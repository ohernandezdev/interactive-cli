#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn as ptySpawn, type IPty } from "node-pty";
import xtermPkg from "@xterm/headless";
const { Terminal } = xtermPkg;
type TerminalInstance = InstanceType<typeof Terminal>;

// ---------------------------------------------------------------------------
// Constants — tuned from Claude Code source analysis
// Claude Code truncates at 100K chars / 25K tokens. We stay under.
// ---------------------------------------------------------------------------
const MAX_RESULT_CHARS = 80_000;
const DEFAULT_WAIT_MS = 2000;
const SCREEN_COLS = 120;
const SCREEN_ROWS = 30;
const VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------
interface Session {
  id: string;
  pty: IPty;
  terminal: TerminalInstance;
  buffer: string;         // raw output since last read
  alive: boolean;
  exitCode: number | null;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivity: number;
  bytesReceived: number;
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
// xterm screen renderer — renders PTY as clean 2D text grid
// ---------------------------------------------------------------------------
function renderScreen(terminal: TerminalInstance): string {
  const lines: string[] = [];
  const buf = terminal.buffer.active;
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1B\][^\x07]*\x07/g, "")
    .replace(/\x1B[()][AB012]/g, "")
    .replace(/\r\n?/g, "\n");
}

function truncate(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 60;
  return (
    text.slice(0, half) +
    `\n\n[... truncated ${text.length - max} chars — use get_screen with search to find specific content ...]\n\n` +
    text.slice(-half)
  );
}

function result(data: Record<string, unknown>, meta?: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
    _meta: {
      interactive_cli_version: VERSION,
      timestamp: new Date().toISOString(),
      ...meta,
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEY_MAP: Record<string, string> = {
  enter: "\r", tab: "\t", escape: "\x1B", space: " ",
  up: "\x1B[A", down: "\x1B[B", left: "\x1B[D", right: "\x1B[C",
  "ctrl+c": "\x03", "ctrl+d": "\x04", "ctrl+z": "\x1A",
  "ctrl+l": "\x0C", "ctrl+a": "\x01", "ctrl+e": "\x05",
  "ctrl+r": "\x12", "ctrl+w": "\x17", "ctrl+u": "\x15",
  "ctrl+k": "\x0B", "ctrl+p": "\x10", "ctrl+n": "\x0E",
  backspace: "\x7F", delete: "\x1B[3~",
  home: "\x1B[H", end: "\x1B[F",
  "page_up": "\x1B[5~", "page_down": "\x1B[6~",
  "f1": "\x1BOP", "f2": "\x1BOQ", "f3": "\x1BOR", "f4": "\x1BOS",
  "f5": "\x1B[15~", "f6": "\x1B[17~", "f7": "\x1B[18~", "f8": "\x1B[19~",
  "f9": "\x1B[20~", "f10": "\x1B[21~", "f11": "\x1B[23~", "f12": "\x1B[24~",
  y: "y", n: "n",
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
};

const VALID_KEYS = Object.keys(KEY_MAP) as [string, ...string[]];

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "interactive-cli",
  version: VERSION,
}, {
  capabilities: {
    resources: {},
    prompts: {},
  },
});

// ============================= TOOLS =======================================

