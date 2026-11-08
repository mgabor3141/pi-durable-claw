// `read` from a codemode script: a text file gives its text, an image gives the block `image()` shows. pi-durable's
// `read` already returns an image as its content, but a tool without an output schema gives scripts only its text, so
// the picture came back as "".
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ImageContent } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, expect, it } from "vitest";
import { imageCheckExtension } from "@mgabor3141/pi-durable-t3";
import { readTool } from "../src/tools.ts";

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));
async function dir() {
	const made = await mkdtemp(join(tmpdir(), "pdc-read-"));
	dirs.push(made);
	return made;
}

/** A 1x1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function api(cwd: string) {
	return {
		env: new NodeExecutionEnv({ cwd }),
		agent: async () => ({}),
		models: { getModel: () => undefined },
		output: () => {},
		retainedOutput: () => ({ text: "", truncated: false }),
		diagnostic: () => {},
	};
}

it("a text file arrives as its text", async () => {
	const cwd = await dir();
	await writeFile(join(cwd, "notes.md"), "alpha\nbeta\n");
	const result = (await readTool().execute({ path: join(cwd, "notes.md") } as never, api(cwd) as never, BACKGROUND_CONTEXT)) as {
		structuredOutput: { type: string; text: string };
	};
	expect(result.structuredOutput).toEqual({ type: "text", text: "alpha\nbeta\n" });
});

it("a large text file arrives whole, past pi-durable's 2,000 lines and 50 KB; offset and limit still select lines", async () => {
	const cwd = await dir();
	const lines = Array.from({ length: 5000 }, (_, index) => `line ${index + 1} ${"x".repeat(20)}`);
	const text = lines.join("\n");
	expect(Buffer.byteLength(text)).toBeGreaterThan(100_000);
	await writeFile(join(cwd, "big.log"), text);
	const whole = (await readTool().execute({ path: "big.log" } as never, api(cwd) as never, BACKGROUND_CONTEXT)) as unknown as { structuredOutput: { text: string } };
	expect(whole.structuredOutput.text).toBe(text);
	const some = (await readTool().execute({ path: "big.log", offset: 4999, limit: 5 } as never, api(cwd) as never, BACKGROUND_CONTEXT)) as unknown as { structuredOutput: { text: string } };
	expect(some.structuredOutput.text).toBe(`${lines[4998]}\n${lines[4999]}`);
});

it("an image arrives as the block image() shows", async () => {
	const cwd = await dir();
	await writeFile(join(cwd, "shot.png"), PNG);
	const result = (await readTool().execute({ path: join(cwd, "shot.png") } as never, api(cwd) as never, BACKGROUND_CONTEXT)) as unknown as {
		output: unknown[];
		structuredOutput: ImageContent;
	};
	// The model-facing content is unchanged (one image block); the script now gets the same block, which image() takes.
	expect(result.output).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
	const shown: ImageContent = result.structuredOutput;
	expect(shown).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
});

it("a missing file rejects, with no structured output pretending otherwise", async () => {
	const cwd = await dir();
	await expect(readTool().execute({ path: join(cwd, "nope.png") } as never, api(cwd) as never, BACKGROUND_CONTEXT)).rejects.toThrow(/nope\.png/);
});

it("a script that reads a PNG can show it: the codemode result carries the picture", { timeout: 60_000 }, async () => {
	const cwd = await dir();
	await writeFile(join(cwd, "shot.png"), PNG);
	const registry = createRegistry();
	registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }) }) as never);
	registry.install(defineExtension({ name: "harness-tools", tools: [readTool()] }));
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(cwd, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, BACKGROUND_CONTEXT);
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
		const code = `const r = await tools.read({ path: ${JSON.stringify(join(cwd, "shot.png"))} }); image(r); return r.type;`;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code } as never, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("shown"),
		]);
		await conversation.submit({ type: "input", content: "look" }, BACKGROUND_CONTEXT);
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
		const context = await conversation.context(BACKGROUND_CONTEXT);
		const result = context.messages.find((message) => message.role === "toolResult") as { content: { type: string; text?: string; data?: string; mimeType?: string }[] };
		expect(result.content.some((block) => block.type === "image" && block.data === PNG.toString("base64") && block.mimeType === "image/png")).toBe(true);
		expect(result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")).toContain("image");
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
});

/** A script's run, with the harness's image check: the codemode result as the model gets it. */
async function runScript(cwd: string, code: string): Promise<{ type: string; text?: string; data?: string }[]> {
	const registry = createRegistry();
	registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }) }) as never);
	registry.install(defineExtension({ name: "harness-tools", tools: [readTool()] }));
	registry.install(imageCheckExtension());
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(join(cwd, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, BACKGROUND_CONTEXT);
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id } } });
		faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code } as never, { id: "c1" })], { stopReason: "toolUse" }), fauxAssistantMessage("seen")]);
		await conversation.submit({ type: "input", content: "look" }, BACKGROUND_CONTEXT);
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
		const context = await conversation.context(BACKGROUND_CONTEXT);
		return (context.messages.find((message) => message.role === "toolResult") as { content: { type: string; text?: string; data?: string }[] }).content;
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

// A screenshot copied while it was still being written arrived cut short; the provider refused every request after it,
// and the thread could not continue. With the image check the script learns why, and nothing broken reaches the model.
it("a truncated PNG: read rejects with the reason, and image() of broken data shows the reason, not the image", { timeout: 60_000 }, async () => {
	const cwd = await dir();
	const cut = PNG.subarray(0, 50);
	await writeFile(join(cwd, "cut.png"), cut);
	const viaRead = await runScript(cwd, `try { await tools.read({ path: ${JSON.stringify(join(cwd, "cut.png"))} }); return "read it"; } catch (error) { return "refused: " + error.message; }`);
	const readText = viaRead.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	expect(readText).toContain("refused:");
	expect(readText).toContain("the PNG ends early, at 50 bytes");
	expect(viaRead.some((block) => block.type === "image")).toBe(false);

	const viaImage = await runScript(cwd, `image("data:image/png;base64,${cut.toString("base64")}"); return "shown";`);
	expect(viaImage.some((block) => block.type === "image"), "the broken image never reaches the model").toBe(false);
	expect(viaImage.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")).toContain("[Image not shown to the model: the PNG ends early, at 50 bytes");
});
