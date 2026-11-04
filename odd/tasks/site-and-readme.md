# GitHub Pages site and a better README

Branch `feat/site-and-readme` from `9c20458` (main). Omar, 2026-11-04: "¿te atreves a crearle un github site a este y mejorar el
readme?". Same family as flint's site (https://ohernandezdev.github.io/flint/: dark, Geist + Geist Mono, big headline left, the
product right, top nav with "Star on GitHub", a mono meta line), served the same way: GitHub Pages, legacy build from `main` /docs
(no GitHub Actions: they are blocked on the account).

## Facts (from src/index.ts v1.1.0, read 2026-11-04; nothing else is claimed)

- npm package `interactive-cli-mcp` 1.1.0, bin `interactive-cli-mcp`, MIT, Node >= 18. Dependencies: @modelcontextprotocol/sdk,
  node-pty, @xterm/headless, zod.
- Commands run as `$SHELL -c "<command>"` (`/bin/zsh` when SHELL is unset) in a node-pty PTY named xterm-256color; xterm headless
  renders the screen (scrollback 1000 lines). macOS and Linux.
- Results are JSON; any screen is capped at 80,000 characters, cut in the middle with a marker (Claude Code caps tool results at
  100,000).
- Tools (annotations): `spawn(command, cwd?, env?, cols = 120, rows = 30, waitMs = 2000)` destructive, open world;
  `send_input(sessionId, text, pressEnter = true, waitMs = 2000)` destructive; `send_keys(sessionId, keys[], delayBetweenMs = 50,
  waitMs = 1500)` destructive; `get_screen(sessionId, search?, waitMs = 500)` read-only, search = regex, matching lines with 2 lines
  of context; `wait_for(sessionId, pattern, timeoutMs = 30000, intervalMs = 1000)` regex, case-insensitive;
  `wait_for_exit(sessionId, timeoutMs = 30000)`; `resize(sessionId, cols, rows)`; `list_sessions()` read-only;
  `close(sessionId)` destructive: SIGTERM, then SIGKILL if needed, returns the final screen.
- Keys: enter tab escape space up down left right backspace delete home end page_up page_down f1-f12 ctrl+c ctrl+d ctrl+z ctrl+l
  ctrl+a ctrl+e ctrl+r ctrl+w ctrl+u ctrl+k ctrl+p ctrl+n y n 0-9.
- Resources: `interactive-cli://sessions` (JSON list), `interactive-cli://sessions/{sessionId}/screen`.
- Prompts: `eas_build(platform?, profile?, cwd?)`, `ssh_session(host, commands?)`, `repl_session(command, setup?)`,
  `docker_interactive` (see source for its arguments).
- Install: Claude Code `claude mcp add interactive-cli -- npx -y interactive-cli-mcp`; Codex CLI `codex mcp add interactive-cli
  -- npx -y interactive-cli-mcp` (writes `[mcp_servers.interactive-cli]` with `command = "npx"`, `args = ["-y",
  "interactive-cli-mcp"]` to ~/.codex/config.toml); Cursor `~/.cursor/mcp.json` `{ "mcpServers": { "interactive-cli": { "command":
  "npx", "args": ["-y", "interactive-cli-mcp"] } } }`; any stdio MCP client: `npx -y interactive-cli-mcp`.

## Site (docs/index.html, one file, inline CSS and JS; docs/.nojekyll; docs/assets/icon.svg, docs/assets/og.png 1200 x 630)

Tokens. Dark (default): `--bg #0b0d14`, `--card #12151d`, `--raised #171b25`, `--line rgba(255,255,255,0.08)`, `--line-strong
rgba(255,255,255,0.14)`, `--text #e8eaf0`, `--text2 #a3aab8`, `--muted #8b93a3`, `--accent #3CCFBD`, `--on-accent #0b0d14`. Light
(prefers-color-scheme: light): `--bg #f5f7fa`, `--card #ffffff`, `--raised #eceff4`, `--line rgba(17,24,39,0.08)`, `--line-strong
rgba(17,24,39,0.14)`, `--text #111827`, `--text2 #4b5565`, `--muted #5d6678`, `--accent #0B6B63`, `--on-accent #ffffff`. Terminal
window: always dark (`#0b0d14` body, `#12151d` title bar, text `#e8eaf0`, prompt marks `#3CCFBD`, dim `#8b93a3`, success
`#4ade80`, highlighted menu row `#3CCFBD` on `rgba(60,207,189,0.12)`). Fonts: Geist 400/500/600 and Geist Mono 400/500 (Google
Fonts, as flint). Ease `cubic-bezier(0.22, 1, 0.36, 1)`. Max content width 1136 px, gutter 24 px (16 px under 640 px).

