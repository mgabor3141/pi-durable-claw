/**
 * The `codemode` prompt section as a catalog: every tool a script can call on one line, a few in full, the rest's details
 * on demand with `describeTool(name)`.
 *
 * pi-durable's section declares tools in full until a token budget runs out, cheapest first, and leaves the others
 * unnamed. With the budget unlimited the section was about 26,000 characters, nine tenths of the prompt; with pi's
 * default of 3,000 tokens the largest tools would be the hidden ones, and they are the ones whose arguments are hardest
 * to guess. Here the agent sees that every tool exists and what it is for, and reads a tool's declaration when it first
 * needs it, as tool search works in Claude Code, Codex and the MCP client guidance (a catalog of names and one line,
 * then the full definition on demand).
 *
 * - Pinned tools (`read`, `write`, `edit`, `bash`): declared in full, as pi-durable would; nearly every turn uses them.
 * - Every other tool: `- <name>: <first sentence of its description>`, grouped by namespace as pi-durable groups them.
 * - Deferred tools (MCP servers') stay out, as in pi-durable: `searchTools()` finds them, and the `mcp-servers`
 *   section names the servers.
 *
 * The section is rendered once per thread, like the rest of the prompt (`fixed-prompt.ts`), so this extension must come
 * before `fixedPromptExtension` among the selected extensions: wraps apply in that order, the first innermost.
 */
import { defineExtension, wrapSection, type Extension, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, type CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";

/** Tools nearly every turn uses: declared in full. */
export const PINNED_TOOLS = ["read", "write", "edit", "bash"] as const;
/** pi-durable's internal tools (`models.*`), which scripts reach only through globals. */
const INTERNAL_PREFIX = "pi.codemode.";
const SUMMARY_MAX = 200;

const HEADER = [
	"Tools scripts can call, as `await tools.<name>(args)`.",
	"The first few are declared in full; the others have one line each: before you first call one, `await describeTool(name)` gives its description and TypeScript declaration.",
	"MCP tools are not listed: `searchTools(query)` and `describeNamespace(name)` find them.",
].join(" ");

/** The codemode tool's sentence about the section, and what it says now. */
const SECTION_SENTENCE = "The `codemode` section of the system prompt lists the tools scripts can call, by namespace, as far as space allows.";
const CATALOG_SENTENCE = "The `codemode` section of the system prompt lists every tool scripts can call: a few declared in full, the others in one line each; `describeTool(name)` gives a tool's declaration.";

/** A description's first sentence, on one line: what the catalog says about a tool. */
export function summaryOf(description: string): string {
	const paragraph = (description.trim().split(/\n\s*\n/u)[0] ?? "").replace(/\s+/gu, " ").trim();
	const sentence = /^.*?[.!?](?=\s|$)/u.exec(paragraph)?.[0] ?? paragraph;
	return sentence.length > SUMMARY_MAX ? `${sentence.slice(0, SUMMARY_MAX - 1)}…` : sentence;
}

/** `### \`id\`` and the tool's description and declaration, as pi-durable renders a tool it lists. */
function declared(tool: ToolRegistration): string {
	const sample = renderToolSample({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as never,
		outputSchema: (tool.structuredOutputSchema ?? { type: "string" }) as never,
	});
	return `${heading("###", tool.name)}\n${sample.trim()}`;
}

function heading(level: string, name: string): string {
	const id = toCodemodeIdentifier(name);
	return id === name ? `${level} \`${id}\`` : `${level} \`${id}\` (\`${name}\`)`;
}

function line(tool: ToolRegistration): string {
	const id = toCodemodeIdentifier(tool.name);
	return `- ${id === tool.name ? id : `${id} (${tool.name})`}: ${summaryOf(tool.description)}`;
}

function namespaceOf(name: string, namespaces: readonly CodemodeNamespace[]): CodemodeNamespace | undefined {
	let found: CodemodeNamespace | undefined;
	for (const namespace of namespaces) {
		if (name.startsWith(namespace.prefix) && (found === undefined || namespace.prefix.length > found.prefix.length)) found = namespace;
	}
	return found;
}

/** The section's text, for the tools scripts can call. `undefined` without any, as pi-durable's section. */
export function catalogSection(callable: readonly ToolRegistration[], namespaces: readonly CodemodeNamespace[], pinned: readonly string[] = PINNED_TOOLS): string | undefined {
	const tools = callable.filter((tool) => !tool.name.startsWith(INTERNAL_PREFIX) && tool.deferred !== true);
	if (tools.length === 0) return undefined;
	const full = pinned.flatMap((name) => tools.filter((tool) => tool.name === name));
	const rest = tools.filter((tool) => !full.includes(tool));
	const loose = rest.filter((tool) => namespaceOf(tool.name, namespaces) === undefined);
	const grouped = new Map<string, { namespace: CodemodeNamespace; tools: ToolRegistration[] }>();
	for (const tool of rest) {
		const namespace = namespaceOf(tool.name, namespaces);
		if (namespace === undefined) continue;
		const group = grouped.get(namespace.name) ?? { namespace, tools: [] };
		group.tools.push(tool);
		grouped.set(namespace.name, group);
	}
	const parts = [HEADER, ...full.map(declared)];
	if (loose.length > 0) parts.push(`### Other tools\n${loose.map(line).join("\n")}`);
	for (const { namespace, tools: members } of [...grouped.values()].sort((a, b) => a.namespace.name.localeCompare(b.namespace.name))) {
		const description = namespace.description?.trim();
		parts.push(`## ${namespace.name}${description ? `\n${description}` : ""}\n${members.map(line).join("\n")}`);
	}
	return parts.join("\n\n");
}

/**
 * The catalog: wraps the `codemode` section (and the codemode tool's sentence about it). Select it before
 * `fixedPromptExtension`, so the fixed prompt keeps what this renders.
 */
export function codemodeCatalogExtension(options: { readonly namespaces?: readonly CodemodeNamespace[]; readonly pinned?: readonly string[] } = {}): Extension {
	const namespaces = options.namespaces ?? [];
	const tool: Wrap = {
		tool: CODEMODE_TOOL_NAME,
		wrap: (codemode: ToolRegistration) => {
			if (!codemode.description.includes(SECTION_SENTENCE)) throw new Error(`codemode catalog: the codemode tool's description no longer says "${SECTION_SENTENCE}"`);
			return { ...codemode, description: codemode.description.replace(SECTION_SENTENCE, CATALOG_SENTENCE) };
		},
	};
	return defineExtension({
		name: "codemode-catalog",
		wraps: [
			wrapSection("codemode", (section) => ({ ...section, render: (input) => catalogSection(input.agent.callable, namespaces, options.pinned) })),
			tool,
		],
	});
}
