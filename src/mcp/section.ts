/**
 * The `mcp_servers` system prompt section.
 *
 * It names only servers whose tools are reached indirectly. A `deferred` server is loaded with
 * `tool_search`; a `codemode` server is called from scripts. Tools exposed directly are already
 * in the model's tool list and are not listed here. The section is bounded like pi's.
 */

export type McpReach = "tool_search" | "codemode";

export interface McpServerSummary {
	readonly name: string;
	readonly namespace: string;
	readonly description?: string;
	readonly reaches: readonly McpReach[];
}

const MAX_SERVER_DESCRIPTION_CHARS = 250;
const MAX_SECTION_CHARS = 4096;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

function intro(reaches: ReadonlySet<McpReach>): string {
	let text = "MCP servers whose tools are not declared to you.";
	if (reaches.has("codemode")) text += " Call the tools of codemode servers from codemode scripts.";
	if (reaches.has("tool_search")) text += " Load the tools of tool_search servers with tool_search.";
	return text;
}

/** Render the section, or undefined when no server needs one. */
export function mcpServersSection(servers: readonly McpServerSummary[]): string | undefined {
	const listed = servers
		.filter((server) => server.reaches.length > 0)
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));
	if (listed.length === 0) return undefined;

	const reaches = new Set(listed.flatMap((server) => server.reaches));
	const introText = intro(reaches);
	const heads = listed.map(
		(server) => `- ${server.namespace} (${server.reaches.join(", ")})`,
	);
	const omitted = (count: number) =>
		count > 0
			? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`]
			: [];
	const size = (kept: number) => [introText, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;

	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SECTION_CHARS) kept--;
	const perServer =
		kept === 0
			? 0
			: Math.min(
					MAX_SERVER_DESCRIPTION_CHARS,
					Math.floor((MAX_SECTION_CHARS - size(kept)) / kept) - 2,
				);
	const lines = listed.slice(0, kept).map((server, index) => {
		const summary =
			perServer > 0 && server.description !== undefined ? truncate(server.description.trim().split("\n", 1)[0] ?? "", perServer) : "";
		return summary.length > 0 ? `${heads[index]}: ${summary}` : heads[index];
	});
	return [introText, ...lines, ...omitted(listed.length - kept)].join("\n");
}
