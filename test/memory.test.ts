import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { HARNESS_PREAMBLE } from "../src/prompts.ts";
import { preambleExtension } from "../src/preamble.ts";
import { workspaceMemoryExtension } from "../src/memory.ts";

const section = (extension: ReturnType<typeof workspaceMemoryExtension>, key: string) =>
	extension.sections?.find((candidate) => candidate.key === key);

async function skill(root: string, dir: string, name: string, description: string): Promise<void> {
	const path = join(root, ".agents", "skills", dir);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

describe("system prompt", () => {
	it("renders the preamble first and untagged", async () => {
		const section = preambleExtension().sections?.find((candidate) => candidate.key === "preamble");
		expect(section?.tag).toBe(false);
		expect(await section!.render({} as never, BACKGROUND_CONTEXT)).toBe(HARNESS_PREAMBLE);
	});

	it("injects global and local AGENTS.md, then the working directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pdc-memory-"));
		const home = join(root, "home");
		const project = join(root, "project");
		await mkdir(home);
		await mkdir(project);
		await writeFile(join(home, "AGENTS.md"), "# Global rule\n\nBe terse.");
		await writeFile(join(project, "AGENTS.md"), "# Project rule\n\nUse tests.");
		try {
			const env = new NodeExecutionEnv({ cwd: project });
			const extension = workspaceMemoryExtension({ home });
			expect(extension.sections?.map((candidate) => candidate.key)).toEqual([
				"global-agents",
				"global-skills",
				"cwd",
				"local-agents",
				"local-skills",
				"conversation-time",
			]);

			const global = await section(extension, "global-agents")!.render({ env } as never, BACKGROUND_CONTEXT);
			expect(global).toContain(`<global-agents path="${join(home, "AGENTS.md")}">`);
			expect(global).toContain("# Global rule");

			const local = await section(extension, "local-agents")!.render({ env } as never, BACKGROUND_CONTEXT);
			expect(local).toContain(`<local-agents path="${join(project, "AGENTS.md")}">`);
			expect(local).toContain("Local instructions take precedence");
			expect(local).toContain("# Project rule");

			const cwd = await section(extension, "cwd")!.render({ env } as never, BACKGROUND_CONTEXT);
			expect(cwd).toBe(`<cwd>\n${project}\n</cwd>`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lists global and local skills and lets local names shadow global ones", async () => {
		const root = await mkdtemp(join(tmpdir(), "pdc-skills-"));
		const home = join(root, "home");
		const project = join(root, "project");
		await mkdir(home);
		await mkdir(project);
		await skill(home, "global-only", "global-only", "A global skill");
		await skill(home, "shadowed", "shadowed", "The global copy");
		await skill(project, "local-only", "local-only", "A local skill");
		await skill(project, "shadowed", "shadowed", "The local copy");
		try {
			const env = new NodeExecutionEnv({ cwd: project });
			const extension = workspaceMemoryExtension({ home });

			const global = await section(extension, "global-skills")!.render({ env } as never, BACKGROUND_CONTEXT);
			expect(global).toContain("<name>global-only</name>");
			expect(global).not.toContain("<name>shadowed</name>");

			const local = await section(extension, "local-skills")!.render({ env } as never, BACKGROUND_CONTEXT);
			expect(local).toContain("<name>local-only</name>");
			expect(local).toContain("<name>shadowed</name>");
			expect(local).toContain("The local copy");
			expect(local).toContain(`<location>${join(project, ".agents", "skills", "shadowed", "SKILL.md")}</location>`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("renders when the conversation started, from its recorded start (test/fixed-prompt.test.ts keeps it over a reload)", async () => {
		const extension = workspaceMemoryExtension({ now: () => new Date("2026-11-04T12:42:00Z") });
		const time = section(extension, "conversation-time");
		const reading = (at: number | undefined) => ({ shown: {}, conversationId: 1, read: { snapshot: async () => (at === undefined ? undefined : { at }) } }) as never;
		const recorded = await time!.render(reading(Date.parse("2026-10-01T08:00:00Z")), BACKGROUND_CONTEXT);
		expect(recorded).toContain("<conversation-time>");
		expect(recorded).toContain("Local time when this conversation started:");
		expect(recorded).toContain("2026-10-01");
		// A conversation from before starts were recorded: the clock.
		expect(await time!.render(reading(undefined), BACKGROUND_CONTEXT)).toContain("2026-11-04");
	});
});
