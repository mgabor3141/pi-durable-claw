// Signing the harness in to an MCP server over OAuth (the MCP authorization spec). The flow is pi-mcp's: its auth
// provider sends and refreshes the token on a connection, and its sign-in runs in two halves, `startMcpSignIn` (the
// link) and `completeMcpSignIn` (the code exchange). It covers discovery (RFC 9728, then RFC 8414, or the configured
// `authServerMetadataUrl`), a pre-registered client or dynamic registration, PKCE, refresh, and step-up on
// `insufficient_scope`. This file is the harness's side: where the state lives, the settings, and which sign-in a
// redirect belongs to.
//
// The redirect comes back to the host itself (`<public URL>/host/oauth/callback`): the user's browser already reaches
// the host, since that is how they use T3. A browser that cannot (the redirect page fails to load) still shows the URL;
// pasted back to the agent, it completes the same way. The agent starts a sign-in with `mcp` and hands the user
// the link. Tokens are refreshed on their own and kept with the harness's secrets (`../secrets.ts`), never in the
// config, and are scrubbed from tool output like any secret.
import {
	completeMcpSignIn,
	createMcpAuthProvider,
	type McpOAuthClientOptions,
	type McpOAuthServerStore,
	type McpOAuthSettings,
	type McpOAuthState,
	type McpSignInRedirect,
	type OAuthChallenge,
	startMcpSignIn,
} from "@earendil-works/pi-mcp/oauth";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import type { McpServerConfig, SecretResolver } from "./config.ts";

/** Claude Code's `oauth` block. `clientSecret` is ours (Claude Code prompts for it): write it as a `${NAME}` secret. */
export interface McpOAuthConfig {
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly authServerMetadataUrl?: string;
	/** Space-separated, pinned for the authorization request. */
	readonly scopes?: string;
	/** Claude Code's loopback callback port. Unused here: the redirect URI is always the host's (`McpOAuth.redirectUrl`). */
	readonly callbackPort?: number;
}

/** Where a server's OAuth state lives: with the harness's secrets. */
export interface OAuthStateStore {
	oauthState(server: string): McpOAuthState | undefined;
	saveOAuthState(server: string, state: McpOAuthState | undefined): Promise<void>;
	oauthServers(): string[];
}

