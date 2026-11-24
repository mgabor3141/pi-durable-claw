import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, type Extension, type HarnessOptions, type HarnessSettings, type Registry, type ToolNamespace, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { recordConversationStart, workspaceContextExtension } from "./context.ts";
import { codemodeTimersExtension, timerGlobal } from "./codemode-timers.ts";
import { codemodeCatalogExtension } from "./codemode-catalog.ts";
import { preambleExtension } from "./preamble.ts";
import { fixedPromptExtension } from "./fixed-prompt.ts";
import { compactionExtension, type CompactionOptions } from "./compaction.ts";
import { browserTools, type SharedBrowserProvider } from "./browser.ts";
import { abortable, imageCheckExtension, type T3Attachment } from "@mgabor3141/pi-durable-t3";
import { workspaceTools } from "./tools.ts";
import { machineGate, type Machines, machineTools, onMachine } from "./machines.ts";
import { imageFitExtension } from "./images.ts";
import { directCallsExtension } from "./direct-calls.ts";
import { webTools, type WebConfig } from "./web.ts";
import { summarizeTools } from "./summarize.ts";
import { workspaceEnv, type WorkspaceConnection, WORKSPACE_HOME } from "./workspace.ts";
import { type SecretStore, secretsTool, withSecrets } from "./secrets.ts";
import { setting, type Env } from "./env.ts";

type SecretsLogger = Parameters<typeof withSecrets>[2];

/**
 * What one codemode script's VM may allocate (`CLAW_CODEMODE_MEMORY_MB`, default 256 MiB). The VMs run in worker threads
 * of the host process, so without a limit a runaway script takes the host down with it; with one, the script fails with
 * QuickJS's `out of memory` and the turn goes on. Large data belongs in tools and files, not in script memory. Not a
 * positive number: fails loudly.
 */
export function codemodeMemoryLimitBytes(env: Env = process.env): number {
	const value = setting(env, "CLAW_CODEMODE_MEMORY_MB");
	if (value === undefined) return 256 * 1024 * 1024;
	const megabytes = Number(value);
	if (!Number.isFinite(megabytes) || megabytes <= 0) throw new Error(`CLAW_CODEMODE_MEMORY_MB must be a number of MiB above 0, not ${JSON.stringify(value)}`);
	return megabytes * 1024 * 1024;
}

/** One QuickJS sandbox per process is enough: each execution gets its own VM and worker. */
let sharedSandbox: CodemodeSandbox | undefined;
export function codemodeSandbox(): CodemodeSandbox {
	return (sharedSandbox ??= new CodemodeSandbox({ memoryLimitBytes: codemodeMemoryLimitBytes() }));
}

/**
 * What exists only once the bridge is attached. The harness is opened first (the bridge attaches to it), so what the
 * harness's own tools and extensions need of the bridge is read from here, at each use.
 */
export interface HarnessLate {
	/** The bridge: T3's text-generation model (`summarize`), the models hidden from its picker (left out of the lists a
	 * script sees), and whose a conversation is (a person's thread keeps its prompt cache for an hour). */
	bridge?: Pick<T3Attachment, "textGenerationModel" | "hiddenModels" | "threadOf" | "threadOrigin" | "requestApproval">;
	/** T3's preview browser, when one is configured: the `browser_*` tools' pages. */
	previewBrowser?: SharedBrowserProvider;
}

export interface HarnessExtensionOptions {
	/** More script-callable tools (`callers: ["tools"]`), e.g. integrations. */
	readonly extraTools?: readonly ToolRegistration[];
	/** Extensions installed after the built-in tools, such as the MCP server section. */
	readonly extraExtensions?: readonly Extension[];
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
	/** The model catalog: what a model takes decides how a thread's prompt follows its files (`fixed-prompt.ts`). */
	readonly models?: HarnessOptions["models"];
	/** Told what each compaction's summary cost, and when one could not be asked for on the conversation (`compaction.ts`). */
	readonly compaction?: CompactionOptions;
	/** Other machines (`machines.ts`): `bash`, `read`, `write` and `edit` take a `machine`, and scripts get the tools that
	 * manage them and `copy_file`. */
	readonly machines?: Machines;
}

