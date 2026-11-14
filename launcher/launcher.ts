// The harness image's launcher. The image holds Node, the system's tools, `claw-tailnet` and this file; it holds no
// harness. The harness is a package this launcher downloads at the first start, installs under the app dir (a volume),
// and runs from there, at every start the same way. `claw update` installs another version next to it and restarts
// into it; the version before stays, with a copy of the data as it was, so a version that does not come up is undone.
//
//   claw                    run the harness (the image's command): install it first if none is installed
//   claw update [version]   install the newest version (or the one named) and restart into it
//   claw rollback           restart into the version before
//   claw version            what is installed
//   claw <anything else>    the harness's own commands (`claw pair`, `claw remote ...`)
//
// A version is a git ref of the harness's repository: a branch, a tag or a commit. `CLAW_VERSION` names the one to
// run; unset (or `latest`) is the main branch as it was when it was installed, moved only by `claw update`.
// `file:/path` is a directory instead (a checkout mounted into the container, for development and CI), installed
// afresh at every start.
//
// What this file asks of a harness package, in every version: `package.json` with `main` (run with Node, given
// `--root`, `--listen`, `--pubkey-dir` and the command), `engines.node` when it needs a newer Node than the image's,
// and a `pnpm-lock.yaml`, so an install is the same on every day. And of the image: `tar`, and `corepack` with pnpm.
//
// It imports nothing but Node, since it runs before anything is installed.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

/** Where versions come from. */
export const REPOSITORY = "mgabor3141/pi-durable-claw";
/** The branch `latest` means. */
const LATEST_REF = "main";

export interface LauncherConfig {
	/** The app dir (a volume): the installed versions, which one runs, pnpm's store, the data's copy. */
	readonly app: string;
	/** The harness's data dir, passed to it as `--root`. */
	readonly root: string;
	readonly listen: string;
	readonly pubkeyDir?: string;
	/** `CLAW_VERSION`: the version to run. Empty or `latest`: whatever is installed, the newest at the first start. */
	readonly pin: string;
	/** The harness's port, where it answers once it serves. */
	readonly port: number;
	readonly log: (line: string) => void;
	/** Fetch a ref's archive into `file`. Default: the repository's archive on GitHub. */
	readonly download?: (ref: string, file: string) => Promise<void>;
	/** Where a stop (SIGTERM, SIGINT) and a restart (SIGHUP) come from. Default: the process. */
	readonly signals?: { on(signal: string, listener: () => void): unknown; off(signal: string, listener: () => void): unknown };
	/** Install a version's dependencies in `dir`. Default: pnpm with the version's lockfile, development tools removed. */
	readonly installDependencies?: (dir: string, config: LauncherConfig) => Promise<void>;
}

interface State {
	/** The version that runs. */
	current: string | null;
	/** The one before it, kept to go back to. */
	previous: string | null;
	/** Installed and waiting for the restart that switches to it. */
	pending: string | null;
	/** The current version has not served yet: if it exits first, the launcher goes back. */
	unproven: boolean;
}

export interface VersionInfo {
	readonly id: string;
	/** What was asked for: `latest`, a ref, or `file:/path`. */
	readonly spec: string;
	readonly commit?: string;
	readonly installedAt: string;
}

class LauncherError extends Error {}

const statePath = (app: string) => join(app, "state.json");
const versionDir = (app: string, id: string) => join(app, "versions", id);
const backupDir = (app: string) => join(app, "data-before-update");
const pidPath = (app: string) => join(app, "launcher.pid");

export function readState(app: string): State {
	if (!existsSync(statePath(app))) return { current: null, previous: null, pending: null, unproven: false };
	return JSON.parse(readFileSync(statePath(app), "utf8")) as State;
}

function writeState(app: string, state: State): void {
	mkdirSync(app, { recursive: true });
	writeFileSync(`${statePath(app)}.tmp`, `${JSON.stringify(state, null, "\t")}\n`);
	renameSync(`${statePath(app)}.tmp`, statePath(app));
}

