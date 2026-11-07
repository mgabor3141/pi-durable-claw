# pi-durable-claw

An always-on personal agent on [pi-durable](https://github.com/earendil-works/pi): coding, research, calendar,
watching for things, running on your server 24/7 and reachable from T3 Code on desktop, web and phone.

Unofficial; not affiliated with Earendil or T3. Working title. Experimental: what runs today is the codemode
assistant (a harness plus a workspace container, with optional HTTP MCP servers and tool search) served to T3 Code;
the rest of the design is not built yet.

## The idea in one rule

**Agent-written code never runs where the keys are.**

- The **harness container** runs the agent loop, holds your keys, and connects to your HTTP MCP servers. The agent
  reaches them only through codemode (or a tool it has loaded with `tool_search`), never their keys.
- **Execution containers** are where the agent runs bash, Python and its own scripts. They hold no keys, so they need
  no permission system.

That is why there are no approval prompts: a full-autonomy agent can use what you gave it, but cannot steal it.

## Install

Requirements: a Linux server with Docker (Compose v2) and git, and a model provider you can reach from it.

1. **Clone** this repo on the server and `cp .env.example .env`. Compose reads `.env` for every command, so settings
   such as `CLAW_PORT` stay put.
2. **Credentials.** Put pi's credentials file at `data/harness/pi/auth.json`, with an API key per provider, for
   example `{"anthropic":{"type":"api_key","key":"sk-..."}}`. If you use pi, you can copy yours from `~/.pi/agent/`,
   but prefer API keys: an OAuth login shared with another machine may be signed out on one of them when its token
   is refreshed. A `models.json` next to it adds custom providers.
3. **Start:** `docker compose up -d` (the first build takes a few minutes). The app listens on `127.0.0.1:3775`. If it
   is not up, `docker compose logs harness` says why; with no usable credentials the harness restarts in a loop.
4. **Pair:** `docker compose exec harness claw pair` prints a link. Open it in a browser, or paste the
   code into T3's desktop app (Add computer). If you reach the server by another address, set `CLAW_PUBLIC_URL` so
   the link matches. Set `CLAW_LABEL` to name the T3 environment (default `claw`). T3 then shows a first-run wizard;
   skip the project import.
5. **Set the default model:** T3 → Settings → General → New threads → Model. T3 defaults new threads to the first
   model in the catalog, which may not be one you can use.

Everything worth keeping lives in `./data`, next to `compose.yaml`: `harness/` (your credentials, conversations,
pairings, settings, the harness's SSH key), `workspace/` (the agent's files, at `/home/agent` in its container)
and `workspace-ssh/` (the workspace's host key). The containers own them as uid 1000. The workspace's sshd is not published, and the Docker
socket is never mounted. There is no hako sshd image yet, so the workspace is a plain Debian image (python3, git, curl).

### Tailscale (optional)

On the host (nothing here runs it for you): `tailscale serve --bg --https=443 http://127.0.0.1:3775`, and set
`CLAW_PUBLIC_URL` to the URL it serves.

### Update

`git pull && docker compose up -d --build`. Your data is in `./data` and survives.

### Backup

Stop the stack (`docker compose down`) and archive `./data`, keeping ownership (e.g. `sudo tar -cpzf claw.tgz data`).
Restore all of it together: the conversations (`harness/durable.db`) and the bridge's state (`harness/t3/`) are a pair,
and the workspace's host key is the one the harness trusts. The archive holds the harness's SSH key and your
`auth.json`, so treat it like your credentials.

## Workspace tools

The `read`, `write`, `edit` and `bash` tools run in the workspace over SSH and start in the conversation's own
working directory: a project's root, a Scratch thread's folder, or `/home/agent`. The prompt carries the global
`AGENTS.md` and global skills from `~/.agents/skills`, then the working directory, the project's `AGENTS.md` and
its `.agents/skills`, and the local time when the conversation started. The agent owns its tools under
`/home/agent`; the workspace image reads `PATH` from `~/.ssh/environment` and includes `jq`. The model tool list is
`codemode` and `restart_harness`, plus `tool_search` when MCP servers with deferred tools are configured.

## Compaction

When a conversation reaches the model window, compaction keeps the recent tail and replaces the older prefix with a
structured summary. This harness uses pi's coding-agent summary prompt: a previous summary is updated through
`<previous-summary>`, a cut inside a user turn gets a separate turn-prefix summary, and Critical Context asks for the
relevant files. Automatic thresholds and `/compact` come from pi-durable; the summary is stored
as the durable `pi.compaction` entry and shown as a completed item in T3.

## Prompt text

All model-facing prompts and tool copy this harness authors — system prompts, user-prompt templates, XML wrappers,
tool descriptions and short tool output notes — lives in `src/prompts.ts`. Tool descriptions inherited from pi-durable's coding and
codemode tools are not duplicated there. MCP tool descriptions come from the server and are shown only when
`tool_search` loads them (or in a script's on-demand `describeTool()`).

## Attachments

T3 image attachments reach the model inline when the selected model accepts images. File attachments are uploaded
through the bridge, copied to `/home/agent/attachments/` in the workspace, and named by path in the prompt, so the
agent can read them with its normal workspace tools. The T3 thread shows the file chip, not the injected path line.
Uploads are capped at 50 MiB.

## Web tools

The harness offers `web_search`, `web_fetch`, `summarize` and the `browser_*` tools to codemode scripts. They are local
services, not cloud APIs:

- `web_search` calls a SearXNG JSON endpoint (`SEARXNG_URL`, default `http://searxng:8080`).
- `web_fetch` calls a page-reader service (`READER_URL`, default `http://reader:8000`) and returns the complete page as main-content Markdown. There is no tool-level character limit; the codemode output limit decides what reaches the model.
- `summarize` makes one model call over supplied text or a workspace file; it is not a subagent and cannot run tools.
- `browser_open`, `browser_act`, `browser_snapshot`, `browser_screenshot` and `browser_close` drive T3's preview
  browser, a Browserless Chromium the harness reaches over CDP (`BROWSERLESS_URL`, for example
  `ws://browserless:3000/chromium`; `BROWSERLESS_TOKEN` is optional). Without `BROWSERLESS_URL` there is no browser:
  the tools are not offered, and the harness logs that at start. `BROWSER_LOCAL_HOSTS` is an optional comma-separated
  allowlist for the browser only; a deployment can set `workspace` so the agent can open its own local dev server.
  `web_fetch` never uses that allowlist.

Point them at services the harness can reach; this repo does not run them. The
reader accepts `POST /read` with `{"url":"..."}` and returns `markdown` and the final `url`.
`web_fetch` accepts only `http` and `https`, refuses embedded credentials and private/internal addresses, and marks
the result as untrusted data. The browser tools apply the same URL check to `browser_open` and `browser_act`'s
`goto`, and wrap page text as untrusted data too. Backend calls are bounded in size and time. If a service is absent or
the request fails, the tool returns the backend error instead of inventing a result.

The browser is for interaction, not reading. `web_fetch` is the cheap, stateless path and should be the default;
use the browser when a page needs clicks, typing, JavaScript, a screenshot, or a short interactive test. A
screenshot result is an image block; call `image(shot)` in the same codemode script to attach it. One page
is kept per conversation, a T3 preview tab that stays while viewed. The bridge sweeps tabs with no viewer after thirty minutes when an agent opened them, or twenty-four hours when the user did; a viewed tab is kept. Browserless's session timer is effectively off, and the shared preview browser closes after three days with no tabs. Local HTML is served from the workspace (for example `python3 -m http.server`) and opened by URL like any other page.

When `BROWSERLESS_URL` is set, the bridge also offers T3's in-app Browser panel: it advertises
`serverBrowser`, implements `preview.*` and `subscribePreviewEvents`, and serves `/api/preview-stream/ws`
from the same Browserless Chromium. T3's panel opens a tab, receives JPEG frames and forwards pointer and
keyboard input, so the same browser is visible and controllable from the web or mobile client. A URL passed to
`browser_open` is opened in that same T3 preview tab; the tab is visible in the Browser panel. The agent and the user operate one page. If the preview browser does not answer, `browser_open` fails with its
error; there is no other browser to fall back to. This is a live view, not a page reader. Preview tabs share a durable storageState profile (cookies and origins' localStorage, kept at the bridge's stateDir/browser-profile.json). A preview tab has no
upload/download or file chooser; closing the panel closes its tab. The URL is reached from Browserless, not from
the device, so no host forwarder or proxy is needed.

## MCP servers

The agent owns its MCP configuration: `/home/agent/.mcp.json` in the workspace, in Claude Code's `.mcp.json`
format, so a snippet from a server's documentation works as is. The agent adds, edits and removes servers itself. The
harness checks the file before each model request and after each round of tools, and applies the change: a new server
connects, a changed one reconnects, a removed one is closed. A broken file or entry is shown to the agent in
`mcp_servers` and leaves the running servers alone. Project `.mcp.json` files are not read.

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "timeout": 60000,
      "description": "Search and read the product documentation",
      "exposure": "deferred"
    }
  }
}
```

`type` is required: `"http"` (or its alias `"streamable-http"`). `timeout` is per request, in milliseconds.
`alwaysLoad: true` means `exposure: "direct"`. stdio, `sse` and `ws` entries are refused with a message saying so.
`${NAME}` (or `${NAME:-default}`) in `url` or `headers` names one of the harness's [secrets](#secrets), never an
environment variable. A server that names a missing secret is reported as needing it, and connects once the secret is
saved. Changing a secret reconnects the servers that use it.

Exposure, per server or per tool with `toolExposure`:

- `deferred` (default): the tool is not in the first model request. `tool_search` loads it, and
  the model can then call it directly; codemode scripts can call it at any time.
- `codemode`: script-only. It is not offered to the model and `tool_search` cannot load it.
- `direct`: offered to the model immediately, and callable from scripts.
- `hidden`: not reachable.

`mcp_servers` lists the configured indirect servers and how to reach them. `describeNamespace()`
and `searchTools()` see the `mcp__<server>` namespaces. A successful connect installs the
server's tools. A server that fails to connect, or drops later, is logged and reconnected in the
background (after 5 s, 15 s, 1 min, then every 5 min); its tools appear once it is back. `tool_search` is offered while
some server's tools are reached through it.

### OAuth

A server with no `Authorization` header signs in by OAuth when it answers 401, as in Claude Code. It shows in
`mcp_servers` as needing a sign-in. The agent calls `mcp_auth({ action: "login", server })` and gives the user the link.
After the user approves, the browser returns to `<CLAW_PUBLIC_URL>/host/oauth/callback` and the server connects. If the
user's browser cannot reach that URL, the page fails to load, but the address bar still holds the code: pasted back to
the agent, `mcp_auth({ action: "complete", redirectUrl })` finishes the sign-in the same way. A callback works once.

Discovery follows the MCP authorization spec (RFC 9728, then RFC 8414). The client registers dynamically, unless the
server takes a Client ID Metadata Document or you configure a client. Tokens refresh on their own, including a
step-up on `insufficient_scope`. They are kept with the secrets in `secrets.json` and appear in tool output only as
`[<server> OAuth credential]`. `mcp_auth({ action: "logout", server })` forgets a sign-in.

Claude Code's `oauth` block is read:

```json
"linear": {
  "type": "http",
  "url": "https://mcp.linear.app/mcp",
  "oauth": { "clientId": "…", "clientSecret": "${LINEAR_CLIENT_SECRET}", "scopes": "read", "authServerMetadataUrl": "https://…" }
}
```

`clientSecret` is our addition (Claude Code prompts for it); write it as a secret. `callbackPort` is accepted and not
used: the redirect URI is always the host's. Register `<CLAW_PUBLIC_URL>/host/oauth/callback` with a server that needs
a pre-registered client. Many authorization servers accept plain `http` only on loopback, so with a non-loopback
`CLAW_PUBLIC_URL`, use `https` (Tailscale Serve) or the paste fallback.

## Secrets

The harness keeps named secrets in `data/harness/secrets.json` (owner-only, outside `durable.db`). The agent asks for
one with `request_secret`: T3 shows a private card in the thread, the value you enter is saved under the name the agent
chose (`GITHUB_TOKEN`), and it never enters the chat. Scripts can also `list`, `set` (a value the agent already has) and
`delete` secrets with the `secrets` tool.

The agent uses a secret by writing `${NAME}` (or `${NAME:-default}`) where the value goes: tool arguments, MCP config,
browser form fields. A shell command uses `$NAME`: the secrets it names are exported to it. The value is substituted only
inside the running tool, so the recorded call keeps the placeholder, and any value that appears in a tool's output comes
back as `${NAME}`. This keeps secrets out of the model's context and the transcript; it is not a wall between the agent
and its secrets (a transformed value is not recognised, and the agent may read a secret on purpose). Each use is logged
by name.

## Threads that drive each other

Every agent works in a thread, and scripts drive other threads with six tools. A call acts as the thread the
conversation belongs to, so a message it sends shows in the other thread as coming from it.

- `thread_prompt` starts a child thread (`new`, optionally `fork` to give it the caller's history) or follows up on any
  thread (`mode`: auto, followUp, steer, or notify to add to its context without starting work). By default it waits
  and returns the activity's report: every message that entered the work, its tool-call count and the final answer,
  with a verdict (completed, interrupted, failed, or active when the wait ran out). With `wait: false` it returns at
  once, and the report is posted into the caller's thread when the work settles, starting its next turn if it is
  idle. A wait that runs out, or a restart, turns into the same delivery.
- `thread_wait` waits for several threads and returns their reports with the worst verdict.
- `thread_read` reads a thread's exchanges, the caller's own included, back past any compaction.
- `thread_search` searches every thread's messages; `thread_list` lists threads (`parent: "self"` for children).
- `thread_cancel` stops a thread and, by default, its children; nobody gets reports of the stopped work.

A child nests under its parent in T3: the parent's run shows it as a subagent card, and the child is a full thread
you can open and write to. Children nest at most 3 deep, and at most 10 children of one thread work at once.

T3's own thread tools are served to outside MCP clients at `<CLAW_PUBLIC_URL>/mcp`. A client signs in over OAuth as it would to T3:
it opens T3's approval page, where you choose its access and approve with a pairing code (`claw pair`) or in one click
from a signed-in browser. It then appears under Settings → Sharing & access, where it can be revoked. Every thread
here runs at full access, so a client approved below that can only read.

## Codemode limits

Each codemode script runs in its own QuickJS VM, in a worker thread of the harness process. A script may allocate at
most 256 MiB (`CLAW_CODEMODE_MEMORY_MB`); past that it fails with `out of memory` and the turn goes on, instead of
taking the harness down. A script also ends after 5 minutes, tool calls included.

## Restart

`restart_harness` is the one standalone model-facing tool. It writes `data/harness/restart.json`, waits until every
other live agent is paused after its tool results are stored, closes the harness and exits 0; the compose restart
policy starts the next process, which consumes the marker and resumes. The tool always answers `Restarted`; a
second request during a drain is accepted and pauses at its own tool boundary, so two requests cannot deadlock. A
thread tool waiting on another thread returns when the drain starts, so its turn pauses; the report of the work it
waited on reaches its thread when that work settles.
`CLAW_RESTART_DRAIN_MS` (default 1800000, 30 minutes) caps the wait and a timeout still restarts; `CLAW_RESTART_CLOSE_GRACE_MS`
(default 5000) caps close. It applies startup-only configuration such as MCP servers; it does not rebuild the image,
so a code release still needs the operator.

### Known limitations

- No account integrations are configured by default. HTTP MCP servers can be added as above; OAuth, stdio and MCP
  resources are not implemented. Web search, page view and the browser are the built-in connectors.
- Scheduled tasks run on intervals or fixed times; there are no webhook triggers.
- T3 projects do not map to containers: use "No project" threads. The project picker, file panel and search go
  through the workspace execution environment, so a project must live under the workspace's `/home/agent` (the
  harness's data directory is not visible there).
- Nested calls inside a codemode script are invisible in T3: you see the script and its result.
- The workspace can reach the app. Everything there needs a pairing credential except the web app's static files,
  the environment descriptor and pairing itself.
- A harness restart resumes a turn, but a command that was running in the workspace is cut off, not rerun; the
  agent sees it as interrupted.
- Experimental: pi-durable and the T3 bridge are pre-release and pinned to specific commits.
- `web_fetch` uses a local reader that extracts main content; JavaScript-heavy and anti-bot pages may still fail or return partial text. It returns the complete page; the codemode output limit decides how much the model sees.
- The browser keeps no login profile. Live view and human takeover are available through T3's Browser panel
  when `BROWSERLESS_URL` is set; a CAPTCHA, 2FA prompt or payment step that needs you stays blocked.
- The preview panel serves one page per tab and has no profile store, upload/download or file chooser.

## Shape

```
T3 Code (desktop · web · mobile) ── harness container ── execution containers (hako, devcontainers)
                                    pi-durable, bridge,      bash, files, scripts; no keys
                                    keys, MCP servers,
                                    codemode, restart_harness, schedules
```

See [docs/design.md](docs/design.md) for the decisions and why.

## Development

`pnpm install`, `pnpm typecheck`, `pnpm test` (needs Docker; `CLAW_TEST_MODEL=provider/modelId` adds a real-model
test). The T3 bridge, [pi-durable-t3](https://github.com/mgabor3141/pi-durable-t3), is not on npm yet: it installs
from git at a pinned commit and builds on install (it fetches T3's contracts and web app), which `package.json`
allowlists. Its pi packages are peers, so the pi versions are ours: keep every `@earendil-works` package on one
version (`test/one-copy.test.ts` checks it). To try a bridge change, point the dependency at a local checkout
(`link:../pi-durable-t3`, built with `pnpm build` there).

## License

MIT
