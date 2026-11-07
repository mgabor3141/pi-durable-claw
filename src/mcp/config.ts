/**
 * MCP server configuration for the claw harness: the agent's own `~/.mcp.json` in the workspace, in Claude Code's
 * `.mcp.json` format (`mcpServers`, `"type": "http"`, `url`, `headers`, `timeout` in milliseconds, `alwaysLoad`), so a
 * config copied from a server's documentation works. HTTP only: a stdio server would be a child process beside the
 * harness, and servers run as their own containers. `${NAME}` (and `${NAME:-default}`) in `url` and `headers` name the
 * harness's secrets (`../secrets.ts`), resolved when the server connects. Our own extensions: `exposure`,
 * `toolExposure`, `description`, `enabled`.
 */

import { readFile, stat } from "node:fs/promises";
import type { McpOAuthConfig } from "./oauth.ts";

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
	/** Per-request timeout in milliseconds, as Claude Code's. Default: 60000. */
	readonly timeout?: number;
	/** Claude Code's `oauth` block (`oauth.ts`). A server with no `Authorization` header signs in by OAuth when asked. */
	readonly oauth?: McpOAuthConfig;
}

/** Where the configuration is read from: `version` changes whenever its content may have. */
export interface McpConfigSource {
	/** For messages: the file's path. */
	readonly describe: string;
	version(): Promise<string | undefined>;
	/** The text, or `undefined` when there is no file (an empty configuration). */
	read(): Promise<string | undefined>;
}

type FileResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
/** The part of the workspace's file API a source needs (`RemoteExecutionEnv`). */
export interface WorkspaceFiles {
	fileInfo(path: string, context: never): Promise<FileResult<{ mtimeMs: number; size: number }>>;
	readTextFile(path: string, context: never): Promise<FileResult<string>>;
}

/** The agent's file in the workspace, read over the workspace connection: no file is an empty configuration. */
export function workspaceSource(files: WorkspaceFiles, path: string, context: unknown): McpConfigSource {
	return {
		describe: path,
		version: async () => {
			const info = await files.fileInfo(path, context as never);
			return info.ok ? `${info.value.mtimeMs}:${info.value.size}` : undefined;
		},
		read: async () => {
			const text = await files.readTextFile(path, context as never);
			if (text.ok) return text.value;
			if (text.error.code === "not_found") return undefined;
			throw new Error(text.error.message);
		},
	};
}

/** A configuration file on this machine. */
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

export interface McpServerEntry {
	readonly name: string;
	readonly config: McpServerConfig;
	readonly namespace: string;
}

export interface LoadedMcpConfig {
	readonly servers: readonly McpServerEntry[];
	readonly errors: readonly string[];
	/** The file could not be parsed at all: keep the configuration that was running. */
	readonly unreadable?: boolean;
	/** Entries with errors: each keeps the version that was running, so a typo does not take a server down. */
	readonly broken?: readonly string[];
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

