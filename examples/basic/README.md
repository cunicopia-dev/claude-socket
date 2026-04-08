# Basic Example

A minimal chat UI that connects to a claude-socket server. Single HTML file, no build tools.

## Prerequisites

1. Claude Code running with the claude-socket MCP plugin configured
2. The plugin's WebSocket server listening (default: `ws://localhost:3100`)

## Run

Open `index.html` in your browser. That's it.

The page connects to `ws://localhost:3100` by default. Override via query params:

```
index.html?port=3200&session=my-session&host=localhost
```

| Param     | Default     | Description                    |
|-----------|-------------|--------------------------------|
| `port`    | `3100`      | WebSocket server port          |
| `host`    | `localhost` | WebSocket server host          |
| `session` | `default`   | Session ID for multiplexing    |

## What it does

- Connects to the WebSocket server
- Sends messages you type to Claude Code (via the MCP bridge)
- Displays Claude's replies
- Shows thinking/tool_use status indicators
- Handles permission requests with Allow/Deny buttons
- Auto-reconnects on disconnect
