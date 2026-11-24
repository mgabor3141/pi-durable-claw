// Messages a person steers in while the agent works reach the model together, at the run's next boundary, as T3's
// providers take them: the host's `steeringMode: "all"`, where pi-durable's default places one a boundary.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, type Context as ModelContext, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it } from "vitest";
import { HARNESS_SETTINGS, harnessExtensions } from "../src/harness.ts";

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

it("two steers sent while a command runs reach the model in the same request", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "claw-steers-"));
	dirs.push(dir);
	const registry = createRegistry();
	for (const extension of harnessExtensions({})) registry.install(extension);
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const told: string[][] = [];
	const answer = (text: string) => (context: ModelContext) => {
		told.push(context.messages.flatMap((message) => (message.role === "user" ? [typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")] : [])));
		return fauxAssistantMessage(text);
	};
	faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${join(dir, "started")}; sleep 2` }, { id: "wait" })], { stopReason: "toolUse" }), answer("read both"), answer("done")]);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }), settings: HARNESS_SETTINGS }, ctx);
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: faux.models[0]!.id }, cwd: dir } }, ctx);
		await conversation.submit({ type: "input", content: "go" }, ctx);
		const { access } = await import("node:fs/promises");
		await expect.poll(async () => access(join(dir, "started")).then(() => true, () => false), { timeout: 10_000 }).toBe(true);
		await conversation.submit({ type: "input", requestId: "a", content: "also check the logs", whenBusy: "steer" }, ctx);
		await conversation.submit({ type: "input", requestId: "b", content: "and the unit file", whenBusy: "steer" }, ctx);
		await conversation.waitForIdle(ctx);
		expect(told[0]!.slice(-2)).toEqual(["also check the logs", "and the unit file"]);
	} finally {
		await harness.close(ctx);
	}
});
