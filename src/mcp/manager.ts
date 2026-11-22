/**
 * Connection and registry manager for operator-configured HTTP MCP servers.
 *
 * The manager connects at startup, lists each server's tools, and installs one extension per
 * server. A failed server does not stop the harness: its tools are absent, and the manager keeps
 * reconnecting it in the background (a model cannot call a tool it was never shown, so waiting for a
 * call would wait forever). A server that drops is reconnected the same way. Scripts call the tools, which codemode's
 * listing leaves out: `searchTools()` finds them. The system prompt names the configured servers; the `mcp` tool says
 * which are connected and what is wrong.
 *
 * Over HTTP a server that went away is not noticed until it is asked: it is connected from its `initialize` on, and what
 * it forgot since shows in its next answer. A server that restarted no longer knows the session, and one whose sign-in
 * ended no longer accepts it: the call (or the `mcp` tool's status) that finds out connects again (`refusedBy`).
 */

import type { CallToolResult, McpRequestOptions, McpTransport, Tool as McpTool } from "@earendil-works/pi-mcp";
import { McpClient, McpError, McpSessionExpiredError, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
	defineExtension,
	section,
	type Extension,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
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
import { abortable } from "@mgabor3141/pi-durable-t3";
import { mcpServersSection, type McpServerSummary } from "./section.ts";
import { createMcpToolName, createMcpToolRegistration } from "./tools.ts";
import { opt, str, union } from "@earendil-works/pi-schema";
import { literal, object } from "../schema.ts";

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
	/** Applied to every tool registration the manager installs (the harness resolves and scrubs secrets with it). */
	readonly wrapTool?: (tool: ToolRegistration) => ToolRegistration;
}

