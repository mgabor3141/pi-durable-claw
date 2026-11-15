import type { CacheRetention, Models } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, ProviderDoc, type ConversationId, type Extension } from "@earendil-works/pi-durable";

/** A request is sent by one of these; both take `(model, context, options)`. */
const SENDS = new Set<PropertyKey>(["streamSimple", "completeSimple"]);
/** Provider sessions remembered: one per conversation that sent a request since the harness started. */
const REMEMBERED = 5000;

/**
 * How long a provider keeps a conversation's prompt cache, chosen per conversation.
 *
 * pi-durable has one `settings.stream.cacheRetention` for the whole Harness, and what is wanted is two: an hour for
 * the threads a person works in, where a pause of ten minutes should not cost the whole context again, and pi's
 * default five minutes for the threads an agent or a scheduled task starts, which rarely pause and resume, and whose
 * cache writes would cost 2× the input price instead of 1.25×. Claude Code makes the same split.
 *
 * Until pi-durable has a per-conversation option, this is done in two halves that meet at the provider session id,
 * which every conversation has its own of and every request carries:
 * - `extension()`: before each request of a conversation, remember its session's retention (`retentionOf`).
 * - `models()`: a request that names a remembered session and no retention of its own is sent with that retention.
 *
 * A compaction's summary on the conversation (`compaction.ts`) runs the same request hooks and names the same
 * session, so it gets the same retention, which it must: another retention is another cache entry. A request that
 * sets its own (the transcript summarizer's `none`) keeps it, and one without a session is not a conversation's.
 */
export class ConversationCacheRetention {
	readonly #retentionOf: (conversationId: ConversationId) => CacheRetention | undefined;
	readonly #sessions = new Map<string, CacheRetention | undefined>();

	constructor(retentionOf: (conversationId: ConversationId) => CacheRetention | undefined) {
		this.#retentionOf = retentionOf;
	}

	extension(): Extension {
		return defineExtension({
			name: "cache-retention",
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async (_request, api, context) => {
						const session = await api.snapshot(ProviderDoc, api.conversationId, context);
						if (session !== undefined) this.#remember(session.sessionId, this.#retentionOf(api.conversationId));
						return undefined;
					},
				}),
			],
		});
	}

	models<M extends Models>(models: M): M {
		const sessions = this.#sessions;
		return new Proxy(models, {
			get(target, key) {
				const value: unknown = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				// Bound to the runtime itself: its methods read private state a proxy does not have.
				const method = value.bind(target) as (...args: unknown[]) => unknown;
				if (!SENDS.has(key)) return method;
				return (model: unknown, context: unknown, options?: { readonly sessionId?: string; readonly cacheRetention?: CacheRetention }) => {
					const retention = options?.sessionId === undefined || options.cacheRetention !== undefined ? undefined : sessions.get(options.sessionId);
					return method(model, context, retention === undefined ? options : { ...options, cacheRetention: retention });
				};
			},
		});
	}

	#remember(sessionId: string, retention: CacheRetention | undefined): void {
		this.#sessions.delete(sessionId);
		this.#sessions.set(sessionId, retention);
		if (this.#sessions.size > REMEMBERED) this.#sessions.delete(this.#sessions.keys().next().value as string);
	}
}
