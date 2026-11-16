// A thread's prompt follows its files where that costs nothing (`fixed-prompt.ts`, `promptRefresh`). A model that
// takes a system message in the middle of a conversation is told of a changed AGENTS.md with the user's next message:
// the change is appended, and everything before it is sent as it was. Another model's prompt is rendered again when
// its cache has expired, and kept while it holds.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it } from "vitest";
import { cacheMissExtension, type CacheMiss } from "../src/cache-misses.ts";
import { workspaceContextExtension } from "../src/context.ts";
import { fixedPromptExtension, promptRefresh } from "../src/fixed-prompt.ts";
import { preambleExtension } from "../src/preamble.ts";
import { object } from "../src/schema.ts";

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const T0 = 1_000_000_000_000;
const min = 60_000;
const user = (text: string): Message => ({ role: "user", content: text, timestamp: T0 });
const answer = (usage: object, more: object = {}): Message =>
	({ ...fauxAssistantMessage("ok"), provider: "local", model: "m", timestamp: T0, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage }, ...more }) as Message;
const result: Message = { role: "toolResult", toolCallId: "c", toolName: "bash", content: [], isError: false, timestamp: T0 } as Message;

it("decides by what the model takes and whether its cache holds, and only at a user's message", () => {
	const takes = { provider: "local", id: "m", compat: { supportsMidConvoSystemMessages: true } };
	const plain = { provider: "local", id: "m", promptCache: { short: 300 } };
	const cached = [user("one"), answer({ cacheWrite: 5_000 }), user("two")];

	// A model that takes the message: told at a run's start and at a steer, never after a tool result.
	expect(promptRefresh(cached, takes, T0 + min)).toBe("update");
	expect(promptRefresh([...cached, answer({ cacheRead: 5_000 }), result], takes, T0 + min)).toBe("keep");
	expect(promptRefresh([...cached, answer({ cacheRead: 5_000 }), result, user("a steer")], takes, T0 + min)).toBe("update");
	// A system message at the end is not what the model answers: the user's message before it counts.
	expect(promptRefresh([...cached, { role: "system", content: "", timestamp: T0 } as Message], takes, T0 + min)).toBe("update");

	// Another model: kept while the cache holds, rendered again once it is known to have expired.
	expect(promptRefresh(cached, plain, T0 + 4 * min)).toBe("keep");
	expect(promptRefresh(cached, plain, T0 + 6 * min)).toBe("reload");
	expect(promptRefresh(cached, { ...plain, id: "another" }, T0 + min), "another model's cache is none of this one's").toBe("reload");
	expect(promptRefresh([...cached, answer({ cacheRead: 5_000 }), result], plain, T0 + 6 * min), "not in a run").toBe("keep");
	// Nothing says whether the provider caches: kept, and `/reload` is the way.
	expect(promptRefresh([user("one"), answer({ input: 5_000 }), user("two")], plain, T0 + 60 * min)).toBe("keep");
	expect(promptRefresh([user("one")], plain, T0 + 60 * min)).toBe("keep");
	expect(promptRefresh(cached, undefined, T0 + 60 * min)).toBe("keep");
});

