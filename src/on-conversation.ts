// A request on a conversation: the request the agent itself would send next, with one more message that asks for
// something else (a compaction's summary, the memory step's notes). Such a request starts byte for byte as the agent's
// own last one did, so the provider's prompt cache answers everything but the ask. It goes to the model the agent's own
// requests went to, with the same thinking level, session and options, and through the same request hooks; the ask
// follows the conversation, and nothing before it is left out or rewritten.
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { GenerationTask, type Extension, type HookApi } from "@earendil-works/pi-durable";

/**
 * The ask, after the conversation: a system message where the model takes one in the middle of a conversation
 * (`compat.supportsMidConvoSystemMessages`), as the harness's own instructions are; otherwise a user message, since pi
 * folds a system message into the leading prompt for any other model, which would rewrite the request's start.
 */
export function askMessage(model: { readonly compat?: unknown }, text: string): Message {
	const midConversation = (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true;
	return midConversation ? { role: "system", content: text, timestamp: Date.now() } : { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** The messages as the agent's own request would send them: through every `beforeRequest` hook of its extensions. */
export async function requestMessages(api: HookApi, extensions: readonly Extension[], messages: readonly Message[], context: Context): Promise<readonly Message[]> {
	let current = messages;
	for (const extension of extensions) {
		for (const installed of extension.hooks ?? []) {
			if (installed.task !== GenerationTask.definition.name) continue;
			const handlers = installed.handlers as { beforeRequest?: (request: { messages: readonly Message[] }, api: HookApi, context: Context) => unknown };
			if (typeof handlers.beforeRequest !== "function") continue;
			const replaced = (await handlers.beforeRequest({ messages: current }, api, context)) as { messages: readonly Message[] } | undefined;
			if (replaced !== undefined) current = replaced.messages;
		}
	}
	return current;
}

/** The provider request body through every `beforeProviderRequest` hook, as the agent's own request's is. */
export async function requestPayload(api: HookApi, extensions: readonly Extension[], model: unknown, payload: unknown, context: Context): Promise<unknown> {
	let current = payload;
	for (const extension of extensions) {
		for (const installed of extension.hooks ?? []) {
			if (installed.task !== GenerationTask.definition.name) continue;
			const handlers = installed.handlers as { beforeProviderRequest?: (request: { model: unknown; payload: unknown }, api: HookApi, context: Context) => unknown };
			if (typeof handlers.beforeProviderRequest !== "function") continue;
			const replaced = (await handlers.beforeProviderRequest({ model, payload: current }, api, context)) as { payload: unknown } | undefined;
			if (replaced !== undefined) current = replaced.payload;
		}
	}
	return current;
}
