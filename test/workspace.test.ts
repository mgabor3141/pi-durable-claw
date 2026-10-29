import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHarness } from "../src/harness.ts";
import { codemodeAnswer, codemodeToolCall, fauxModels } from "./fixtures/faux.ts";
import { secretLookupTool } from "./fixtures/secret.ts";
import { workspaceEnv, type WorkspaceConnection } from "../src/workspace.ts";
import { connectTestWorkspace, dockerWorkspace } from "./fixtures/workspace.ts";

const context = BACKGROUND_CONTEXT;
// A key the harness holds; if this string ever reaches the container, isolation failed.
const SECRET_KEY = "sk-mgabor-SECRETKEY-7f3a9c2b1d";
const WORKSPACE_KEY_FILE = "/home/agent/x.json";

// The model's script, run by upstream's codemode tool. `secret_lookup` and the workspace tools are callable only
// from scripts (`callers: ["tools"]`), reached as nested `pi.tool` tasks; `bash` resolves to its structured
// `{ output, exitCode, ... }` (1.2.0 structured tool output).
const script = `
	const secret = await tools.secret_lookup({ name: "calendar" });
	await tools.write({ path: "${WORKSPACE_KEY_FILE}", content: JSON.stringify(secret) });
	const processed = await tools.bash({
		command: "python3 -c 'import json; d=json.load(open(\\"${WORKSPACE_KEY_FILE}\\")); print(d[\\"value\\"].upper())'",
	});
	return { processed: processed.output.trim(), exit: processed.exitCode };
`;

let workspace: WorkspaceConnection;
let directory: string;
let harness: Awaited<ReturnType<typeof openHarness>>;
let resultText = "";
let offeredToolNames: string[] = [];
let callableToolNames: string[] = [];

beforeAll(async () => {
	workspace = await connectTestWorkspace();
	directory = await mkdtemp(join(tmpdir(), "pdc-test-"));
	const { faux, models } = fauxModels();
	faux.setResponses([codemodeToolCall(script), codemodeAnswer("The workspace processed the secret.")]);
	harness = await openHarness({
		storagePath: join(directory, "session.sqlite"),
		workspace,
		models,
		extraTools: [secretLookupTool(SECRET_KEY)],
	});
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/home/agent" } });

	// The model is offered exactly one tool: codemode. (`agent.tools` are the tools a request offers, in order:
	// enabled, callable by the model, selected by `modelTools`.) The script-callable tools are enabled, not offered.
	const agent = await root.agent(context);
	offeredToolNames = agent.tools.map((tool) => tool.name);
	callableToolNames = agent.callable.map((tool) => tool.name);

	const settled = await (await root.submit({ type: "input", content: "Process the calendar secret." }, context)).wait(context);
	expect(settled.status).toBe("done");

	// Collect the codemode tool's result text.
	const transcript = await root.entries({}, 50, undefined, context);
	for (const entry of transcript.items) {
		if (ToolResultEntry.is(entry)) {
			const message = entry.model![0] as ToolResultMessage;
			if (message.toolName === "codemode") {
				resultText = message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
			}
		}
	}
	// The answer reached the model too.
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, (settled as { answer: any }).answer), context);
	expect(answer?.model?.[0]).toBeDefined();
}, 60_000);

afterAll(async () => {
	await harness?.close(context);
	workspace?.connection.close();
	if (directory) await rm(directory, { recursive: true, force: true });
});

describe("upstream codemode in a pi-durable conversation", () => {
	it("the model is offered exactly [codemode]; the other tools are script-callable only", () => {
		expect(offeredToolNames).toEqual(["codemode"]);
		for (const name of ["secret_lookup", "read", "write", "bash"]) expect(callableToolNames).toContain(name);
	});

	it("runs the script: secret_lookup -> write -> python3 -> processed output", () => {
		expect(resultText).toContain("RECORD-FOR-CALENDAR-SIG-9C2B1D");
		expect(resultText).toContain('"exit":0');
	});

	it("wrote the derived record to /home/agent/x.json in the container", () => {
		const content = dockerWorkspace(`cat ${WORKSPACE_KEY_FILE}`);
		expect(content).toContain("record-for-calendar-sig-9c2b1d");
	});

	it("the key never appears in the container's filesystem", () => {
		// Grep real files (not /proc, which carries our own grep command line) for the key.
		const hits = dockerWorkspace(
			`grep -rl --exclude-dir=proc --exclude-dir=sys ${JSON.stringify(SECRET_KEY)} / 2>/dev/null || true`,
		).trim();
		expect(hits).toBe("");
	});

	it("the key is not in the bash environment inside the container", () => {
		const envDump = dockerWorkspace("cat /proc/1/environ /proc/self/environ 2>/dev/null | tr '\\0' '\\n'");
		expect(envDump).not.toContain("SECRETKEY");
	});

	it("the container cannot read the harness's files", async () => {
		// A sentinel in the harness process's temp dir; the container must not see it.
		const sentinel = join(directory, "harness-secret.txt");
		await writeFile(sentinel, `harness-only-${SECRET_KEY}`);
		// The container's view of the host path: nothing there.
		const out = dockerWorkspace(`cat ${JSON.stringify(sentinel)} 2>&1 || echo MISSING`);
		expect(out).toContain("MISSING");
		// And an SSH-run bash from the workspace env reports a non-zero exit for the same read.
		const env = workspaceEnv(workspace.connection, "/home/agent");
		const exec = await env.exec(`cat ${JSON.stringify(sentinel)}`, undefined, context);
		expect(exec.ok ? exec.value.exitCode : "spawn_error").not.toBe(0);
	});

	it("the workspace has no harness key material in its environment (shell env of a real command)", async () => {
		const env = workspaceEnv(workspace.connection, "/home/agent");
		let out = "";
		const exec = await env.exec("env", { onOutput: (t) => (out += t) }, context);
		expect(exec.ok && exec.value.exitCode).toBe(0);
		expect(out).not.toContain("SECRETKEY");
	});
});
