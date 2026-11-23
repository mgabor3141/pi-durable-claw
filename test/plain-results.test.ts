// What the model is given back from the harness's own tools: plain lines after the output, as pi coding agent writes
// them (the bridge's `plainResults`, installed last as the host installs it), with the other extensions that change a
// result before it: a file `read` gives whole is cut with where to go on, a direct call of a script's tool keeps its
// answer and nothing more, a broken image is said once, and a command a restart cut off says so.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { plainResultsExtension } from "@mgabor3141/pi-durable-t3";
import { afterEach, expect, it } from "vitest";
import { directCallsExtension } from "../src/direct-calls.ts";
import { harnessExtensions } from "../src/harness.ts";
import { SecretStore } from "../src/secrets.ts";

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));

/** A harness with the tools the host gives it, in the host's order: the harness's extensions, the answer to a direct
 * call, and the plain results last. */
async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "claw-plain-"));
	dirs.push(dir);
	const secrets = new SecretStore(join(dir, "secrets.json"));
	await secrets.save("DEPLOY_TOKEN", "tok_0123456789abcdef");
	const registry = createRegistry();
	for (const extension of harnessExtensions({ secrets: { store: secrets, log: { info: () => {}, warn: () => {} } } })) registry.install(extension);
	registry.install(directCallsExtension(registry));
	registry.install(plainResultsExtension({ registry, stopOf: () => undefined, log: { warn: () => {} } }));
	const faux = fauxProvider({ provider: "faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const open = async () => Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }), settings: { toolExecution: "sequential" } }, ctx);
	const agent = { model: { provider: "faux", modelId: faux.models[0]!.id }, cwd: dir };
	const calls = (...list: [id: string, name: string, args: Record<string, string | number>][]) => fauxAssistantMessage(list.map(([id, name, args]) => fauxToolCall(name, args, { id })), { stopReason: "toolUse" });
	/** The tool results as the model is given them, each one's items joined by a mark. */
	const results = (messages: readonly Message[]) =>
		messages.flatMap((message) => (message.role === "toolResult" ? [message.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("⸻")] : []));
	return { dir, faux, open, agent, calls, results };
}

it("the model's own tools answer in plain lines: a failed command, a silent one, a file too long to show, a secret kept out", { timeout: 60_000 }, async () => {
	const { dir, faux, open, agent, calls, results } = await setup();
	await writeFile(join(dir, "long.txt"), `${Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
	faux.setResponses([
		calls(
			["fails", "bash", { command: "echo before; exit 3" }],
			["silent", "bash", { command: "true" }],
			["secret", "bash", { command: 'echo "token $DEPLOY_TOKEN"; exit 1' }],
			["long", "read", { path: "long.txt" }],
			["from", "read", { path: "long.txt", offset: 4000 }],
			["missing", "read", { path: "nowhere.txt" }],
			["script", "codemode", { code: "const file = await tools.read({ path: 'long.txt' });\nreturn file.text.split('\\n').length;" }],
		),
		fauxAssistantMessage("done"),
	]);
	const harness = await open();
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
		await conversation.submit({ type: "input", content: "go" }, ctx);
		await conversation.waitForIdle(ctx);
		const given = results((await conversation.context(ctx)).messages);
		expect(given.join("\n")).not.toContain("<harness>");
		expect(given[0]).toBe("before\n\nCommand exited with code 3");
		expect(given[1]).toBe("(no output)");
		// A secret stays out of the result, with the lines after it.
		expect(given[2]).toBe("token ${DEPLOY_TOKEN}\n\nCommand exited with code 1");
		// `read` gives the file whole (a script reads all of it); what the model is shown is cut here, with where to go on.
		expect(given[3]!.startsWith("line 1\nline 2\n")).toBe(true);
		expect(given[3]!.endsWith("\nline 1998\n\n[Showing lines 1-1998 of 5000. Use offset=1999 to continue.]")).toBe(true);
		expect(given[4]).toBe(`${Array.from({ length: 1001 }, (_, index) => `line ${index + 4000}`).join("\n")}\n`);
		expect(given[5]).toMatch(/^nowhere\.txt: .*ENOENT/u);
		// The script got every line: 5000 and the empty one after the last newline.
		expect(given[6]).toContain("5001");
	} finally {
		await harness.close(ctx);
	}
});

it("a direct call of a script's tool keeps its answer and nothing more, and a broken image is said once", { timeout: 60_000 }, async () => {
	const { dir, faux, open, agent, calls, results } = await setup();
	await writeFile(join(dir, "broken.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not a picture at all")]));
	faux.setResponses([calls(["direct", "ssh", { host: "web-1", command: "uptime" }], ["image", "read", { path: "broken.png" }]), fauxAssistantMessage("done")]);
	const harness = await open();
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
		await conversation.submit({ type: "input", content: "go" }, ctx);
		await conversation.waitForIdle(ctx);
		const given = results((await conversation.context(ctx)).messages);
		expect(given.join("\n")).not.toContain("<harness>");
		expect(given[0]).toBe(["`ssh` is called from a script, not directly: nothing ran. Call `codemode` with this code:", "", "```js", 'return await tools.ssh({\n  "host": "web-1",\n  "command": "uptime"\n});', "```"].join("\n"));
		// One sentence about the picture, not the same one twice.
		expect(given[1]!.split("\n\n")).toHaveLength(1);
		expect(given[1]).toMatch(/image|picture/iu);
	} finally {
		await harness.close(ctx);
	}
});

it("a command cut off says by what: a stop, or a restart of the harness, after which the run goes on", { timeout: 60_000 }, async () => {
	const { faux, open, agent, calls, results } = await setup();
	faux.setResponses([calls(["stopped", "bash", { command: "echo started; sleep 30" }])]);
	let harness = await open();
	try {
		const stopped = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
		await stopped.submit({ type: "input", content: "go" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await stopped.abort(ctx);
		await stopped.waitForIdle(ctx);
		// No bridge here to say who asked.
		expect(results((await stopped.context(ctx)).messages)).toEqual(["started\n\nCommand interrupted; it may have partially run"]);

		faux.setResponses([calls(["cut", "bash", { command: "echo started; sleep 30" }]), fauxAssistantMessage("after the restart")]);
		const restarted = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
		const id = restarted.id;
		await restarted.submit({ type: "input", content: "go" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		await harness.close(ctx);
		harness = await open();
		const again = (await harness.conversation(id, ctx))!;
		await again.waitForIdle(ctx);
		const messages = (await again.context(ctx)).messages;
		expect(results(messages)).toEqual(["started\n\nCommand interrupted by a restart of the harness; it may have partially run"]);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	} finally {
		await harness.close(ctx);
	}
});
