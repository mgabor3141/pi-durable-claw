import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ModelThinkingLevel, SimpleStreamOptions, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import { answeredOf, cacheHolds, sentOf } from "./cache-misses.ts";
import {
	COMPACTION_INLINE_PROMPT,
	COMPACTION_NO_HISTORY,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_PROMPT,
	COMPACTION_SYSTEM_PROMPT,
	COMPACTION_TOOL_REFUSED,
	COMPACTION_TURN_PREFIX_PROMPT,
	COMPACTION_UPDATE_PROMPT,
	compactionPrompt,
	compactionTurnPrefixPrompt,
	splitTurnSummary,
	withCompactionFocus,
} from "./prompts.ts";
import {
	CompactionTask,
	GenerationTask,
	ProviderDoc,
	UsageDoc,
	defineExtension,
	hook,
	type CompactionHooks,
	type ContextView,
	type ConversationId,
	type EntryId,
	type EntryRecord,
	type Extension,
	type HookApi,
} from "@earendil-works/pi-durable";

/**
 * The summary of a compaction, written two ways.
 *
 * On the conversation (`summarizeOnConversation`): the request the agent itself would send next (its system prompt,
 * tools and history, through the same request hooks and with the same options) with one more user message that asks
 * for the summary. A provider's prompt cache matches a request's start byte for byte, so this request reads the whole
 * conversation from the cache the agent's own requests wrote, at a tenth of the input price on Anthropic, where a
 * request of its own (another system prompt, the conversation as text) pays for every token again. Claude Code,
 * opencode and Codex summarize this way. pi 1.5 carries the prompt and the tools in the transcript's system messages,
 * so the conversation's context is the whole request; nothing of it is rebuilt here.
 *
 * From a transcript (`summarize`): pi's compaction prompt, copied from the coding agent, over the conversation
 * serialized as text, with an update prompt when a previous summary exists and a split-turn prefix summary. It is what
 * is left when the first way cannot work: the context is already too long for the model (an `overflow` compaction, or a
 * request the provider refuses), the model would not write a summary, or the first way would cost more
 * (`cheaperFromTranscript`: the cache has expired, so the whole conversation would be written to it again for one
 * request). All prompt text lives in `prompts.ts`.
 */

/** A compaction hook's `api` is its task's runtime; these are the parts of it used here. */
type CompactionRuntime = HookApi & {
	readonly signal?: AbortSignal;
	readonly settings: { readonly stream: SimpleStreamOptions & { readonly deferred?: unknown } };
	agent(context: Context): Promise<{
		model?: { provider: string; modelId: string };
		thinkingLevel: ModelThinkingLevel;
		extensions?: readonly Extension[];
	}>;
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	context(conversationId: ConversationId, context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
	commit(change: (tx: any) => unknown, context: Context): Promise<void>;
};

/** What a summary on the conversation cost, for whoever wants to see that the cache was read. */
export type SummaryUsage = { readonly conversationId: ConversationId; readonly model: string; readonly requests: number; readonly usage: Usage };

export type CompactionOptions = {
	/** Told of each summary written on the conversation: `usage.cacheRead` is what the provider's cache answered. */
	readonly summarized?: (summary: SummaryUsage) => void;
	/** Told why a summary on the conversation was given up for one from a transcript. */
	readonly gaveUp?: (conversationId: ConversationId, why: string) => void;
};

/** A summary may take this many requests: the model is asked again after a tool call it made instead. */
const SUMMARY_REQUESTS = 3;

type SummaryRequest = {
	readonly api: HookApi;
	readonly context: Context;
	readonly model: NonNullable<ReturnType<HookApi["models"]["getModel"]>>;
	readonly thinkingLevel?: ModelThinkingLevel;
};

/** The exact summary text of a previous compaction, without durable's presentation wrapper. */
export function previousSummary(entry: EntryRecord | undefined): string | undefined {
	if (entry?.kind !== "pi.compaction") return undefined;
	const wrapped = messageText(entry.model?.[0]);
	const start = wrapped.indexOf("<summary>\n");
	const end = wrapped.lastIndexOf("\n</summary>");
	if (start < 0 || end < start) return undefined;
	return wrapped.slice(start + "<summary>\n".length, end);
}

function messageText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** Strip legacy file tags from a previous summary; new summaries name their own relevant files. */
function prose(summary: string): string {
	return summary
		.replace(/\n\n<read-files>[\s\S]*?<\/modified-files>/g, "")
		.replace(/\n\n<read-files>[\s\S]*?<\/read-files>/g, "")
		.replace(/\n\n<modified-files>[\s\S]*?<\/modified-files>/g, "")
		.trim();
}

function promptFor(messages: readonly Message[], prior: string | undefined, instructions: string | undefined): string {
	const prompt = withCompactionFocus(prior === undefined ? COMPACTION_SUMMARY_PROMPT : COMPACTION_UPDATE_PROMPT, instructions);
	return compactionPrompt(serializeConversation([...messages]), prior, prompt);
}

function turnPrefixPrompt(messages: readonly Message[], instructions: string | undefined): string {
	return compactionTurnPrefixPrompt(serializeConversation([...messages]), withCompactionFocus(COMPACTION_TURN_PREFIX_PROMPT, instructions));
}

function lastUserIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

/** A cut after a non-user entry is inside a user turn, as in the coding agent's split-turn path. */
async function isSplitTurn(compaction: Parameters<CompactionHooks["beforeCompact"]>[0], api: CompactionRuntime, context: Context): Promise<boolean> {
	try {
		const firstKept = await api.entry(compaction.firstKept, context);
		const role = firstKept?.model?.at(0)?.role;
		return role !== undefined && role !== "user";
	} catch {
		return false;
	}
}

async function summaryModel(api: CompactionRuntime, context: Context): Promise<{ model: NonNullable<ReturnType<HookApi["models"]["getModel"]>>; thinkingLevel?: ModelThinkingLevel } | undefined> {
	const agent = await api.agent(context);
	if (agent.model === undefined) return undefined;
	const model = api.models.getModel(agent.model.provider, agent.model.modelId);
	return model === undefined ? undefined : { model, thinkingLevel: agent.thinkingLevel };
}

function textOf(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "stop") return undefined;
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	const text = message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
	return text.length === 0 ? undefined : text;
}

