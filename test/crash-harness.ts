// The crash-check child: a harness that starts an upstream codemode call that blocks mid-script (inside a nested
// bash call), then stays alive so the test can kill it. Run with:
// node test/crash-harness.ts <storagePath>
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openHarness } from "../src/harness.ts";
import { codemodeAnswer, codemodeToolCall, fauxModels } from "./fixtures/faux.ts";
import { connectTestWorkspace } from "./fixtures/workspace.ts";

const storagePath = process.argv[2]!;

const context = BACKGROUND_CONTEXT;

// Nested call 1: append a line (completes, and is journaled). Nested call 2: a long-running sleep — the test kills
// the process while it runs. On resume the replay delivers call 1's journaled result without running it again; the
// interrupted sleep rejects, the script catches it, and call 3 finishes the job. The appends count the side effects.
const script = `
	await tools.bash({ command: "printf 'run\\n' >> /workspace/crash-ran" });
	let resumed = false;
	try {
		await tools.bash({ command: "sleep 300 && printf 'slept\\n' >> /workspace/crash-ran" });
	} catch (error) {
		resumed = true;
		text("interrupted: " + (error && error.message ? String(error.message) : String(error)));
	}
	await tools.bash({ command: "printf 'done\\n' >> /workspace/crash-ran" });
	return resumed ? "resumed-and-completed" : "completed-without-interrupt";
`;

const workspace = await connectTestWorkspace();
const { faux, models } = fauxModels();
faux.setResponses([codemodeToolCall(script), codemodeAnswer("done after")]);

const harness = await openHarness({
	storagePath,
	workspace,
	models,
	cwd: "/workspace",
});
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/workspace" } });
harness.resume();
await root.submit({ type: "input", content: "Run the crash script.", requestId: "crash-1" }, context);
console.log("SUBMITTED");

// Keep the process alive; the scheduler runs the script and its nested calls as tasks.
setInterval(() => {}, 1000);
