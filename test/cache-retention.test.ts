// A conversation's prompt cache retention is chosen per conversation (`cache-retention.ts`): the request hook and the
// models wrapper meet at the provider session id. A real Harness, a provider that records each request's options.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it } from "vitest";
import { ConversationCacheRetention } from "../src/cache-retention.ts";
import { compactionExtension } from "../src/compaction.ts";

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("a person's thread is cached for an hour, another for pi's default, and a summary as its thread", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "claw-cache-retention-"));
	dirs.push(dir);
	const persons = new Set<ConversationId>();
	const retention = new ConversationCacheRetention((conversationId) => (persons.has(conversationId) ? "long" : undefined));
	const registry = createRegistry();
	registry.install(compactionExtension());
	registry.install(retention.extension());
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const sent: { session: string | undefined; retention: string | undefined; summary: boolean; text: string }[] = [];
	const long = "x".repeat(60_000);
	const step = (context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessage => {
		const text = JSON.stringify(context.messages.at(-1));
		const summary = text.includes("about to be compacted");
		sent.push({ session: options?.sessionId, retention: options?.cacheRetention, summary, text });
		return fauxAssistantMessage(summary ? "## Goal\nsummarized" : "answer" + long);
	};
	faux.setResponses(Array.from({ length: 20 }, () => step));
	const storage = await openNodeSqliteStorage(join(dir, "durable.db"));
	const harness = await Harness.open(storage, { models: retention.models(models), registry, env: () => new NodeExecutionEnv({ cwd: dir }) }, ctx);
	try {
		const agent = { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } };
		const person = await harness.root(ctx, agent);
		const childId = await harness.commit(async (tx) => {
			return (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
		}, ctx);
		const child = (await harness.conversation(childId, ctx))!;
		await child.configure(agent.agent, ctx);
		persons.add(person.id);
		for (const conversation of [person, child]) {
			for (const text of ["one", "two"]) {
				await conversation.submit({ type: "input", content: text }, ctx);
				await conversation.waitForIdle(ctx);
			}
		}
		const [personSession, childSession] = [sent[0]!.session, sent[2]!.session];
		expect(personSession).not.toBe(childSession);
		expect(sent.slice(0, 2).map((request) => request.retention)).toEqual(["long", "long"]);
		expect(sent.slice(2, 4).map((request) => request.retention), "pi's default").toEqual([undefined, undefined]);

		// The summary is asked for on the conversation, with its session, so with its retention.
		await person.compact(undefined, ctx);
		await person.waitForIdle(ctx);
		expect(sent.at(-1)).toMatchObject({ summary: true, session: personSession, retention: "long" });
		await child.compact(undefined, ctx);
		await child.waitForIdle(ctx);
		expect(sent.at(-1)).toMatchObject({ summary: true, session: childSession, retention: undefined });

		// A thread that becomes a person's (or stops being one) is asked again at each request.
		persons.delete(person.id);
		await person.submit({ type: "input", content: "three" }, ctx);
		await person.waitForIdle(ctx);
		expect(sent.at(-1)).toMatchObject({ summary: false, session: personSession, retention: undefined });

		// A request that sets its own retention keeps it, and one without a session is nobody's.
		persons.add(person.id);
		await person.submit({ type: "input", content: "four" }, ctx);
		await person.waitForIdle(ctx);
		const wrapped = retention.models(models);
		const model = models.getModel("faux", faux.models[0]!.id)!;
		await wrapped.completeSimple(model, { messages: [{ role: "user", content: "x", timestamp: 0 }] }, { sessionId: personSession, cacheRetention: "none" });
		expect(sent.at(-1)).toMatchObject({ retention: "none" });
		await wrapped.completeSimple(model, { messages: [{ role: "user", content: "x", timestamp: 0 }] }, {});
		expect(sent.at(-1)).toMatchObject({ retention: undefined });
	} finally {
		await harness.close(ctx);
	}
});
