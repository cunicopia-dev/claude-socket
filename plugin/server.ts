#!/usr/bin/env bun
/**
 * claude-socket — MCP plugin server
 *
 * Runs as a Claude Code MCP plugin via stdio. Simultaneously hosts a WebSocket
 * server that browser clients connect to. Messages flow:
 *
 *   Browser  <--WebSocket-->  this server  <--MCP stdio-->  Claude Code
 *
 * Claude Code calls MCP tools (reply, status, fetch_messages) to send data
 * back to connected browsers. Browsers send messages over WebSocket, which
 * this server forwards to Claude Code as MCP channel notifications.
 *
 * Environment variables:
 *   CLAUDE_SOCKET_PORT  — WebSocket listen port (default: 3100)
 *   CLAUDE_SOCKET_HOST  — WebSocket bind address (default: 127.0.0.1)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Config ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.CLAUDE_SOCKET_PORT ?? '3100', 10)
const HOST = process.env.CLAUDE_SOCKET_HOST ?? '127.0.0.1'
const MAX_MESSAGES = 100
const SESSION_TTL_MS = 5 * 60 * 1000 // clean up 5 min after last client leaves

// ── Logging ─────────────────────────────────────────────────────────────

const LOG_FILE = join(tmpdir(), 'claude-socket.log')

function log(msg: string): void {
  const ts = new Date().toISOString()
  appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`)
  process.stderr.write(`claude-socket: ${msg}\n`)
}

// ── Types ───────────────────────────────────────────────────────────────

/** A message stored in the session's rolling buffer. */
type StoredMessage = {
  role: string
  content: string
  ts: string
}

/**
 * Minimal interface for Bun's ServerWebSocket. We only use send(),
 * so this avoids coupling to Bun's full WebSocket type.
 */
type WsClient = {
  send(data: string): void
}

/** Per-session state: connected clients, message buffer, cleanup timer. */
type Session = {
  clients: Set<WsClient>
  messages: StoredMessage[]
  cleanupTimer: ReturnType<typeof setTimeout> | null
}

/** Messages the browser can send to the server. */
type InboundMessage =
  | { type: 'message'; session_id: string; content: string; user: string; ts: string }
  | { type: 'fetch_history'; session_id: string; limit?: number }
  | { type: 'permission_response'; request_id: string; allowed: boolean }

/** Messages the server sends to the browser. */
type OutboundMessage =
  | { type: 'reply'; session_id: string; message_id: string; content: string; ts: string }
  | { type: 'status'; session_id: string; status: string; detail?: string }
  | { type: 'history'; session_id: string; messages: StoredMessage[] }
  | { type: 'permission_request'; session_id: string; request_id: string; tool_name: string; description: string; input_preview: string }
  | { type: 'error'; session_id: string; message: string }

// ── State ───────────────────────────────────────────────────────────────

