// Signing the harness in to an MCP server over OAuth (the MCP authorization spec), on pi-mcp's client flow: discovery
// (RFC 9728, then RFC 8414, or the configured `authServerMetadataUrl`), a pre-registered client, a Client ID Metadata
// Document or dynamic registration, PKCE, refresh, and step-up on `insufficient_scope`.
//
// The redirect comes back to the host itself (`<public URL>/host/oauth/callback`): the user's browser already reaches
// the host, since that is how they use T3. A browser that cannot (the redirect page fails to load) still shows the URL;
// pasted back to the agent, it completes the same way. The agent starts a sign-in with `mcp_auth` and hands the user
// the link. Tokens are refreshed on their own and kept with the harness's secrets (`../secrets.ts`), never in the
// config, and are scrubbed from tool output like any secret.
import {
	authorizeMcp,
	McpOAuthProvider,
	type McpOAuthState,
	parseWwwAuthenticate,
	stepUpScope,
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
	/** The authorization URL each server's flow last produced, by server. */
	readonly #links = new Map<string, string>();

	constructor(options: { redirectUrl: string; store: OAuthStateStore; secrets?: SecretResolver }) {
		this.redirectUrl = options.redirectUrl;
		this.#store = options.store;
		this.#secrets = options.secrets;
	}

	/** The transport's auth for `server` at `url` (its resolved URL): the stored token, refreshed after a 401. Like
	 * pi-mcp's `adaptOAuthProvider`, but with the configured metadata URL and scopes on every authorization. */
	authProvider(server: string, url: string, config: McpServerConfig): AuthProvider {
		const provider = this.#provider(server, url, config);
		const oauth = oauthOf(config);
		let inFlight: Promise<void> | undefined;
		return {
			token: async () => (await provider.tokens())?.access_token,
			onUnauthorized: async (context) => {
				const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
				const insufficientScope = challenge.error === "insufficient_scope";
				if (!insufficientScope && inFlight === undefined && context.token !== undefined) {
					const current = (await provider.tokens())?.access_token;
					if (current !== undefined && current !== context.token) return;
				}
				inFlight ??= (async () => {
					const granted = insufficientScope ? await provider.tokens() : undefined;
					const result = await authorizeMcp(provider, {
						serverUrl: context.serverUrl,
						...(challenge.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
						...this.#flowOptions(oauth),
						...(oauth?.scopes === undefined ? { scope: insufficientScope ? stepUpScope(granted?.scope, challenge.scope) : challenge.scope } : {}),
						fetch: context.fetch,
						skipRefresh: insufficientScope,
					} as never);
					if (result === "REDIRECT") throw Object.assign(new Error("the server needs a sign-in"), { name: "McpOAuthAuthorizationRequiredError" });
				})().finally(() => {
					inFlight = undefined;
				});
				await inFlight;
			},
		};
	}

	/** Start a sign-in: the link to give the user. */
	async login(server: string, url: string, config: McpServerConfig): Promise<string> {
		const provider = this.#provider(server, url, config);
		const result = await authorizeMcp(provider, { serverUrl: url, ...this.#flowOptions(oauthOf(config)), skipRefresh: true } as never);
		const link = this.#links.get(server);
		if (result !== "REDIRECT" || link === undefined) throw new Error(`${server}: the authorization server did not ask for a sign-in`);
		return link;
	}

	/** The server a callback's `state` belongs to. */
	serverForState(state: string): string | undefined {
		return this.#store.oauthServers().find((server) => this.#store.oauthState(server)?.oauthState === state);
	}

	/** Finish a sign-in from the redirect's query (`code`, `state`, `iss`, or `error`). Answers the server it signed in. */
	async complete(params: URLSearchParams, find: (server: string) => { url: string; config: McpServerConfig } | undefined): Promise<string> {
		const state = params.get("state");
		const server = state === null ? undefined : this.serverForState(state);
		if (server === undefined) throw new Error("This sign-in link is unknown or was already used. Start the sign-in again.");
		const error = params.get("error");
		if (error !== null) throw new Error(`${server}: the authorization server refused: ${params.get("error_description") ?? error}`);
		const code = params.get("code");
		if (code === null) throw new Error(`${server}: the redirect carries no code`);
		const entry = find(server);
		if (entry === undefined) throw new Error(`${server} is no longer configured`);
		const iss = params.get("iss");
		const oauth = oauthOf(entry.config);
		const result = await authorizeMcp(this.#provider(server, entry.url, entry.config), {
			serverUrl: entry.url,
			authorizationCode: code,
			...(iss === null ? {} : { iss }),
			...this.#flowOptions(oauth),
		} as never);
		if (result !== "AUTHORIZED") throw new Error(`${server}: the code exchange did not authorize`);
		// One use: the provider keeps `state` and the verifier for the next authorization, so a replayed callback (a
		// reloaded page) would find this server, fail with `invalid_grant`, and pi-mcp would then drop the new tokens.
		const stored = this.#store.oauthState(server);
		if (stored !== undefined) {
			const { oauthState: _state, codeVerifier: _verifier, ...rest } = stored;
			await this.#store.saveOAuthState(server, rest);
		}
		return server;
	}

	/** Forget a server's sign-in (tokens, registered client, discovery). */
	async logout(server: string): Promise<void> {
		this.#links.delete(server);
		await this.#store.saveOAuthState(server, undefined);
	}

	#flowOptions(oauth: McpOAuthConfig | undefined) {
		return {
			...(oauth?.scopes === undefined ? {} : { scope: oauth.scopes }),
			...(oauth?.authServerMetadataUrl === undefined ? {} : { authorizationServerMetadataUrl: new URL(this.#resolve(oauth.authServerMetadataUrl)) }),
		};
	}

	#resolve(text: string): string {
		return this.#secrets === undefined ? text : this.#secrets.substitute(text).text;
	}

	#provider(server: string, url: string, config: McpServerConfig): McpOAuthProvider {
		const oauth = oauthOf(config);
		const store = this.#store;
		return new McpOAuthProvider({
			serverUrl: url,
			redirectUrl: this.redirectUrl,
			clientMetadata: { client_name: "claw", ...(oauth?.scopes === undefined ? {} : { scope: oauth.scopes }) },
			...(oauth?.clientId === undefined ? {} : { clientId: this.#resolve(oauth.clientId) }),
			...(oauth?.clientSecret === undefined ? {} : { clientSecret: this.#resolve(oauth.clientSecret) }),
			store: { load: () => store.oauthState(server), save: (state) => store.saveOAuthState(server, state) },
			onRedirect: (link) => {
				this.#links.set(server, link.toString());
			},
		});
	}
}

function oauthOf(config: McpServerConfig): McpOAuthConfig | undefined {
	return (config as { oauth?: McpOAuthConfig }).oauth;
}
