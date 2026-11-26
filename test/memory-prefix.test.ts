// What the memory step sends a prefix-caching engine (pi's openai-completions over HTTP, a DeepSeek-style model from
// models.json, whose engine starts a thinking prompt with its reasoning effort): the thread's own next request, so the
// engine reads only the ask; never a request that would read the thread again.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { str } from "@earendil-works/pi-schema";
import { afterEach, expect, it } from "vitest";
import { fixedPromptExtension } from "../src/fixed-prompt.ts";
import { HARNESS_SETTINGS } from "../src/harness.ts";
import { Hindsight, harnessMemoryHost } from "../src/hindsight.ts";
import { preambleExtension } from "../src/preamble.ts";
import { object } from "../src/schema.ts";
import { type Answer, PrefixEngine, type Request } from "./fixtures/prefix-engine.ts";

const ctx = BACKGROUND_CONTEXT;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const isMemoryStep = (request: Request) => request.messages.at(-1)!.includes("Memory step.");
const mode = (request: Request) => {
	const { thinking, effort } = JSON.parse(request.tools) as { thinking: unknown; effort: unknown };
	return { thinking, effort };
};

type Setup = {
	readonly compat?: Record<string, unknown>;
	readonly promptCache?: { short?: number; long?: number };
	/** The memory step's answer; it may be held back. */
	readonly notes?: () => Answer | Promise<Answer>;
	/** How far the harness's clock runs ahead of the one answers are stamped with. */
	readonly clockAheadMs?: number;
};

async function setup(options: Setup = {}) {
	const dir = await mkdtemp(join(tmpdir(), "claw-memory-prefix-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	// The thread: one tool call, then an answer, for each message; reasoning on both, as DeepSeek writes it.
	const engine = new PrefixEngine((messages) => {
		if (JSON.stringify(messages.at(-1)?.content ?? "").includes("Memory step.")) return options.notes?.() ?? { text: "The user likes tea." };
		return messages.at(-1)?.role === "tool" ? { reasoning: "done thinking", text: "done" } : { reasoning: "let me note it", call: { name: "note", args: { text: "x" } } };
	});
	const baseUrl = await engine.start();
	cleanups.push(() => engine.close());
	await writeFile(join(dir, "auth.json"), "{}");
	const model = (id: string) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 32_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(options.promptCache === undefined ? {} : { promptCache: options.promptCache }) });
	await writeFile(
		join(dir, "models.json"),
		JSON.stringify({ providers: { local: { baseUrl, api: "openai-completions", apiKey: "k", compat: { sendSessionAffinityHeaders: true, thinkingFormat: "deepseek", supportsReasoningEffort: true, ...options.compat }, models: [model("engine"), model("engine-small")] } } }),
	);
	const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "store.json") });
	const retained: { content: string; documentId?: string }[] = [];
	const client = {
		getVersion: async () => ({}),
		recall: async () => ({ results: [] }),
		retain: async (_bank: string, content: string, retain: { documentId?: string }) => (retained.push({ content, ...(retain.documentId === undefined ? {} : { documentId: retain.documentId }) }), {}),
	};
	const logs: string[] = [];
	const memory = new Hindsight({ url: "http://unused", bank: "b" }, { info: (message) => logs.push(message), warn: (message) => logs.push(message) }, client as never);
	cleanups.push(async () => memory.close());
	const registry = createRegistry();
	const note = defineTool({ name: "note", description: "Note.", parameters: object({ text: str() }), execute: async () => ({ output: [{ type: "text" as const, text: "noted" }] }) });
	for (const extension of [fixedPromptExtension({ models: runtime as never }), preambleExtension(), defineExtension({ name: "tools", tools: [note] }), memory.extension()]) registry.install(extension);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models: runtime as never, registry, env: () => new NodeExecutionEnv({ cwd: dir }), settings: HARNESS_SETTINGS, ...(options.clockAheadMs === undefined ? {} : { now: () => Date.now() + options.clockAheadMs! }) }, ctx);
	cleanups.push(() => harness.close(ctx));
	memory.attach(harnessMemoryHost(harness));
	const thread = await harness.root(ctx, { agent: { model: { provider: "local", modelId: "engine" }, thinkingLevel: "high" } } as never);
	const turn = async (text: string) => {
		await thread.submit({ type: "input", content: text }, ctx);
		await thread.waitForIdle(ctx);
	};
	return { engine, memory, thread, turn, retained, logs };
}