export function versionInfo(app: string, id: string | null): VersionInfo | undefined {
	if (id === null) return undefined;
	const file = join(versionDir(app, id), "version.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as VersionInfo) : undefined;
}

/** `latest` for nothing asked. */
const specOf = (raw: string | undefined): string => raw?.trim() || "latest";
const isLocal = (spec: string) => spec.startsWith("file:");

/**
 * The commit a `git archive` was made from: GitHub's archives are git's, which name it in a comment before the first
 * file (a pax global header). A branch's archive says which commit the branch was at.
 */
export function archiveCommit(gzipped: Buffer): string | undefined {
	const tar = gunzipSync(gzipped);
	if (tar.length < 1024 || tar[156] !== 0x67 /* g: a pax global header */) return undefined;
	return /comment=([0-9a-f]{40})\n/.exec(tar.subarray(512, 1024).toString("latin1"))?.[1];
}

async function downloadFromGitHub(ref: string, file: string): Promise<void> {
	const url = `https://codeload.github.com/${REPOSITORY}/tar.gz/${encodeURIComponent(ref).replaceAll("%2F", "/")}`;
	const response = await fetch(url);
	if (response.status === 404) throw new LauncherError(`no version ${ref}: ${REPOSITORY} has no such branch, tag or commit`);
	if (!response.ok) throw new LauncherError(`could not download version ${ref}: ${url} answered ${response.status}`);
	writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** The install step under way, so a stop can end it. */
let installing: ChildProcess | undefined;

/** Not `spawnSync`: an install takes minutes, and the launcher must hear a stop meanwhile. */
async function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
	const child = spawn(command, args, { stdio: "inherit", ...options });
	installing = child;
	try {
		const ended = await new Promise<string | undefined>((done) => {
			child.on("error", (error) => done(`could not run: ${error.message}`));
			child.on("exit", (status, signal) => done(status === 0 ? undefined : `failed (${signal ?? `exit ${status}`})`));
		});
		if (ended !== undefined) throw new LauncherError(`${command} ${args.join(" ")} ${ended}`);
	} finally {
		installing = undefined;
	}
}

/**
 * The version's own lockfile decides every dependency. The store is in the app dir, so versions share what they have in
 * common. A dependency that builds when it is installed (the T3 bridge, from git) needs the development tools, so they
 * are installed and then removed.
 */
async function installWithPnpm(dir: string, config: LauncherConfig): Promise<void> {
	// HOME is the user's own, whatever the process was started with (the image starts as root and drops to node): pnpm
	// and git keep their files there.
	// The store is named in the environment, which every pnpm command reads: `prune` has no option for it, and with
	// another store it would build the bridge again, without the tools.
	const env = { ...process.env, HOME: userInfo().homedir, CI: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", npm_config_store_dir: join(config.app, "store") };
	await run("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: dir, env });
	await run("corepack", ["pnpm", "prune", "--prod"], { cwd: dir, env });
	// What no installed version uses any more (the development tools, a removed version's packages) leaves the store.
	await run("corepack", ["pnpm", "store", "prune"], { cwd: dir, env }).catch((error: unknown) =>
		config.log(`could not tidy pnpm's store (the install is fine): ${error instanceof Error ? error.message : String(error)}`),
	);
}

/** Whether this Node is one the version runs on: `engines.node` as `>=a.b.c`, the form the harness uses. */
export function nodeIsEnough(required: string | undefined, running: string): boolean {
	const wanted = /^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(required ?? "");
	const have = /^v?(\d+)\.(\d+)\.(\d+)/.exec(running);
	if (wanted === null || have === null) return true;
	for (let part = 1; part <= 3; part++) {
		if (Number(have[part]) !== Number(wanted[part])) return Number(have[part]) > Number(wanted[part]);
	}
	return true;
}

/** One install at a time: a second one would write the same directories. */
function withLock<T>(app: string, work: () => Promise<T>): Promise<T> {
	const lock = join(app, "install.lock");
	mkdirSync(app, { recursive: true });
	const holder = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : undefined;
	if (holder !== undefined && holder !== process.pid && alive(holder)) throw new LauncherError("another install is running: wait for it (docker compose logs -f harness)");
	writeFileSync(lock, String(process.pid));
	return work().finally(() => rmSync(lock, { force: true }));
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Install the version `spec` names, unless that very commit is installed already, and return it. The work happens in
 * a directory of its own that is renamed into place at the end, so a version either is there whole or is not there.
 */
export async function install(config: LauncherConfig, spec: string): Promise<VersionInfo> {
	return withLock(config.app, async () => {
		const versions = join(config.app, "versions");
		mkdirSync(versions, { recursive: true });
		// What an install that was cut off left behind.
		for (const name of readdirSync(versions)) if (name.endsWith(".tmp")) rmSync(join(versions, name), { recursive: true, force: true });
		const work = join(versions, `${process.pid}.tmp`);
		const archive = join(versions, `${process.pid}.tar.gz.tmp`);
		mkdirSync(work);
		try {
			let id: string;
			let commit: string | undefined;
			if (isLocal(spec)) {
				const source = resolve(spec.slice("file:".length));
				if (!existsSync(join(source, "package.json"))) throw new LauncherError(`${spec}: no package.json there`);
				id = `local-${Date.now()}`;
				config.log(`installing the harness from ${source}`);
				const skipped = new Set(["node_modules", ".git", "data", ".env"]);
				cpSync(source, work, { recursive: true, filter: (from) => from === source || !skipped.has(from.slice(source.length + 1)) });
			} else {
				const ref = spec === "latest" ? LATEST_REF : spec;
				config.log(`downloading the harness, version ${spec}`);
				await (config.download ?? downloadFromGitHub)(ref, archive);
				commit = archiveCommit(readFileSync(archive));
				if (commit === undefined) throw new LauncherError(`version ${spec}: the archive does not say which commit it is`);
				id = commit.slice(0, 12);
				const have = versionInfo(config.app, id);
				if (have !== undefined) return have;
				await run("tar", ["-xzf", archive, "--strip-components=1", "-C", work]);
			}
			const manifest = JSON.parse(readFileSync(join(work, "package.json"), "utf8")) as { main?: string; engines?: { node?: string } };
			if (manifest.main === undefined) throw new LauncherError(`version ${spec} is from before the harness was a package the image installs: its package.json names no main`);
			if (!nodeIsEnough(manifest.engines?.node, process.version)) {
				throw new LauncherError(`version ${spec} needs Node ${manifest.engines!.node}, and this image has ${process.version}: update the image first (git pull && docker compose up -d --build)`);
			}
			config.log(`installing version ${id} (its dependencies; the first time takes a few minutes)`);
			await (config.installDependencies ?? installWithPnpm)(work, config);
			const info: VersionInfo = { id, spec, ...(commit === undefined ? {} : { commit }), installedAt: new Date().toISOString() };
			writeFileSync(join(work, "version.json"), `${JSON.stringify(info, null, "\t")}\n`);
			renameSync(work, versionDir(config.app, id));
			config.log(`version ${id} is installed`);
			return info;
		} finally {
			rmSync(work, { recursive: true, force: true });
			rmSync(archive, { force: true });
		}
	});
}

/** Sockets and pipes (a running process's) are not data and cannot be copied. */
const copyable = (path: string) => {
	const stat = lstatSync(path);
	return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
};

/** The data as it is now, kept beside the versions: what the version before can still read. One copy, the last. */
function backUpData(config: LauncherConfig): void {
	if (!existsSync(config.root)) return;
	const started = Date.now();
	const target = backupDir(config.app);
	rmSync(`${target}.tmp`, { recursive: true, force: true });
	cpSync(config.root, `${target}.tmp`, { recursive: true, preserveTimestamps: true, filter: copyable });
	rmSync(target, { recursive: true, force: true });
	renameSync(`${target}.tmp`, target);
	config.log(`kept a copy of the data as it was (${Math.round((Date.now() - started) / 100) / 10} s): ${target}`);
}

/** Put the copy back: every file and folder it holds replaces the one in the data dir. */
function restoreData(config: LauncherConfig): void {
	const source = backupDir(config.app);
	if (!existsSync(source)) return;
	for (const name of readdirSync(source)) {
		rmSync(join(config.root, name), { recursive: true, force: true });
		cpSync(join(source, name), join(config.root, name), { recursive: true, preserveTimestamps: true });
	}
	config.log("put the data back as it was before the update");
}

/** Only the version that runs and the one before it are kept. */
function removeOtherVersions(app: string, state: State): void {
	const keep = new Set([state.current, state.previous, state.pending]);
	// Not an install under way (`*.tmp`): the next install removes what one left behind.
	for (const name of readdirSync(join(app, "versions"))) if (!keep.has(name) && !name.endsWith(".tmp")) rmSync(join(app, "versions", name), { recursive: true, force: true });
}

/**
 * Before the harness starts: install one if there is none, install the pinned one if another runs, and switch to a
 * version that waits. The harness is down here, so the data can be copied whole. `refused` is a spec that did not
 * come up in this launcher's life: it is not tried again until the container restarts.
 */
async function prepare(config: LauncherConfig, refused: string | undefined): Promise<State> {
	let state = readState(config.app);
	const wanted = specOf(config.pin);
	const running = versionInfo(config.app, state.current);
	if (running === undefined) {
		const installed = await install(config, wanted);
		state = { current: installed.id, previous: null, pending: null, unproven: false };
		writeState(config.app, state);
		return state;
	}
	const pinMoved = isLocal(wanted) || (wanted !== "latest" && running.spec !== wanted);
	if (state.pending === null && pinMoved && wanted === refused) {
		config.log(`CLAW_VERSION=${wanted} did not come up, so version ${running.id} runs instead. It is tried again when the container restarts`);
	} else if (state.pending === null && pinMoved) {
		const installed = await install(config, wanted);
		if (installed.id !== state.current) state.pending = installed.id;
	}
	if (state.pending !== null && versionInfo(config.app, state.pending) !== undefined) {
		backUpData(config);
		state = { current: state.pending, previous: state.current, pending: null, unproven: true };
		config.log(`switching to version ${state.current} (was ${state.previous})`);
	} else {
		state.pending = null;
	}
	writeState(config.app, state);
	removeOtherVersions(config.app, state);
	return state;
}

function harnessCommand(config: LauncherConfig, id: string, args: readonly string[]): string[] {
	const dir = versionDir(config.app, id);
	const main = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { main: string }).main;
	return [join(dir, main), "--root", config.root, "--listen", config.listen, ...(config.pubkeyDir === undefined ? [] : ["--pubkey-dir", config.pubkeyDir]), ...args];
}

async function serves(port: number): Promise<boolean> {
	try {
		return (await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2_000) })).ok;
	} catch {
		return false;
	}
}