/** Whether `config` authenticates by OAuth: it does unless it sends its own `Authorization` header, as in Claude Code. */
export function usesOAuth(config: McpServerConfig): boolean {
	return !Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

/** Whether a connect failed because the server wants a sign-in (pi-mcp's errors, through any `cause` chain). */
export function needsSignIn(error: unknown): boolean {
	for (let current = error; current instanceof Error; current = current.cause) {
		if (current.name === "McpOAuthAuthorizationRequiredError" || current.name === "McpAuthRequiredError") return true;
	}
	return false;
}

export class McpOAuth {
	/** The redirect URI every sign-in uses; register it with a server that needs a pre-registered client. */
	readonly redirectUrl: string;
	readonly #store: OAuthStateStore;
	readonly #secrets: SecretResolver | undefined;
	/** Sign-ins waiting for their redirect, by `state`. Kept in memory: a restart ends them, and the user starts again. */
	readonly #pending = new Map<string, { readonly server: string; readonly authorization: McpSignInRedirect }>();
	/** The challenge each server last answered a request with: its resource metadata URL and scope apply to the sign-in. */
	readonly #challenges = new Map<string, OAuthChallenge>();
	/** The end of each server's last refresh, so refreshes of one server run one at a time. */
	readonly #refreshing = new Map<string, Promise<void>>();

	constructor(options: { redirectUrl: string; store: OAuthStateStore; secrets?: SecretResolver }) {
		this.redirectUrl = options.redirectUrl;
		this.#store = options.store;
		this.#secrets = options.secrets;
	}

	/** The transport's auth for `server` at `url` (its resolved URL): the stored token, refreshed before it expires and
	 * after a 401. It never opens a sign-in: a server that needs one fails the request (`needsSignIn`). */
	authProvider(server: string, url: string, config: McpServerConfig): AuthProvider {
		return createMcpAuthProvider({
			...this.#client(server, url),
			// Read when a refresh needs them, so a secret that was just entered is the one used.
			settings: () => this.#settings(config),
			onChallenge: (challenge) => void this.#challenges.set(server, challenge),
			redirectUrl: this.redirectUrl,
		});
	}

	/** Start a sign-in: the link to give the user, or `undefined` when the stored sign-in could be renewed without one. */
	async login(server: string, url: string, config: McpServerConfig): Promise<string | undefined> {
		const started = await startMcpSignIn(this.#signIn(server, url, config));
		if (started.kind === "authorized") return undefined;
		// A server has one sign-in at a time: pi-mcp keeps one `state` and verifier per server, so an older link is dead.
		for (const [state, pending] of this.#pending) if (pending.server === server) this.#pending.delete(state);
		this.#pending.set(started.state, { server, authorization: started });
		return started.authorizationUrl;
	}

	/** Finish a sign-in from the redirect's query (`code`, `state`, `iss`, or `error`). Answers the server it signed in. */
	async complete(params: URLSearchParams, find: (server: string) => { url: string; config: McpServerConfig } | undefined): Promise<string> {
		const state = params.get("state");
		const pending = state === null ? undefined : this.#pending.get(state);
		if (state === null || pending === undefined) throw new Error("This sign-in link is unknown or was already used. Start the sign-in again.");
		const { server, authorization } = pending;
		const error = params.get("error");
		if (error !== null) throw new Error(`${server}: the authorization server refused: ${params.get("error_description") ?? error}`);
		const code = params.get("code");
		if (code === null) throw new Error(`${server}: the redirect carries no code`);
		const entry = find(server);
		if (entry === undefined) throw new Error(`${server} is no longer configured`);
		const iss = params.get("iss");
		// One use: a code is exchanged once, so a replayed callback (a reloaded page) must not reach the exchange again.
		this.#pending.delete(state);
		await completeMcpSignIn({ ...this.#signIn(server, entry.url, entry.config), authorization, response: { code, state, ...(iss === null ? {} : { iss }) } });
		this.#challenges.delete(server);
		return server;
	}

	/** Forget a server's sign-in (tokens, registered client, discovery). */
	async logout(server: string): Promise<void> {
		for (const [state, pending] of this.#pending) if (pending.server === server) this.#pending.delete(state);
		this.#challenges.delete(server);
		await this.#store.saveOAuthState(server, undefined);
	}

	/** Both halves of a sign-in take the same options: the client, our redirect URI, and the server's last challenge. */
	#signIn(server: string, url: string, config: McpServerConfig) {
		const challenge = this.#challenges.get(server);
		return { ...this.#client(server, url), settings: this.#settings(config), redirectUrl: this.redirectUrl, ...(challenge === undefined ? {} : { challenge }) };
	}

	/** pi-mcp's OAuth client for one server, without its settings: its state among the harness's secrets, and our name. */
	#client(server: string, url: string): Omit<McpOAuthClientOptions, "settings"> {
		return { serverUrl: url, store: this.#serverStore(server), clientName: "claw" };
	}

	/** Claude Code's `oauth` block as pi-mcp's settings, with `${NAME}` secrets resolved. No client id: dynamic registration. */
	#settings(config: McpServerConfig): McpOAuthSettings {
		const oauth = oauthOf(config);
		return {
			...(oauth?.clientId === undefined ? {} : { clientId: this.#resolve(oauth.clientId) }),
			...(oauth?.clientSecret === undefined ? {} : { clientSecret: this.#resolve(oauth.clientSecret) }),
			...(oauth?.scopes === undefined ? {} : { scope: oauth.scopes }),
			...(oauth?.authServerMetadataUrl === undefined ? {} : { authServerMetadataUrl: new URL(this.#resolve(oauth.authServerMetadataUrl)) }),
		};
	}

	/** One server's state. Its refresh lock orders refreshes within this process, the only one that holds the store. */
	#serverStore(server: string): McpOAuthServerStore {
		return {
			load: () => this.#store.oauthState(server),
			save: (state) => this.#store.saveOAuthState(server, state),
			withRefreshLock: <T>(fn: () => Promise<T>): Promise<T> => {
				const run = (this.#refreshing.get(server) ?? Promise.resolve()).then(fn);
				this.#refreshing.set(server, run.then(() => undefined, () => undefined));
				return run;
			},
		};
	}

	#resolve(text: string): string {
		return this.#secrets === undefined ? text : this.#secrets.substitute(text).text;
	}
}

function oauthOf(config: McpServerConfig): McpOAuthConfig | undefined {
	return (config as { oauth?: McpOAuthConfig }).oauth;
}
