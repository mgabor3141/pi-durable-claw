/**
 * Long-term memory through Hindsight (https://github.com/vectorize-io/hindsight), which you deploy yourself, as with
 * Browserless: `HINDSIGHT_URL` turns it on, `HINDSIGHT_API_KEY` when the server requires one, `HINDSIGHT_BANK` names the
 * memory bank (default `claw`). Without `HINDSIGHT_URL` there is no memory, and the log says so.
 *
 * It works as Hindsight's own agent integrations do:
 * - Recall: each message that starts or steers a turn is searched for, and what comes back is stored with the message
 *   as a hidden `<memories>` block (the bridge's `messageContext`). Stored with the message rather than added to each
 *   request, so the provider's prompt cache holds; hidden, so T3 shows only the message.
 * - Retain: each finished turn (`afterRun`) is stored: the user's messages and the agent's replies, without tool calls
 *   and without the hidden blocks (memories, attachment lists), so recalled memories are not stored again as new facts.
 *   Its document id is the conversation and the turn's first entry, so storing a turn again replaces it.
 * - Tools for scripts: `hindsight_recall`, `hindsight_retain`, `hindsight_reflect`.
 *
 * Memory never stops a turn: a failed recall says so in the block, a failed retain is logged.
 */
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, GenerationTask, hook, type EntryRecord, type Extension, type HookApi, type RunSummary, type ToolRegistration } from "@earendil-works/pi-durable";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import type { MessageContextAnswer, MessageContextRequest } from "@mgabor3141/pi-durable-t3";
import { int, opt, str } from "@earendil-works/pi-schema";
import { MEMORY_RECALL_DESCRIPTION, MEMORY_REFLECT_DESCRIPTION, MEMORY_RETAIN_DESCRIPTION, MEMORY_TURN_CONTEXT, memoriesBlock, memoriesUnavailable } from "./prompts.ts";
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
/** Tokens of memories recalled for a message. */
const RECALL_MAX_TOKENS = 1_024;
/** How long storing a turn may hold the end of its run. */
const RETAIN_TIMEOUT_MS = 10_000;
const ENTRY_PAGE = 500;

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

type Recalled = { text: string; type?: string | null; mentioned_at?: string | null; occurred_start?: string | null };

/** One memory as a line: its date (when it happened, else when it was learned) and its text. */
function memoryLine(memory: Recalled): string {
	const date = (memory.occurred_start ?? memory.mentioned_at ?? "").slice(0, 10);
	return `- ${date === "" ? "" : `[${date}] `}${memory.text.replace(/\s+/gu, " ").trim()}`;
}

type Message = { role: string; content: unknown; timestamp?: number };

/** A message's visible text: its text blocks, without hidden ones (memories, attachment lists). */
function visibleText(message: Message): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return (message.content as { type: string; text?: string; hidden?: boolean }[])
		.flatMap((block) => (block.type === "text" && block.hidden !== true && block.text !== undefined ? [block.text] : []))
		.join("\n")
		.trim();
}

/** Who wrote a user entry, as the bridge records it (`createdBy`). */
function speaker(entry: EntryRecord): string {
	const createdBy = (entry.data as { createdBy?: unknown } | undefined)?.createdBy;
	return createdBy === "agent" ? "Another agent" : createdBy === "system" ? "Scheduler" : "User";
}

/** A finished turn as Hindsight stores it: the user's messages and the agent's replies, in order. */
export function turnTranscript(entries: readonly EntryRecord[]): { text: string; startedAt?: number } {
	const parts: string[] = [];
	let startedAt: number | undefined;
	for (const entry of entries) {
		const message = entry.model?.[0] as Message | undefined;
		if (message === undefined || entry.kind === "pi.compaction") continue;
		const text = message.role === "user" || message.role === "assistant" ? visibleText(message) : "";
		if (text === "") continue;
		startedAt ??= message.timestamp;
		parts.push(`${message.role === "user" ? speaker(entry) : "Agent"}: ${text}`);
	}
	return { text: parts.join("\n\n"), ...(startedAt === undefined ? {} : { startedAt }) };
}

function signalWithin(ms: number, context: Context): AbortSignal {
	return context.abortSignal === undefined ? AbortSignal.timeout(ms) : AbortSignal.any([AbortSignal.timeout(ms), context.abortSignal]);
}

export class Hindsight {
	readonly config: HindsightConfig;
	readonly #client: HindsightClient;
	readonly #log: Log;

	constructor(config: HindsightConfig, log: Log, client?: HindsightClient) {
		this.config = config;
		this.#log = log;
		this.#client = client ?? new HindsightClient({ baseUrl: config.url, userAgent: "pi-durable-claw", ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }) });
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
	 * The bridge's `messageContext`: the memories recalled for a message, or a note that memory could not be searched.
	 * T3 shows it after the message as a `hindsight_recall` call with the query it was recalled for.
	 */
	async recallFor(request: MessageContextRequest): Promise<MessageContextAnswer | undefined> {
		const query = request.text.trim().slice(0, QUERY_MAX_CHARS);
		if (query === "") return undefined;
		const shownAs = { name: "hindsight_recall", input: { query } };
		try {
			const response = await this.#client.recall(this.config.bank, query, {
				types: ["world", "experience", "observation"],
				preferObservations: true,
				maxTokens: RECALL_MAX_TOKENS,
				budget: "mid",
				signal: request.signal,
			});
			const memories = (response.results ?? []) as Recalled[];
			return memories.length === 0 ? undefined : { text: memoriesBlock(memories.map(memoryLine)), shownAs };
		} catch (error) {
			if (request.signal.aborted) throw error;
			return { text: memoriesUnavailable((error as Error).message), shownAs };
		}
	}

	/** Store a finished turn. Never fails the run: a failure is logged. */
	async retainRun(run: RunSummary, api: HookApi, context: Context): Promise<void> {
		try {
			const entries: EntryRecord[] = [];
			let cursor: Parameters<HookApi["entries"]>[2];
			do {
				const page = await api.entries({ minEntryId: run.first, maxEntryId: run.last, order: "ascending" }, ENTRY_PAGE, cursor, context);
				entries.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			const { text, startedAt } = turnTranscript(entries);
			if (text === "") return;
			await this.#client.retain(this.config.bank, text, {
				documentId: `conversation-${api.conversationId}-entry-${run.first}`,
				context: MEMORY_TURN_CONTEXT,
				metadata: { conversationId: String(api.conversationId) },
				...(startedAt === undefined ? {} : { timestamp: new Date(startedAt) }),
				async: true,
				signal: signalWithin(RETAIN_TIMEOUT_MS, context),
			});
		} catch (error) {
			this.#log.warn("memory: a turn was not stored", { conversationId: api.conversationId, first: run.first, error: (error as Error).message });
		}
	}

	/** Stores each finished turn. */
	extension(): Extension {
		return defineExtension({
			name: "hindsight",
			hooks: [
				hook(GenerationTask, {
					afterRun: async (run, api, context) => {
						await this.retainRun(run, api, context);
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
