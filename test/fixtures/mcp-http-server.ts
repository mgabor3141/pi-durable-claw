// A fake that is both an MCP server (Streamable HTTP at /mcp) and its authorization server, for the tests that connect
// over real HTTP. It keeps its sessions, tokens and registered clients in memory, as most servers do, so a test can
// make it forget each: a restarted server knows no session, an expired sign-in is a token it no longer accepts, and a
// client it no longer knows gets an error page at /authorize, not a redirect.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const body = (request: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let text = "";
		request.on("data", (chunk) => (text += chunk));
		request.on("end", () => resolve(text));
	});
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export interface FakeMcpServer {
	/** Its origin: the MCP endpoint is `${base}/mcp`. */
	readonly base: string;
	readonly fake: {
		/** Dynamic registrations made, and the client ids it still knows. */
		registered: number;
		readonly clients: Set<string>;
		/** The access tokens it accepts, and how many it issued and refreshed. */
		readonly valid: Set<string>;
		issued: number;
		refreshed: number;
		/** The sessions it knows, how many it began, and the ones a client ended (DELETE), known or not. */
		readonly sessions: Set<string>;
		initialized: number;
		readonly ended: string[];
		/** How many requests a session answers after `initialize` before the server forgets it. */
		sessionLife: number;
		/** The tools it lists, the calls it ran, and what it does only for a token of more scope: a tool, or `initialize`. */
		tools: string[];
		calls: number;
		readonly needScope: Set<string>;
		/** Whether anyone may connect and list the tools: a token is asked for a call alone. */
		openConnect: boolean;
		/** What the next call waits for before the server looks at it (a request that is slow to arrive). */
		nextCallAfter: Promise<void> | undefined;
		/** The pings that reached it, whether it answers them (a server need not know `ping`), and what an answer waits for first. */
		pings: number;
		knowsPing: boolean;
		pingAfter: Promise<void>;
		/** Whether its token endpoint is out of order (a 503 for every grant). */
		tokensDown: boolean;
		/** The notifications a session sent it. */
		readonly notified: string[];
		/** Forget every session, as a server that restarted has; `tools` are what it lists from then on. */
		restart(tools?: string[]): void;
	};
	close(): Promise<void>;
}