function addUsage(total: Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** Summaries are spend, not conversation entries: record them in the conversation's `pi.usage` like durable does. */
async function recordUsage(request: SummaryRequest, response: AssistantMessage): Promise<void> {
	const runtime = request.api as CompactionRuntime;
	try {
		await runtime.commit(async (tx) => {
			const state = await tx.doc(UsageDoc, runtime.conversationId);
			const key = `${response.provider}/${response.model}`;
			const total = Object.hasOwn(state.models, key) ? state.models[key] : undefined;
			if (total === undefined) state.models[key] = JSON.parse(JSON.stringify(response.usage));
			else addUsage(total, response.usage);
		}, request.context);
	} catch {
		// The summary is still useful if the ledger write loses a race with a closing task.
	}
}

async function complete(request: SummaryRequest, prompt: string): Promise<string | undefined> {
	const options: SimpleStreamOptions = {
		cacheRetention: "none",
		signal: request.context.abortSignal,
		...(request.thinkingLevel === undefined || request.thinkingLevel === "off" ? {} : { reasoning: request.thinkingLevel }),
	};
	const response = await request.api.models.completeSimple(
		request.model,
		{
			messages: [
				{ role: "system", content: COMPACTION_SYSTEM_PROMPT, timestamp: Date.now() },
				{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
			],
		},
		options,
	);
	const text = textOf(response);
	if (text !== undefined) await recordUsage(request, response);
	return text;
}

/** Strip a previous summary's head message before serialization: it is passed as `<previous-summary>` instead. */
function withoutHeadSummary(messages: readonly Message[], previous: string | undefined): readonly Message[] {
	if (previous === undefined || messages.length === 0) return messages;
	const first = messages[0];
	if (first?.role !== "user") return messages;
	const text =
		typeof first.content === "string"
			? first.content
			: first.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	return text.startsWith(COMPACTION_SUMMARY_PREFIX) ? messages.slice(1) : messages;
}

async function summarize(
	compaction: Parameters<CompactionHooks["beforeCompact"]>[0],
	api: HookApi,
	context: Context,
): Promise<{ summary: string } | undefined> {
	const runtime = api as CompactionRuntime;
	const model = await summaryModel(runtime, context);
	if (model === undefined) return undefined;
	const previous = previousSummary(compaction.entries[0]);
	const prior = previous === undefined ? undefined : prose(previous);
	const messages = withoutHeadSummary(compaction.messages, previous);
	const request: SummaryRequest = { api: runtime, context, model: model.model, thinkingLevel: model.thinkingLevel };

	let summary: string | undefined;
	if (messages.length === 0) {
		summary = prior;
	} else if (await isSplitTurn(compaction, runtime, context)) {
		const split = lastUserIndex(messages);
		const history = split < 0 ? messages : messages.slice(0, split);
		const prefix = split < 0 ? [] : messages.slice(split);
		const historySummary =
			history.length === 0
				? prior ?? COMPACTION_NO_HISTORY
				: await complete(request, promptFor(history, prior, compaction.instructions));
		if (historySummary === undefined) return undefined;
		if (prefix.length === 0) {
			summary = historySummary;
		} else {
			const prefixSummary = await complete(request, turnPrefixPrompt(prefix, compaction.instructions));
			if (prefixSummary === undefined) return undefined;
			summary = splitTurnSummary(historySummary, prefixSummary);
		}
	} else {
		summary = await complete(request, promptFor(messages, prior, compaction.instructions));
	}
	if (summary === undefined) return undefined;

	return { summary };
}

/**
 * Where the conversation can be asked for a summary: its newest entry, or, while tools still run, the entry before the
 * answer that called them, since a request with a call and no result is refused. That is where the request in flight
 * ended too, so its cache entry is read whole. `null`: nothing before the open call.
 */
export function askableEnd(view: ContextView): EntryId | undefined | null {
	const open = new Map<string, number>();
	view.contributions.forEach((messages, index) => {
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const block of message.content) if (block.type === "toolCall") open.set(block.id, index);
			} else if (message.role === "toolResult") open.delete(message.toolCallId);
		}
	});
	if (open.size === 0) return undefined;
	const first = Math.min(...open.values());
	return first === 0 ? null : view.entries[first - 1]!.id;
}

