/**
 * Other machines, reached by the harness. The agent names a machine (`machine_add`) and installs the harness's public
 * key for it there itself; the harness keeps the private key (never in the workspace), trusts the machine's host key
 * once the user approved it, and holds the connection: pi-env's daemon over SSH, as the workspace is reached, so
 * `bash`, `read`, `write` and `edit` given `machine` run there as they run in the workspace.
 *
 * A connection needs the user's approval, asked on T3's approval card in the thread whose call needs it: for a while
 * (`CLAW_MACHINE_APPROVAL_HOURS`), for that thread (and the child threads and side chats under it), or always. It is
 * asked before the call runs, by a gate (`machineGate`): the call parks until the user answers, holding no process,
 * with no time limit and across a restart. `/machines` lists the machines and their access, grants and revokes it. A
 * revoke ends the connection, and with it what runs there. The user approves an address and the host key it shows:
 * until that key is trusted, the card asks even with a grant, and a machine given another address loses its grants.
 *
 * Kept in `<root>/machines/`: `machines.json` (the machines and their grants, read at each use, so an edit by hand
 * counts), a keypair per machine, and `known_hosts`, each host key under the machine's own alias. A machine is added
 * with `machine_add`, which makes its keypair; one added to the file by hand has none.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension, hook, type HookApi, type ToolHookCall, type ToolRegistration, ToolTask } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { acceptHostKey, connectSsh, forgetHostKey, HostKeyChangedError, HostKeyUnknownError, RemoteExecutionEnv, scanHostKey, type Connection, type SshTarget } from "@earendil-works/pi-env";
import type { HostCommand, T3Attachment } from "@mgabor3141/pi-durable-t3";
import { int, opt, str } from "@earendil-works/pi-schema";
import { type Env, setting } from "./env.ts";
import { object } from "./schema.ts";

/** A machine as `machines.json` keeps it. */
export interface MachineConfig {
	readonly host: string;
	readonly user?: string;
	readonly port?: number;
	/** Where a call without an absolute path works; default the user's home there. */
	readonly cwd?: string;
}

/** Access the user granted: until a time, in a thread (and the threads under it), or always. */
export type MachineGrant =
	| { readonly machine: string; readonly scope: "until"; readonly until: number }
	| { readonly machine: string; readonly scope: "thread"; readonly threadId: string }
	| { readonly machine: string; readonly scope: "always" };

interface MachinesFile {
	readonly machines: Readonly<Record<string, MachineConfig>>;
	readonly grants: readonly MachineGrant[];
}

/** What of the bridge machines need: whose a conversation is, and the approval card. */
export type MachinesBridge = Pick<T3Attachment, "threadOf" | "threadOrigin" | "requestApproval">;

export interface MachinesOptions {
	/** `<root>/machines`. */
	readonly dir: string;
	/** How long "Allow for …" lasts. */
	readonly approvalMs: number;
	/** The bridge, resolved once attached. A gate that runs before (one woken at startup, while the bridge attaches)
	 * waits for it rather than losing its card. */
	readonly bridge: Promise<MachinesBridge>;
	readonly now?: () => number;
	readonly log?: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMPTY: MachinesFile = { machines: {}, grants: [] };
/** What the card's answer is until the user gave one: the sleep a gate returns to park its call. */
type Park = Extract<Awaited<ReturnType<MachinesBridge["requestApproval"]>>, { readonly sleep: unknown }>;

/** What a machine's host key was when a card first showed it: the lines to trust, and their fingerprints. */
type HostKey = { readonly lines: string[]; readonly fingerprints: string[] };

/** An error that tells the agent what went wrong with a machine, and what to do about it. */
class MachineError extends Error {}

/** The alias a machine's host key is kept under in `known_hosts`, and its key's comment. */
const alias = (name: string): string => `claw-machine-${name}`;

/** `user@host:port`, leaving out what is not set. */
const address = (machine: MachineConfig): string => `${machine.user === undefined ? "" : `${machine.user}@`}${machine.host}${machine.port === undefined ? "" : `:${machine.port}`}`;

export class Machines {
	readonly #options: MachinesOptions;
	/** Open connections, by machine; each with the address it was opened for, so a machine given another address connects
	 * again. */
	readonly #open = new Map<string, { readonly key: string; readonly connection: Promise<{ connection: Connection; home: string }> }>();
	/** The bridge once attached, for what reads it at once (`/machines`, `machines_list`, a call's environment). */
	#bridge: MachinesBridge | undefined;

