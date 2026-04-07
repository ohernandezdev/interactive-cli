# interactive-cli

MCP server that lets AI coding agents interact with interactive CLI processes. Uses a real PTY + [xterm headless](https://www.npmjs.com/package/@xterm/headless) to render terminal output as clean text — no ANSI escape soup.

Works with [Claude Code](https://claude.ai/code), Cursor, Windsurf, or any MCP-compatible client.

## Why

AI agents can run shell commands, but they choke on anything interactive:

```
$ eas build --platform ios
✔ Select a build profile › (waiting for input...)
```

This MCP server bridges that gap — spawn the process, read the screen, send keystrokes.

## Quick Start

### Claude Code

```bash
claude mcp add-json interactive-cli '{"command":"npx","args":["-y","interactive-cli-mcp"]}'
```

Or add to `~/.claude/settings.json` manually:

```json
{
  "mcpServers": {
    "interactive-cli": {
      "command": "npx",
      "args": ["-y", "interactive-cli-mcp"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/ohernandezdev/interactive-cli.git
cd interactive-cli
npm install && npm run build
```

```bash
claude mcp add-json interactive-cli '{"command":"node","args":["/absolute/path/to/interactive-cli/dist/index.js"]}'
```

### Other MCP Clients

Point your client's MCP config at:

```
command: node
args: ["/path/to/interactive-cli/dist/index.js"]
transport: stdio
```

## Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `spawn` | Start an interactive process in a PTY | No |
| `send_input` | Type text (appends Enter by default) | No |
| `send_keys` | Send special keys in sequence (arrows, ctrl combos, etc.) | No |
| `get_screen` | Capture current terminal screen, optional regex search | Yes |
| `wait_for` | Block until a regex pattern appears in output | No |
| `wait_for_exit` | Block until the process exits | No |
| `resize` | Change terminal dimensions | No |
| `list_sessions` | List all active sessions | Yes |
| `close` | Kill process, clean up session | No |

### Typical Flow

```
1. spawn("eas build --platform ios --profile production")
   → returns sessionId + initial screen

2. get_screen(sessionId)
   → "Select a build profile: ❯ development  staging  production"

3. send_keys(sessionId, ["down", "down", "enter"])
   → "✔ Selected: production"

4. wait_for(sessionId, "Build complete|error|failed", timeoutMs: 600000)
   → blocks until build finishes, returns screen

5. close(sessionId)
```

### `spawn`

```typescript
spawn({
  command: "ssh user@server.com",   // full command string
  cwd: "/path/to/project",          // optional working directory
  env: { "NODE_ENV": "production" }, // optional extra env vars
  cols: 120,                         // terminal width (default 120)
  rows: 30,                          // terminal height (default 30)
  waitMs: 3000,                      // ms to wait for initial output (default 2000)
})
```

Commands run through your shell (`$SHELL` or `/bin/zsh`), so pipes, redirects, and builtins work.

### `send_input`

```typescript
send_input({
  sessionId: "s1",
  text: "yes",           // text to type
  pressEnter: true,      // append Enter (default true). false for password fields
  waitMs: 2000,          // ms to wait for response (default 2000)
})
```

### `send_keys`

Send one or more keys in sequence with a small delay between each:

```typescript
send_keys({
  sessionId: "s1",
  keys: ["down", "down", "enter"],  // navigate menu
  delayBetweenMs: 50,               // ms between keys (default 50)
  waitMs: 1500,                     // ms to wait after last key (default 1500)
})
```

**Supported keys:** `enter` `tab` `escape` `space` `up` `down` `left` `right` `backspace` `delete` `home` `end` `page_up` `page_down` `f1`–`f12` `ctrl+c` `ctrl+d` `ctrl+z` `ctrl+l` `ctrl+a` `ctrl+e` `ctrl+r` `ctrl+w` `ctrl+u` `ctrl+k` `ctrl+p` `ctrl+n` `y` `n` `0`–`9`

### `get_screen`

```typescript
get_screen({
  sessionId: "s1",
  search: "error|warning",  // optional regex to highlight matching lines
})
// Returns: { screen, cursor: { row, col }, searchResults, stats }
```

### `wait_for`

```typescript
wait_for({
  sessionId: "s1",
  pattern: "\\$|#|>",      // regex to match (case-insensitive)
  timeoutMs: 30000,         // max wait (default 30s)
  intervalMs: 1000,         // check interval (default 1s)
})
// Returns: { matched: true/false, screen, elapsed }
```

### `wait_for_exit`

```typescript
wait_for_exit({
  sessionId: "s1",
  timeoutMs: 60000,
})
// Returns: { alive: false, exitCode: 0, screen }
```

## Resources

Sessions are exposed as MCP resources:

- `interactive-cli://sessions` — JSON list of all sessions
- `interactive-cli://sessions/{id}/screen` — live screen content

## Prompt Templates

Pre-built prompt templates for common flows (appear as slash commands in Claude Code):

- **`eas_build`** — EAS build with credential handling
- **`ssh_session`** — SSH connection with command execution
- **`repl_session`** — Start a REPL (Python, Node, psql, etc.)
- **`docker_interactive`** — Run an interactive Docker container

## How It Works

```
Agent ←→ MCP Protocol (stdio) ←→ interactive-cli server
                                        │
                                  ┌─────┴──────┐
                                  │   Session   │
                                  │   Manager   │
                                  └─────┬──────┘
                                        │
                                  ┌─────┼──────┐
                                  │     │      │
                               node-pty xterm  Truncation
                               (PTY)  (render) (80K limit)
```

- **node-pty** spawns a real pseudo-terminal, so the child process thinks it's talking to a human
- **xterm headless** maintains a virtual terminal buffer that renders ANSI escape sequences into a clean 2D text grid
- Output is truncated at 80K characters (MCP clients like Claude Code cap at 100K) using smart middle-truncation that preserves the start and end
- Tool annotations (`readOnlyHint`, `destructiveHint`) tell Claude Code which tools are safe to run in parallel and which need permission

## Requirements

- Node.js >= 18
- macOS or Linux (node-pty uses native PTY)

## License

MIT