async function setup(compat: object | undefined) {
	const dir = await mkdtemp(join(tmpdir(), "claw-prompt-refresh-"));
	dirs.push(dir);
	const home = join(dir, "home");
	await mkdir(home);
	await writeFile(join(home, "AGENTS.md"), "Rule one.");
	const faux = fauxProvider({ provider: "faux" });
	if (compat !== undefined) (faux.models[0] as { compat?: object }).compat = compat;
	const models = createModels();
	models.setProvider(faux.provider);
	const clock = { now: Date.now() };
	const slow = defineTool({ name: "noop", description: "Nothing.", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "done" }] }) });
	const registry = createRegistry();
	const missed: CacheMiss[] = [];
	for (const extension of [fixedPromptExtension({ models, now: () => clock.now }), preambleExtension(), defineExtension({ name: "noop", tools: [slow] }), workspaceContextExtension({ home }), cacheMissExtension((miss) => missed.push(miss))]) registry.install(extension);
	const sent: Message[][] = [];
	const replies: AssistantMessage[] = [];
	faux.setResponses(Array.from({ length: 20 }, () => (context: TranscriptContext) => (sent.push(JSON.parse(JSON.stringify(context.messages)) as Message[]), replies.shift() ?? fauxAssistantMessage("ok"))));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: home }), settings: { stream: { cacheRetention: "short" } } } as never, ctx);
	const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } } as never);
	const turn = async (text: string, ...reply: AssistantMessage[]) => {
		replies.push(...reply);
		await conversation.submit({ type: "input", content: text }, ctx);
		await conversation.waitForIdle(ctx);
	};
	const prompt = (request: number) => JSON.stringify(getCurrentSystemMessage(sent.at(request)!));
	return { harness, home, sent, turn, prompt, clock, missed };
}

it("a model that takes system messages mid-conversation is told of a changed AGENTS.md, after what is cached", { timeout: 60_000 }, async () => {
	const t = await setup({ supportsMidConvoSystemMessages: true });
	try {
		await t.turn("one");
		await t.turn("two");
		expect(t.sent[1]!.filter((message) => message.role === "system"), "nothing changed: nothing is added").toHaveLength(1);

		// Changed while a run's tools work: the run goes on with the prompt it has.
		const during = async () => void (await writeFile(join(t.home, "AGENTS.md"), "Rule two."));
		await during();
		await t.turn("three", fauxAssistantMessage([fauxToolCall("noop", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done"));
		const [first, afterTools] = [t.sent[2]!, t.sent[3]!];
		// The run's first request carries the update where the conversation is: after everything sent before, behind
		// the user's message, never behind a tool result.
		const updates = first.filter((message) => message.role === "system");
		expect(updates).toHaveLength(2);
		expect((updates[1] as { sections?: Record<string, string | null> }).sections).toEqual({ "global-agents": expect.stringContaining("Rule two.") });
		expect(first.map((message) => message.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user", "system"]);
		expect(JSON.stringify(first.slice(0, 4)), "what the request before sent is sent as it was").toBe(JSON.stringify(t.sent[1]));
		expect(t.prompt(2)).toContain("Rule two.");
		expect(t.prompt(2)).not.toContain("Rule one.");
		// The request after the tool round starts with the first, byte for byte: nothing is rendered again there.
		expect(JSON.stringify(afterTools.slice(0, first.length))).toBe(JSON.stringify(first));
		expect(afterTools.filter((message) => message.role === "system")).toHaveLength(2);

		// A file that is gone takes its section out; nothing else of the prompt moves.
		await rm(join(t.home, "AGENTS.md"));
		await t.turn("four");
		expect((t.sent.at(-1)!.filter((message) => message.role === "system").at(-1) as { sections?: object }).sections).toEqual({ "global-agents": null });
		// The provider's cache held over every update (`cache-misses.ts` checks the request after one).
		expect(t.missed).toEqual([]);
	} finally {
		await t.harness.close(ctx);
	}
});

it("another model keeps its prompt while the cache holds, and gets it rendered again once the cache has expired", { timeout: 60_000 }, async () => {
	const t = await setup(undefined);
	try {
		await t.turn("one");
		await t.turn("two");
		await writeFile(join(t.home, "AGENTS.md"), "Rule two.");
		await t.turn("three");
		expect(t.prompt(-1), "the cache holds: the prompt is kept").toContain("Rule one.");
		expect(t.sent.at(-1)!.filter((message) => message.role === "system")).toHaveLength(1);
		// Ten minutes on, the five-minute cache is gone: the whole context is paid for anyway.
		t.clock.now += 10 * min;
		await t.turn("four");
		expect(t.prompt(-1)).toContain("Rule two.");
		expect(t.prompt(-1)).not.toContain("Rule one.");
	} finally {
		await t.harness.close(ctx);
	}
});
