// Long-term memory through Hindsight (`hindsight.ts`), against a fake Hindsight server that answers the endpoints the
// real client calls: recall for each message (what the context does not hold yet), the memory step after each turn
// (notes from a copy of the conversation, stored as the turn's document), and the tools.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { Hindsight, harnessMemoryHost, hindsightConfig, notesConversation, RECALL_MIN_SCORE } from "../src/hindsight.ts";
import { MEMORY_NOTES_CONTEXT, MEMORY_NOTES_NO_TOOLS } from "../src/prompts.ts";
import { object } from "../src/schema.ts";

type Seen = { method: string; path: string; auth?: string; body: Record<string, unknown> };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => void (await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))));

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
}

/** A Hindsight server that answers `answers[path suffix]` and records every request. */
async function fakeHindsight(answers: Record<string, (seen: Seen) => { status?: number; json: unknown }>) {
	const seen: Seen[] = [];
	const server: Server = createServer(async (request, response) => {
		const entry: Seen = { method: request.method ?? "", path: request.url ?? "", body: await body(request), ...(request.headers.authorization === undefined ? {} : { auth: request.headers.authorization }) };
		seen.push(entry);
		const key = Object.keys(answers).find((suffix) => entry.path.endsWith(suffix));
		const answer = key === undefined ? { status: 404, json: { detail: "not found" } } : answers[key]!(entry);
		response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
		response.end(JSON.stringify(answer.json));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
	const port = (server.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}`, seen };
}

const log = () => {
	const warnings: string[] = [];
	return { warnings, log: { info: () => {}, warn: (message: string) => void warnings.push(message) } };
};

describe("hindsightConfig", () => {
	it("is off without HINDSIGHT_URL, and a malformed setting fails loudly", () => {
		expect(hindsightConfig({})).toBeUndefined();
		expect(hindsightConfig({ HINDSIGHT_URL: "  " })).toBeUndefined();
		expect(hindsightConfig({ HINDSIGHT_URL: "http://hindsight:8888/" })).toEqual({ url: "http://hindsight:8888", bank: "claw" });
		expect(hindsightConfig({ HINDSIGHT_URL: "https://m.example", HINDSIGHT_BANK: "gabor", HINDSIGHT_API_KEY: "k" })).toEqual({ url: "https://m.example", bank: "gabor", apiKey: "k" });
		expect(() => hindsightConfig({ HINDSIGHT_URL: "hindsight:8888" })).toThrow(/http\(s\)/);
		expect(() => hindsightConfig({ HINDSIGHT_URL: "not a url" })).toThrow(/not a URL/);
		expect(() => hindsightConfig({ HINDSIGHT_URL: "http://h", HINDSIGHT_BANK: "a/b" })).toThrow(/HINDSIGHT_BANK/);
	});
});

describe("recall for a message", () => {
	/** A context still holding entries 10 and 11; entry 10's message carries an earlier recall of `o-old`. */
	const view = {
		head: undefined,
		messages: [],
		contributions: [],
		entries: [
			{ id: 10, conversationId: 1, kind: "app.user", model: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "<memories>\n- old\n</memories>", hidden: true, shownAs: { name: "hindsight_recall", input: {} }, data: { memories: ["o-old"] } }] }] },
			{ id: 11, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }] },
		],
	};
	const host = { context: async () => view as never, notesModel: async () => undefined };
	const fact = (lastEntry: number) => ({ id: `f${lastEntry}`, text: "a fact", metadata: { lastEntry: String(lastEntry) } });

	it("is the observations the context does not hold yet, scored at least RECALL_MIN_SCORE, with why the others were left out", async () => {
		const server = await fakeHindsight({
			"/memories/recall": () => ({
				json: {
					results: [
						{ id: "o1", text: "The user prefers short answers.", type: "observation", mentioned_at: "2026-10-03T08:00:00Z", source_fact_ids: ["f3"], scores: { reranker: 0.8, final: 0.8 } },
						{ id: "o2", text: "Unrelated.", type: "observation", source_fact_ids: ["f3"], scores: { reranker: 0.005, final: 0.005 } },
						{ id: "o-old", text: "Recalled before.", type: "observation", source_fact_ids: ["f3"], scores: { reranker: 0.9, final: 0.9 } },
						{ id: "o3", text: "Said in this thread.", type: "observation", source_fact_ids: ["f11"], scores: { reranker: 0.5, final: 0.5 } },
						{ id: "o4", text: "The user\nlives in Budapest.", type: "observation", occurred_start: "2026-01-01T00:00:00Z", source_fact_ids: ["f11", "f4"], scores: { reranker: 0.4, final: 0.4 } },
						{ id: "o5", text: "No score.", type: "observation", scores: { reranker: null, final: 0.3 } },
					],
					source_facts: { f3: fact(3), f4: fact(4), f11: fact(11) },
				},
			}),
		});
		const memory = new Hindsight({ url: server.url, bank: "gabor", apiKey: "secret-key" }, log().log);
		memory.attach(host);
		const answer = await memory.recallFor({ threadId: "t", conversationId: 1 as never, text: `what do I like? ${"x".repeat(2_000)}`, signal: new AbortController().signal });
		expect(answer?.shownAs.name).toBe("hindsight_recall");
		expect(answer?.shownAs.input).toEqual({ query: `what do I like? ${"x".repeat(784)}` });
		expect(answer?.text).toBe(
			"<memories>\nRecalled from long-term memory for this message. They may be out of date or not apply; the conversation wins where they disagree.\n- [2026-10-03] The user prefers short answers.\n- [2026-01-01] The user lives in Budapest.\n- No score.\n</memories>",
		);
		expect(answer?.data).toEqual({ memories: ["o1", "o4", "o5"] });
		expect(answer?.shownAs.details).toBe(
			[
				"1. score 0.80 · 1 source",
				"2. score 0.40 · 2 sources, 1 in this thread's context",
				"3. no score · 0 sources",
				"",
				`Left out: 1 scored below ${RECALL_MIN_SCORE} (0.005); 1 recalled earlier and still in this thread's context; 1 drawn only from turns still in this thread's context.`,
			].join("\n"),
		);
		const [recall] = server.seen;
		expect(recall).toMatchObject({ method: "POST", path: "/v1/default/banks/gabor/memories/recall", auth: "Bearer secret-key" });
		expect((recall!.body.query as string).length).toBe(800);
		expect(recall!.body).toMatchObject({ types: ["observation"], max_tokens: 1024, budget: "mid", include: { source_facts: {} } });
	});

	it("is nothing when nothing new is recalled or the message is empty, and says so when memory cannot be searched", async () => {
		let status = 200;
		const server = await fakeHindsight({
			"/memories/recall": () => ({ status, json: status === 200 ? { results: [{ id: "o-old", text: "Recalled before.", type: "observation", scores: { reranker: 0.9 } }] } : { detail: "database is down" } }),
		});
		const memory = new Hindsight({ url: server.url, bank: "b" }, log().log);
		memory.attach(host);
		const ask = (text: string) => memory.recallFor({ threadId: "t", conversationId: 1 as never, text, signal: new AbortController().signal });
		expect(await ask("hello")).toBeUndefined();
		expect(await ask("   ")).toBeUndefined();
		expect(server.seen).toHaveLength(1);
		status = 500;
		expect((await ask("hello"))?.text).toMatch(/^<memories>\nLong-term memory could not be searched for this message: .*database is down/);
	});
});

describe("the memory step's copy of the conversation", () => {
	const system = { role: "system", content: "You are an agent.", timestamp: 0 } as Message;
	const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as Message;
	const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as Message;
	const result = (text: string) => ({ role: "toolResult", toolCallId: "c", toolName: "t", content: [{ type: "text", text }], isError: false, timestamp: 0 }) as Message;
	const big = "x".repeat(4_000);

	it("keeps the prompt, drops the oldest turns to fit, and starts at a user message", () => {
		const messages = [system, user(`old ${big}`), said("ok"), result(big), user("middle"), said("fine"), user("latest"), said("done")];
		const sizes = messages.map((message) => Math.ceil(JSON.stringify(message).length / 4));
		// A window the newest turns fit but the oldest does not: 0.85 of it, less the answer's 2,048, is the budget.
		const window = Math.ceil((sizes.reduce((sum, size) => sum + size, 0) - sizes[1]! + 2_048) / 0.85) + 10;
		expect(notesConversation(messages, { contextWindow: window, input: ["text"] }, 6)).toEqual([system, user("middle"), said("fine"), user("latest"), said("done")]);
		expect(notesConversation(messages, { contextWindow: 1_000_000, input: ["text"] }, 6)).toEqual(messages);
		// Too small for even the latest turn and the answer.
		expect(notesConversation(messages, { contextWindow: 2_000, input: ["text"] }, 6)).toBeUndefined();
	});

	it("tells a model that reads no images that there was one", () => {
		const withImage = { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 } as Message;
		expect(notesConversation([withImage], { contextWindow: 1_000_000, input: ["text"] }, 0)).toEqual([{ ...withImage, content: [{ type: "text", text: "look" }, { type: "text", text: "[an image]" }] }]);
		expect(notesConversation([withImage], { contextWindow: 1_000_000, input: ["text", "image"] }, 0)).toEqual([withImage]);
	});
});

it("after each turn, a copy of the conversation is asked what to remember; the notes, or nothing, are stored as the turn's document", { timeout: 60_000 }, async () => {
	let status = 200;
	const server = await fakeHindsight({ "/memories": () => ({ status, json: status === 200 ? { success: true, bank_id: "b", items_count: 1, async: true } : { detail: "full" } }) });
	const { log: logger, warnings } = log();
	const memory = new Hindsight({ url: server.url, bank: "b" }, logger);
	const dir = await mkdtemp(join(tmpdir(), "claw-hindsight-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const registry = createRegistry();
	registry.install(defineExtension({ name: "tools", tools: [defineTool({ name: "look", description: "Look.", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "a tool output" }] }) })] }));
	registry.install(memory.extension());
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }) }, ctx);
	cleanups.push(() => harness.close(ctx));
	memory.attach(harnessMemoryHost(harness, () => undefined));
	const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
	const asked: Message[][] = [];
	const notes = (text: string) => (context: { messages: readonly Message[] }) => {
		asked.push([...context.messages]);
		return fauxAssistantMessage(text);
	};
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("look", {}, { id: "c1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("I looked."),
		// The memory step: a tool call is turned down, then the notes.
		(context) => (asked.push([...context.messages]), fauxAssistantMessage([fauxToolCall("look", {}, { id: "c2" })], { stopReason: "toolUse" })),
		notes("The user likes tea."),
	]);
	await conversation.submit({ type: "input", content: [{ type: "text", text: "Look around." }, { type: "text", text: "<memories>\n- recalled\n</memories>", hidden: true }] as never }, ctx);
	await conversation.waitForIdle(ctx);
	await memory.settled();
	// The copy is the conversation as the model saw it, then the memory step's message; nothing was written to it.
	const prompt = asked[0]!.at(-1) as { role: string; content: { text: string }[] };
	expect(prompt.role).toBe("user");
	expect(prompt.content[0]!.text).toContain('from the message that begins "Look around."');
	expect(JSON.stringify(asked[0])).toContain("a tool output");
	expect(asked[1]!.slice(-2)).toMatchObject([{ role: "assistant", content: [{ type: "toolCall", id: "c2" }] }, { role: "toolResult", toolCallId: "c2", isError: true, content: [{ text: MEMORY_NOTES_NO_TOOLS }] }]);
	expect((await conversation.context(ctx)).messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "I looked." }] });
	const retains = () => server.seen.filter((request) => request.path === "/v1/default/banks/b/memories");
	expect(retains()).toHaveLength(1);
	const [item] = retains()[0]!.body.items as { content: string; document_id: string; context: string; metadata: Record<string, string> }[];
	expect(item!.content).toBe("The user likes tea.");
	expect(item!.context).toBe(MEMORY_NOTES_CONTEXT);
	expect(item!.document_id).toBe(`conversation-${conversation.id}-entry-${item!.metadata.firstEntry}`);
	expect(Number(item!.metadata.lastEntry)).toBeGreaterThan(Number(item!.metadata.firstEntry));
	expect(retains()[0]!.body.async).toBe(true);

	// Nothing worth remembering: nothing is stored.
	faux.setResponses([fauxAssistantMessage("Hi."), notes("NOTHING")]);
	await conversation.submit({ type: "input", content: "Hello." }, ctx);
	await conversation.waitForIdle(ctx);
	await memory.settled();
	expect(retains()).toHaveLength(1);

	// A failure to store is logged, never fatal.
	status = 500;
	faux.setResponses([fauxAssistantMessage("Noted."), notes("The user moved to Vienna.")]);
	await conversation.submit({ type: "input", content: "I moved." }, ctx);
	await conversation.waitForIdle(ctx);
	await memory.settled();
	expect(retains()).toHaveLength(2);
	expect(warnings).toEqual(["memory: a turn was not stored"]);
});

it("the tools recall, save and reflect in the configured bank", async () => {
	const server = await fakeHindsight({
		"/memories/recall": () => ({ json: { results: [{ id: "1", text: "Likes tea.", mentioned_at: "2026-11-01T00:00:00Z" }] } }),
		"/memories": () => ({ json: { success: true, bank_id: "b", items_count: 1, async: true } }),
		"/reflect": () => ({ json: { text: "Probably tea." } }),
	});
	const memory = new Hindsight({ url: server.url, bank: "b" }, log().log);
	const tool = (name: string) => memory.tools().find((candidate) => candidate.name === name)!;
	const run = async (name: string, args: unknown) => ((await tool(name).execute(args as never, {} as never, ctx)) as { output: { text: string }[] }).output[0]!.text;
	expect(await run("hindsight_recall", { query: "drinks" })).toBe("- [2026-11-01] Likes tea.");
	expect(await run("hindsight_retain", { content: "Likes tea.", context: "from a note" })).toBe("Saved to long-term memory.");
	expect(await run("hindsight_reflect", { query: "What would they drink?" })).toBe("Probably tea.");
	expect(server.seen.map((request) => request.path)).toEqual(["/v1/default/banks/b/memories/recall", "/v1/default/banks/b/memories", "/v1/default/banks/b/reflect"]);
	// The tool searches observations only, as the recall for each message does.
	expect((server.seen[0]!.body as { types?: string[] }).types).toEqual(["observation"]);
	expect(memory.tools().map((candidate) => candidate.callers)).toEqual([["tools"], ["tools"], ["tools"]]);
});
