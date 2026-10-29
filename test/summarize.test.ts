import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/chord";
import { summarizeTools } from "../src/summarize.ts";

const context = { abortSignal: undefined } as unknown as Context;

function fakeApi(text: string, summary = "a summary") {
	let seen = "";
	return {
		api: {
			env: { readTextFile: async () => ({ ok: true, value: text }) },
			agent: async () => ({ model: { provider: "mgabor", modelId: "batch" } }),
			models: {
				getModel: () => ({}),
				completeSimple: async (_model: unknown, prompt: unknown) => {
					seen = JSON.stringify(prompt);
					return { stopReason: "stop", content: [{ type: "text", text: summary }] };
				},
			},
		},
		seen: () => seen,
	};
}

describe("summarize", () => {
	it("reads a workspace file and sends it to the selected model", async () => {
		const { api, seen } = fakeApi("page text", "answer");
		const tool = summarizeTools()[0]!;
		const result = await (tool as any).execute({ path: "/workspace/tmp/pages/page.md", instruction: "What changed?" }, api, context);
		expect(result.structuredOutput).toEqual({ summary: "answer" });
		expect(seen()).toContain("page text");
		expect(seen()).toContain("What changed?");
	});

	it("requires exactly one of path or text", async () => {
		const { api } = fakeApi("page text");
		const tool = summarizeTools()[0]!;
		await expect((tool as any).execute({ text: "x", path: "/x" }, api, context)).rejects.toThrow("exactly one");
	});
});
