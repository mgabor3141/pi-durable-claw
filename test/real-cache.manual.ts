// Manual check against a real provider (not part of the suite): node --experimental-strip-types test/real-cache.manual.ts <piDir> [model]
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, type ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ConversationCacheRetention } from "../src/cache-retention.ts";
import { compactionExtension } from "../src/compaction.ts";
import { object } from "../src/schema.ts";

const ctx = BACKGROUND_CONTEXT;
const piDir = process.argv[2]!;
const modelId = process.argv[3] ?? "claude-haiku-4-5";
const models = await ModelRuntime.create({ authPath: join(piDir, "auth.json"), modelsPath: join(piDir, "models.json"), modelsStorePath: join(piDir, "models-store.json") });
if (process.argv[3] === "list") {
	console.log((await models.getAvailable()).filter((m: { provider: string }) => m.provider === "anthropic").map((m: { id: string }) => m.id).join(" "));
	process.exit(0);
}
const persons = new Set<ConversationId>();
const retention = new ConversationCacheRetention((id) => (persons.has(id) ? "long" : undefined));
const names = new Map<ConversationId, string>();
const show = (label: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }) =>
	console.log(`${label.padEnd(34)} input=${u.input} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} (1h: ${u.cacheWrite1h ?? 0}) output=${u.output}`);
const registry = createRegistry();
registry.install(compactionExtension({ summarized: (s) => show(`  SUMMARY ${names.get(s.conversationId)} (${s.requests} req)`, s.usage), gaveUp: (id, why) => console.log(`  GAVE UP ${names.get(id)}: ${why}`) }));
registry.install(retention.extension());
registry.install(
	defineExtension({
		name: "probe",
		tools: [defineTool({ name: "note", description: "Save a short note.", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "saved" }] }) })],
		hooks: [hook(GenerationTask, { afterResponse: (message, api) => show(`  ${names.get(api.conversationId)} ${message.stopReason}${message.errorMessage ? " " + message.errorMessage.slice(0, 200) : ""}`, message.usage) })],
	}),
);
const dir = await mkdtemp(join(tmpdir(), "claw-real-cache-"));
const harness = await Harness.open(
	await openNodeSqliteStorage(join(dir, "durable.db")),
	{ models: retention.models(models as never), registry, env: () => new NodeExecutionEnv({ cwd: dir }), settings: { compaction: { keepRecentTokens: 1500 }, retry: { enabled: false } } } as never,
	ctx,
);
// Text that is long and not repetitive, so it is real tokens: about 9k tokens a block.
const filler = (seed: number) => Array.from({ length: 4500 }, (_, i) => ((i * 7919 + seed * 104729) % 99991).toString(36)).join(" ");
const make = async (name: string, person: boolean) => {
	const id = await harness.commit(async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id, ctx);
	const conversation = (await harness.conversation(id, ctx))!;
	await conversation.configure({ model: { provider: "anthropic", modelId }, instructions: "You are a terse test assistant. Answer in one short sentence and never call tools unless asked." } as never, ctx);
	names.set(id, name);
	if (person) persons.add(id);
	return conversation;
};
const turn = async (conversation: Awaited<ReturnType<typeof make>>, text: string) => {
	await conversation.submit({ type: "input", content: text }, ctx);
	await conversation.waitForIdle(ctx);
};
try {
	console.log(`model ${modelId}`);
	for (const [name, person] of [["person", true], ["child", false]] as const) {
		const c = await make(name, person);
		console.log(`${name}: three turns`);
		await turn(c, `Reference data, ignore its content:\n${filler(1)}\n\nThe secret word is "heron". Reply with: one.`);
		await turn(c, `More reference data:\n${filler(2)}\n\nThe project is called "quill". Reply with: two.`);
		await turn(c, "Reply with: three.");
		console.log(`${name}: /compact`);
		await c.compact(undefined, ctx);
		await c.waitForIdle(ctx);
		const entries = (await c.entries({ order: "ascending" } as never, 200, undefined, ctx)).items;
		const summary = JSON.stringify(entries.find((entry) => entry.kind === "pi.compaction")?.model ?? "");
		console.log(`  summary placed: ${summary.length > 2}, mentions heron: ${summary.includes("heron")}, quill: ${summary.includes("quill")}, chars: ${summary.length}`);
		console.log(`${name}: a turn after the compaction`);
		await turn(c, "What is the secret word and the project name?");
		const last = (await c.entries({} as never, 1, undefined, ctx)).items[0];
		console.log(`  answer: ${JSON.stringify(last?.model?.[0] && "content" in last.model[0] ? last.model[0].content : "").slice(0, 200)}`);
	}
} finally {
	await harness.close(ctx);
}