/** The messages as the agent's own request would send them: through every `beforeRequest` hook of its extensions. */
async function requestMessages(runtime: CompactionRuntime, extensions: readonly Extension[], messages: readonly Message[], context: Context): Promise<readonly Message[]> {
	let current = messages;
	for (const extension of extensions) {
		for (const installed of extension.hooks ?? []) {
			if (installed.task !== GenerationTask.definition.name) continue;
			const handlers = installed.handlers as { beforeRequest?: (request: { messages: readonly Message[] }, api: HookApi, context: Context) => unknown };
			if (typeof handlers.beforeRequest !== "function") continue;
			const replaced = (await handlers.beforeRequest({ messages: current }, runtime, context)) as { messages: readonly Message[] } | undefined;
			if (replaced !== undefined) current = replaced.messages;
		}
	}
	return current;
}

/** The provider request body through every `beforeProviderRequest` hook, as the agent's own request's is. */
async function requestPayload(runtime: CompactionRuntime, extensions: readonly Extension[], model: SummaryRequest["model"], payload: unknown, context: Context): Promise<unknown> {
	let current = payload;
	for (const extension of extensions) {
		for (const installed of extension.hooks ?? []) {
			if (installed.task !== GenerationTask.definition.name) continue;
			const handlers = installed.handlers as { beforeProviderRequest?: (request: { model: unknown; payload: unknown }, api: HookApi, context: Context) => unknown };
			if (typeof handlers.beforeProviderRequest !== "function") continue;
			const replaced = (await handlers.beforeProviderRequest({ model, payload: current }, runtime, context)) as { payload: unknown } | undefined;
			if (replaced !== undefined) current = replaced.payload;
		}
	}
	return current;
}

/** A cached token's price against an uncached one's when the model has no prices: Anthropic's. */
const CACHE_READ_RATE = 0.1;

/**
 * Why a summary from a transcript costs less than one asked for on the conversation, or `undefined` when it does not.
 * On the conversation the request reads everything from the provider's cache, at a fraction of the input price, when
 * the cache still holds it (`cacheHolds`). When it does not, the whole context is written to the cache again, at more
 * than the input price, for an entry the compaction then makes useless, where a transcript of the summarized part is
 * shorter and paid once. pi's in-context compaction (earendil-works/pi#10577) decides the same way.
 */
export function cheaperFromTranscript(
	messages: readonly Message[],
	summarized: readonly Message[],
	model: { readonly provider: string; readonly id: string; readonly promptCache?: { readonly short?: number; readonly long?: number }; readonly cost?: unknown },
	now: number,
): string | undefined {
	const cache = cacheHolds(answeredOf(messages), model, now);
	if (!cache.holds) return cache.why;
	const cost = model.cost as { input?: number; cacheRead?: number } | undefined;
	const rate = cost?.input !== undefined && cost.input > 0 && cost.cacheRead !== undefined ? cost.cacheRead / cost.input : CACHE_READ_RATE;
	const cached = (sentOf(cache.last.usage) + cache.last.usage.output) * rate;
	const transcript = summarized.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	return transcript < cached ? "the part to summarize is small: a transcript of it costs less than reading the whole context from the cache" : undefined;
}

