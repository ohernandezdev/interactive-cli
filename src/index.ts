#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn as ptySpawn, type IPty } from "node-pty";
import xtermPkg from "@xterm/headless";
const { Terminal } = xtermPkg;
type TerminalInstance = InstanceType<typeof Terminal>;

// ---------------------------------------------------------------------------
// Constants tuned for Claude Code's MCP consumption
// ---------------------------------------------------------------------------
const MAX_RESULT_CHARS = 80_000; // Claude Code truncates at 100K, leave margin
const DEFAULT_WAIT_MS = 2000;
const SCREEN_COLS = 120;
const SCREEN_ROWS = 30;

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------
interface Session {
  id: string;
  pty: IPty;
  terminal: TerminalInstance;     // xterm headless for clean screen rendering
  buffer: string;         // raw output since last read
  alive: boolean;
  exitCode: number | null;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
}

const sessions = new Map<string, Session>();
let nextId = 1;

function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) {
    const active = [...sessions.keys()].join(", ") || "none";
    throw new Error(`Session "${id}" not found. Active: ${active}`);
  }
  return s;
}

// ---------------------------------------------------------------------------
// xterm screen renderer — the killer feature
// Renders the terminal buffer as a clean 2D text grid, exactly what an AI
// agent needs to "see" TUI menus, prompts, and interactive selections.
// ---------------------------------------------------------------------------
function renderScreen(terminal: TerminalInstance): string {
  const lines: string[] = [];
  const buf = terminal.buffer.active;
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

/** Strip ANSI for raw output mode (fallback when screen isn't useful) */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B[()][AB012]/g, "")
    .replace(/\r\n?/g, "\n");
}

/** Truncate to fit Claude Code's result limit */
function truncate(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 50;
  return (
    text.slice(0, half) +
    `\n\n[... truncated ${text.length - max} chars ...]\n\n` +
    text.slice(-half)
  );
}

function result(data: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "interactive-cli",
  version: "1.0.0",
});

