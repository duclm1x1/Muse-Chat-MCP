# Muse-Chat-MCP

**Use Meta Muse — the [muse.ai](https://muse.ai) "Hatch" agent — from any MCP client or any OpenAI-compatible client, with your own account and quota.**

Muse has no public API: its chat is an **encrypted WebSocket** (`wss://hatch.metaaivm.com/v1/noise`, an X25519 + HKDF + AES‑GCM + Ed25519 *Noise* transport). So instead of re‑implementing the protocol, this project **drives your real, logged‑in Chrome** with Playwright: the app performs all the crypto itself, and we type into the composer and read the rendered reply.

That gives you two front doors:

| Front door | What it is | Use it from |
| --- | --- | --- |
| **MCP server** (stdio) | 7 tools: `muse_status`, `muse_login`, `muse_new_chat`, `muse_chat`, `muse_read_last`, `muse_dump_dom`, `muse_close` | Claude Desktop, opencode, Cursor, any MCP host |
| **OpenAI-compatible shim** (HTTP) | `GET /v1/models`, `POST /v1/chat/completions` (stream + non-stream, tool calling) | any OpenAI SDK / `@ai-sdk/openai-compatible` provider |

Plus a tiny **CLI** (`muse-cli.mjs`) for one-shot generation from scripts.

> [!IMPORTANT]
> This drives **your** browser and **your** Muse account. It ships with **no** credentials, no Chrome profile, and no captured traffic — you sign in to your own Meta account on first run. See [Disclaimer](#disclaimer).

---

## Features

- **MCP tools** over stdio — drop-in for Claude Desktop / opencode / any MCP host.
- **OpenAI-compatible HTTP shim** with **real streaming** (SSE), correct `finish_reason`, and `/v1` error objects.
- **Prompt-injected tool calling** — expose OpenAI `tools` to Muse and get `tool_calls` back.
- **Attachments** — send images/video with a prompt (MCP `files`, OpenAI `image_url` parts, CLI `-f`).
- **Sessions & media** — list/open/read/send in any Muse chat, and pull out the images/videos Muse generates (links + download).
- **Muse Manual** — a living guide to Muse's video/image/content capabilities at [`manual/MUSE_MANUAL.md`](manual/MUSE_MANUAL.md), regenerated with `node manual/interview.mjs`.
- **Reuses your existing login** via a dedicated Chrome profile, or attaches to a Chrome you already run with `--remote-debugging-port=9222`.
- **Never kills your browser**: when attached over CDP it only *disconnects* on close.
- **Resilient**: if the profile is locked by a running Chrome, it auto-attaches over CDP instead of failing.
- **Correct streaming**: only stable, monotonic text is emitted, so a rewrite mid-answer never duplicates.
- No browser download — it uses your **installed** Chrome via [`playwright-core`](https://www.npmjs.com/package/playwright-core).

---

## Requirements

- **Node.js ≥ 18** (tested on v24).
- **Google Chrome** (or Edge) installed.
- A **Meta account** with access to Muse.
- Windows / macOS / Linux (paths in the examples are Windows; adjust for your OS).

---

## Install

```bash
git clone https://github.com/duclm1x1/Muse-Chat-MCP.git
cd Muse-Chat-MCP
npm install
```

`npm install` only pulls `playwright-core` (a library) — it does **not** download a browser.

## First run (log in once)

```bash
npm run login             # opens Chrome to muse.ai and waits for you to sign in (5 min)
# or:
npm run selftest          # checks status; if not logged in, waits for you to complete sign-in
```

A Chrome window opens to `https://muse.ai`. Sign in with your Meta account. The session is stored in a dedicated profile (`.muse-profile/`, git-ignored) and reused afterwards. When `muse_status` reports `"loggedIn": true`, you're ready.

---

## Use it as an MCP server

### opencode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "muse": {
      "type": "local",
      "command": ["node", "/absolute/path/to/Muse-Chat-MCP/muse-server.mjs"],
      "enabled": true,
      "timeout": 300000
    }
  }
}
```

> The `timeout` is the **tool-listing** timeout at startup, not per-call — long `muse_chat` calls are fine.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "muse": {
      "command": "node",
      "args": ["/absolute/path/to/Muse-Chat-MCP/muse-server.mjs"],
      "env": { "MUSE_PROFILE_DIR": "/absolute/path/to/Muse-Chat-MCP/.muse-profile" }
    }
  }
}
```

