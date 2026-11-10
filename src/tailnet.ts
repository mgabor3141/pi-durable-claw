/**
 * Remote access built in, as gmux does it: `claw-tailnet` (Go, `tailnet/`) joins your tailnet as its own device with
 * embedded Tailscale and serves claw there: HTTPS on 443 to this host's T3 app, and SSH on 22 into the workspace,
 * keyless, so T3's "Open in VS Code", file links and the file preview work from any of your devices. Only the node's
 * owner (the account that logged it in) and `CLAW_TAILNET_ALLOW` get through.
 *
 * `claw remote` turns it on (`<root>/remote.json`) and prints the login link; the running host notices, starts the
 * program, restarts it if it exits, and stops it when turned off. Its status, `<root>/tailscale/status.json` (the CLI
 * reads the same file), is what the bridge advertises to T3 (`remoteAccess`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { RemoteAccess, RemoteAccessState } from "@mgabor3141/pi-durable-t3";

/** What `claw-tailnet` reports (its `status.go`). */
export interface TailnetStatus {
	readonly state: "starting" | "needs-login" | "needs-approval" | "running" | "stopped";
	readonly authUrl?: string;
	readonly dnsName?: string;
	readonly magicDns: boolean;
	readonly https: boolean;
	readonly owner?: string;
	readonly allow?: readonly string[];
	readonly problems?: readonly string[];
}

export interface TailnetOptions {
	/** The harness's root: `remote.json` and `tailscale/` live here. */
	readonly root: string;
	/** The device name on the tailnet. */
	readonly hostname: string;
	/** Logins or tags allowed besides the owner. */
	readonly allow: readonly string[];
	/** This host's port, for the HTTPS side. */
	readonly port: number;
	/** The harness's HTTP address, when it does not listen on loopback (default `http://127.0.0.1:<port>`). */
	readonly upstream?: string;
	readonly workspace: { readonly host: string; readonly port: number; readonly user: string; readonly sshDir: string; readonly hostKeyAlias: string };
	/** The program and leading arguments; default `claw-tailnet` on PATH. */
	readonly command?: readonly string[];
	readonly log: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
	/** How often `remote.json` is checked, in ms (default 2000). */
	readonly pollMs?: number;
}

const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const STOP_GRACE_MS = 5_000;

export const remoteFile = (root: string) => join(root, "remote.json");
export const statusFile = (root: string) => join(root, "tailscale", "status.json");

/** Whether remote access is on (`claw remote` writes it). A malformed file fails loudly. */
export function readRemoteEnabled(root: string): boolean {
	const file = remoteFile(root);
	if (!existsSync(file)) return false;
	const parsed = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown };
	if (typeof parsed.enabled !== "boolean") throw new Error(`${file}: "enabled" must be true or false`);
	return parsed.enabled;
}

export function writeRemoteEnabled(root: string, enabled: boolean): void {
	const file = remoteFile(root);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, `${JSON.stringify({ enabled }, null, 2)}\n`);
	renameSync(`${file}.tmp`, file);
}

/** The last status the program wrote, for the CLI; `undefined` before it ever ran. */
export function readStatusFile(root: string): TailnetStatus | undefined {
	try {
		return JSON.parse(readFileSync(statusFile(root), "utf8")) as TailnetStatus;
	} catch {
		return undefined;
	}
}

/** The tailnet address to give out (pairing links, OAuth callbacks) while remote access is on and serves HTTPS; read
 * from the last report, since a device keeps its name across restarts. */
export function tailnetUrl(root: string): string | undefined {
	if (!readRemoteEnabled(root)) return undefined;
	const status = readStatusFile(root);
	return status?.https === true && status.dnsName ? `https://${status.dnsName}` : undefined;
}

/** A DNS label from the T3 label: lowercase letters, digits and dashes. */
export function deviceName(label: string): string {
	const name = label.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63);
	return name === "" ? "claw" : name;
}

/** What T3 is told: the HTTPS URL once certificates work, and the SSH host once the node runs. */
export function advertised(status: TailnetStatus | undefined, user: string): RemoteAccessState {
	if (status?.state !== "running" || status.dnsName === undefined || status.dnsName === "") return {};
	return { ...(status.https ? { httpBaseUrl: `https://${status.dnsName}` } : {}), ssh: { host: status.dnsName, username: user } };
}

export class Tailnet implements RemoteAccess {
	readonly #options: TailnetOptions;
	readonly #listeners = new Set<() => void>();
	#status: TailnetStatus | undefined;
	#child: ChildProcess | undefined;
	#enabled = false;
	#closed = false;
	#backoffMs = BACKOFF_FIRST_MS;
	#restartTimer: NodeJS.Timeout | undefined;
	/** When the running program started: an older status file is a previous run's. */
	#spawnedAt = 0;

	constructor(options: TailnetOptions) {
		this.#options = options;
	}

