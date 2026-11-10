// The `codemode` section as a catalog (`codemode-catalog.ts`): every tool on one line, the model's own tools
// (read/write/edit/bash) named once, the rest's declarations from `describeTool()`. The section was about 26,000 characters, nine tenths of the prompt.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTool, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { catalogSection, summaryOf } from "../src/codemode-catalog.ts";
import { harnessExtensions } from "../src/harness.ts";
import { object } from "../src/schema.ts";

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

const tool = (name: string, description: string, extra: Partial<ToolRegistration> = {}): ToolRegistration =>
	defineTool({ name, description, parameters: object({}), callers: ["tools"], execute: async () => ({ output: [] }), ...extra }) as ToolRegistration;

describe("summaryOf", () => {
	it("is the description's first sentence, on one line", () => {
		expect(summaryOf("Run a command over SSH. host: where.")).toBe("Run a command over SSH.");
		expect(summaryOf("Read a file (~/.mcp.json works)\nacross lines. More.")).toBe("Read a file (~/.mcp.json works) across lines.");
		expect(summaryOf("First paragraph without a stop\n\nSecond paragraph.")).toBe("First paragraph without a stop");
		expect(summaryOf("x".repeat(300))).toHaveLength(200);
	});
});

describe("catalogSection", () => {
	it("names the model's own tools once, lists every other on one line by namespace, and leaves out deferred and internal tools", () => {
		const section = catalogSection(
			[
				tool("ssh", "Run a command over SSH. Long details nobody needs up front."),
				tool("bash", "Execute a bash command.", { callers: undefined }),
				tool("read", "Read a file.", { callers: ["model", "tools"] }),
				tool("thread_wait", "Wait for threads. Details."),
				tool("mcp__docs__search", "An MCP tool.", { deferred: true }),
				tool("pi.codemode.classify", "Internal."),
				tool("my-tool", "A tool whose name is not an identifier."),
			],
			[{ name: "thread", prefix: "thread_", description: "Other agents' threads" }],
		)!;
		expect(section).toContain("Your own tools `bash` and `read` are not listed: scripts call them too, with the same arguments. In a script, `bash` gives { output, exitCode, truncated, fullOutputPath? }");
		expect(section).not.toContain("- bash:");
		expect(section).not.toContain("Execute a bash command.");
		expect(section).not.toContain("```ts");
		expect(section).toContain("- ssh: Run a command over SSH.");
		expect(section).not.toContain("Long details");
		expect(section).toContain("## thread\nOther agents' threads\n- thread_wait: Wait for threads.");
		expect(section).toContain("- my_tool (my-tool): A tool whose name is not an identifier.");
		expect(section).not.toContain("mcp__docs__search");
		expect(section).not.toContain("pi.codemode");
		expect(section.indexOf("Your own tools")).toBeLessThan(section.indexOf("- ssh:"));
		expect(catalogSection([tool("mcp__docs__search", "x", { deferred: true })], [])).toBeUndefined();
	});
});

it("the harness's prompt is the catalog, fixed for the thread, and describeTool() gives a listed tool's declaration", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "claw-catalog-"));
	dirs.push(dir);
	const registry = createRegistry();
	for (const extension of harnessExtensions({ browser: true, web: { searxngUrl: "http://searxng:8080", readerUrl: "http://reader:8000" } })) registry.install(extension);
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const prompts: string[] = [];
	const descriptions: string[] = [];
	const record = (reply: AssistantMessage) => (context: TranscriptContext) => {
		// The system message in effect: its sections, and the tools offered to the model.
		const system = getCurrentSystemMessage(context.messages) as { sections?: Record<string, string>; toolsAdded?: { name: string; description: string }[] };
		prompts.push(system.sections?.codemode ?? "");
		descriptions.push(system.toolsAdded?.find((candidate) => candidate.name === "codemode")?.description ?? "");
		return reply;
	};
	faux.setResponses([
		record(fauxAssistantMessage([fauxToolCall("codemode", { code: 'return await describeTool("ssh");' } as never, { id: "c1" })], { stopReason: "toolUse" })),
		record(fauxAssistantMessage("described")),
	]);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }) }, ctx);
	try {
		const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
		await conversation.submit({ type: "input", content: "go" }, ctx);
		// A tool registered mid-thread: the prompt the thread started with stays as it was.
		registry.install(defineExtension({ name: "late", tools: [tool("late_tool", "Arrives late.")] }));
		await conversation.waitForIdle(ctx);

		const [first, second] = prompts;
		expect(first).toContain("Your own tools `read`, `write`, `edit` and `bash` are not listed");
		expect(first).toContain("- ssh: Run a command on another machine over SSH");
		expect(first, "ssh's details are not in the prompt").not.toContain("No terminal, no stdin");
		expect(first!.length, "the section stays small; a tool belongs on one line").toBeLessThan(5_000);
		expect(second).toBe(first);
		expect(second).not.toContain("late_tool");
		expect(descriptions[0]).toContain("lists the tools scripts can call, one line each, besides your own tools");

		const context = await conversation.context(ctx);
		const result = context.messages.find((message) => message.role === "toolResult") as { content: { type: string; text?: string }[] };
		const described = result.content.map((block) => block.text ?? "").join("\n");
		expect(described).toContain("No terminal, no stdin");
		expect(described).toContain("host: string");
	} finally {
		await harness.close(ctx);
	}
});
