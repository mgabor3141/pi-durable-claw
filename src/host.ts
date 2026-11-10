// The always-on assistant: the codemode-first harness (workspace read/write/bash over pi-env SSH) behind the T3 bridge
// (`attachT3` from @mgabor3141/pi-durable-t3, which serves T3's web app), plus the title hook and shutdown copied from
// the bridge's example agent.
//
//   node src/host.ts --root <dir> [--listen <host>] [--workspace <host:port>] [--pubkey-dir <dir>]   serve
//   node src/host.ts --root <dir> pair                    mint a single-use pairing code and print the link
//   node src/host.ts --root <dir> remote [on|off|status]  remote access over your tailnet (`tailnet.ts`)
//
// The flags are the image's wiring, set by its `claw` launcher: the data dir (`--root`: storage, bridge state, SSH
// keys), the listen address (default 127.0.0.1), the workspace's SSH address (default workspace:22), and where the
// harness's public key is published for the workspace (default: not published). Your settings are environment
// variables, listed in .env.example; compose passes .env whole. Models: <root>/pi/auth.json (and models.json).
import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { Hindsight, hindsightConfig } from "./hindsight.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Registry } from "@earendil-works/pi-durable";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openHarness, type HarnessLate } from "./harness.ts";
import { McpManager } from "./mcp/manager.ts";
import { workspaceSource } from "./mcp/config.ts";
import { McpOAuth } from "./mcp/oauth.ts";
import { SecretStore, withSecrets } from "./secrets.ts";
import { connectWorkspace, ensureKeypair, WORKSPACE_HOME, workspaceEnv, workspaceTarget } from "./workspace.ts";
import { webConfig } from "./web.ts";
import { deviceName, readRemoteEnabled, readStatusFile, Tailnet, tailnetUrl, writeRemoteEnabled, type TailnetStatus } from "./tailnet.ts";
import { attachT3, mintPairingCode } from "@mgabor3141/pi-durable-t3";
import { installShutdown } from "./shutdown.ts";
import { titleThread } from "./title.ts";

