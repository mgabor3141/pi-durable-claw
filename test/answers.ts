// An assistant message with made-up usage: what the tests of the prompt cache's rules (`prompt-cache.ts`) read.
import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";

/** A time far from now, so nothing depends on the clock. */
export const T0 = 1_000_000_000_000;
export const MINUTE = 60_000;

/**
 * An answer of `model` at `at`, counted as 10 input tokens unless `usage` says otherwise: `{ cacheWrite: 100_000 }`
 * wrote the cache, `{ cacheRead: … }` read it, `{ input: 0 }` with `stopReason: "error"` in `more` was not counted.
 */
export function answerOf(model: { readonly provider: string; readonly id: string }, at: number, usage: object = {}, more: object = {}): AssistantMessage {
	const counted = { input: 10, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage };
	return { ...fauxAssistantMessage("ok"), provider: model.provider, model: model.id, timestamp: at, usage: counted, ...more } as AssistantMessage;
}