const sessions = new Map<string, Session>()
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// Keep the process alive on stray rejections — an MCP server must not crash.
process.on('unhandledRejection', (err) => {
  process.stderr.write(`claude-socket: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`claude-socket: uncaught exception: ${err}\n`)
})

// ── Session Helpers ─────────────────────────────────────────────────────

/** Get an existing session or create a new one. Cancels any pending cleanup. */
function getOrCreateSession(sessionId: string): Session {
  let session = sessions.get(sessionId)
  if (!session) {
    session = { clients: new Set(), messages: [], cleanupTimer: null }
    sessions.set(sessionId, session)
  }
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer)
    session.cleanupTimer = null
  }
  return session
}

/** Append a message to the session buffer, trimming to MAX_MESSAGES. */
function pushMessage(session: Session, msg: StoredMessage): void {
  session.messages.push(msg)
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES)
  }
}

/** Send a message to all WebSocket clients in a session. */
function broadcast(sessionId: string, msg: OutboundMessage): void {
  const session = sessions.get(sessionId)
  if (!session) return
  const payload = JSON.stringify(msg)
  for (const ws of session.clients) {
    try { ws.send(payload) } catch (err) { log(`broadcast send failed: ${err}`) }
  }
}

/** Send a message to all clients across all sessions (e.g. permission requests). */
function broadcastAll(msg: OutboundMessage & { session_id: string }): void {
  for (const [sid, session] of sessions) {
    const payload = JSON.stringify({ ...msg, session_id: sid })
    for (const ws of session.clients) {
      try { ws.send(payload) } catch (err) { log(`broadcast send failed: ${err}`) }
    }
  }
}

/** Schedule session cleanup after all clients disconnect. */
function scheduleCleanup(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session || session.clients.size > 0) return
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer)
  session.cleanupTimer = setTimeout(() => {
    const s = sessions.get(sessionId)
    if (s && s.clients.size === 0) {
      sessions.delete(sessionId)
      log(`session ${sessionId} cleaned up`)
    }
  }, SESSION_TTL_MS)
}

// ── MCP Server ──────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'claude-socket', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'Messages arrive from connected WebSocket clients as channel notifications.',
      'Use the reply tool to send responses back. The sender sees your replies',
      'through the WebSocket connection, not this terminal.',
      '',
      'Messages arrive as <channel source="websocket" chat_id="..." user="..." ts="...">.',
      'Reply with the reply tool — pass chat_id back.',
      'Use the status tool to show thinking/tool_use indicators.',
      '',
      'fetch_messages returns message history from the session buffer.',
      'The buffer is rolling (last 100 messages).',
    ].join('\n'),
  },
)

// ── Permission Relay (Claude Code -> Plugin -> Browser) ─────────────────
//
// When Claude Code wants to use a tool that needs user approval, it sends
// a permission request notification. We forward it to all connected browsers.
// The browser shows a prompt, and the user's response flows back through
// the same path.

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    const { request_id, tool_name, description, input_preview } = params
    pendingPermissions.set(request_id, { tool_name, description, input_preview })
    broadcastAll({
      type: 'permission_request',
      session_id: '', // overwritten by broadcastAll
      request_id,
      tool_name,
      description,
      input_preview,
    })
  },
)

// ── MCP Tools ───────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a reply to a connected WebSocket client. Pass chat_id from the inbound message.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'Session ID from the inbound message.' },
          text: { type: 'string', description: 'Reply text content.' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'status',
      description:
        'Push a status update to connected clients (thinking, tool_use, idle).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'Session ID.' },
          status: { type: 'string', description: 'One of: thinking, tool_use, idle.' },
          detail: { type: 'string', description: 'Optional detail text.' },
        },
        required: ['chat_id', 'status'],
      },
    },
    {
      name: 'fetch_messages',
      description:
        'Fetch recent messages from a session buffer. Returns oldest-first.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID.' },
          limit: { type: 'number', description: 'Max messages to return (default 50, max 100).' },
        },
        required: ['session_id'],
      },
    },
  ],
}))

// ── Tool Arg Schemas ───────────────────────────────────────────────────

const ReplyArgsSchema = z.object({
  chat_id: z.string(),
  text: z.string(),
})

const StatusArgsSchema = z.object({
  chat_id: z.string(),
  status: z.string(),
  detail: z.string().optional(),
})

const FetchMessagesArgsSchema = z.object({
  session_id: z.string(),
  limit: z.number().optional(),
})

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {}

  try {
    switch (req.params.name) {
      case 'reply': {
        const { chat_id: chatId, text } = ReplyArgsSchema.parse(args)
        const messageId = randomBytes(8).toString('hex')
        const ts = new Date().toISOString()

        const session = sessions.get(chatId)
        if (session) {
          pushMessage(session, { role: 'assistant', content: text, ts })
        }

        broadcast(chatId, {
          type: 'reply',
          session_id: chatId,
          message_id: messageId,
          content: text,
          ts,
        })

        return { content: [{ type: 'text', text: `sent (id: ${messageId})` }] }
      }

      case 'status': {
        const { chat_id: chatId, status, detail } = StatusArgsSchema.parse(args)

        broadcast(chatId, {
          type: 'status',
          session_id: chatId,
          status,
          detail,
        })

        return { content: [{ type: 'text', text: 'status sent' }] }
      }

      case 'fetch_messages': {
        const { session_id: sessionId, limit: rawLimit } = FetchMessagesArgsSchema.parse(args)
        const limit = Math.min(Math.max(rawLimit ?? 50, 1), MAX_MESSAGES)
        const session = sessions.get(sessionId)
        const messages = session ? session.messages.slice(-limit) : []

        const out = messages.length === 0
          ? '(no messages)'
          : messages
              .map((m) => `[${m.ts}] ${m.role}: ${m.content.replace(/[\r\n]+/g, ' ')}`)
              .join('\n')

        return { content: [{ type: 'text', text: out }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// ── WebSocket Server (Bun native) ──────────────────────────────────────

/** Handle an inbound WebSocket message from a browser client. */
function handleWsMessage(ws: WsClient, raw: string | Buffer): void {
  let data: InboundMessage
  try {
    data = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as InboundMessage
  } catch {
    try {
      ws.send(JSON.stringify({ type: 'error', session_id: '', message: 'invalid JSON' }))
    } catch (err) { log(`failed to send error response: ${err}`) }
    return
  }

  switch (data.type) {
    case 'message': {
      const session = getOrCreateSession(data.session_id)
      session.clients.add(ws)

      const storedMsg: StoredMessage = { role: 'user', content: data.content, ts: data.ts }
      pushMessage(session, storedMsg)

      // Forward to Claude Code via MCP channel notification.
      log(`delivering message: "${data.content.substring(0, 80)}"`)
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: data.content,
          meta: {
            chat_id: data.session_id,
            user: data.user,
            ts: data.ts,
            source: 'websocket',
          },
        },
      }).then(() => {
        log('notification sent successfully')
      }).catch((err) => {
        log(`FAILED to deliver: ${err}`)
      })
      break
    }

    case 'fetch_history': {
      const session = sessions.get(data.session_id)
      const limit = Math.min(Math.max(data.limit ?? 50, 1), MAX_MESSAGES)
      const messages = session ? session.messages.slice(-limit) : []

      try {
        ws.send(JSON.stringify({
          type: 'history',
          session_id: data.session_id,
          messages,
        }))
      } catch (err) { log(`failed to send history: ${err}`) }
      break
    }

    case 'permission_response': {
      const behavior = data.allowed ? 'allow' : 'deny'
      pendingPermissions.delete(data.request_id)

      mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: data.request_id,
          behavior,
        },
      }).catch((err) => {
        process.stderr.write(`claude-socket: failed to send permission response: ${err}\n`)
      })
      break
    }

    default: {
      try {
        ws.send(JSON.stringify({
          type: 'error',
          session_id: (data as Record<string, unknown>).session_id ?? '',
          message: `unknown message type: ${(data as Record<string, unknown>).type}`,
        }))
      } catch (err) { log(`failed to send error response: ${err}`) }
    }
  }
}

// Track ws -> session for cleanup on disconnect.
const wsSessionMap = new WeakMap<WsClient, string>()

const wsServer = Bun.serve({
  port: PORT,
  hostname: HOST,

  fetch(req, server) {
    const url = new URL(req.url)

    // Allow session_id via query param or default to "default".
    const sessionId = url.searchParams.get('session') ?? 'default'

    if (server.upgrade(req, { data: { sessionId } })) {
      return // upgraded to WebSocket
    }

    // Non-WebSocket: health check endpoint.
    return new Response(
      JSON.stringify({ status: 'ok', sessions: sessions.size }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  },

  websocket: {
    open(ws) {
      const sessionId = (ws.data as { sessionId: string }).sessionId
      const session = getOrCreateSession(sessionId)
      session.clients.add(ws as unknown as WsClient)
      wsSessionMap.set(ws as unknown as WsClient, sessionId)
      log(`client connected to session "${sessionId}"`)
    },

    message(ws, raw) {
      handleWsMessage(ws as unknown as WsClient, raw as string | Buffer)
    },

    close(ws) {
      const sessionId =
        (ws.data as { sessionId: string }).sessionId ||
        wsSessionMap.get(ws as unknown as WsClient)
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (session) {
          session.clients.delete(ws as unknown as WsClient)
          log(`client disconnected from "${sessionId}" (${session.clients.size} remaining)`)
          scheduleCleanup(sessionId)
        }
      }
    },
  },
})

log(`WebSocket server listening on ${HOST}:${PORT}`)

// ── MCP Transport ───────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())

// ── Shutdown ────────────────────────────────────────────────────────────

let shuttingDown = false

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('claude-socket: shutting down\n')
  try { wsServer.stop() } catch {}
  setTimeout(() => process.exit(0), 500)
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