### MCP tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `muse_status` | – | browser / login / composer state |
| `muse_login` | `timeout_sec?` | waits for Meta sign-in to complete |
| `muse_new_chat` | – | navigates to the home composer |
| `muse_chat` | `prompt`, `timeout_sec?`, `new_thread?`, `files?`, `chat?` | `{ reply, messages, threadUrl, elapsedMs, … }` |
| `muse_read_last` | – | latest assistant message (no send) |
| `muse_chats` | `query?` | list chats (Main chat / Channels / Side chats), optional title filter |
| `muse_open_chat` | `target` | open a chat (title, index, URL, or id) |
| `muse_read_chat` | `chat?`, `max?` | messages of a chat (all roles, with media links) |
| `muse_media` | `chat?`, `download?`, `dir?` | image/video/attachment links from a chat (optionally downloaded) |
| `muse_dump_dom` | `max_chars?` | element counts + transcript HTML (selector debugging) |
| `muse_close` | – | closes the browser (disconnect-only if CDP-attached) |

Typical flow: `muse_status` → (if needed `muse_login`) → `muse_chat { prompt }`.

### Attachments (images & video)

`muse_chat` accepts a `files` array — absolute paths or URLs — and attaches them to the
message before sending:

```jsonc
{ "name": "muse_chat", "arguments": { "prompt": "What is in this image?", "files": ["C:\\path\\frame.jpg", "https://host/clip.mp4"] } }
```

Muse accepts images, video and documents (the composer's file input has **no** `accept`
filter). Files are set directly on the hidden composer input — no OS file dialog.

### Sessions (multiple chats)

Muse has a **Main chat** plus **Channels** and **Side chats** (each a `muse.ai/thread/<id>`).
List them, then target any one for reading or sending:

- **MCP** — `muse_chats`, `muse_open_chat { target }`, `muse_read_chat { chat?, max? }`, and `muse_chat { …, chat }` where the target is a title, index, thread URL, or thread id.
- **HTTP** — `GET /v1/muse/chats` (list) and `GET /v1/muse/chat?target=<name|index|url>&max=100` (read); send with header `x-muse-chat: <name|index|url>` (or body `chat`).
- **CLI** — `--list-chats`, `--read [<chat>]`, `--chat <chat>`.

> Muse can generate images/video **inside a chat** (it replies with share links) — use a
> session read or the media tools to retrieve them.

### Media (generated images & video)

When asked, Muse makes media and replies with a share link (`https://muse.ai/files/<…>/….mp4|.png`).
Extract and download them:

- **MCP** — `muse_media { chat?, download?, dir? }`.
- **HTTP** — `GET /v1/muse/media?target=<chat>&download=1&dir=<dir>`.
- **CLI** — `--media [<chat>] [--download] [--dir <dir>]`.

Links are public (anyone with the link can view) but expire (~2 days) — download to keep them.

---

## Use the OpenAI-compatible shim

`muse-server.mjs` starts the shim automatically on **port 8787** (disable with `MUSE_SHIM_PORT=0`). Run it stand-alone (HTTP only, no MCP) with `node muse-server.mjs --serve-only`.

| Route | Purpose |
| --- | --- |
| `GET /v1/models` | model list |
| `POST /v1/chat/completions` | chat completions (stream + non-stream, tools) |
| `GET /health` | browser / login state |
| `GET /v1/muse/chats` | list Muse chats |
| `GET /v1/muse/chat?target=…` | read a chat (optionally opening it first) |
| `GET /v1/muse/media?target=…` | media links in a chat (add `download=1` to save) |

