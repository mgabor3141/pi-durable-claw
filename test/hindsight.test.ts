// Long-term memory through Hindsight (`hindsight.ts`), against a fake Hindsight server that answers the endpoints the
// real client calls: recall for each message (stored with it, hidden), retain for each finished turn, and the tools.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { Hindsight, hindsightConfig, turnTranscript } from "../src/hindsight.ts";
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
	it("is the memories as dated lines in a <memories> block, searched with the message's start, with the key", async () => {
		const server = await fakeHindsight({
			"/memories/recall": () => ({
				json: { results: [{ id: "1", text: "The user prefers short answers.", type: "observation", mentioned_at: "2026-10-03T08:00:00Z" }, { id: "2", text: "The user\nlives in Budapest.", type: "world", occurred_start: "2026-01-01T00:00:00Z" }] },
			}),
		});
		const memory = new Hindsight({ url: server.url, bank: "gabor", apiKey: "secret-key" }, log().log);
		const block = await memory.recallFor({ threadId: "t", conversationId: 1 as never, text: `what do I like? ${"x".repeat(2_000)}`, signal: new AbortController().signal });
		expect(block).toBe("<memories>\nRecalled from long-term memory for this message. They may be out of date or not apply; the conversation wins where they disagree.\n- [2026-10-03] The user prefers short answers.\n- [2026-01-01] The user lives in Budapest.\n</memories>");
		const [recall] = server.seen;
		expect(recall).toMatchObject({ method: "POST", path: "/v1/default/banks/gabor/memories/recall", auth: "Bearer secret-key" });
		expect((recall!.body.query as string).length).toBe(800);
		expect(recall!.body).toMatchObject({ max_tokens: 1024, prefer_observations: true, budget: "mid" });
	});

	it("is nothing when nothing is recalled or the message is empty, and says so when memory cannot be searched", async () => {
		let status = 200;
		const server = await fakeHindsight({ "/memories/recall": () => ({ status, json: status === 200 ? { results: [] } : { detail: "database is down" } }) });
		const memory = new Hindsight({ url: server.url, bank: "b" }, log().log);
		const ask = (text: string) => memory.recallFor({ threadId: "t", conversationId: 1 as never, text, signal: new AbortController().signal });
		expect(await ask("hello")).toBeUndefined();
		expect(await ask("   ")).toBeUndefined();
		expect(server.seen).toHaveLength(1);
		status = 500;
		expect(await ask("hello")).toMatch(/^<memories>\nLong-term memory could not be searched for this message: .*database is down/);
	});
});

describe("a finished turn as Hindsight stores it", () => {
	it("is the people's messages and the agent's replies: no tool calls or results, no hidden memories or attachment lists", () => {
		const entries = [
			{ id: 1, kind: "app.user", data: { createdBy: "user" }, model: [{ role: "user", timestamp: 1000, content: [{ type: "text", text: "Plan my week." }, { type: "text", text: "<memories>\n- old\n</memories>", hidden: true }] }] },
			{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "c", name: "codemode", arguments: {} }] }] },
			{ id: 3, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "calendar dump" }] }] },
			{ id: 4, kind: "app.user", data: { createdBy: "agent" }, model: [{ role: "user", content: "Child report: done." }] },
			{ id: 5, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Here is your week." }] }] },
		] as unknown as EntryRecord[];
		expect(turnTranscript(entries)).toEqual({ text: "User: Plan my week.\n\nAnother agent: Child report: done.\n\nAgent: Here is your week.", startedAt: 1000 });
	});
});

it("each finished turn is stored once per turn, by document, and a failure to store is logged, never fatal", { timeout: 60_000 }, async () => {
	let status = 200;
	const server = await fakeHindsight({ "/memories": () => ({ status, json: status === 200 ? { success: true, bank_id: "b", items_count: 1, async: true } : { detail: "full" } }) });
	const { log: logger, warnings } = log();
	const memory = new Hindsight({ url: server.url, bank: "b" }, logger);
	const dir = await mkdtemp(join(tmpdir(), "claw-hindsight-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const registry = createRegistry();
	registry.install(defineExtension({ name: "tools", tools: [defineTool({ name: "look", description: "Look.", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "a secret tool output" }] }) })] }));
	registry.install(memory.extension());
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }) }, ctx);
	cleanups.push(() => harness.close(ctx));
	const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("look", {}, { id: "c1" })], { stopReason: "toolUse" }), fauxAssistantMessage("I looked."), fauxAssistantMessage("Second answer.")]);
	await conversation.submit({ type: "input", content: [{ type: "text", text: "Look around." }, { type: "text", text: "<memories>\n- recalled\n</memories>", hidden: true }] as never }, ctx);
	await conversation.waitForIdle(ctx);
	const retains = () => server.seen.filter((request) => request.path === "/v1/default/banks/b/memories");
	expect(retains()).toHaveLength(1);
	const [item] = retains()[0]!.body.items as { content: string; document_id: string; context: string }[];
	expect(item!.content).toBe("User: Look around.\n\nAgent: I looked.");
	expect(item!.document_id).toMatch(new RegExp(`^conversation-${conversation.id}-entry-\\d+$`));
	expect(retains()[0]!.body.async).toBe(true);

	status = 500;
	await conversation.submit({ type: "input", content: "Again." }, ctx);
	await conversation.waitForIdle(ctx);
	expect(retains()).toHaveLength(2);
	expect((retains()[1]!.body.items as { document_id: string }[])[0]!.document_id).not.toBe(item!.document_id);
	expect(warnings).toEqual(["memory: a turn was not stored"]);
	const context = await conversation.context(ctx);
	expect(context.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
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
	expect(memory.tools().map((candidate) => candidate.callers)).toEqual([["tools"], ["tools"], ["tools"]]);
});
