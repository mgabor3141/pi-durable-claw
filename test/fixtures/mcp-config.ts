import { readFile, stat } from "node:fs/promises";
import type { McpConfigSource } from "../../src/mcp/config.ts";

/** Test fixture: an MCP configuration file on this machine (the harness reads the workspace's `~/.mcp.json`). */
export function fileSource(path: string): McpConfigSource {
	return {
		describe: path,
		version: async () => {
			const info = await stat(path).catch(() => undefined);
			return info === undefined ? undefined : `${info.mtimeMs}:${info.size}`;
		},
		read: async () => {
			try {
				return await readFile(path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
	};
}
