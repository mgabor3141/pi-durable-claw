import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHarness } from "../src/harness.ts";
import { codemodeAnswer, fauxModels } from "./fixtures/faux.ts";
import { type WorkspaceConnection } from "../src/workspace.ts";
import { connectTestWorkspace, dockerWorkspace } from "./fixtures/workspace.ts";

const context = BACKGROUND_CONTEXT;
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
let directory: string;
let storagePath: string;
let workspace: WorkspaceConnection;
let child: ChildProcess | undefined;

/** Count lines matching `marker` in the side-effect file, through docker exec (never trusting the container). */
function countLines(marker: string): number {
	const out = dockerWorkspace(`grep -c '^${marker}$' /workspace/crash-ran 2>/dev/null || true`).trim();
	return Number(out || "0");
}

beforeAll(async () => {
	workspace = await connectTestWorkspace();
	dockerWorkspace("rm -f /workspace/crash-ran");
	directory = await mkdtemp(join(tmpdir(), "pdc-test-crash-"));
	storagePath = join(directory, "session.sqlite");
	await writeFile(storagePath, "");
});

afterAll(async () => {
	if (child?.pid !== undefined) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
	workspace?.connection.close();
	if (directory) await rm(directory, { recursive: true, force: true });
});

describe("crash mid-script: durable codemode resumes from its journal", () => {
	it("kills the harness mid-script; the script resumes, completes, and completed calls ran exactly once", async () => {
		// Start the child harness; it submits and blocks inside the codemode script's nested bash call.
		child = spawn(
			process.execPath,
			[join(repoRoot, "test", "crash-harness.ts"), storagePath],
			{ cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"], env: process.env },
		);
		const proc = child;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("child did not submit within 60s")), 60_000);
			proc.stdout!.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("SUBMITTED")) {
					clearTimeout(timer);
					resolve();
				}
			});
			proc.on("exit", (code) => reject(new Error(`child exited early: ${code}`)));
		});

		// Wait for the first nested call's side effect, then a moment for its journal commit, then kill -9
		// while the second nested call (`sleep 300`) is running.
		for (let i = 0; i < 200; i++) {
			if (countLines("run") >= 1) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(countLines("run")).toBe(1);
		await new Promise((r) => setTimeout(r, 1000));
		process.kill(proc.pid!, "SIGKILL");
		await new Promise((resolve) => proc.on("exit", resolve));

		// Reopen the same store and resume.
		const { faux, models } = fauxModels();
		faux.setResponses([codemodeAnswer("recovered")]);
		const harness = await openHarness({ storagePath, workspace, models });
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/workspace" } });
		harness.resume();

		// The run settles: the codemode call's result is the script's own, from the resumed VM.
		let toolText = "";
		for (let i = 0; i < 600 && toolText === ""; i++) {
			const transcript = await root.entries({}, 50, undefined, context);
			for (const entry of transcript.items) {
				if (ToolResultEntry.is(entry)) {
					const message = entry.model![0] as ToolResultMessage;
					if (message.toolName === "codemode") {
						toolText = message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
					}
				}
			}
			if (toolText === "") await new Promise((r) => setTimeout(r, 100));
		}

		// Resumed and completed: the journal replayed call 1, the interrupted sleep rejected into the catch, and
		// the script ran its last call and returned.
		console.log("[crash] codemode result:", JSON.stringify(toolText.slice(0, 500)));
		expect(toolText).toContain("resumed-and-completed");
		expect(toolText).toContain("interrupted:");
		// The nested call that completed before the kill ran exactly once (its result came from the journal);
		// the post-resume append ran exactly once; the interrupted call's side effect never landed.
		expect(countLines("run")).toBe(1);
		expect(countLines("done")).toBe(1);
		expect(countLines("slept")).toBe(0);

		await harness.close(context);
	}, 180_000);
});
