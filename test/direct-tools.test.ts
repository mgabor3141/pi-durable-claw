// The model calls read, write, edit and bash itself for a single step, and codemode for several: the harness offers
// those four directly (and scripts still call them), with the same registrations, so secrets, image fitting and the
// output bound apply as they do in a script.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, expect, it } from "vitest";
import { harnessExtensions } from "../src/harness.ts";
import { imageProcessor, imageSize } from "../src/images.ts";

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

/** A grey PNG of `width` x `height`. */
function greyPng(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x80)]);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

it("the model calls read, write and bash directly; a large image comes back fitted", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "claw-direct-"));
	dirs.push(dir);
	await writeFile(join(dir, "wide.png"), greyPng(2150, 1250));
	const registry = createRegistry();
	for (const extension of harnessExtensions({ images: await imageProcessor() })) registry.install(extension);
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	let offered: string[] = [];
	let catalog = "";
	faux.setResponses([
		(context: TranscriptContext) => {
			const system = getCurrentSystemMessage(context.messages) as { sections?: Record<string, string>; toolsAdded?: { name: string }[] };
			offered = (system.toolsAdded ?? []).map((tool) => tool.name);
			catalog = system.sections?.codemode ?? "";
			return fauxAssistantMessage(
				[
					fauxToolCall("write", { path: join(dir, "note.txt"), content: "hello" }, { id: "w" }),
					fauxToolCall("bash", { command: "cat note.txt; echo; echo exit-was-fine" }, { id: "b" }),
					fauxToolCall("read", { path: "wide.png" }, { id: "r" }),
				],
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("done"),
	]);
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }) }, ctx);
	try {
		const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.models[0]!.id }, cwd: dir } });
		await conversation.submit({ type: "input", content: "go" }, ctx);
		await conversation.waitForIdle(ctx);
		expect([...offered].sort()).toEqual(["bash", "codemode", "edit", "read", "write"]);
		expect(catalog).toContain("Your own tools `read`, `write`, `edit` and `bash` are not listed");
		expect(catalog).toContain("- ssh:");
		const results = (await conversation.context(ctx)).messages.filter((message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult");
		const text = (message: (typeof results)[number]) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(results.map((message) => message.toolName)).toEqual(["write", "bash", "read"]);
		expect(results.every((message) => message.isError !== true)).toBe(true);
		// The shell's own text, not a script's JSON.
		expect(text(results[1]!)).toContain("hello\nexit-was-fine");
		const image = results[2]!.content.find((block) => block.type === "image");
		expect(imageSize(Buffer.from(image!.data, "base64"))).toEqual({ width: 2000, height: 1163 });
	} finally {
		await harness.close(ctx);
	}
});
