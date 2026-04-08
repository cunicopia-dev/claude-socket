#!/usr/bin/env bun
/**
 * claude-socket integration test
 *
 * Spawns the plugin server, connects a WebSocket client,
 * and verifies the protocol works end-to-end.
 *
 * Run: bun test.ts
 */

const PORT = 13100 // use a non-default port to avoid conflicts
const HOST = '127.0.0.1'
const WS_URL = `ws://${HOST}:${PORT}`

let server: ReturnType<typeof Bun.spawn> | null = null
let passed = 0
let failed = 0

function assert(condition: boolean, name: string): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

async function waitForPort(port: number, host: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${host}:${port}`)
      if (res.ok) return true
    } catch {}
    await Bun.sleep(100)
  }
  return false
}

function connectWs(session = 'test'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?session=${session}`)
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 3000)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws connect error')) }
  })
}

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs)
    ws.onmessage = (e) => {
      clearTimeout(timer)
      resolve(JSON.parse(e.data as string))
    }
  })
}

function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const msgs: any[] = []
    const timer = setTimeout(() => reject(new Error(`expected ${count} messages, got ${msgs.length}`)), timeoutMs)
    ws.onmessage = (e) => {
      msgs.push(JSON.parse(e.data as string))
      if (msgs.length >= count) {
        clearTimeout(timer)
        resolve(msgs)
      }
    }
  })
}

