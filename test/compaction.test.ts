import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { compactionExtension, collectFileOps, previousFileOps, previousSummary } from "../src/compaction.ts";

const model = { provider: "fake", id: "fake", api: "fake", maxTokens: 8192 } as never;

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "fake" as never,
		provider: "fake" as never,
		model: "fake",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 0 };
}

function assistant(text: string, calls: readonly { name: string; path: string }[] = []): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...calls.map((call, index) => ({ type: "toolCall" as const, id: `call-${index}`, name: call.name, arguments: { path: call.path } })),
		],
		api: "fake" as never,
		provider: "fake" as never,
		model: "fake",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function toolResult(calls: readonly { name: string; path: string }[]): Message {
	return {
		role: "toolResult",
		toolCallId: "call-0",
		toolName: "codemode",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 0,
		nestedCalls: { calls: calls.map((call) => ({ id: "nested", name: call.name, arguments: { path: call.path } })) },
	} as never;
}

function entry(id: string, kind: string, messages: readonly Message[]) {
	return { id, kind, conversationId: 1, model: messages } as never;
}

function fakeApi(summary = "## Goal\nsummarized", entries: Record<string, unknown> = {}) {
	const prompts: string[] = [];
	const api = {
		models: {
			getModel: () => model,
			completeSimple: async (_model: unknown, context: { messages: readonly Message[] }) => {
				const content = context.messages[1]?.content;
				const text = typeof content === "string" ? content : content?.flatMap((block) => ("text" in block ? [block.text] : [])).join("") ?? "";
				prompts.push(text);
				return reply(summary);
			},
		},
		agent: async () => ({ model: { provider: "fake", modelId: "fake" }, thinkingLevel: "off" }),
		entry: async (id: string) => entries[id],
	};
	return { api, prompts };
}

async function run(compaction: unknown, api: unknown): Promise<{ summary: string } | undefined> {
	const handlers = compactionExtension().hooks?.[0]?.handlers as { beforeCompact: Function };
	return (await handlers.beforeCompact(compaction, api, { abortSignal: undefined })) as { summary: string } | undefined;
}

describe("compaction", () => {
	it("uses pi's summary prompt and appends cumulative file lists", async () => {
		const messages = [user("fix the tests"), assistant("reading", [{ name: "read", path: "/a.ts" }, { name: "write", path: "/b.ts" }, { name: "edit", path: "/b.ts" }]), toolResult([{ name: "read", path: "/a.ts" }])];
		const { api, prompts } = fakeApi("## Goal\nfix the tests");
		const result = await run({ firstKept: "keep", instructions: undefined, entries: [entry("u", "pi.user", [user("fix")])], messages }, api);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("## Goal");
		expect(prompts[0]).toContain("## Critical Context");
		expect(result?.summary).toContain("## Goal");
		expect(result?.summary).toContain("<read-files>\n/a.ts\n</read-files>");
		expect(result?.summary).toContain("<modified-files>\n/b.ts\n</modified-files>");
		expect(result?.summary).not.toContain("<read-files>\n/a.ts\n/b.ts");
	});

	it("folds a previous summary through the update prompt and carries its file lists", async () => {
		const wrapped = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n## Goal\nold\n\n<read-files>\n/old.ts\n</read-files>\n</summary>";
		const messages = [user(wrapped), user("next"), assistant("done")];
		const { api, prompts } = fakeApi("## Goal\nnew");
		const result = await run(
			{ firstKept: "keep", entries: [entry("c", "pi.compaction", [user(wrapped)]), entry("u", "pi.user", [user("next")])], messages },
			api,
		);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("<previous-summary>");
		expect(prompts[0]).toContain("Update the existing structured summary");
		expect(result?.summary).toContain("<read-files>\n/old.ts\n</read-files>");
	});

	it("summarizes the prefix of a split turn separately", async () => {
		const messages = [user("long task"), assistant("partial work")];
		const { api, prompts } = fakeApi("## Original Request\nlong task", { keep: entry("keep", "pi.assistant", [assistant("partial work")]) });
		const result = await run(
			{ firstKept: "keep", entries: [entry("u", "pi.user", [user("long task")])], messages },
			api,
		);

		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("# Instructions");
		expect(prompts[0]).toContain("Only summarize information explicitly present above");
		expect(result?.summary).toContain("**Turn Context (split turn):**");
		expect(result?.summary).toContain("No prior history.");
	});

	it("keeps the helpers usable independently", () => {
		expect(previousSummary(entry("c", "pi.compaction", [user("x<summary>\nhi\n</summary>")]))).toBe("hi");
		expect(previousSummary(entry("u", "pi.user", [user("hi")]))).toBeUndefined();
		expect([...previousFileOps("<read-files>\n/a\n</read-files>\n<modified-files>\n/b\n</modified-files>").read]).toEqual(["/a"]);
		expect([...collectFileOps([assistant("x", [{ name: "read", path: "/a" }]), toolResult([{ name: "write", path: "/b" }])]).written]).toEqual(["/b"]);
	});
});
