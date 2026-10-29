# pi-durable-claw

An always-on personal agent on [pi-durable](https://github.com/earendil-works/pi): coding, research, calendar,
watching for things, running on your server 24/7 and reachable from T3 Code on desktop, web and phone.

Unofficial; not affiliated with Earendil or T3. Working title. Experimental: what runs today is the codemode-only
assistant (a harness plus a workspace container) served to T3 Code; the rest of the design is not built yet.

## The idea in one rule

**Agent-written code never runs where the keys are.**

- The **harness container** runs the agent loop and holds your keys and MCP servers. The agent reaches them only
  through codemode, a sandbox with no file system or network: it can call your tools, never read their keys.
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
   the link matches. T3 then shows a first-run wizard; skip the project import.
5. **Set the default model:** T3 → Settings → General → New threads → Model. T3 defaults new threads to the first
   model in the catalog, which may not be one you can use.

Everything worth keeping lives in `./data`, next to `compose.yaml`: `harness/` (your credentials, conversations,
pairings, settings, the harness's SSH key), `workspace/` (the agent's files, at `/workspace` in its container) and `workspace-ssh/` (the
workspace's host key). The containers own them as uid 1000. The workspace's sshd is not published, and the Docker
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

## Web tools

The harness offers `web_search`, `fetch_page`, `summarize` and the `browser_*` tools to codemode scripts. They are local
services, not cloud APIs:

- `web_search` calls a SearXNG JSON endpoint (`SEARXNG_URL`, default `http://searxng:8080`).
- `fetch_page` calls a page-reader service (`READER_URL`, default `http://reader:8000`) and returns main-content Markdown. It also writes the complete page to `/workspace/tmp/pages/` when an execution environment exists; the workspace cleans that directory automatically. Use it to grep or read long pages instead of fetching them again.
- `summarize` makes one model call over supplied text or a workspace file; it is not a subagent and cannot run tools.
- `browser_open`, `browser_act`, `browser_snapshot`, `browser_screenshot` and `browser_close` drive a
  Browserless Chromium pool (`BROWSERLESS_URL`, default `ws://browserless:3000/chromium`) over CDP. `BROWSERLESS_TOKEN`
  is optional in the default endpoint and becomes a `token` query parameter when set. `BROWSER_LOCAL_HOSTS` is an
  optional comma-separated allowlist for the browser only; a deployment can set `workspace` so the agent can open
  its own local dev server. `fetch_page` never uses that allowlist.

Point them at services the harness can reach; this repo does not run them. The
reader accepts `POST /read` with `{"url":"..."}` and returns `markdown` and the final `url`.
`fetch_page` accepts only `http` and `https`, refuses embedded credentials and private/internal addresses, and marks
the result as untrusted data. The browser tools apply the same URL check to `browser_open` and `browser_act`'s
`goto`, and wrap page text as untrusted data too. Every tool caps results, size and time. If a service is absent or
the request fails, the tool returns the backend error instead of inventing a result.

The browser is for interaction, not reading. `fetch_page` is the cheap, stateless path and should be the default;
use the browser when a page needs clicks, typing, JavaScript, a screenshot, or a short interactive test. A
screenshot result is an image block; call `image(shot)` in the same codemode script to attach it. One page
is kept per conversation and closed after five idle minutes; Browserless closes it unconditionally after ten
minutes. Local HTML can be opened with `browser_open({ html })`.

When `BROWSERLESS_URL` is set, the bridge also offers T3's in-app Browser panel: it advertises
`serverBrowser`, implements `preview.*` and `subscribePreviewEvents`, and serves `/api/preview-stream/ws`
from the same Browserless Chromium. T3's panel opens a tab, receives JPEG frames and forwards pointer and
keyboard input, so the same browser is visible and controllable from the web or mobile client. This is a live
view, not a page reader. A preview tab has no profile store, upload/download or file chooser; closing the panel
closes its tab. The URL is reached from Browserless, not from the device, so no host forwarder or proxy is
needed.

### Known limitations

- No account integrations yet (calendar, email, MCP servers): web search, page fetch and the browser are the only connectors.
- Scheduled tasks run on intervals or fixed times; there are no webhook triggers.
- T3 projects do not map to containers: use "No project" threads. The project picker, file panel and search go
  through the workspace execution environment, so a project must live under the workspace's `/workspace` (the
  harness's data directory is not visible there).
- Nested calls inside a codemode script are invisible in T3: you see the script and its result.
- The workspace can reach the app. Everything there needs a pairing credential except the web app's static files,
  the environment descriptor and pairing itself.
- A harness restart resumes a turn, but a command that was running in the workspace is cut off, not rerun; the
  agent sees it as interrupted.
- Experimental: pi-durable and the T3 bridge are pre-release and pinned to specific commits.
- `fetch_page` uses a local reader that extracts main content; JavaScript-heavy and anti-bot pages may still fail or return partial text. The complete extracted page is available in `/workspace/tmp/pages/` until it expires.
- The browser keeps no login profile. Live view and human takeover are available through T3's Browser panel
  when `BROWSERLESS_URL` is set; a CAPTCHA, 2FA prompt or payment step that needs you stays blocked.
- The preview panel serves one page per tab and has no profile store, upload/download or file chooser.

## Shape

```
T3 Code (desktop · web · mobile) ── harness container ── execution containers (hako, devcontainers)
                                    pi-durable, bridge,      bash, files, scripts; no keys
                                    keys, MCP servers,
                                    codemode, schedules
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