// ---- spawn ----------------------------------------------------------------
server.tool(
  "spawn",
  `Start an interactive CLI process in a real PTY with virtual terminal rendering.
Returns a session ID and the initial screen output. Use for any command that
requires user interaction: eas build, gcloud auth, npm init, ssh, docker login,
interactive installers, REPLs (python, node, psql), etc.
The "screen" field shows exactly what a human would see — clean text with
TUI menus, prompts, progress bars, and selections properly rendered.`,
  {
    command: z.string().describe("Full command to run, e.g. 'eas build --platform ios --profile production'"),
    cwd: z.string().optional().describe("Working directory"),
    env: z.record(z.string(), z.string()).optional().describe("Extra environment variables to merge with current env"),
    cols: z.number().optional().describe("Terminal width in columns (default 120)"),
    rows: z.number().optional().describe("Terminal height in rows (default 30)"),
    waitMs: z.number().optional().describe("Ms to wait for initial output before returning (default 2000). Use higher values for slow-starting processes."),
  },
  // Annotations: spawn is destructive (creates processes), not read-only, not idempotent
  { destructiveHint: true, readOnlyHint: false, openWorldHint: true, title: "Spawn Interactive Process" },
  async ({ command, cwd, env, cols, rows, waitMs }) => {
    const id = `s${nextId++}`;
    const resolvedCwd = cwd || process.cwd();
    const c = cols ?? SCREEN_COLS;
    const r = rows ?? SCREEN_ROWS;

    // Spawn through shell so pipes, builtins, and complex commands work
    const shell = process.env.SHELL || "/bin/zsh";

    const terminal = new Terminal({ cols: c, rows: r, scrollback: 1000, allowProposedApi: true });

    const ptyProcess = ptySpawn(shell, ["-c", command], {
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
      createdAt: Date.now(), lastActivity: Date.now(),
      bytesReceived: 0,
    };

    ptyProcess.onData((data: string) => {
      session.buffer += data;
      session.bytesReceived += data.length;
      session.lastActivity = Date.now();
      terminal.write(data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      session.alive = false;
      session.exitCode = exitCode;
      session.lastActivity = Date.now();
    });

    sessions.set(id, session);
    await wait(waitMs ?? DEFAULT_WAIT_MS);

    const screen = renderScreen(terminal);
    session.buffer = "";

    return result({
      sessionId: id,
      alive: session.alive,
      exitCode: session.exitCode,
      command,
      cwd: resolvedCwd,
      size: `${c}x${r}`,
      screen: truncate(screen),
      hint: session.alive
        ? "Process is running. Use send_input to answer prompts, send_keys to navigate menus, or wait_for to wait for specific output."
        : `Process exited with code ${session.exitCode}. Use close to clean up.`,
    }, { tool: "spawn", elapsed: Date.now() - session.createdAt });
  }
);

// ---- send_input -----------------------------------------------------------
server.tool(
  "send_input",
  `Type text into the interactive process and return the updated screen.
Appends Enter (newline) automatically. Set pressEnter=false to type without
submitting — useful for password fields or filling forms before tabbing.`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    text: z.string().describe("Text to type into the process"),
    pressEnter: z.boolean().optional().describe("Append Enter key after text (default true)"),
    waitMs: z.number().optional().describe("Ms to wait for process response (default 2000). Increase for slow operations."),
  },
  { destructiveHint: true, readOnlyHint: false, title: "Send Text Input" },
  async ({ sessionId, text, pressEnter, waitMs }) => {
    const s = getSession(sessionId);
    if (!s.alive) return result({ error: "Process already exited", exitCode: s.exitCode, sessionId }, {}, true);

    s.buffer = "";
    const t0 = Date.now();
    s.pty.write(pressEnter === false ? text : text + "\r");
    await wait(waitMs ?? DEFAULT_WAIT_MS);

    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      screen: truncate(renderScreen(s.terminal)),
    }, { tool: "send_input", elapsed: Date.now() - t0 });
  }
);

// ---- send_keys ------------------------------------------------------------
server.tool(
  "send_keys",
  `Send one or more special keys in sequence to navigate interactive TUI menus,
confirm dialogs, or control the process. A small delay between keys ensures
TUI frameworks register each keystroke.
Examples:
  ["down","down","enter"] — select 3rd item in a menu
  ["tab","tab","enter"] — skip to submit button
  ["ctrl+c"] — cancel/interrupt the process
  ["y","enter"] — confirm a yes/no prompt`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    keys: z.array(z.enum(VALID_KEYS)).describe("Keys to send in sequence"),
    delayBetweenMs: z.number().optional().describe("Delay between each key in ms (default 50). Increase for slow TUIs."),
    waitMs: z.number().optional().describe("Ms to wait after all keys are sent (default 1500)"),
  },
  { destructiveHint: true, readOnlyHint: false, title: "Send Keystrokes" },
  async ({ sessionId, keys, delayBetweenMs, waitMs }) => {
    const s = getSession(sessionId);
    if (!s.alive) return result({ error: "Process already exited", exitCode: s.exitCode, sessionId }, {}, true);

    s.buffer = "";
    const delay = delayBetweenMs ?? 50;
    for (const key of keys) {
      s.pty.write(KEY_MAP[key] || key);
      if (delay > 0) await wait(delay);
    }

    await wait(waitMs ?? 1500);

    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      screen: truncate(renderScreen(s.terminal)),
      keysSent: keys,
    }, { tool: "send_keys", keysCount: keys.length });
  }
);