	constructor(options: MachinesOptions) {
		this.#options = options;
		void options.bridge.then((bridge) => (this.#bridge = bridge));
		mkdirSync(options.dir, { recursive: true, mode: 0o700 });
	}

	get #file(): string {
		return join(this.#options.dir, "machines.json");
	}

	#now(): number {
		return this.#options.now?.() ?? Date.now();
	}

	/** `machines.json` as it is now. A file that does not parse fails loudly: it is the user's too. */
	read(): MachinesFile {
		if (!existsSync(this.#file)) return EMPTY;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#file, "utf8"));
		} catch (error) {
			throw new Error(`${this.#file} is not valid JSON: ${(error as Error).message}`);
		}
		const file = parsed as Partial<MachinesFile> | null;
		if (typeof file !== "object" || file === null || typeof file.machines !== "object" || file.machines === null || !Array.isArray(file.grants)) {
			throw new Error(`${this.#file} must be { "machines": { … }, "grants": [ … ] }`);
		}
		for (const [name, machine] of Object.entries(file.machines)) {
			if (!NAME.test(name) || typeof machine?.host !== "string" || machine.host === "") throw new Error(`${this.#file}: machine ${JSON.stringify(name)} needs a name of lowercase letters, digits and dashes, and a host`);
		}
		return { machines: file.machines, grants: file.grants };
	}

	#write(file: MachinesFile): void {
		const temporary = `${this.#file}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temporary, this.#file);
	}

	#machine(name: string): MachineConfig {
		const machines = this.read().machines;
		const machine = machines[name];
		if (machine === undefined) {
			const names = Object.keys(machines);
			throw new MachineError(`No machine named ${JSON.stringify(name)}. ${names.length === 0 ? "There are none yet: add one with machine_add." : `There are: ${names.join(", ")}.`}`);
		}
		return machine;
	}

	#keyFile(name: string): string {
		return join(this.#options.dir, name, "id_ed25519");
	}

	/** The target pi-env connects to: the machine's own key, and its host key under its own alias. */
	#target(name: string, machine: MachineConfig): SshTarget {
		return {
			host: machine.host,
			...(machine.user === undefined ? {} : { user: machine.user }),
			...(machine.port === undefined ? {} : { port: machine.port }),
			identityFile: this.#keyFile(name),
			knownHostsFile: join(this.#options.dir, "known_hosts"),
			hostKeyAlias: alias(name),
		};
	}

	/** The `known_hosts` lines trusted for a machine: none until the user allowed it on a card, or after its host or port
	 * changed. */
	#knownHostLines(name: string): string[] {
		const known = join(this.#options.dir, "known_hosts");
		return existsSync(known) ? readFileSync(known, "utf8").split("\n").filter((line) => line.startsWith(`${alias(name)} `)) : [];
	}

	/** The line to put in the machine's `~/.ssh/authorized_keys`: the harness's key for it, with no forwarding of any kind. */
	authorizedKey(name: string): string {
		return `restrict ${readFileSync(`${this.#keyFile(name)}.pub`, "utf8").trim()}`;
	}

	/** Add a machine, or change one: its key is made the first time. A changed address (host, user or port) drops the
	 * grants it had, since the user allowed that address, not the name, and ends its connection; a changed host or port
	 * also forgets the host key. Only `cwd` changed keeps both: it plays no part in the connection. */
	async add(name: string, machine: MachineConfig): Promise<{ readonly authorizedKey: string; readonly changed: boolean }> {
		if (!NAME.test(name)) throw new MachineError(`A machine's name is lowercase letters, digits and dashes (up to 63), not ${JSON.stringify(name)}.`);
		if (machine.host.trim() === "" || /\s/.test(machine.host) || machine.host.startsWith("-")) throw new MachineError(`${JSON.stringify(machine.host)} is not a host name or address.`);
		const file = this.read();
		const before = file.machines[name];
		const key = this.#keyFile(name);
		if (!existsSync(key)) {
			mkdirSync(join(this.#options.dir, name), { recursive: true, mode: 0o700 });
			execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", alias(name), "-f", key]);
		}
		const next: MachineConfig = {
			host: machine.host,
			...(machine.user === undefined ? {} : { user: machine.user }),
			...(machine.port === undefined ? {} : { port: machine.port }),
			...(machine.cwd === undefined ? {} : { cwd: machine.cwd }),
		};
		const changed = before !== undefined && JSON.stringify(before) !== JSON.stringify(next);
		const moved = before !== undefined && address(before) !== address(next);
		this.#write({ machines: { ...file.machines, [name]: next }, grants: moved ? file.grants.filter((grant) => grant.machine !== name) : file.grants });
		if (moved && (before.host !== next.host || before.port !== next.port)) await forgetHostKey(this.#target(name, before)).catch(() => {});
		if (moved) this.#close(name);
		return { authorizedKey: this.authorizedKey(name), changed };
	}

	/** Remove a machine: its key, its host key, its grants, and its connection. */
	async remove(name: string): Promise<void> {
		const machine = this.#machine(name);
		this.#close(name);
		await forgetHostKey(this.#target(name, machine)).catch(() => {});
		const file = this.read();
		const { [name]: _removed, ...machines } = file.machines;
		this.#write({ machines, grants: file.grants.filter((grant) => grant.machine !== name) });
		rmSync(join(this.#options.dir, name), { recursive: true, force: true });
	}

	/** Grant access without a card (`/machines allow`). */
	grant(grant: MachineGrant): void {
		this.#machine(grant.machine);
		const file = this.read();
		this.#write({ ...file, grants: [...this.#live(file.grants).filter((each) => !sameScope(each, grant)), grant] });
	}

	/** Take back every grant of a machine, and end its connection. */
	revoke(name: string): number {
		this.#machine(name);
		const file = this.read();
		const kept = file.grants.filter((grant) => grant.machine !== name);
		this.#write({ ...file, grants: kept });
		this.#close(name);
		return file.grants.length - kept.length;
	}

	/** Grants still in force (an expired one is dropped when the file is next written). */
	#live(grants: readonly MachineGrant[]): MachineGrant[] {
		const now = this.#now();
		return grants.filter((grant) => grant.scope !== "until" || grant.until > now);
	}

	/** The grant that lets `threadId` (or no thread) use `name` now: always, until a time, or the thread's own or that of
	 * a thread above it whose child or side chat it is. */
	allowed(name: string, threadId: string | undefined): MachineGrant | undefined {
		const grants = this.#live(this.read().grants).filter((grant) => grant.machine === name);
		const standing = grants.find((grant) => grant.scope === "always") ?? grants.filter((grant) => grant.scope === "until").sort((a, b) => b.until - a.until)[0];
		if (standing !== undefined || threadId === undefined) return standing;
		const bridge = this.#bridge;
		const seen = new Set<string>();
		for (let current: string | undefined = threadId; current !== undefined && !seen.has(current); ) {
			seen.add(current);
			const here = current;
			const grant = grants.find((each) => each.scope === "thread" && each.threadId === here);
			if (grant !== undefined) return grant;
			const origin: ReturnType<MachinesBridge["threadOrigin"]> = bridge?.threadOrigin(current);
			current = origin !== undefined && origin.parentThreadId !== null && (origin.relationshipToParent === "subagent" || origin.sideChat) ? origin.parentThreadId : undefined;
		}
		return undefined;
	}

	/** The thread a conversation is the head of. */
	threadOf(conversationId: number): string | undefined {
		return this.#bridge?.threadOf(conversationId as never)?.threadId;
	}

	/** May `threadId` connect to `name` now: a grant, and a host key the user saw on the card? */
	#approved(name: string, threadId: string | undefined): boolean {
		return this.allowed(name, threadId) !== undefined && this.#knownHostLines(name).length > 0;
	}

	/** The machine as the call's environment, connected. The call's gate (`gate`) allowed it; access taken back or run
	 * out since is refused. */
	async env(name: string, conversationId: number): Promise<RemoteExecutionEnv> {
		const machine = this.#machine(name);
		if (!this.#approved(name, this.threadOf(conversationId))) throw new MachineError(`Using ${name} is not allowed here now: its access was taken back or ran out. Call again to ask the user.`);
		const { connection, home } = await this.#connection(name, machine);
		return new RemoteExecutionEnv({ connection, id: `pi-env:${alias(name)}`, cwd: machine.cwd ?? home });
	}

	/**
	 * The gate before a call that uses machines (`uses`: each, and what the call does there, for the card). It passes once
	 * each is allowed in the call's thread and its host key is trusted. Otherwise it asks on T3's card and returns the
	 * sleep that parks the call until the user answers; on an allow it trusts the host key the card showed and grants
	 * what the user chose, on a deny it blocks the call with what they said. It runs again on every wake (and after a
	 * restart), so it decides from the grants and the card's answer, and each step is done once: the host key is read
	 * once per call (a memo), trusted only while none is, and a grant replaces its like.
	 */
	async gate(uses: readonly { readonly machine: string; readonly doing: string }[], api: HookApi, context: Context): Promise<{ readonly block: string } | Park | undefined> {
		// A gate woken at startup waits for the bridge; Stop and the harness's close end the wait (a host whose attach failed
		// closes before it exits, and must not hang on it).
		const signal = context.abortSignal;
		const bridge = await Promise.race([
			this.#options.bridge,
			new Promise<never>((_, reject) => {
				if (signal?.aborted === true) reject(signal.reason);
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
		]);
		const threadId = bridge.threadOf(api.conversationId)?.threadId;
		for (const { machine: name, doing } of uses) {
			let machine: MachineConfig;
			try {
				machine = this.#machine(name);
			} catch (error) {
				if (error instanceof MachineError) return { block: error.message };
				throw error;
			}
			if (this.#approved(name, threadId)) continue;
			if (threadId === undefined) {
				return {
					block:
						this.allowed(name, threadId) === undefined
							? `Using ${name} needs the user's approval, which only a thread can ask for: ask the user to allow it with /machines allow ${name}.`
							: `${name}'s host key is not trusted yet, and only a thread's approval card can show it to the user: connect to it from a thread first.`,
				};
			}
			const target = this.#target(name, machine);
			// The key the card shows, read once: allowing trusts the key the user saw.
			let scanned = await api.memo<HostKey>(`machines.hostKey.${name}`, context);
			if (scanned === undefined && this.#knownHostLines(name).length === 0) {
				try {
					scanned = await api.memo<HostKey>(`machines.hostKey.${name}`, await scanHostKey(target), context);
				} catch (error) {
					return { block: `Cannot reach ${name} (${target.host}): ${(error as Error).message.trim()}` };
				}
			}
			const answer = await bridge.requestApproval(api, this.#card(name, machine, doing, scanned), context);
			if ("sleep" in answer) return answer;
			if (answer.decision === "decline" || answer.decision === "cancel") return { block: `The user did not allow ${name}${answer.feedback === undefined ? "." : `, and said: ${answer.feedback}`}` };
			if (scanned !== undefined && this.#knownHostLines(name).length === 0) await acceptHostKey(target, scanned.lines);
			const grant: MachineGrant =
				answer.decision === "acceptAlways"
					? { machine: name, scope: "always" }
					: answer.decision === "acceptForSession"
						? { machine: name, scope: "thread", threadId }
						: { machine: name, scope: "until", until: this.#now() + this.#options.approvalMs };
			this.grant(grant);
			this.#options.log?.info("machine allowed", { machine: name, scope: grant.scope, threadId });
		}
		return undefined;
	}

	/** The card that asks for `name`, showing the host key it would trust when none is yet. Its key is the machine and
	 * that host key: calls of a thread asking for the same share the card. */
	#card(name: string, machine: MachineConfig, doing: string, scanned: HostKey | undefined): Parameters<MachinesBridge["requestApproval"]>[1] {
		const hours = this.#options.approvalMs / 3_600_000;
		const forAWhile = Number.isInteger(hours) ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.round(this.#options.approvalMs / 60_000)} minutes`;
		const fingerprints = scanned?.fingerprints.map(shortFingerprint).join(", ");
		// One paragraph: T3 shows the reason as one.
		const reason = [
			`The agent wants to use ${name} (${address(machine)}): run commands and read and change files there, as its user. Wanted for: ${doing}.`,
			...(fingerprints === undefined ? [] : [`First connection: ${name} shows the host key ${fingerprints}. Allowing trusts it; compare it with the machine's own first (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub there).`]),
		].join(" ");
		return {
			key: fingerprints === undefined ? `machine:${name}` : `machine:${name}:${fingerprints}`,
			prompt: `ssh ${address(machine)}`,
			reason,
			appName: name,
			options: [
				{ decision: "decline", label: "Deny" },
				{ decision: "accept", label: `Allow for ${forAWhile}` },
				{ decision: "acceptForSession", label: "Allow in this thread" },
				{ decision: "acceptAlways", label: `Always allow ${name}` },
			],
		};
	}

	async #connection(name: string, machine: MachineConfig): Promise<{ connection: Connection; home: string }> {
		const key = address(machine);
		const open = this.#open.get(name);
		if (open !== undefined && open.key === key) return open.connection;
		if (open !== undefined) this.#close(name);
		const target = this.#target(name, machine);
		const connection = connectSsh({ ...target, onLog: (line) => this.#options.log?.info("machine daemon", { machine: name, line: line.trim() }) }).then(
			({ connection, remote }) => ({ connection, home: remote.home }),
			(error: unknown) => {
				this.#open.delete(name);
				throw new MachineError(connectFailure(name, this, error));
			},
		);
		this.#open.set(name, { key, connection });
		return connection;
	}

	/** End a machine's connection, and with it what runs there. */
	#close(name: string): void {
		const open = this.#open.get(name);
		this.#open.delete(name);
		void open?.connection.then(({ connection }) => connection.close(), () => {});
	}

	/** Is a connection to `name` open (or opening)? */
	connected(name: string): boolean {
		return this.#open.has(name);
	}

	close(): void {
		for (const name of [...this.#open.keys()]) this.#close(name);
	}

	/** The host key trusted for a machine, as `ssh-keygen -l` prints it; `undefined` while none is (`#knownHostLines`). */
	hostKeyFingerprint(name: string): string | undefined {
		const lines = this.#knownHostLines(name);
		if (lines.length === 0) return undefined;
		try {
			return execFileSync("ssh-keygen", ["-l", "-f", "-"], { input: lines.join("\n") + "\n" }).toString().trim().split("\n").map(shortFingerprint).join(", ");
		} catch {
			return undefined;
		}
	}

	/** How a machine's access stands, in words, for `threadId` (if any). */
	access(name: string, threadId: string | undefined): string {
		const grant = this.allowed(name, threadId);
		if (grant === undefined) {
			const elsewhere = this.#live(this.read().grants).filter((each) => each.machine === name && each.scope === "thread").length;
			return elsewhere === 0 ? "asks" : `asks here (allowed in ${elsewhere} other thread${elsewhere === 1 ? "" : "s"})`;
		}
		if (grant.scope === "always") return "always allowed";
		if (grant.scope === "thread") return grant.threadId === threadId ? "allowed in this thread" : "allowed in a thread above this one";
		return `allowed until ${new Date(grant.until).toISOString().slice(0, 16).replace("T", " ")} UTC`;
	}
}

/** `256 SHA256:… alias (ED25519)`, as `ssh-keygen -l` prints a key, as `SHA256:… (ED25519)`. */
const shortFingerprint = (line: string): string => {
	const words = line.trim().split(/\s+/);
	return words.length >= 3 ? `${words[1]} ${words.at(-1)}` : line.trim();
};

const sameScope = (a: MachineGrant, b: MachineGrant): boolean =>
	a.machine === b.machine && a.scope === b.scope && (a.scope !== "thread" || (b.scope === "thread" && a.threadId === b.threadId));

/** Why a connection failed, with what to do about it. */
function connectFailure(name: string, machines: Machines, error: unknown): string {
	if (error instanceof HostKeyChangedError) {
		return `${name}'s host key has CHANGED since it was trusted: the connection is refused. If the machine was reinstalled, ask the user to check it, then remove and add it again (machine_remove, machine_add).`;
	}
	if (error instanceof HostKeyUnknownError) return `${name}'s host key is not trusted yet; try again to be asked.`;
	const message = error instanceof Error ? error.message.trim() : String(error);
	if (/permission denied|publickey/i.test(message)) {
		return `${name} refused the harness's key (${message}). Put this line in ~/.ssh/authorized_keys of that user there:\n${machines.authorizedKey(name)}`;
	}
	return `Cannot connect to ${name}: ${message}`;
}

/** How long "Allow for …" lasts: `CLAW_MACHINE_APPROVAL_HOURS` (default 1). Not a positive number: fails loudly. */
export function machineApprovalMs(env: Env): number {
	const value = setting(env, "CLAW_MACHINE_APPROVAL_HOURS");
	if (value === undefined) return 3_600_000;
	const hours = Number(value);
	if (!Number.isFinite(hours) || hours <= 0) throw new Error(`CLAW_MACHINE_APPROVAL_HOURS must be a number of hours above 0, not ${JSON.stringify(value)}`);
	return hours * 3_600_000;
}

/** Parse a duration such as `30m`, `8h`, `2d`; `undefined` when it is none. */
export function parseDuration(text: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/.exec(text.trim());
	if (match === null) return undefined;
	const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "min" | "h" | "d"];
	const ms = Number(match[1]) * unit;
	return ms > 0 ? ms : undefined;
}

/** `/machines`: the machines and their access in the thread it is sent in; `allow`, `revoke`. */
export function machinesCommand(machines: Machines): HostCommand {
	return {
		name: "machines",
		description: "The machines the agent may use and their access; shown here only, not sent to the model",
		hint: "allow <name> <30m|8h|thread|always>, or revoke <name>",
		async run({ threadId, argument }) {
			const words = argument.split(/\s+/).filter((word) => word !== "");
			if (words[0] === "allow") {
				const [, name, how] = words;
				if (name === undefined || how === undefined) return "Usage: `/machines allow <name> <30m|8h|2d|thread|always>`";
				const ms = parseDuration(how);
				const grant: MachineGrant | undefined =
					how === "always" ? { machine: name, scope: "always" } : how === "thread" ? { machine: name, scope: "thread", threadId } : ms === undefined ? undefined : { machine: name, scope: "until", until: Date.now() + ms };
				if (grant === undefined) return `Not a duration: \`${how}\`. Give one such as \`30m\`, \`8h\` or \`2d\`, or \`thread\`, or \`always\`.`;
				machines.grant(grant);
				return `${name}: ${machines.access(name, threadId)}.${machines.hostKeyFingerprint(name) === undefined ? " Its host key is not trusted yet, so its first connection still asks on the card, showing the key to compare." : ""}`;
			}
			if (words[0] === "revoke") {
				const name = words[1];
				if (name === undefined) return "Usage: `/machines revoke <name>`";
				const count = machines.revoke(name);
				return `${name}: ${count === 0 ? "had no access granted" : `access taken back (${count} grant${count === 1 ? "" : "s"})`}; its connection is closed. The agent is asked again next time.`;
			}
			if (words.length > 0) return "Usage: `/machines`, `/machines allow <name> <30m|8h|2d|thread|always>`, `/machines revoke <name>`";
			const all = Object.entries(machines.read().machines);
			if (all.length === 0) return "No machines yet. The agent adds one with `machine_add`, and installs the key it gets there.";
			const rows = all.map(([name, machine]) => {
				const fingerprint = machines.hostKeyFingerprint(name);
				return `| ${name} | \`${address(machine)}\` | ${machines.access(name, threadId)} | ${machines.connected(name) ? "open" : "—"} | ${fingerprint === undefined ? "not trusted yet" : `\`${fingerprint}\``} |`;
			});
			return [
				"| Machine | Address | Access | Connection | Host key |",
				"| --- | --- | --- | --- | --- |",
				...rows,
				"",
				"`/machines allow <name> <30m|8h|2d|thread|always>` grants access, `/machines revoke <name>` takes it back. Shown here only: not sent to the model.",
			].join("\n");
		},
	};
}

/** `tool` with an optional `machine`: given, the call runs on that machine (connected; the gate, `machineGate`, asked
 * for it before the call ran), as it would in the workspace. */
export function onMachine(tool: ToolRegistration, machines: Machines): ToolRegistration {
	const parameters = tool.parameters as unknown as { properties: Record<string, unknown> };
	return {
		...tool,
		parameters: {
			...parameters,
			properties: { ...parameters.properties, machine: { type: "string", description: "Run it on this machine (machines_list) instead of the workspace" } },
		} as never,
		async execute(args, api, context) {
			const { machine, ...rest } = args as Record<string, unknown>;
			if (machine === undefined || machine === null || machine === "") return tool.execute(rest as never, api, context);
			if (typeof machine !== "string") throw new Error("machine: give a machine's name");
			const env = await machines.env(machine, api.conversationId);
			return tool.execute(rest as never, { ...api, env } as never, context);
		},
	} as ToolRegistration;
}

/** The machines a call uses, and what it does on each, for the card: `machine` on a tool in `doing` (`onMachine`'s), and
 * the two sides of `copy_file`. */
export function machineUses(call: Pick<ToolHookCall, "name" | "arguments">, doing: Readonly<Record<string, (args: Record<string, unknown>) => string>>): { machine: string; doing: string }[] {
	const args = call.arguments as Record<string, unknown>;
	const named = (value: unknown): value is string => typeof value === "string" && value !== "";
	if (call.name === "copy_file") {
		const sides = [["from", args["from"]], ["to", args["to"]]] as const;
		return sides.flatMap(([side, value]) => {
			const { path, machine } = (typeof value === "object" && value !== null ? value : {}) as { path?: unknown; machine?: unknown };
			return named(machine) ? [{ machine, doing: `copy_file ${side} ${String(path ?? "")}` }] : [];
		});
	}
	const describe = doing[call.name];
	return describe !== undefined && named(args["machine"]) ? [{ machine: args["machine"], doing: `${call.name} ${describe(args)}` }] : [];
}

/**
 * The machines' approval, as a gate before every call that uses one (pi-durable's gates): the call parks on T3's card
 * until the user answers (`Machines.gate`). A gate, not a wrapper of the tools: a wrapper cannot park its call. `doing`
 * says, per tool that takes `machine`, what a call is about to do there.
 */
export function machineGate(machines: Machines, doing: Readonly<Record<string, (args: Record<string, unknown>) => string>>): Extension {
	return defineExtension({
		name: "machine-approval",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const uses = machineUses(call, doing);
					return uses.length === 0 ? undefined : machines.gate(uses, api, context);
				},
			}),
		],
	});
}

/** The tools that manage machines and move files between them: `machine_add`, `machine_remove`, `machines_list`,
 * `copy_file`. Scripts only. */
export function machineTools(machines: Machines): ToolRegistration[] {
	const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
	return [
		{
			name: "machine_add",
			description:
				"Add another machine the harness can reach, or change one, under a name. Returns the harness's public key for it: put that line in ~/.ssh/authorized_keys of the user there (with access you have, or ask the user to). The private key stays with the harness. Then pass machine: name to bash, read, write or edit; the first use asks the user to approve the connection.",
			parameters: object({
				name: str({ description: "Lowercase letters, digits and dashes: nas, pi, gpu-box" }),
				host: str({ description: "Host name or address" }),
				user: opt(str({ description: "The user to log in as; default the harness's own, node" })),
				port: opt(int({ minimum: 1, maximum: 65535, description: "SSH port; default 22" })),
				cwd: opt(str({ description: "Where commands start and relative paths resolve; default that user's home" })),
			}),
			callers: ["tools"],
			async execute(args: { name: string; host: string; user?: string; port?: number; cwd?: string }) {
				const { authorizedKey, changed } = await machines.add(args.name, {
					host: args.host,
					...(args.user === undefined ? {} : { user: args.user }),
					...(args.port === undefined ? {} : { port: args.port }),
					...(args.cwd === undefined ? {} : { cwd: args.cwd }),
				});
				return text({ name: args.name, changed, authorizedKey, next: `Append authorizedKey to ~/.ssh/authorized_keys of ${args.user ?? "that user"} on ${args.host}, then use machine: "${args.name}".` });
			},
		} as ToolRegistration,
		{
			name: "machine_remove",
			description: "Remove a machine: the harness's key for it, its trusted host key, its access grants, and its connection.",
			parameters: object({ name: str() }),
			callers: ["tools"],
			async execute(args: { name: string }) {
				await machines.remove(args.name);
				return text(`Removed ${args.name}. Its key line can be deleted from authorized_keys there.`);
			},
		} as ToolRegistration,
		{
			name: "machines_list",
			description: "The machines you can use (machine: name on bash, read, write, edit), with their address, access in this thread, and the key line to install.",
			parameters: object({}),
			callers: ["tools"],
			async execute(_args, api) {
				const threadId = machines.threadOf(api.conversationId);
				const all = Object.entries(machines.read().machines).map(([name, machine]) => ({
					name,
					...machine,
					access: machines.access(name, threadId),
					hostKeyTrusted: machines.hostKeyFingerprint(name) !== undefined,
					authorizedKey: machines.authorizedKey(name),
				}));
				return text(all);
			},
		} as ToolRegistration,
		{
			name: "copy_file",
			description:
				"Copy a file, of any size or kind, between the workspace and a machine, or between machines: from and to are each { path, machine? } (no machine: the workspace). Overwrites the destination; makes its folder. For a folder, tar it first.",
			parameters: object({
				from: object({ path: str(), machine: opt(str()) }),
				to: object({ path: str(), machine: opt(str()) }),
			}),
			callers: ["tools"],
			async execute(args: { from: { path: string; machine?: string }; to: { path: string; machine?: string } }, api, context) {
				const envOf = async (side: { path: string; machine?: string }) =>
					(side.machine === undefined || side.machine === "" ? api.env : await machines.env(side.machine, api.conversationId)) as ExecutionEnv | undefined;
				const source = await envOf(args.from);
				const target = await envOf(args.to);
				if (source === undefined || target === undefined) throw new Error("No execution environment is configured");
				const bytes = await copyFile(source, args.from.path, target, args.to.path, context);
				return text(`Copied ${bytes} bytes.`);
			},
		} as ToolRegistration,
	];
}

const CHUNK = 4 * 1024 * 1024;

/** Copy `from` in `source` to `to` in `target` a chunk at a time, through a temporary file renamed into place. */
async function copyFile(source: ExecutionEnv, from: string, target: ExecutionEnv, to: string, context: Context): Promise<number> {
	const fail = (what: string, error: { message: string }) => new Error(`${what}: ${error.message}`);
	const destination = await target.absolutePath(to, context);
	if (!destination.ok) throw fail(to, destination.error);
	const folder = destination.value.slice(0, destination.value.lastIndexOf("/")) || "/";
	const made = await target.createDir(folder, { recursive: true }, context);
	if (!made.ok) throw fail(folder, made.error);
	const reader = await source.openBinaryReader(from, undefined, context);
	if (!reader.ok) throw fail(from, reader.error);
	const temporary = `${destination.value}.copying-${process.pid}-${Date.now()}`;
	try {
		const info = await reader.value.info(context);
		if (!info.ok) throw fail(from, info.error);
		if (info.value.kind !== "file") throw new Error(`${from} is not a file`);
		const started = await target.writeFile(temporary, new Uint8Array(), context);
		if (!started.ok) throw fail(to, started.error);
		let offset = 0;
		for (;;) {
			const chunk = await reader.value.read(offset, CHUNK, context);
			if (!chunk.ok) throw fail(from, chunk.error);
			if (chunk.value.length === 0) break;
			const written = await target.appendFile(temporary, chunk.value, context);
			if (!written.ok) throw fail(to, written.error);
			offset += chunk.value.length;
		}
		const moved = await target.renameFile(temporary, destination.value, context);
		if (!moved.ok) throw fail(to, moved.error);
		return offset;
	} catch (error) {
		await target.remove(temporary, { force: true }, context).catch(() => {});
		throw error;
	} finally {
		await reader.value.close(context);
	}
}
