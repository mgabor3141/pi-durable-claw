import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, wrapSection, type ContextView, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { answeredOf, cacheHolds } from "./cache-misses.ts";

/**
 * Every section of the harness's system prompt, in no particular order. test/fixed-prompt.test.ts checks the list
 * against the extensions that provide sections, so a new section cannot be left out.
 */
export const PROMPT_SECTIONS = [
	"preamble",
	"codemode",
	"mcp-servers",
	"global-agents",
	"global-skills",
	"cwd",
	"local-agents",
	"local-skills",
	"conversation-time",
] as const;

/** A section every rendered prompt has: while it is shown, the prompt is in effect. */
const IN_EFFECT = "preamble";

/**
 * The sections that follow what they are made of while a thread goes on (`promptRefresh`): the files a person or an
 * agent edits to change how the agent works. The rest (the preamble, the tool catalog, the working directory, the
 * start time) changes with a deploy or not at all.
 */
export const FOLLOWED_SECTIONS: ReadonlySet<string> = new Set(["global-agents", "local-agents", "global-skills", "local-skills", "mcp-servers"]);

/** What `promptRefresh` reads of a model. */
export type RefreshModel = {
	readonly provider: string;
	readonly id: string;
	readonly promptCache?: { readonly short?: number; readonly long?: number };
	readonly compat?: unknown;
};

/**
 * What a request's preparation does with a prompt that is in effect:
 * - `keep`: every section as the thread shows it.
 * - `update`: the followed sections rendered afresh. A changed one is written as a system message where the
 *   conversation is, which pi sends in place to a model that takes system messages there
 *   (`compat.supportsMidConvoSystemMessages`): "Updated system prompt section …", after everything the provider has
 *   cached, so the cache holds and the agent learns of the change.
 * - `reload`: every section rendered afresh, as after `/reload`. For a model that takes no such message a change
 *   rewrites the start of the request, which costs the whole context again unless the cache has expired anyway.
 *
 * Only where a user's message is the last thing in the context: a run's start, or a steer. Not after a tool result,
 * so a run's later requests never wait on the workspace's files, and an update never stands where a model could take
 * it for a tool's output. Where nothing says whether the provider's cache holds, the prompt is kept: `/reload` is
 * the way then.
 */
export function promptRefresh(messages: readonly Message[], model: RefreshModel | undefined, now: number): "keep" | "update" | "reload" {
	if (model === undefined || messages.findLast((message) => message.role !== "system")?.role !== "user") return "keep";
	if ((model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true) return "update";
	const cache = cacheHolds(answeredOf(messages), model, now);
	return !cache.holds && cache.known ? "reload" : "keep";
}

export type FixedPromptOptions = {
	/** The model catalog. Absent: the prompt changes only on `/reload` and a compaction. */
	readonly models?: ModelCatalog | (() => ModelCatalog);
	/** The clock a cache's age is read against. Default `Date.now`; tests override it. */
	readonly now?: () => number;
};

type ModelCatalog = { getModel(provider: string, modelId: string): RefreshModel | undefined };

/** A preparation's `read` is its task's runtime; this is the part of it used here. */
type PreparationRuntime = { context?(conversationId: ConversationId, context: Context): Promise<ContextView> };

/**
 * The system prompt is rendered once and then kept as it is: every later request answers each section with what the
 * thread already shows, so the cached prefix holds whatever changes underneath (AGENTS.md, skills, ~/.mcp.json, the
 * tools registered). A section absent then stays absent. It is rendered afresh when nothing is shown: a new thread,
 * `/reload` (the bridge's `Threads.reload` removes every shown section), and a compaction (its first request writes the
 * whole prompt again, after the head). One exception: the history a compaction keeps (its last ~20k tokens) can hold
 * the prompt a recent `/reload` rendered, and then that prompt is the one kept. Nothing tells a section that a
 * compaction's baseline is being written, and only a `/reload` puts sections in the history.
 *
 * And where it costs nothing, it follows its files by itself (`promptRefresh`): a model that takes a system message
 * in the middle of a conversation is told of a changed AGENTS.md, skill or MCP server with its next message, and
 * another model's prompt is rendered again when its cache has expired.
 */
export function fixedPromptExtension(options: FixedPromptOptions = {}): Extension {
	// One decision for a preparation: its sections are rendered with the same input, one after another.
	const decided = new WeakMap<object, Promise<"keep" | "update" | "reload">>();
	const refresh = (input: { readonly conversationId: ConversationId; readonly agent: { readonly model?: { provider: string; modelId: string } }; readonly read: unknown }, context: Context) => {
		let decision = decided.get(input);
		if (decision === undefined) {
			decision = (async () => {
				const runtime = input.read as PreparationRuntime;
				const ref = input.agent.model;
				if (options.models === undefined || ref === undefined || typeof runtime.context !== "function") return "keep";
				const view = await runtime.context(input.conversationId, context);
				const models = typeof options.models === "function" ? options.models() : options.models;
				return promptRefresh(view.messages, models.getModel(ref.provider, ref.modelId), (options.now ?? Date.now)());
			})();
			decided.set(input, decision);
		}
		return decision;
	};
	return defineExtension({
		name: "fixed-prompt",
		wraps: PROMPT_SECTIONS.map((key) =>
			wrapSection(key, (section) => ({
				key: section.key,
				// The shown text is already tagged: tag a fresh rendering here, as pi-durable would.
				tag: false,
				render: async (input, context) => {
					if (input.shown[IN_EFFECT] !== undefined) {
						const mode = await refresh(input, context);
						if (mode === "keep" || (mode === "update" && !FOLLOWED_SECTIONS.has(key))) return input.shown[key];
					}
					// A section that cannot be read throws, and pi-durable keeps what the thread shows of it.
					const text = await section.render(input, context);
					return text === undefined || section.tag === false ? text : `<${key}>\n${text}\n</${key}>`;
				},
			})),
		),
	});
}
