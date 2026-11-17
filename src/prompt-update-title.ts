// What a change of the system prompt is called in the thread (the bridge's `promptUpdateTitle`): what the agent was
// told anew, and why. "Agent instructions updated: skill added (release-notes); ~/AGENTS.md changed".
import type { PromptSectionChange } from "@mgabor3141/pi-durable-t3";

/** The entries of a list section by name: a skill's block, an MCP server's line. */
function entries(text: string | undefined, pattern: RegExp): Map<string, string> {
	return new Map([...(text ?? "").matchAll(pattern)].map((match) => [match[1]!, match[0]]));
}

/** "skill added (a, b)", "skill removed (c)", "skill changed (d)"; nothing when the entries are the same. */
function listReasons(what: string, change: PromptSectionChange, pattern: RegExp): string[] {
	const before = entries(change.before, pattern);
	const after = entries(change.after, pattern);
	const named = (word: string, names: string[]): string[] => (names.length === 0 ? [] : [`${what}${names.length === 1 ? "" : "s"} ${word} (${names.join(", ")})`]);
	return [
		...named("added", [...after.keys()].filter((name) => !before.has(name))),
		...named("removed", [...before.keys()].filter((name) => !after.has(name))),
		...named("changed", [...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name))),
	];
}

const SKILL = /<skill>\s*<name>([^<]*)<\/name>[\s\S]*?<\/skill>/g;
const MCP_SERVER = /^- (\S+) \(.*$/gm;

function reasons(change: PromptSectionChange): string[] {
	const how = change.after === undefined ? "removed" : change.before === undefined ? "added" : "changed";
	switch (change.key) {
		case "global-agents":
			return [`~/AGENTS.md ${how}`];
		case "local-agents":
			return [`the project's AGENTS.md ${how}`];
		case "global-skills":
		case "local-skills": {
			const listed = listReasons(change.key === "local-skills" ? "project skill" : "skill", change, SKILL);
			return listed.length > 0 ? listed : [`the list of ${change.key === "local-skills" ? "project " : ""}skills changed`];
		}
		case "mcp-servers": {
			const listed = listReasons("MCP server", change, MCP_SERVER);
			return listed.length > 0 ? listed : ["the list of MCP servers changed"];
		}
		case "codemode":
			return ["the tools changed"];
		case "cwd":
			return ["the working directory changed"];
		case "preamble":
			return ["the harness's own part changed"];
		default:
			return [`${change.key} ${how}`];
	}
}

export function promptUpdateTitle(changes: readonly PromptSectionChange[]): string {
	return `Agent instructions updated: ${changes.flatMap(reasons).join("; ")}`;
}
