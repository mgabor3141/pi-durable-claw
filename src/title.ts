// Copied from pi-durable-t3's example agent (examples/coding-agent/src/title.ts), same author and license.
// The example's `titleThread` hook: one tool-less completion on T3's text-generation model when Settings names one of
// ours, else on the thread's own model. It reads the conversation's
// context at the entry the bridge names (not a fork: the title model gets no tools and runs nothing) and sends its
// user/assistant TEXT only, trimmed to a budget the way T3's `formatThreadTitleContext` does: no tool calls or results
// (no tools are declared), no thinking, at most 2000 characters per message and 8000 in all, keeping the first user
// message and then the most recent ones.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import type { TitleThread } from "@mgabor3141/pi-durable-t3";
import { TITLE_ASK, TITLE_SYSTEM_PROMPT, titleContext, titlePrompt, titleRegenerateAsk } from "./prompts.ts";

export { titleContext } from "./prompts.ts";

export function titleThread(harness: Harness, models: Models): TitleThread {
	return async ({ conversationId, at, reason, previousTitle, signal, model: configured }) => {
		const ctx = BACKGROUND_CONTEXT;
		const conversation = await harness.conversation(conversationId, ctx);
		if (conversation === undefined) return undefined;
		const ref = configured ?? (await conversation.agent(ctx)).model;
		const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
		const reasoning = configured?.thinkingLevel;
		if (model === undefined) return undefined;
		const { messages } = await conversation.context(ctx, { at });
		const ask = reason === "regenerate" ? titleRegenerateAsk(previousTitle) : TITLE_ASK;
		const reply = await models.completeSimple(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: titlePrompt(titleContext(messages), ask), timestamp: Date.now() }],
			},
			{ signal, ...(reasoning === undefined || reasoning === "off" ? {} : { reasoning: reasoning as never }) },
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
		const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
		return text.replace(/^["']|["']$/g, "").trim() || undefined;
	};
}
