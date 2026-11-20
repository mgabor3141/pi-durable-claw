// Other machines: the harness's own key per machine, the user's approval on T3's card asked by a gate before the call
// (a fake bridge here, which parks the call once and answers on its wake), and pi-env over SSH to a private sshd this
// test starts (skipped where there is none).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineSignal, Harness, type HookApi, LiveDoc, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj, oneOf } from "@earendil-works/pi-schema";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ApprovalAsk, ApprovalOutcome, ThreadOrigin } from "@mgabor3141/pi-durable-t3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { harnessExtensions } from "../src/harness.ts";
import { machineApprovalMs, machineGate, Machines, machinesCommand, machineTools, machineUses, onMachine, parseDuration } from "../src/machines.ts";
import { object } from "../src/schema.ts";

const SSHD = "/usr/sbin/sshd";
const PORT = 22000 + Math.floor(Math.random() * 2000);

let dir: string;
let sshd: ChildProcess | undefined;

async function listening(port: number): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		const open = await new Promise<boolean>((resolve) => {
			const socket = new Socket();
			socket.once("connect", () => (socket.destroy(), resolve(true)));
			socket.once("error", () => resolve(false));
			socket.connect(port, "127.0.0.1");
		});
		if (open) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "claw-machines-"));
	// Without an sshd the tests that connect pass without running; CI installs one, so there they must run.
	if (!existsSync(SSHD)) {
		if (process.env.CI !== undefined) throw new Error(`no ${SSHD}: CI must install openssh-server`);
		return;
	}
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "host_ed25519")]);
	await writeFile(join(dir, "authorized_keys"), "");
	await writeFile(
		join(dir, "sshd_config"),
		[`Port ${PORT}`, "ListenAddress 127.0.0.1", `HostKey ${join(dir, "host_ed25519")}`, `PidFile ${join(dir, "sshd.pid")}`, `AuthorizedKeysFile ${join(dir, "authorized_keys")}`, "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no", "StrictModes no", ""].join("\n"),
	);
	sshd = spawn(SSHD, ["-D", "-e", "-f", join(dir, "sshd_config")], { stdio: "ignore" });
	if (!(await listening(PORT))) {
		sshd.kill();
		sshd = undefined;
		if (process.env.CI !== undefined) throw new Error("the test's sshd did not start");
	}
});

afterAll(async () => {
	sshd?.kill();
	await rm(dir, { recursive: true, force: true });
});

/** A call's hook api, as far as the gate and the bridge use it: its conversation, the clock, and the call's memos. */
type FakeApi = Pick<HookApi, "conversationId" | "memo" | "readSignal" | "now"> & { readonly parked: Set<string> };
const fakeApi = (conversationId: number): FakeApi => {
	const memos = new Map<string, unknown>();
	return {
		conversationId: conversationId as never,
		now: () => Date.now(),
		readSignal: async () => undefined,
		// First writer wins, as pi-durable's memos.
		memo: (async (name: string, ...rest: unknown[]) => {
			if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);
			return memos.get(name);
		}) as never,
		parked: new Set(),
	};
};

/** A fake bridge: threads by conversation (1 → "t1", 2 → "child" of t1, 3 → "fork" of t1), and a card that, as the
 * bridge does, parks the call the first time it is asked and answers on the gate's next pass (its wake) as `answer`
 * says, recording what it was asked. */
function fakeBridge(answer: (ask: ApprovalAsk) => ApprovalOutcome) {
	const asked: ApprovalAsk[] = [];
	const origins: Record<string, ThreadOrigin> = {
		t1: { threadId: "t1", createdBy: "user", creationSource: "web", parentThreadId: null, relationshipToParent: null, sideChat: false },
		child: { threadId: "child", createdBy: "agent", creationSource: "server", parentThreadId: "t1", relationshipToParent: "subagent", sideChat: false },
		fork: { threadId: "fork", createdBy: "user", creationSource: "web", parentThreadId: "t1", relationshipToParent: "fork", sideChat: false },
	} as never;
	const byConversation: Record<number, string> = { 1: "t1", 2: "child", 3: "fork" };
	return {
		asked,
		bridge: {
			threadOf: (conversationId: number) => origins[byConversation[conversationId]!],
			threadOrigin: (threadId: string) => origins[threadId],
			requestApproval: async (api: FakeApi, ask: ApprovalAsk) => {
				if (!api.parked.has(ask.key)) {
					api.parked.add(ask.key);
					asked.push(ask);
					return { sleep: { signals: [] } };
				}
				return answer(ask);
			},
		},
	};
}

