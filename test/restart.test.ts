import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Harness, TaskId, TaskInspection } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	RestartCoordinator,
	consumeRestartMarker,
	writeRestartMarker,
} from "../src/restart.ts";

const dirs: string[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function markerPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pdc-restart-"));
	dirs.push(dir);
	return join(dir, "restart.json");
}

const taskId = (value: string) => value as unknown as TaskId;
const running = (value: string, owner?: string, conversationId = 1) =>
	({
		record: { id: taskId(value), kind: "pi.generation", conversationId, ...(owner === undefined ? {} : { owner: taskId(owner) }) },
		state: { kind: "running" },
	}) as unknown as TaskInspection;

/** `conversationOwners`: the task that created each conversation (a subagent tool owns its child's conversation). */
function fakeHarness(tasks: TaskInspection[], conversationOwners: Record<number, string> = {}): Pick<Harness, "inspect" | "commit"> {
	return {
		async inspect() {
			return { scheduling: "running", tasks: [...tasks], submissions: [] };
		},
		async commit(run: (tx: unknown) => unknown) {
			return run({
				conversation: async (id: number) => ({ id, ...(conversationOwners[id] === undefined ? {} : { owner: { conversationId: 1, taskId: taskId(conversationOwners[id]!) } }) }),
			});
		},
	} as unknown as Pick<Harness, "inspect" | "commit">;
}

function coordinator(path: string, options: { exit?: (code: number) => void; shutdown?: () => Promise<void> } = {}) {
	const logs: string[] = [];
	return {
		logs,
		restart: new RestartCoordinator({
			markerPath: path,
			log: {
				info: (message) => logs.push(message),
				warn: (message) => logs.push(message),
			},
			drainTimeoutMs: 80,
			closeGraceMs: 20,
			pollIntervalMs: 2,
			forcedSettleMs: 5,
			shutdown: options.shutdown ?? (async () => {}),
			exit: options.exit ?? (() => {}),
		}),
	};
}

