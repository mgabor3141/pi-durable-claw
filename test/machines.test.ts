// Other machines: the harness's own key per machine, the user's approval on T3's card (a fake bridge here), and pi-env
// over SSH to a private sshd this test starts (skipped where there is none).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ApprovalAsk, ApprovalOutcome, ThreadOrigin } from "@mgabor3141/pi-durable-t3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { machineApprovalMs, Machines, machinesCommand, machineTools, onMachine, parseDuration } from "../src/machines.ts";
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

/** A fake bridge: threads by conversation (1 → "t1", 2 → "child" of t1, 3 → "fork" of t1), and a card that answers
 * as `answer` says, recording what it was asked. */
function fakeBridge(answer: (ask: ApprovalAsk) => ApprovalOutcome | Promise<ApprovalOutcome>) {
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
			requestApproval: async (ask: ApprovalAsk) => {
				asked.push(ask);
				return answer(ask);
			},
		},
	};
}

/** The machines each test made: their connections are closed after it, as each holds a daemon with its threads. */
const made: Machines[] = [];
afterEach(() => {
	for (const machines of made.splice(0)) machines.close();
});

const make = (name: string, answer: Parameters<typeof fakeBridge>[0], now?: () => number) => {
	const fake = fakeBridge(answer);
	const machines = new Machines({ dir: join(dir, name), approvalMs: 3_600_000, bridge: () => fake.bridge as never, ...(now === undefined ? {} : { now }) });
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
		const { machines } = make("keys", () => ({ status: "cancelled" }));
		const { authorizedKey } = await machines.add("nas", { host: "nas.lan", user: "max" });
		expect(authorizedKey).toMatch(/^restrict ssh-ed25519 \S+ claw-machine-nas$/);
		expect(await machines.add("nas", { host: "nas.lan", user: "max" })).toEqual({ authorizedKey, changed: false });
		expect(JSON.parse(await readFile(join(dir, "keys", "machines.json"), "utf8"))).toEqual({ machines: { nas: { host: "nas.lan", user: "max" } }, grants: [] });
		await expect(machines.add("Bad Name", { host: "x" })).rejects.toThrow("lowercase letters");
		await expect(machines.add("ok", { host: "-oProxyCommand=x" })).rejects.toThrow("not a host");
		await expect(machines.env("nope", 1, "bash true", undefined)).rejects.toThrow('No machine named "nope". There are: nas.');
	});

	it("asks once on the card, trusting the host key it showed, then runs there; a grant in a thread covers its child, not a fork", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("ask", () => ({ status: "decided", decision: "acceptForSession" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		// Two calls at once: one card.
		const [env] = await Promise.all([machines.env("box", 1, "bash whoami", undefined), machines.env("box", 1, "bash pwd", undefined)]);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ conversationId: 1, prompt: `ssh ${user}@127.0.0.1:${PORT}`, appName: "box" });
		expect(asked[0]!.reason).toMatch(/First connection: box shows the host key SHA256:\S+ \(ED25519\)\. Allowing trusts it/);
		expect(asked[0]!.options.map((option) => [option.decision, option.label])).toEqual([
			["decline", "Deny"],
			["accept", "Allow for 1 hour"],
			["acceptForSession", "Allow in this thread"],
			["acceptAlways", "Always allow box"],
		]);
		expect((await exec(env as never, "whoami")).stdout.trim()).toBe(user);
		expect(machines.hostKeyFingerprint("box")).toMatch(/^SHA256:\S+ \(ED25519\)$/);
		// The child thread is covered; a fork is a thread of its own and asks.
		await machines.env("box", 2, "bash true", undefined);
		expect(asked).toHaveLength(1);
		await machines.env("box", 3, "bash true", undefined);
		expect(asked).toHaveLength(2);
		expect(asked[1]!.reason).not.toContain("First connection");
		expect(machines.access("box", "t1")).toBe("allowed in this thread");
		expect(machines.access("box", "child")).toBe("allowed in a thread above this one");
	});

	it("asks on the card at the first connection even with access granted, so the user sees the host key it trusts", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("granted", () => ({ status: "decided", decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		const said = await machinesCommand(machines).run({ threadId: "t1", argument: "allow box always" });
		// Outside a thread there is no card to show the key on.
		await expect(machines.env("box", 99, "bash true", undefined)).rejects.toThrow("box's host key is not trusted yet, and only a thread's approval card can show it to the user");
		const env = await machines.env("box", 1, "bash whoami", undefined);
		expect(said).toBe("box: always allowed. Its host key is not trusted yet, so its first connection still asks on the card, showing the key to compare.");
		expect(asked).toHaveLength(1);
		expect(asked[0]!.reason).toContain("First connection: box shows the host key");
		expect((await exec(env as never, "whoami")).stdout.trim()).toBe(user);
		// Trusted now: the grant is enough.
		await machines.env("box", 3, "bash true", undefined);
		expect(asked).toHaveLength(1);
	});

	it("keeps the connection and the grants when only cwd changes", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("cwd", () => ({ status: "decided", decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		const env = await machines.env("box", 1, "bash true", undefined);
		// Settled either way, so a command the connection's end kills fails the expectation, not the run.
		const running = exec(env as never, "sleep 1; echo finished").then(
			(result) => result.stdout.trim(),
			(error: Error) => error.message,
		);
		expect(await machines.add("box", { host: "127.0.0.1", port: PORT, user, cwd: "/tmp" })).toMatchObject({ changed: true });
		expect(machines.access("box", "t1")).toBe("always allowed");
		// Another thread's call while the command still runs: it uses the same connection, with the new cwd.
		expect((await machines.env("box", 3, "bash pwd", undefined)).cwd).toBe("/tmp");
		expect(await running).toBe("finished");
		expect(machines.connected("box")).toBe(true);
		expect(asked).toHaveLength(1);
	});

	it("drops a machine's grants when its address changes, and its host key when its host or port does", async () => {
		if (sshd === undefined) return;
		const { machines, asked } = make("moved", () => ({ status: "decided", decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		await machines.env("box", 1, "bash true", undefined);
		// Another user: the grant goes and the connection with it; the host key stays, as the host is the same.
		await machines.add("box", { host: "127.0.0.1", port: PORT, user: "someone-else" });
		expect(machines.access("box", "t1")).toBe("asks");
		expect(machines.connected("box")).toBe(false);
		expect(machines.hostKeyFingerprint("box")).toBeDefined();
		// Another port: the host key is forgotten by the time add returns, so the next card shows the key again.
		await machines.add("box", { host: "127.0.0.1", port: PORT + 1, user });
		expect(machines.hostKeyFingerprint("box")).toBeUndefined();
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await machines.env("box", 1, "bash true", undefined);
		expect(asked).toHaveLength(2);
		expect(asked[1]!.reason).toContain("First connection");
	});

	it("says what the user answered on a decline, and asks again after a revoke, which ends the connection", async () => {
		if (sshd === undefined) return;
		let answer: ApprovalOutcome = { status: "decided", decision: "decline", feedback: "use the pi instead" };
		const { machines, asked } = make("decline", () => answer);
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		await expect(machines.env("box", 1, "bash true", undefined)).rejects.toThrow("The user did not allow box, and said: use the pi instead");
		answer = { status: "decided", decision: "accept" };
		const env = await machines.env("box", 1, "bash true", undefined);
		expect(machines.access("box", "t1")).toMatch(/^allowed until /);
		const running = exec(env as never, "sleep 30");
		expect(machines.revoke("box")).toBe(1);
		await expect(running).rejects.toThrow();
		expect(machines.connected("box")).toBe(false);
		await machines.env("box", 1, "bash true", undefined);
		expect(asked).toHaveLength(3);
	});

	it("lets an expired grant ask again, and a timed-out card say so", async () => {
		if (sshd === undefined) return;
		let now = Date.now();
		let answer: ApprovalOutcome = { status: "decided", decision: "accept" };
		const { machines, asked } = make("expiry", () => answer, () => now);
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		await machines.env("box", 1, "bash true", undefined);
		now += 3_600_001;
		answer = { status: "timed_out" };
		await expect(machines.env("box", 1, "bash true", undefined)).rejects.toThrow("Nobody answered the approval for box");
		expect(asked).toHaveLength(2);
	});

	it("names the key line to install when the machine refuses the key", async () => {
		if (sshd === undefined) return;
		const { machines } = make("refused", () => ({ status: "decided", decision: "acceptAlways" }));
		const { authorizedKey } = await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await expect(machines.env("box", 1, "bash true", undefined)).rejects.toThrow(authorizedKey);
	});

	it("runs a tool given `machine` there, and the workspace's without", async () => {
		if (sshd === undefined) return;
		const { machines } = make("tool", () => ({ status: "decided", decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user, cwd: "/tmp" });
		await install(machines, "box");
		const seen: unknown[] = [];
		const probe = { name: "bash", description: "", parameters: object({}), execute: async (args: unknown, api: { env: { id: string; cwd: string } }) => (seen.push([args, api.env.id, api.env.cwd]), { output: [] }) } as unknown as ToolRegistration;
		const tool = onMachine(probe, machines, (args) => String(args["command"]));
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
		const { machines } = make("copy", () => ({ status: "decided", decision: "acceptAlways" }));
		await machines.add("box", { host: "127.0.0.1", port: PORT, user });
		await install(machines, "box");
		const copy = machineTools(machines).find((tool) => tool.name === "copy_file")!;
		const bytes = new Uint8Array(9 * 1024 * 1024).map((_, index) => (index * 7919) % 256);
		await writeFile(join(dir, "blob.bin"), bytes);
		const api = { conversationId: 1, env: new NodeExecutionEnv({ cwd: dir }) };
		await copy.execute({ from: { path: "blob.bin" }, to: { path: join(dir, "remote", "deep", "blob.bin"), machine: "box" } } as never, api as never, BACKGROUND_CONTEXT as never);
		await copy.execute({ from: { path: join(dir, "remote", "deep", "blob.bin"), machine: "box" }, to: { path: "back.bin" } } as never, api as never, BACKGROUND_CONTEXT as never);
		expect(Buffer.compare(await readFile(join(dir, "back.bin")), Buffer.from(bytes))).toBe(0);
	});

	it("/machines lists them, grants for a time or the thread, and revokes", async () => {
		const { machines } = make("command", () => ({ status: "cancelled" }));
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
		const { machines } = make("broken", () => ({ status: "cancelled" }));
		await writeFile(join(dir, "broken", "machines.json"), "{ nope");
		expect(() => machines.read()).toThrow("is not valid JSON");
	});
});
