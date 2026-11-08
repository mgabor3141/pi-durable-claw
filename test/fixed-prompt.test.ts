// The system prompt is fixed for a thread (`fixed-prompt.ts`): rendered once, then sent byte for byte the same whatever
// changes underneath (AGENTS.md, ~/.mcp.json, the tools registered), so the cached prefix holds. It is rendered afresh
// after a `/reload` (the bridge's `Threads.reload` removes every shown section) and after a compaction.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, defineTool, Harness, type Extension } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_SECTIONS, fixedPromptExtension } from "../src/fixed-prompt.ts";
import { codemodeSandbox, harnessExtensions } from "../src/harness.ts";
import { fileSource } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { ConversationStartDoc, recordConversationStart, workspaceContextExtension } from "../src/context.ts";
import { preambleExtension } from "../src/preamble.ts";
import { object } from "../src/schema.ts";

const ctx = BACKGROUND_CONTEXT;
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const scriptTool = (name: string) =>
	defineTool({
		name,
		description: `The ${name} tool.`,
		parameters: object({}),
		callers: ["tools"],
		execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }),
	});

/** What a request sends besides the conversation: its system messages, with their sections and tool changes. */
const systemMessagesOf = (context: TranscriptContext) => JSON.stringify(context.messages.filter((message) => message.role === "system"));
/** The prompt in effect: every system message replayed. */
const promptOf = (context: TranscriptContext) => JSON.stringify(getCurrentSystemMessage(context.messages));

describe("the fixed system prompt", () => {
	it("covers every section of the harness's prompt", () => {
		const mcp = new McpManager({ source: fileSource("/nonexistent/mcp.json") });
		const extensions: Extension[] = [...harnessExtensions({ browser: true }), mcp.extension()];
		const keys = new Set(extensions.flatMap((extension) => extension.sections?.map((section) => section.key) ?? []));
		expect([...keys].sort()).toEqual([...PROMPT_SECTIONS].sort());
	});

	it("is sent unchanged whatever changes underneath, until a reload or a compaction", { timeout: 60_000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "claw-fixed-prompt-"));
		dirs.push(dir);
		const home = join(dir, "home");
		await mkdir(home);
		await writeFile(join(home, "AGENTS.md"), "Rule one.");
		const mcpPath = join(dir, "mcp.json");
		await writeFile(mcpPath, JSON.stringify({ mcpServers: {} }));
		const mcp = new McpManager({ source: fileSource(mcpPath) });
		await mcp.load();

		const registry = createRegistry();
		for (const extension of [
			fixedPromptExtension(),
			preambleExtension(),
			createCodemodeExtension({ sandbox: codemodeSandbox(), namespaces: mcp.namespaces(), inlineBudget: Number.POSITIVE_INFINITY }) as Extension,
			defineExtension({ name: "first", tools: [scriptTool("first_tool")] }),
			mcp.extension(),
			// A clock far from the recorded start: a prompt rendered again must still name the start.
			workspaceContextExtension({ home, now: () => new Date("2030-01-01T12:00:00Z") }),
		]) {
			registry.install(extension);
		}
		mcp.attach(registry);

		const faux = fauxProvider({ provider: "faux" });
		const models = createModels();
		models.setProvider(faux.provider);
		// One step for every request: a compaction's summary request is answered, the agent's requests are recorded.
		const prompts: string[] = [];
		const sent: string[] = [];
		const replies: string[] = [];
		const step = (context: TranscriptContext): AssistantMessage => {
			const prompt = promptOf(context);
			if (!prompt.includes("You are a personal agent")) return fauxAssistantMessage("## Goal\nsummarized");
			prompts.push(prompt);
			sent.push(systemMessagesOf(context));
			return fauxAssistantMessage(replies.shift() ?? "ok");
		};
		faux.setResponses(Array.from({ length: 20 }, () => step));
		let creationClock = Date.parse("2026-10-01T08:00:00Z");
		const storage = await openNodeSqliteStorage(join(dir, "durable.db"));
		const harness = await Harness.open(
			storage,
			{ models, registry, env: () => new NodeExecutionEnv({ cwd: home }), conversationCreated: recordConversationStart(() => creationClock) },
			ctx,
		);
		try {
			const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
			const turn = async (text: string, reply: string) => {
				replies.push(reply);
				await conversation.submit({ type: "input", content: text }, ctx);
				await conversation.waitForIdle(ctx);
			};
			const systemEntries = async () => (await conversation.entries({}, 500, undefined, ctx)).items.filter((entry) => entry.kind === "pi.system").length;
			// Answers long enough that a compaction has something to cut (it keeps the last 20k tokens), short enough that
			// none starts by itself.
			const long = "x".repeat(60_000);

			await turn("one", "first" + long);
			expect(prompts[0]).toContain("Rule one.");
			expect(prompts[0]).toContain("first_tool");
			const baseline = await systemEntries();

			// Change everything the prompt is made of.
			await writeFile(join(home, "AGENTS.md"), "Rule two.");
			await writeFile(mcpPath, JSON.stringify({ mcpServers: { docs: { type: "http", url: "http://example.test/mcp", description: "Documentation" } } }));
			await mcp.reload();
			registry.install(defineExtension({ name: "second", tools: [scriptTool("second_tool")] }));

			await turn("two", "second" + long);
			expect(sent[1], "the same system messages, byte for byte").toBe(sent[0]);
			expect(prompts[1]).not.toContain("second_tool");
			expect(await systemEntries(), "nothing appended to the transcript").toBe(baseline);

			// A compaction writes the whole prompt again, rendered afresh.
			await conversation.compact(undefined, ctx);
			await conversation.waitForIdle(ctx);
			expect((await conversation.entries({}, 500, undefined, ctx)).items.some((entry) => entry.kind === "pi.compaction")).toBe(true);
			await turn("three", "third");
			expect(prompts[2]).toContain("Rule two.");
			expect(prompts[2]).toContain("second_tool");
			expect(prompts[2]).toContain("- docs (mcp__docs): Documentation");
			expect(prompts[2]).not.toContain("Rule one.");

			// `/reload`, as the bridge writes it: every shown section removed, so the next request renders them all.
			await writeFile(join(home, "AGENTS.md"), "Rule three.");
			await turn("four", "fourth");
			expect(prompts[3]).toContain("Rule two.");
			const shown = PROMPT_SECTIONS.filter((key) => key !== "local-agents" && key !== "local-skills");
			await conversation.submit(
				{ type: "write", entry: { kind: "pi.system", model: [{ role: "system", content: "", sections: Object.fromEntries(shown.map((key) => [key, null])), timestamp: Date.now() }] } as never },
				ctx,
			);
			await turn("five", "fifth");
			expect(prompts[4]).toContain("Rule three.");
			expect(prompts[4]).not.toContain("Rule two.");
			for (const prompt of prompts) {
				expect(prompt).toContain("Local time when this conversation started: 2026-10-01");
				expect(prompt).not.toContain("2030-01-01");
			}

			// A fork (T3's undo and edit fork a thread's conversation) keeps the start it inherited.
			creationClock = Date.parse("2027-02-02T08:00:00Z");
			const at = (await conversation.entries({}, 1, undefined, ctx)).items[0]!.id;
			const fork = await conversation.fork(at, { ownership: "ordinary" } as never, ctx);
			expect((await harness.snapshot(ConversationStartDoc, fork.id, ctx))?.at).toBe(Date.parse("2026-10-01T08:00:00Z"));
		} finally {
			await harness.close(ctx);
		}
	});
});
