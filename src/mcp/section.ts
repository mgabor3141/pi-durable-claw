/**
 * The `mcp-servers` system prompt section: the servers in ~/.mcp.json whose tools scripts can call, each with the
 * description its entry gives. It is rendered with the rest of the prompt and kept for the thread, so it comes from the
 * configuration, not from what is connected at the moment; the `mcp` tool's status says that.
 */

import { MCP_SERVERS_INTRO } from "../prompts.ts";

export interface McpServerSummary {
	readonly name: string;
	readonly namespace: string;
	readonly description?: string;
}

const MAX_DESCRIPTION_CHARS = 250;

function firstLine(text: string): string {
	const line = text.trim().split("\n", 1)[0]?.trim() ?? "";
	return line.length <= MAX_DESCRIPTION_CHARS ? line : `${line.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/** Render the section, or undefined without servers. */
export function mcpServersSection(servers: readonly McpServerSummary[]): string | undefined {
	if (servers.length === 0) return undefined;
	const lines = servers
		.toSorted((a, b) => a.name.localeCompare(b.name))
		.map((server) => {
			const description = server.description === undefined ? "" : firstLine(server.description);
			return `- ${server.name} (${server.namespace})${description === "" ? "" : `: ${description}`}`;
		});
	return [MCP_SERVERS_INTRO, ...lines].join("\n");
}