```bash
curl http://127.0.0.1:8787/v1/models

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"muse-spark-1.3","messages":[{"role":"user","content":"Summarize what Muse is in 2 sentences."}]}'
```

### Any OpenAI client

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="muse-local")
r = client.chat.completions.create(
    model="muse-spark-1.3",
    messages=[{"role": "user", "content": "Write a haiku about browsers."}],
    stream=True,
)
for chunk in r:
    print(chunk.choices[0].delta.content or "", end="")
```

### opencode provider

```jsonc
"provider": {
  "muse-local": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Muse (local shim)",
    "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "muse-local" },
    "models": {
      "muse-spark-1.3": { "name": "Muse Spark 1.3" },
      "muse": { "name": "Muse" }
    }
  }
}
```

### Shim behavior

- **Real streaming** — DOM text is re-emitted as OpenAI deltas. Only text that is a *monotonic extension* and has been stable for `MUSE_STREAM_QUIET_MS` (default 600 ms) is emitted; the remainder is flushed at the end. Each stream ends with exactly one `finish_reason`, then `[DONE]`.
- **Tools** — prompt-injected. Tool schemas are embedded with a *decision-only* rule ("do not execute"), so Muse returns `{"tool_calls":[{"name","arguments"}]}` instead of trying to actually run the action. Parsed into OpenAI `tool_calls` (`finish_reason: "tool_calls"`). Best-effort, not a native function-calling API.
- **Attachments** — send images/video via OpenAI multimodal content (`{"type":"image_url","image_url":{"url":…}}`) or a top-level `files` array (local paths / URLs / data-URIs). Muse sees them like a normal chat attachment.
- **Plain message** — the shim sends the latest user message **verbatim**: no `### USER/### ASSISTANT` role markers and no "continue the conversation" wrapper. Muse flags roleplay-style wrappers as prompt-injection and refuses them, so the bridge never adds any. Prior context comes from Muse's own thread.
- **Sessions** — target a chat with header `x-muse-chat: <title|index|url>` (or body `chat`); read chats via `GET /v1/muse/chats` and `GET /v1/muse/chat`.
- **Headers** — `x-muse-thread: new` (navigate to `/` first), `x-muse-timeout-ms`.

---

## Use the CLI

`muse-cli.mjs` talks to the shim (reusing a running one, or auto-starting `--serve-only` and shutting it down after).

```bash
node muse-cli.mjs "Explain what a B-tree is in 2 sentences."          # streams to stdout
node muse-cli.mjs --no-stream -s "Output ONLY raw code." "Write ..."   # exact final code
node muse-cli.mjs -f ./frame.jpg "Write a Facebook caption for this image."  # attach image/video
node muse-cli.mjs --list-chats                                        # list Muse chats
node muse-cli.mjs --read "Video creation capability"                  # read a chat
node muse-cli.mjs --chat "Reply with pong" "hi"                       # send into a chat
echo "<file>" | node muse-cli.mjs -s "Review this file"                # stdin prompt
npm run muse -- "hello"                                                # via package.json
```

Options: `-s/--system`, `-m/--model`, `-t/--timeout`, `-f/--file <path|url>` (repeatable), `--chat <name|index|url>`, `--list-chats`, `--query <text>`, `--read [<chat>]`, `--media [<chat>]`, `--download`, `--dir <dir>`, `--new-thread`, `--no-stream`, `--json`, `--base` (or env `MUSE_SHIM_URL`).

---

## Architecture

```
MCP client (Claude Desktop / opencode / …)      OpenAI client (SDK / opencode provider)
        │ stdio (JSON-RPC)                                │ HTTP  /v1/*
        ▼                                                  ▼
   muse-server.mjs  ───────────►  muse-openai-shim.mjs  ────┘
        │  (MCP tools)                   (SSE + JSON)
        └──────────────┬──────────────────────────┘
                       ▼
                 muse-driver.mjs        playwright-core
                       ▼
        Chrome (dedicated profile ./.muse-profile)  ──►  https://muse.ai
```