describe("restart coordinator", () => {
	it("waits for other live tasks to drain, then exits", async () => {
		const path = await markerPath();
		const tasks: TaskInspection[] = [running("other")];
		let exited: number | undefined;
		const { restart, logs } = coordinator(path, { exit: (code) => { exited = code; } });
		restart.attach(fakeHarness(tasks));

		const request = restart.request("config change", taskId("restart-tool"));
		await delay(10);
		expect(exited).toBeUndefined();
		tasks.splice(0);

		await request;
		await delay(10);
		expect(exited).toBe(0);
		expect(logs).toContain("restart requested");
		expect(logs).toContain("restarting harness");
	});

	it("does not deadlock on the generation that owns the restart tool", async () => {
		const path = await markerPath();
		const tasks: TaskInspection[] = [running("generation"), running("restart-tool", "generation")];
		let exited: number | undefined;
		const { restart } = coordinator(path, { exit: (code) => { exited = code; } });
		restart.attach(fakeHarness(tasks));
		const cancel = withCancel(BACKGROUND_CONTEXT);

		await restart.request("config change", taskId("restart-tool"));
		const held = restart.afterTools(taskId("generation"), cancel.context);
		const heldResult = held.then(
			() => "resolved",
			(error: unknown) => error,
		);
		expect(exited).toBeUndefined();
		tasks.splice(1);
		await delay(10);
		expect(exited).toBe(0);
		cancel.cancel();
		expect(await heldResult).toBeInstanceOf(Error);
	});

	it("counts a tool task as paused once the work it started is paused (a subagent's child generation)", async () => {
		const path = await markerPath();
		// A generation runs a subagent tool; the tool waits on its child conversation (2), whose generation is live.
		const tasks: TaskInspection[] = [running("generation"), running("subagent-tool", "generation"), running("child", undefined, 2)];
		let exited: number | undefined;
		const { restart, logs } = coordinator(path, { exit: (code) => { exited = code; } });
		restart.attach(fakeHarness(tasks, { 2: "subagent-tool" }));
		const cancel = withCancel(BACKGROUND_CONTEXT);

		const request = restart.request("config change", taskId("restart-tool"));
		await delay(10);
		expect(exited, "the child has not paused yet").toBeUndefined();
		// The child reaches its tool boundary and pauses: the tool and its generation can do nothing more.
		const held = restart.afterTools(taskId("child"), cancel.context).catch(() => {});
		await request;
		await delay(20);
		expect(exited).toBe(0);
		expect(logs).not.toContain("restart drain timed out; forcing");
		cancel.cancel();
		await held;
	});

	it("pauses a generation at afterTools and releases it on abort", async () => {
		const path = await markerPath();
		const tasks: TaskInspection[] = [running("generation")];
		let exited: number | undefined;
		const { restart, logs } = coordinator(path, { exit: (code) => { exited = code; } });
		restart.attach(fakeHarness(tasks));
		const cancel = withCancel(BACKGROUND_CONTEXT);

		const request = restart.request("config change", taskId("restart-tool"));
		const held = restart.afterTools(taskId("generation"), cancel.context);
		const heldResult = held.then(
			() => "resolved",
			(error: unknown) => error,
		);

		await request;
		await delay(10);
		expect(exited).toBe(0);
		expect(logs).toContain("restart paused a generation at a tool boundary");
		cancel.cancel();
		expect(await heldResult).toBeInstanceOf(Error);
	});

	it("forces the restart when another task never reaches a boundary", async () => {
		const path = await markerPath();
		const tasks: TaskInspection[] = [running("stuck")];
		let exited: number | undefined;
		const { restart } = coordinator(path, { exit: (code) => { exited = code; } });
		restart.attach(fakeHarness(tasks));

		await restart.request("forced", taskId("restart-tool"));
		expect(exited).toBeUndefined();
		await delay(20);
		expect(exited).toBe(0);
	});

	it("acknowledges a second request while the first drain is pending", async () => {
		const path = await markerPath();
		const tasks: TaskInspection[] = [running("other")];
		let exited: number | undefined;
		const { restart } = coordinator(path, { exit: (code) => { exited = code; } });
		restart.attach(fakeHarness(tasks));

		const first = restart.request("first", taskId("restart-one"));
		const second = restart.request("second", taskId("restart-two"));
		await second;
		expect(exited).toBeUndefined();
		tasks.splice(0);
		await first;
		await delay(10);
		expect(exited).toBe(0);
	});
});

describe("restart marker", () => {
	it("writes owner-only and consumes the request", async () => {
		const path = await markerPath();
		writeRestartMarker(path, { requestedAt: "2026-11-04T22:00:00.000Z", pid: 42, reason: "test" });
		const info = await stat(path);
		expect(info.mode & 0o777).toBe(0o600);
		expect(consumeRestartMarker(path)).toEqual({
			marker: { requestedAt: "2026-11-04T22:00:00.000Z", pid: 42, reason: "test" },
		});
		expect(consumeRestartMarker(path)).toEqual({});
	});

	it("removes a malformed marker and reports the error", async () => {
		const path = await markerPath();
		await import("node:fs/promises").then((fs) => fs.writeFile(path, "not json", { mode: 0o600 }));
		const consumed = consumeRestartMarker(path);
		expect(consumed.error).toContain("Unexpected token");
		expect(consumeRestartMarker(path)).toEqual({});
	});
});

describe("restart tool", () => {
	it("is model-facing and standalone", () => {
		const { restart } = coordinator("unused");
		const [tool] = restart.extension().tools ?? [];
		expect(tool?.name).toBe("restart_harness");
		expect(tool?.callers).toEqual(["model"]);
		expect(tool?.replay).toBe("unsafe");
		const extension = restart.extension();
		expect(extension.hooks?.[0]?.task).toBe("pi.generation");
	});

	it("answers Restarted", async () => {
		const path = await markerPath();
		let exited: number | undefined;
		const { restart } = coordinator(path, { exit: (code) => { exited = code; } });
		restart.attach(fakeHarness([]));
		const [tool] = restart.extension().tools ?? [];
		const result = await tool!.execute!({}, {} as never, BACKGROUND_CONTEXT);
		expect(result.output).toEqual([{ type: "text", text: "Restarted" }]);
		await delay(10);
		expect(exited).toBe(0);
	});
});
