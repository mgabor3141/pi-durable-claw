import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, type ConversationId, type EntryRecord, type Extension } from "@earendil-works/pi-durable";

/** Lifetimes of a provider's prompt cache when the model's catalog entry has none: Anthropic's. */
const CACHE_SECONDS = { short: 300, long: 3600 } as const;
/** A request is sent this long before the cache would expire, or the cache is taken as expired. */
const CACHE_MARGIN_MS = 10_000;
/** A request that read less than this share of what the one before it sent has missed the cache. */
const MISSED_BELOW = 0.9;
/** How far back a response looks for the request before it: a run's tool results lie between. */
const LOOK_BACK = 200;

type CachedModel = { readonly provider: string; readonly id: string; readonly promptCache?: { readonly short?: number; readonly long?: number } };

/** What a request sent, as its provider counted it: 0 for one that failed before it was counted. */
export const sentOf = (usage: Usage | undefined): number => (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);

/** The requests among `messages` that were answered and counted, oldest first. */
export const answeredOf = (messages: readonly Message[]): AssistantMessage[] =>
	messages.filter((message): message is AssistantMessage => message.role === "assistant" && sentOf(message.usage) > 0);

/**
 * Whether a provider's prompt cache still holds what a conversation's last request sent, at `now`. `answered` are its
 * counted requests, oldest first. It holds when the last of them went to `model`, used the cache, and is within the
 * lifetime the newest write asked for, since a read renews an entry for the lifetime it was written with (Anthropic
 * counts its one-hour tokens apart; the lifetimes are the model's catalog values, else Anthropic's).
 */
export function cacheHolds(answered: readonly AssistantMessage[], model: CachedModel, now: number): { readonly holds: true; readonly last: AssistantMessage; readonly lifetimeMs: number } | { readonly holds: false; readonly why: string; readonly known: boolean } {
	// `known`: the cache is known not to hold. Not known: nothing says whether the provider caches at all.
	const last = answered.at(-1);
	if (last === undefined) return { holds: false, known: false, why: "no request of this context was answered yet, so no cache holds it" };
	if (last.provider !== model.provider || last.model !== model.id) return { holds: false, known: true, why: "the last request went to another model, whose cache this model does not read" };
	if (last.usage.cacheRead + last.usage.cacheWrite <= 0) return { holds: false, known: false, why: "the last request used no prompt cache" };
	const wrote = answered.findLast((answer) => answer.usage.cacheWrite > 0);
	const tier = ((wrote?.usage as { cacheWrite1h?: number } | undefined)?.cacheWrite1h ?? 0) > 0 ? "long" : "short";
	const lifetimeMs = (model.promptCache?.[tier] ?? CACHE_SECONDS[tier]) * 1000;
	const age = now - last.timestamp;
	if (age > lifetimeMs - CACHE_MARGIN_MS) return { holds: false, known: true, why: `the prompt cache has expired: ${Math.round(age / 60_000)} min since the last request, kept for ${Math.round(lifetimeMs / 60_000)}` };
	return { holds: true, last, lifetimeMs };
}

/** A request that should have read the cache and did not. Token counts are the provider's. */
export type CacheMiss = {
	readonly conversationId: ConversationId;
	readonly model: string;
	/** What the request before sent: all of it was in the cache. */
	readonly expected: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly input: number;
	readonly sinceLastRequestS: number;
	readonly lifetimeS: number;
};

/**
 * The miss a response shows, or `undefined`. `before` are the conversation's entries before the response, newest
 * first. A response missed when the cache still held the request before it (`cacheHolds`) and it read less than
 * `MISSED_BELOW` of what that request sent. Not a miss: the first request after a compaction or a rewritten system
 * prompt (`/reload`), which change the start of the request on purpose.
 */
export function cacheMissOf(response: AssistantMessage, before: readonly EntryRecord[], model: CachedModel, conversationId: ConversationId): CacheMiss | undefined {
	if (sentOf(response.usage) <= 0) return undefined;
	const answered: AssistantMessage[] = [];
	for (const entry of before) {
		// Nothing older counts: the request's start was written anew here.
		if (entry.kind === "pi.compaction" || entry.kind === "pi.system") break;
		// The response itself, should it be committed already.
		answered.unshift(...answeredOf(entry.model ?? []).filter((answer) => answer.timestamp !== response.timestamp));
	}
	const cache = cacheHolds(answered, model, response.timestamp);
	if (!cache.holds) return undefined;
	const expected = sentOf(cache.last.usage);
	if (response.usage.cacheRead >= expected * MISSED_BELOW) return undefined;
	return {
		conversationId,
		model: `${model.provider}/${model.id}`,
		expected,
		cacheRead: response.usage.cacheRead,
		cacheWrite: response.usage.cacheWrite,
		input: response.usage.input,
		sinceLastRequestS: Math.round((response.timestamp - cache.last.timestamp) / 1000),
		lifetimeS: Math.round(cache.lifetimeMs / 1000),
	};
}

/**
 * Tells `missed` of each response that should have read the provider's prompt cache and did not: the cache was
 * written by the request before, to the same model, within its lifetime, and nothing rewrote the start of the
 * request since. Such a miss costs the whole context at the write price, and says that something changed the request's
 * start (a tool's description, a block inserted before the end) or that the provider dropped the entry.
 */
export function cacheMissExtension(missed: (miss: CacheMiss) => void): Extension {
	return defineExtension({
		name: "cache-misses",
		hooks: [
			hook(GenerationTask, {
				afterResponse: async (message, api, context) => {
					if (sentOf(message.usage) <= 0) return;
					const model = api.models.getModel(message.provider, message.model);
					if (model === undefined) return;
					const page = await api.entries({ order: "descending" }, LOOK_BACK, undefined, context);
					const miss = cacheMissOf(message, page.items, model, api.conversationId);
					if (miss !== undefined) missed(miss);
				},
			}),
		],
	});
}