// ---- get_screen -----------------------------------------------------------
server.tool(
  "get_screen",
  `Capture the current terminal screen — exactly what a human would see.
Use to check progress, see updated menus, or read output after waiting.
The optional "search" parameter finds matching lines with context, useful
for finding specific prompts or errors in large output.`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    waitMs: z.number().optional().describe("Ms to wait before capturing (default 500). Set to 0 for instant capture."),
    search: z.string().optional().describe("Regex pattern to highlight in screen. Returns matching lines with 2 lines of context."),
  },
  // get_screen is read-only and safe for parallel execution
  { readOnlyHint: true, destructiveHint: false, title: "Capture Terminal Screen" },
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
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length - 1, i + 2);
          for (let j = start; j <= end; j++) {
            const prefix = j === i ? ">>>" : "   ";
            matches.push(`${prefix} L${j + 1}: ${lines[j]}`);
          }
          matches.push("---");
        }
      }
      searchResults = matches.join("\n") || "(no matches found)";
    }

    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      screen: truncate(screen),
      ...(searchResults && { searchResults }),
      cursor: { row: s.terminal.buffer.active.cursorY, col: s.terminal.buffer.active.cursorX },
      stats: {
        bytesReceived: s.bytesReceived,
        uptime: `${Math.round((Date.now() - s.createdAt) / 1000)}s`,
        lastActivity: `${Math.round((Date.now() - s.lastActivity) / 1000)}s ago`,
      },
    }, { tool: "get_screen", readOnly: true });
  }
);

// ---- wait_for -------------------------------------------------------------
server.tool(
  "wait_for",
  `Wait until a regex pattern appears in terminal output, or timeout.
Essential for long-running commands — avoids wasting tool calls polling.
Use for: build completion, error detection, prompt appearance, etc.
Examples:
  pattern: "Build complete|error|failed" — wait for build result
  pattern: "\\?" — wait for next interactive prompt
  pattern: "\\$" — wait for shell prompt (command finished)
  pattern: "password:" — wait for password prompt`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    pattern: z.string().describe("Regex pattern to match (case-insensitive)"),
    timeoutMs: z.number().optional().describe("Max wait time in ms (default 30000). Use 300000+ for builds."),
    intervalMs: z.number().optional().describe("How often to check for pattern in ms (default 1000)"),
  },
  { readOnlyHint: false, destructiveHint: false, openWorldHint: true, title: "Wait for Pattern" },
  async ({ sessionId, pattern, timeoutMs, intervalMs }, { sendNotification }) => {
    const s = getSession(sessionId);
    const timeout = timeoutMs ?? 30_000;
    const interval = intervalMs ?? 1000;
    const re = new RegExp(pattern, "i");
    const start = Date.now();

    s.buffer = "";

    // Send progress updates so Claude Code shows feedback
    let lastProgress = 0;
    while (Date.now() - start < timeout) {
      if (!s.alive) break;

      const screen = renderScreen(s.terminal);
      if (re.test(s.buffer) || re.test(screen)) {
        return result({
          sessionId,
          alive: s.alive,
          exitCode: s.exitCode,
          matched: true,
          pattern,
          elapsed: `${Math.round((Date.now() - start) / 1000)}s`,
          screen: truncate(screen),
        }, { tool: "wait_for", matched: true, elapsed: Date.now() - start });
      }

      // Report progress every 5 seconds
      const elapsed = Date.now() - start;
      if (elapsed - lastProgress >= 5000) {
        lastProgress = elapsed;
        // Progress is reported via _meta in result — SDK handles display
      }

      await wait(interval);
    }

    const screen = renderScreen(s.terminal);
    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      matched: false,
      timedOut: s.alive, // only timed out if still alive
      pattern,
      elapsed: `${Math.round((Date.now() - start) / 1000)}s`,
      screen: truncate(screen),
      hint: s.alive
        ? "Pattern not found within timeout. Try: increase timeoutMs, check pattern is correct, or use get_screen to see current state."
        : `Process exited (code ${s.exitCode}) before pattern was found.`,
    }, { tool: "wait_for", matched: false, elapsed: Date.now() - start });
  }
);