	/** Follow `remote.json`: start the program when it says on, stop it when it says off. */
	start(): void {
		this.#apply();
		const interval = this.#options.pollMs ?? 1_000;
		watchFile(remoteFile(this.#options.root), { interval }, () => this.#apply());
		watchFile(statusFile(this.#options.root), { interval }, (current) => this.#statusChanged(current));
	}

	current(): RemoteAccessState {
		return advertised(this.#status, this.#options.workspace.user);
	}

	status(): TailnetStatus | undefined {
		return this.#status;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => void this.#listeners.delete(listener);
	}

	async close(): Promise<void> {
		this.#closed = true;
		unwatchFile(remoteFile(this.#options.root));
		unwatchFile(statusFile(this.#options.root));
		await this.#stop();
	}

	#apply(): void {
		if (this.#closed) return;
		let enabled: boolean;
		try {
			enabled = readRemoteEnabled(this.#options.root);
		} catch (error) {
			this.#options.log.warn("remote access: remote.json is unreadable; left as it was", { error: (error as Error).message });
			return;
		}
		if (enabled === this.#enabled) return;
		this.#enabled = enabled;
		if (enabled) {
			this.#options.log.info("remote access on: starting claw-tailnet");
			this.#backoffMs = BACKOFF_FIRST_MS;
			this.#spawn();
		} else {
			this.#options.log.info("remote access off: stopping claw-tailnet");
			void this.#stop();
		}
	}

	#spawn(): void {
		const { root, hostname, allow, port, upstream, workspace, command = ["claw-tailnet"], log } = this.#options;
		const stateDir = join(root, "tailscale");
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const args = [
			...command.slice(1),
			"--state-dir", stateDir,
			"--hostname", hostname,
			"--upstream", upstream ?? `http://127.0.0.1:${port}`,
			"--workspace", `${workspace.host}:${workspace.port}`,
			"--workspace-user", workspace.user,
			"--identity", join(workspace.sshDir, "id_ed25519"),
			"--known-hosts", join(workspace.sshDir, "known_hosts"),
			"--host-key-alias", workspace.hostKeyAlias,
			...(allow.length === 0 ? [] : ["--allow", allow.join(",")]),
		];
		const startedAt = Date.now();
		this.#spawnedAt = startedAt;
		const child = spawn(command[0]!, args, { stdio: ["ignore", "pipe", "pipe"] });
		this.#child = child;
		for (const stream of [child.stdout!, child.stderr!]) createInterface({ input: stream }).on("line", (line) => log.info(`tailnet: ${line}`));
		child.once("error", (error) => log.warn("remote access: claw-tailnet did not start", { error: error.message }));
		child.once("exit", (code, signal) => {
			if (this.#child === child) this.#child = undefined;
			this.#setStatus(undefined);
			if (this.#closed || !this.#enabled) return;
			// A run that lasted resets the backoff; a program that keeps failing is retried less and less often.
			if (Date.now() - startedAt > BACKOFF_MAX_MS) this.#backoffMs = BACKOFF_FIRST_MS;
			log.warn("remote access: claw-tailnet exited; restarting", { code, signal, inMs: this.#backoffMs });
			this.#restartTimer = setTimeout(() => {
				this.#restartTimer = undefined;
				if (!this.#closed && this.#enabled && this.#child === undefined) this.#spawn();
			}, this.#backoffMs);
			this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
		});
	}

	/** A new status file: this run's report, once the program runs (the program rewrites it on every change). */
	#statusChanged(current: Stats): void {
		if (this.#child === undefined || current.mtimeMs === 0 || current.mtimeMs < this.#spawnedAt - 1_000) return;
		let status: TailnetStatus;
		try {
			status = JSON.parse(readFileSync(statusFile(this.#options.root), "utf8")) as TailnetStatus;
		} catch {
			return;
		}
		const before = this.#status;
		this.#setStatus(status);
		const { log } = this.#options;
		if (status.state === "needs-login" && status.authUrl !== undefined && status.authUrl !== before?.authUrl) {
			log.info("remote access: log this device in to your tailnet", { url: status.authUrl });
		}
		if (status.state === "running" && (before?.state !== "running" || before.dnsName !== status.dnsName)) {
			log.info("remote access: on the tailnet", { name: status.dnsName, owner: status.owner });
		}
		for (const problem of status.problems ?? []) if (!(before?.problems ?? []).includes(problem)) log.warn(`remote access: ${problem}`);
	}

	#setStatus(status: TailnetStatus | undefined): void {
		const before = JSON.stringify(this.current());
		this.#status = status;
		if (JSON.stringify(this.current()) === before) return;
		for (const listener of this.#listeners) listener();
	}

	async #stop(): Promise<void> {
		if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer);
		this.#restartTimer = undefined;
		const child = this.#child;
		this.#child = undefined;
		this.#setStatus(undefined);
		if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGTERM");
		const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
		await exited;
		clearTimeout(timer);
	}
}
