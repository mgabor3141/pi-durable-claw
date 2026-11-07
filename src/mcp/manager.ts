/**
 * Connection and registry manager for operator-configured HTTP MCP servers.
 *
 * The manager connects at startup, lists each server's tools, and installs one extension per
 * server. A failed server does not stop the harness: its tools are absent, and the manager keeps
 * reconnecting it in the background (a model cannot call a tool it was never shown, so waiting for a
 * call would wait forever). A server that drops is reconnected the same way. Tools are exposed as deferred model tools by default, so `tool_search` loads
 * them for direct use, while codemode scripts can call them at any time.
 */

import type { CallToolResult, McpRequestOptions, McpTransport, Tool as McpTool } from "@earendil-works/pi-mcp";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
	defineExtension,
	section,
	type Extension,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import {
	getMcpToolExposure,
	hasIndirectTools,
	loadMcpConfig,
	resolveHeaders,
	McpConfigError,
	type McpServerEntry,
	type McpServerConfig,
} from "./config.ts";
import { mcpServersSection, type McpReach, type McpServerSummary } from "./section.ts";
import { createMcpToolName, createMcpToolRegistration } from "./tools.ts";

export interface McpLogger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

export type McpTransportFactory = (server: McpServerEntry, config: McpServerConfig) => McpTransport;

export interface McpManagerOptions {
	readonly configPath: string;
	readonly logger?: McpLogger;
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Test seam; production uses `StreamableHttpTransport`. */
	readonly transportFactory?: McpTransportFactory;
	readonly connectTimeoutMs?: number;
	/** Waits before each reconnect attempt of a failed or dropped server; the last repeats. */
	readonly retryDelaysMs?: readonly number[];
	/** Applied to every tool registration the manager installs (the harness resolves and scrubs secrets with it). */
	readonly wrapTool?: (tool: ToolRegistration) => ToolRegistration;
}

type McpState = {
	readonly entry: McpServerEntry;
	client?: McpClient;
	transport?: McpTransport;
	tools: McpTool[];
	registeredNames: string[];
	status: "idle" | "connecting" | "connected" | "failed" | "disconnected";
	error?: string;
	connecting?: Promise<void>;
	instructions?: string;
	/** Reconnect attempts since the last success, and the pending one. */
	retries: number;
	retryTimer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];
const CLIENT_VERSION = "1.0.0";

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function firstLine(text: string | undefined): string | undefined {
	const line = text?.trim().split("\n", 1)[0]?.trim();
	return line === undefined || line.length === 0 ? undefined : line;
}

/** Whether a server is enabled. */
function enabled(config: McpServerConfig): boolean {
	return config.enabled !== false;
}

export class McpManager {
	readonly options: McpManagerOptions;
	private readonly states = new Map<string, McpState>();
	private registry?: Registry;
	private loaded = false;
	private closed = false;

	constructor(options: McpManagerOptions) {
		this.options = options;
	}

	/** Read the configuration. Throws McpConfigError when any entry is invalid. */
	async load(): Promise<void> {
		if (this.loaded) return;
		const loaded = await loadMcpConfig(this.options.configPath);
		if (loaded.errors.length > 0) throw new McpConfigError(loaded.errors);
		for (const entry of loaded.servers) {
			this.states.set(entry.name, { entry, tools: [], registeredNames: [], status: "idle", retries: 0 });
		}
		this.loaded = true;
	}

	/** Namespaces for codemode's `describeNamespace()`, built from the operator's entries. */
	namespaces(): CodemodeNamespace[] {
		return [...this.states.values()]
			.filter((state) => enabled(state.entry.config))
			.map((state) => ({
				name: state.entry.namespace,
				prefix: `${state.entry.namespace}__`,
				...(state.entry.config.description === undefined
					? {}
					: { description: state.entry.config.description }),
			}));
	}

