import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createRegistry, defineExtension, Harness, type Extension, type HarnessOptions, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension, type CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { workspaceMemoryExtension } from "./memory.ts";
import { preambleExtension } from "./preamble.ts";
import { compactionExtension } from "./compaction.ts";
import { browserTools } from "./browser.ts";
import { workspaceTools } from "./tools.ts";
import { webTools } from "./web.ts";
import { summarizeTools } from "./summarize.ts";
import { workspaceEnv, type WorkspaceConnection } from "./workspace.ts";

/**
 * What one codemode script's VM may allocate (`CLAW_CODEMODE_MEMORY_MB`, default 256 MiB). The VMs run in worker threads
 * of the host process, so without a limit a runaway script takes the host down with it; with one, the script fails with
 * QuickJS's `out of memory` and the turn goes on. Large data belongs in tools and files, not in script memory.
 */
export function codemodeMemoryLimitBytes(env: Readonly<Record<string, string | undefined>> = process.env): number {
	const megabytes = Number(env.CLAW_CODEMODE_MEMORY_MB ?? "");
	return (Number.isFinite(megabytes) && megabytes > 0 ? megabytes : 256) * 1024 * 1024;
}

/** One QuickJS sandbox per process is enough: each execution gets its own VM and worker. */
let sharedSandbox: CodemodeSandbox | undefined;
export function codemodeSandbox(): CodemodeSandbox {
	return (sharedSandbox ??= new CodemodeSandbox({ memoryLimitBytes: codemodeMemoryLimitBytes() }));
}

export interface HarnessExtensionOptions {
	/** More script-callable tools (`callers: ["tools"]`), e.g. integrations. */
	readonly extraTools?: readonly ToolRegistration[];
	/** Extensions installed after the built-in tools, such as the MCP server section. */
	readonly extraExtensions?: readonly Extension[];
	/** Namespaces of MCP servers, for codemode's `describeNamespace()` and tool search. */
	readonly mcpNamespaces?: readonly CodemodeNamespace[];
	/** Offer `tool_search` when deferred tools (normally MCP tools) are configured. */
	readonly toolSearch?: boolean;
}

/**
 * The extensions of the assistant conversation: the preamble, upstream's durable `codemode` extension, the optional
 * `tool_search` tool for deferred tools, and the harness's own tools — the workspace's `read`/`write`/`bash`
 * (pi-durable's coding tools over the call's `ExecutionEnv`, i.e. pi-env SSH to the workspace container; plus any
 * `extraTools`) — all with `callers: ["tools"]`, so only codemode scripts call them. MCP tools are registered
 * separately by the MCP manager and are deferred by default. The host adds the model-facing restart_harness tool as
 * an extra extension.
 */
export function harnessExtensions(options: HarnessExtensionOptions = {}): readonly Extension[] {
	const harnessTools: ToolRegistration[] = [
		...(options.extraTools ?? []),
		...workspaceTools(),
		...webTools(),
		...browserTools(),
		...summarizeTools(),
	];
	return [
		preambleExtension({ toolSearch: options.toolSearch }),
		createCodemodeExtension({ sandbox: codemodeSandbox(), namespaces: options.mcpNamespaces ?? [] }) as Extension,
		...(options.toolSearch === true ? [createToolSearchExtension() as Extension] : []),
		defineExtension({ name: "harness-tools", tools: harnessTools }),
		...(options.extraExtensions ?? []),
		workspaceMemoryExtension(),
		compactionExtension(),
	];
}

export interface HarnessConfig extends HarnessExtensionOptions {
	storagePath: string;
	/** The workspace connection the workspace tools' read/write/bash go to. */
	workspace: WorkspaceConnection;
	/** The model catalog. */
	models: HarnessOptions["models"];
	cwd?: string;
	/** Called with the registry before the harness opens, so integrations can install dynamic extensions. */
	onRegistry?: (registry: Registry) => void;
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
	for (const extension of harnessExtensions(options)) registry.install(extension);
	options.onRegistry?.(registry);
	const storage = await openNodeSqliteStorage(options.storagePath);
	return Harness.open(
		storage,
		{
			models: options.models,
			registry,
			// Every tool call's environment is the workspace container over SSH, starting where this conversation
			// says it works: a project's root, a Scratch thread's own folder, or the home fallback.
			env: (target) => workspaceEnv(options.workspace.connection, target.cwd ?? options.cwd ?? "/home/agent"),
			settings: { toolExecution: "sequential" },
		},
		context,
	);
}
