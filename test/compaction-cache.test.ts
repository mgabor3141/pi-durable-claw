// A compaction's summary is asked for on the conversation itself (`compaction.ts`), so the provider reads the
// conversation from its prompt cache: the summary request must start with the agent's own last request, byte for byte,
// and be sent with the same options. These run a real Harness against a provider that records what it is sent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTool, Harness, type Extension } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it } from "vitest";
import { cheaperFromTranscript, compactionExtension, type SummaryUsage } from "../src/compaction.ts";
import { COMPACTION_INLINE_PROMPT, COMPACTION_TOOL_REFUSED } from "../src/prompts.ts";
import { object } from "../src/schema.ts";
import { answerOf, T0 } from "./answers.ts";

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Sent = { readonly messages: readonly Message[]; readonly options: SimpleStreamOptions | undefined; readonly summary: boolean };

const textOf = (message: Message | undefined): string =>
	message === undefined || message.role === "assistant" ? "" : typeof message.content === "string" ? message.content : message.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("");
const asksForSummary = (messages: readonly Message[]) => messages.some((message) => message.role === "user" && textOf(message).startsWith(COMPACTION_INLINE_PROMPT));
/** What decides a cache entry besides the messages: the options a request is sent with. */
const cacheKeyOf = (options: SimpleStreamOptions | undefined) => ({ sessionId: options?.sessionId, cacheRetention: options?.cacheRetention, reasoning: (options as { reasoning?: unknown } | undefined)?.reasoning });

async function setup(extra: readonly Extension[] = []) {
	const dir = await mkdtemp(join(tmpdir(), "claw-compaction-cache-"));
	dirs.push(dir);
	const summaries: SummaryUsage[] = [];
	const gaveUp: string[] = [];
	const registry = createRegistry();
	for (const extension of [compactionExtension({ summarized: (summary) => summaries.push(summary), gaveUp: (_id, why) => gaveUp.push(why) }), ...extra]) registry.install(extension);
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const sent: Sent[] = [];
	const answers: ((sent: Sent) => AssistantMessage | undefined)[] = [];
	const replies: AssistantMessage[] = [];
	let onSummaryRequest: (() => void) | undefined;
	const step = (context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessage => {
		const request: Sent = { messages: JSON.parse(JSON.stringify(context.messages)) as Message[], options, summary: asksForSummary(context.messages) };
		sent.push(request);
		if (request.summary) {
			onSummaryRequest?.();
			return answers.shift()?.(request) ?? fauxAssistantMessage("## Goal\nsummarized");
		}
		return replies.shift() ?? fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 40 }, () => step));
	const storage = await openNodeSqliteStorage(join(dir, "durable.db"));
	const harness = await Harness.open(storage, { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }), settings: { stream: { cacheRetention: "long" } } } as never, ctx);
	const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id }, thinkingLevel: "high" } } as never);
	const turn = async (text: string, ...reply: AssistantMessage[]) => {
		replies.push(...reply);
		await conversation.submit({ type: "input", content: text }, ctx);
		await conversation.waitForIdle(ctx);
	};
	const entries = async () => (await conversation.entries({ order: "ascending" } as never, 500, undefined, ctx)).items;
	return { harness, conversation, sent, answers, replies, summaries, gaveUp, turn, entries, summaryRequested: () => new Promise<void>((resolve) => (onSummaryRequest = resolve)) };
}

// Messages long enough that a compaction has something to cut (it keeps the last 20k tokens), and that what it cuts
// is worth reading the context from the cache for (`cheaperFromTranscript`).
const long = "x".repeat(60_000);