	/** Whether the model needs `tool_search` for any configured server. */
	hasIndirectTools(): boolean {
		return [...this.states.values()].some(
			(state) => enabled(state.entry.config) && hasIndirectTools(state.entry.config),
		);
	}

	/** The `mcp_servers` prompt section. Its content follows the manager's current state. */
	extension(): Extension {
		return defineExtension({
			name: "mcp-servers",
			sections: [section("mcp-servers", () => mcpServersSection(this.summaries()))],
		});
	}

	/** Give the manager the registry where per-server extensions are installed. */
	attach(registry: Registry): void {
		this.registry = registry;
		for (const state of this.states.values()) this.install(state);
	}

	/** Connect every enabled server. Failures are recorded and logged, not thrown. */
	async start(): Promise<void> {
		if (!this.loaded) await this.load();
		await Promise.all(
			[...this.states.values()]
				.filter((state) => enabled(state.entry.config))
				.map((state) => this.connect(state.entry.name)),
		);
	}

	/** Close every client and stop reconnecting. */
	async close(): Promise<void> {
		this.closed = true;
		for (const state of this.states.values()) {
			if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
			state.retryTimer = undefined;
		}
		await Promise.all(
			[...this.states.values()].map(async (state) => {
				const client = state.client;
				state.client = undefined;
				state.transport = undefined;
				state.status = "idle";
				if (client !== undefined) await client.close().catch(() => {});
			}),
		);
	}

	/** A callable client, reconnecting first when the server dropped. */
	async clientFor(server: string): Promise<McpClient> {
		const state = this.states.get(server);
		if (state === undefined) throw new Error(`unknown MCP server "${server}"`);
		if (!enabled(state.entry.config)) throw new Error(`MCP server "${server}" is disabled`);
		const current = state.client;
		if (current !== undefined && current.connectionState === "connected") return current;
		await this.connect(server);
		const connected: McpClient | undefined = state.client;
		if (connected === undefined || connected.connectionState !== "connected") {
			throw new Error(`MCP server "${server}" is not connected${state.error ? `: ${state.error}` : ""}`);
		}
		return connected;
	}

	/** Call one tool through its server, reconnecting if necessary. */
	async callTool(
		server: string,
		tool: string,
		args: Record<string, unknown>,
		options?: McpRequestOptions,
	): Promise<CallToolResult> {
		const client = await this.clientFor(server);
		return client.callTool(tool, args, options);
	}

	private summaries(): McpServerSummary[] {
		const result: McpServerSummary[] = [];
		for (const state of this.states.values()) {
			if (!enabled(state.entry.config)) continue;
			const reaches = this.reaches(state);
			if (reaches.length === 0) continue;
			result.push({
				name: state.entry.name,
				namespace: state.entry.namespace,
				description: state.entry.config.description ?? firstLine(state.instructions),
				reaches,
			});
		}
		return result;
	}

	private reaches(state: McpState): McpReach[] {
		const exposures = new Set(
			state.tools.length > 0
				? state.tools.map((tool) => getMcpToolExposure(state.entry.config, tool.name))
				: [state.entry.config.exposure ?? "deferred", ...Object.values(state.entry.config.toolExposure ?? {})],
		);
		const reaches: McpReach[] = [];
		if (exposures.has("deferred")) reaches.push("tool_search");
		if (exposures.has("codemode")) reaches.push("codemode");
		return reaches;
	}

