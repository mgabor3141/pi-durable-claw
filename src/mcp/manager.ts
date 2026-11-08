/**
 * Connection and registry manager for operator-configured HTTP MCP servers.
 *
 * The manager connects at startup, lists each server's tools, and installs one extension per
 * server. A failed server does not stop the harness: its tools are absent, and the manager keeps
 * reconnecting it in the background (a model cannot call a tool it was never shown, so waiting for a
 * call would wait forever). A server that drops is reconnected the same way. Scripts call the tools, which codemode's
 * listing leaves out: `searchTools()` finds them. The system prompt names the configured servers; the `mcp` tool says
 * which are connected and what is wrong.
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
import { GenerationTask, hook } from "@earendil-works/pi-durable";
import {
	getMcpToolExposure,
	hasCallableTools,
	parseMcpConfig,
	resolveConnection,
	type McpConfigSource,
	type McpServerEntry,
	type McpServerConfig,
	type SecretResolver,
} from "./config.ts";
import { MCP_TOOL_DESCRIPTION, mcpNeedsSecrets, mcpNeedsSignIn } from "../prompts.ts";
import { type McpOAuth, needsSignIn, usesOAuth } from "./oauth.ts";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { mcpServersSection, type McpServerSummary } from "./section.ts";
import { createMcpToolName, createMcpToolRegistration } from "./tools.ts";

export interface McpLogger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

export type McpTransportFactory = (server: McpServerEntry, config: McpServerConfig) => McpTransport;

export interface McpManagerOptions {
	/** The agent's `~/.mcp.json` (or, in tests, a local file): read at start and again whenever it changes. */
	readonly source: McpConfigSource;
	readonly logger?: McpLogger;
	/** Resolves `${NAME}` in a server's `url` and `headers`: the harness's secrets. */
	readonly secrets?: SecretResolver;
	/** OAuth sign-in for servers without an `Authorization` header (`oauth.ts`); absent, none signs in. */
	readonly oauth?: McpOAuth;
	/** Test seam; production uses `StreamableHttpTransport`. */
	readonly transportFactory?: McpTransportFactory;
	readonly connectTimeoutMs?: number;
	/** Waits before each reconnect attempt of a failed or dropped server; the last repeats. */
	readonly retryDelaysMs?: readonly number[];
	/** Namespaces that are not MCP servers', always listed first (the harness's own tool groups, such as `thread_`). */
	readonly baseNamespaces?: readonly CodemodeNamespace[];
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
	/** Set once the entry left the configuration (or changed): its callbacks change nothing more. */
	dropped?: boolean;
	/** The last connect was refused for want of a sign-in: no retries until one completes. */
	needsSignIn?: boolean;
	/** The per-server extension installed in the registry. */
	extension?: Extension;
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
	private started = false;
	/** The configuration's version as last read; problems in it, for the prompt section. */
	private version: string | undefined;
	private configErrors: string[] = [];
	private reloading: Promise<void> | undefined;
	/** The namespaces codemode sees: one array, updated in place, since codemode reads it at each use. */
	private readonly liveNamespaces: CodemodeNamespace[];

	constructor(options: McpManagerOptions) {
		this.options = options;
		this.liveNamespaces = [...(options.baseNamespaces ?? [])];
	}

	/** Read the configuration. A broken file or entry is reported (log, prompt section), never thrown. */
	async load(): Promise<void> {
		if (!this.loaded) await this.reload(true);
	}

	/**
	 * Read the configuration again if its version changed (or `force`), and apply the difference: a removed or changed
	 * server is closed and its tools uninstalled, a new one installed and (once started) connected. Concurrent calls
	 * share one read.
	 */
	reload(force = false): Promise<void> {
		this.reloading ??= (async () => {
			const version = await this.options.source.version().catch(() => undefined);
			if (!force && this.loaded && version === this.version) return;
			let text: string | undefined;
			try {
				text = await this.options.source.read();
			} catch (error) {
				this.configErrors = [`${this.options.source.describe}: ${error instanceof Error ? error.message : String(error)}`];
				this.options.logger?.warn("MCP configuration unreadable", { errors: this.configErrors });
				return;
			}
			this.version = version;
			this.loaded = true;
			const parsed = parseMcpConfig(text, this.options.source.describe);
			this.configErrors = [...parsed.errors];
			if (parsed.errors.length > 0) this.options.logger?.warn("MCP configuration has errors", { errors: parsed.errors });
			if (parsed.unreadable === true) return;
			await this.apply(parsed.servers, new Set(parsed.broken));
		})().finally(() => {
			this.reloading = undefined;
		});
		return this.reloading;
	}

	/** Check the configuration's version (one `stat`) and apply an edit; never throws into the generation. */
	private async recheck(): Promise<void> {
		if (this.closed) return;
		await this.reload().catch((error: unknown) => this.options.logger?.warn("MCP configuration check failed", { error: String(error) }));
	}

	/** Close `server`'s connection and connect again now (after a sign-in, or a sign-out). */
	async reconnect(server: string): Promise<void> {
		const state = this.states.get(server);
		if (state === undefined) return;
		if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
		state.retryTimer = undefined;
		await state.connecting?.catch(() => {});
		const client = state.client;
		state.client = undefined;
		state.transport = undefined;
		if (client !== undefined) await client.close().catch(() => {});
		state.retries = 0;
		await this.connect(server);
	}

	/** Finish an OAuth sign-in from the redirect's query (the host's callback route, or a pasted URL), then connect. */
	async completeSignIn(params: URLSearchParams): Promise<string> {
		const oauth = this.options.oauth;
		if (oauth === undefined) throw new Error("OAuth is not configured on this harness");
		const server = await oauth.complete(params, (name) => {
			const state = this.states.get(name);
			if (state === undefined) return undefined;
			const connection = resolveConnection(state.entry.config, this.options.secrets);
			return "missing" in connection ? undefined : { url: connection.url, config: state.entry.config };
		});
		this.options.logger?.info("MCP server signed in", { server });
		await this.reconnect(server);
		return server;
	}

	/** `mcp`: the servers' status; start a sign-in, finish one from a pasted URL, or sign out. */
	private tool() {
		return defineTool({
			name: "mcp",
			description: MCP_TOOL_DESCRIPTION,
			parameters: Type.Object({
				action: Type.Union([Type.Literal("status"), Type.Literal("login"), Type.Literal("complete"), Type.Literal("logout")]),
				server: Type.Optional(Type.String({ description: "The server's name in ~/.mcp.json (login, logout)" })),
				redirectUrl: Type.Optional(Type.String({ description: "The URL the user's browser ended on (complete)" })),
			}),
			callers: ["tools"],
			execute: async (args) => {
				const answer = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
				if (args.action === "status") return answer(await this.report());
				const oauth = this.options.oauth;
				if (oauth === undefined) throw new Error("OAuth sign-in is not configured on this harness");
				if (args.action === "complete") {
					if (args.redirectUrl === undefined || !URL.canParse(args.redirectUrl)) throw new Error("complete needs the full redirectUrl the browser ended on");
					const server = await this.completeSignIn(new URL(args.redirectUrl).searchParams);
					return answer({ server, ...this.status(server) });
				}
				const state = args.server === undefined ? undefined : this.states.get(args.server);
				if (state === undefined) throw new Error(`no MCP server named ${JSON.stringify(args.server)} in ~/.mcp.json`);
				if (!usesOAuth(state.entry.config)) throw new Error(`${state.entry.name} sends its own Authorization header; remove it to sign in by OAuth`);
				if (args.action === "logout") {
					await oauth.logout(state.entry.name);
					await this.reconnect(state.entry.name);
					return answer({ server: state.entry.name, signedOut: true, ...this.status(state.entry.name) });
				}
				const connection = resolveConnection(state.entry.config, this.options.secrets);
				if ("missing" in connection) throw new Error(`${state.entry.name}: ${mcpNeedsSecrets(connection.missing)}`);
				const link = await oauth.login(state.entry.name, connection.url, state.entry.config);
				this.options.logger?.info("MCP sign-in started", { server: state.entry.name });
				return answer({ server: state.entry.name, signInUrl: link, redirectUri: oauth.redirectUrl });
			},
		});
	}

	/** The secrets changed: servers whose config names one connect again with the new values. */
	async secretsChanged(): Promise<void> {
		if (!this.started) return;
		await Promise.all(
			[...this.states.values()]
				.filter((state) => enabled(state.entry.config) && /\$\{/.test(JSON.stringify([state.entry.config.url, state.entry.config.headers ?? {}])))
				.map(async (state) => {
					const client = state.client;
					state.client = undefined;
					state.transport = undefined;
					if (client !== undefined) await client.close().catch(() => {});
					state.retries = 0;
					await this.connect(state.entry.name);
				}),
		);
	}

	private async apply(entries: readonly McpServerEntry[], broken: ReadonlySet<string>): Promise<void> {
		const next = new Map(entries.map((entry) => [entry.name, entry]));
		for (const [name, state] of [...this.states]) {
			if (broken.has(name)) continue;
			const entry = next.get(name);
			if (entry !== undefined && JSON.stringify(entry) === JSON.stringify(state.entry)) continue;
			await this.drop(state);
		}
		for (const entry of entries) {
			if (this.states.has(entry.name)) continue;
			const state: McpState = { entry, tools: [], registeredNames: [], status: "idle", retries: 0 };
			this.states.set(entry.name, state);
			this.install(state);
			if (this.started && enabled(entry.config)) void this.connect(entry.name);
		}
		this.liveNamespaces.splice(0, this.liveNamespaces.length, ...(this.options.baseNamespaces ?? []), ...this.currentNamespaces());
	}

	/** A server that left the configuration: close it, stop retrying, uninstall its tools. */
	private async drop(state: McpState): Promise<void> {
		state.dropped = true;
		this.states.delete(state.entry.name);
		if (state.retryTimer !== undefined) clearTimeout(state.retryTimer);
		const client = state.client;
		state.client = undefined;
		if (client !== undefined) await client.close().catch(() => {});
		if (state.extension !== undefined) this.registry?.uninstall(state.extension);
		this.options.logger?.info("MCP server removed", { server: state.entry.name });
	}

	/** Namespaces for codemode's `describeNamespace()`: a live array, kept current as the configuration changes. */
	namespaces(): CodemodeNamespace[] {
		return this.liveNamespaces;
	}

	private currentNamespaces(): CodemodeNamespace[] {
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

	/** The `mcp-servers` prompt section (the configured servers), the `mcp` tool, and the hooks that notice an edit of the
	 * config: its version is checked after each round of tools (the agent edits it with them) and before each request (an
	 * edit from outside). An edit changes the tools scripts can call at once; the prompt shows it after a reload. */
	extension(): Extension {
		return defineExtension({
			name: "mcp-servers",
			sections: [section("mcp-servers", () => mcpServersSection(this.summaries()))],
			tools: [this.tool()],
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async () => {
						await this.recheck();
						return undefined;
					},
					afterTools: () => this.recheck(),
				}),
			],
		});
	}

	/** A server's connection state, and why it is not connected. */
	status(server: string): { status: McpState["status"]; error?: string } | undefined {
		const state = this.states.get(server);
		return state === undefined ? undefined : { status: state.status, ...(state.error === undefined ? {} : { error: state.error }) };
	}

	/** `mcp`'s status: the config read afresh, and each server once its connection attempt settled. */
	private async report() {
		await this.recheck();
		await Promise.all([...this.states.values()].map((state) => state.connecting?.catch(() => {})));
		return {
			config: this.options.source.describe,
			problems: this.problems(),
			servers: [...this.states.values()].map((state) => ({
				name: state.entry.name,
				namespace: state.entry.namespace,
				...(enabled(state.entry.config) ? { status: state.status } : { status: "disabled" }),
				...(state.error === undefined ? {} : { error: state.error }),
				tools: state.registeredNames.length,
			})),
		};
	}

	/** What the agent should know is wrong: config errors, and servers that failed to connect. */
	problems(): string[] {
		const failing = [...this.states.values()].filter((state) => enabled(state.entry.config) && state.status === "failed" && state.error !== undefined);
		return [...this.configErrors, ...failing.map((state) => `server "${state.entry.name}" is not connected: ${state.error}`)];
	}

	/** Give the manager the registry where per-server extensions are installed. */
	attach(registry: Registry): void {
		this.registry = registry;
		for (const state of this.states.values()) this.install(state);
	}

	/** Connect every enabled server. Failures are recorded and logged, not thrown. */
	async start(): Promise<void> {
		if (!this.loaded) await this.load();
		this.started = true;
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

	/** The configured servers scripts can call, as ~/.mcp.json describes them (connected or not). */
	private summaries(): McpServerSummary[] {
		return [...this.states.values()]
			.filter((state) => enabled(state.entry.config) && hasCallableTools(state.entry.config))
			.map((state) => ({
				name: state.entry.name,
				namespace: state.entry.namespace,
				...(state.entry.config.description === undefined ? {} : { description: state.entry.config.description }),
			}));
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
			// The secrets its url and headers name: a missing one is the server's error until it is saved, which reconnects it.
			const connection = resolveConnection(config, this.options.secrets);
			if ("missing" in connection) {
				state.status = "failed";
				state.error = mcpNeedsSecrets(connection.missing);
				this.options.logger?.warn("MCP server needs secrets", { server, missing: connection.missing });
				return;
			}
			try {
				const oauth = this.options.oauth !== undefined && usesOAuth(config) ? this.options.oauth.authProvider(server, connection.url, config) : undefined;
				transport =
					this.options.transportFactory?.(state.entry, { ...config, url: connection.url, ...(connection.headers === undefined ? {} : { headers: connection.headers }) }) ??
					new StreamableHttpTransport({
						url: connection.url,
						...(connection.headers === undefined ? {} : { headers: connection.headers }),
						...(oauth === undefined ? {} : { authProvider: oauth }),
					});
				client = new McpClient({
					name: "claw",
					version: CLIENT_VERSION,
					requestTimeoutMs: config.timeout ?? 60_000,
				});
				client.onError((error) => {
					this.options.logger?.warn("MCP client error", { server, error: error.message });
				});
				client.onClose(() => {
					if (state.client !== client || state.dropped === true) return;
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
				state.needsSignIn = false;
				this.options.logger?.info("MCP server connected", {
					server,
					tools: state.tools.length,
				});
				await this.refresh(state, client);
			} catch (error) {
				state.status = "failed";
				state.needsSignIn = this.options.oauth !== undefined && usesOAuth(config) && needsSignIn(error);
				state.error = state.needsSignIn ? mcpNeedsSignIn(server) : error instanceof Error ? error.message : String(error);
				state.client = undefined;
				state.transport = undefined;
				if (client !== undefined) await client.close().catch(() => {});
				else if (transport !== undefined) await transport.close().catch(() => {});
				this.options.logger?.warn(state.needsSignIn ? "MCP server needs a sign-in" : "MCP server failed", { server, error: state.error });
				// Retrying cannot help until the user signs in; the sign-in reconnects.
				if (!state.needsSignIn) this.retryLater(state);
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
			const tools = await client.listTools({ timeoutMs: state.entry.config.timeout ?? 60_000 });
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
					timeoutMs: state.entry.config.timeout ?? 60_000,
					getClient: () => this.clientFor(state.entry.name),
				})),
			);
		}
		state.registeredNames = names;
		if (state.extension !== undefined) this.registry.uninstall(state.extension);
		state.extension = defineExtension({ name: `mcp:${state.entry.name}`, tools });
		this.registry.install(state.extension);
		this.options.logger?.info("MCP extension installed", {
			server: state.entry.name,
			tools: tools.length,
		});
	}
}