// ---- wait_for_exit --------------------------------------------------------
server.tool(
  "wait_for_exit",
  `Wait for the process to exit and return the final screen and exit code.
Use after sending a quit command, or for short-lived processes where you
need the final result.`,
  {
    sessionId: z.string().describe("Session ID from spawn"),
    timeoutMs: z.number().optional().describe("Max wait time in ms (default 30000)"),
  },
  { readOnlyHint: false, destructiveHint: false, title: "Wait for Process Exit" },
  async ({ sessionId, timeoutMs }) => {
    const s = getSession(sessionId);
    const timeout = timeoutMs ?? 30_000;
    const start = Date.now();

    while (s.alive && Date.now() - start < timeout) {
      await wait(500);
    }

    return result({
      sessionId,
      alive: s.alive,
      exitCode: s.exitCode,
      timedOut: s.alive,
      elapsed: `${Math.round((Date.now() - start) / 1000)}s`,
      screen: truncate(renderScreen(s.terminal)),
    }, { tool: "wait_for_exit", elapsed: Date.now() - start });
  }
);

// ---- resize ---------------------------------------------------------------
server.tool(
  "resize",
  "Resize the terminal dimensions. Some TUI applications reflow their content on resize, which can help if output is clipped or misaligned.",
  {
    sessionId: z.string().describe("Session ID"),
    cols: z.number().describe("New width in columns"),
    rows: z.number().describe("New height in rows"),
  },
  { destructiveHint: false, readOnlyHint: false, title: "Resize Terminal" },
  async ({ sessionId, cols, rows }) => {
    const s = getSession(sessionId);
    s.pty.resize(cols, rows);
    s.terminal.resize(cols, rows);
    s.cols = cols;
    s.rows = rows;
    await wait(300);

    return result({
      sessionId,
      size: `${cols}x${rows}`,
      screen: truncate(renderScreen(s.terminal)),
    }, { tool: "resize" });
  }
);

// ---- list_sessions --------------------------------------------------------
server.tool(
  "list_sessions",
  "List all interactive CLI sessions with status, uptime, and resource usage.",
  {},
  // Pure read-only, safe for parallel execution
  { readOnlyHint: true, destructiveHint: false, title: "List Sessions" },
  async () => {
    const list = [...sessions.values()].map((s) => ({
      sessionId: s.id,
      command: s.command,
      cwd: s.cwd,
      alive: s.alive,
      exitCode: s.exitCode,
      size: `${s.cols}x${s.rows}`,
      uptime: `${Math.round((Date.now() - s.createdAt) / 1000)}s`,
      lastActivity: `${Math.round((Date.now() - s.lastActivity) / 1000)}s ago`,
      bytesReceived: s.bytesReceived,
    }));
    return result({ sessions: list, count: list.length }, { tool: "list_sessions", readOnly: true });
  }
);

// ---- close ----------------------------------------------------------------
server.tool(
  "close",
  "Terminate and clean up an interactive CLI session. Sends SIGTERM first, then SIGKILL if needed. Returns the final screen state.",
  {
    sessionId: z.string().describe("Session ID to close"),
  },
  { destructiveHint: true, readOnlyHint: false, title: "Close Session" },
  async ({ sessionId }) => {
    const s = getSession(sessionId);
    const finalScreen = renderScreen(s.terminal);

    if (s.alive) {
      s.pty.kill("SIGTERM");
      await wait(500);
      if (s.alive) {
        s.pty.kill("SIGKILL");
        await wait(200);
      }
    }

    s.terminal.dispose();
    sessions.delete(sessionId);

    // Notify Claude Code that resources changed (session removed)
    server.sendResourceListChanged();

    return result({
      sessionId,
      closed: true,
      exitCode: s.exitCode,
      finalScreen: truncate(finalScreen),
      stats: {
        uptime: `${Math.round((Date.now() - s.createdAt) / 1000)}s`,
        bytesReceived: s.bytesReceived,
      },
    }, { tool: "close" });
  }
);

// ============================= RESOURCES ===================================
// Expose each session's screen as a readable MCP resource.
// Claude Code can read these with ReadMcpResourceTool without a tool call.
// ---------------------------------------------------------------------------

