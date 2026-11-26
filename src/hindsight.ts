/**
 * Long-term memory through Hindsight (https://github.com/vectorize-io/hindsight), which you deploy yourself, as with
 * Browserless: `HINDSIGHT_URL` turns it on, `HINDSIGHT_API_KEY` when the server requires one, `HINDSIGHT_BANK` names the
 * memory bank (default `claw`). Without `HINDSIGHT_URL` there is no memory, and the log says so.
 *
 * - Recall: the message that opens a context (a thread's first, or the first after a compaction: `opensContext`) is
 *   searched for, and the observations that come back (Hindsight's consolidated memories) are stored with the message as
 *   a hidden `<memories>` block (the bridge's `messageContext`), so the provider's prompt cache holds. Left out: those
 *   below `RECALL_MIN_SCORE`, those recalled earlier and still in the model's context, and those drawn only from turns
 *   still in it; after a compaction they can come back. T3 shows the block as a `memory_recall` row, with what was left
 *   out and why below a display-only rule.
 * - Retain: the moment a run has answered, its thread is asked what in the turn is worth remembering: the request the
 *   agent would send next, to the same model with the same thinking level and options, with one more message that asks
 *   (`on-conversation.ts`). Nothing is written to the thread. That request starts as the turn's last one did, so the
 *   provider's prompt cache answers all of it but the ask; a request of its own (another model, another thinking level,
 *   history cut to fit) would read the whole thread again, which on a local engine takes minutes. The notes, or
 *   nothing, are stored as the turn's document, with its entry range, which is how recall knows where a memory came
 *   from. Off the run, one step a thread, beside other threads' steps.
 * - A step the thread overtakes (its next request), or that fails, leaves its turns to the next answer's step, which
 *   asks about them all and stores them as one document under the same name. So a turn is asked about again only right
 *   after an answer, while the cache holds the thread; never later. Turns not yet written when the harness stops are lost.
 * - An undo does not reach memory: the notes of turns that were taken back stay, as a record of what happened.
 * - Tools for scripts: `memory_recall`, `memory_reflect` and the page tools.
 *
 * Memory never stops a turn: a failed recall says so in the block, a failed retain is logged.
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Model, SimpleStreamOptions, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, ProviderDoc, type ContextView, type ConversationId, type EntryId, type EntryRecord, type Extension, type Harness, type HookApi, type RunSummary, type ToolRegistration } from "@earendil-works/pi-durable";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { messageContextData, type MessageContextAnswer, type MessageContextRequest } from "@mgabor3141/pi-durable-t3";
import { arr, int, opt, str } from "@earendil-works/pi-schema";
import { MEMORY_NOTES_CONTEXT, MEMORY_NOTES_NO_TOOLS, MEMORY_PAGES_CREATE_DESCRIPTION, MEMORY_PAGES_CREATE_FOLDER_DESCRIPTION, MEMORY_PAGES_DELETE_DESCRIPTION, MEMORY_PAGES_LIST_DESCRIPTION, MEMORY_PAGES_READ_DESCRIPTION, MEMORY_PAGES_SEARCH_DESCRIPTION, MEMORY_PAGES_UPDATE_DESCRIPTION, MEMORY_RECALL_DESCRIPTION, MEMORY_REFLECT_DESCRIPTION, memoriesBlock, memoriesUnavailable, memoryNotesPrompt } from "./prompts.ts";
import { askMessage, requestMessages, requestPayload } from "./on-conversation.ts";
import { answeredOf, cacheHolds } from "./prompt-cache.ts";
import { object } from "./schema.ts";
import { setting, type Env } from "./env.ts";

export interface HindsightConfig {
	readonly url: string;
	readonly apiKey?: string;
	readonly bank: string;
}

interface Log {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

/** The longest recall query: a message's start says what it is about (Hindsight's OpenClaw plugin uses 800). */
const QUERY_MAX_CHARS = 800;
/** Tokens of memories recalled for a message: Hindsight fills this budget with the best it finds. */
const RECALL_MAX_TOKENS = 1_024;
/**
 * The lowest reranker score a recalled memory may have. Low on purpose: Hindsight's scores order well but are not
 * absolute, so this only stops what plainly has nothing to do with the message.
 */
