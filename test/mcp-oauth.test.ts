// OAuth sign-in to an MCP server, end to end against a fake that is both the MCP server and its authorization server:
// the first connect reports a sign-in, mcp's login answers the link, the redirect's code is exchanged (discovery, dynamic
// registration, PKCE), the server connects, an expired token is refreshed by itself, and tokens are scrubbed. A login
// that can renew the stored sign-in needs no link, and a newer link replaces an older one.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { fileSource } from "../src/mcp/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { McpOAuth } from "../src/mcp/oauth.ts";
import { SecretStore } from "../src/secrets.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const body = (request: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let text = "";
		request.on("data", (chunk) => (text += chunk));
		request.on("end", () => resolve(text));
	});
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** The fake: an MCP endpoint at /mcp that wants a bearer token, and the authorization server that issues it. */
async function fakeServer() {
	let base = "";
	const codes = new Map<string, { challenge: string; redirect: string }>();
	const fake = { registered: 0, valid: new Set<string>(), issued: 0, refreshed: 0 };
	const server: Server = createServer(async (request, response) => {
		const url = new URL(request.url!, base);
		const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
			response.writeHead(status, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify(value));
		};
		const issue = () => {
			fake.issued += 1;
			const access = `access-token-${fake.issued}-abcdef`;
			fake.valid.add(access);
			json(200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: `refresh-token-${fake.issued}-abcdef` });
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
			return json(201, { ...JSON.parse(await body(request)), client_id: "client-1" });
		}
		if (url.pathname === "/authorize") {
			const code = `code-${codes.size + 1}`;
			codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")! });
			const back = new URL(url.searchParams.get("redirect_uri")!);
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state")!);
			response.writeHead(302, { location: back.toString() });
			return response.end();
		}
		if (url.pathname === "/token") {
			const form = new URLSearchParams(await body(request));
			if (form.get("grant_type") === "authorization_code") {
				const grant = codes.get(form.get("code")!);
				codes.delete(form.get("code")!);
				if (grant === undefined || s256(form.get("code_verifier")!) !== grant.challenge || form.get("redirect_uri") !== grant.redirect) return json(400, { error: "invalid_grant" });
				return issue();
			}
			fake.refreshed += 1;
			return issue();
		}
		if (url.pathname === "/mcp") {
			const token = request.headers.authorization?.replace(/^Bearer /, "");
			if (token === undefined || !fake.valid.has(token)) {
				response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
				return response.end();
			}
			if (request.method !== "POST") {
				response.writeHead(405);
				return response.end();
			}
			const message = JSON.parse(await body(request)) as { id?: number; method: string };
			if (message.id === undefined) {
				response.writeHead(202);
				return response.end();
			}
			const result =
				message.method === "initialize"
					? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
					: message.method === "tools/list"
						? { tools: [{ name: "whoami", inputSchema: { type: "object", properties: {} } }] }
						: { content: [{ type: "text", text: `you hold ${token}` }] };
			return json(200, { jsonrpc: "2.0", id: message.id, result });
		}
		json(404, {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
	return { base, fake };
}

it("signs in through mcp, connects, refreshes by itself, and keeps tokens out of output", async () => {
	const { base, fake } = await fakeServer();
	const dir = await mkdtemp(join(tmpdir(), "pdc-oauth-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	await writeFile(config, JSON.stringify({ mcpServers: { docs: { type: "http", url: `${base}/mcp` } } }));
	const secrets = new SecretStore(join(dir, "secrets.json"));
	const oauth = new McpOAuth({ redirectUrl: "http://127.0.0.1:4999/host/oauth/callback", store: secrets, secrets });
	const manager = new McpManager({ source: fileSource(config), secrets, oauth, connectTimeoutMs: 5000 });
	cleanup.push(() => manager.close());
	await manager.load();
	const registry = createRegistry();
	manager.attach(registry);
	await manager.start();

	expect(manager.status("docs")).toMatchObject({ status: "failed" });
	expect(manager.problems()).toEqual([expect.stringContaining('call mcp({ action: "login", server: "docs" })')]);

	const tool = manager.extension().tools!.find((candidate) => candidate.name === "mcp")!;
	const run = async (args: unknown) => JSON.parse(((await tool.execute(args as never, {} as never, {} as never)) as { output: { text: string }[] }).output[0]!.text);
	const login = await run({ action: "login", server: "docs" });
	expect(login.redirectUri).toBe("http://127.0.0.1:4999/host/oauth/callback");
	expect(new URL(login.signInUrl).origin).toBe(base);
	expect(fake.registered, "dynamic registration, once").toBe(1);

	// The user approves; their browser is sent to the host's callback with the code.
	const approved = await fetch(login.signInUrl, { redirect: "manual" });
	const callback = new URL(approved.headers.get("location")!);
	expect(callback.pathname).toBe("/host/oauth/callback");
	await expect(manager.completeSignIn(new URLSearchParams({ code: "x", state: "forged" }))).rejects.toThrow("unknown or was already used");
	expect(await manager.completeSignIn(callback.searchParams)).toBe("docs");
	expect(manager.status("docs")).toEqual({ status: "connected" });
	expect(registry.snapshot().extension("mcp:docs")?.tools?.map((registered) => registered.name)).toEqual(["mcp__docs__whoami"]);
	await expect(manager.completeSignIn(callback.searchParams), "a reloaded callback page changes nothing").rejects.toThrow("unknown or was already used");
	expect(manager.status("docs")).toEqual({ status: "connected" });

	// The token is kept with the secrets and scrubbed like one.
	const first = await manager.callTool("docs", "whoami", {});
	const text = (first.content[0] as { text: string }).text;
	expect(text).toBe("you hold access-token-1-abcdef");
	expect(secrets.scrub(text)).toBe("you hold [docs OAuth credential]");

	// The server drops the token: the next call refreshes it and goes through.
	fake.valid.clear();
	const second = await manager.callTool("docs", "whoami", {});
	expect((second.content[0] as { text: string }).text).toBe("you hold access-token-2-abcdef");
	expect(fake.refreshed).toBe(1);

	// A login while the stored sign-in can still be renewed: it is renewed, and there is no link to give anyone.
	fake.valid.clear();
	expect(await run({ action: "login", server: "docs" })).toEqual({ server: "docs", signedIn: true, status: "connected" });
	expect(fake.refreshed).toBe(2);
	expect(fake.registered, "the registered client is kept").toBe(1);

	// A pasted redirect works the same way (here, after a sign-out). A server has one sign-in at a time: the link of
	// an earlier login is dead once a later one is made.
	expect(await run({ action: "logout", server: "docs" })).toMatchObject({ signedOut: true, status: "failed" });
	const stale = await run({ action: "login", server: "docs" });
	const again = await run({ action: "login", server: "docs" });
	const stalePasted = (await fetch(stale.signInUrl, { redirect: "manual" })).headers.get("location")!;
	await expect(run({ action: "complete", redirectUrl: stalePasted })).rejects.toThrow("unknown or was already used");
	const pasted = (await fetch(again.signInUrl, { redirect: "manual" })).headers.get("location")!;
	expect(await run({ action: "complete", redirectUrl: pasted })).toEqual({ server: "docs", status: "connected" });
});

it("a server with its own Authorization header does not sign in", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdc-oauth-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	await writeFile(config, JSON.stringify({ mcpServers: { docs: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer x" } } } }));
	const secrets = new SecretStore(join(dir, "secrets.json"));
	const manager = new McpManager({ source: fileSource(config), oauth: new McpOAuth({ redirectUrl: "http://h/host/oauth/callback", store: secrets }), connectTimeoutMs: 500, retryDelaysMs: [60_000] });
	cleanup.push(() => manager.close());
	await manager.load();
	const tool = manager.extension().tools!.find((candidate) => candidate.name === "mcp")!;
	await expect(tool.execute({ action: "login", server: "docs" } as never, {} as never, {} as never)).rejects.toThrow("sends its own Authorization header");
});