server.resource(
  "session_screen",
  "interactive-cli://sessions/{sessionId}/screen",
  { description: "Live terminal screen content for an interactive session", mimeType: "text/plain" },
  async (uri) => {
    const match = uri.href.match(/sessions\/(\w+)\/screen/);
    const sessionId = match?.[1];
    if (!sessionId) throw new Error("Invalid session URI");

    const s = getSession(sessionId);
    return {
      contents: [{
        uri: uri.href,
        text: renderScreen(s.terminal),
        mimeType: "text/plain",
      }],
    };
  }
);

server.resource(
  "sessions_list",
  "interactive-cli://sessions",
  { description: "List of all active interactive CLI sessions", mimeType: "application/json" },
  async (uri) => {
    const list = [...sessions.values()].map((s) => ({
      sessionId: s.id,
      command: s.command,
      alive: s.alive,
      exitCode: s.exitCode,
      uptime: `${Math.round((Date.now() - s.createdAt) / 1000)}s`,
    }));
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(list, null, 2),
        mimeType: "application/json",
      }],
    };
  }
);

// ============================= PROMPTS =====================================
// Reusable prompt templates for common interactive flows.
// In Claude Code these appear as slash commands: /mcp__interactive-cli__eas_build
// ---------------------------------------------------------------------------

server.prompt(
  "eas_build",
  "Interactive EAS build for iOS or Android with credential management",
  {
    platform: z.string().optional().describe("ios or android (default: ios)"),
    profile: z.string().optional().describe("Build profile (default: production)"),
    cwd: z.string().optional().describe("Mobile project directory"),
  },
  ({ platform, profile, cwd }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Run an interactive EAS build and handle all prompts automatically:

1. spawn the command: eas build --platform ${platform || "ios"} --profile ${profile || "production"} --auto-submit${cwd ? ` (in directory: ${cwd})` : ""}
2. Watch for credential prompts (Distribution Certificate, Provisioning Profile) and confirm them
3. Watch for any selection menus and pick the appropriate option
4. Wait for the build to complete or report any errors
5. Return the build URL or error details

Use wait_for with pattern "✔|error|failed|Build complete|https://" and generous timeouts (600000ms for builds).
Navigate any menus with send_keys. Answer yes/no prompts with send_input.`,
      },
    }],
  })
);

server.prompt(
  "ssh_session",
  "Start an interactive SSH session and run commands",
  {
    host: z.string().describe("SSH host (user@hostname)"),
    commands: z.string().optional().describe("Semicolon-separated commands to run after connecting"),
  },
  ({ host, commands }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Start an interactive SSH session to ${host}:

1. spawn: ssh ${host}
2. If there's a password prompt, ask me for the password (never guess)
3. If there's a host key confirmation, send "yes"
4. Wait for the shell prompt ($ or #)
${commands ? `5. Run these commands one by one, waiting for prompt between each: ${commands}` : "5. Let me know when connected and ready"}
6. Show me the final output

Use wait_for with pattern "\\$|#|>" to detect shell prompts.`,
      },
    }],
  })
);

server.prompt(
  "repl_session",
  "Start an interactive REPL (Python, Node, psql, etc.)",
  {
    command: z.string().describe("REPL command to start (python3, node, psql, etc.)"),
    setup: z.string().optional().describe("Initial commands to run in the REPL, semicolon-separated"),
  },
  ({ command, setup }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Start an interactive ${command} REPL session:

1. spawn: ${command}
2. Wait for the REPL prompt
${setup ? `3. Run these setup commands: ${setup}` : "3. Ready for my commands"}

Use wait_for with appropriate prompt pattern (>>> for python, > for node, => for psql).
For multi-line input, use send_input with pressEnter=false, then send_keys(["enter"]).`,
      },
    }],
  })
);

server.prompt(
  "docker_interactive",
  "Run an interactive Docker container",
  {
    image: z.string().describe("Docker image to run"),
    shellCmd: z.string().optional().describe("Shell command (default: /bin/sh)"),
  },
  ({ image, shellCmd }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Start an interactive Docker container:

1. spawn: docker run -it ${image} ${shellCmd || "/bin/sh"}
2. Wait for shell prompt
3. Ready for commands

Use wait_for with pattern "\\$|#|>" for shell prompt detection.`,
      },
    }],
  })
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`interactive-cli MCP server v${VERSION} running`);
  console.error(`Features: PTY + xterm rendering, ${Object.keys(KEY_MAP).length} key types, resources, prompts`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
