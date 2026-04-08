# claude-socket

WebSocket bridge that connects any web UI to a running Claude Code session. Ships as two pieces: an MCP plugin that Claude Code runs, and a zero-dependency browser client. Claude Code talks to the plugin over MCP stdio; browsers talk to the plugin over WebSocket.

## Quick Start

### 1. Install the plugin

```bash
cd claude-socket/plugin
bun install
```

### 2. Configure Claude Code

Add the MCP server to your Claude Code settings (`~/.claude/settings.json` or project-level `.claude/settings.json`):

```json
{
  "mcpServers": {
    "claude-socket": {
      "command": "bun",
      "args": ["run", "/path/to/claude-socket/plugin/server.ts"],
      "env": {
        "CLAUDE_SOCKET_PORT": "3100",
        "CLAUDE_SOCKET_HOST": "127.0.0.1"
      }
    }
  }
}
```

### 3. Open the example

Open `examples/basic/index.html` in your browser. Type a message. Claude Code sees it and replies through the WebSocket.

## Architecture

```
┌──────────┐         stdio (MCP)         ┌──────────────┐       WebSocket       ┌─────────┐
│          │ ──── tools/notifications ──> │              │ <──── messages ──────> │         │
│  Claude  │                              │  MCP Plugin  │                        │ Browser │
│   Code   │ <── reply/status/fetch ───── │  (Bun server)│ ────> replies ──────> │ Client  │
│          │                              │              │ ────> status ────────> │         │
│          │                              │              │ ────> permissions ───> │         │
└──────────┘                              └──────────────┘                        └─────────┘
```

The plugin runs a single process that serves two roles:
- **MCP server** on stdio — Claude Code calls `reply`, `status`, and `fetch_messages` tools
- **WebSocket server** on a TCP port — browsers connect, send messages, receive replies

Messages from the browser are forwarded to Claude Code as MCP channel notifications. Claude Code's replies come back through MCP tool calls, which the plugin broadcasts to connected WebSocket clients.

## Configuration

| Environment Variable   | Default       | Description                     |
|------------------------|---------------|---------------------------------|
| `CLAUDE_SOCKET_PORT`   | `3100`        | WebSocket server port           |
| `CLAUDE_SOCKET_HOST`   | `127.0.0.1`  | WebSocket server bind address   |

## Protocol Reference

### Browser -> Server (WebSocket)

#### `message` — Send a chat message

```json
{
  "type": "message",
  "session_id": "default",
  "content": "Hello Claude!",
  "user": "user",
  "ts": "2026-01-01T00:00:00.000Z"
}
```

#### `fetch_history` — Request message history

```json
{
  "type": "fetch_history",
  "session_id": "default",
  "limit": 50
}
```

#### `permission_response` — Answer a permission request

```json
{
  "type": "permission_response",
  "request_id": "abc123",
  "allowed": true
}
```

### Server -> Browser (WebSocket)

#### `reply` — Claude's response

```json
{
  "type": "reply",
  "session_id": "default",
  "message_id": "a1b2c3d4e5f6g7h8",
  "content": "Hello! How can I help?",
  "ts": "2026-01-01T00:00:01.000Z"
}
```

#### `status` — Activity indicator

```json
{
  "type": "status",
  "session_id": "default",
  "status": "thinking",
  "detail": "optional detail text"
}
```

Status values: `thinking`, `tool_use`, `idle`

#### `history` — Message history response

```json
{
  "type": "history",
  "session_id": "default",
  "messages": [
    { "role": "user", "content": "Hello", "ts": "..." },
    { "role": "assistant", "content": "Hi there!", "ts": "..." }
  ]
}
```

#### `permission_request` — Tool permission prompt

```json
{
  "type": "permission_request",
  "session_id": "default",
  "request_id": "abc123",
  "tool_name": "Bash",
  "description": "Run a shell command",
  "input_preview": "ls -la /tmp"
}
```

#### `error` — Error message

