/**
 * Long-term memory through Hindsight (https://github.com/vectorize-io/hindsight), which you deploy yourself, as with
 * Browserless: `HINDSIGHT_URL` turns it on, `HINDSIGHT_API_KEY` when the server requires one, `HINDSIGHT_BANK` names the
 * memory bank (default `claw`). Without `HINDSIGHT_URL` there is no memory, and the log says so.
 *
 * - Recall: each message that starts or steers a turn is searched for, and the observations that come back (Hindsight's
 *   consolidated memories) are stored with the message as a hidden `<memories>` block (the bridge's `messageContext`),
 *   so the provider's prompt cache holds. Left out: those below `RECALL_MIN_SCORE`, those recalled earlier and still
 *   in the model's context, and those drawn only from turns still in it; after a compaction they can come back. T3 shows
 *   the block as a `hindsight_recall` row, with what was left out and why below a display-only rule.
 * - Retain: after each finished turn, a copy of the conversation (its model context as the turn ended, nothing written
 *   to it) gets one more message asking what in the turn is worth remembering, answered by T3's text-generation model.
 *   The notes, or nothing, are stored as the turn's document, with the turn's entry range, which is how recall knows
 *   where a memory came from. One turn at a time, off the run: a turn not yet written when the harness stops is lost.
 * - Tools for scripts: `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`.
 *
 * Memory never stops a turn: a failed recall says so in the block, a failed retain is logged.
 */
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Model, Models, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, type ContextView, type ConversationId, type EntryId, type EntryRecord, type Extension, type Harness, type ModelRef, type ToolRegistration } from "@earendil-works/pi-durable";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { messageContextData, type MessageContextAnswer, type MessageContextRequest, type TextGenerationModel } from "@mgabor3141/pi-durable-t3";
import { int, opt, str } from "@earendil-works/pi-schema";
import { MEMORY_NOTES_CONTEXT, MEMORY_NOTES_NO_TOOLS, MEMORY_RECALL_DESCRIPTION, MEMORY_REFLECT_DESCRIPTION, MEMORY_RETAIN_DESCRIPTION, memoriesBlock, memoriesUnavailable, memoryNotesPrompt } from "./prompts.ts";
import { object } from "./schema.ts";

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
/** The longest a memory step may write. */
const NOTES_MAX_TOKENS = 2_048;
/** Tool calls the memory step may answer before it gives up on the turn. */
const NOTES_MAX_TOOL_ROUNDS = 2;
/** How long one memory step may take, writing and storing. */
const NOTES_TIMEOUT_MS = 10 * 60_000;
/** How long storing the notes may take. */
const RETAIN_TIMEOUT_MS = 30_000;
/** Of the model's context window, what the copy may fill (the rest is the prompt, the answer and estimate error). */
const NOTES_WINDOW_SHARE = 0.85;