/** Start the fake. `refreshTokens: false` issues access tokens alone and refuses the refresh grant, as T3's server does. */
export async function fakeMcpServer(options: { refreshTokens?: boolean } = {}): Promise<FakeMcpServer> {
	const refreshTokens = options.refreshTokens ?? true;
	let base = "";
	const codes = new Map<string, { challenge: string; redirect: string }>();
	const left = new Map<string, number>();
	const fake: FakeMcpServer["fake"] = {
		registered: 0,
		clients: new Set(),
		valid: new Set(),
		issued: 0,
		refreshed: 0,
		sessions: new Set(),
		initialized: 0,
		ended: [],
		sessionLife: Number.POSITIVE_INFINITY,
		tools: ["whoami"],
		calls: 0,
		needScope: new Set(),
		openConnect: false,
		nextCallAfter: undefined,
		pings: 0,
		knowsPing: true,
		pingAfter: Promise.resolve(),
		tokensDown: false,
		notified: [],
		restart(tools) {
			fake.sessions.clear();
			if (tools !== undefined) fake.tools = tools;
		},
	};
	const server: Server = createServer(async (request, response) => {
		const url = new URL(request.url!, base);
		const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
			response.writeHead(status, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify(value));
		};
		const empty = (status: number, headers: Record<string, string> = {}) => {
			response.writeHead(status, headers);
			response.end();
		};
		const issue = () => {
			fake.issued += 1;
			const access = `access-token-${fake.issued}-abcdef`;
			fake.valid.add(access);
			json(200, { access_token: access, token_type: "Bearer", expires_in: 3600, ...(refreshTokens ? { refresh_token: `refresh-token-${fake.issued}-abcdef` } : {}) });
		};
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
		if (url.pathname === "/.well-known/oauth-authorization-server")
			return json(200, {
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				registration_endpoint: `${base}/register`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
			});
		if (url.pathname === "/register") {
			fake.registered += 1;
			const clientId = `client-${fake.registered}`;
			fake.clients.add(clientId);
			return json(201, { ...JSON.parse(await body(request)), client_id: clientId });
		}
		if (url.pathname === "/authorize") {
			// A client it does not know is told to the user on a page: nothing goes back to the client.
			if (!fake.clients.has(url.searchParams.get("client_id") ?? "")) return json(400, { page: "This sign-in link names an unknown app." });
			const code = `code-${codes.size + 1}`;
			codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")! });
			const back = new URL(url.searchParams.get("redirect_uri")!);
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state")!);
			return empty(302, { location: back.toString() });
		}
		if (url.pathname === "/token") {
			const form = new URLSearchParams(await body(request));
			if (fake.tokensDown) return json(503, {});
			if (form.get("grant_type") === "authorization_code") {
				const grant = codes.get(form.get("code")!);
				codes.delete(form.get("code")!);
				if (grant === undefined || s256(form.get("code_verifier")!) !== grant.challenge || form.get("redirect_uri") !== grant.redirect) return json(400, { error: "invalid_grant" });
				return issue();
			}
			if (!refreshTokens) return json(400, { error: "unsupported_grant_type", error_description: "Only authorization_code is supported." });
			fake.refreshed += 1;
			return issue();
		}
		if (url.pathname === "/mcp") {
			const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
			const token = request.headers.authorization?.replace(/^Bearer /, "");
			const signedIn = token !== undefined && fake.valid.has(token);
			if (request.method === "DELETE") fake.ended.push(String(request.headers["mcp-session-id"]));
			if (!signedIn && !fake.openConnect) return empty(401, { "www-authenticate": challenge });
			if (request.method !== "POST") return empty(405);
			const message = JSON.parse(await body(request)) as { id?: number; method: string; params?: { name?: string } };
			const answer = (result: unknown, headers: Record<string, string> = {}) => json(200, { jsonrpc: "2.0", id: message.id, result }, headers);
			const moreScope = () => empty(403, { "www-authenticate": `${challenge}, error="insufficient_scope", scope="admin"` });
			if (message.method === "initialize") {
				if (fake.needScope.has("initialize")) return moreScope();
				fake.initialized += 1;
				const session = `session-${fake.initialized}`;
				fake.sessions.add(session);
				left.set(session, fake.sessionLife);
				return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }, { "mcp-session-id": session });
			}
			if (message.method === "tools/call" && fake.nextCallAfter !== undefined) {
				const arrived = fake.nextCallAfter;
				fake.nextCallAfter = undefined;
				await arrived;
			}
			// The MCP spec's answers: 400 without a session id, 404 for one the server does not know (any more).
			const session = request.headers["mcp-session-id"];
			if (typeof session !== "string") return empty(400);
			const remaining = left.get(session) ?? 0;
			if (!fake.sessions.has(session) || remaining <= 0) return empty(404);
			left.set(session, remaining - 1);
			if (message.id === undefined) {
				fake.notified.push(message.method);
				return empty(202);
			}
			if (message.method === "ping") {
				fake.pings += 1;
				await fake.pingAfter;
				return fake.knowsPing ? answer({}) : json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found: ping" } });
			}
			if (message.method === "tools/list") return answer({ tools: fake.tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) });
			if (!signedIn) return empty(401, { "www-authenticate": challenge });
			if (fake.needScope.has(message.params?.name ?? "")) return moreScope();
			fake.calls += 1;
			return answer({ content: [{ type: "text", text: `you hold ${token}` }], structuredContent: { tool: message.params?.name, session } });
		}
		json(404, {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		base,
		fake,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				// A client that was given up without being closed may hold a connection open.
				server.closeAllConnections();
			}),
	};
}
