// Timers in codemode scripts (`codemode-timers.ts`): an agent that wrote `setTimeout` got a ReferenceError and fell back
// to `bash sleep`. A wait is a journaled host call, so it survives a restart without waiting twice.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Extension } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension, createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import { codemodeTimersExtension, timerGlobal, withTimers } from "../src/codemode-timers.ts";

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));
const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });

async function open(cwd: string) {
	const registry = createRegistry();
	registry.install(createCodemodeExtension({ sandbox, globals: [timerGlobal()] }) as Extension);
	registry.install(codemodeTimersExtension());
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(cwd, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, BACKGROUND_CONTEXT);
	return { harness, faux };
}

/** Runs one script as the model's codemode call; resolves with the result text the model gets. */
async function run(code: string, during?: (conversation: { abort(context: typeof BACKGROUND_CONTEXT): Promise<void> }) => Promise<void>): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pdc-timers-"));
	dirs.push(cwd);
	const { harness, faux } = await open(cwd);
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
		faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code } as never, { id: "c1" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
		await during?.(conversation);
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
		return resultText(await conversation.context(BACKGROUND_CONTEXT));
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

function resultText(context: { readonly messages: readonly unknown[] }): string {
	const result = context.messages.find((message) => (message as { role: string }).role === "toolResult") as { content: { type: string; text?: string }[] } | undefined;
	return result?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") ?? "";
}

describe("withTimers", () => {
	it("appends the timer functions only to a script that names one and declares none; the script's lines stay where they were", () => {
		expect(withTimers("return 1;")).toBe("return 1;");
		const code = '// @options: {"timeout_ms": 5000}\nawait new Promise((r) => setTimeout(r, 10));';
		const shimmed = withTimers(code);
		expect(shimmed.startsWith(`${code}\n`)).toBe(true);
		expect(shimmed).toContain("function clearInterval(");
		expect(withTimers("const setTimeout = (f) => f();\nsetTimeout(() => 1);")).toBe("const setTimeout = (f) => f();\nsetTimeout(() => 1);");
		expect(withTimers("function clearTimeout() {}\nsetTimeout(() => 1);")).toBe("function clearTimeout() {}\nsetTimeout(() => 1);");
	});

	it("the codemode tool's description says scripts have timers", () => {
		const wrap = codemodeTimersExtension().wraps![0]! as { wrap(tool: unknown): { description: string } };
		const description = wrap.wrap(createCodemodeTool({ sandbox })).description;
		expect(description).not.toContain("or timers");
		expect(description).toContain("`setTimeout` and `setInterval` wait in real time");
	});
});

it("setTimeout waits in real time, fires in deadline order, and clearTimeout and clearInterval stop timers", { timeout: 60_000 }, async () => {
	const started = Date.now();
	const text = await run(`
const t0 = Date.now();
await new Promise((resolve) => setTimeout(resolve, 300));
const waited = Date.now() - t0;
const order = [];
setTimeout(() => order.push("b"), 80);
setTimeout((name) => order.push(name), 20, "a");
const never = setTimeout(() => order.push("never"), 10);
clearTimeout(never);
setTimeout(() => order.push("zero"), 0);
let ticks = 0;
const interval = setInterval(() => { ticks++; if (ticks === 3) clearInterval(interval); }, 15);
await new Promise((resolve) => setTimeout(resolve, 200));
return JSON.stringify({ waited, order, ticks });`);
	expect(Date.now() - started).toBeGreaterThanOrEqual(500);
	const result = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { waited: number; order: string[]; ticks: number };
	expect(result.waited).toBeGreaterThanOrEqual(300);
	expect(result.order).toEqual(["zero", "a", "b"]);
	expect(result.ticks).toBe(3);
});

it("an agent's own sleep helper works, and a script with its own setTimeout keeps it", { timeout: 60_000 }, async () => {
	expect(await run("const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nawait sleep(50);\nreturn 'slept';")).toContain("slept");
	expect(await run("function setTimeout(callback) { callback(); return 0; }\nlet ran = false;\nsetTimeout(() => { ran = true; });\nreturn ran ? 'own' : 'shim';")).toContain("own");
});

it("an error in a timer's callback is reported on the console, and the script goes on", { timeout: 60_000 }, async () => {
	const text = await run("setTimeout(() => { throw new Error('boom in a timer'); }, 10);\nawait new Promise((resolve) => setTimeout(resolve, 50));\nreturn 'went on';");
	expect(text).toContain("boom in a timer");
	expect(text).toContain("went on");
});

it("Stop ends a script waiting on a long timer at once", { timeout: 60_000 }, async () => {
	const started = Date.now();
	await run("await new Promise((resolve) => setTimeout(resolve, 60_000));\nreturn 'woke';", async (conversation) => {
		await new Promise((resolve) => setTimeout(resolve, 300));
		await conversation.abort(BACKGROUND_CONTEXT);
	});
	expect(Date.now() - started).toBeLessThan(10_000);
});

it("a restart in the middle of a wait resumes it with the time that was left, not from the start", { timeout: 60_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pdc-timers-"));
	dirs.push(cwd);
	const first = await open(cwd);
	const started = Date.now();
	const conversation = await first.harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: first.faux.models[0]!.id } } });
	first.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: "await new Promise((resolve) => setTimeout(resolve, 2000));\nreturn 'woke';" } as never, { id: "c1" })], { stopReason: "toolUse" })]);
	await conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
	await new Promise((resolve) => setTimeout(resolve, 800));
	await first.harness.close(BACKGROUND_CONTEXT);

	const second = await open(cwd);
	try {
		second.faux.setResponses([fauxAssistantMessage("done")]);
		const resumed = await second.harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: second.faux.models[0]!.id } } });
		expect(resumed.id).toBe(conversation.id);
		await resumed.waitForIdle(BACKGROUND_CONTEXT);
		const elapsed = Date.now() - started;
		expect(resultText(await resumed.context(BACKGROUND_CONTEXT))).toContain("woke");
		// A wait issued again in full would end no sooner than 800 + 2000 ms after the start.
		expect(elapsed).toBeGreaterThanOrEqual(2000);
		expect(elapsed).toBeLessThan(2700);
	} finally {
		await second.harness.close(BACKGROUND_CONTEXT);
	}
});
