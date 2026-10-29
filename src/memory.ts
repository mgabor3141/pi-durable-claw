import { join } from "node:path";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";

/**
 * One file in the workspace memory prompt. `content` files are injected; `reference`
 * files only contribute a short note (name, roughly what they hold, how to read
 * them), so a conversation does not carry personal context until it is needed.
 */
export interface WorkspaceMemoryFile {
	/** The label shown to the model. */
	readonly label: string;
	/** Absolute path in the workspace. */
	readonly path: string;
	/** Default: `content`. */
	readonly mode?: "content" | "reference";
	/** One line for a reference: roughly what the file holds. */
	readonly summary?: string;
}

export interface WorkspaceMemoryOptions {
	readonly files?: readonly WorkspaceMemoryFile[];
	/** Total character budget for the section. */
	readonly maxTotal?: number;
}

/**
 * The workspace memory the model sees at the start of every request. The global
 * AGENTS.md and the active project's AGENTS.md are injected; USER.md is only
 * referenced, because it is personal and a project conversation usually does
 * not need it. MEMORY.md is named in AGENTS.md and read on demand. Other project
 * files are read on demand too.
 *
 * The files live in the workspace, which is the execution environment; the
 * section reads them over pi-env SSH, the same route the tools use. A missing
 * or unreadable file is omitted rather than failing the request.
 */
const HOME = "/home/agent";
const FILES = [
	{ label: "AGENTS.md", path: join(HOME, "AGENTS.md"), mode: "content" },
	{
		label: "USER.md",
		path: join(HOME, "USER.md"),
		mode: "reference",
		summary: "The user's stable profile: identity, communication style, and preferences",
	},
] as const satisfies readonly WorkspaceMemoryFile[];

/** Total character budget for the section. The per-file cap is the remaining room. */
const MAX_TOTAL = 24_000;

export function workspaceMemoryExtension(options: WorkspaceMemoryOptions = {}): Extension {
	const files: readonly WorkspaceMemoryFile[] = options.files ?? FILES;
	const maxTotal = options.maxTotal ?? MAX_TOTAL;
	return defineExtension({
		name: "workspace-memory",
		sections: [
			section("workspace-memory", async (input, context) => {
				const env = input.env;
				if (env === undefined) return undefined;
				const parts: string[] = [`<workspace cwd="${env.cwd}"/>`];
				// A project thread starts in its project root; inject its AGENTS.md after the global one. Scratch threads
				// may have an AGENTS.md too, but only if the folder actually carries one.
				const requestFiles: WorkspaceMemoryFile[] = [...files];
				if (env.cwd !== HOME) {
					const projectFile = join(env.cwd, "AGENTS.md");
					requestFiles.splice(1, 0, { label: projectFile, path: projectFile, mode: "content" });
				}
				let used = 0;
				for (const file of requestFiles) {
					const room = maxTotal - used;
					if (room <= 0) break;

					if ((file.mode ?? "content") === "reference") {
						const exists = await env.exists(file.path, context);
						if (!exists.ok || !exists.value) continue;
						const note = `<file path="${file.label}" mode="reference">\nNot loaded. ${file.summary ?? "A workspace file"}. Read ${file.path} with the read tool only when the task needs it.\n</file>`;
						if (note.length > room) break;
						parts.push(note);
						used += note.length;
						continue;
					}

					const result = await env.readTextFile(file.path, context);
					if (!result.ok) continue;
					const text = result.value.trim();
					if (text.length === 0) continue;
					const body = text.length > room ? `${text.slice(0, room)}\n[truncated]` : text;
					parts.push(`<file path="${file.label}">\n${body}\n</file>`);
					used += body.length;
				}
				return parts.length > 0 ? parts.join("\n\n") : undefined;
			}),
		],
	});
}
