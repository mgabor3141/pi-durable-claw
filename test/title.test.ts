// The title prompt: the conversation, the ask, and the user's own title instructions (T3's Settings) last.
import { expect, it } from "vitest";
import { TITLE_ASK, titlePrompt } from "../src/prompts.ts";

it("adds T3's title instructions after the ask, and nothing when they are blank", () => {
	expect(titlePrompt("[user]: hi", TITLE_ASK, "  Use sentence case. ")).toBe(`[user]: hi\n\n${TITLE_ASK}\n\nAdditional instructions:\nUse sentence case.`);
	expect(titlePrompt("[user]: hi", TITLE_ASK, "   ")).toBe(`[user]: hi\n\n${TITLE_ASK}`);
	expect(titlePrompt("[user]: hi", TITLE_ASK)).toBe(`[user]: hi\n\n${TITLE_ASK}`);
});