it("asks for the summary with the agent's own request and one more message", { timeout: 60_000 }, async () => {
	const t = await setup();
	try {
		await t.turn("one" + long, fauxAssistantMessage("first" + long));
		await t.turn("two", fauxAssistantMessage("second" + long));
		const last = t.sent.at(-1)!;
		await t.conversation.compact("the tests", ctx);
		await t.conversation.waitForIdle(ctx);

		const summary = t.sent.at(-1)!;
		expect(summary.summary).toBe(true);
		expect(t.sent.filter((request) => request.summary)).toHaveLength(1);
		// The agent's last request, then its answer, then the question: nothing before the question differs.
		const shared = last.messages.length;
		expect(JSON.stringify(summary.messages.slice(0, shared)), "the same start, byte for byte").toBe(JSON.stringify(last.messages));
		expect(summary.messages).toHaveLength(shared + 2);
		expect(summary.messages[shared]).toMatchObject({ role: "assistant" });
		expect(textOf(summary.messages[shared + 1])).toBe(`${COMPACTION_INLINE_PROMPT}\n\nAdditional focus: the tests`);
		expect(summary.messages.filter((message) => message.role === "system")).toEqual(last.messages.filter((message) => message.role === "system"));
		// And the same options: another session, retention or thinking level is another cache entry.
		expect(cacheKeyOf(summary.options)).toEqual(cacheKeyOf(last.options));
		expect(cacheKeyOf(summary.options)).toMatchObject({ cacheRetention: "long", reasoning: "high" });
		expect(typeof summary.options?.sessionId).toBe("string");

		expect((await t.entries()).filter((entry) => entry.kind === "pi.compaction")).toHaveLength(1);
		expect(t.summaries).toHaveLength(1);
		expect(t.summaries[0]).toMatchObject({ requests: 1 });
		expect(t.gaveUp).toEqual([]);
		// The agent goes on from the summary.
		await t.turn("three", fauxAssistantMessage("third"));
		expect(JSON.stringify(t.sent.at(-1)!.messages)).toContain("## Goal\\nsummarized");
	} finally {
		await t.harness.close(ctx);
	}
});

it("answers a tool call the model makes instead, and asks again", { timeout: 60_000 }, async () => {
	const ran: string[] = [];
	const tool = defineTool({ name: "probe", description: "Probe.", parameters: object({}), execute: async () => (ran.push("probe"), { output: [{ type: "text" as const, text: "ran" }] }) });
	const t = await setup([defineExtension({ name: "probe", tools: [tool] })]);
	try {
		await t.turn("one" + long, fauxAssistantMessage("first" + long));
		await t.turn("two", fauxAssistantMessage("second" + long));
		t.answers.push(() => fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }));
		await t.conversation.compact(undefined, ctx);
		await t.conversation.waitForIdle(ctx);

		const asked = t.sent.filter((request) => request.summary);
		expect(asked).toHaveLength(2);
		expect(ran, "the call is not run").toEqual([]);
		expect(asked[1]!.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "probe", isError: true });
		expect(textOf(asked[1]!.messages.at(-1))).toBe(COMPACTION_TOOL_REFUSED);
		// The second request still starts with the first, so it is read from the cache the first wrote.
		expect(JSON.stringify(asked[1]!.messages.slice(0, asked[0]!.messages.length))).toBe(JSON.stringify(asked[0]!.messages));
		expect(t.summaries[0]).toMatchObject({ requests: 2 });
		const compaction = (await t.entries()).find((entry) => entry.kind === "pi.compaction");
		expect(JSON.stringify(compaction?.model)).toContain("## Goal\\nsummarized");
		// Nothing of the refused call is in the conversation.
		expect((await t.entries()).some((entry) => JSON.stringify(entry.model ?? "").includes(COMPACTION_TOOL_REFUSED))).toBe(false);
	} finally {
		await t.harness.close(ctx);
	}
});

it("falls back to the transcript summary when the model will not write one", { timeout: 60_000 }, async () => {
	const t = await setup();
	try {
		await t.turn("one" + long, fauxAssistantMessage("first" + long));
		await t.turn("two", fauxAssistantMessage("second" + long));
		for (let i = 0; i < 3; i++) t.answers.push(() => fauxAssistantMessage([fauxToolCall("nothing", {})], { stopReason: "toolUse" }));
		await t.conversation.compact(undefined, ctx);
		await t.conversation.waitForIdle(ctx);
		expect(t.sent.filter((request) => request.summary)).toHaveLength(3);
		expect(t.gaveUp).toEqual(["the model called tools instead of writing a summary"]);
		// The transcript summarizer's own request: its system prompt, the conversation as text.
		const fallback = t.sent.at(-1)!;
		expect(fallback.summary).toBe(false);
		expect(textOf(fallback.messages.at(-1))).toContain("[User]: one");
		expect(fallback.messages).toHaveLength(2);
		expect((await t.entries()).filter((entry) => entry.kind === "pi.compaction")).toHaveLength(1);
	} finally {
		await t.harness.close(ctx);
	}
});