/**
 * Run the harness and stay beside it: forward a stop, restart it into a version `claw update` installed (SIGHUP), and
 * go back when a version it just switched to exits before it has served once. Resolves with the exit code once the
 * harness has ended for good; the container's restart policy takes it from there, as before.
 */
export async function supervise(config: LauncherConfig): Promise<number> {
	mkdirSync(config.app, { recursive: true });
	writeFileSync(pidPath(config.app), String(process.pid));
	// This is the container's first process: an install lock here is one a killed container left.
	rmSync(join(config.app, "install.lock"), { force: true });
	let refused: string | undefined;
	let child: ChildProcess | undefined;
	let stopping = false;
	let restarting = false;
	const stop = () => {
		stopping = true;
		if (child !== undefined) return void child.kill("SIGTERM");
		// No harness yet: an install is all there is to end.
		installing?.kill("SIGTERM");
		process.exit(143);
	};
	// Remembered when no harness runs yet, so a version installed during a restart is not left waiting.
	const restart = () => {
		restarting = true;
		child?.kill("SIGTERM");
	};
	const signals = config.signals ?? process;
	signals.on("SIGTERM", stop);
	signals.on("SIGINT", stop);
	signals.on("SIGHUP", restart);
	try {
		for (;;) {
			restarting = false;
			const state = await prepare(config, refused);
			const id = state.current!;
			config.log(`starting the harness, version ${id}`);
			const harness = spawn(process.execPath, harnessCommand(config, id, []), { stdio: "inherit" });
			child = harness;
			if (restarting || stopping) harness.kill("SIGTERM");
			// A version is proven once it serves; until then its exit means it does not work here.
			let proven = !state.unproven;
			const watch = state.unproven
				? setInterval(() => {
						void serves(config.port).then((up) => {
							if (!up || proven || readState(config.app).current !== id) return;
							proven = true;
							clearInterval(watch);
							writeState(config.app, { ...readState(config.app), unproven: false });
							config.log(`version ${id} serves`);
						});
					}, 1_000)
				: undefined;
			const code = await new Promise<number>((done) => harness.on("exit", (status, signal) => done(status ?? (signal === null ? 1 : 128))));
			child = undefined;
			clearInterval(watch);
			if (stopping) return code;
			if (restarting) continue;
			const after = readState(config.app);
			if (after.current === id && after.unproven && after.previous !== null && versionInfo(config.app, after.previous) !== undefined) {
				config.log(`version ${id} exited (${code}) before it served: going back to version ${after.previous}`);
				restoreData(config);
				refused = versionInfo(config.app, id)?.spec;
				writeState(config.app, { current: after.previous, previous: null, pending: null, unproven: false });
				continue;
			}
			return code;
		}
	} finally {
		signals.off("SIGTERM", stop);
		signals.off("SIGINT", stop);
		signals.off("SIGHUP", restart);
		rmSync(pidPath(config.app), { force: true });
	}
}

