// What the harness knows of a provider's prompt cache from a conversation's own messages: which requests were
// counted, and whether the cache still holds what the last of them sent. Read by the compaction's choice of summary
// (`compaction.ts`), the prompt's following of its files (`fixed-prompt.ts`) and the miss log (`cache-misses.ts`).
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

/** Lifetimes of a provider's prompt cache when the model's catalog entry has none: Anthropic's. */
const CACHE_SECONDS = { short: 300, long: 3600 } as const;
/** A request is sent this long before the cache would expire, or the cache is taken as expired. */
const CACHE_MARGIN_MS = 10_000;

export type CachedModel = { readonly provider: string; readonly id: string; readonly promptCache?: { readonly short?: number; readonly long?: number }; readonly compat?: unknown };

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
export function cacheHolds(answered: readonly AssistantMessage[], model: CachedModel, now: number):
	| { readonly holds: true; readonly last: AssistantMessage; readonly lifetimeMs: number; readonly lifetimeKnown: boolean }
	| { readonly holds: false; readonly why: string; readonly known: boolean; readonly expired: boolean; readonly lifetimeKnown: boolean } {
	// `known`: the cache is known not to hold. Not known: nothing says whether the provider caches at all.
	// `lifetimeKnown`: some request wrote the cache, so its lifetime comes from that write rather than a fallback.
	const last = answered.at(-1);
	if (last === undefined) return { holds: false, known: false, expired: false, lifetimeKnown: false, why: "no request of this context was answered yet, so no cache holds it" };
	if (last.provider !== model.provider || last.model !== model.id) return { holds: false, known: true, expired: false, lifetimeKnown: false, why: "the last request went to another model, whose cache this model does not read" };
	if (last.usage.cacheRead + last.usage.cacheWrite <= 0) return { holds: false, known: false, expired: false, lifetimeKnown: false, why: "the last request used no prompt cache" };
	const wrote = answered.findLast((answer) => answer.usage.cacheWrite > 0);
	const tier = ((wrote?.usage as { cacheWrite1h?: number } | undefined)?.cacheWrite1h ?? 0) > 0 ? "long" : "short";
	const lifetimeMs = (model.promptCache?.[tier] ?? CACHE_SECONDS[tier]) * 1000;
	const age = now - last.timestamp;
	if (age > lifetimeMs - CACHE_MARGIN_MS) return { holds: false, known: true, expired: true, lifetimeKnown: wrote !== undefined, why: `the prompt cache has expired: ${Math.round(age / 60_000)} min since the last request, kept for ${Math.round(lifetimeMs / 60_000)}` };
	return { holds: true, last, lifetimeMs, lifetimeKnown: wrote !== undefined };
}
