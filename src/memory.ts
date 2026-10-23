import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";

/**
 * The workspace memory the model sees at the start of every request: the global
 * AGENTS.md, the user profile, and the durable memory index. Project files are
 * read on demand, so a conversation does not pay for every project.
 *
 * The files live in the workspace, which is the execution environment; the
 * section reads them over pi-env SSH, the same route the tools use. A missing
 * or unreadable file is omitted rather than failing the request.
 */
const FILES = [
	{ label: "AGENTS.md", path: "/workspace/AGENTS.md" },
	{ label: "USER.md", path: "/workspace/USER.md" },
	{ label: "MEMORY.md", path: "/workspace/MEMORY.md" },
] as const;

/** Total character budget for all files. The per-file cap is the remaining room. */
const MAX_TOTAL = 24_000;

export function workspaceMemoryExtension(): Extension {
	return defineExtension({
		name: "workspace-memory",
		sections: [
			section("workspace-memory", async (input, context) => {
				const env = input.env;
				if (env === undefined) return undefined;
				const parts: string[] = [];
				let used = 0;
				for (const file of FILES) {
					const result = await env.readTextFile(file.path, context);
					if (!result.ok) continue;
					const text = result.value.trim();
					if (text.length === 0) continue;
					const room = MAX_TOTAL - used;
					if (room <= 0) break;
					const body = text.length > room ? `${text.slice(0, room)}\n[truncated]` : text;
					parts.push(`<file path="${file.label}">\n${body}\n</file>`);
					used += body.length;
				}
				return parts.length > 0 ? parts.join("\n\n") : undefined;
			}),
		],
	});
}