Copy (exact):
- title: "interactive-cli · Give your AI agent a real terminal"; description: "An MCP server that lets Claude Code, Codex, Cursor and
  other AI agents run interactive commands: it starts them in a real PTY, hands the agent the rendered screen and sends its
  answers, so prompts, menus, REPLs and SSH stop being dead ends."
- Nav: logo (terminal icon, accent) + "interactive-cli"; links "How it works", "Tools", "Install", "FAQ"; button "Star on GitHub"
  (GitHub mark, https://github.com/ohernandezdev/interactive-cli).
- Hero h1: "Give your AI agent a real terminal". Lead: "interactive-cli is an MCP server that runs commands in a real
  pseudo-terminal and hands your agent the rendered screen, so it can answer prompts, pick menu items and drive REPLs, SSH and
  installers the way you would." Buttons: primary "Add to Claude Code" (copies `claude mcp add interactive-cli -- npx -y
  interactive-cli-mcp`, then reads "Copied" for 1.6 s), secondary "View on GitHub". Meta line (mono, muted): "v1.1.0 · MCP server
  · Node 18+ · macOS & Linux · MIT".
- Hero visual: a terminal window (title "eas build --platform ios", three dots) above an "agent" strip of tool calls, animated
  in a loop of about 14 s, labelled under it in mono "An illustrative session". Steps: (1) call `spawn("eas build --platform ios")`;
  the screen shows "? Select a build profile ›" and the rows "development", "preview", "production" with the first highlighted;
  (2) `get_screen()`; (3) `send_keys(["down", "down", "enter"])`: the highlight moves twice, then "✔ Selected profile: production";
  (4) "? Do you want to log in to your Apple account? › (Y/n)", `send_input("y")`, "✔ Logged in"; (5) "Building… " with a bar that
  fills, `wait_for("Build complete|error", 600000)`; (6) "✔ Build complete", `close()` → "exit 0". Under reduced motion: the final
  state, no animation. The terminal text is real text (selectable), aria-hidden with a visually hidden one-line summary.
- Section "The problem" (no nav link): heading "Agents run commands. Then a command asks something." Text: "A shell tool sends a
  command and waits for it to finish. An interactive command never finishes: it waits for a person. The agent hangs, times out
  or kills it, and you end up typing the answer yourself." Next to it a small terminal: "$ npm init" / "package name: (my-app)" with
  a blinking cursor and the mono note "waiting for input…".
- Section "How it works" (#how): heading "Four calls, the way you would do it"; four steps, each the tool name in mono, a title and
  one line: `spawn` "Start it" "The command runs in a real pseudo-terminal, so it behaves exactly as it does in your terminal.";
  `get_screen` "Read it" "xterm headless renders the output into the clean text a person sees: menus, prompts, progress bars. No
  ANSI escape soup."; `send_input` / `send_keys` "Answer it" "Type a reply, or press keys: arrows, Enter, Tab, Ctrl+C, F1 to F12.";
  `wait_for` "Wait for it" "Block until a pattern shows up, such as a prompt or "Build complete", so long jobs need no polling."
- Section "Tools" (#tools): heading "Nine tools"; one card per tool with its signature in mono (defaults as in Facts) and one line;
  a "read-only" chip on get_screen and list_sessions. Under the cards: "Resources: interactive-cli://sessions and
  interactive-cli://sessions/{id}/screen. Prompts: eas_build, ssh_session, repl_session, docker_interactive (slash commands in
  Claude Code)."
- Section "Install" (#install): heading "One line to install"; tabs "Claude Code", "Codex", "Cursor", "Any MCP client" with the
  commands and snippets from Facts, each with a copy button; then "Requires Node 18 or later, on macOS or Linux."
- Section "Good for" (no nav link): heading "Good for"; chips: "eas build", "gcloud auth login", "npm init", "ssh", "docker login",
  "python, node and psql REPLs", "interactive installers", "TUI menus".
- Section "FAQ" (#faq), details/summary, four: "Does it work on Windows?" "Not yet. Commands run through your shell ($SHELL -c, zsh
  by default), so it needs macOS or Linux." / "Is it safe?" "It runs the commands your agent asks for, in your shell, with your
  permissions. spawn, send_input, send_keys and close are marked destructive, so clients such as Claude Code ask before using
  them; get_screen and list_sessions only read." / "What about very long output?" "Each result is capped at 80,000 characters
  (Claude Code's limit is 100,000), cut in the middle so the start and the end survive. get_screen with a search returns the
  matching lines with context." / "Can it type passwords?" "send_input with pressEnter set to false types without submitting.
  The agent sees what the terminal shows, and terminals usually hide what you type at a password prompt."
- Footer: "MIT licensed. Made by Omar Hernández Bastos" (link https://hernandezbastos.es), links "npm"
  (https://www.npmjs.com/package/interactive-cli-mcp) and "GitHub".
- Head: canonical https://ohernandezdev.github.io/interactive-cli/, og/twitter with assets/og.png, JSON-LD SoftwareApplication
  (name, description, version 1.1.0, license MIT URL, free offer, url, codeRepository via sameAs), favicon assets/icon.svg.
- Motion: sections fade up on entering the viewport (IntersectionObserver, 520 ms, 12 px), hover lifts on cards (2 px), all off
  under reduced motion. No framework, no build step; total weight under 60 KB besides fonts and og.png.
- Layout: hero two columns at >= 960 px (copy 1fr, terminal 1.05fr), one column below; tool cards 3 / 2 / 1 columns
  (>= 960 / >= 640 / below); no horizontal scroll at 320 px.

## README (exact structure, same facts)

Title + the hero sentence; badges (npm version, license MIT, "MCP server"); a link to the site; "Why" (the npm init example);
"Install" (Claude Code, Codex, Cursor, any client, from source); "What a session looks like" (the eas build flow as a short
transcript of calls and screens); "Tools" (table with parameters and defaults, read-only column; get_screen's waitMs documented);
"Keys"; "Resources"; "Prompts" (with their arguments); "How it works" (the existing Mermaid diagram, kept); "Limits" (macOS and
Linux only, 80,000-character cap, scrollback 1,000 lines, the agent runs commands with your permissions); "Development" (npm
install, npm run build, run from dist); "License".

## Acceptance

- docs/index.html renders with no console error in Chromium and WebKit, light and dark, at 1440 x 900, 393 x 852 and 320 x 640, no
  horizontal scroll; every frame looked at one by one; the copy buttons copy the exact command; all links resolve (200).
- Every number and name on the site and in the README matches Facts.
- GitHub Pages enabled from main /docs (legacy build, like flint) only after Omar's go; then the live URL answers 200.

## Tasks

- [x] T1 docs/ site + README (delegated writer: two non-trivial files).
- [x] T2 QA frames (coordinator), fixes.
- [ ] T3 Omar's go: merge to main, enable Pages, check live.

## Evidence

- Writer: docs/index.html 31 KB, docs/.nojekyll, docs/assets/icon.svg, scripts/og.html, README.md. The source filled the one gap:
  docker_interactive(image, shellCmd = /bin/sh); eas_build appends --auto-submit; the screen resource is text/plain (all checked
  in src/index.ts).
- QA (Chromium 1440 x 900 dark and light, 393 x 852 dark and light, 320 x 640, WebKit iPhone 15 Pro): 0 console errors, no
  horizontal scroll anywhere. Frames looked at. Found and fixed: the fade-up hid every section until the observer saw it (.fx at
  opacity 0 with no condition), so a capture without scrolling, or a failed script, showed empty sections; now hidden only under
  html.js, set in <head> and dropped after 3 s if the script never started. The version line left "· MIT" alone on a phone; the
  separators are now non-breaking before the dot.
- docs/assets/og.png rendered from scripts/og.html (1200 x 630), looked at.
- Links: GitHub, shields badges, opensource.org, Google Fonts css, hernandezbastos.es answer 200; npmjs.com answers 403 to curl
  (bot wall) while the registry has interactive-cli-mcp 1.1.0.
