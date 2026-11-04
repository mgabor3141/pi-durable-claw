import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { HARNESS_PREAMBLE } from "./prompts.ts";

/** The untagged first section: identity and the codemode working model. */
export function preambleExtension(): Extension {
	return defineExtension({
		name: "preamble",
		sections: [section("preamble", () => HARNESS_PREAMBLE, { tag: false })],
	});
}