it("summarizes while the thread works: up to the answer whose tools still run", { timeout: 60_000 }, async () => {
	let started!: () => void;
	const running = new Promise<void>((resolve) => (started = resolve));
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const tool = defineTool({
		name: "slow",
		description: "Slow.",
		parameters: object({}),
		execute: async () => {
			started();
			await held;
			return { output: [{ type: "text" as const, text: "slow done" }] };
		},
	});
	const t = await setup([defineExtension({ name: "slow", tools: [tool] })]);
	try {
		await t.turn("one" + long, fauxAssistantMessage("first" + long));
		await t.turn("two", fauxAssistantMessage("second" + long));
		t.replies.push(fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }), fauxAssistantMessage("after the tool"));
		await t.conversation.submit({ type: "input", content: "three" }, ctx);
		await running;
		const inFlight = t.sent.at(-1)!;
		const asked = t.summaryRequested();
		await t.conversation.compact(undefined, ctx);
		await asked;

		const summary = t.sent.at(-1)!;
		expect(summary.summary).toBe(true);
		// Exactly the request whose answer called the tool, and the question: the call without a result is left out.
		expect(JSON.stringify(summary.messages.slice(0, -1))).toBe(JSON.stringify(inFlight.messages));
		expect(JSON.stringify(summary.messages)).not.toContain('"toolCall"');

		release();
		await t.conversation.waitForIdle(ctx);
		const entries = await t.entries();
		expect(entries.filter((entry) => entry.kind === "pi.compaction")).toHaveLength(1);
		expect(JSON.stringify(entries.at(-1)?.model ?? entries.at(-2)?.model)).toContain("after the tool");
		// What was written while the summary was made is still in the context, after the summary.
		await t.turn("four", fauxAssistantMessage("fourth"));
		const next = JSON.stringify(t.sent.at(-1)!.messages);
		expect(next).toContain("## Goal\\nsummarized");
		expect(next).toContain("slow done");
		expect(next).toContain("after the tool");
	} finally {
		release();
		await t.harness.close(ctx);
	}
});

it("asks on the conversation only while its cache holds, and only when that is the cheaper way", () => {
	const model = { provider: "anthropic", id: "opus", promptCache: { short: 300, long: 3600 }, cost: { input: 5, cacheRead: 0.5 } };
	const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: T0 });
	const answer = (usage: object, more: object = {}): Message => answerOf(model, T0, usage, more);
	const summarized = [user("word ".repeat(60_000))];
	const hour = [user("a"), answer({ cacheWrite: 150_000, cacheWrite1h: 150_000 }), user("b"), answer({ cacheRead: 150_000 })];
	const five = [user("a"), answer({ cacheWrite: 150_000 }), user("b"), answer({ cacheRead: 150_000, cacheWrite: 900 })];
	const min = 60_000;

	// Within the lifetime the cache was written with; a read renews it, and the lifetime is the newest write's.
	expect(cheaperFromTranscript(hour, summarized, model, T0 + 58 * min)).toBeUndefined();
	expect(cheaperFromTranscript(hour, summarized, model, T0 + 61 * min)).toBe("the prompt cache has expired: 61 min since the last request, kept for 60");
	expect(cheaperFromTranscript(five, summarized, model, T0 + 3 * min)).toBeUndefined();
	expect(cheaperFromTranscript(five, summarized, model, T0 + 6 * min)).toBe("the prompt cache has expired: 6 min since the last request, kept for 5");
	// A model without lifetimes in its catalog entry: Anthropic's.
	expect(cheaperFromTranscript(five, summarized, { provider: "anthropic", id: "opus" }, T0 + 6 * min)).toMatch(/kept for 5$/);
	// No cache to read: nothing answered, a request that failed, another model's cache, a provider without one.
	expect(cheaperFromTranscript([user("a")], summarized, model, T0)).toMatch(/^no request of this context was answered yet/);
	expect(cheaperFromTranscript([...hour, user("c"), answer({ input: 0, output: 0 }, { stopReason: "error" })], summarized, model, T0 + min), "a failed request is not the last request").toBeUndefined();
	expect(cheaperFromTranscript(hour, summarized, { ...model, id: "sonnet" }, T0 + min)).toMatch(/^the last request went to another model/);
	expect(cheaperFromTranscript([user("a"), answer({ input: 150_000 })], summarized, model, T0 + min)).toBe("the last request used no prompt cache");
	// Almost nothing to summarize: its transcript costs less than a tenth of the whole context.
	expect(cheaperFromTranscript(hour, [user("a few words")], model, T0 + min)).toMatch(/^the part to summarize is small/);
});