/** Tell the launcher that runs the harness to restart it; false when none runs. */
function signalLauncher(app: string): boolean {
	if (!existsSync(pidPath(app))) return false;
	const pid = Number(readFileSync(pidPath(app), "utf8"));
	if (!Number.isInteger(pid) || pid === process.pid || !alive(pid)) return false;
	process.kill(pid, "SIGHUP");
	return true;
}

export async function update(config: LauncherConfig, asked: string | undefined): Promise<string> {
	const pinned = specOf(config.pin);
	const spec = specOf(asked ?? config.pin);
	if (pinned !== "latest" && spec !== pinned) {
		throw new LauncherError(`CLAW_VERSION is ${pinned}, and the harness returns to it at every start: change it in .env (or remove it) instead, then docker compose up -d`);
	}
	const state = readState(config.app);
	const installed = await install(config, spec);
	if (installed.id === state.current) return `already at version ${installed.id}${installed.commit === undefined ? "" : ` (${spec})`}: nothing to do`;
	writeState(config.app, { ...readState(config.app), pending: installed.id });
	return signalLauncher(config.app) ? `version ${installed.id} is installed: the harness is restarting into it` : `version ${installed.id} is installed: the harness runs it from its next start`;
}

export function rollback(config: LauncherConfig): string {
	const state = readState(config.app);
	if (specOf(config.pin) !== "latest") throw new LauncherError(`CLAW_VERSION is ${specOf(config.pin)}, and the harness returns to it at every start: change it in .env instead`);
	if (state.previous === null || versionInfo(config.app, state.previous) === undefined) throw new LauncherError("there is no version before this one to go back to");
	writeState(config.app, { ...state, pending: state.previous });
	const note = `The data stays as it is now; a copy from before the last update is in ${backupDir(config.app)}.`;
	return signalLauncher(config.app) ? `the harness is restarting into version ${state.previous}. ${note}` : `the harness runs version ${state.previous} from its next start. ${note}`;
}