// ---- spawn ----------------------------------------------------------------
server.tool(
  "spawn",
  `Start an interactive CLI process in a real PTY with a virtual terminal.
Returns a session ID. Use for commands requiring user input: eas build,
gcloud auth, npm init, ssh, docker login, interactive installers, etc.
The output includes a rendered "screen" showing exactly what a human would
see in their terminal — menus, prompts, selections, and progress bars
rendered as clean text.`,
  {
    command: z.string().describe("Full command to run, e.g. 'eas build --platform ios --profile production'"),
    cwd: z.string().optional().describe("Working directory"),
    env: z.record(z.string(), z.string()).optional().describe("Extra env vars"),
    cols: z.number().optional().describe("Terminal width (default 120)"),
    rows: z.number().optional().describe("Terminal height (default 30)"),
    waitMs: z.number().optional().describe("Ms to wait for initial output (default 2000)"),
  },
  async ({ command, cwd, env, cols, rows, waitMs }) => {
    const id = `s${nextId++}`;
    const resolvedCwd = cwd || process.cwd();
    const c = cols ?? SCREEN_COLS;
    const r = rows ?? SCREEN_ROWS;

    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [command];
    const exe = parts[0]!.replace(/^["']|["']$/g, "");
    const args = parts.slice(1).map(a => a.replace(/^["']|["']$/g, ""));

    // Create virtual terminal for screen rendering
    const terminal = new Terminal({ cols: c, rows: r, scrollback: 1000 });

    const ptyProcess = ptySpawn(exe, args, {
      name: "xterm-256color",
      cols: c,
      rows: r,
      cwd: resolvedCwd,
      env: { ...process.env, ...env } as Record<string, string>,
    });

    const session: Session = {
      id, pty: ptyProcess, terminal,
      buffer: "", alive: true, exitCode: null,
      command, cwd: resolvedCwd, cols: c, rows: r,
      createdAt: Date.now(),
    };

    ptyProcess.onData((data: string) => {
      session.buffer += data;
      terminal.write(data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      session.alive = false;
      session.exitCode = exitCode;
    });

    sessions.set(id, session);
    await wait(waitMs ?? DEFAULT_WAIT_MS);

    const screen = renderScreen(terminal);
    const raw = stripAnsi(session.buffer);
    session.buffer = "";

    return result({
      sessionId: id,
      alive: session.alive,
      exitCode: session.exitCode,
      command,
      cwd: resolvedCwd,
      screen: truncate(screen),
      raw: screen !== raw ? truncate(raw) : undefined,
    });
  }
);

// ---- send_input -----------------------------------------------------------
server.tool(
  "send_input",
  `Send text to an interactive session and return the updated screen.
Appends Enter (newline) by default. Set pressEnter=false to type without
submitting — useful for filling fields before tabbing to next.`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    text: z.string().describe("Text to type into the process"),
    pressEnter: z.boolean().optional().describe("Append Enter key after text (default true)"),
    waitMs: z.number().optional().describe("Ms to wait for response (default 2000)"),
  },
  async ({ sessionId, text, pressEnter, waitMs }) => {
    const s = getSession(sessionId);
    if (!s.alive) return result({ error: "Process already exited", exitCode: s.exitCode, sessionId }, true);

    s.buffer = "";
    s.pty.write(pressEnter === false ? text : text + "\r");
    await wait(waitMs ?? DEFAULT_WAIT_MS);

    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      screen: truncate(renderScreen(s.terminal)),
    });
  }
);

// ---- send_keys ------------------------------------------------------------
server.tool(
  "send_keys",
  `Send one or more special keys to navigate interactive menus, confirm dialogs,
or control the process. Keys are sent in sequence with a small delay between them.
Examples: ["down","down","enter"] to select 3rd menu item,
["tab","tab","enter"] to skip to submit button.`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    keys: z.array(z.enum([
      "enter", "tab", "escape", "space",
      "up", "down", "left", "right",
      "ctrl+c", "ctrl+d", "ctrl+z", "ctrl+l", "ctrl+a", "ctrl+e",
      "backspace", "delete",
      "y", "n",
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
    ])).describe("Keys to send in order"),
    waitMs: z.number().optional().describe("Ms to wait after all keys sent (default 1500)"),
  },
  async ({ sessionId, keys, waitMs }) => {
    const s = getSession(sessionId);
    if (!s.alive) return result({ error: "Process already exited", exitCode: s.exitCode, sessionId }, true);

    const keyMap: Record<string, string> = {
      enter: "\r", tab: "\t", escape: "\x1B", space: " ",
      up: "\x1B[A", down: "\x1B[B", left: "\x1B[D", right: "\x1B[C",
      "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+z": "\x1A",
      "ctrl+l": "\x0C", "ctrl+a": "\x01", "ctrl+e": "\x05",
      backspace: "\x7F", delete: "\x1B[3~",
      y: "y", n: "n",
      "1": "1", "2": "2", "3": "3", "4": "4", "5": "5",
      "6": "6", "7": "7", "8": "8", "9": "9", "0": "0",
    };

    s.buffer = "";
    for (const key of keys) {
      s.pty.write(keyMap[key] || key);
      await wait(50); // Small delay between keys for TUI rendering
    }

    await wait(waitMs ?? 1500);

    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      screen: truncate(renderScreen(s.terminal)),
    });
  }
);

// ---- get_screen -----------------------------------------------------------
server.tool(
  "get_screen",
  `Get the current terminal screen contents — what a human would see right now.
Use to check progress, see updated menus after navigation, or read long output.
Optionally search for a pattern in the screen content.`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    waitMs: z.number().optional().describe("Ms to wait before capturing (default 500)"),
    search: z.string().optional().describe("Regex pattern to search in screen. Returns matching lines with context."),
  },
  async ({ sessionId, waitMs, search }) => {
    const s = getSession(sessionId);
    await wait(waitMs ?? 500);

    const screen = renderScreen(s.terminal);
    let searchResults: string | undefined;

    if (search) {
      const re = new RegExp(search, "gi");
      const lines = screen.split("\n");
      const matches: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          // Include 1 line of context above and below
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length - 1, i + 1);
          for (let j = start; j <= end; j++) {
            const prefix = j === i ? ">>> " : "    ";
            matches.push(`${prefix}${j + 1}: ${lines[j]}`);
          }
          matches.push("");
        }
      }
      searchResults = matches.join("\n") || "(no matches)";
    }

    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      screen: truncate(screen),
      ...(searchResults && { searchResults }),
      cursorY: s.terminal.buffer.active.cursorY,
      cursorX: s.terminal.buffer.active.cursorX,
    });
  }
);