```json
{
  "type": "error",
  "session_id": "default",
  "message": "something went wrong"
}
```

### MCP Tools (Claude Code -> Plugin)

| Tool             | Parameters                             | Description                          |
|------------------|----------------------------------------|--------------------------------------|
| `reply`          | `chat_id`, `text`                      | Send a reply to WebSocket clients    |
| `status`         | `chat_id`, `status`, `detail?`         | Push a status indicator              |
| `fetch_messages` | `session_id`, `limit?`                 | Read the session's message buffer    |

## Client API

The `client/` package exports a `ClaudeSocket` class. Zero dependencies, works in any browser.

### Constructor

```ts
const socket = new ClaudeSocket(url: string, options?: {
  session?: string        // Session ID (default: "default")
  user?: string           // Username sent with messages (default: "user")
  reconnect?: boolean     // Auto-reconnect on disconnect (default: true)
  reconnectDelay?: number // Initial reconnect delay in ms (default: 1000)
  maxReconnectDelay?: number // Max reconnect delay in ms (default: 30000)
})
```

### Properties

| Property     | Type      | Description                        |
|--------------|-----------|------------------------------------|
| `connected`  | `boolean` | Whether the WebSocket is connected |
| `connecting` | `boolean` | Whether a connection is in progress|

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `connect` | `() => void` | Open the WebSocket connection |
| `send` | `(content: string) => void` | Send a message to Claude Code |
| `fetchHistory` | `(limit?: number) => void` | Request message history |
| `respondToPermission` | `(requestId: string, allowed: boolean) => void` | Answer a permission request |
| `disconnect` | `() => void` | Close connection, stop reconnecting |
| `on` | `(event, callback) => () => void` | Subscribe to events (returns unsubscribe fn) |
| `off` | `(event, callback) => void` | Unsubscribe from events |

### Events

| Event                | Payload                    | Description                          |
|----------------------|----------------------------|--------------------------------------|
| `connected`          | —                          | WebSocket connected                  |
| `disconnected`       | —                          | WebSocket disconnected               |
| `reply`              | `ReplyMessage`             | Claude sent a reply                  |
| `status`             | `StatusMessage`            | Status indicator update              |
| `history`            | `HistoryMessage`           | History response                     |
| `permission_request` | `PermissionRequestMessage` | Claude needs tool permission         |
| `error`              | `ErrorMessage`             | Error from the server                |
| `message`            | `ServerMessage`            | Any server message (catch-all)       |

### Usage

```ts
import { ClaudeSocket } from 'claude-socket'

const socket = new ClaudeSocket('ws://localhost:3100', {
  session: 'my-app',
  user: 'alice',
})

socket.on('connected', () => {
  console.log('Connected to Claude Code')
})

socket.on('reply', (msg) => {
  console.log(`Claude: ${msg.content}`)
})

socket.on('status', (msg) => {
  if (msg.status === 'thinking') console.log('Claude is thinking...')
})

socket.on('permission_request', (msg) => {
  const allowed = confirm(`Allow ${msg.tool_name}?\n${msg.description}\n${msg.input_preview}`)
  socket.respondToPermission(msg.request_id, allowed)
})

socket.connect()
socket.send('What time is it?')
```

## Sessions

Multiple browser tabs can share a session by using the same `session` parameter. Messages broadcast to all clients in a session. Sessions are created on first connection and cleaned up 5 minutes after the last client disconnects.

Connect to a session via query parameter:
```
ws://localhost:3100?session=my-session
```

Or set it in the client constructor:
```ts
new ClaudeSocket('ws://localhost:3100', { session: 'my-session' })
```

## Permission Relay

When Claude Code needs approval for a tool (e.g., running a shell command), the permission request is forwarded to all connected browsers. The UI can present an Allow/Deny prompt, and the response flows back to Claude Code through the same bridge. This lets you approve Claude's actions from a web UI instead of the terminal.

## License

Apache 2.0
