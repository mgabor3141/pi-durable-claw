// A request that should have read the provider's prompt cache and did not, told to the host for its log.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, type ConversationId, type EntryRecord, type Extension } from "@earendil-works/pi-durable";
import { answeredOf, cacheHolds, sentOf, type CachedModel } from "./prompt-cache.ts";

/** A request that read less than this share of what the one before it sent has missed the cache. */
const MISSED_BELOW = 0.9;
/** How far back a response looks for the request before it: a run's tool results lie between. */
const LOOK_BACK = 200;

/**
 * Whether a `pi.system` entry leaves the start of the request as it was. It does for a model that takes system
 * messages in the middle of a conversation (`compat.supportsMidConvoSystemMessages`): pi sends the entry in place,
 * behind everything the provider has cached. Tool changes need the same of the model for tools; without it they
 * change the tools the request starts with. For any other model the entry is folded into the leading prompt.
 */
function appended(entry: EntryRecord, model: CachedModel): boolean {
	const compat = model.compat as { supportsMidConvoSystemMessages?: boolean; supportsMidConvoToolChanges?: boolean; supportsMidConvoToolAdditions?: boolean } | undefined;
	if (compat?.supportsMidConvoSystemMessages !== true) return false;
	const message = entry.model?.[0] as { toolsAdded?: readonly unknown[]; toolsRemoved?: readonly unknown[] } | undefined;
	const added = (message?.toolsAdded?.length ?? 0) > 0;
	const removed = (message?.toolsRemoved?.length ?? 0) > 0;
	if (!added && !removed) return true;
	return compat.supportsMidConvoToolChanges === true || (!removed && compat.supportsMidConvoToolAdditions === true);
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
 * `MISSED_BELOW` of what that request sent. Not a miss: the first request after a compaction, or after a system
 * prompt change that rewrote the start of the request (`appended` says which do not: an update sent in place to a
 * model that takes one is checked like any request, and is where a miss would cost the most).
 */
export function cacheMissOf(response: AssistantMessage, before: readonly EntryRecord[], model: CachedModel, conversationId: ConversationId): CacheMiss | undefined {
	if (sentOf(response.usage) <= 0) return undefined;
	const answered: AssistantMessage[] = [];
	for (const entry of before) {
		// Nothing older counts: the request's start was written anew here.
		if (entry.kind === "pi.compaction" || (entry.kind === "pi.system" && !appended(entry, model))) break;
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
