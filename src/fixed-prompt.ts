import { defineExtension, wrapSection, type Extension } from "@earendil-works/pi-durable";

/**
 * Every section of the harness's system prompt, in no particular order. test/fixed-prompt.test.ts checks the list
 * against the extensions that provide sections, so a new section cannot be left out.
 */
export const PROMPT_SECTIONS = [
	"preamble",
	"codemode",
	"mcp-servers",
	"global-agents",
	"global-skills",
	"cwd",
	"local-agents",
	"local-skills",
	"conversation-time",
] as const;

/** A section every rendered prompt has: while it is shown, the prompt is in effect. */
const IN_EFFECT = "preamble";

/**
 * The system prompt is rendered once and then kept as it is: every later request answers each section with what the
 * thread already shows, so the cached prefix holds whatever changes underneath (AGENTS.md, skills, ~/.mcp.json, the
 * tools registered). A section absent then stays absent. It is rendered afresh when nothing is shown: a new thread,
 * `/reload` (the bridge's `Threads.reload` removes every shown section), and a compaction (its first request writes the
 * whole prompt again, after the head). One exception: the history a compaction keeps (its last ~20k tokens) can hold
 * the prompt a recent `/reload` rendered, and then that prompt is the one kept. Nothing tells a section that a
 * compaction's baseline is being written, and only a `/reload` puts sections in the history.
 */
export function fixedPromptExtension(): Extension {
	return defineExtension({
		name: "fixed-prompt",
		wraps: PROMPT_SECTIONS.map((key) =>
			wrapSection(key, (section) => ({
				key: section.key,
				// The shown text is already tagged: tag a fresh rendering here, as pi-durable would.
				tag: false,
				render: async (input, context) => {
					if (input.shown[IN_EFFECT] !== undefined) return input.shown[key];
					const text = await section.render(input, context);
					return text === undefined || section.tag === false ? text : `<${key}>\n${text}\n</${key}>`;
				},
			})),
		),
	});
}