	private async connect(server: string): Promise<void> {
		const state = this.states.get(server);
		if (state === undefined) throw new Error(`unknown MCP server "${server}"`);
		if (!enabled(state.entry.config)) return;
		if (state.client?.connectionState === "connected") return;
		if (state.connecting !== undefined) return state.connecting;

		state.connecting = (async () => {
			state.status = "connecting";
			state.error = undefined;
			const config = state.entry.config;
			let transport: McpTransport | undefined;
			let client: McpClient | undefined;
			try {
				const resolvedHeaders = resolveHeaders(config.headers, this.options.env ?? process.env);
				transport =
					this.options.transportFactory?.(state.entry, config) ??
					new StreamableHttpTransport({
						url: config.url,
						...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
					});
				client = new McpClient({
					name: "claw",
					version: CLIENT_VERSION,
					requestTimeoutMs: (config.timeout ?? 60) * 1000,
				});
				client.onError((error) => {
					this.options.logger?.warn("MCP client error", { server, error: error.message });
				});
				client.onClose(() => {
					if (state.client !== client) return;
					state.client = undefined;
					state.transport = undefined;
					state.status = "disconnected";
					this.options.logger?.warn("MCP server disconnected", { server });
					this.retryLater(state);
				});

				await withTimeout(
					client.connect(transport),
					this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
					`MCP server "${server}" did not connect`,
				);
				state.client = client;
				state.transport = transport;
				state.instructions = client.instructions;
				state.status = "connected";
				state.retries = 0;
				this.options.logger?.info("MCP server connected", {
					server,
					tools: state.tools.length,
				});
				await this.refresh(state, client);
			} catch (error) {
				state.status = "failed";
				state.error = error instanceof Error ? error.message : String(error);
				state.client = undefined;
				state.transport = undefined;
				if (client !== undefined) await client.close().catch(() => {});
				else if (transport !== undefined) await transport.close().catch(() => {});
				this.options.logger?.warn("MCP server failed", { server, error: state.error });
				this.retryLater(state);
			}
		})().finally(() => {
			state.connecting = undefined;
		});

		return state.connecting;
	}

	/** Try a failed or dropped server again after the next delay, unless the manager is closing or a try is pending. */
	private retryLater(state: McpState): void {
		if (this.closed || state.retryTimer !== undefined || !enabled(state.entry.config)) return;
		const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
		const delay = delays[Math.min(state.retries, delays.length - 1)] ?? DEFAULT_RETRY_DELAYS_MS[0]!;
		state.retries += 1;
		state.retryTimer = setTimeout(() => {
			state.retryTimer = undefined;
			if (!this.closed) void this.connect(state.entry.name);
		}, delay);
		state.retryTimer.unref?.();
	}

	private async refresh(state: McpState, client: McpClient): Promise<void> {
		try {
			const tools = await client.listTools({ timeoutMs: (state.entry.config.timeout ?? 60) * 1000 });
			state.tools = tools;
			state.instructions = client.instructions;
			state.error = undefined;
			state.status = "connected";
			this.options.logger?.info("MCP tools loaded", { server: state.entry.name, tools: tools.length });
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			this.options.logger?.warn("MCP tool listing failed", { server: state.entry.name, error: state.error });
		}
		this.install(state);
	}

	/** Install (or replace) the server's extension and its tool registrations. */
	private install(state: McpState): void {
		if (this.registry === undefined) return;
		if (!enabled(state.entry.config)) return;

		const used = new Set<string>();
		for (const other of this.states.values()) {
			if (other === state) continue;
			for (const name of other.registeredNames) used.add(name);
		}

		const tools: ToolRegistration[] = [];
		const names: string[] = [];
		for (const tool of state.tools) {
			const exposure = getMcpToolExposure(state.entry.config, tool.name);
			if (exposure === "hidden") continue;
			const name = createMcpToolName(state.entry.name, tool.name, (candidate) => used.has(candidate));
			used.add(name);
			names.push(name);
			const wrap = this.options.wrapTool ?? ((registration: ToolRegistration) => registration);
			tools.push(
				wrap(createMcpToolRegistration({
					server: state.entry.name,
					tool,
					name,
					exposure,
					timeoutMs: (state.entry.config.timeout ?? 60) * 1000,
					getClient: () => this.clientFor(state.entry.name),
				})),
			);
		}
		state.registeredNames = names;
		this.registry.install(
			defineExtension({
				name: `mcp:${state.entry.name}`,
				tools,
			}),
		);
		this.options.logger?.info("MCP extension installed", {
			server: state.entry.name,
			tools: tools.length,
		});
	}
}
