# interactive-cli

MCP server that gives AI coding agents the ability to interact with interactive CLI processes. Spawn a real PTY, see the terminal screen as clean text via xterm headless, send keystrokes, navigate TUI menus, and wait for patterns — all through the Model Context Protocol.

**Built for [Claude Code](https://claude.ai/code)**, works with any MCP-compatible agent (Cursor, Windsurf, etc.).

## The Problem

AI coding agents can run shell commands, but they can't interact with processes that ask questions:

```
$ eas build --platform ios
✔ Select a build profile › (waiting for input...)
```

The agent gets stuck. You have to take over manually.

## The Solution

`interactive-cli` gives your agent a real terminal it can see and control:

```
Agent: spawn("eas build --platform ios")
→ Screen shows: "Select a build profile: ❯ development  staging  production"

Agent: send_keys(["down", "down", "enter"])
→ Screen shows: "✔ Selected: production"

Agent: wait_for("Build complete|error", timeoutMs: 300000)
→ Waits up to 5 min, returns screen when pattern matches
```

## Install

### Claude Code

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

## Tools (9)

### `spawn` — Start Interactive Process
Start a command in a real PTY with virtual terminal rendering.

```
spawn({ command: "eas build --platform ios", cwd: "/path/to/mobile" })
→ { sessionId: "s1", screen: "...", alive: true }
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | required | Full command to run |
| `cwd` | string | cwd | Working directory |
| `env` | object | {} | Extra environment variables |
| `cols` | number | 120 | Terminal width |
| `rows` | number | 30 | Terminal height |
| `waitMs` | number | 2000 | Ms to wait for initial output |

### `send_input` — Type Text
Send text input. Appends Enter by default.

```
send_input({ sessionId: "s1", text: "y" })
send_input({ sessionId: "s1", text: "password123", pressEnter: false })
```

### `send_keys` — Navigate Menus & Send Special Keys
Send one or more keys in sequence. Supports 50+ keys including arrows, function keys, ctrl combos.

```
send_keys({ sessionId: "s1", keys: ["down", "down", "enter"] })
send_keys({ sessionId: "s1", keys: ["ctrl+c"] })
```

**Available keys:** `enter`, `tab`, `escape`, `space`, `up`, `down`, `left`, `right`, `ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+l`, `ctrl+a`, `ctrl+e`, `ctrl+r`, `ctrl+w`, `ctrl+u`, `ctrl+k`, `ctrl+p`, `ctrl+n`, `backspace`, `delete`, `home`, `end`, `page_up`, `page_down`, `f1`-`f12`, `y`, `n`, `0`-`9`

### `get_screen` — Capture Terminal
See exactly what a human would see. Optional regex search with context.

```
get_screen({ sessionId: "s1" })
get_screen({ sessionId: "s1", search: "error|warning" })
→ { screen: "...", cursor: { row: 5, col: 0 }, searchResults: "..." }
```

### `wait_for` — Smart Pattern Waiting
Wait until output matches a pattern. Avoids polling with repeated get_screen calls.

```
wait_for({ sessionId: "s1", pattern: "Build complete|error", timeoutMs: 300000 })
→ { matched: true, screen: "...", elapsed: "45s" }
```

### `wait_for_exit` — Wait for Process to Finish
Wait until the process exits. Returns final screen and exit code.

```
wait_for_exit({ sessionId: "s1", timeoutMs: 60000 })
→ { alive: false, exitCode: 0, screen: "..." }
```

### `resize` — Resize Terminal
Resize the PTY. Some TUIs reflow content on resize.

### `list_sessions` — List Active Sessions
Shows all sessions with uptime, status, and byte counts.

### `close` — Kill Session
SIGTERM → SIGKILL → cleanup. Returns final screen.

## Resources

Sessions are exposed as MCP resources that Claude Code can read directly:

| URI | Description |
|-----|-------------|
| `interactive-cli://sessions` | List of all active sessions |
| `interactive-cli://sessions/{id}/screen` | Live screen content for a session |

## Prompt Templates

Pre-built flows available as slash commands in Claude Code:

| Prompt | Usage |
|--------|-------|
| `eas_build` | Interactive EAS build with credential handling |
| `ssh_session` | SSH connection with command execution |
| `repl_session` | Start Python, Node, psql, or any REPL |
| `docker_interactive` | Run an interactive Docker container |

## Claude Code Integration Details

Optimized based on analysis of Claude Code's MCP consumption:

- **Tool annotations**: `readOnlyHint` on read-only tools enables parallel execution. `destructiveHint` on mutating tools triggers permission checks.
- **Output size**: Truncated at 80K chars (Claude Code limit is 100K) with smart middle-truncation preserving start/end.
- **Screen rendering**: xterm headless converts raw ANSI into clean 2D text, eliminating escape sequence noise for the LLM.
- **`_meta` fields**: Every result includes timing, tool name, and version for observability.
- **Resource notifications**: `sendResourceListChanged()` on session close keeps resource cache fresh.
- **50+ key types**: Full keyboard support including function keys, ctrl combos, home/end, page up/down.

## Architecture

```
AI Agent ←→ MCP Protocol ←→ interactive-cli MCP server
                                    │
                          ┌─────────┼──────────┐
                          │         │          │
                       node-pty   xterm     Resources
                       (real PTY) (render)  (sessions)
                          │         │          │
                          └─────────┼──────────┘
                                    │
                              ┌─────┴─────┐
                              │  Session   │
                              │  Manager   │
                              └───────────┘
```

## Comparison with Alternatives

| Feature | interactive-cli | interactive-shell-mcp | terminal-mcp | PiloTY |
|---------|----------------|----------------------|--------------|--------|
| Screen rendering (xterm) | ✅ | ✅ | ❌ | ✅ |
| `wait_for` pattern | ✅ | ❌ | ❌ | ❌ |
| `wait_for_exit` | ✅ | ❌ | ❌ | ❌ |
| Batch `send_keys` (50+ keys) | ✅ | ❌ | ❌ | ❌ |
| Screen search (regex) | ✅ | ✅ | ❌ | ❌ |
| Cursor position | ✅ | ✅ | ❌ | ❌ |
| MCP Resources | ✅ | ❌ | ❌ | ❌ |
| MCP Prompts (templates) | ✅ | ❌ | ❌ | ❌ |
| Tool annotations | ✅ | ❌ | ❌ | ❌ |
| `_meta` observability | ✅ | ❌ | ❌ | ❌ |
| Smart truncation (80K) | ✅ | ❌ | ❌ | ❌ |
| Claude Code optimized | ✅ | ❌ | ❌ | ❌ |

## License

MIT
