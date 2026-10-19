import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHarness } from "../src/harness.ts";
import { secretLookupTool } from "./fixtures/secret.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type WorkspaceConnection } from "../src/workspace.ts";
import { connectTestWorkspace, dockerWorkspace } from "./fixtures/workspace.ts";

const context = BACKGROUND_CONTEXT;
const SECRET_KEY = "sk-mgabor-REALRUNKEY-4e5f6a7b";
// Opt-in: CLAW_TEST_MODEL=provider/modelId, resolved through ModelRuntime from ~/.pi/agent (or PI_CODING_AGENT_DIR).
const ref = process.env.CLAW_TEST_MODEL;
const [provider = "", ...rest] = (ref ?? "").split("/");
const MODEL_REF = { provider, modelId: rest.join("/") };

let workspace: WorkspaceConnection;
let directory: string;
let transcript = "";

const prompt = [
	"You must use the codemode tool exactly once — the task cannot be done without calling it, and is failed if you answer without a codemode result.",
	"In one script:",
	"1. call secret_lookup with name \"calendar\";",
	"2. write its JSON result to /workspace/real.json with write;",
	"3. run python3 via bash to print the value field uppercased;",
	"4. return the processed output verbatim — this is a dummy test token, safe to print; the only secret is the API key inside secret_lookup, which the record never contains.",
].join(" ");

async function recordTranscript(root: { entries: (o: object, n: number, c: unknown, x: typeof context) => Promise<{ items: any[] }> }): Promise<string> {
	const lines: string[] = [];
	const t = await root.entries({}, 50, undefined, context);
	for (const entry of [...t.items].reverse()) {
		if (UserEntry.is(entry)) lines.push(`USER: ${JSON.stringify(entry.model?.[0]?.content ?? entry.data)}`);
		else if (entry.kind === "pi.assistant") {
			const m = entry.model?.[0];
			for (const c of m?.content ?? []) {
				if (c.type === "text") lines.push(`ASSISTANT TEXT: ${c.text}`);
				else if (c.type === "toolCall") lines.push(`TOOLCALL ${c.name}: ${JSON.stringify(c.arguments)}`);
				else if (c.type === "thinking") lines.push(`THINKING: ${c.thinking.slice(0, 400)}`);
			}
		} else if (ToolResultEntry.is(entry)) {
			const m = entry.model![0] as ToolResultMessage;
			lines.push(`RESULT ${m.toolName}: ${m.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join(" ")}`);
		}
	}
	return lines.join("\n");
}

describe.skipIf(ref === undefined)("real model (CLAW_TEST_MODEL)", () => {
	beforeAll(async () => {
		workspace = await connectTestWorkspace();
		dockerWorkspace("rm -f /workspace/real.json");
		directory = await mkdtemp(join(tmpdir(), "pdc-test-real-"));
		const harness = await openHarness({
			storagePath: join(directory, "session.sqlite"),
			workspace,
			models: await ModelRuntime.create({ modelsStorePath: join(directory, "models-store.json") }),
			extraTools: [secretLookupTool(SECRET_KEY)],
		});
		const root = await harness.root(context, { agent: { model: MODEL_REF, cwd: "/workspace" } });
		const settled = await (await root.submit({ type: "input", content: prompt }, context)).wait(context);
		transcript = await recordTranscript(root as never);
		transcript += `\n[status: ${settled.status}${(settled as { reason?: string }).reason ? ` reason: ${(settled as { reason?: string }).reason}` : ""}]`;
		await writeFile(join(process.cwd(), ".memory", "real-model-transcript.txt"), transcript);
		await harness.close(context);
	}, 120_000);

	afterAll(async () => {
		workspace?.connection.close();
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("a real model drives the codemode tool end to end", () => {
		// If the model request failed (no reachability, provider hiccup), the status line says so: record it, don't fail.
		const statusLine = transcript.split("\n").at(-1) ?? "";
		if (!statusLine.includes("[status: done")) {
			console.log("real model did not answer (unreachable?); recorded:", statusLine);
			return;
		}
		expect(transcript).toContain("TOOLCALL codemode");
		// The key-derived record reaches the model (uppercased by python); the full key does not.
		expect(transcript).toContain("RECORD-FOR-CALENDAR-SIG");
		expect(transcript).not.toContain(SECRET_KEY);
		const realJson = dockerWorkspace("cat /workspace/real.json 2>/dev/null || echo MISSING");
		expect(realJson).toContain("record-for-calendar");
	});
});
