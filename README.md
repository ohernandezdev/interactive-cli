# interactive-cli

MCP server that gives AI coding agents the ability to interact with interactive CLI processes. Spawn a real PTY, see the terminal screen as clean text, send keystrokes, and navigate TUI menus — all through the Model Context Protocol.

**Built for [Claude Code](https://claude.ai/code)**, works with any MCP-compatible agent (Cursor, Windsurf, etc.).

## The Problem

AI coding agents can run shell commands, but they can't interact with processes that ask questions:

```
$ eas build --platform ios
✔ Select a build profile › (waiting for input...)
```

The agent gets stuck. You have to take over manually.

## The Solution

`interactive-cli` gives your agent a real terminal (PTY + xterm) it can see and control:

```
Agent: spawn("eas build --platform ios")
→ Screen shows: "Select a build profile: ❯ development  staging  production"

Agent: send_keys(["down", "down", "enter"])
→ Screen shows: "✔ Selected: production"

Agent: wait_for("Build complete|error", timeoutMs: 300000)
→ Waits up to 5 min, returns when build finishes
```

## Install

### Claude Code (recommended)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "interactive-cli": {
      "command": "npx",
      "args": ["-y", "@anthropic-tools/interactive-cli"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/ohernandezdev/interactive-cli.git
cd interactive-cli
npm install && npm run build
```

Then in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "interactive-cli": {
      "command": "node",
      "args": ["/path/to/interactive-cli/dist/index.js"]
    }
  }
}
```

## Tools

### `spawn`
Start an interactive CLI process in a real PTY with virtual terminal rendering.

| Param | Type | Description |
|-------|------|-------------|
| `command` | string | Full command to run |
| `cwd` | string? | Working directory |
| `env` | object? | Extra environment variables |
| `cols` | number? | Terminal width (default 120) |
| `rows` | number? | Terminal height (default 30) |
| `waitMs` | number? | Ms to wait for initial output (default 2000) |

Returns: `sessionId`, `screen` (rendered terminal), `alive`, `exitCode`

### `send_input`
Type text into the process. Appends Enter by default.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session from spawn |
| `text` | string | Text to type |
| `pressEnter` | boolean? | Append Enter (default true) |
| `waitMs` | number? | Ms to wait for response (default 2000) |

### `send_keys`
Send special keys in sequence. Navigate menus, confirm dialogs, cancel processes.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session from spawn |
| `keys` | string[] | Keys to send: `up`, `down`, `enter`, `tab`, `escape`, `space`, `ctrl+c`, `y`, `n`, `1`-`9`, etc. |
| `waitMs` | number? | Ms to wait after (default 1500) |

### `get_screen`
Capture current terminal screen as clean text. Optionally search with regex.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session from spawn |
| `search` | string? | Regex to search in screen content |

### `wait_for`
Wait for a pattern to appear in the output. Use for builds, installs, or any long-running process.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session from spawn |
| `pattern` | string | Regex to wait for |
| `timeoutMs` | number? | Max wait (default 30000) |

### `resize`
Resize the terminal. Useful when TUI content is clipped.

### `list_sessions`
List all active sessions.

### `close`
Kill and clean up a session. Returns final screen state.

## Key Feature: Screen Rendering

Unlike raw PTY wrappers, `interactive-cli` uses **xterm headless** to maintain a virtual terminal buffer. This means:

- **TUI menus** render as clean text grids, not ANSI escape soup
- **Progress bars** show their actual visual state
- **Cursor position** is tracked for context
- **Scrollback** is preserved (1000 lines)

The agent sees exactly what a human would see in their terminal.

## Example Flows

### EAS Build (iOS credentials)
```
spawn("cd mobile && eas build --platform ios --profile production --auto-submit")
→ see prompt for Distribution Certificate
send_input("y")
→ see prompt for provisioning profile
send_keys(["down", "enter"])
→ build starts
wait_for("Build complete|failed", timeoutMs: 600000)
```

### SSH into a server
```
spawn("ssh user@server.com")
→ see password prompt
send_input("mypassword")
→ see shell
send_input("ls -la")
→ see file listing
close(sessionId)
```

### Interactive npm init
```
spawn("npm init")
→ see "package name:" prompt
send_input("my-package")
→ see "version:" prompt
send_input("1.0.0")
...
```

## Architecture

```
AI Agent ←→ MCP Protocol ←→ interactive-cli server
                                    │
                              ┌─────┴─────┐
                              │  Session   │
                              │  Manager   │
                              └─────┬─────┘
                                    │
                          ┌─────────┼─────────┐
                          │         │         │
                       node-pty   xterm    Output
                       (real PTY) (render) (truncate)
```

## Optimized for Claude Code

- Output truncated at 80K chars (Claude Code's limit is 100K)
- Smart middle-truncation preserves start and end of long output
- Screen rendering eliminates ANSI parsing burden from the LLM
- `wait_for` prevents unnecessary polling tool calls
- Session cleanup on close prevents resource leaks

## License

MIT
