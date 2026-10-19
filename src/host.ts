// The always-on assistant: the codemode-only harness (workspace read/write/bash over pi-env SSH) behind the T3 bridge
// (`attachT3`), plus the example host's title hook and shutdown — both imported from the T3 repo, nothing copied.
// `pi-durable-t3` is a `link:` dependency; Node resolves it to the repo's real path, so its .ts sources strip outside
// node_modules (package.json shares one copy of each pi package).
//
//   node src/host.ts [--root <dir>]        serve (root: CLAW_ROOT; storage, bridge state, SSH keys live under it)
//   node src/host.ts pair                  mint a single-use pairing code and print the link
//
// Configuration (all CLAW_*): ROOT, HOST (listen address, default 127.0.0.1), PORT (3775), PUBLIC_URL (what `pair`
// prints; default http://127.0.0.1:PORT), WORKSPACE_HOST (workspace), WORKSPACE_PORT (22), PUBKEY_DIR (where to
// publish the harness's public key for the workspace; unset: not published). Models: <root>/pi/auth.json (and models.json).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openHarness } from "./harness.ts";
import { connectWorkspace, ensureKeypair } from "./workspace.ts";
import { attachT3, mintPairingCode } from "pi-durable-t3/src/bridge.ts";
import { titleThread } from "pi-durable-t3/examples/coding-agent/src/title.ts";
import { installShutdown } from "pi-durable-t3/examples/coding-agent/src/shutdown.ts";

/** The T3 repo's built web app (its `pnpm setup:t3` output). */
const WEB_APP_DIR = fileURLToPath(new URL("web-dist", import.meta.resolve("pi-durable-t3/package.json")));

const PORT = Number(process.env.CLAW_PORT ?? 3775);
const LISTEN = { host: process.env.CLAW_HOST ?? "127.0.0.1", port: PORT };
const PUBLIC_URL = (process.env.CLAW_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

const log = {
	info: (message: string, fields?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", message, ...fields })),
	warn: (message: string, fields?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "warn", message, ...fields })),
};

/** The value after `--root`, if any (undefined at the end or before another flag). */
function rootFromArgv(argv: readonly string[]): string | undefined {
	const index = argv.indexOf("--root");
	const value = index >= 0 ? argv[index + 1] : undefined;
	return value !== undefined && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	while (argv[0] === "--") argv.shift();
	const root = rootFromArgv(argv) ?? process.env.CLAW_ROOT;
	if (root === undefined) {
		console.error("usage: node src/host.ts [--root <dir>]   (or set CLAW_ROOT)\n       node src/host.ts pair");
		process.exit(2);
	}
	const stateDir = join(root, "t3");

	// `pair`: mint a code against the state dir's auth store and exit; the running host reads the store per attempt.
	if (argv[0] === "pair") {
		const { code } = mintPairingCode(stateDir);
		console.log(`Pairing code (single use): ${code}`);
		console.log(`\n  Open in a browser (pairs and opens the web app), or paste into the T3 desktop app's Add computer:\n  ${PUBLIC_URL}/pair#token=${code}\n`);
		return;
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
	ensureKeypair(sshDir, process.env.CLAW_PUBKEY_DIR);
	const workspaceConfig = { host: process.env.CLAW_WORKSPACE_HOST ?? "workspace", port: Number(process.env.CLAW_WORKSPACE_PORT ?? 22), sshDir };
	let workspace;
	try {
		workspace = await connectWorkspace(workspaceConfig);
	} catch (error) {
		console.error(`cannot reach the workspace over SSH (${workspaceConfig.host}:${workspaceConfig.port}): ${(error as Error).message}`);
		process.exit(1);
	}

	const harness = await openHarness({ storagePath: join(root, "durable.db"), workspace, models });
	const webApp = WEB_APP_DIR;

	let t3;
	try {
		t3 = await attachT3(harness, {
			models,
			stateDir,
			scratchDir: join(root, "scratch"),
			listen: LISTEN,
			label: "claw",
			...(existsSync(webApp) ? { webApp } : {}),
			titleThread: titleThread(harness, models),
			log,
		});
	} catch (error) {
		console.error(`failed to listen on http://${LISTEN.host}:${LISTEN.port}: ${(error as NodeJS.ErrnoException).code ?? "unknown"} (${(error as Error).message ?? ""})`);
		await harness.close(BACKGROUND_CONTEXT);
		process.exit(1);
	}

	// Crash resume: the caller resumes AFTER the attach resolved (the bridge's contract). An interrupted codemode call
	// replays its journal: completed nested calls do not run twice.
	harness.resume();
	// A facet that stops serving on its own cannot answer a paired client again: fatal, per the example's policy.
	void t3.closed.then(() => process.exit(1));

	log.info("pi-durable-claw host ready", {
		address: `http://${LISTEN.host}:${LISTEN.port}`,
		root,
		stateDir,
		workspace: `${workspaceConfig.host}:${workspaceConfig.port} (${workspace.remote.platform}/${workspace.remote.arch})`,
		models: (await models.getAvailable()).map((m) => `${m.provider}/${m.id}`),
		webApp: existsSync(webApp) ? webApp : "none (the T3 repo has no web-dist; run its pnpm setup:t3)",
	});
	console.log("\n  Pair a device: docker compose exec harness claw pair\n");

	installShutdown(async () => {
		await t3.close();
		await harness.close(BACKGROUND_CONTEXT);
	});
}

try {
	await main();
} catch (error) {
	console.error(`pi-durable-claw host failed: ${(error as Error).stack ?? error}`);
	process.exit(1);
}