export function describe(config: LauncherConfig): string {
	const state = readState(config.app);
	const line = (label: string, id: string | null) => {
		const info = versionInfo(config.app, id);
		return info === undefined ? [] : [`${label}: ${info.id} (${info.spec}${info.commit === undefined ? "" : `, commit ${info.commit}`}), installed ${info.installedAt}`];
	};
	const lines = [...line("running", state.current), ...line("before it", state.previous), ...line("waiting for a restart", state.pending)];
	if (lines.length === 0) return "no version is installed yet";
	return [...lines, `CLAW_VERSION: ${specOf(config.pin)}`].join("\n");
}

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		options: { app: { type: "string" }, root: { type: "string" }, listen: { type: "string" }, "pubkey-dir": { type: "string" } },
		allowPositionals: true,
		strict: true,
	});
	if (values.app === undefined || values.root === undefined) throw new LauncherError("usage: launcher.ts --app <dir> --root <dir> [--listen <host>] [--pubkey-dir <dir>] [--] [command]");
	const config: LauncherConfig = {
		app: values.app,
		root: values.root,
		listen: values.listen ?? "127.0.0.1",
		...(values["pubkey-dir"] === undefined ? {} : { pubkeyDir: values["pubkey-dir"] }),
		pin: process.env.CLAW_VERSION ?? "",
		port: Number(process.env.CLAW_PORT?.trim() || 3775),
		log: (line) => console.log(`claw: ${line}`),
	};
	const [command, argument] = positionals;
	if (command === undefined) return supervise(config);
	if (command === "update") return console.log(await update(config, argument)), 0;
	if (command === "rollback") return console.log(rollback(config)), 0;
	if (command === "version") return console.log(describe(config)), 0;
	// The harness's own commands, in the version that runs.
	const state = readState(config.app);
	if (versionInfo(config.app, state.current) === undefined) throw new LauncherError("the harness is not installed yet: its first start installs it (docker compose logs -f harness)");
	const result = spawnSync(process.execPath, harnessCommand(config, state.current!, positionals), { stdio: "inherit" });
	return result.status ?? 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
	main().then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(error instanceof LauncherError ? `claw: ${error.message}` : error);
			process.exit(1);
		},
	);
}
