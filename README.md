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

### Known limitations

- No integrations yet (calendar, MCP servers): the assistant has a workspace and nothing else.
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
