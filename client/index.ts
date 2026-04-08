/**
 * claude-socket client
 *
 * Framework-agnostic WebSocket client for connecting to a claude-socket server.
 * Zero dependencies. Works in any browser or JS runtime with WebSocket support.
 *
 * @example
 * ```ts
 * const socket = new ClaudeSocket('ws://localhost:3100')
 * socket.on('reply', (msg) => console.log(msg.content))
 * socket.on('status', (msg) => console.log(msg.status))
 * socket.on('connected', () => console.log('connected'))
 * socket.connect()
 * socket.send('Hello Claude!')
 * ```
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface ReplyMessage {
  type: 'reply'
  session_id: string
  message_id: string
  content: string
  ts: string
}

export interface StatusMessage {
  type: 'status'
  session_id: string
  status: 'thinking' | 'tool_use' | 'idle' | string
  detail?: string
}

export interface HistoryItem {
  role: string
  content: string
  ts: string
}

export interface HistoryMessage {
  type: 'history'
  session_id: string
  messages: HistoryItem[]
}

export interface PermissionRequestMessage {
  type: 'permission_request'
  session_id: string
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export interface ErrorMessage {
  type: 'error'
  session_id: string
  message: string
}

export type ServerMessage =
  | ReplyMessage
  | StatusMessage
  | HistoryMessage
  | PermissionRequestMessage
  | ErrorMessage

/** Map of event names to their callback signatures. */
export interface ClaudeSocketEvents {
  reply: (msg: ReplyMessage) => void
  status: (msg: StatusMessage) => void
  history: (msg: HistoryMessage) => void
  permission_request: (msg: PermissionRequestMessage) => void
  error: (msg: ErrorMessage) => void
  connected: () => void
  disconnected: () => void
  message: (msg: ServerMessage) => void
}

export type EventName = keyof ClaudeSocketEvents

// ── Options ─────────────────────────────────────────────────────────────

export interface ClaudeSocketOptions {
  /** Session ID for multiplexing. Defaults to "default". */
  session?: string

  /** Username sent with messages. Defaults to "user". */
  user?: string

  /** Auto-reconnect on disconnect. Defaults to true. */
  reconnect?: boolean

  /** Initial reconnect delay in ms. Doubles on each attempt, caps at 30s. Defaults to 1000. */
  reconnectDelay?: number

  /** Max reconnect delay in ms. Defaults to 30000. */
  maxReconnectDelay?: number
}

// ── Client ──────────────────────────────────────────────────────────────

export class ClaudeSocket {
  private url: string
  private session: string
  private user: string
  private shouldReconnect: boolean
  private reconnectDelay: number
  private maxReconnectDelay: number
  private currentDelay: number
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Map<string, Set<Function>>()
  private _connected = false
  private _connecting = false

  constructor(url: string, options: ClaudeSocketOptions = {}) {
    this.url = url
    this.session = options.session ?? 'default'
    this.user = options.user ?? 'user'
    this.shouldReconnect = options.reconnect ?? true
    this.reconnectDelay = options.reconnectDelay ?? 1000
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000
    this.currentDelay = this.reconnectDelay
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Whether the WebSocket is currently connected. */
  get connected(): boolean {
    return this._connected
  }

  /** Whether a connection attempt is in progress. */
  get connecting(): boolean {
    return this._connecting
  }

  /** Open the WebSocket connection. Safe to call multiple times. */
  connect(): void {
    if (this.ws || this._connecting) return
    this._connecting = true

    // Append session as query param.
    const separator = this.url.includes('?') ? '&' : '?'
    const wsUrl = `${this.url}${separator}session=${encodeURIComponent(this.session)}`

    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this._connecting = false
      this._connected = true
      this.currentDelay = this.reconnectDelay
      this.emit('connected')
    }

    this.ws.onmessage = (event: MessageEvent) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }

      // Emit the specific event type and the generic 'message' event.
      this.emit(msg.type as EventName, msg)
      this.emit('message', msg)
    }

    this.ws.onclose = () => {
      this._connected = false
      this._connecting = false
      this.ws = null
      this.emit('disconnected')

      if (this.shouldReconnect) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onerror fires before onclose — onclose handles cleanup.
    }
  }

  /** Send a message to Claude Code through the WebSocket bridge. */
  send(content: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'message',
      session_id: this.session,
      content,
      user: this.user,
      ts: new Date().toISOString(),
    }))
  }

  /** Request message history from the server's rolling buffer. */
  fetchHistory(limit = 50): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'fetch_history',
      session_id: this.session,
      limit,
    }))
  }

  /** Respond to a permission request from Claude Code. */
  respondToPermission(requestId: string, allowed: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'permission_response',
      request_id: requestId,
      allowed,
    }))
  }

  /** Close the connection and stop reconnecting. */
  disconnect(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this._connected = false
    this._connecting = false
  }

  /** Register an event listener. Returns an unsubscribe function. */
  on<E extends EventName>(event: E, callback: ClaudeSocketEvents[E]): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback)
    return () => this.off(event, callback)
  }

  /** Remove an event listener. */
  off<E extends EventName>(event: E, callback: ClaudeSocketEvents[E]): void {
    this.listeners.get(event)?.delete(callback)
  }

  // ── Internals ─────────────────────────────────────────────────────

  private emit(event: string, ...args: unknown[]): void {
    const callbacks = this.listeners.get(event)
    if (!callbacks) return
    for (const cb of callbacks) {
      try { cb(...args) } catch {}
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.currentDelay = Math.min(this.currentDelay * 2, this.maxReconnectDelay)
      this.connect()
    }, this.currentDelay)
  }
}

// Default export for convenience.
export default ClaudeSocket