// An empty setting is an unset one (an `.env` line left blank).
const PORT = Number(process.env.CLAW_PORT?.trim() || 3775);
const PUBLIC_URL_SET = (process.env.CLAW_PUBLIC_URL?.trim() ?? "") !== "";
const PUBLIC_URL = (PUBLIC_URL_SET ? process.env.CLAW_PUBLIC_URL!.trim() : `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
/** Where your browser reaches this host (pairing links, OAuth callbacks): CLAW_PUBLIC_URL when set, else the tailnet
 * address while remote access is on and serves HTTPS, else loopback. */
const publicUrl = (root: string): string => (PUBLIC_URL_SET ? PUBLIC_URL : (tailnetUrl(root) ?? PUBLIC_URL));
const LABEL = process.env.CLAW_LABEL?.trim() || "claw";
/** The agent's MCP configuration, in the workspace (Claude Code's user-scope file). */
const MCP_CONFIG_PATH = join(WORKSPACE_HOME, ".mcp.json");

const log = {
	info: (message: string, fields?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", message, ...fields })),
	warn: (message: string, fields?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "warn", message, ...fields })),
};

/** The thread tools, grouped in codemode's listing. */
const THREAD_NAMESPACE = {
	name: "thread",
	prefix: "thread_",
	description: "Other agents' threads: start a child or follow up (thread_prompt), wait for, read, search, list and stop threads",
};

/** Where an OAuth sign-in returns (a public route on T3's listener; its `state` is the check). */
const OAUTH_CALLBACK_PATH = "/host/oauth/callback";

/** The page the user's browser lands on after approving (or refusing) a sign-in. */
async function oauthCallback(mcp: McpManager, request: Request): Promise<Response> {
	const page = (status: number, title: string, text: string) =>
		new Response(
			`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font:16px system-ui;max-width:32em;margin:4em auto;padding:0 1em"><h1 style="font-size:1.3em">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body>`,
			{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
		);
	try {
		const server = await mcp.completeSignIn(new URL(request.url).searchParams);
		return page(200, `Signed in to ${server}`, "The agent can use it now. You can close this tab.");
	} catch (error) {
		log.warn("MCP sign-in failed", { error: error instanceof Error ? error.message : String(error) });
		return page(400, "Sign-in failed", error instanceof Error ? error.message : String(error));
	}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const USAGE = `usage: node src/host.ts --root <dir> [--listen <host>] [--workspace <host:port>] [--pubkey-dir <dir>]
       node src/host.ts --root <dir> pair
       node src/host.ts --root <dir> remote [on|off|status]`;

/** The command line: the image's wiring as flags (unknown ones refused), then the command and its argument. */
function parseCommandLine(argv: readonly string[]) {
	const { values, positionals } = parseArgs({
		args: [...argv],
		options: { root: { type: "string" }, listen: { type: "string" }, workspace: { type: "string" }, "pubkey-dir": { type: "string" } },
		allowPositionals: true,
		strict: true,
	});
	const workspace = values.workspace ?? "workspace:22";
	const match = /^(.+):(\d+)$/u.exec(workspace);
	if (match === null) throw new Error(`--workspace must be host:port, not ${workspace}`);
	return {
		root: values.root,
		listen: values.listen ?? "127.0.0.1",
		workspace: { host: match[1]!, port: Number(match[2]) },
		pubkeyDir: values["pubkey-dir"],
		command: positionals[0],
		argument: positionals[1],
	};
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	while (argv[0] === "--") argv.shift();
	let line: ReturnType<typeof parseCommandLine>;
	try {
		line = parseCommandLine(argv);
	} catch (error) {
		console.error(`${(error as Error).message}\n${USAGE}`);
		process.exit(2);
	}
	const { root } = line;
	if (root === undefined || (line.command !== undefined && line.command !== "pair" && line.command !== "remote")) {
		console.error(USAGE);
		process.exit(2);
	}
	const stateDir = join(root, "t3");
	const scratchDir = join(WORKSPACE_HOME, "scratch");
	const listen = { host: line.listen, port: PORT };

	// `pair`: mint a code against the state dir's auth store and exit; the running host reads the store per attempt.
	// With remote access on and serving HTTPS, the link is the tailnet's, unless CLAW_PUBLIC_URL names another.
	if (line.command === "pair") {
		const { code } = mintPairingCode(stateDir);
		const base = publicUrl(root);
		console.log(`Pairing code (single use): ${code}`);
		console.log(`\n  Open in a browser (pairs and opens the web app), or paste into the T3 desktop app's Add computer:\n  ${base}/pair#token=${code}\n`);
		return;
	}
	if (line.command === "remote") {
		process.exit(await remoteCommand(root, line.argument ?? "on"));
	}

	// Models: pi's own files under <root>/pi (auth.json with keys, optionally models.json), read and refreshed in place.
	// No credentials at all is fatal: the host has nothing to answer with.
	const piDir = join(root, "pi");
	const models = await ModelRuntime.create({ authPath: join(piDir, "auth.json"), modelsPath: join(piDir, "models.json"), modelsStorePath: join(piDir, "models-store.json") });
	if ((await models.getAvailable()).length === 0) {
		console.error(`no models are available: put an auth.json with a provider key in ${piDir} (see the README).`);
		process.exit(1);
	}

	// The workspace: our keypair (made on first start, public half published for the workspace), then connected once;
	// its host key is accepted on first use and kept under the root.
	const sshDir = join(root, "ssh");
	ensureKeypair(sshDir, line.pubkeyDir);
	const workspaceConfig = { ...line.workspace, sshDir };
	let workspace;
	try {
		workspace = await connectWorkspace(workspaceConfig);
	} catch (error) {
		console.error(`cannot reach the workspace over SSH (${workspaceConfig.host}:${workspaceConfig.port}): ${(error as Error).message}`);
		process.exit(1);
	}

	// The harness's secrets, beside its data and outside `durable.db` (`secrets.ts`).
	const secrets = new SecretStore(join(root, "secrets.json"));
	// The agent's own MCP configuration, `~/.mcp.json` in the workspace: it adds and edits servers itself; an edit is
	// picked up before its next request, and a broken entry is reported in its prompt, not fatal.
	// OAuth sign-ins come back to this host: the user's browser reaches it already (`mcp/oauth.ts`).
	const oauth = new McpOAuth({ redirectUrl: `${publicUrl(root)}${OAUTH_CALLBACK_PATH}`, store: secrets, secrets });
	const mcp = new McpManager({
		source: workspaceSource(workspaceEnv(workspace.connection), MCP_CONFIG_PATH, BACKGROUND_CONTEXT),
		logger: log,
		secrets,
		oauth,
		baseNamespaces: [THREAD_NAMESPACE],
		wrapTool: (tool) => withSecrets(tool, secrets, log),
	});
	secrets.subscribe(() => void mcp.secretsChanged());
	await mcp.load();

	let toolRegistry: Registry | undefined;
	// The agent's browser is T3's preview browser (Browserless over CDP). Without one there is no browser at all: the
	// tools are not offered, and the log says why.
	const browserlessUrl = process.env.BROWSERLESS_URL?.trim() ?? "";
	if (browserlessUrl === "") log.info("browser tools off: BROWSERLESS_URL is not set");
	// Web search and page fetch are services you run, as with Browserless: each tool only with its URL.
	const web = webConfig(process.env);
	if (web.searxngUrl === undefined) log.info("web_search off: SEARXNG_URL is not set");
	if (web.readerUrl === undefined) log.info("web_fetch off: READER_URL is not set");
	// Long-term memory is Hindsight, which you deploy yourself, as with Browserless (`hindsight.ts`). Without
	// HINDSIGHT_URL there is no memory: no recall, nothing stored, no memory tools.
	const memoryConfig = hindsightConfig(process.env);
	const memory = memoryConfig === undefined ? undefined : new Hindsight(memoryConfig, log);
	if (memory === undefined) log.info("memory off: HINDSIGHT_URL is not set");
	else await memory.check();
	// Filled in once the bridge is attached (below); the harness's own tools read it at each call.
	const late: HarnessLate = {};
	const harness = await openHarness({
		storagePath: join(root, "durable.db"),
		browser: browserlessUrl !== "",
		web,
		workspace,
		models,
		mcpNamespaces: mcp.namespaces(),
		late,
		secrets: { store: secrets, log },
		...(memory === undefined ? {} : { extraTools: memory.tools() }),
		extraExtensions: [mcp.extension(), ...(memory === undefined ? [] : [memory.extension()])],
		onRegistry: (registry) => {
			mcp.attach(registry);
			toolRegistry = registry;
		},
	});
	// Connect MCP servers before the T3 bridge accepts input, so the first prompt sees their tools.
	await mcp.start();

	// Remote access over your tailnet, when `claw remote` turned it on: HTTPS to this host, SSH into the workspace.
	const target = workspaceTarget(workspaceConfig);
	const tailnet = new Tailnet({
		root,
		hostname: process.env.CLAW_TAILNET_HOSTNAME?.trim() || deviceName(LABEL),
		allow: (process.env.CLAW_TAILNET_ALLOW ?? "").split(",").map((item) => item.trim()).filter((item) => item !== ""),
		port: PORT,
		workspace: { host: workspaceConfig.host, port: workspaceConfig.port, user: target.user!, sshDir, hostKeyAlias: target.hostKeyAlias! },
		log,
	});

	let t3;
	try {
		t3 = await attachT3(harness, {
			models,
			stateDir,
			scratchDir,
			// Every image and file a user sends lives here, where the agent works, named to it by path.
			attachmentsDir: join(WORKSPACE_HOME, "attachments"),
			// T3 works in the workspace container, with `/` as its root: every absolute path in the protocol is an
			// environment path, and there is no harness-filesystem fallback.
			env: workspaceEnv(workspace.connection, "/"),
			listen,
			label: LABEL,
			routes: [{ method: "GET", path: OAUTH_CALLBACK_PATH, handle: (request) => oauthCallback(mcp, request) }],
			titleThread: titleThread(harness, models),
			// T3 learns the tailnet URL and the SSH host its editors open paths on ("Open in VS Code").
			remoteAccess: tailnet,
			// Each message arrives with the memories recalled for it, stored with it (hidden in T3).
			...(memory === undefined ? {} : { messageContext: (request) => memory.recallFor(request) }),
			...(browserlessUrl === ""
				? {}
				: { preview: { cdpUrl: browserlessUrl, ...(process.env.BROWSERLESS_TOKEN?.trim() ? { token: process.env.BROWSERLESS_TOKEN.trim() } : {}), storageStatePath: join(stateDir, "browser-profile.json") } }),
			log,
		});
	} catch (error) {
		console.error(`failed to listen on http://${listen.host}:${listen.port}: ${(error as NodeJS.ErrnoException).code ?? "unknown"} (${(error as Error).message ?? ""})`);
		await mcp.close();
		await harness.close(BACKGROUND_CONTEXT);
		process.exit(1);
	}

	// The thread tools for scripts (`thread_prompt`, `thread_wait`, `thread_read`, `thread_search`, `thread_list`,
	// `thread_cancel`): a conversation that is a thread's head acts as that thread. Installed once the bridge exists,
	// before anything resumes.
	toolRegistry?.install(t3.threadTools({ callers: ["tools"] }));
	// T3's inline HTML for scripts: `html_render` shows a page in the caller's thread, kept in /home/agent/attachments;
	// `html_preview` (with the preview browser) renders one first.
	toolRegistry?.install(t3.htmlTools({ callers: ["tools"] }));
	// T3's secret card: `request_secret` asks the user in the thread and saves the answer to the harness's secrets.
	toolRegistry?.install(t3.secretRequests({ save: (name, value) => secrets.save(name, value) }));

	// Agent `browser_open` pages are T3's preview tabs, the ones the user sees; there is no other browser.
	// What the harness's own tools need from the bridge: `summarize` generates with T3's text-generation model when it names
	// one of ours (titles get it per request), and `browser_open` opens T3's preview tabs.
	late.textGenerationModel = () => t3.textGenerationModel();
	const previewBrowser = t3.previewBrowser;
	if (previewBrowser !== undefined) late.previewBrowser = (conversationId, url) => previewBrowser.open(conversationId, url);

	tailnet.start();
	if (!readRemoteEnabled(root)) log.info("remote access off: `docker compose exec harness claw remote` turns it on");

	let stopping = false;
	const shutdown = async () => {
		stopping = true;
		await tailnet.close();
		await mcp.close();
		await t3.close();
		await harness.close(BACKGROUND_CONTEXT);
	};

	// Crash resume: the caller resumes AFTER the attach resolved (the bridge's contract). An interrupted codemode call
	// replays its journal: completed nested calls do not run twice.
	harness.resume();
	// A facet that stops serving on its own cannot answer a paired client again: fatal, per the example's policy. A
	// shutdown closes it deliberately, and must then finish closing the harness rather than exit here.
	void t3.closed.then(() => {
		if (!stopping) process.exit(1);
	});

	log.info("pi-durable-claw host ready", {
		address: `http://${listen.host}:${listen.port}`,
		root,
		stateDir,
		workspace: `${workspaceConfig.host}:${workspaceConfig.port} (${workspace.remote.platform}/${workspace.remote.arch})`,
		models: (await models.getAvailable()).map((m) => `${m.provider}/${m.id}`),
	});
	console.log("\n  Pair a device: docker compose exec harness claw pair\n");

	installShutdown(shutdown);
}

try {
	await main();
} catch (error) {
	console.error(`pi-durable-claw host failed: ${(error as Error).stack ?? error}`);
	process.exit(1);
}

/** `claw remote [on|off|status]`: turn remote access on or off, and say where it stands: the login link, the tailnet
 * settings it still needs, or its address. The running host does the work; this waits for its report. */
async function remoteCommand(root: string, action: string): Promise<number> {
	if (action === "off") {
		writeRemoteEnabled(root, false);
		console.log("Remote access is off. The device stays in your tailnet's machine list until you remove it there.");
		return 0;
	}
	if (action !== "on" && action !== "status") {
		console.error("usage: claw remote [on|off|status]");
		return 2;
	}
	const wasOn = readRemoteEnabled(root);
	if (action === "status" && !wasOn) {
		console.log("Remote access is off. `claw remote` turns it on.");
		return 0;
	}
	const since = Date.now();
	if (!wasOn) {
		writeRemoteEnabled(root, true);
		console.log("Remote access is on. Waiting for the harness to start it...");
	}
	// A status written before it was turned on is an old run's.
	const fresh = (): TailnetStatus | undefined => {
		const status = readStatusFile(root);
		if (status === undefined) return undefined;
		if (!wasOn && statSync(join(root, "tailscale", "status.json")).mtimeMs < since) return undefined;
		return status;
	};
	for (let waited = 0; waited < 90_000; waited += 1_000) {
		const status = fresh();
		if (status?.state === "needs-login" && status.authUrl) {
			console.log(`\n  Log this device in to your tailnet (once):\n  ${status.authUrl}\n\n  Then run \`claw remote\` again to check.\n`);
			return 0;
		}
		if (status?.state === "needs-approval") {
			console.log("\n  Logged in; the device waits for approval in your tailnet's admin console (Machines).\n");
			return 0;
		}
		if (status?.state === "running") {
			const problems = status.problems ?? [];
			console.log(`\n  On your tailnet as ${status.dnsName}${status.owner ? `, owned by ${status.owner}` : ""}.`);
			if (problems.length > 0) {
				console.log(`\n  Still needed:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n  Then run \`claw remote\` again.\n`);
				return 1;
			}
			console.log(`\n  T3:  https://${status.dnsName}  (claw pair prints a link to it)\n  SSH: ssh agent@${status.dnsName}  (no key: your tailnet login is the key; T3's "Open in VS Code" uses it)\n`);
			return 0;
		}
		if (waited === 15_000 && status === undefined) console.log("  The harness has not reported yet. Is it running? (docker compose ps; docker compose logs harness)");
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	console.log("  No answer yet; `docker compose logs harness` shows what claw-tailnet says.");
	return 1;
}
