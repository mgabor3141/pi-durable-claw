import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message, ModelThinkingLevel, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_NO_HISTORY,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_PROMPT,
	COMPACTION_SYSTEM_PROMPT,
	COMPACTION_TURN_PREFIX_PROMPT,
	COMPACTION_UPDATE_PROMPT,
	compactionPrompt,
	compactionTurnPrefixPrompt,
	splitTurnSummary,
	withCompactionFocus,
} from "./prompts.ts";
import {
	CompactionTask,
	UsageDoc,
	defineExtension,
	hook,
	type CompactionHooks,
	type EntryId,
	type EntryRecord,
	type Extension,
	type HookApi,
} from "@earendil-works/pi-durable";

/**
 * pi's compaction prompt, copied from the coding agent. The durable runtime already truncates tool results and omits
 * thinking before serializing; this hook adds the parts the coding agent has and durable does not: an update prompt
 * when a previous summary exists and a split-turn prefix summary. All prompt text lives in `prompts.ts`.
 */

type CompactionRuntime = HookApi & {
	agent(context: Context): Promise<{ model?: { provider: string; modelId: string }; thinkingLevel: ModelThinkingLevel }>;
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	commit(change: (tx: any) => unknown, context: Context): Promise<void>;
};

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

export function compactionExtension(): Extension {
	return defineExtension({
		name: "compaction",
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (compaction, api, context) => {
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