async function cleanup() {
  if (server) {
    server.kill()
    server = null
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

async function main() {
  console.log('\nclaude-socket tests\n')

  // ── Start server ─────────────────────────────────────────────────────
  console.log('starting server...')

  // The server needs stdin to stay open (MCP transport reads from it).
  // We spawn it with piped stdin and just keep it open.
  server = Bun.spawn(['bun', 'run', 'server.ts'], {
    cwd: `${import.meta.dir}`,
    env: {
      ...process.env,
      CLAUDE_SOCKET_PORT: String(PORT),
      CLAUDE_SOCKET_HOST: HOST,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const ready = await waitForPort(PORT, HOST)
  if (!ready) {
    // dump stderr for debugging
    const stderr = await new Response(server.stderr).text()
    console.error('server failed to start:', stderr)
    process.exit(1)
  }
  console.log('server up\n')

  // ── Test: health check endpoint ──────────────────────────────────────
  console.log('health check:')
  try {
    const res = await fetch(`http://${HOST}:${PORT}`)
    const body = await res.json()
    assert(res.status === 200, 'returns 200')
    assert(body.status === 'ok', 'body.status is "ok"')
    assert(typeof body.sessions === 'number', 'body.sessions is a number')
  } catch (e) {
    assert(false, `health check failed: ${e}`)
  }

  // ── Test: websocket connect ──────────────────────────────────────────
  console.log('\nwebsocket connect:')
  let ws1: WebSocket | null = null
  try {
    ws1 = await connectWs('test-session')
    assert(ws1.readyState === WebSocket.OPEN, 'connects successfully')
  } catch (e) {
    assert(false, `connect failed: ${e}`)
  }

  // ── Test: default session ────────────────────────────────────────────
  console.log('\ndefault session:')
  let wsDefault: WebSocket | null = null
  try {
    // connect without session param — should get "default"
    wsDefault = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(WS_URL)
      const timer = setTimeout(() => reject(new Error('timeout')), 3000)
      ws.onopen = () => { clearTimeout(timer); resolve(ws) }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('error')) }
    })
    assert(wsDefault.readyState === WebSocket.OPEN, 'connects to default session')
    wsDefault.close()
  } catch (e) {
    assert(false, `default session failed: ${e}`)
  }

  // ── Test: send message (inbound) ─────────────────────────────────────
  console.log('\nmessage sending:')
  try {
    // Send a message — the server will try to forward via MCP notification,
    // which will fail since we don't have a real MCP client on stdin.
    // But the message should still be stored in the session buffer.
    ws1!.send(JSON.stringify({
      type: 'message',
      session_id: 'test-session',
      content: 'hello from test',
      user: 'tester',
      ts: new Date().toISOString(),
    }))
    // Give it a moment to process
    await Bun.sleep(200)
    assert(true, 'message sent without crash')
  } catch (e) {
    assert(false, `message send failed: ${e}`)
  }

  // ── Test: fetch_history ──────────────────────────────────────────────
  console.log('\nfetch history:')
  try {
    const historyPromise = waitForMessage(ws1!)
    ws1!.send(JSON.stringify({
      type: 'fetch_history',
      session_id: 'test-session',
      limit: 10,
    }))
    const historyMsg = await historyPromise
    assert(historyMsg.type === 'history', 'returns history type')
    assert(historyMsg.session_id === 'test-session', 'correct session_id')
    assert(Array.isArray(historyMsg.messages), 'messages is array')
    assert(historyMsg.messages.length === 1, 'has 1 message in buffer')
    assert(historyMsg.messages[0].role === 'user', 'message role is user')
    assert(historyMsg.messages[0].content === 'hello from test', 'message content matches')
  } catch (e) {
    assert(false, `fetch history failed: ${e}`)
  }

  // ── Test: multiple messages in buffer ────────────────────────────────
  console.log('\nmessage buffer:')
  try {
    // Send 2 more messages
    for (const content of ['second message', 'third message']) {
      ws1!.send(JSON.stringify({
        type: 'message',
        session_id: 'test-session',
        content,
        user: 'tester',
        ts: new Date().toISOString(),
      }))
    }
    await Bun.sleep(200)

    const historyPromise = waitForMessage(ws1!)
    ws1!.send(JSON.stringify({
      type: 'fetch_history',
      session_id: 'test-session',
      limit: 10,
    }))
    const historyMsg = await historyPromise
    assert(historyMsg.messages.length === 3, 'buffer has 3 messages')
    assert(historyMsg.messages[2].content === 'third message', 'latest message is correct')
  } catch (e) {
    assert(false, `buffer test failed: ${e}`)
  }

  // ── Test: invalid JSON ───────────────────────────────────────────────
  console.log('\nerror handling:')
  try {
    const errPromise = waitForMessage(ws1!)
    ws1!.send('not json at all')
    const errMsg = await errPromise
    assert(errMsg.type === 'error', 'returns error type for bad JSON')
    assert(errMsg.message === 'invalid JSON', 'error message says invalid JSON')
  } catch (e) {
    assert(false, `error handling failed: ${e}`)
  }

  // ── Test: unknown message type ───────────────────────────────────────
  try {
    const errPromise = waitForMessage(ws1!)
    ws1!.send(JSON.stringify({ type: 'bogus', session_id: 'test-session' }))
    const errMsg = await errPromise
    assert(errMsg.type === 'error', 'returns error for unknown type')
    assert(errMsg.message.includes('bogus'), 'error mentions the bad type')
  } catch (e) {
    assert(false, `unknown type test failed: ${e}`)
  }

  // ── Test: session isolation ──────────────────────────────────────────
  console.log('\nsession isolation:')
  let ws2: WebSocket | null = null
  try {
    ws2 = await connectWs('other-session')

    // other-session should have empty history
    const historyPromise = waitForMessage(ws2)
    ws2.send(JSON.stringify({
      type: 'fetch_history',
      session_id: 'other-session',
      limit: 10,
    }))
    const historyMsg = await historyPromise
    assert(historyMsg.messages.length === 0, 'other session has no messages')
  } catch (e) {
    assert(false, `session isolation failed: ${e}`)
  }

  // ── Test: multi-client broadcast ─────────────────────────────────────
  console.log('\nmulti-client broadcast:')
  let ws3: WebSocket | null = null
  try {
    // Connect a second client to test-session
    ws3 = await connectWs('test-session')
    await Bun.sleep(100)

    // Both ws1 and ws3 are in test-session.
    // Send a message from ws3, both should see the history update.
    ws3.send(JSON.stringify({
      type: 'message',
      session_id: 'test-session',
      content: 'from client 3',
      user: 'tester3',
      ts: new Date().toISOString(),
    }))
    await Bun.sleep(200)

    // Fetch history from ws1 — should include ws3's message
    const historyPromise = waitForMessage(ws1!)
    ws1!.send(JSON.stringify({
      type: 'fetch_history',
      session_id: 'test-session',
      limit: 10,
    }))
    const historyMsg = await historyPromise
    assert(historyMsg.messages.length === 4, 'ws1 sees all 4 messages')
    assert(historyMsg.messages[3].content === 'from client 3', 'ws1 sees ws3 message')
  } catch (e) {
    assert(false, `broadcast test failed: ${e}`)
  }

  // ── Test: health check shows sessions ────────────────────────────────
  console.log('\nsession count:')
  try {
    const res = await fetch(`http://${HOST}:${PORT}`)
    const body = await res.json()
    assert(body.sessions >= 2, `health check shows ≥2 sessions (got ${body.sessions})`)
  } catch (e) {
    assert(false, `session count failed: ${e}`)
  }

  // ── Cleanup ──────────────────────────────────────────────────────────
  ws1?.close()
  ws2?.close()
  ws3?.close()
  wsDefault?.close()

  // ── Results ──────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
  await cleanup()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error('test runner error:', e)
  await cleanup()
  process.exit(1)
})