	if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined || raw.cwd !== undefined || raw.type === "stdio") {
		return `server "${name}": stdio servers are not supported here; use "type": "http" with a streamable HTTP "url"`;
	}
	if (raw.type === "sse" || raw.type === "ws") return `server "${name}": the ${raw.type} transport is not supported; use "type": "http" with the streamable HTTP URL`;
	if (raw.type === undefined && raw.url !== undefined) return `server "${name}" has a "url" but no "type"; add "type": "http"`;
	if (raw.type !== "http" && raw.type !== "streamable-http") return `server "${name}": type must be "http" or "streamable-http"`;
	// A placeholder may stand for any part of the URL; it is checked again once resolved.
	const shape = typeof raw.url === "string" ? raw.url.replace(/\$\{[A-Z][A-Z0-9_]*(?::-[^}]*)?\}/g, "x") : undefined;
	if (shape === undefined || !URL.canParse(shape) || !/^https?:$/.test(new URL(shape).protocol)) {
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
		return `server "${name}": timeout must be a positive number of milliseconds`;
	}
	if (raw.alwaysLoad !== undefined && typeof raw.alwaysLoad !== "boolean") {
		return `server "${name}": alwaysLoad must be a boolean`;
	}
	if (raw.oauth !== undefined) {
		if (!isRecord(raw.oauth)) return `server "${name}": oauth must be an object`;
		for (const field of ["clientId", "clientSecret", "authServerMetadataUrl", "scopes"]) {
			if (raw.oauth[field] !== undefined && typeof raw.oauth[field] !== "string") return `server "${name}": oauth.${field} must be a string`;
		}
		if (raw.oauth.callbackPort !== undefined && typeof raw.oauth.callbackPort !== "number") return `server "${name}": oauth.callbackPort must be a number`;
		const unknown = Object.keys(raw.oauth).filter((field) => !["clientId", "clientSecret", "authServerMetadataUrl", "scopes", "callbackPort"].includes(field));
		if (unknown.length > 0) return `server "${name}": unknown oauth field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`;
	}

	return {
		url: raw.url as string,
		...(raw.headers === undefined ? {} : { headers: raw.headers }),
		...(raw.description === undefined ? {} : { description: raw.description }),
		// Claude Code's `alwaysLoad`: the tools are in every request, which is `direct` here.
		...(raw.exposure !== undefined ? { exposure: raw.exposure } : raw.alwaysLoad === true ? { exposure: "direct" as const } : {}),
		...(raw.toolExposure === undefined ? {} : { toolExposure: raw.toolExposure as Record<string, McpExposure> }),
		...(raw.enabled === undefined ? {} : { enabled: raw.enabled }),
		...(raw.timeout === undefined ? {} : { timeout: raw.timeout }),
		...(raw.oauth === undefined ? {} : { oauth: raw.oauth as McpOAuthConfig }),
	};
}

/** Whether any tool of the server is reached indirectly: loaded by `tool_search` or called from codemode. */
export function hasIndirectTools(config: McpServerConfig): boolean {
	const exposures = new Set<McpExposure>([config.exposure ?? "deferred"]);
	for (const exposure of Object.values(config.toolExposure ?? {})) exposures.add(exposure);
	return exposures.has("deferred") || exposures.has("codemode");
}

/** Parse a configuration file's text (`origin` names it in messages). A broken entry is an error; the others load. */
export function parseMcpConfig(text: string | undefined, origin: string): LoadedMcpConfig {
	if (text === undefined || text.trim() === "") return { servers: [], errors: [] };
	const path = origin;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		return { servers: [], errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`], unreadable: true };
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		return { servers: [], errors: [`${path}: expected an object with an "mcpServers" object`], unreadable: true };
	}

	const servers: McpServerEntry[] = [];
	const errors: string[] = [];
	const broken: string[] = [];
	for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
		const config = validateMcpServerConfig(name, raw);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			broken.push(name);
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
	return { servers, errors, ...(broken.length === 0 ? {} : { broken }) };
}

/** What resolves `${NAME}`: the harness's secrets. */
export interface SecretResolver {
	substitute(text: string): { text: string; used: string[]; missing: string[] };
}

/** The server's URL and headers with its secrets resolved, or the secrets it names that do not exist. */
export function resolveConnection(config: McpServerConfig, secrets: SecretResolver | undefined): { url: string; headers?: Record<string, string> } | { missing: string[] } {
	const missing = new Set<string>();
	const resolve = (text: string) => {
		if (secrets === undefined) return text;
		const result = secrets.substitute(text);
		for (const name of result.missing) missing.add(name);
		return result.text;
	};
	const url = resolve(config.url);
	const headers = config.headers === undefined ? undefined : Object.fromEntries(Object.entries(config.headers).map(([name, value]) => [name, resolve(value)]));
	if (missing.size > 0) return { missing: [...missing] };
	return { url, ...(headers === undefined ? {} : { headers }) };
}