function refusal(call: { id: string; name: string }): ToolResultMessage {
	return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: COMPACTION_TOOL_REFUSED }], isError: true, timestamp: Date.now() };
}

/**
 * The summary, asked for at the end of the conversation itself (see the top of this file). `undefined` when it cannot
 * be had this way, with the reason told to `options.gaveUp`.
 */
async function summarizeOnConversation(
	compaction: Parameters<CompactionHooks["beforeCompact"]>[0],
	runtime: CompactionRuntime,
	context: Context,
	options: CompactionOptions,
): Promise<string | undefined> {
	const gaveUp = (why: string) => {
		options.gaveUp?.(runtime.conversationId, why);
		return undefined;
	};
	// The provider has refused this context as too long already; one more message on it is refused the same.
	if (compaction.reason === "overflow") return gaveUp("the context is over the model's window");
	if (typeof runtime.context !== "function" || runtime.settings === undefined) return gaveUp("the compaction task gives no access to the conversation's context");
	const agent = await runtime.agent(context);
	const model = agent.model === undefined ? undefined : runtime.models.getModel(agent.model.provider, agent.model.modelId);
	if (model === undefined) return gaveUp("the conversation has no model");
	const session = await runtime.snapshot(ProviderDoc, runtime.conversationId, context);
	// Without a provider session nothing was requested yet, so there is no cache to read either.
	if (session === undefined) return gaveUp("the conversation has sent no request yet");

	let view = await runtime.context(runtime.conversationId, context);
	const end = askableEnd(view);
	if (end === null) return gaveUp("tools are running and nothing precedes them");
	if (end !== undefined) view = await runtime.context(runtime.conversationId, context, { at: end });
	if (!view.messages.some((message) => message.role !== "system")) return gaveUp("there is nothing to summarize");

	const cheaper = cheaperFromTranscript(view.messages, compaction.messages, model, Date.now());
	if (cheaper !== undefined) return gaveUp(cheaper);

	const extensions = agent.extensions ?? [];
	const prompt = withCompactionFocus(COMPACTION_INLINE_PROMPT, compaction.instructions);
	const messages: Message[] = [...(await requestMessages(runtime, extensions, view.messages, context)), { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];
	// The agent's own request options (pi-durable's generation task): another retention, thinking level or session
	// would be another cache entry. Not `deferred`: a summary is waited for.
	const { deferred: _deferred, ...stream } = runtime.settings.stream;
	const request: SimpleStreamOptions = {
		...stream,
		signal: runtime.signal ?? context.abortSignal,
		sessionId: session.sessionId,
		...(agent.thinkingLevel === "off" ? {} : { reasoning: agent.thinkingLevel }),
		onPayload: (payload: unknown) => requestPayload(runtime, extensions, model, payload, context),
	} as SimpleStreamOptions;

	const total: { usage?: Usage } = {};
	for (let attempt = 1; attempt <= SUMMARY_REQUESTS; attempt++) {
		const response = await runtime.models.completeSimple(model, { messages: [...messages] }, request);
		if (response.stopReason === "error" || response.stopReason === "aborted") return gaveUp(`the request failed: ${response.errorMessage ?? response.stopReason}`);
		await recordUsage({ api: runtime, context, model }, response);
		if (total.usage === undefined) total.usage = JSON.parse(JSON.stringify(response.usage)) as Usage;
		else addUsage(total.usage, response.usage);
		const text = textOf(response);
		if (text !== undefined) {
			options.summarized?.({ conversationId: runtime.conversationId, model: `${model.provider}/${model.id}`, requests: attempt, usage: total.usage });
			return text;
		}
		const calls = response.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
		if (calls.length === 0) return gaveUp(response.stopReason === "length" ? "the summary did not fit the model's answer" : "the model wrote no summary");
		// The model went on working. Its calls are answered, not run, and it is asked again.
		messages.push(response, ...calls.map(refusal));
	}
	return gaveUp("the model called tools instead of writing a summary");
}

export function compactionExtension(options: CompactionOptions = {}): Extension {
	return defineExtension({
		name: "compaction",
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (compaction, api, context) => {
					try {
						const summary = await summarizeOnConversation(compaction, api as CompactionRuntime, context, options);
						if (summary !== undefined) return { summary };
					} catch (error) {
						if (context.abortSignal?.aborted === true) throw error;
						options.gaveUp?.(api.conversationId, error instanceof Error ? error.message : String(error));
					}
					try {
						return await summarize(compaction, api, context);
					} catch {
						// A failed custom summary falls back to the durable task's own summarizer.
						return undefined;
					}
				},
			}),
		],
	});
}
