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
import { harnessExtensions, THREAD_NAMESPACE, threadToolExtensions } from "../src/harness.ts";
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
		const extensions = [
			defineExtension({
				name: "own",
				tools: [
					tool("ssh", "Run a command over SSH. Long details nobody needs up front."),
					tool("bash", "Execute a bash command.", { callers: undefined }),
					tool("read", "Read a file.", { callers: ["model", "tools"] }),
					tool("pi.codemode.classify", "Internal."),
					tool("my-tool", "A tool whose name is not an identifier."),
				],
			}),
			defineExtension({ name: "threads", namespace: { name: "thread", description: "Other agents' threads" }, tools: [tool("thread_wait", "Wait for threads. Details.")] }),
			// An MCP server: its namespace has no listed tool, so no heading (the `mcp-servers` section names it).
			defineExtension({ name: "mcp:docs", namespace: { name: "mcp__docs", description: "Docs" }, tools: [tool("mcp__docs__search", "An MCP tool.", { deferred: true })] }),
		];
		const section = catalogSection(extensions.flatMap((extension) => extension.tools ?? []), extensions)!;
		// What a script gets is said of the call it makes: a plain `bash(...)` is not defined in a script.
		expect(section).toContain("Your own tools `bash` and `read` are not listed: scripts call them too, with the same arguments. In a script, `tools.bash` gives { output, exitCode, truncated, fullOutputPath? } (a nonzero exit resolves too: check exitCode); `tools.read` gives { type: \"text\", text } or an image block (show it with image()).");
		expect(section).not.toMatch(/`(?:bash|read)` gives/u);
		expect(section).not.toContain("- bash:");
		expect(section).not.toContain("Execute a bash command.");
		expect(section).not.toContain("```ts");
		expect(section).toContain("- ssh: Run a command over SSH.");
		expect(section).not.toContain("Long details");
		expect(section).toContain("## thread\nOther agents' threads\n- thread_wait: Wait for threads.");
		expect(section).toContain("- my_tool (my-tool): A tool whose name is not an identifier.");
		expect(section).not.toContain("mcp__docs");
		expect(section).not.toContain("pi.codemode");
		expect(section.indexOf("Your own tools")).toBeLessThan(section.indexOf("- ssh:"));
		expect(catalogSection([tool("mcp__docs__search", "x", { deferred: true })], [])).toBeUndefined();
	});

	it("groups the bridge's thread_* tools as the thread namespace and leaves its other tools among the others, in order", () => {
		const bridge = defineExtension({
			name: "thread-tools",
			tools: [tool("thread_prompt", "Prompt a thread."), tool("schedule_task", "Create scheduled work."), tool("thread_wait", "Wait for threads."), tool("t3_queue", "Manage a queue.")],
		});
		const extensions = [defineExtension({ name: "own", tools: [tool("ssh", "Run a command over SSH.")] }), ...threadToolExtensions(bridge), defineExtension({ name: "html", tools: [tool("html_render", "Show a page.")] })];
		const section = catalogSection(extensions.flatMap((extension) => extension.tools ?? []), extensions)!;
		expect(section).toContain("### Other tools\n- ssh: Run a command over SSH.\n- schedule_task: Create scheduled work.\n- t3_queue: Manage a queue.\n- html_render: Show a page.");
		expect(section).toContain(`## thread\n${THREAD_NAMESPACE.description}\n- thread_prompt: Prompt a thread.\n- thread_wait: Wait for threads.`);
	});
});

it("the harness's prompt is the catalog, fixed for the thread, describeTool() gives a listed tool's declaration, and describeNamespace() a declared namespace", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "claw-catalog-"));
	dirs.push(dir);
	const registry = createRegistry();
	for (const extension of harnessExtensions({ browser: true, web: { searxngUrl: "http://searxng:8080", readerUrl: "http://reader:8000" } })) registry.install(extension);
	for (const extension of threadToolExtensions(defineExtension({ name: "thread-tools", tools: [tool("thread_wait", "Wait for threads."), tool("schedule_task", "Create scheduled work.")] }))) registry.install(extension);
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
		record(fauxAssistantMessage([fauxToolCall("codemode", { code: 'return [await describeTool("ssh"), JSON.stringify(await describeNamespace("thread"))].join("\\n");' } as never, { id: "c1" })], { stopReason: "toolUse" })),
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
		expect(first).toContain("## thread");
		expect(described, "describeNamespace() knows the namespace the extension declares").toContain('{"name":"thread","description":"Other agents\' threads');
		expect(described).toContain('"tools":["thread_wait"]');
	} finally {
		await harness.close(ctx);
	}
});
