import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { workspaceMemoryExtension } from "../src/memory.ts";

describe("workspace memory", () => {
	it("injects the active project's AGENTS.md", async () => {
		const root = await mkdtemp(join(tmpdir(), "pdc-memory-"));
		const project = join(root, "project");
		await mkdir(project);
		await writeFile(join(project, "AGENTS.md"), "# Project rule\n\nBe terse.");
		try {
			const env = new NodeExecutionEnv({ cwd: project });
			const section = workspaceMemoryExtension().sections?.find((candidate) => candidate.key === "workspace-memory");
			expect(section).toBeDefined();
			const text = await section!.render({ env } as never, BACKGROUND_CONTEXT);
			expect(text).toContain(`<workspace cwd="${project}"/>`);
			expect(text).toContain(`<file path="${join(project, "AGENTS.md")}">`);
			expect(text).toContain("# Project rule");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