/** Run a call's gate as pi-durable does: again on each wake, until it passes (`undefined`) or blocks (its text). */
async function gate(machines: Machines, uses: { machine: string; doing: string }[], api: FakeApi): Promise<{ block?: string; parks: number }> {
	for (let parks = 0; ; parks++) {
		const result = await machines.gate(uses, api as never, BACKGROUND_CONTEXT);
		if (result === undefined) return { parks };
		if ("block" in result) return { block: result.block, parks };
		if (parks > 3) throw new Error("the gate keeps parking");
	}
}

/** A call on `box` from conversation `conversationId` asks, and passes: the machine may be used there now. */
async function approve(machines: Machines, conversationId: number, doing = "bash true"): Promise<void> {
	const { block } = await gate(machines, [{ machine: "box", doing }], fakeApi(conversationId));
	if (block !== undefined) throw new Error(block);
}

/** The machines each test made: their connections are closed after it, as each holds a daemon with its threads. */
const made: Machines[] = [];
afterEach(() => {
	for (const machines of made.splice(0)) machines.close();
});

const make = (name: string, answer: Parameters<typeof fakeBridge>[0], now?: () => number) => {
	const fake = fakeBridge(answer);
	const machines = new Machines({ dir: join(dir, name), approvalMs: 3_600_000, bridge: Promise.resolve(fake.bridge as never), ...(now === undefined ? {} : { now }) });
	made.push(machines);
	return { machines, asked: fake.asked };
};

const user = userInfo().username;
const install = async (machines: Machines, name: string) => writeFile(join(dir, "authorized_keys"), `${machines.authorizedKey(name)}\n`, { flag: "a" });
const exec = async (env: unknown, command: string) => {
	let stdout = "";
	const result = await (env as NodeExecutionEnv).exec(command, { onOutput: (text) => void (stdout += text) }, BACKGROUND_CONTEXT);
	if (!result.ok) throw result.error;
	return { ...result.value, stdout };
};