export const RECALL_MIN_SCORE = 0.01;
/** Tool calls the memory step may answer before it gives up on the turn. */
const NOTES_MAX_TOOL_ROUNDS = 2;
/** How long one memory step may take to write its notes, waiting for the provider included. */
const NOTES_TIMEOUT_MS = 10 * 60_000;
/** How long storing the notes may take. */
const RETAIN_TIMEOUT_MS = 30_000;

/** The configuration from the environment; `undefined` without `HINDSIGHT_URL`. A malformed value fails loudly. */
export function hindsightConfig(env: Env): HindsightConfig | undefined {
	const url = setting(env, "HINDSIGHT_URL");
	if (url === undefined) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`HINDSIGHT_URL is not a URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`HINDSIGHT_URL must be http(s): ${url}`);
	const bank = setting(env, "HINDSIGHT_BANK") ?? "claw";
	if (!/^[A-Za-z0-9_.-]+$/u.test(bank)) throw new Error(`HINDSIGHT_BANK may hold only letters, digits, ".", "_" and "-": ${bank}`);
	const apiKey = setting(env, "HINDSIGHT_API_KEY");
	return { url: url.replace(/\/+$/u, ""), bank, ...(apiKey === undefined ? {} : { apiKey }) };
}

/** What recall needs from the harness once it is open. */
export interface MemoryHost {
	/** A conversation's committed model context (`Conversation.context`). */
	context(conversationId: ConversationId): Promise<ContextView | undefined>;
}

/** The `MemoryHost` of a harness. */
export function harnessMemoryHost(harness: Harness): MemoryHost {
	const ctx = BACKGROUND_CONTEXT;
	return {
		async context(conversationId) {
			const conversation = await harness.conversation(conversationId, ctx);
			return conversation === undefined ? undefined : conversation.context(ctx);
		},
	};
}

type Scores = { reranker?: number | null };
type Recalled = {
	id: string;
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
	occurred_start?: string | null;
	document_id?: string | null;
	metadata?: Record<string, string> | null;
	source_fact_ids?: string[] | null;
	scores?: Scores | null;
};

/** One memory as a line: its date (when it happened, else when it was learned) and its text. */
function memoryLine(memory: Recalled): string {
	const date = (memory.occurred_start ?? memory.mentioned_at ?? "").slice(0, 10);
	return `- ${date === "" ? "" : `[${date}] `}${memory.text.replace(/\s+/gu, " ").trim()}`;
}

/** The turn a stored fact came from: the last entry of its document (`lastEntry`, written with the notes). */
function sourceEntry(fact: Recalled | undefined): number | undefined {
	const last = Number(fact?.metadata?.lastEntry);
	return Number.isSafeInteger(last) ? last : undefined;
}

/** What recall stores with a message's block (`MessageContextAnswer.data`): the memories it injected. */
type RecallData = { readonly memories: readonly string[] };

/** The memories a context still holds: recalled for a message in it, and the entries it holds. */
function contextHolds(view: ContextView | undefined): { injected: Set<string>; entries: Set<number> } {
	const injected = new Set<string>();
	const entries = new Set<number>();
	for (const entry of view?.entries ?? []) {
		entries.add(entry.id as number);
		for (const data of messageContextData(entry)) {
			for (const id of (data as Partial<RecallData> | null)?.memories ?? []) injected.add(id);
		}
	}
	return { injected, entries };
}

const score = (memory: Recalled): number | undefined => (typeof memory.scores?.reranker === "number" ? memory.scores.reranker : undefined);
const formatScore = (value: number | undefined): string => (value === undefined ? "no score" : `score ${value.toFixed(value < 0.1 ? 3 : 2)}`);

/** A message's visible text: its text blocks, without hidden ones (memories, attachment lists). */
function visibleText(message: Message | undefined): string {
	if (message === undefined || (message.role !== "user" && message.role !== "assistant")) return "";
	if (typeof message.content === "string") return message.content.trim();
	return (message.content as { type: string; text?: string; hidden?: boolean }[])
		.flatMap((block) => (block.type === "text" && block.hidden !== true && block.text !== undefined ? [block.text] : []))
		.join("\n")
		.trim();
}

/**
 * Whether a message opens a context: the thread's first message, or the first after a compaction. Recall runs only at
 * these boundaries, as Linger, Letta and OpenViking do; a mid-thread message gets no injected memories, and the agent
 * can call `memory_recall` when it needs them. The current message is found in the context by its text; after a
 * compaction the compaction entry is the one before it.
 */
export function opensContext(view: ContextView | undefined, text: string): boolean {
	const entries = view?.entries ?? [];
	const wanted = text.trim().replace(/\s+/gu, " ");
	let at = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.kind !== "app.user") continue;
		if (visibleText(entry.model?.[0]).replace(/\s+/gu, " ") === wanted) {
			at = index;
			break;
		}
	}
	const before = at === -1 ? entries : entries.slice(0, at);
	if (before.at(-1)?.kind === "pi.compaction") return true;
	return !before.some((entry) => entry.kind === "app.user" || entry.kind === "pi.assistant");
}

/** The start of a turn's first message with text, for the memory step to find the turn by. */
function turnStart(entries: readonly EntryRecord[]): { text: string; at?: number } | undefined {
	for (const entry of entries) {
		const message = entry.model?.[0];
		if (message?.role !== "user") continue;
		const text = visibleText(message).replace(/\s+/gu, " ");
		if (text !== "") return { text: text.length > 120 ? `${text.slice(0, 120)}` : text, at: message.timestamp };
	}
	return undefined;
}

function signalWithin(ms: number, signal?: AbortSignal): AbortSignal {
	return signal === undefined ? AbortSignal.timeout(ms) : AbortSignal.any([AbortSignal.timeout(ms), signal]);
}

/** The turns a thread's next memory step asks about: from `first`, the oldest not yet stored, `turns` runs. */
type Pending = { readonly first: EntryId; readonly turns: number };

/** The parts of the generation task's runtime (an `afterRun` hook's api) a memory step reads, as compaction does. */
type RunRuntime = HookApi & {
	readonly settings: { readonly stream: SimpleStreamOptions & { readonly deferred?: unknown } };
	agent(context: Context): Promise<{ readonly thinkingLevel?: string; readonly extensions?: readonly Extension[] }>;
	context(conversationId: ConversationId, context: Context, options?: { readonly at?: EntryId }): Promise<ContextView>;
};

/** A memory step ready to send: the thread's own next request, with the ask after it. */
type Step = {
	readonly conversationId: ConversationId;
	readonly pending: Pending;
	/** The turns' first entry with a message, and the run's last entry: the document's range. */
	readonly first: EntryId;
	readonly last: EntryId;
	readonly startedAt?: number;
	readonly model: Model<never>;
	readonly messages: readonly Message[];
	readonly options: SimpleStreamOptions;
	readonly api: HookApi;
};

/** A turn's document: named by the conversation it ran in and its first entry. */
const documentOf = (conversationId: number, first: number): string => `conversation-${conversationId}-entry-${first}`;

export class Hindsight {
	readonly config: HindsightConfig;
	readonly #client: HindsightClient;
	readonly #log: Log;
	#host: MemoryHost | undefined;
	/** Per thread, the turns whose notes are not stored yet. */
	readonly #pending = new Map<ConversationId, Pending>();
	/** Per thread, the memory step in flight; the thread's next request stops it. */
	readonly #steps = new Map<ConversationId, { readonly stop: AbortController; readonly done: Promise<void> }>();
	readonly #closed = new AbortController();

	constructor(config: HindsightConfig, log: Log, client?: HindsightClient) {
		this.config = config;
		this.#log = log;
		this.#client = client ?? new HindsightClient({ baseUrl: config.url, userAgent: "pi-durable-claw", ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }) });
	}

	/** Once the harness is open: what recall reads through. */
	attach(host: MemoryHost): void {
		this.#host = host;
	}

	/** At startup: say whether the server answers. Not fatal; it may come up after the harness. */
	async check(): Promise<void> {
		try {
			const version = await this.#client.getVersion({ signal: AbortSignal.timeout(5_000) });
			this.#log.info("memory on: Hindsight answers", { url: this.config.url, bank: this.config.bank, version: (version as { api_version?: string }).api_version });
		} catch (error) {
			this.#log.warn("memory: Hindsight does not answer yet; recalls will say so until it does", { url: this.config.url, error: (error as Error).message });
		}
	}

	/**
	 * The bridge's `messageContext`: the observations recalled for a message that its context does not already hold, or
	 * a note that memory could not be searched. T3 shows it after the message as a `memory_recall` call.
	 */
	async recallFor(request: MessageContextRequest): Promise<MessageContextAnswer | undefined> {
		const query = request.text.trim().slice(0, QUERY_MAX_CHARS);
		if (query === "") return undefined;
		const input = { query };
		let response: { results?: Recalled[] | null; source_facts?: Record<string, Recalled> | null };
		let view: ContextView | undefined;
		try {
			view = await this.#host?.context(request.conversationId);
		} catch (error) {
			if (request.signal.aborted) throw error;
			return { text: memoriesUnavailable((error as Error).message), shownAs: { name: "memory_recall", input } };
		}
		if (!opensContext(view, request.text)) return undefined;
		let holds: ReturnType<typeof contextHolds>;
		try {
			response = (await this.#client.recall(this.config.bank, query, { types: ["observation"], maxTokens: RECALL_MAX_TOKENS, budget: "mid", includeSourceFacts: true, signal: request.signal })) as typeof response;
			holds = contextHolds(view);
		} catch (error) {
			if (request.signal.aborted) throw error;
			return { text: memoriesUnavailable((error as Error).message), shownAs: { name: "memory_recall", input } };
		}
		const kept: Recalled[] = [];
		const low: number[] = [];
		let injected = 0;
		let fromContext = 0;
		for (const memory of response.results ?? []) {
			const value = score(memory);
			if (value !== undefined && value < RECALL_MIN_SCORE) low.push(value);
			else if (holds.injected.has(memory.id)) injected++;
			else if (drawnFromContext(memory, response.source_facts ?? {}, holds.entries)) fromContext++;
			else kept.push(memory);
		}
		const left = [
			...(low.length === 0 ? [] : [`${low.length} scored below ${RECALL_MIN_SCORE} (${low.map((value) => value.toFixed(3)).join(", ")})`]),
			...(injected === 0 ? [] : [`${injected} recalled earlier and still in this thread's context`]),
			...(fromContext === 0 ? [] : [`${fromContext} drawn only from turns still in this thread's context`]),
		];
		if (kept.length === 0) {
			if (left.length > 0) this.#log.info("memory: nothing new to recall for a message", { threadId: request.threadId, left: left.join("; ") });
			return undefined;
		}
		const lines = kept.map((memory, index) => {
			const sources = memory.source_fact_ids?.length ?? 0;
			const here = (memory.source_fact_ids ?? []).filter((id) => holds.entries.has(sourceEntry(response.source_facts?.[id]) ?? -1)).length;
			return `${index + 1}. ${formatScore(score(memory))} · ${sources} source${sources === 1 ? "" : "s"}${here === 0 ? "" : `, ${here} in this thread's context`}`;
		});
		const details = [...lines, ...(left.length === 0 ? [] : ["", `Left out: ${left.join("; ")}.`])].join("\n");
		return {
			text: memoriesBlock(kept.map(memoryLine)),
			shownAs: { name: "memory_recall", input, details },
			data: { memories: kept.map((memory) => memory.id) } satisfies RecallData,
		};
	}

	/** Wait for the memory steps in flight (tests). */
	async settled(): Promise<void> {
		while (this.#steps.size > 0) await Promise.all([...this.#steps.values()].map((step) => step.done));
	}

	/** Stop writing: steps in flight are abandoned, and turns not yet stored are dropped. */
	close(): void {
		this.#closed.abort();
		this.#pending.clear();
	}

	/**
	 * After a run answered: its thread's memory step, at once, before anything else is sent on the thread. What is
	 * read from the run is read here, while its runtime is live; the request itself runs off the run.
	 */
	async #afterRun(run: RunSummary, api: RunRuntime, context: Context): Promise<void> {
		if (this.#closed.signal.aborted) return;
		const conversationId = api.conversationId;
		this.#steps.get(conversationId)?.stop.abort();
		const before = this.#pending.get(conversationId);
		const pending: Pending = { first: before?.first ?? run.first, turns: (before?.turns ?? 0) + 1 };
		this.#pending.set(conversationId, pending);
		let step: Step | undefined;
		try {
			step = await this.#prepare(run, pending, api, context);
		} catch (error) {
			this.#log.warn("memory: a turn was not looked at; the next answer's memory step asks about it", { conversationId, first: pending.first, error: (error as Error).message });
			return;
		}
		if (step !== undefined) this.#start(step);
	}

	/** The thread's next request with the ask after it, or `undefined` when there is nothing to ask now. */
	async #prepare(run: RunSummary, pending: Pending, api: RunRuntime, context: Context): Promise<Step | undefined> {
		const conversationId = api.conversationId;
		// The model and thinking level the run's answer was written with: the request whose cache this one reads.
		const answer = (await api.entry(run.answer, context))?.model?.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (answer === undefined) throw new Error("the run's answer has no message");
		const model = api.models.getModel(answer.provider, answer.model) as Model<never> | undefined;
		if (model === undefined) throw new Error(`cannot resolve ${answer.provider}/${answer.model}`);
		const view = await api.context(conversationId, context, { at: run.last });
		// Right after an answer the provider's cache holds the thread, unless it keeps none; a request that would read the
		// whole thread again is not sent, and its turns wait for an answer that writes the cache. An expiry counts only
		// when the lifetime is the provider's (its cache writes, `promptCache`): an engine that reports reads alone keeps
		// a conversation until it needs the room, and a long answer would pass Anthropic's five minutes it is guessed by.
		const cache = cacheHolds(answeredOf(view.messages), model, api.now());
		const guessedExpiry = !cache.holds && cache.expired && !cache.lifetimeKnown && (model as { promptCache?: unknown }).promptCache === undefined;
		if (!cache.holds && cache.known && !guessedExpiry) {
			this.#log.info("memory: the prompt cache does not hold the thread, so its turns wait for the next answer", { conversationId, first: pending.first, why: cache.why });
			return undefined;
		}
		// A run continued without a message (`/continue` after an undone step) starts at the agent's answer: its turn
		// starts at the message that answer is to, the last one before it.
		const within = (from: number) => view.entries.filter((entry) => entry.id >= from && entry.id <= run.last);
		const first = turnStart(within(pending.first)) !== undefined ? pending.first : view.entries.findLast((entry) => entry.id < pending.first && turnStart([entry]) !== undefined)?.id;
		const start = first === undefined ? undefined : turnStart(within(first));
		if (first === undefined || start === undefined) {
			this.#pending.delete(conversationId);
			return undefined;
		}
		const agent = await api.agent(context);
		const extensions = agent.extensions ?? [];
		const messages = [...(await requestMessages(api, extensions, view.messages, context)), askMessage(model, memoryNotesPrompt(start.text, pending.turns))];
		const session = await api.snapshot(ProviderDoc, conversationId, context);
		const thinkingLevel = (answer as { thinkingLevel?: string }).thinkingLevel ?? agent.thinkingLevel;
		// The agent's own request options (pi-durable's generation task); not `deferred`: the notes are waited for.
		const { deferred: _deferred, ...stream } = api.settings.stream;
		const options: SimpleStreamOptions = {
			...stream,
			...(session === undefined ? {} : { sessionId: session.sessionId }),
			...(thinkingLevel === undefined || thinkingLevel === "off" ? {} : { reasoning: thinkingLevel as never }),
			// Sent after the run has ended: a payload hook gets the run's api, for what it reads (t3-priority, the
			// conversation id); one that wrote through it would fail the step, which leaves its turns to the next.
			onPayload: (payload: unknown) => requestPayload(api, extensions, model, payload, BACKGROUND_CONTEXT),
		} as SimpleStreamOptions;
		return { conversationId, pending, first, last: run.last, ...(start.at === undefined ? {} : { startedAt: start.at }), model, messages, options, api };
	}

	/** Send a step off the run. Stored, or nothing worth storing: its turns are done. Otherwise they wait. */
	#start(step: Step): void {
		const stop = new AbortController();
		const signal = AbortSignal.any([stop.signal, this.#closed.signal, AbortSignal.timeout(NOTES_TIMEOUT_MS)]);
		const done = (async () => {
			try {
				await this.#write(step, signal);
				if (this.#pending.get(step.conversationId) === step.pending) this.#pending.delete(step.conversationId);
			} catch (error) {
				if (this.#closed.signal.aborted) return;
				if (stop.signal.aborted) this.#log.info("memory: the thread went on before its turn was written; the next answer's memory step asks about it", { conversationId: step.conversationId, first: step.first });
				else this.#log.warn("memory: a turn was not stored; the next answer's memory step asks about it", { conversationId: step.conversationId, first: step.first, error: (error as Error).message });
			} finally {
				if (this.#steps.get(step.conversationId)?.stop === stop) this.#steps.delete(step.conversationId);
			}
		})();
		this.#steps.set(step.conversationId, { stop, done });
	}

	/** Ask, answer the model's tool calls with a refusal, and store the notes as the turns' document. */
	async #write(step: Step, signal: AbortSignal): Promise<void> {
		const messages = [...step.messages];
		let reply: AssistantMessage | undefined;
		for (let round = 0; round <= NOTES_MAX_TOOL_ROUNDS; round++) {
			reply = await step.api.models.completeSimple(step.model, { messages }, { ...step.options, signal });
			if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
			const calls = reply.content.filter((block) => block.type === "toolCall");
			if (calls.length === 0) break;
			if (round === NOTES_MAX_TOOL_ROUNDS) throw new Error("the model kept calling tools in the memory step");
			messages.push(reply, ...calls.map((call): ToolResultMessage => ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: MEMORY_NOTES_NO_TOOLS }], isError: true, timestamp: Date.now() })));
		}
		const notes = reply!.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
		if (notes === "" || /^NOTHING\.?$/iu.test(notes)) {
			this.#log.info("memory: nothing to remember from a turn", { conversationId: step.conversationId, first: step.first });
			return;
		}
		signal.throwIfAborted();
		// Storing is not the provider's work: the thread going on does not stop it.
		await this.#client.retain(this.config.bank, notes, {
			documentId: documentOf(step.conversationId, step.first),
			context: MEMORY_NOTES_CONTEXT,
			metadata: { conversationId: String(step.conversationId), firstEntry: String(step.first), lastEntry: String(step.last) },
			...(step.startedAt === undefined ? {} : { timestamp: new Date(step.startedAt) }),
			async: true,
			signal: signalWithin(RETAIN_TIMEOUT_MS, this.#closed.signal),
		});
	}

	/** The memory step after each run that answered; the thread's next request stops one still in flight. */
	extension(): Extension {
		return defineExtension({
			name: "hindsight",
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async (_request, api) => {
						this.#steps.get(api.conversationId)?.stop.abort();
						return undefined;
					},
					afterRun: async (run, api, context) => {
						await this.#afterRun(run, api as RunRuntime, context);
						return undefined;
					},
				}),
			],
		});
	}

	/** `memory_recall`, `memory_reflect` and the page tools, for scripts. */
	tools(): ToolRegistration[] {
		const bank = this.config.bank;
		const client = this.#client;
		return [
			defineTool({
				name: "memory_recall",
				description: MEMORY_RECALL_DESCRIPTION,
				parameters: object({
					query: str({ minLength: 1, maxLength: 2_000, description: "What to look for, in words." }),
					maxTokens: opt(int({ minimum: 100, maximum: 8_192, description: "How much to return, in tokens. Default 2,048." })),
				}),
				callers: ["tools"],
				async execute(args, _api, context) {
					// Observations only, as the recall that opens a context: what Hindsight consolidated, not the single facts under it.
					const response = await client.recall(bank, args.query, { types: ["observation"], maxTokens: args.maxTokens ?? 2_048, budget: "mid", ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
					const memories = (response.results ?? []) as Recalled[];
					return { output: [{ type: "text" as const, text: memories.length === 0 ? "No memories found." : memories.map(memoryLine).join("\n") }] };
				},
			}),
			defineTool({
				name: "memory_reflect",
				description: MEMORY_REFLECT_DESCRIPTION,
				parameters: object({
					query: str({ minLength: 1, maxLength: 2_000, description: "The question." }),
					context: opt(str({ maxLength: 2_000, description: "What the answer is for." })),
				}),
				callers: ["tools"],
				async execute(args, _api, context) {
					const answer = await client.reflect(bank, args.query, { ...(args.context === undefined ? {} : { context: args.context }), budget: "mid", ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
					return { output: [{ type: "text" as const, text: answer.text }] };
				},
			}),
			defineTool({
				name: "memory_pages_list",
				description: MEMORY_PAGES_LIST_DESCRIPTION,
				parameters: object({}),
				callers: ["tools"],
				async execute(_args, _api, context) {
					const tree = await client.getKnowledgeBaseTree(bank, { ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
					return { output: [{ type: "text" as const, text: JSON.stringify(tree, null, 2) }] };
				},
			}),
			defineTool({
				name: "memory_pages_search",
				description: MEMORY_PAGES_SEARCH_DESCRIPTION,
				parameters: object({
					query: str({ minLength: 1, maxLength: 2_000, description: "What to search for." }),
					limit: opt(int({ minimum: 1, maximum: 50, description: "How many pages to return. Default 10." })),
				}),
				callers: ["tools"],
				async execute(args, _api, context) {
					const found = await client.searchKnowledgeBase(bank, args.query, {
						...(args.limit === undefined ? {} : { limit: args.limit }),
						...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
					});
					return { output: [{ type: "text" as const, text: JSON.stringify(found, null, 2) }] };
				},
			}),
			defineTool({
				name: "memory_pages_read",
				description: MEMORY_PAGES_READ_DESCRIPTION,
				parameters: object({ pageId: str({ minLength: 1, description: "The page id from memory_pages_list or memory_pages_search." }) }),
				callers: ["tools"],
				async execute(args, _api, context) {
					const page = await client.getKnowledgePage(bank, args.pageId, { ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
					return { output: [{ type: "text" as const, text: page.markdown }] };
				},
			}),
			defineTool({
				name: "memory_pages_create",
				description: MEMORY_PAGES_CREATE_DESCRIPTION,
				parameters: object({
					name: str({ minLength: 1, maxLength: 200, description: "The page name." }),
					sourceQuery: str({ minLength: 1, maxLength: 2_000, description: "The one question the page answers, in words." }),
					parentId: opt(str({ minLength: 1, description: "Folder id to put the page under. Omit for the root." })),
					tags: opt(arr(str({ minLength: 1 }), { maxItems: 32, description: "Optional tags that scope the memories the page is built from." })),
					maxTokens: opt(int({ minimum: 512, maximum: 8_192, description: "Page budget in tokens." })),
				}),
				callers: ["tools"],
				async execute(args, _api, context) {
					const created = await client.createKnowledgePage(bank, args.name, args.sourceQuery, {
						...(args.parentId === undefined ? {} : { parentId: args.parentId }),
						...(args.tags === undefined ? {} : { tags: args.tags }),
						...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
						...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
					});
					return { output: [{ type: "text" as const, text: JSON.stringify(created, null, 2) }] };
				},
			}),
			defineTool({
				name: "memory_pages_create_folder",
				description: MEMORY_PAGES_CREATE_FOLDER_DESCRIPTION,
				parameters: object({
					name: str({ minLength: 1, maxLength: 200, description: "The folder name." }),
					parentId: opt(str({ minLength: 1, description: "Folder id to nest under. Omit for the root." })),
				}),
				callers: ["tools"],
				async execute(args, _api, context) {
					const created = await client.createKnowledgeFolder(bank, args.name, {
						...(args.parentId === undefined ? {} : { parentId: args.parentId }),
						...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
					});
					return { output: [{ type: "text" as const, text: JSON.stringify(created, null, 2) }] };
				},
			}),
			defineTool({
				name: "memory_pages_update",
				description: MEMORY_PAGES_UPDATE_DESCRIPTION,
				parameters: object({
					nodeId: str({ minLength: 1, description: "The page or folder id." }),
					name: opt(str({ minLength: 1, maxLength: 200, description: "New name." })),
					parentId: opt(str({ minLength: 1, description: "Folder id to move it under." })),
					sourceQuery: opt(str({ minLength: 1, maxLength: 2_000, description: "New question for a page; rebuilds it." })),
					tags: opt(arr(str({ minLength: 1 }), { maxItems: 32, description: "Replacement page tags ([] clears them)." })),
					maxTokens: opt(int({ minimum: 512, maximum: 8_192, description: "New page budget in tokens." })),
				}),
				callers: ["tools"],
				async execute(args, _api, context) {
					const updated = await client.updateKnowledgeNode(bank, args.nodeId, {
						...(args.name === undefined ? {} : { name: args.name }),
						...(args.parentId === undefined ? {} : { parentId: args.parentId }),
						...(args.sourceQuery === undefined ? {} : { sourceQuery: args.sourceQuery }),
						...(args.tags === undefined ? {} : { tags: args.tags }),
						...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
						...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
					});
					return { output: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }] };
				},
			}),
			defineTool({
				name: "memory_pages_delete",
				description: MEMORY_PAGES_DELETE_DESCRIPTION,
				parameters: object({ nodeId: str({ minLength: 1, description: "The page or folder id to delete." }) }),
				callers: ["tools"],
				async execute(args, _api, context) {
					await client.deleteKnowledgeNode(bank, args.nodeId, { ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
					return { output: [{ type: "text" as const, text: "Deleted." }] };
				},
			}),
		];
	}
}

/**
 * Whether an observation says only what the context already holds: every source fact it was drawn from came from a
 * turn still in the context. One whose sources are unknown (not returned, or from before turns were recorded) is kept.
 */
function drawnFromContext(memory: Recalled, facts: Readonly<Record<string, Recalled>>, entries: ReadonlySet<number>): boolean {
	const sources = memory.source_fact_ids ?? [];
	if (sources.length === 0) return false;
	return sources.every((id) => {
		const entry = sourceEntry(facts[id]);
		return entry !== undefined && entries.has(entry);
	});
}
