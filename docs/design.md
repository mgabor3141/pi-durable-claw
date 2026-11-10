# Design

Status: `docker compose up` runs the harness and a workspace (the README has the install). Built: codemode over the
workspace, web search and page fetch, the browser through T3's preview, MCP servers over HTTP (with OAuth and the
harness's secrets), the thread tools, scheduled tasks (not the webhook trigger) and a system prompt fixed per thread.
Memory is Hindsight, deployed by you and connected by `HINDSIGHT_URL`. Not built: spending caps, notifications, the release flow and self-update,
devcontainers, host conversations. Sections marked **unverified** are assumptions a spike must confirm.

## Goal

One always-on agent that replaces a separate OpenClaw and assorted pi setups. It does coding and personal-assistant
work (searching, recommendations, calendar, watching listings), runs on a server 24/7, and is used from T3 Code.

Two kinds of people use it, as with Home Assistant or Immich:

- the **operator** hosts it, adds integrations and deploys releases;
- **household users** just talk to it. When something needs the operator, the agent says so plainly ("ask Gábor to
  reconnect your calendar").

## Principles

1. **Agent-written code never runs where the keys are.** Codemode is the one exception, and it is safe by
   construction (below).
2. **Full autonomy, no approvals.** The agent runs without approval prompts. Safety comes from what each place holds,
   not from asking.
3. **No UI of our own.** T3 Code is the frontend. Every screen we build is a screen we maintain forever.
4. **Replicate T3, don't invent.** Where T3 defines a feature (scheduling, orchestration), the bridge replicates its
   contract. Where pi provides something (tool search, MCP, codemode), use it.
5. **Small and replaceable.** Two kinds of container, each customisable; any plain container can be an execution
   container.

## Architecture

```
            T3 Code: desktop · web · mobile app
                          │  (pi-durable-t3 bridge; claw-tailnet: its own tailnet device)
┌─────────────────────────┴──────────────────────────┐
│ harness container (server)                         │
│   pi-durable: conversations, storage, schedules    │
│   keys · secrets · MCP clients (HTTP)             │
└───────┬───────────────────────────┬────────────────┘
        │ SSH (pi-env)              │ SSH (pi-env), only from a host conversation
┌───────┴─────────────────────┐   ┌─┴───────────────────────────┐
│ execution containers        │   │ operator's computer         │
│   workspace (hako image)    │   │   started by the operator,  │
│   one devcontainer/project  │   │   never by the agent        │
│   bash, files; no keys      │   └─────────────────────────────┘
└─────────────────────────────┘
```

### Harness container

- pi-durable with SQLite storage; pi-durable-t3 serves T3's web app and its API from the same origin.
- Holds the model keys and every integration key. Each key-bearing MCP server runs as its own container, reached
  over streamable HTTP and holding only its own key, so a bad server exposes one key, not all of them.
- The agent has **no execution environment on the server**. No tool runs a command or touches a file there.
- Keys live in a root-only file or systemd credentials. A passphrase-unlocked vault would block unattended restarts,
  which self-release depends on; it may be offered for laptop installs.

### Codemode

pi's codemode runs model-written JavaScript in QuickJS compiled to WebAssembly: no file system, no network, no timers.
The script can only call the tools it is given. A tool that declares a structured output schema gives the script its
full value; a plain-text result is capped (50 KB / 2,000 lines by default, raisable per tool), so our MCP adapter
passes MCP's `structuredContent` through as structured output. We set the sandbox's memory limit ourselves (without
one, only wasm's 4 GiB address space bounds it). So a script can call a calendar MCP whose
key stays in the harness, write the result into the workspace, and run Python on it there. Data crosses into the
workspace; the key does not.

pi-durable ships it: `@earendil-works/pi-durable/codemode`'s `createCodemodeExtension({ sandbox })`. A script's
`tools.<name>(args)` calls are nested `pi.tool` tasks of the codemode call, so a crash is a **resume, not a rerun**:
the tool is replay-safe — after a restart the script is replayed deterministically from a journal of the results it
already got, completed nested calls never run twice, and the script continues live. The workspace's
`read`/`write`/`bash` and every other harness tool are registered with `callers: ["tools"]`, so only scripts call
them, and so are MCP tools: the codemode section is a catalog of the harness's tools (four in full, the rest on one line each, with `describeTool()` for their declarations) and leaves MCP tools out, which
scripts find with `searchTools()`. The model is offered `codemode` and the bridge's `request_secret`, and that list
never changes, so the prompt cache holds (the README's "A fixed system prompt").
**Verified (spike):** upstream's extension runs a model script whose only capabilities are the conversation's
script-callable tools — a key-bearing harness tool and the workspace's `read`/`write`/`bash`, pi-durable's own coding
tools over pi-env — with the key never reaching the container and the model offered exactly `[codemode]`; after a
kill mid-script the resumed call replays its journal (the completed nested call's side effect landed exactly once),
the interrupted nested call is not rerun, and the script completes.

### Execution containers

- The **workspace**: the agent's own container for files, scripts and scratch work. Default image: hako.
- One **devcontainer per project** for coding, with bash.
- They hold no keys and have network access. They run on the server, so the operator's computer is not in the
  everyday loop.
- The harness reaches them over SSH with pi-env, which deploys its own daemon. An execution container therefore needs
  only sshd. The harness never gets the Docker socket: that would be root on the host. **Verified (spike):** pi-env's
  SSH path (`scanHostKey`/`acceptHostKey`, `connectSsh`, daemon deploy) works unchanged against a stock sshd container
  (Debian slim, key-only, non-root); the static linux-x64 daemon it ships runs there with no libc, and `RemoteExecutionEnv`
  read/write/exec (`python3`) all work. No change to pi-env was needed.
- Version 1 uses a fixed compose setup (one workspace, a folder per project). Creating devcontainers on demand needs
  something with Docker access and is deferred.

### The operator's computer

Reachable only from a **host conversation** that the operator starts: bash on the computer through pi-env, in the
same harness and the same T3 window. The assistant cannot launch or prompt it. Optionally, a few read-only tools
(logs, a screenshot, current activity) may be offered to the assistant.

## Working from T3 (bridge-attach)

`node src/host.ts` serves the codemode-first assistant through `attachT3`; `node src/host.ts pair` mints a pairing
code. Verified in T3's web app (playwright + chromium, screenshots in `.memory/`):

- **The bridge is a package.** `@mgabor3141/pi-durable-t3` is a git dependency at a pinned commit (not on npm yet);
  it builds on install and ships T3's web app, which `attachT3` serves by default. Its pi packages are peers, so we
  choose the pi versions; every `@earendil-works` package is pinned to one version, giving one copy of each at
  runtime (`test/one-copy.test.ts`).
- **Titles.** The `titleThread` hook (a tool-less completion, copied with the shutdown handler from the bridge's
  example agent) titles threads,
  including scheduled-task threads, from the first user entry.
- **Auth boundary.** The bridge binds loopback and guards no `Host` header — pairing is the boundary. Serving T3's
  web app from the host's own origin makes it "This machine"; no Tailscale is needed for local use.
- **Remote access** (`claw remote`, the README's "Remote access"): `claw-tailnet`, a Go program with embedded
  Tailscale (`tsnet`) that the harness runs, joins the tailnet as its own device, as gmux does. It owns the whole
  path: HTTPS on 443 to the harness, and SSH on 22 relayed into the workspace, so T3's editor links (which carry a host
  and no port) reach the agent's files. Who gets in is the tailnet's answer (the device's owner and
  `CLAW_TAILNET_ALLOW`), checked before T3's pairing; SSH takes no key and relays with the harness's. Chosen over a
  Tailscale sidecar container (no compose service, switched on live) and over Tailscale SSH in the workspace (no
  tailnet identity where agent code runs). The bridge advertises it through `remoteAccess`.
- **Crash resume holds through the UI:** kill -9 mid-script, restart, and the codemode call resumes from its
  journal and completes — the completed nested call's side effect lands exactly once.
- **What the UI shows:** a codemode call renders as one tool card (the script's code and its final output). Nested
  calls are invisible. Bridge projects are paths on the harness machine (the Add-project picker, the cwd check, the
  git panel); our project files live in execution containers, so those features do not fit them — the smallest seam
  is a pluggable per-project filesystem for browse and the cwd existence check (proposal in the report).

## Tools

| Profile | Tools (what the model is offered) |
|---|---|
| assistant | codemode and the bridge's request_secret — every other tool, MCP tools included, is `callers: ["tools"]` |
| dev project | read/write/edit/bash on the project's devcontainer, plus codemode |
| host conversation | read/write/edit/bash on the operator's computer |

- Profiles are expressed with `ToolRegistration.callers` and the agent's `modelTools`. A request offers exactly the
  tools in the column above.

- **Web research** is split by job: `web_search` reads SearXNG JSON, `web_fetch` reads one page through the
  stateless reader, and the `browser_*` tools drive T3's preview browser (Browserless over CDP): the tabs the user
  sees in T3's Browser panel. All live in the harness because the service URLs and the browser token do; the services
  are separate containers, so page-driven code never runs beside the keys. Results carry caps and are wrapped as untrusted data. The workspace still has no direct route to
  the LAN.
- **Orchestration**: the agent's thread tools (`thread_prompt`, `thread_wait`, `thread_read`, `thread_search`,
  `thread_list`, `thread_cancel`) start and drive child threads; outside MCP clients get T3's orchestrator toolkit on
  `/mcp`. Agents will be able to prompt dev-project agents (they hold no keys); none can reach a host conversation.
- **Schedules** replicate T3's scheduled tasks: interval and fixed time. The signed webhook (a cheap watcher waking the
  agent only when something changed) is not built; the bridge refuses it.
- An MCP tool that is rarely needed and destructive can be hidden per tool (`toolExposure: { "delete_*": "hidden" }`).
  Nothing is hidden unless the configuration says so.
- Executor is not used: with keys in the harness, pi's codemode already isolates them, and nesting Executor's
  codemode inside pi's confuses models.

## What needs the operator

Only the two steps where agent-written code would move next to the keys:

| Agent does freely | Needs the operator |
|---|---|
| compose tools in codemode, save scripts and skills | add an MCP server that needs a key |
| run anything in execution containers | deploy a new harness release |
| write a keyless MCP server in the workspace (the harness connects over HTTP) | |
| orchestrate agents, manage schedules | |

## Self-management

Three layers:

1. **Data**: memory files, skills, feedback. The agent edits them freely.
2. **Integrations**: keyless MCP servers it writes in the workspace; key-bearing ones the operator sets up.
3. **Code**: the harness repository is just another devcontainer project. The agent develops and tests there,
   against a snapshot of the production store. A release builds the harness image; the operator deploys it. The
   deploy snapshots the store, recreates the container and rolls back if the health check fails. pi-durable resumes
   in-flight work after the restart. Self-update, the agent restarting into a new release, would bring back a
   restart tool (removed while nothing needed it: MCP configuration and secrets apply live, the prompt has `/reload`).

## Memory

[Hindsight](https://github.com/vectorize-io/hindsight), adopted as a service rather than built: retain, recall and
reflect over memory banks, with consolidated observations, and recall by vector, keyword, entity graph and time. It is
an integration point, like Browserless: you deploy Hindsight, `HINDSIGHT_URL` connects it, and without it there is no
memory. The harness recalls observations for each message (stored with it, hidden, so the prompt cache holds),
leaving out what the model's context already holds, which it knows from the entry range each stored turn records and
the ids each recall stores with its block. After each turn, a copy of the conversation is asked what is worth
remembering, on T3's text-generation model; only that answer is stored, so Hindsight extracts from notes rather than
from transcripts full of passing detail. Scripts get `hindsight_recall`, `hindsight_retain` and
`hindsight_reflect` (the README's "Memory"). Left to the deployment: the model Hindsight calls, its embedding model,
where it runs and whether agents share it (one bank each, `HINDSIGHT_BANK`; separate keys need Hindsight's tenant
extension). Not built: importing past threads.

Today every new conversation starts with the same conventions (global `AGENTS.md`, global skills, cwd, project
`AGENTS.md` and skills, and the conversation-start time); anything else the agent keeps is files it reads on demand.

## Spending caps

Opt-in caps per task, per day, per month and per scheduled task. The agent can read its budget but not raise it. A
24/7 agent on schedules with no approvals is exactly where a runaway loop costs money. pi-durable already records
usage per conversation; the check runs before each model request.

## Notifications

ntfy, added to the bridge. No push for a thread a T3 client is currently watching; other threads still notify.

## Households

**One harness per person.** Each household member gets their own instance: their own keys, memory, workspace and T3
pairing. This is real isolation with almost no new code. Users inside one shared harness would need an account system
and still not isolate files or keys.

## Frontend

Stock T3 on desktop, web and the store mobile app (confirmed working with the bridge). After a household member has
used it for a few weeks, what confused them decides between a fork that hides features at a few seams and a small
custom app on T3's client runtime. **To check:** the pi mobile UI mentioned on the pi Discord.

## Accepted risks

- **Keys are safe; their use is not.** Injected instructions on a web page can make the agent misuse a tool it has.
- **The workspace has network access,** so data a key-bearing tool returned can leave from there.
- **pi-durable is new** and the T3 pin follows nightlies; upgrades will need care.

## Plan

1. Scheduling in the bridge — done, except the webhook trigger: interval and fixed-time tasks fire, the bridge
   refuses webhook triggers.
2. Done: a pi-durable codemode tool with the workspace's read/write/bash injected over pi-env to an sshd container.
3. Done (v0): harness and workspace images and a compose file for a fresh machine. The T3 bridge installs as a package
   from git; the harness's SSH public key reaches the workspace through a small shared volume.
4. Done: MCP servers over HTTP, one container each for key-bearing ones, configured by the agent in `~/.mcp.json`,
   with OAuth and the harness's secrets; tools are called from codemode. stdio servers are refused.
5. Done: orchestration (the thread tools, and T3's orchestrator toolkit on `/mcp`). Not done: dev-project devcontainers.
6. Done: memory (Hindsight, as an integration point). Not done: spending caps; ntfy.
7. Release flow: store snapshot, deploy, health check, rollback; then self-update.
8. Host conversations.

## Prior art

- [piclaw](https://github.com/rcarmo/piclaw) by Rui Carmo: the Dream memory model, spending caps and notification
  policy above are adapted from it, and its family mode informed "one harness per person".
- [hako](https://github.com/mgabor3141/hako): "the boundary is the absence of secrets", and the default workspace image.
- [What is Codemode](https://lucumr.pocoo.org/2026/10/6/codemode/), Armin Ronacher.
- OpenClaw, which this replaces.