describe("machines", () => {
	it("makes a key per machine, given as a restricted authorized_keys line, and keeps them in a file", async () => {
		const { machines } = make("keys", () => ({ decision: "cancel" }));
		const { authorizedKey } = await machines.add("nas", { host: "nas.lan", user: "max" });
		expect(authorizedKey).toMatch(/^restrict ssh-ed25519 \S+ claw-machine-nas$/);
		expect(await machines.add("nas", { host: "nas.lan", user: "max" })).toEqual({ authorizedKey, changed: false });
		expect(JSON.parse(await readFile(join(dir, "keys", "machines.json"), "utf8"))).toEqual({ machines: { nas: { host: "nas.lan", user: "max" } }, grants: [] });
		await expect(machines.add("Bad Name", { host: "x" })).rejects.toThrow("lowercase letters");
		await expect(machines.add("ok", { host: "-oProxyCommand=x" })).rejects.toThrow("not a host");
		await expect(machines.env("nope", 1)).rejects.toThrow('No machine named "nope". There are: nas.');
		expect(await gate(machines, [{ machine: "nope", doing: "bash true" }], fakeApi(1))).toEqual({ block: 'No machine named "nope". There are: nas.', parks: 0 });
	});

	it("lets a gate that runs before the bridge is attached (one woken at startup) wait for it, and ask then", async () => {
		if (sshd === undefined) return;
		const fake = fakeBridge(() => ({ decision: "accept" }));
		const attached = Promise.withResolvers<never>();
		const machines = new Machines({ dir: join(dir, "early"), approvalMs: 3_600_000, bridge: attached.promise });
		made.push(machines);
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		let settled: unknown = "waiting";
		const gated = machines.gate([{ machine: "box", doing: "bash true" }], fakeApi(1) as never, BACKGROUND_CONTEXT).then((result) => (settled = result));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(settled, "no block while the bridge attaches").toBe("waiting");
		attached.resolve(fake.bridge as never);
		await gated;
		// Attached: the card is asked, and the call parks on it.
		expect(settled).toMatchObject({ sleep: {} });
		expect(fake.asked).toHaveLength(1);
	});

	it("gates the calls that use a machine, by the tools that take one and copy_file's two sides", async () => {
		const doing = { bash: (args: Record<string, unknown>) => String(args["command"]) };
		expect(machineUses({ name: "bash", arguments: { command: "ls", machine: "box" } }, doing)).toEqual([{ machine: "box", doing: "bash ls" }]);
		expect(machineUses({ name: "bash", arguments: { command: "ls" } }, doing)).toEqual([]);
		expect(machineUses({ name: "read", arguments: { path: "a", machine: "box" } }, doing)).toEqual([]);
		expect(machineUses({ name: "copy_file", arguments: { from: { path: "a", machine: "box" }, to: { path: "b", machine: "nas" } } }, doing)).toEqual([
			{ machine: "box", doing: "copy_file from a" },
			{ machine: "nas", doing: "copy_file to b" },
		]);
		// A call that uses none passes without asking anything.
		const { machines, asked } = make("uses", () => ({ decision: "accept" }));
		const hooks = machineGate(machines, doing).hooks![0]!.handlers as { beforeTool: (call: unknown, api: unknown, context: unknown) => Promise<unknown> };
		expect(await hooks.beforeTool({ name: "bash", arguments: { command: "ls" } }, fakeApi(1), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await hooks.beforeTool({ name: "bash", arguments: { command: "ls", machine: "nope" } }, fakeApi(1), BACKGROUND_CONTEXT)).toEqual({ block: expect.stringContaining('No machine named "nope"') });
		expect(asked).toEqual([]);
	});

	it("parks a call on the card, trusts the host key it showed, then runs there; a grant in a thread covers its child, not a fork", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("ask", () => ({ decision: "acceptForSession" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		// Not allowed yet: only the gate asks, the call itself does not.
		await expect(machines.env("box", 1)).rejects.toThrow("Using box is not allowed here now");
		// Two calls at once: each parks, with the same question, which the bridge shows as one card.
		const first = fakeApi(1);
		const second = fakeApi(1);
		expect(await machines.gate([{ machine: "box", doing: "bash whoami" }], first as never, BACKGROUND_CONTEXT)).toMatchObject({ sleep: {} });
		expect(await machines.gate([{ machine: "box", doing: "bash pwd" }], second as never, BACKGROUND_CONTEXT)).toMatchObject({ sleep: {} });
		expect(asked).toHaveLength(2);
		expect(asked[1]!.key).toBe(asked[0]!.key);
		expect(asked[0]).toMatchObject({ prompt: `ssh ${user}@127.0.0.1:${PORT}`, appName: "box" });
		expect(asked[0]!.key).toMatch(/^machine:box:SHA256:\S+ \(ED25519\)$/);
		expect(asked[0]!.reason).toMatch(/Wanted for: bash whoami\. First connection: box shows the host key SHA256:\S+ \(ED25519\)\. Allowing trusts it/);
		expect(asked[0]!.options.map((option) => [option.decision, option.label])).toEqual([
			["decline", "Deny"],
			["accept", "Allow for 1 hour"],
			["acceptForSession", "Allow in this thread"],
			["acceptAlways", "Always allow box"],
		]);
		// Nothing is trusted or granted while the card waits.
		expect(machines.hostKeyFingerprint("box")).toBeUndefined();
		expect(machines.access("box", "t1")).toBe("asks");
		// The user answers: both wake, and both pass.
		expect(await machines.gate([{ machine: "box", doing: "bash whoami" }], first as never, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await machines.gate([{ machine: "box", doing: "bash pwd" }], second as never, BACKGROUND_CONTEXT)).toBeUndefined();
		const env = await machines.env("box", 1);
		expect((await exec(env as never, "whoami")).stdout.trim()).toBe(user);
		expect(machines.hostKeyFingerprint("box")).toMatch(/^SHA256:\S+ \(ED25519\)$/);
		expect((await readFile(join(dir, "ask", "known_hosts"), "utf8")).split("\n").filter((line) => line.startsWith("claw-machine-box "))).toHaveLength(1);
		// The child thread is covered; a fork is a thread of its own and asks, now without a host key to show.
		await approve(machines, 2);
		expect(asked).toHaveLength(2);
		await approve(machines, 3);
		expect(asked).toHaveLength(3);
		expect(asked[2]!.reason).not.toContain("First connection");
		expect(asked[2]!.key).toBe("machine:box");
		expect(machines.access("box", "t1")).toBe("allowed in this thread");
		expect(machines.access("box", "child")).toBe("allowed in a thread above this one");
	});

	it("decides from the grants and the card's answer on every pass, and does each step once", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("again", () => ({ decision: "accept" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		const api = fakeApi(1);
		expect(await gate(machines, [{ machine: "box", doing: "bash true" }], api)).toEqual({ parks: 1 });
		const known = await readFile(join(dir, "again", "known_hosts"), "utf8");
		const grants = machines.read().grants;
		// A gate asked again before its call ran (a restart, a registry change): it passes, and changes nothing.
		expect(await gate(machines, [{ machine: "box", doing: "bash true" }], api)).toEqual({ parks: 0 });
		expect(await readFile(join(dir, "again", "known_hosts"), "utf8")).toBe(known);
		expect(machines.read().grants).toEqual(grants);
		expect(asked).toHaveLength(1);
	});

	it("asks on the card at the first connection even with access granted, so the user sees the host key it trusts", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("granted", () => ({ decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		const said = await machinesCommand(machines).run({ threadId: "t1", argument: "allow box always" });
		// Outside a thread there is no card to show the key on.
		expect((await gate(machines, [{ machine: "box", doing: "bash true" }], fakeApi(99))).block).toBe("box's host key is not trusted yet, and only a thread's approval card can show it to the user: connect to it from a thread first.");
		await approve(machines, 1, "bash whoami");
		const env = await machines.env("box", 1);
		expect(said).toBe("box: always allowed. Its host key is not trusted yet, so its first connection still asks on the card, showing the key to compare.");
		expect(asked).toHaveLength(1);
		expect(asked[0]!.reason).toContain("First connection: box shows the host key");
		expect((await exec(env as never, "whoami")).stdout.trim()).toBe(user);
		// Trusted now: the grant is enough.
		await approve(machines, 3);
		expect(asked).toHaveLength(1);
	});

	it("keeps the connection and the grants when only cwd changes", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("cwd", () => ({ decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		await approve(machines, 1);
		const env = await machines.env("box", 1);
		// Settled either way, so a command the connection's end kills fails the expectation, not the run.
		const running = exec(env as never, "sleep 1; echo finished").then(
			(result) => result.stdout.trim(),
			(error: Error) => error.message,
		);
		expect(await machines.add("box", { host: "127.0.0.1", port: PORT, user, cwd: "/tmp" })).toMatchObject({ changed: true });
		expect(machines.access("box", "t1")).toBe("always allowed");
		// Another thread's call while the command still runs: it uses the same connection, with the new cwd.
		await approve(machines, 3, "bash pwd");
		expect((await machines.env("box", 3)).cwd).toBe("/tmp");
		expect(await running).toBe("finished");
		expect(machines.connected("box")).toBe(true);
		expect(asked).toHaveLength(1);
	});

	it("drops a machine's grants when its address changes, and its host key when its host or port does", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("moved", () => ({ decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		await approve(machines, 1);
		await machines.env("box", 1);
		// Another user: the grant goes and the connection with it; the host key stays, as the host is the same.
		await machines.add("box", { host: "127.0.0.1", port: PORT, user: "someone-else" });
		expect(machines.access("box", "t1")).toBe("asks");
		expect(machines.connected("box")).toBe(false);
		expect(machines.hostKeyFingerprint("box")).toBeDefined();
		// Another port: the host key is forgotten by the time add returns, so the next card shows the key again.
		await machines.add("box", { host: "127.0.0.1", port: PORT + 1, user });
		expect(machines.hostKeyFingerprint("box")).toBeUndefined();
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await approve(machines, 1);
		await machines.env("box", 1);
		expect(asked).toHaveLength(2);
		expect(asked[1]!.reason).toContain("First connection");
	});

	it("blocks the call with what the user answered on a decline, and asks again after a revoke, which ends the connection", async () => {
		if (sshd === undefined) return;
		let answer: ApprovalOutcome = { decision: "decline", feedback: "use the pi instead" };
		const { machines, asked } = make("decline", () => answer);
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		expect(await gate(machines, [{ machine: "box", doing: "bash true" }], fakeApi(1))).toEqual({ block: "The user did not allow box, and said: use the pi instead", parks: 1 });
		// Denied: nothing trusted, nothing granted.
		expect(machines.hostKeyFingerprint("box")).toBeUndefined();
		answer = { decision: "accept" };
		await approve(machines, 1);
		const env = await machines.env("box", 1);
		expect(machines.access("box", "t1")).toMatch(/^allowed until /);
		const running = exec(env as never, "sleep 30");
		expect(machines.revoke("box")).toBe(1);
		await expect(running).rejects.toThrow();
		expect(machines.connected("box")).toBe(false);
		await expect(machines.env("box", 1)).rejects.toThrow("not allowed here now");
		await approve(machines, 1);
		expect(asked).toHaveLength(3);
	});

	it("lets an expired grant ask again", async () => {
		if (sshd === undefined) return;
		let now = Date.now();
		const { machines, asked } = make("expiry", () => ({ decision: "accept" }), () => now);
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		await approve(machines, 1);
		now += 3_600_001;
		await expect(machines.env("box", 1)).rejects.toThrow("not allowed here now");
		await approve(machines, 1);
		expect(asked).toHaveLength(2);
	});

	it("names the key line to install when the machine refuses the key", async () => {
		if (sshd === undefined) return;
		const { machines } = make("refused", () => ({ decision: "acceptAlways" }));
		const { authorizedKey } = await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await approve(machines, 1);
		await expect(machines.env("box", 1)).rejects.toThrow(authorizedKey);
	});

	it("runs a tool given `machine` there, and the workspace's without", async () => {
		if (sshd === undefined) return;
		const { machines } = make("tool", () => ({ decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user, cwd: "/tmp" });
		await install(machines, "box");
		await approve(machines, 1);
		const seen: unknown[] = [];
		const probe = { name: "bash", description: "", parameters: object({}), execute: async (args: unknown, api: { env: { id: string; cwd: string } }) => (seen.push([args, api.env.id, api.env.cwd]), { output: [] }) } as unknown as ToolRegistration;
		const tool = onMachine(probe, machines);
		expect((tool.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty("machine");
		const workspace = new NodeExecutionEnv({ cwd: dir });
		await tool.execute({ command: "ls" } as never, { conversationId: 1, env: workspace } as never, BACKGROUND_CONTEXT as never);
		await tool.execute({ command: "ls", machine: "box" } as never, { conversationId: 1, env: workspace } as never, BACKGROUND_CONTEXT as never);
		expect(seen).toEqual([
			[{ command: "ls" }, workspace.id, dir],
			[{ command: "ls" }, "pi-env:claw-machine-box", "/tmp"],
		]);
	});

	it("copies a file of any kind between the workspace and a machine", async () => {
		if (sshd === undefined) return;
		const { machines } = make("copy", () => ({ decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		await approve(machines, 1, "copy_file to blob.bin");
		const copy = machineTools(machines).find((tool) => tool.name === "copy_file")!;
		const bytes = new Uint8Array(9 * 1024 * 1024).map((_, index) => (index * 7919) % 256);
		await writeFile(join(dir, "blob.bin"), bytes);
		const api = { conversationId: 1, env: new NodeExecutionEnv({ cwd: dir }) };
		await copy.execute({ from: { path: "blob.bin" }, to: { path: join(dir, "remote", "deep", "blob.bin"), machine: "box" } } as never, api as never, BACKGROUND_CONTEXT as never);
		await copy.execute({ from: { path: join(dir, "remote", "deep", "blob.bin"), machine: "box" }, to: { path: "back.bin" } } as never, api as never, BACKGROUND_CONTEXT as never);
		expect(Buffer.compare(await readFile(join(dir, "back.bin")), Buffer.from(bytes))).toBe(0);
	});

	it("parks the model's call on a machine at its gate, holding no process, until the user answers; then it runs there", { timeout: 60_000 }, async () => {
		if (sshd === undefined) return;
		// The bridge's part, as it does it: the decision is a signal to the call's task, which the gate reads on its wake.
		const Decision = defineSignal({ name: "test.approval", version: 1, schema: obj({ decision: oneOf(["accept", "decline"]) }) });
		const asked: ApprovalAsk[] = [];
		const t1: ThreadOrigin = { threadId: "t1", createdBy: "user", creationSource: "web", parentThreadId: null, relationshipToParent: null, sideChat: false } as never;
		const bridge = {
			threadOf: () => t1,
			threadOrigin: () => t1,
			requestApproval: async (api: HookApi, ask: ApprovalAsk, context: typeof BACKGROUND_CONTEXT) => {
				const state = await api.readSignal(Decision, ask.key, context);
				if (state !== undefined && "value" in state) return state.value;
				asked.push(ask);
				return { sleep: { signals: [Decision.key(ask.key)] } };
			},
		};
		const machines = new Machines({ dir: join(dir, "parked"), approvalMs: 3_600_000, bridge: Promise.resolve(bridge as never) });
		made.push(machines);
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		const registry = createRegistry();
		for (const extension of harnessExtensions({ machines })) registry.install(extension);
		const faux = fauxProvider({ provider: "faux" });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "whoami", machine: "box" }, { id: "b" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "parked", "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }) }, BACKGROUND_CONTEXT);
		try {
			const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id }, cwd: dir } });
			await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
			let slot: { status: string; taskId?: number } | undefined;
			for (let tries = 0; tries < 200 && slot?.status !== "sleeping"; tries++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
				slot = (await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT))?.tools?.find((each) => each.callId === "b") as never;
			}
			expect(slot?.status).toBe("sleeping");
			let active = true;
			for (let tries = 0; tries < 200 && active; tries++) {
				active = harness.wake().active;
				if (active) await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(active, "nothing needs a process while the card waits").toBe(false);
			expect(asked).toHaveLength(1);
			expect(asked[0]!.reason).toContain("Wanted for: bash whoami. First connection");
			expect(machines.access("box", "t1")).toBe("asks");
			expect(await harness.signal(slot!.taskId! as never, Decision, asked[0]!.key, { decision: "accept" }, BACKGROUND_CONTEXT)).toBe("delivered");
			await conversation.waitForIdle(BACKGROUND_CONTEXT);
			const result = (await conversation.context(BACKGROUND_CONTEXT)).messages.find((message) => message.role === "toolResult");
			expect(result?.role === "toolResult" && result.isError !== true ? result.content.map((block) => (block.type === "text" ? block.text : "")).join("") : result).toContain(user);
			expect(machines.access("box", "t1")).toMatch(/^allowed until /);
			expect(asked).toHaveLength(1);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("/machines lists them, grants for a time or the thread, and revokes", async () => {
		const { machines } = make("command", () => ({ decision: "cancel" }));
		const command = machinesCommand(machines);
		expect(await command.run({ threadId: "t1", argument: "" })).toContain("No machines yet");
		await machines.add("nas", { host: "nas.lan", user: "max", port: 2222 });
		expect(await command.run({ threadId: "t1", argument: "" })).toContain("| nas | `max@nas.lan:2222` | asks | — | not trusted yet |");
		expect(await command.run({ threadId: "t1", argument: "allow nas 8h" })).toMatch(/^nas: allowed until /);
		expect(await command.run({ threadId: "t1", argument: "allow nas soon" })).toContain("Not a duration");
		expect(await command.run({ threadId: "t1", argument: "revoke nas" })).toContain("access taken back (1 grant)");
		expect(await command.run({ threadId: "t1", argument: "allow nas thread" })).toMatch(/^nas: allowed in this thread/);
		expect(await command.run({ threadId: "other", argument: "" })).toContain("asks here (allowed in 1 other thread)");
		expect(await command.run({ threadId: "t1", argument: "allow nope always" }).catch((error: Error) => error.message)).toContain('No machine named "nope"');
	});

	it("reads its settings, and fails loudly on a broken file", async () => {
		expect(parseDuration("30m")).toBe(1_800_000);
		expect(parseDuration("1.5h")).toBe(5_400_000);
		expect(parseDuration("2d")).toBe(172_800_000);
		expect(parseDuration("soon")).toBeUndefined();
		expect(machineApprovalMs({})).toBe(3_600_000);
		expect(machineApprovalMs({ CLAW_MACHINE_APPROVAL_HOURS: "8" })).toBe(28_800_000);
		expect(() => machineApprovalMs({ CLAW_MACHINE_APPROVAL_HOURS: "-1" })).toThrow("above 0");
		const { machines } = make("broken", () => ({ decision: "cancel" }));
		await writeFile(join(dir, "broken", "machines.json"), "{ nope");
		expect(() => machines.read()).toThrow("is not valid JSON");
	});
});
