import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createRegistry, defineExtension, Harness, type Extension, type HarnessOptions, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension, type CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { recordConversationStart, workspaceContextExtension } from "./context.ts";
import { codemodeTimersExtension, timerGlobal } from "./codemode-timers.ts";
import { codemodeCatalogExtension } from "./codemode-catalog.ts";
import { preambleExtension } from "./preamble.ts";
import { fixedPromptExtension } from "./fixed-prompt.ts";
import { compactionExtension } from "./compaction.ts";
import { browserTools, type SharedBrowserProvider } from "./browser.ts";
import { abortable, imageCheckExtension, type TextGenerationModel } from "@mgabor3141/pi-durable-t3";
import { workspaceTools } from "./tools.ts";
import { imageFitExtension } from "./images.ts";
import { directCallsExtension } from "./direct-calls.ts";
import { webTools, type WebConfig } from "./web.ts";
import { summarizeTools } from "./summarize.ts";
import { workspaceEnv, type WorkspaceConnection, WORKSPACE_HOME } from "./workspace.ts";
import { type SecretStore, secretsTool, withSecrets } from "./secrets.ts";

type SecretsLogger = Parameters<typeof withSecrets>[2];

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

/** The parts of the bridge the harness's own tools use, set once it is attached. */
export interface HarnessLate {
	previewBrowser?: SharedBrowserProvider;
	textGenerationModel?: () => TextGenerationModel | undefined;
}

export interface HarnessExtensionOptions {
	/** More script-callable tools (`callers: ["tools"]`), e.g. integrations. */
	readonly extraTools?: readonly ToolRegistration[];
	/** Extensions installed after the built-in tools, such as the MCP server section. */
	readonly extraExtensions?: readonly Extension[];
	/** Namespaces of MCP servers, for codemode's `describeNamespace()`. */
	readonly mcpNamespaces?: readonly CodemodeNamespace[];
	/** The web services: `web_search` and `web_fetch`, each only when configured. */
	readonly web?: WebConfig;
	/** Offer the `browser_*` tools: only when T3's preview browser is configured, since it is the only browser. */
	readonly browser?: boolean;
	/** What exists only once the bridge is attached: the host fills it in after `attachT3`, and the tools read it at each
	 * call. */
	readonly late?: HarnessLate;
	/** The harness's secrets: every harness tool resolves and scrubs them (`secrets.ts`), and scripts get the `secrets` tool. */
	readonly secrets?: { readonly store: SecretStore; readonly log: SecretsLogger };
	/** Prepares the images `read` returns (oriented, converted, shrunk to the model's limits), and fits an image a
	 * script shows that is over them (`images.ts`). */
	readonly images?: ImageProcessor;
}

/**
 * The extensions of the assistant conversation: the preamble, upstream's durable `codemode` extension, and the
 * harness's own tools — the workspace's `read`/`write`/`bash` (pi-durable's coding tools over the call's
 * `ExecutionEnv`, i.e. pi-env SSH to the workspace container; plus any `extraTools`) — all with `callers: ["tools"]`,
 * so only codemode scripts call them. The codemode section is a catalog (`codemode-catalog.ts`): every one of them on
 * one line, `read`/`write`/`edit`/`bash` in full, the rest's declarations from `describeTool()`; MCP tools, which the
 * MCP manager registers, are left out of it and found with `searchTools()`. The system prompt is fixed for a thread
 * (`fixed-prompt.ts`).
 */
export function harnessExtensions(options: HarnessExtensionOptions = {}): readonly Extension[] {
	const tools: ToolRegistration[] = [
		...(options.extraTools ?? []),
		...workspaceTools(options.images),
		...webTools(options.web ?? {}),
		// The browser's sessions do not listen for Stop; each call returns the moment it is stopped.
		...(options.browser === true ? browserTools(options.late).map(abortable) : []),
		...summarizeTools(options.late),
	];
	const secrets = options.secrets;
	const harnessTools = secrets === undefined ? tools : [...tools.map((tool) => withSecrets(tool, secrets.store, secrets.log)), secretsTool(secrets.store)];
	return [
		// Before the fixed prompt: wraps apply in this order, so the fixed prompt keeps the catalog it renders.
		codemodeCatalogExtension({ namespaces: options.mcpNamespaces ?? [] }),
		fixedPromptExtension(),
		preambleExtension(),
		createCodemodeExtension({ sandbox: codemodeSandbox(), namespaces: options.mcpNamespaces ?? [], inlineBudget: Number.POSITIVE_INFINITY, globals: [timerGlobal()] }) as Extension,
		codemodeTimersExtension(),
		defineExtension({ name: "harness-tools", tools: harnessTools }),
		...(options.extraExtensions ?? []),
		workspaceContextExtension(),
		compactionExtension(),
		// An image over the model's limits that a script shows (a full-page screenshot) is shrunk to fit, as `read`'s are;
		// every other image is left as it is.
		...(options.images === undefined ? [] : [imageFitExtension(options.images)]),
		// Only images a provider can read reach the model: a broken one (a screenshot copied while still being written)
		// becomes a text saying why, in the tool result and in every request, so it never stops the thread.
		imageCheckExtension(),
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
	// A direct call to a tool only scripts call is answered with the script that calls it (`direct-calls.ts`).
	registry.install(directCallsExtension(registry));
	options.onRegistry?.(registry);
	const storage = await openNodeSqliteStorage(options.storagePath);
	return Harness.open(
		storage,
		{
			models: options.models,
			registry,
			// Every tool call's environment is the workspace container over SSH, starting where this conversation
			// says it works: a project's root, a Scratch thread's own folder, or the home fallback.
			env: (target) => workspaceEnv(options.workspace.connection, target.cwd ?? options.cwd ?? WORKSPACE_HOME),
			settings: { toolExecution: "sequential" },
			conversationCreated: recordConversationStart(),
		},
		context,
	);
}