### Why a browser driver?

Captured from a real session (endpoints + WS frames), Muse chat is **not** REST/SSE:

| Signal | Value |
| --- | --- |
| App | Next.js on Vercel, fronted by Meta `fwdproxy` |
| Auth | cookie-based: `POST /api/auth/check` → `{ ok, access_token, viewer_id }` |
| Session | `GET /api/session` → assigned VM `wss://<vm_id>.metaaivm.com/` |
| Wake | `POST /api/hatch/vm/wake` |
| Chat transport | WebSocket `wss://hatch.metaaivm.com/v1/noise` — RPC methods `chat.stream`, `chat.history`, `chat.mark_seen` |
| Frames | **encrypted binary** (Noise handshake), signed `auth_token`/`notary_token` in the WS URL |
| `/api/falco` | telemetry only — **not** chat |

So the only robust options are (1) drive the real browser (this project) or (2) re-implement the encrypted Noise client ([roadmap](#roadmap)).

### Selectors

| Purpose | Selector |
| --- | --- |
| Composer root | `[data-hatch-composer-root]` |
| Editor | `[data-hatch-composer-root] textarea` (fallback `[data-lexical-editor="true"]`) |
| Send | `Enter` key |
| Attach | `[data-hatch-composer-root] input[type="file"]` (hidden; `setInputFiles`) |
| Chat list | `[data-testid="hatch-thread-row"]` |
| Streaming | `[data-testid="hatch-composer-stop-button"]` |
| Messages | `[data-message-item]` with `data-message-role="user" \| "assistant"` |
| Error | `[data-testid="assistant-response-error-notice"]` |
| Auth probe | page-origin `fetch('/api/auth/check', { method: 'POST' })` |

---

## Reproduce this yourself (HAR → coding agent)

You don't have to reverse-engineer anything by hand. Capture what the app actually does,
then let a coding agent read it and write the bridge for you.

**Requirements: Google Chrome + some kind of coding agent** — Claude Code, OpenAI Codex,
opencode, Cursor, Cline, Aider, … anything that can read files.

1. **Open the app.** In Chrome, go to `https://muse.ai` and sign in with **your own** account.
2. **Open DevTools.** Press `F12` → **Network** tab → tick **Preserve log**. Leave it open for
   the whole session so the WebSocket frames get recorded.
3. **Filter the traffic.** Click **Fetch/XHR** to see the HTTP calls, and **WS** to see the chat
   WebSocket. Muse's chat is a **WebSocket**, not a REST call, so you want *both*.
4. **Send a few prompts** (e.g. `hi`, `what can you do?`) so real traffic is recorded.
5. **Export a HAR.** Right-click anywhere in the request list → **Save all as HAR with content**.
   Pick the version **"with sensitive data"** — the sanitized export strips cookies and
   WebSocket frames, which makes the capture useless.
6. **Hand it to your coding agent.** Drop the file into your project (e.g. `captures/muse.har`)
   and give the agent a prompt like this:

   ```text
   Analyze captures/muse.har from a web chat app and report:
   1) The chat transport: REST/SSE vs WebSocket. List every relevant endpoint
      (auth, session, wake, chat) and how authentication works (cookies? tokens?).
   2) The WebSocket: URL, subprotocol, and whether frames are encrypted/binary —
      e.g. a Noise handshake (X25519 + HKDF + AES-GCM + Ed25519) — plus the RPC method names.
   3) The most robust way to build a local bridge that exposes this chat as
      (a) an MCP tool and (b) an OpenAI-compatible /v1 endpoint, given there is no official API.
   ```

   The agent will read the HAR and tell you exactly what to build. In our capture it surfaced
   `POST /api/auth/check`, `GET /api/session`, `POST /api/hatch/vm/wake`, and the **encrypted**
   `wss://hatch.metaaivm.com/v1/noise` WebSocket with a `chat.stream` method — which is precisely
   why this project **drives the real browser** instead of calling a REST API. If your agent
   reaches the same conclusion, you're spot on.

> [!WARNING]
> A HAR "with sensitive data" contains your **session cookies and access tokens**. Never commit
> it, never paste it into a chat, never share it. This repo's `.gitignore` already blocks `*.har`.

---

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `MUSE_PROFILE_DIR` | `./.muse-profile` | dedicated Chrome profile (holds your login) |
| `MUSE_URL` | `https://muse.ai/` | app URL |
| `MUSE_CHANNEL` | `chrome` | `chrome` or `msedge` |
| `MUSE_HEADLESS=1` | off | run headless (log in headed first) |
| `MUSE_CDP` | – | attach to an existing Chrome at this URL (e.g. `http://127.0.0.1:9222`) instead of launching |
| `MUSE_STREAM_QUIET_MS` | `600` | streaming stability window (skip mid-message draft rewrites) |
| `MUSE_LAUNCH_TIMEOUT_MS` | `60000` | launch / navigation timeout |
| `MUSE_SHIM_PORT` | `8787` | shim port (`0` disables the shim) |
| `MUSE_SHIM_HOST` | `127.0.0.1` | shim bind host |
| `MUSE_SHIM_TIMEOUT_MS` | `240000` | default shim request timeout |
| `MUSE_SHIM_MODELS` | `muse-spark-1.3,muse-spark-1.3-contributor,muse` | advertised model ids |
| `MUSE_SHIM_URL` | `http://127.0.0.1:8787/v1` | shim base url used by the CLI |
| `MUSE_CLI_AUTOSTART=0` | off | disable the CLI auto-starting a shim |

---

## Troubleshooting

- **`loggedIn: false`** → run `npm run login` (or `npm run selftest`) and complete sign-in in the opened Chrome window.
- **`composerReady: false`** after login → `node muse-server.mjs --dump-dom`; if the DOM changed, re-derive selectors and update `SELECTORS` in `muse-driver.mjs`.
- **Empty reply / `timedOut`** → raise `timeout_sec`; agent tasks (browsing, VM work) can take minutes. `needsApproval: true` means Muse is waiting on an in-app approval you must click.
- **Chrome profile locked** → expected if a Chrome already uses `.muse-profile`. The driver auto-attaches to `http://127.0.0.1:9222` in that case; otherwise close that window, or start Chrome with `--remote-debugging-port=9222` and set `MUSE_CDP`.
- **`npm` blocked in PowerShell** → call `& "C:\Program Files\nodejs\npm.cmd"` instead of `npm`.

## Limitations

- **One conversation.** Muse is a single persistent thread; the in-app "new chat" control is unreliable. The shim sends the full transcript each call; `x-muse-thread: new` navigates to `/` first (best-effort fresh context).
- **Serialized** — one browser, requests run one at a time (auto-queued).
- **Tool calling is prompt-injected** — best-effort, not a native function-calling API.
- **DOM-driven** — a Muse UI change can break selectors; `muse_dump_dom` is the escape hatch.

---

## Roadmap

- [ ] **Phase 2 — headless Noise client.** Talk to Muse directly over `wss://hatch.metaaivm.com/v1/noise` (X25519 + HKDF + AES‑GCM + Ed25519) with a `MUSE_TRANSPORT=noise|browser` switch, keeping the browser driver as fallback.
- [ ] Native tool-calling passthrough for clients that support it.
- [ ] Multi-thread support when Muse exposes a reliable switch.

## Disclaimer

This is an **unofficial, unaffiliated** tool. It automates *your own* logged-in browser session and does not bundle, proxy, or share anyone's credentials. Use it only with an account you are entitled to use, and respect Muse's / Meta's Terms of Service and your local laws. The maintainers are not responsible for misuse or for any consequences of using this software. There is **no** API key, Chrome profile, or captured traffic in this repository — you bring your own.

## License

[MIT](LICENSE) © 2026 duclm1x1
