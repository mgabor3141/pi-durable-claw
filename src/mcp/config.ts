/**
 * MCP server configuration for the claw harness.
 *
 * One operator-owned file, /data/mcp.json by default, using the `mcpServers` shape shared by
 * other MCP clients. Unlike pi's coding agent, this harness deliberately supports HTTP only:
 * a stdio server would be a child process beside the harness keys, and the workspace must not
 * be able to define one. The file is never read from the workspace or a project directory.
 */

import { readFile } from "node:fs/promises";

/** How the model reaches a server's tools. */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

export interface McpServerConfig {
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	/** What the server offers, in a sentence. Shown in `mcp_servers` and used by codemode. */
	readonly description?: string;
	/** Default: `deferred`. */
	readonly exposure?: McpExposure;
	/** Per-tool exposure overrides. Keys are exact tool names or `*` patterns. */
	readonly toolExposure?: Readonly<Record<string, McpExposure>>;
	/** Default: true. A disabled entry is kept, but not connected. */
	readonly enabled?: boolean;
	/** Per-request timeout in seconds. Default: 60. */
	readonly timeout?: number;
}

export interface McpServerEntry {
	readonly name: string;
	readonly config: McpServerConfig;
	readonly namespace: string;
}

export interface LoadedMcpConfig {
	readonly servers: readonly McpServerEntry[];
	readonly errors: readonly string[];
}

export class McpConfigError extends Error {
	readonly errors: readonly string[];

	constructor(errors: readonly string[]) {
		super(errors.join("\n"));
		this.name = "McpConfigError";
		this.errors = errors;
	}
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const MCP_EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];

/** Namespace of a server's tools: `mcp__<server>` with `-` replaced by `_`, like the tool names. */
export function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}`;
}

/** Regular expression for a tool name pattern where `*` matches any characters. */
function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^$\{}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/** Exposure of one tool: exact name, then the first matching pattern, then the server default. */
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	const overrides = config.toolExposure ?? {};
	const exact = overrides[toolName];
	if (exact !== undefined) return exact;
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	return config.exposure ?? "deferred";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExposure(value: unknown): value is McpExposure {
	return typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** Validate one server entry. Returns a copy with defaults normalized, or an error message. */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;

	if (raw.type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined || raw.cwd !== undefined) {
		return `server "${name}": stdio servers are not supported; use "url" with a streamable HTTP endpoint`;
	}
	if (raw.type !== undefined && raw.type !== "http" && raw.type !== "streamable-http") {
		return `server "${name}": type must be "http" or "streamable-http"`;
	}
	if (typeof raw.url !== "string" || !URL.canParse(raw.url) || !/^https?:$/.test(new URL(raw.url).protocol)) {
		return `server "${name}": url must be an http or https URL`;
	}
	if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
		return `server "${name}": headers must map names to strings`;
	}
	if (raw.description !== undefined && typeof raw.description !== "string") {
		return `server "${name}": description must be a string`;
	}
	if (raw.exposure !== undefined && !isExposure(raw.exposure)) {
		return `server "${name}": exposure must be one of ${MCP_EXPOSURES.map((value) => `"${value}"`).join(", ")}`;
	}
	if (raw.toolExposure !== undefined) {
		if (!isRecord(raw.toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, value] of Object.entries(raw.toolExposure)) {
			if (!isExposure(value)) {
				return `server "${name}": toolExposure "${tool}" must be one of ${MCP_EXPOSURES.map((entry) => `"${entry}"`).join(", ")}`;
			}
		}
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		return `server "${name}": enabled must be a boolean`;
	}
	if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0))) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}

	return {
		url: raw.url,
		...(raw.headers === undefined ? {} : { headers: raw.headers }),
		...(raw.description === undefined ? {} : { description: raw.description }),
		...(raw.exposure === undefined ? {} : { exposure: raw.exposure }),
		...(raw.toolExposure === undefined ? {} : { toolExposure: raw.toolExposure as Record<string, McpExposure> }),
		...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
		...(raw.timeout === undefined ? {} : { timeout: raw.timeout }),
	};
}

/** Whether any tool of the server is reached indirectly: loaded by `tool_search` or called from codemode. */
export function hasIndirectTools(config: McpServerConfig): boolean {
	const exposures = new Set<McpExposure>([config.exposure ?? "deferred"]);
	for (const exposure of Object.values(config.toolExposure ?? {})) exposures.add(exposure);
	return exposures.has("deferred") || exposures.has("codemode");
}

/** Load the operator's MCP file. A missing file is an empty configuration. */
export async function loadMcpConfig(path: string): Promise<LoadedMcpConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: [], errors: [] };
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		return { servers: [], errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		return { servers: [], errors: [`${path}: expected an object with an "mcpServers" object`] };
	}

	const servers: McpServerEntry[] = [];
	const errors: string[] = [];
	for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
		const config = validateMcpServerConfig(name, raw);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		const namespace = mcpNamespace(name);
		const clash = servers.find((server) => server.namespace === namespace);
		if (clash) {
			errors.push(`${path}: server "${name}" conflicts with "${clash.name}"`);
			continue;
		}
		servers.push({ name, config, namespace });
	}
	return { servers, errors };
}

/** Resolve `${NAME}` references in header values from the given environment. */
export function resolveHeaders(
	headers: Readonly<Record<string, string>> | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	const resolved: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		resolved[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
			const resolvedValue = env[variable];
			if (resolvedValue === undefined) throw new Error(`header "${name}" references missing environment variable ${variable}`);
			return resolvedValue;
		});
	}
	return resolved;
}
