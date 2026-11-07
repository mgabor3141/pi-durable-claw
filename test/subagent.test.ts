// The subagent tool, end to end on a real Harness with a scripted model: the parent's call creates a child conversation
// the call owns, the child answers, and the answer is the call's output. The child cannot start subagents or restart.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { subagentExtension } from "../src/subagent.ts";

it("runs a task in a child conversation the call owns, and answers with the child's reply", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdc-subagent-"));
	const faux = fauxProvider({ provider: "faux" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { prompt: "Name a prime.", description: "primes" }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("7"),
		fauxAssistantMessage("The subagent said 7."),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const restart = defineExtension({ name: "harness-restart", tools: [defineTool({ name: "restart_harness", description: "restart", parameters: Type.Object({}), callers: ["model"], execute: async () => ({ output: [] }) })] });
	const registry = createRegistry();
	registry.install(restart);
	registry.install(subagentExtension({ without: [restart] }));
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry }, BACKGROUND_CONTEXT);
	onTestFinished(async () => {
		await harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	harness.resume();

	const parent = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
	const settled = await (await parent.submit({ type: "input", content: "Ask a subagent for a prime.", requestId: "r1" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	expect(settled.status).toBe("done");

	const { entries } = await parent.context(BACKGROUND_CONTEXT);
	const result = entries.map((entry) => entry.model?.[0]).find((message) => message?.role === "toolResult");
	expect(JSON.stringify(result)).toContain("7");
	const childId = (result as { details?: { conversationId?: number } }).details?.conversationId;
	expect(typeof childId).toBe("number");

	const child = await harness.conversation(childId as ConversationId, BACKGROUND_CONTEXT);
	const agent = await child!.agent(BACKGROUND_CONTEXT);
	const names = agent.extensions.map((extension) => extension.name);
	expect(names).not.toContain("subagent");
	expect(names).not.toContain("harness-restart");
}, 30_000);
