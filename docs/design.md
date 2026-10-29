# Design

Status: decisions agreed. Plan step 1 is implemented in the bridge (interval and fixed-time schedules; the webhook
trigger is not), step 2 (codemode over the workspace) is the harness in `src/`, and step 3 is done: `docker compose
up` runs the harness and a workspace (the README has the install). Web search and page fetch are implemented as
harness tools against a local SearXNG and page-reader service; account integrations and the rest of the plan are not
built. Sections marked **unverified** are assumptions a spike must confirm.

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
                          │  (pi-durable-t3 bridge, Tailscale Serve)
┌─────────────────────────┴──────────────────────────┐
│ harness container (server)                         │
│   pi-durable: conversations, storage, schedules    │
│   keys · MCP servers (one process each) · codemode │
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
- Holds the model keys and every integration key. Each key-bearing MCP server runs as its own process holding only
  its own key, so a bad server exposes one key, not all of them.
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
already got, completed nested calls never run twice, and the script continues live. Tools the model must never see
(MCP tools, the workspace's `read`/`write`/`bash`) are registered with `callers: ["tools"]`, so only scripts call
them; the agent's `modelTools` selects what a conversation offers the model — for the assistant, exactly `codemode`.
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

`node src/host.ts` serves the codemode-only assistant through `attachT3`; `node src/host.ts pair` mints a pairing
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
- **Crash resume holds through the UI:** kill -9 mid-script, restart, and the codemode call resumes from its
  journal and completes — the completed nested call's side effect lands exactly once.
- **What the UI shows:** a codemode call renders as one tool card (the script's code and its final output). Nested
  calls are invisible. Bridge projects are paths on the harness machine (the Add-project picker, the cwd check, the
  git panel); our project files live in execution containers, so those features do not fit them — the smallest seam
  is a pluggable per-project filesystem for browse and the cwd existence check (proposal in the report).

## Tools

| Profile | Tools (what the model is offered) |
|---|---|
| assistant | codemode — MCP tools, workspace read/write/bash, orchestration and schedules are `callers: ["tools"]`: scripts call them, the model is not offered them |
| dev project | read/write/edit/bash on the project's devcontainer, plus codemode |
| host conversation | read/write/edit/bash on the operator's computer |

- Profiles are expressed with `ToolRegistration.callers` and the agent's `modelTools`: key-bearing and workspace tools
  are script-callable only, so a request offers exactly the tools in the column above.

- **Web research** is split by job: `web_search` reads SearXNG JSON, `web_fetch` reads one page through the
  stateless reader, and the `browser_*` tools drive an interactive Browserless pool. All live in the harness because
  the service URLs and the browser token do; the services are separate containers, so page-driven code never runs
  beside the keys. Results carry caps and are wrapped as untrusted data. The workspace still has no direct route to
  the LAN.
- **Orchestration** replicates T3's orchestrator MCP: launch, send, wait, read, interrupt and fork threads; queues;
  projects. Agents can prompt dev-project agents (they hold no keys); none can reach a host conversation.
- **Schedules** replicate T3's scheduled tasks: interval, fixed time, and signed webhook. The webhook lets a cheap
  watcher (a script in the workspace, or an MCP server) wake the agent only when something changed.
- Destructive tools that are rarely needed are hidden by default with pi's per-tool exposure (`"delete_*": "hidden"`).
  Household instances default to fewer tools still.
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
   in-flight work after the restart.

## Memory

Files, not a vector database. Adapted from piclaw's "Dream":

- every new conversation starts with the same conventions (`AGENTS.md`); the user profile is referenced and the memory index is named, but both are read on demand;
- a nightly scheduled run reviews recent activity, writes human-readable daily notes, distils preferences,
  corrections and project state, and prunes the rest. It may edit only the memory and feedback files.

The memory files live in the workspace. The harness injects the global `AGENTS.md` and only references `USER.md`; the agent reads the rest when a task needs it, so a project conversation does not carry personal context by default.

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
4. Key-bearing MCP servers, one process each; tool exposure defaults.
5. Orchestration (T3's orchestrator MCP) and dev-project devcontainers.
6. Memory and the nightly consolidation; spending caps; ntfy.
7. Release flow: store snapshot, deploy, health check, rollback.
8. Host conversations.

## Prior art

- [piclaw](https://github.com/rcarmo/piclaw) by Rui Carmo: the Dream memory model, spending caps and notification
  policy above are adapted from it, and its family mode informed "one harness per person".
- [hako](https://github.com/mgabor3141/hako): "the boundary is the absence of secrets", and the default workspace image.
- [What is Codemode](https://lucumr.pocoo.org/2026/10/6/codemode/), Armin Ronacher.
- OpenClaw, which this replaces.