/** The workspace tools that also run on a machine, and what each says it is about to do there, for the approval card. */
const ON_MACHINE: Readonly<Record<string, (args: Record<string, unknown>) => string>> = {
	bash: (args) => clip(String(args["command"] ?? "")),
	read: (args) => String(args["path"] ?? ""),
	write: (args) => String(args["path"] ?? ""),
	edit: (args) => String(args["path"] ?? ""),
};
const clip = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);
const machineAware = (tool: ToolRegistration, machines: Machines): ToolRegistration => (ON_MACHINE[tool.name] === undefined ? tool : onMachine(tool, machines));

/**
 * The extensions of the assistant conversation: the preamble, upstream's durable `codemode` extension, and the
 * harness's own tools. The workspace's `read`/`write`/`edit`/`bash` (pi-durable's coding tools over the call's
 * `ExecutionEnv`, i.e. pi-env SSH to the workspace container) are the model's as well as the scripts'; the rest
 * (`ssh`, the `extraTools`, the web, browser, machine, summarize and secrets tools) have `callers: ["tools"]`, so only
 * codemode scripts call them. The codemode section is a catalog (`codemode-catalog.ts`): every one of them on one line,
 * `read`/`write`/`edit`/`bash` in full, the rest's declarations from `describeTool()`; MCP tools, which the MCP manager
 * registers, are left out of it and found with `searchTools()`. The system prompt is fixed for a thread
 * (`fixed-prompt.ts`).
 */
export function harnessExtensions(options: HarnessExtensionOptions = {}): readonly Extension[] {
	const machines = options.machines;
	const tools: ToolRegistration[] = [
		...(options.extraTools ?? []),
		...workspaceTools(options.images).map((tool) => (machines === undefined ? tool : machineAware(tool, machines))),
		...(machines === undefined ? [] : machineTools(machines)),
		...webTools(options.web ?? {}),
		// The browser's sessions do not listen for Stop; each call returns the moment it is stopped.
		...(options.browser === true ? browserTools(options.late).map(abortable) : []),
		...summarizeTools(options.late),
	];
	const secrets = options.secrets;
	const harnessTools = secrets === undefined ? tools : [...tools.map((tool) => withSecrets(tool, secrets.store, secrets.log)), secretsTool(secrets.store)];
	return [
		// Before the fixed prompt: wraps apply in this order, so the fixed prompt keeps the catalog it renders.
		codemodeCatalogExtension(),
		fixedPromptExtension(options.models === undefined ? {} : { models: options.models }),
		preambleExtension(),
		createCodemodeExtension({ sandbox: codemodeSandbox(), inlineBudget: Number.POSITIVE_INFINITY, globals: [timerGlobal()] }) as Extension,
		codemodeTimersExtension(),
		defineExtension({ name: "harness-tools", tools: harnessTools }),
		// A call that uses a machine waits, parked, for the user's approval before it runs.
		...(machines === undefined ? [] : [machineGate(machines, ON_MACHINE)]),
		...(options.extraExtensions ?? []),
		workspaceContextExtension(),
		compactionExtension(options.compaction),
		// An image over the model's limits that a script shows (a full-page screenshot) is shrunk to fit, as `read`'s are;
		// every other image is left as it is.
		...(options.images === undefined ? [] : [imageFitExtension(options.images)]),
		// Only images a provider can read reach the model: a broken one (a screenshot copied while still being written)
		// becomes a text saying why, in the tool result and in every request, so it never stops the thread.
		imageCheckExtension(),
	];
}

