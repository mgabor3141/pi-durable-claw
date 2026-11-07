import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { HARNESS_PREAMBLE, TOOL_SEARCH_PREAMBLE } from "./prompts.ts";

/** The untagged first section: identity and the working model. */
export function preambleExtension(options: { toolSearch?: () => boolean } = {}): Extension {
	const offered = options.toolSearch ?? (() => false);
	return defineExtension({
		name: "preamble",
		sections: [section("preamble", () => (offered() ? TOOL_SEARCH_PREAMBLE : HARNESS_PREAMBLE), { tag: false })],
	});
}