// ---- wait_for --------------------------------------------------------------
server.tool(
  "wait_for",
  `Wait until a pattern appears in the terminal output or a timeout is reached.
Essential for long-running commands like builds — instead of polling with
get_screen, use this to wait for "Build complete", "error:", "?", etc.
Returns the screen when the pattern matches or timeout expires.`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    pattern: z.string().describe("Regex pattern to wait for in new output"),
    timeoutMs: z.number().optional().describe("Max wait time in ms (default 30000)"),
    intervalMs: z.number().optional().describe("Check interval in ms (default 1000)"),
  },
  async ({ sessionId, pattern, timeoutMs, intervalMs }) => {
    const s = getSession(sessionId);
    const timeout = timeoutMs ?? 30_000;
    const interval = intervalMs ?? 1000;
    const re = new RegExp(pattern, "i");
    const start = Date.now();

    s.buffer = "";

    while (Date.now() - start < timeout) {
      if (!s.alive) break;
      if (re.test(s.buffer) || re.test(renderScreen(s.terminal))) {
        return result({
          sessionId,
          alive: s.alive,
          exitCode: s.exitCode,
          matched: true,
          pattern,
          elapsed: Date.now() - start,
          screen: truncate(renderScreen(s.terminal)),
        });
      }
      await wait(interval);
    }

    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      matched: false,
      pattern,
      elapsed: Date.now() - start,
      timedOut: true,
      screen: truncate(renderScreen(s.terminal)),
    });
  }
);

// ---- resize ---------------------------------------------------------------
server.tool(
  "resize",
  "Resize the terminal. Some TUIs reflow content on resize.",
  {
    sessionId: z.string().describe("Session ID"),
    cols: z.number().describe("New column count"),
    rows: z.number().describe("New row count"),
  },
  async ({ sessionId, cols, rows }) => {
    const s = getSession(sessionId);
    s.pty.resize(cols, rows);
    s.terminal.resize(cols, rows);
    s.cols = cols;
    s.rows = rows;
    await wait(300);

    return result({
      sessionId,
      cols,
      rows,
      screen: truncate(renderScreen(s.terminal)),
    });
  }
);

// ---- list_sessions --------------------------------------------------------
server.tool(
  "list_sessions",
  "List all interactive CLI sessions with their status.",
  {},
  async () => {
    const list = [...sessions.values()].map((s) => ({
      sessionId: s.id,
      command: s.command,
      cwd: s.cwd,
      alive: s.alive,
      exitCode: s.exitCode,
      age: `${Math.round((Date.now() - s.createdAt) / 1000)}s`,
      size: `${s.cols}x${s.rows}`,
    }));
    return result({ sessions: list, count: list.length });
  }
);

// ---- close ----------------------------------------------------------------
server.tool(
  "close",
  "Kill and clean up an interactive CLI session. Returns final screen state.",
  {
    sessionId: z.string().describe("Session ID to close"),
  },
  async ({ sessionId }) => {
    const s = getSession(sessionId);
    const finalScreen = renderScreen(s.terminal);

    if (s.alive) {
      s.pty.kill("SIGTERM");
      await wait(500);
      if (s.alive) s.pty.kill("SIGKILL");
      await wait(200);
    }

    s.terminal.dispose();
    sessions.delete(sessionId);

    return result({
      sessionId,
      closed: true,
      exitCode: s.exitCode,
      finalScreen: truncate(finalScreen),
    });
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("interactive-cli MCP server v1.0.0 running");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
