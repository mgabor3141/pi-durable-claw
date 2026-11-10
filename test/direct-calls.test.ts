// The model calls a script-only tool itself: pi-durable refused with "Tool bash is not available" (bash was script-only
// then), and the agent did not learn how to run it. The refusal now gives the script to send. Here a script-only bash
// stands for any such tool.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { afterEach, expect, it } from "vitest";
import { directCallAnswer, directCallsExtension } from "../src/direct-calls.ts";

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

const textOf = (message: Message | undefined) => ((message?.content ?? []) as { type: string; text?: string }[]).flatMap((block) => (block.type === "text" ? [block.text!] : [])).join("\n");

it("a direct call to a script-only tool is answered with the script that calls it, and that script runs", { timeout: 60_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pdc-direct-"));
	dirs.push(cwd);
	const registry = createRegistry();
	registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }) }) as never);
	registry.install(defineExtension({ name: "harness-tools", tools: [{ ...createBashTool(), callers: ["tools"] as const }] }));
	registry.install(directCallsExtension(registry));
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(cwd, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, BACKGROUND_CONTEXT);
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
		let answer = "";
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo direct-call-ok" }, { id: "c1" }), fauxToolCall("bsah", {}, { id: "c2" })], { stopReason: "toolUse" }),
			// The model sends the script it was given.
			(context) => {
				answer = textOf(context.messages.find((message) => message.role === "toolResult"));
				const code = /```js\n([\s\S]*?)\n```/.exec(answer)![1]!;
				return fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "c3" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await conversation.submit({ type: "input", content: "run it" }, BACKGROUND_CONTEXT);
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
		expect(answer).toBe(`${directCallAnswer("bash", { command: "echo direct-call-ok" }, true)}\n<harness>\n[error] Tool bash is called from codemode scripts, not directly\n</harness>`);
		expect(answer).toContain("return await tools.bash({\n  \"command\": \"echo direct-call-ok\"\n});");
		const results = (await conversation.context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "toolResult");
		expect(textOf(results[1])).toContain("There is no tool named `bsah`");
		expect(textOf(results[1])).toContain("[error] Tool bsah is not available");
		expect(textOf(results[2])).toContain("direct-call-ok");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});
