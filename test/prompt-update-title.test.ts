// The row that says the system prompt changed (`promptUpdateTitle`): what the agent was told anew, and why.
import { expect, it } from "vitest";
import { mcpServersSection } from "../src/mcp/section.ts";
import { skillsSection } from "../src/prompts.ts";
import { promptUpdateTitle } from "../src/prompt-update-title.ts";

const skill = (name: string, description = "does things") => ({ name, description, path: `/home/agent/.agents/skills/${name}/SKILL.md` });

it("names the file, the skill or the server that changed", () => {
	expect(promptUpdateTitle([{ key: "global-agents", before: "a", after: "b" }])).toBe("Agent instructions updated: ~/AGENTS.md changed");
	expect(promptUpdateTitle([{ key: "local-agents", before: undefined, after: "b" }])).toBe("Agent instructions updated: the project's AGENTS.md added");
	const skills = (...list: ReturnType<typeof skill>[]) => skillsSection("global", list);
	expect(promptUpdateTitle([{ key: "global-skills", before: skills(skill("notes"), skill("old"), skill("same")), after: skills(skill("notes", "does other things"), skill("release"), skill("review"), skill("same")) }])).toBe(
		"Agent instructions updated: skills added (release, review); skill removed (old); skill changed (notes)",
	);
	expect(promptUpdateTitle([{ key: "local-skills", before: undefined, after: skillsSection("local", [skill("deploy")]) }])).toBe("Agent instructions updated: project skill added (deploy)");
	const servers = (...names: string[]) => mcpServersSection(names.map((name) => ({ name, namespace: `mcp__${name}`, description: "a server" })));
	expect(promptUpdateTitle([{ key: "mcp-servers", before: undefined, after: servers("github") }, { key: "global-agents", before: "a", after: "b" }])).toBe("Agent instructions updated: MCP server added (github); ~/AGENTS.md changed");
	expect(promptUpdateTitle([{ key: "mcp-servers", before: servers("github", "linear"), after: undefined }])).toBe("Agent instructions updated: MCP servers removed (github, linear)");
	// A section this does not know is named by its key.
	expect(promptUpdateTitle([{ key: "something", before: "a", after: "b" }])).toBe("Agent instructions updated: something changed");
});