/** The thread tools, grouped in codemode's listing. */
export const THREAD_NAMESPACE: ToolNamespace = {
	name: "thread",
	description: "Other agents' threads: start a child or follow up (thread_prompt), wait for, read, search, list and stop threads",
};

/**
 * The bridge's thread tools as two extensions: the `thread_*` tools, the `thread` namespace, and the rest (scheduled
 * tasks, projects, a thread's title, pins and queue), which belong to none. A codemode namespace is the extension that
 * brings the tools (`Extension.namespace`), and the bridge brings all of them in one.
 */
export function threadToolExtensions(threadTools: Extension): readonly Extension[] {
	const tools = threadTools.tools ?? [];
	const threads = (tool: ToolRegistration) => tool.name.startsWith("thread_");
	// A bridge that renamed its thread tools would silently drop the `## thread` heading and change the prompt.
	if (!tools.some(threads)) throw new Error(`${threadTools.name} brings no thread_* tools: the thread namespace would be empty`);
	return [
		{ ...threadTools, namespace: THREAD_NAMESPACE, tools: tools.filter(threads) },
		defineExtension({ name: `${threadTools.name}-t3`, tools: tools.filter((tool) => !threads(tool)) }),
	];
}

export interface HarnessConfig extends HarnessExtensionOptions {
	storagePath: string;
	/** The workspace connection the workspace tools' read/write/bash go to. */
	workspace: WorkspaceConnection;
	/** The model catalog. */
	models: HarnessOptions["models"];
	/** Called with the registry before the harness opens, so integrations can install dynamic extensions. */
	onRegistry?: (registry: Registry) => void;
}

/**
 * A model request that failed for a passing reason (out of usage, overloaded, the network) is sent again: after 2
 * seconds, then twice as long each time up to 5 minutes, 64 times, which is 4 hours 48 minutes in all: about a
 * five-hour rate-limit window, so one clears on its own. Every wait is the harness's own: durable (it survives a
 * restart), shown in T3, and ended by Stop.
 */
export const RETRY_POLICY = { enabled: true, maxRetries: 64, baseDelayMs: 2_000, maxAgentDelayMs: 300_000 } as const;

/**
 * A provider that says when to come back (`retry-after` on a 429 or a 5xx) is taken at its word for up to a minute:
 * pi waits that long inside the request and sends it again, three times at most, before the request counts as failed for
 * `RETRY_POLICY`. Both fields are needed. pi sends a request once unless `maxRetries` says otherwise, and without a
 * second try it never reads what the provider asked for. A longer delay is refused at once, which is what an exhausted
 * plan sends: a 7-day overage window answers 429 with `retry-after` near 5 days, and waiting it out inside the request
 * showed only "Thinking" with no error or retry row. Failing it here puts the wait the provider asked for in the
 * error, and the bridge acts on it: it ends the run and continues it when the limit has reset (within 5 hours), which
 * T3 shows as its usage limit with the time. `RETRY_POLICY` is for the failures that say no time.
 */
export const PROVIDER_RETRY = { maxRetries: 3, maxRetryDelayMs: 60_000 } as const;

/**
 * The harness's run policy. Tools run one at a time; failed requests are retried as above; and every steer that waits
 * reaches the model at the run's next boundary, together (pi-durable's default places one a boundary), as T3's
 * providers take the messages a person sends while the agent works.
 */
export const HARNESS_SETTINGS = { toolExecution: "sequential", retry: RETRY_POLICY, stream: PROVIDER_RETRY, steeringMode: "all" } as const satisfies HarnessSettings;

/**
 * A pi-durable Harness whose model calls `codemode` and the workspace's `read`/`write`/`edit`/`bash`, whose environment
 * is the workspace over SSH (pi-env), and whose scripts reach the harness's tools as nested calls.
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
			env: (target) => workspaceEnv(options.workspace.connection, target.cwd ?? WORKSPACE_HOME),
			settings: HARNESS_SETTINGS,
			conversationCreated: recordConversationStart(),
		},
		context,
	);
}
