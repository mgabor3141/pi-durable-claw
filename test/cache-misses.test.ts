// A request that should have read the provider's prompt cache and did not is logged (`cache-misses.ts`): the cache was
// written by the request before, to the same model, within its lifetime, and nothing rewrote the request's start.
// The rule over made-up usage first, then a real Harness against a provider that counts its cache by the prompt's start.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, type EntryRecord } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it } from "vitest";
import { cacheMissExtension, cacheMissOf, type CacheMiss } from "../src/cache-misses.ts";

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const model = { provider: "anthropic", id: "opus", promptCache: { short: 300, long: 3600 } };
const T0 = 1_000_000_000_000;
const min = 60_000;
const answer = (at: number, usage: object, more: object = {}): AssistantMessage =>
	({ ...fauxAssistantMessage("ok"), provider: "anthropic", model: "opus", timestamp: at, usage: { input: 10, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage }, ...more }) as AssistantMessage;
let nextId = 1;
const entry = (kind: string, message?: Message): EntryRecord => ({ id: nextId++, conversationId: 1, kind, ...(message === undefined ? {} : { model: [message] }) }) as unknown as EntryRecord;
/** The entries before a response, newest first, as the hook reads them. */
const before = (...entries: EntryRecord[]) => entries.reverse();
const of = (response: AssistantMessage, entries: EntryRecord[], m: Parameters<typeof cacheMissOf>[2] = model) => cacheMissOf(response, entries, m, 7 as never);

it("a miss is a request that read little of what the one before it sent, while the cache held it", () => {
	const first = entry("pi.assistant", answer(T0, { cacheWrite: 100_000, cacheWrite1h: 100_000 }));
	const tool = entry("pi.tool-result", { role: "toolResult", toolCallId: "c", toolName: "bash", content: [], isError: false, timestamp: T0 + 1 } as Message);

	// Read from the cache, with a little more written after it: no miss.
	expect(of(answer(T0 + min, { cacheRead: 100_010, cacheWrite: 2_000 }), before(first, tool))).toBeUndefined();
	// Nothing read ten minutes later, in a cache kept an hour: a miss, with what it cost.
	expect(of(answer(T0 + 10 * min, { cacheRead: 0, cacheWrite: 102_000, cacheWrite1h: 102_000 }), before(first, tool))).toEqual({
		conversationId: 7 as never,
		model: "anthropic/opus",
		expected: 100_010,
		cacheRead: 0,
		cacheWrite: 102_000,
		input: 10,
		sinceLastRequestS: 600,
		lifetimeS: 3600,
	} satisfies CacheMiss);
	// Only the system prompt and tools read (the messages changed): a miss too.
	expect(of(answer(T0 + min, { cacheRead: 12_000, cacheWrite: 90_000 }), before(first, tool))?.cacheRead).toBe(12_000);

	// Not a miss: the cache had expired (five minutes, here), or was another model's, or the provider has none.
	const short = entry("pi.assistant", answer(T0, { cacheWrite: 100_000 }));
	expect(of(answer(T0 + 4 * min, { cacheWrite: 100_000 }), before(short))?.lifetimeS).toBe(300);
	expect(of(answer(T0 + 6 * min, { cacheWrite: 100_000 }), before(short))).toBeUndefined();
	expect(of(answer(T0 + min, { cacheWrite: 100_000 }), before(first), { ...model, id: "sonnet" })).toBeUndefined();
	expect(of(answer(T0 + min, { input: 100_000 }), before(entry("pi.assistant", answer(T0, { input: 100_000 }))))).toBeUndefined();
	// Not a miss: the first request after a compaction or a rewritten system prompt, whose start is new on purpose.
	expect(of(answer(T0 + min, { cacheRead: 12_000, cacheWrite: 30_000 }), before(first, entry("pi.compaction", { role: "user", content: "summary", timestamp: T0 + 2 })))).toBeUndefined();
	expect(of(answer(T0 + min, { cacheWrite: 100_000 }), before(first, entry("pi.system", { role: "system", content: "", timestamp: T0 + 2 } as Message)))).toBeUndefined();
	// A model that takes a system message in the middle of a conversation is sent the change in place, so the cache
	// must hold over it: a miss there is a miss. A tool change needs the same of the model for tools.
	const takes = { ...model, compat: { supportsMidConvoSystemMessages: true } };
	const update = entry("pi.system", { role: "system", content: "", sections: { "global-agents": "Rule two." }, timestamp: T0 + 2 } as Message);
	expect(of(answer(T0 + min, { cacheWrite: 100_000 }), before(first, update), takes)?.expected).toBe(100_010);
	expect(of(answer(T0 + min, { cacheRead: 100_010, cacheWrite: 900 }), before(first, update), takes)).toBeUndefined();
	const tools = entry("pi.system", { role: "system", content: "", toolsAdded: [{ name: "t" }], timestamp: T0 + 2 } as unknown as Message);
	expect(of(answer(T0 + min, { cacheWrite: 100_000 }), before(first, tools), takes), "the tools the request starts with changed").toBeUndefined();
	expect(of(answer(T0 + min, { cacheWrite: 100_000 }), before(first, tools), { ...model, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } })?.expected).toBe(100_010);
	// Not a miss: the first request of a conversation, and a request that failed (nothing was counted).
	expect(of(answer(T0, { cacheWrite: 100_000 }), [])).toBeUndefined();
	expect(of(answer(T0 + min, { input: 0, output: 0 }, { stopReason: "error" }), before(first))).toBeUndefined();
	// A failed request in between is not the request before: the one that was answered is.
	expect(of(answer(T0 + 2 * min, { cacheWrite: 100_000 }), before(first, entry("pi.assistant", answer(T0 + min, { input: 0, output: 0 }, { stopReason: "error" }))))?.expected).toBe(100_010);
});

it("a Harness tells of a request whose start changed, and of no other", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "claw-cache-misses-"));
	dirs.push(dir);
	const missed: CacheMiss[] = [];
	let rewrite = false;
	const registry = createRegistry();
	registry.install(cacheMissExtension((miss) => missed.push(miss)));
	// Something that changes the first message of a request: what breaks a cache.
	registry.install(
		defineExtension({
			name: "rewriter",
			hooks: [hook(GenerationTask, { beforeRequest: ({ messages }) => (rewrite ? { messages: messages.map((message, index) => (index === 0 && message.role === "user" ? { ...message, content: "changed " + "y".repeat(8_000) } : message)) } : undefined) })],
		}),
	);
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 10 }, () => () => fauxAssistantMessage("answer " + "x".repeat(4_000))));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }), settings: { stream: { cacheRetention: "long" } } } as never, ctx);
	try {
		const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } } as never);
		const turn = async (text: string) => {
			await conversation.submit({ type: "input", content: text }, ctx);
			await conversation.waitForIdle(ctx);
		};
		await turn("one " + "z".repeat(8_000));
		await turn("two");
		await turn("three");
		expect(missed, "each request starts with the one before it").toEqual([]);
		rewrite = true;
		await turn("four");
		expect(missed).toHaveLength(1);
		expect(missed[0]).toMatchObject({ conversationId: conversation.id, model: `faux/${faux.models[0]!.id}` });
		expect(missed[0]!.cacheRead).toBeLessThan(missed[0]!.expected * 0.9);
		// The changed start is the cache's now: the next request reads it.
		await turn("five");
		expect(missed).toHaveLength(1);
	} finally {
		await harness.close(ctx);
	}
});