/** The configuration from the environment; `undefined` without `HINDSIGHT_URL`. A malformed value fails loudly. */
export function hindsightConfig(env: Readonly<Record<string, string | undefined>>): HindsightConfig | undefined {
	const url = env.HINDSIGHT_URL?.trim() ?? "";
	if (url === "") return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`HINDSIGHT_URL is not a URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`HINDSIGHT_URL must be http(s): ${url}`);
	const bank = env.HINDSIGHT_BANK?.trim() || "claw";
	if (!/^[A-Za-z0-9_.-]+$/u.test(bank)) throw new Error(`HINDSIGHT_BANK may hold only letters, digits, ".", "_" and "-": ${bank}`);
	const apiKey = env.HINDSIGHT_API_KEY?.trim();
	return { url: url.replace(/\/+$/u, ""), bank, ...(apiKey ? { apiKey } : {}) };
}

/** What memory needs from the harness once it is open. */
export interface MemoryHost {
	/** A conversation's committed model context, as of the visible entry `at` when given (`Conversation.context`). */
	context(conversationId: ConversationId, at?: EntryId): Promise<ContextView | undefined>;
	/** The model the memory step writes with: T3's text-generation model when it names one, else the conversation's. */
	notesModel(conversationId: ConversationId): Promise<(ModelRef & { readonly thinkingLevel?: string }) | undefined>;
}

/** The `MemoryHost` of a harness; `textGenerationModel` is the bridge's (it exists once the bridge is attached). */
export function harnessMemoryHost(harness: Harness, textGenerationModel: () => TextGenerationModel | undefined): MemoryHost {
	const ctx = BACKGROUND_CONTEXT;
	return {
		async context(conversationId, at) {
			const conversation = await harness.conversation(conversationId, ctx);
			return conversation === undefined ? undefined : conversation.context(ctx, at === undefined ? {} : { at });
		},
		async notesModel(conversationId) {
			const configured = textGenerationModel();
			if (configured !== undefined) return configured;
			const conversation = await harness.conversation(conversationId, ctx);
			return conversation === undefined ? undefined : (await conversation.agent(ctx)).model;
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

/** A rough token count: JSON characters over four, as pi's own estimate does for what it has no usage for. */
const estimateTokens = (message: Message): number => Math.ceil(JSON.stringify(message).length / 4);

/** `content` without images, for a model that takes none: each image becomes a line saying one was there. */
function withoutImages(message: Message): Message {
	if (message.role === "system" || typeof message.content === "string") return message;
	if (!(message.content as { type: string }[]).some((block) => block.type === "image")) return message;
	return { ...message, content: (message.content as { type: string }[]).map((block) => (block.type === "image" ? { type: "text", text: "[an image]" } : block)) } as Message;
}

/**
 * The conversation for the memory step: the model context as the turn ended, fitted to the model. System messages
 * (the prompt and tools) stay; older messages go first, and the copy then starts at a user message, so no tool result
 * lacks its call. `undefined` when even the latest turn does not fit.
 */
export function notesConversation(messages: readonly Message[], model: Pick<Model<never>, "contextWindow" | "input">, turnStartIndex: number): Message[] | undefined {
	const prepared = model.input.includes("image") ? [...messages] : messages.map(withoutImages);
	const budget = Math.floor(model.contextWindow * NOTES_WINDOW_SHARE) - NOTES_MAX_TOKENS;
	const sizes = prepared.map(estimateTokens);
	let total = sizes.reduce((sum, size) => sum + size, 0);
	let start = 0;
	while (total > budget) {
		// Drop the oldest non-system message, then up to the next user message.
		const next = prepared.findIndex((message, index) => index >= start && message.role !== "system");
		if (next === -1 || next >= turnStartIndex) return undefined;
		let cut = next + 1;
		while (cut < turnStartIndex && prepared[cut]!.role !== "user") cut++;
		for (let index = next; index < cut; index++) if (prepared[index]!.role !== "system") total -= sizes[index]!;
		start = cut;
	}
	return prepared.filter((message, index) => index >= start || message.role === "system");
}

function signalWithin(ms: number, signal?: AbortSignal): AbortSignal {
	return signal === undefined ? AbortSignal.timeout(ms) : AbortSignal.any([AbortSignal.timeout(ms), signal]);
}

type NotesJob = { readonly conversationId: ConversationId; readonly first: EntryId; readonly last: EntryId; readonly models: Models };

export class Hindsight {
	readonly config: HindsightConfig;
	readonly #client: HindsightClient;
	readonly #log: Log;
	#host: MemoryHost | undefined;
	readonly #jobs: NotesJob[] = [];
	#draining: Promise<void> | undefined;
	readonly #closed = new AbortController();

	constructor(config: HindsightConfig, log: Log, client?: HindsightClient) {
		this.config = config;
		this.#log = log;
		this.#client = client ?? new HindsightClient({ baseUrl: config.url, userAgent: "pi-durable-claw", ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }) });
	}

	/** Once the harness is open: what recall and the memory step read through. */
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
	 * a note that memory could not be searched. T3 shows it after the message as a `hindsight_recall` call.
	 */
	async recallFor(request: MessageContextRequest): Promise<MessageContextAnswer | undefined> {
		const query = request.text.trim().slice(0, QUERY_MAX_CHARS);
		if (query === "") return undefined;
		const input = { query };
		let response: { results?: Recalled[] | null; source_facts?: Record<string, Recalled> | null };
		let holds: ReturnType<typeof contextHolds>;
		try {
			const [recalled, view] = await Promise.all([
				this.#client.recall(this.config.bank, query, { types: ["observation"], maxTokens: RECALL_MAX_TOKENS, budget: "mid", includeSourceFacts: true, signal: request.signal }),
				this.#host?.context(request.conversationId),
			]);
			response = recalled as typeof response;
			holds = contextHolds(view);
		} catch (error) {
			if (request.signal.aborted) throw error;
			return { text: memoriesUnavailable((error as Error).message), shownAs: { name: "hindsight_recall", input } };
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
			shownAs: { name: "hindsight_recall", input, details },
			data: { memories: kept.map((memory) => memory.id) } satisfies RecallData,
		};
	}

	/** Queue the memory step for a finished turn; it runs off the run, one turn at a time. */
	#enqueue(job: NotesJob): void {
		if (this.#closed.signal.aborted) return;
		this.#jobs.push(job);
		this.#draining ??= (async () => {
			for (let next = this.#jobs.shift(); next !== undefined && !this.#closed.signal.aborted; next = this.#jobs.shift()) {
				try {
					await this.notesFor(next);
				} catch (error) {
					this.#log.warn("memory: a turn was not stored", { conversationId: next.conversationId, first: next.first, error: (error as Error).message });
				}
			}
			this.#draining = undefined;
		})();
	}

	/** Wait for the queued turns to be written (tests). */
	async settled(): Promise<void> {
		while (this.#draining !== undefined) await this.#draining;
	}

	/** Stop writing: a turn in progress is abandoned, queued ones are dropped. */
	close(): void {
		this.#closed.abort();
		this.#jobs.length = 0;
	}

	/** The memory step for one turn: what in it is worth remembering, stored as the turn's document. */
	async notesFor(job: NotesJob): Promise<void> {
		const host = this.#host;
		if (host === undefined) throw new Error("memory is not attached to the harness");
		const view = await host.context(job.conversationId, job.last);
		if (view === undefined) return;
		const turn = view.entries.filter((entry) => entry.id >= job.first && entry.id <= job.last);
		const start = turnStart(turn);
		if (start === undefined) return;
		const ref = await host.notesModel(job.conversationId);
		if (ref === undefined) throw new Error("no model to write memory notes with");
		const model = job.models.getModel(ref.provider, ref.modelId);
		if (model === undefined) throw new Error(`cannot resolve ${ref.provider}/${ref.modelId}`);
		// Where the turn starts in the model context: the first message of its first entry.
		const firstOfTurn = view.entries.findIndex((entry) => entry.id >= job.first);
		const turnStartIndex = view.contributions.slice(0, firstOfTurn).reduce((sum, messages) => sum + messages.length, 0);
		const copy = notesConversation(view.messages, model as Model<never>, Math.min(turnStartIndex, view.messages.length));
		if (copy === undefined) throw new Error(`the turn does not fit ${ref.provider}/${ref.modelId}'s context window`);
		const signal = signalWithin(NOTES_TIMEOUT_MS, this.#closed.signal);
		const messages: Message[] = [...copy, { role: "user", content: [{ type: "text", text: memoryNotesPrompt(start.text) }], timestamp: Date.now() }];
		let reply: AssistantMessage | undefined;
		for (let round = 0; round <= NOTES_MAX_TOOL_ROUNDS; round++) {
			reply = await job.models.completeSimple(model, { messages }, { signal, maxTokens: NOTES_MAX_TOKENS, ...(ref.thinkingLevel === undefined || ref.thinkingLevel === "off" ? {} : { reasoning: ref.thinkingLevel as never }) });
			if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
			const calls = reply.content.filter((block) => block.type === "toolCall");
			if (calls.length === 0) break;
			if (round === NOTES_MAX_TOOL_ROUNDS) throw new Error("the model kept calling tools in the memory step");
			messages.push(reply, ...calls.map((call): ToolResultMessage => ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: MEMORY_NOTES_NO_TOOLS }], isError: true, timestamp: Date.now() })));
		}
		const notes = reply!.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
		if (notes === "" || /^NOTHING\.?$/iu.test(notes)) {
			this.#log.info("memory: nothing to remember from a turn", { conversationId: job.conversationId, first: job.first });
			return;
		}
		await this.#client.retain(this.config.bank, notes, {
			documentId: `conversation-${job.conversationId}-entry-${job.first}`,
			context: MEMORY_NOTES_CONTEXT,
			metadata: { conversationId: String(job.conversationId), firstEntry: String(job.first), lastEntry: String(job.last) },
			...(start.at === undefined ? {} : { timestamp: new Date(start.at) }),
			async: true,
			signal: signalWithin(RETAIN_TIMEOUT_MS, this.#closed.signal),
		});
	}

	/** Queues the memory step for each finished turn. */
	extension(): Extension {
		return defineExtension({
			name: "hindsight",
			hooks: [
				hook(GenerationTask, {
					afterRun: async (run, api) => {
						this.#enqueue({ conversationId: api.conversationId, first: run.first, last: run.last, models: api.models });
						return undefined;
					},
				}),
			],
		});
	}

	/** `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`, for scripts. */
	tools(): ToolRegistration[] {
		const bank = this.config.bank;
		const client = this.#client;
		return [
			defineTool({
				name: "hindsight_recall",
				description: MEMORY_RECALL_DESCRIPTION,
				parameters: object({
					query: str({ minLength: 1, maxLength: 2_000, description: "What to look for, in words." }),
					maxTokens: opt(int({ minimum: 100, maximum: 8_192, description: "How much to return, in tokens. Default 2,048." })),
				}),
				callers: ["tools"],
				async execute(args, _api, context) {
					const response = await client.recall(bank, args.query, { types: ["world", "experience", "observation"], preferObservations: true, maxTokens: args.maxTokens ?? 2_048, budget: "mid", ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
					const memories = (response.results ?? []) as Recalled[];
					return { output: [{ type: "text" as const, text: memories.length === 0 ? "No memories found." : memories.map(memoryLine).join("\n") }] };
				},
			}),
			defineTool({
				name: "hindsight_retain",
				description: MEMORY_RETAIN_DESCRIPTION,
				parameters: object({
					content: str({ minLength: 1, maxLength: 50_000, description: "What to remember, as plain statements." }),
					context: opt(str({ maxLength: 2_000, description: "Where it comes from, such as the file or tool it was learned from." })),
				}),
				callers: ["tools"],
				async execute(args, _api, context) {
					await client.retain(bank, args.content, { ...(args.context === undefined ? {} : { context: args.context }), async: true, ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }) });
					return { output: [{ type: "text" as const, text: "Saved to long-term memory." }] };
				},
			}),
			defineTool({
				name: "hindsight_reflect",
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
