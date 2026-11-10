# pi-durable-claw

An always-on personal agent on [pi-durable](https://github.com/earendil-works/pi): coding, research, calendar,
watching for things, running on your server 24/7 and reachable from T3 Code on desktop, web and phone.

Unofficial; not affiliated with Earendil or T3. Working title. Experimental: what runs today is the codemode
assistant (a harness plus a workspace container, with optional HTTP MCP servers and tool search) served to T3 Code;
the rest of the design is not built yet.

## The idea in one rule

**Agent-written code never runs where the keys are.**

- The **harness container** runs the agent loop, holds your keys, and connects to your HTTP MCP servers. The agent
  reaches them only through codemode, never their keys.
- **Execution containers** are where the agent runs bash, Python and its own scripts. They hold no keys, so they need
  no permission system.

That is why there are no approval prompts: a full-autonomy agent can use what you gave it, but cannot steal it.

## Install

Requirements: a Linux server with Docker (Compose v2) and git, and a model provider you can reach from it.

1. **Clone** this repo on the server and `cp .env.example .env`. `.env` is where every setting goes: it lists them
   all, and compose passes it to the harness whole. Change it, then `docker compose up -d` to apply.
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

### Remote access (optional)

Claw can join your [Tailscale](https://tailscale.com) tailnet as its own device, as gmux does: nothing to install on
the server, no ports to open. It serves T3 over HTTPS with a real certificate, and SSH into the workspace, so T3's
"Open in VS Code" (also Cursor, Zed and JetBrains), file links and the file preview open the agent's files on your
computer. SSH needs no key: your tailnet login is the key.

1. Have a tailnet with **MagicDNS** and **HTTPS Certificates** on (https://login.tailscale.com/admin/dns), and
   Tailscale on the devices you connect from.
2. `docker compose exec harness claw remote` turns it on and prints a login link; open it and log the device in.
   (Or set `TS_AUTHKEY` in `.env` to log in without the link.)
3. `claw remote` again checks: it names what the tailnet still needs, or prints the addresses, e.g.
   `https://claw.<tailnet>.ts.net` and `ssh agent@claw.<tailnet>.ts.net`. `claw pair` now prints tailnet links.

Only the account that logged the device in gets through, on both HTTPS and SSH; `CLAW_TAILNET_ALLOW` adds logins or
tags (`partner@example.com,tag:laptops`), and T3's pairing still guards T3 as before. The device is named after
`CLAW_LABEL` (or `CLAW_TAILNET_HOSTNAME`). `claw remote off` turns it off; `claw remote status` reports. The first
SSH connection asks you to trust the device's key, which is kept with its state under `data/harness/tailscale`.

How it works: the harness runs `claw-tailnet` (`tailnet/`, Go with embedded Tailscale) while remote access is on,
restarting it if it exits. It forwards 443 to the harness and relays SSH to the workspace's sshd with the harness's
own key, checking the workspace's host key as the harness does; the agent's workspace gets no route into your tailnet.
Its state, the device's identity, lives in `data/harness/tailscale` and is part of your backup.

Without it, reach the app as before: on the server, an SSH tunnel to `127.0.0.1:3775`, or your own `tailscale serve`
with `CLAW_PUBLIC_URL` set to its URL (then "Open in VS Code" stays greyed out: it needs an SSH route to the
workspace).

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
its `.agents/skills`, and the local time when the conversation started (recorded when it was created, so a prompt
rendered again still names it). The agent owns its tools under
`/home/agent`; the workspace image reads `PATH` from `~/.ssh/environment` and includes `jq`. The model tool list is
`codemode` and the bridge's `request_secret`, and it never changes.

`read` in a script gives a text file's whole text (or the lines `offset` and `limit` select), or an image as
`{ type: "image", data, mimeType }`; show it with `image(result)`. There is no size limit on what a script reads: the
limit is on what reaches the model, codemode's output. (pi-durable's `read` stops at 2,000 lines or 50 KB.) (pi-durable's `read` already returns an image as its content, but a tool without an output schema gives
scripts only its text, so the picture would arrive as `""`; claw gives `read` that schema.) A file that cannot be read
as an image says why, and the call rejects.
An image is prepared for the model by pi-durable's Photon image processor (`src/images.ts`): turned upright by its
EXIF orientation, converted when providers do not take its format (BMP becomes PNG), and shrunk to the model's image
limits (by default 2000x2000 pixels and 4.5 MB of base64), with a note giving the scale for mapping coordinates back
to the original. It runs in a worker thread that exits after 30 s without images. The harness checks it can load
Photon at start, and does not start without it.

The same goes for an image a script shows with `image()` (a full-page `browser_screenshot`, a generated image, an MCP
tool's, a data URL), but only one the model could not take as it is: a type providers do not take inline, more than
4.5 MB of base64, or wider or taller than 2000 pixels by its header. That one is fitted, followed by a note with the
scale, and codemode's saved file stays the original. Every other image reaches the model exactly as the script gave it.

`ssh` runs one command on another machine from the workspace, with the workspace's `~/.ssh` keys and config.
`ssh({ host, command, timeout? })` passes the remote command to the remote shell exactly as written, so a script needs
no second layer of quoting. It is `bash` running `ssh -n -o BatchMode=yes -- <host> <command>`, and it returns what
`bash` returns. It never prompts: a password or an unknown host key fails with exit code 255. A secret goes into the
remote command as `${NAME}`. A bare `$NAME` of a secret is refused, since the remote shell does not have it; any other
`$VAR` or `${VAR}` belongs to the remote shell.

## A fixed system prompt

The system prompt is rendered at a thread's first request and then sent byte for byte the same, so the provider's
prompt cache keeps the whole prefix. Edits to `AGENTS.md` and skills, `~/.mcp.json`, and tools registered while the
harness runs change nothing in a running thread's prompt. New threads, child threads included, get the current prompt
at once.

A running thread renders it afresh after:

- `/reload`, a T3 slash command. The bridge removes every shown section, and the next request renders all of them.
- A compaction. Its first request writes the whole prompt again anyway. The one exception: if a `/reload` happened
  within the history the compaction keeps (its last ~20k tokens), the prompt that reload rendered stays.

The codemode section is a catalog (`src/codemode-catalog.ts`): `read`, `write`, `edit` and `bash` are declared in
full, every other harness tool has one line (its description's first sentence), and a script reads a tool's
declaration with `describeTool(name)` before first using it, as tool search works in Claude Code and Codex. The
whole system prompt is about 2,000 tokens; declaring every tool in full made it about 7,000. MCP tools are left out
of it, since a server can bring dozens; scripts find them with `searchTools()`. A tool registered after the prompt was rendered can
be called at once and is found the same way. `src/fixed-prompt.ts` keeps the prompt, and
`test/fixed-prompt.test.ts` checks both that every section is kept and that a change sends the same bytes.

## Compaction

When a conversation reaches the model window, compaction keeps the recent tail and replaces the older prefix with a
structured summary. This harness uses pi's coding-agent summary prompt: a previous summary is updated through
`<previous-summary>`, a cut inside a user turn gets a separate turn-prefix summary, and Critical Context asks for the
relevant files. Automatic thresholds and `/compact` come from pi-durable; the summary is stored
as the durable `pi.compaction` entry and shown as a completed item in T3.

## Prompt text

All model-facing prompts and tool copy this harness authors — system prompts, user-prompt templates, XML wrappers,
tool descriptions and short tool output notes — lives in `src/prompts.ts`. Tool descriptions inherited from pi-durable's coding and
codemode tools are not duplicated there. MCP tool descriptions come from the server and are shown only in a
script's on-demand `describeTool()`.

## Attachments

Every image and file sent in a T3 thread is kept in the workspace at `/home/agent/attachments/`, and the prompt lists
the paths (`Attachments:` and one `- <path>` line each), so the agent can work with them using its normal tools. An image
also reaches the model inline when the selected model accepts images. The T3 thread shows the attachment, not the path
line, and reads it from the workspace; one the agent deletes shows as missing. Nothing removes them otherwise. Uploads
are capped at 50 MiB.

## Inline HTML

The agent can show a finished page (a chart, a diagram, a mockup) inline in its T3 thread, above its reply: T3's
`html_render`, from codemode. T3's rules apply: the page uses T3's theme variables, has no viewport-height units, and
local images given as absolute paths are inlined. The page is kept in `/home/agent/attachments/` and shown in T3's
sandboxed frame. With the browser configured, `html_preview` renders a page first and returns a screenshot, its height
and its console, and published pages are measured for phones and wide windows. The codemode catalog lists
`html_render`; when to use it is in its description.

## Web tools

The harness offers `web_search`, `web_fetch`, `summarize` and the `browser_*` tools to codemode scripts. They are local
services, not cloud APIs, that you run; like every outside service, each tool is offered only when its URL is set in
`.env`, and the harness logs which are off at start:

- `web_search` calls a SearXNG JSON endpoint (`SEARXNG_URL`, e.g. `http://searxng:8080`).
- `web_fetch` calls a page-reader service (`READER_URL`, e.g. `http://reader:8000`) and returns the complete page as main-content Markdown. There is no tool-level character limit; the codemode output limit decides what reaches the model.
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

## Memory

Long-term memory is [Hindsight](https://github.com/vectorize-io/hindsight), which you deploy yourself, as with
Browserless; the harness only connects to it. `HINDSIGHT_URL` turns it on (for example `http://hindsight:8888`),
`HINDSIGHT_API_KEY` is sent as a bearer token when your server requires one, and `HINDSIGHT_BANK` names the memory bank
(default `claw`). Without `HINDSIGHT_URL` there is no memory: nothing is recalled or stored, the memory tools are not
offered, and the harness logs that at start. A malformed value stops the harness; a server that does not answer yet
does not (the log says so, and recalls say so until it answers).

How it works (`src/hindsight.ts`):

- **Recall.** Each message that starts or steers a turn (from you, another thread or the scheduler; not a note or a
  child's report) is searched for, and the observations that come back are stored with the message as a hidden
  `<memories>` block, through the bridge's `messageContext`. Observations are what Hindsight consolidates from the
  facts it extracted: de-duplicated, each backed by its sources. Stored with the message, not added to each request,
  so the prompt cache holds. Hindsight fills a 1,024-token budget with the best matches; claw then leaves out:
  - a match whose reranker score is below 0.01 (`RECALL_MIN_SCORE`): low on purpose, since the scores order well but
    are not absolute, so it only drops what has nothing to do with the message;
  - one recalled for an earlier message and still in the model's context;
  - one drawn only from turns still in the model's context.

  After a compaction, what it removed from the context can be recalled again. T3 shows the block right after your
  message as a `hindsight_recall` row (no tool ran): the query, exactly what the model was given, and below a "shown
  here only, not sent to the model" line each memory's score and sources and what was left out and why. The bridge
  waits at most 5 seconds; a failed search becomes a line in the block saying memory could not be searched.
- **Remembering.** After each finished turn, a copy of the conversation (as the model saw it when the turn ended;
  nothing is written to the thread) gets one more message: what in the latest turn is worth remembering weeks from
  now, one self-contained statement per line, or `NOTHING`, which is the usual answer. A tool call there is turned
  down. The notes are stored as the turn's document (the conversation and its entry range, which is how recall knows
  where a memory came from); `NOTHING` stores nothing. Turns are written one at a time, off the run; one not written
  yet when the harness stops is lost. A failure is logged, never fatal.

  **This sends the whole conversation to T3's text-generation model (Settings → Models) after every turn**, of every
  thread, scheduled tasks and child threads included, falling back to the thread's own model when that setting names
  none of ours. Use a model you can afford to call that much: a local one, ideally with prompt caching (llama.cpp,
  vLLM), so each call mostly reads the new turn. A conversation larger than that model's context window is cut from
  its oldest turns; a turn that alone does not fit is not stored.
- **Tools** for scripts: `hindsight_recall` (every kind of memory, not only observations), `hindsight_retain` (for
  what is learned outside the conversation) and `hindsight_reflect`, listed in the codemode catalog.

What Hindsight does with it (the model it calls to extract facts, the embedding model, its database) is your
deployment's configuration. Choose the embedding model before storing anything: changing it later re-embeds every
memory. Hindsight's default is English-only, and its multilingual `hs-embed-1` covers English, Spanish, French,
German, Portuguese, Japanese, Korean and Chinese.

## MCP servers

The agent owns its MCP configuration: `/home/agent/.mcp.json` in the workspace, in Claude Code's `.mcp.json`
format, so a snippet from a server's documentation works as is. The agent adds, edits and removes servers itself. The
harness checks the file before each model request and after each round of tools, and applies the change: a new server
connects, a changed one reconnects, a removed one is closed. A broken file or entry leaves the running servers alone.
Project `.mcp.json` files are not read.

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "timeout": 60000,
      "description": "Search and read the product documentation"
    }
  }
}
```

`type` is required: `"http"` (or its alias `"streamable-http"`). `timeout` is per request, in milliseconds.
stdio, `sse` and `ws` entries are refused with a message saying so, as is `alwaysLoad: true`: every MCP tool is called
from codemode.
`${NAME}` (or `${NAME:-default}`) in `url` or `headers` names one of the harness's [secrets](#secrets), never an
environment variable. A server that names a missing secret is reported as needing it, and connects once the secret is
saved. Changing a secret reconnects the servers that use it.

Scripts call every MCP tool. `exposure: "hidden"` (per server, or per tool with `toolExposure`, exact names or `*`
patterns) makes a tool unreachable; `"codemode"` is the default.

The system prompt names the configured servers with their `description`, as `~/.mcp.json` had them when the prompt was
rendered (see [A fixed system prompt](#a-fixed-system-prompt)). Scripts find the tools with `searchTools()` and
`describeNamespace("mcp__<server>")`. A successful connect installs the server's tools, callable at once. A server
that fails to connect, or drops later, is logged and reconnected in the background (after 5 s, 15 s, 1 min, then
every 5 min); its tools appear once it is back.

`mcp({ action: "status" })` answers what is live: the configuration read afresh, its problems, and each server's
connection, error and tool count, once a connection in progress has settled. The agent calls it after editing
`~/.mcp.json`.

### OAuth

A server with no `Authorization` header signs in by OAuth when it answers 401, as in Claude Code. `mcp`'s status shows
it as needing a sign-in. The agent calls `mcp({ action: "login", server })` and gives the user the link.
After the user approves, the browser returns to `<CLAW_PUBLIC_URL>/host/oauth/callback` and the server connects. If the
user's browser cannot reach that URL, the page fails to load, but the address bar still holds the code: pasted back to
the agent, `mcp({ action: "complete", redirectUrl })` finishes the sign-in the same way. A callback works once.

Discovery follows the MCP authorization spec (RFC 9728, then RFC 8414). The client registers dynamically, unless the
server takes a Client ID Metadata Document or you configure a client. Tokens refresh on their own, including a
step-up on `insufficient_scope`. They are kept with the secrets in `secrets.json` and appear in tool output only as
`[<server> OAuth credential]`. `mcp({ action: "logout", server })` forgets a sign-in.

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
`CLAW_PUBLIC_URL`, use `https` (remote access, or Tailscale Serve) or the paste fallback. With remote access on and
`CLAW_PUBLIC_URL` unset, the callback is the tailnet address, chosen at start: restart the harness after turning
remote access on for the first time.

## Secrets

The harness keeps named secrets in `data/harness/secrets.json` (owner-only, outside `durable.db`). The agent asks for
one with `request_secret`: T3 shows a private card in the thread, the value you enter is saved under the name the agent
chose (`GITHUB_TOKEN`), and it never enters the chat. Scripts can also `list`, `set` (a value the agent already has) and
`delete` secrets with the `secrets` tool.

The agent uses a secret by writing `${NAME}` where the value goes: tool arguments, MCP config, browser form
fields. Only the names of saved secrets are replaced; any other `${...}` in a tool's arguments (a shell or compose
default in a file being written) is left as written. A shell command uses `$NAME`: the secrets it names are exported to it. The value is substituted only
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
  idle. A wait that runs out turns into the same delivery.
- `thread_wait` waits for several threads and returns their reports with the worst verdict.
- `thread_read` reads a thread's exchanges, the caller's own included, back past any compaction.
- `thread_search` searches every thread's messages; `thread_list` lists threads (`parent: "self"` for children).
- `thread_cancel` stops a thread and, by default, its children; nobody gets reports of the stopped work.

A child nests under its parent in T3: the parent's run shows it as a subagent card, and the child is a full thread
you can open and write to. Children nest at most 3 deep, and at most 10 children of one thread work at once.

Scripts also have T3's scheduled-task tools: `schedule_task` (a prompt on an interval or at a time of day, posted
into the calling thread by default, or into a new thread per run with `bindToCurrentThread: false`; with a
`scheduledTaskId` it changes or pauses a task), `list_scheduled_tasks` and `delete_scheduled_task`. The tasks are the
ones T3's Settings → Scheduled tasks shows.

T3's own thread tools are served to outside MCP clients at `<CLAW_PUBLIC_URL>/mcp`. A client signs in over OAuth as it would to T3:
it opens T3's approval page, where you choose its access and approve with a pairing code (`claw pair`) or in one click
from a signed-in browser. It then appears under Settings → Sharing & access, where it can be revoked. Every thread
here runs at full access, so a client approved below that can only read.

## Codemode limits

Each codemode script runs in its own QuickJS VM, in a worker thread of the harness process. A script may allocate at
most 256 MiB (`CLAW_CODEMODE_MEMORY_MB`); past that it fails with `out of memory` and the turn goes on, instead of
taking the harness down. A script has no time limit unless it sets one: a first line `// @options: {"timeout_ms": 60000}`
ends it after that long (pi-durable's codemode; it does not use the sandbox's 5-minute default).

### Known limitations

- No account integrations are configured by default. HTTP MCP servers can be added as above (with OAuth); stdio
  servers and MCP resources are not supported. Web search, page view and the browser are the built-in connectors.
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
                                    codemode, threads, schedules
```

See [docs/design.md](docs/design.md) for the decisions and why.

## Development

`pnpm install`, `pnpm typecheck`, `pnpm test` (needs Docker; `CLAW_TEST_MODEL=provider/modelId` adds a real-model
test). The T3 bridge, [pi-durable-t3](https://github.com/mgabor3141/pi-durable-t3), is not on npm yet: it installs
from git at a pinned commit and builds on install (it fetches T3's contracts and web app), which `package.json`
allowlists. Its pi packages are peers, so the pi versions are ours: keep every `@earendil-works` package on one
version (`test/one-copy.test.ts` checks it). To try a bridge change, point the dependency at a local checkout
(`link:../pi-durable-t3`, built with `pnpm build` there).

`claw-tailnet` (remote access) is Go, in `tailnet/`: `go test ./...` there (Go 1.27). The harness image builds and tests it;
for a local `pnpm test` it is not needed (a stand-in program covers the harness's side).

## License

MIT