type McpState = {
	readonly entry: McpServerEntry;
	client?: McpClient;
	tools: McpTool[];
	registeredNames: string[];
	status: "idle" | "connecting" | "connected" | "failed" | "disconnected";
	error?: string;
	connecting?: Promise<void>;
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
/** How long `mcp`'s status waits for a connected server's sign of life. */
const PING_TIMEOUT_MS = 5_000;
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

	constructor(options: McpManagerOptions) {
		this.options = options;
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
		if (client !== undefined) await client.close().catch(() => {});
		// It may have left the configuration meanwhile.
		if (state.dropped === true) return;
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
			parameters: object({
				action: union([literal("status"), literal("login"), literal("complete"), literal("logout")]),
				server: opt(str({ description: "The server's name in ~/.mcp.json (login, logout)" })),
				redirectUrl: opt(str({ description: "The URL the user's browser ended on (complete)" })),
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
				const link = await oauth.login(state.entry.name, connection.url, state.entry.config, state.needsSignIn === true);
				if (link === undefined) {
					// The stored sign-in was renewed (its refresh token still works): there is nothing for the user to do.
					this.options.logger?.info("MCP sign-in renewed", { server: state.entry.name });
					await this.reconnect(state.entry.name);
					return answer({ server: state.entry.name, signedIn: true, ...this.status(state.entry.name) });
				}
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
				.map((state) => this.reconnect(state.entry.name)),
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

	/** The `mcp-servers` prompt section (the configured servers), the `mcp` tool, and the hooks that notice an edit of the
	 * config: its version is checked after each round of tools (the agent edits it with them) and before each request (an
	 * edit from outside). An edit changes the tools scripts can call at once; the prompt shows it after a reload. */
	extension(): Extension {
		return defineExtension({
			name: "mcp-servers",
			sections: [section("mcp-servers", () => mcpServersSection(this.summaries()))],
			// Status and sign-in may wait on a server; Stop does not.
			tools: [abortable(this.tool())],
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async () => {
						await this.recheck();
						return undefined;
					},
					afterTools: async () => {
						await this.recheck();
						return undefined;
					},
				}),
			],
		});
	}

	/** A server's connection state, and why it is not connected. */
	status(server: string): { status: McpState["status"]; error?: string } | undefined {
		const state = this.states.get(server);
		return state === undefined ? undefined : { status: state.status, ...(state.error === undefined ? {} : { error: state.error }) };
	}

	/** `mcp`'s status: the config read afresh, and each server once its connection attempt settled and, if it is
	 * connected, it was asked for a sign of life. */
	private async report() {
		await this.recheck();
		// What a connected server that gave no sign of life answered instead.
		const silent = new Map<McpState, string>();
		await Promise.all(
			[...this.states.values()].map(async (state) => {
				await state.connecting?.catch(() => {});
				const error = await this.silence(state);
				if (error !== undefined) silent.set(state, error);
			}),
		);
		return {
			config: this.options.source.describe,
			problems: [...this.problems(), ...[...silent].map(([state, error]) => `server "${state.entry.name}" does not answer: ${error}`)],
			servers: [...this.states.values()].map((state) => {
				const error = silent.get(state) ?? state.error;
				return {
					name: state.entry.name,
					namespace: state.entry.namespace,
					status: !enabled(state.entry.config) ? "disabled" : silent.has(state) ? "unreachable" : state.status,
					...(error === undefined ? {} : { error }),
					tools: state.registeredNames.length,
				};
			}),
		};
	}

	/**
	 * Ask a connected server for a sign of life, and answer why there was none. Over HTTP a server is "connected" from its
	 * last `initialize` on, whatever became of it since: nothing tells the harness that it went away. One that no longer
	 * knows the session or the sign-in is connected again (`refusedBy`), which also lists the tools it has now. Any other
	 * silence changes nothing: the server may only be slow, and calls may be in flight on the connection.
	 */
	private async silence(state: McpState): Promise<string | undefined> {
		const client = state.client;
		if (client === undefined || client.connectionState !== "connected") return undefined;
		try {
			await client.ping({ timeoutMs: PING_TIMEOUT_MS });
			return undefined;
		} catch (error) {
			// Any answer is a sign of life, also the refusal of a server that knows no ping.
			if (error instanceof McpError) return undefined;
			if (this.refusedBy(state, client, error)) {
				await this.connect(state.entry.name);
				return undefined;
			}
			// The connection may have been made again meanwhile, which is then what the status tells.
			return state.client === client ? (error instanceof Error ? error.message : String(error)) : undefined;
		}
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
				state.status = "idle";
				if (client !== undefined) await client.close().catch(() => {});
			}),
		);
	}

	/** A callable client, reconnecting first when the server dropped. */
	private async clientFor(server: string): Promise<McpClient> {
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

	/**
	 * Call one tool through its server, connecting first when it is not connected. A server that refused the call before
	 * running it, for a reason a new connection answers (`refusedBy`), is connected again and called once more. A
	 * `timeoutMs` in `options` is at most the entry's `timeout`: a connection that was given up is closed after that long.
	 */
	async callTool(
		server: string,
		tool: string,
		args: Record<string, unknown>,
		options?: McpRequestOptions,
	): Promise<CallToolResult> {
		for (let attempt = 1; ; attempt++) {
			const client = await this.clientFor(server);
			try {
				return await client.callTool(tool, args, options);
			} catch (error) {
				const state = this.states.get(server);
				if (state === undefined) throw error;
				// The connection is good, and this call needs a sign-in: the server asks for more scope for the tool, or it
				// refused the call again on a connection it had just accepted.
				if (this.asksSignIn(state.entry.config, error) && (attempt > 1 || this.options.oauth?.wantsScope(server) === true)) {
					throw new Error(`MCP server "${server}" refused the call: ${mcpNeedsSignIn(server)}`, { cause: error });
				}
				if (attempt > 1 || !this.refusedBy(state, client, error)) throw error;
			}
		}
	}

	/**
	 * Whether `error` is the server's refusal of a request it did not run, for a reason a new connection answers. If so,
	 * the connection the request was made on is given up, and the caller makes it again.
	 * - The server no longer knows the session: it restarted, and a session lives in the server's memory. The MCP spec has
	 *   the client begin a new one.
	 * - It no longer accepts the sign-in: the new connection is refused for that, which is the server's state from then on
	 *   (`connect`), with how to sign in.
	 */
	private refusedBy(state: McpState, client: McpClient, error: unknown): boolean {
		const session = error instanceof McpSessionExpiredError;
		if (!session && !this.asksSignIn(state.entry.config, error)) return false;
		// Unless another request's refusal has given it up meanwhile.
		if (state.client !== client) return true;
		// The client is given up, and closed only once every request on it can have settled (each is bounded by the
		// entry's `timeout`). Closing it now would fail the others in flight on it: those the server refuses as it did this
		// one come here too, and those it accepted before (a sign-in can end while a call runs) are being run, and their
		// answers still arrive. Never closed, it would keep a stream the server gave it, and take that up again with the
		// next sign-in's token.
		state.client = undefined;
		setTimeout(() => void client.close().catch(() => {}), state.entry.config.timeout ?? 60_000).unref?.();
		if (session) this.options.logger?.info("MCP server no longer knows the session", { server: state.entry.name });
		return true;
	}

	/** Whether `error` is a server asking for a sign-in, which a server of this `config` does by OAuth. */
	private asksSignIn(config: McpServerConfig, error: unknown): boolean {
		return this.options.oauth !== undefined && usesOAuth(config) && needsSignIn(error);
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
					state.status = "disconnected";
					this.options.logger?.warn("MCP server disconnected", { server });
					this.retryLater(state);
				});

				await withTimeout(
					client.connect(transport),
					this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
					`MCP server "${server}" did not connect`,
				);
				// The server left the configuration (or the manager closed) while this connected: nothing will use this client.
				if (state.dropped === true || this.closed) {
					await client.close().catch(() => {});
					return;
				}
				state.client = client;
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
				state.needsSignIn = this.asksSignIn(config, error);
				state.error = state.needsSignIn ? mcpNeedsSignIn(server) : error instanceof Error ? error.message : String(error);
				state.client = undefined;
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

	/** Try a failed or dropped server again after the next delay, unless the manager is closing, the server left the
	 * configuration, or a try is pending. */
	private retryLater(state: McpState): void {
		if (this.closed || state.dropped === true || state.retryTimer !== undefined || !enabled(state.entry.config)) return;
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
			state.error = undefined;
			state.status = "connected";
			this.options.logger?.info("MCP tools loaded", { server: state.entry.name, tools: tools.length });
		} catch (error) {
			state.error = error instanceof Error ? error.message : String(error);
			this.options.logger?.warn("MCP tool listing failed", { server: state.entry.name, error: state.error });
		}
		// Removed while it listed: drop() may already have uninstalled the extension before the listing failed.
		if (state.dropped !== true) this.install(state);
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
					timeoutMs: state.entry.config.timeout ?? 60_000,
					call: (args, options) => this.callTool(state.entry.name, tool.name, args, options),
				})),
			);
		}
		state.registeredNames = names;
		if (state.extension !== undefined) this.registry.uninstall(state.extension);
		// The server is its tools' namespace for codemode's `describeNamespace()` and `searchTools()`, also before it has any.
		state.extension = defineExtension({ name: `mcp:${state.entry.name}`, namespace: { name: state.entry.namespace, description: state.entry.config.description ?? "" }, tools });
		this.registry.install(state.extension);
		this.options.logger?.info("MCP extension installed", {
			server: state.entry.name,
			tools: tools.length,
		});
	}
}
