import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createRegistry, defineExtension, Harness, type Extension, type HarnessOptions, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { workspaceMemoryExtension } from "./memory.ts";
import { browserTools } from "./browser.ts";
import { workspaceTools } from "./tools.ts";
import { webTools } from "./web.ts";
import { workspaceEnv, type WorkspaceConnection } from "./workspace.ts";

/** One QuickJS sandbox per process is enough: each execution gets its own VM and worker. */
let sharedSandbox: CodemodeSandbox | undefined;
export function codemodeSandbox(): CodemodeSandbox {
	return (sharedSandbox ??= new CodemodeSandbox());
}

/**
 * The extensions of the assistant conversation: upstream's durable `codemode` extension, and the harness's own tools —
 * the workspace's `read`/`write`/`bash` (pi-durable's coding tools over the call's `ExecutionEnv`, i.e. pi-env SSH to
 * the workspace container; plus any `extraTools`) — all with `callers: ["tools"]`, so only codemode scripts call them
 * and the model is offered exactly one tool: `codemode`.
 */
export function harnessExtensions(extraTools: readonly ToolRegistration[] = []): readonly Extension[] {
	const harnessTools: ToolRegistration[] = [...extraTools, ...workspaceTools(), ...webTools(), ...browserTools()];
	return [
		createCodemodeExtension({ sandbox: codemodeSandbox() }) as Extension,
		defineExtension({ name: "harness-tools", tools: harnessTools }),
		workspaceMemoryExtension(),
	];
}

export interface HarnessConfig {
	storagePath: string;
	/** The workspace connection the workspace tools' read/write/bash go to. */
	workspace: WorkspaceConnection;
	/** The model catalog. */
	models: HarnessOptions["models"];
	/** More script-callable tools (`callers: ["tools"]`), e.g. integrations. */
	extraTools?: readonly ToolRegistration[];
	cwd?: string;
}

/**
 * A pi-durable Harness whose only model-facing tool is upstream's `codemode`, whose environment is the workspace over
 * SSH (pi-env), and whose scripts reach the workspace tools as nested calls.
 */
export async function openHarness(
	options: HarnessConfig,
	context: Context = BACKGROUND_CONTEXT,
): Promise<Harness> {
	const registry = createRegistry();
	for (const extension of harnessExtensions(options.extraTools)) registry.install(extension);
	const storage = await openNodeSqliteStorage(options.storagePath);
	return Harness.open(
		storage,
		{
			models: options.models,
			registry,
			// Every tool call's environment is the workspace container over SSH.
			env: () => workspaceEnv(options.workspace.connection, options.cwd ?? "/workspace"),
			settings: { toolExecution: "sequential" },
		},
		context,
	);
}