/** Each memory step against the thread's request before it: the state that request left is what the engine holds. */
function steps(requests: readonly Request[]) {
	return requests.flatMap((request, index) => {
		if (!isMemoryStep(request)) return [];
		const last = requests.slice(0, index).findLast((earlier) => !isMemoryStep(earlier))!;
		return [{ request, last, continues: PrefixEngine.common(request, last) === PrefixEngine.held(last), added: request.messages.length - last.state.length }];
	});
}

for (const [name, compat, role] of [
	["a model without mid-conversation system messages is asked in a user message", {}, "user"],
	["a model that takes a system message mid-conversation is asked in one", { supportsMidConvoSystemMessages: true }, "system"],
] as const) {
	it(`the memory step is the thread's own next request: same model, thinking and session, all of it cached but the ask; ${name}`, { timeout: 60_000 }, async () => {
		const { engine, memory, turn, retained } = await setup({ compat });
		await turn("one");
		await memory.settled();
		await turn("two");
		await memory.settled();
		const found = steps(engine.requests);
		expect(found).toHaveLength(2);
		for (const { request, last, continues, added } of found) {
			expect(mode(request), "the thinking mode and effort lead the prompt").toEqual(mode(last));
			expect(mode(request)).toEqual({ thinking: { type: "enabled" }, effort: "high" });
			expect(request.session).toBe(last.session);
			expect(continues, "it continues the state the thread's last request left").toBe(true);
			expect(added, "and adds only the ask").toBe(1);
			expect(JSON.parse(request.messages.at(-1)!).role).toBe(role);
		}
		expect(retained.map((item) => item.content)).toEqual(["The user likes tea.", "The user likes tea."]);
	});
}

it("the thread's next request stops a step in flight; the next answer's step asks about both turns, stored under the first turn's name", { timeout: 60_000 }, async () => {
	let release: (() => void) | undefined;
	let held = 0;
	const { engine, memory, thread, turn, retained, logs } = await setup({
		notes: async () => {
			// The first step is held until the thread has gone on; the next one answers at once.
			if (held++ === 0) await new Promise<void>((resolve) => (release = resolve));
			return { text: "The user likes tea." };
		},
	});
	await turn("one");
	await expect.poll(() => release !== undefined).toBe(true);
	await turn("two");
	release!();
	await memory.settled();
	const found = steps(engine.requests);
	expect(found).toHaveLength(2);
	expect(found.every((step) => step.continues && step.added === 1)).toBe(true);
	expect(found[1]!.request.messages.at(-1)).toContain('the latest 2 turns of the conversation above, from the message that begins \\"one\\"');
	expect(logs).toContain("memory: the thread went on before its turn was written; the next answer's memory step asks about it");
	// One document for both turns, named after the first: had the first step finished, the second would replace it.
	expect(retained).toEqual([{ content: "The user likes tea.", documentId: expect.stringMatching(/^conversation-\d+-entry-\d+$/u) }]);
	const firstEntry = (await thread.entries({ order: "ascending" } as never, 1, undefined, ctx)).items[0]!.id;
	expect(retained[0]!.documentId).toBe(`conversation-${thread.id}-entry-${firstEntry}`);
});

it("no step is sent while the provider's cache is known not to hold the thread; its turns wait for an answer", { timeout: 60_000 }, async () => {
	// A cache kept for a second: by the time a run has answered it is taken as expired.
	const { engine, memory, turn, retained, logs } = await setup({ promptCache: { short: 1, long: 1 } });
	await turn("one");
	await memory.settled();
	await turn("two");
	await memory.settled();
	expect(engine.requests.filter(isMemoryStep)).toEqual([]);
	expect(retained).toEqual([]);
	expect(logs.filter((line) => line.startsWith("memory: the prompt cache does not hold the thread"))).toHaveLength(2);
});

it("an engine that reports cache reads and has no lifetime in models.json gets its step however long the answer took", { timeout: 60_000 }, async () => {
	// Ten minutes after the answer started, by the harness's clock: past the five minutes guessed for Anthropic.
	const { engine, memory, turn, retained } = await setup({ clockAheadMs: 10 * 60_000 });
	await turn("one");
	await memory.settled();
	await turn("two");
	await memory.settled();
	const found = steps(engine.requests);
	expect(found).toHaveLength(2);
	expect(found.every((step) => step.continues && step.added === 1)).toBe(true);
	expect(retained).toHaveLength(2);
});
