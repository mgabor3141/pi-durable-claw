// What an MCP server forgets while the harness is connected to it, and how a call gets it back, over real HTTP against
// the fake (`fixtures/mcp-http-server.ts`). A server that restarted knows no session: the call that finds out connects
// again and is made once more, as the MCP spec asks of a client. A server that no longer accepts the sign-in is told
// to the agent as that, with what to do, in the call's error and in the status.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { fileSource } from "./fixtures/mcp-config.ts";
import { type FakeMcpServer, fakeMcpServer } from "./fixtures/mcp-http-server.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { McpOAuth } from "../src/mcp/oauth.ts";
import { SecretStore } from "../src/secrets.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const TOKEN = "st4tic-token-abcdef";

async function until(what: string, check: () => boolean): Promise<void> {
	for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(check(), what).toBe(true);
}

/** A manager connected to the fake with a token of its own in the config (no sign-in): `docs`, with the fake's tools. */
async function connected() {
	const server = await fakeMcpServer();
	cleanup.push(server.close);
	server.fake.valid.add(TOKEN);
	const dir = await mkdtemp(join(tmpdir(), "pdc-reconnect-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	await writeFile(config, JSON.stringify({ mcpServers: { docs: { type: "http", url: `${server.base}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } } } }));
	const logged: string[] = [];
	const manager = new McpManager({
		source: fileSource(config),
		// OAuth is on, as in the harness: it is not for a server that sends its own Authorization header.
		oauth: new McpOAuth({ redirectUrl: "http://127.0.0.1:4999/host/oauth/callback", store: new SecretStore(join(dir, "secrets.json")) }),
		connectTimeoutMs: 5000,
		retryDelaysMs: [60_000],
		logger: { info: (message) => void logged.push(message), warn: (message) => void logged.push(message) },
	});
	cleanup.push(() => manager.close());
	await manager.load();
	const registry = createRegistry();
	manager.attach(registry);
	await manager.start();
	expect(manager.status("docs")).toEqual({ status: "connected" });
	const tools = () => registry.snapshot().extension("mcp:docs")?.tools ?? [];
	/** A call as a script makes it: through the registered tool. */
	const run = async (name: string) => {
		const tool = tools().find((candidate) => candidate.name === `mcp__docs__${name}`)!;
		return (await tool.execute({} as never, {} as never, {} as never)) as { structuredOutput: { structuredContent: { tool: string; session: string } } };
	};
	return { ...server, manager, tools, run, logged, status: () => statusOf(manager) };
}

/** `mcp`'s status. */
async function statusOf(manager: McpManager) {
	const tool = manager.extension().tools!.find((candidate) => candidate.name === "mcp")!;
	const result = (await tool.execute({ action: "status" } as never, {} as never, {} as never)) as { output: { text: string }[] };
	return JSON.parse(result.output[0]!.text) as { problems: string[]; servers: { name: string; namespace: string; status: string; error?: string; tools: number }[] };
}

it("a server that restarted is connected again by the call that finds out, which is then made once", async () => {
	const { fake, manager, tools, run, logged } = await connected();
	expect((await run("whoami")).structuredOutput.structuredContent).toEqual({ tool: "whoami", session: "session-1" });

	// The server restarts: it knows no session any more, and lists another tool.
	fake.restart(["whoami", "added"]);
	expect((await run("whoami")).structuredOutput.structuredContent).toEqual({ tool: "whoami", session: "session-2" });
	expect(fake.calls, "the refused call did not run, and was made once").toBe(2);
	expect(fake.initialized).toBe(2);
	expect(manager.status("docs")).toEqual({ status: "connected" });
	expect(tools().map((tool) => tool.name), "the new connection's tools").toEqual(["mcp__docs__whoami", "mcp__docs__added"]);

	// Several calls that find out at once share one new session.
	fake.restart();
	const answers = await Promise.all([run("whoami"), run("added"), manager.callTool("docs", "whoami", {})]);
	expect(answers.map((answer) => ("structuredOutput" in answer ? answer.structuredOutput.structuredContent : answer.structuredContent)).map((content) => (content as { session: string }).session)).toEqual(["session-3", "session-3", "session-3"]);
	expect(fake.initialized).toBe(3);
	expect(fake.calls).toBe(5);
	// A call that reaches the server after the others were refused and answered: it is made again on the connection
	// they made, which it leaves as it is.
	let arrive!: () => void;
	fake.nextCallAfter = new Promise((resolve) => (arrive = resolve));
	const late = run("whoami");
	await new Promise((resolve) => setTimeout(resolve, 50));
	fake.restart();
	expect((await run("added")).structuredOutput.structuredContent.session).toBe("session-4");
	arrive();
	expect((await late).structuredOutput.structuredContent.session).toBe("session-4");
	expect(fake.initialized).toBe(4);
	// A client whose session is gone is not closed while calls may be in flight on it, which that would have failed.
	expect(fake.ended).toEqual([]);
	expect(logged.filter((line) => line === "MCP server no longer knows the session"), "logged once for each restart").toHaveLength(3);
});

it("a call that is stopped is cancelled at the server, and not made again", async () => {
	const { fake, tools } = await connected();
	let arrive!: () => void;
	fake.nextCallAfter = new Promise((resolve) => (arrive = resolve));
	const stop = new AbortController();
	const call = tools()[0]!.execute({} as never, {} as never, { abortSignal: stop.signal } as never);
	await until("the call is with the server", () => fake.nextCallAfter === undefined);
	stop.abort(new Error("stopped"));
	await expect(call).rejects.toThrow("stopped");
	await until("the server is told", () => fake.notified.includes("notifications/cancelled"));
	arrive();
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(fake.initialized).toBe(1);
	expect(fake.calls).toBe(1);
});

it("a server that refuses the token its config gives is not asked to sign in: the call's error is the server's", async () => {
	const { fake, manager, run } = await connected();
	fake.valid.clear();
	await expect(run("whoami")).rejects.toThrow("MCP server requires authentication");
	expect(fake.initialized, "no new connection").toBe(1);
	expect(manager.status("docs")).toEqual({ status: "connected" });
});

it("a server that forgets the new session too has that told, after one new connection", async () => {
	const { fake, manager, run } = await connected();
	// Each session answers the two requests of a connect, and is gone before a call.
	fake.sessionLife = 2;
	fake.restart();
	await expect(run("whoami")).rejects.toThrow("MCP session expired");
	expect(fake.initialized, "the first connection, and one more").toBe(2);
	expect(fake.calls).toBe(0);
	// The server is as before again: the next call connects.
	fake.sessionLife = Number.POSITIVE_INFINITY;
	expect((await run("whoami")).structuredOutput.structuredContent).toEqual({ tool: "whoami", session: "session-3" });
	expect(manager.status("docs")).toEqual({ status: "connected" });
});

it("mcp's status asks each connected server: one that restarted is connected again, and one that does not answer is told", async () => {
	const { fake, manager, tools, status, close } = await connected();
	expect(await status()).toEqual({ config: expect.any(String), problems: [], servers: [{ name: "docs", namespace: "mcp__docs", status: "connected", tools: 1 }] });
	expect(fake.initialized, "a server that answers is left as it is").toBe(1);

	// It restarted with another tool, and no call has found out: the status does, so the tools scripts find are the new ones.
	fake.restart(["whoami", "added"]);
	expect(await status()).toMatchObject({ problems: [], servers: [{ name: "docs", status: "connected", tools: 2 }] });
	expect(fake.initialized).toBe(2);
	expect(tools().map((tool) => tool.name)).toEqual(["mcp__docs__whoami", "mcp__docs__added"]);

	// It is down. Nothing over HTTP says so until it is asked; the connection is left alone, for the call that reaches it.
	await close();
	const down = await status();
	expect(down.servers).toEqual([{ name: "docs", namespace: "mcp__docs", status: "unreachable", error: expect.stringContaining("fetch failed"), tools: 2 }]);
	expect(down.problems).toEqual([expect.stringMatching(/^server "docs" does not answer: .*fetch failed/)]);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(manager.status("docs")).toEqual({ status: "connected" });
	expect(tools()).toHaveLength(2);
});

it("mcp's status takes any answer for a sign of life, and tells of the connection as it is when the answer is in", async () => {
	const { fake, manager, status } = await connected();
	// A server need not know `ping`: its refusal is an answer.
	fake.knowsPing = false;
	expect(await status()).toMatchObject({ problems: [], servers: [{ name: "docs", status: "connected" }] });
	expect(fake.pings).toBe(1);

	// The connection is made again while the answer is waited for (a secret changed, say), which closes the one that was
	// asked: that is no silence of the server.
	let answer!: () => void;
	fake.pingAfter = new Promise((resolve) => (answer = resolve));
	const asked = status();
	await until("the ping is with the server", () => fake.pings === 2);
	await manager.reconnect("docs");
	answer();
	const told = await asked;
	expect(told.problems).toEqual([]);
	expect(told.servers[0]!.status).not.toBe("unreachable");
	expect(manager.status("docs")).toEqual({ status: "connected" });
});

const NEEDS_SIGN_IN = 'it needs a sign-in: call mcp({ action: "login", server: "docs" }) and give the user the link';

/** A manager with OAuth and the fake, where a sign-in is an access token alone (no refresh token) unless asked, as
 * T3's is. `timeout` is the server's in the config: how long a request may take. */
async function withOAuth(options: { prepare?: (fake: FakeMcpServer["fake"]) => void; refreshTokens?: boolean; timeout?: number } = {}) {
	const server = await fakeMcpServer({ refreshTokens: options.refreshTokens ?? false });
	cleanup.push(server.close);
	options.prepare?.(server.fake);
	const dir = await mkdtemp(join(tmpdir(), "pdc-reconnect-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	const config = join(dir, "mcp.json");
	await writeFile(config, JSON.stringify({ mcpServers: { docs: { type: "http", url: `${server.base}/mcp`, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) } } }));
	const secrets = new SecretStore(join(dir, "secrets.json"));
	const oauth = new McpOAuth({ redirectUrl: "http://127.0.0.1:4999/host/oauth/callback", store: secrets, secrets });
	const manager = new McpManager({ source: fileSource(config), secrets, oauth, connectTimeoutMs: 5000, retryDelaysMs: [60_000] });
	cleanup.push(() => manager.close());
	await manager.load();
	manager.attach(createRegistry());
	await manager.start();
	const tool = manager.extension().tools!.find((candidate) => candidate.name === "mcp")!;
	const mcp = async (args: unknown) => JSON.parse(((await tool.execute(args as never, {} as never, {} as never)) as { output: { text: string }[] }).output[0]!.text);
	/** The user opens the link and approves: the server sends the browser back with a code, or shows a page. */
	const approve = async (signInUrl: string) => {
		const approved = await fetch(signInUrl, { redirect: "manual" });
		if (approved.status !== 302) throw new Error(`the sign-in page says: ${JSON.stringify(await approved.json())}`);
		return manager.completeSignIn(new URL(approved.headers.get("location")!).searchParams);
	};
	const whoami = async () => ((await manager.callTool("docs", "whoami", {})).content[0] as { text: string }).text;
	return { ...server, manager, secrets, mcp, approve, whoami };
}

/** The same, signed in. */
async function signedIn(options: { tools?: string[]; refreshTokens?: boolean; timeout?: number } = {}) {
	const setup = await withOAuth({ ...options, prepare: (fake) => void (fake.tools = options.tools ?? ["whoami"]) });
	await setup.approve((await setup.mcp({ action: "login", server: "docs" })).signInUrl);
	expect(setup.manager.status("docs")).toEqual({ status: "connected" });
	expect(await setup.whoami()).toBe("you hold access-token-1-abcdef");
	return setup;
}

it("a sign-in the server no longer accepts is told with what to do, and the next sign-in starts from nothing", async () => {
	const { fake, manager, mcp, approve, whoami } = await signedIn();
	// The sign-in ends (T3's lasts 30 days, or the user revoked it), and nothing renews it.
	fake.valid.clear();
	await expect(whoami()).rejects.toThrow(`MCP server "docs" is not connected: ${NEEDS_SIGN_IN}`);
	expect(manager.status("docs")).toEqual({ status: "failed", error: NEEDS_SIGN_IN });
	expect(manager.problems()).toEqual([`server "docs" is not connected: ${NEEDS_SIGN_IN}`]);
	expect((await mcp({ action: "status" })).servers).toEqual([{ name: "docs", namespace: "mcp__docs", status: "failed", error: NEEDS_SIGN_IN, tools: 1 }]);
	await expect(whoami(), "a later call says the same").rejects.toThrow(NEEDS_SIGN_IN);
	expect(fake.calls).toBe(1);

	// The server has forgotten the client it registered as well, and would say so to the user on its page: the sign-in
	// after a refusal registers again.
	fake.clients.clear();
	const login = await mcp({ action: "login", server: "docs" });
	expect(fake.registered).toBe(2);
	expect(await approve(login.signInUrl)).toBe("docs");
	expect(manager.status("docs")).toEqual({ status: "connected" });
	expect(await whoami()).toBe("you hold access-token-2-abcdef");

	// mcp's status finds out as a call does.
	fake.valid.clear();
	expect(await statusOf(manager)).toMatchObject({ problems: [`server "docs" is not connected: ${NEEDS_SIGN_IN}`], servers: [{ name: "docs", status: "failed", error: NEEDS_SIGN_IN }] });
});

it("a call the server accepted before the sign-in ended is answered, whoever finds out that it ended", async () => {
	for (const finder of ["a call", "the status"] as const) {
		const { fake, manager, whoami } = await signedIn();
		// The server has the call and is running it...
		let done!: () => void;
		fake.nextCallAfter = new Promise((resolve) => (done = resolve));
		const running = whoami();
		await until("the call is with the server", () => fake.nextCallAfter === undefined);
		// ...when the sign-in ends, and another request is refused for it.
		fake.valid.clear();
		if (finder === "a call") await expect(whoami()).rejects.toThrow(NEEDS_SIGN_IN);
		else expect((await statusOf(manager)).servers[0]).toMatchObject({ status: "failed", error: NEEDS_SIGN_IN });
		expect(manager.status("docs")).toEqual({ status: "failed", error: NEEDS_SIGN_IN });
		done();
		expect(await running, `found out by ${finder}`).toBe("you hold access-token-1-abcdef");
		expect(fake.ended, "the connection it was made on is still open").toEqual([]);
	}
});

it("a connection that was given up is closed once no request can still be under way on it", async () => {
	// A request may take 300 ms here (the server's `timeout`).
	const { fake, whoami } = await signedIn({ timeout: 300 });
	fake.valid.clear();
	await expect(whoami()).rejects.toThrow(NEEDS_SIGN_IN);
	await until("the client ends its session", () => fake.ended.length > 0);
	expect(fake.ended).toEqual(["session-1"]);
});

it("a sign-in that a refresh token may still renew is kept through a refusal, and so is a client no sign-in was made with", async () => {
	// The authorization server is out of order when the token must be renewed, so the server is refused the old one.
	const { fake, manager, mcp, whoami } = await signedIn({ refreshTokens: true });
	fake.valid.clear();
	fake.tokensDown = true;
	await expect(whoami()).rejects.toThrow(`MCP server "docs" is not connected: ${NEEDS_SIGN_IN}`);
	expect(manager.status("docs")).toEqual({ status: "failed", error: NEEDS_SIGN_IN });
	// It is back: the login renews the sign-in, with no link, and nothing was registered again.
	fake.tokensDown = false;
	expect(await mcp({ action: "login", server: "docs" })).toEqual({ server: "docs", signedIn: true, status: "connected" });
	expect(await whoami()).toBe("you hold access-token-2-abcdef");
	expect(fake.registered).toBe(1);

	// A link that was never used: the next one is for the same client.
	const fresh = await withOAuth();
	const first = await fresh.mcp({ action: "login", server: "docs" });
	const second = await fresh.mcp({ action: "login", server: "docs" });
	expect(new URL(second.signInUrl).searchParams.get("client_id")).toBe(new URL(first.signInUrl).searchParams.get("client_id"));
	expect(fresh.fake.registered).toBe(1);
});

it("a login while the sign-in works keeps it, and its client, until the new one is complete", async () => {
	const { fake, manager, mcp, approve, whoami } = await signedIn();
	const login = await mcp({ action: "login", server: "docs" });
	expect(fake.registered, "the registered client is kept").toBe(1);
	expect(await whoami(), "the sign-in still works").toBe("you hold access-token-1-abcdef");
	expect(await approve(login.signInUrl)).toBe("docs");
	expect(await whoami()).toBe("you hold access-token-2-abcdef");
	expect(manager.status("docs")).toEqual({ status: "connected" });
});

it("a tool that needs more scope says to sign in, and the connection serves the other tools on", async () => {
	const { fake, manager, mcp, whoami } = await signedIn({ tools: ["whoami", "admin"] });
	fake.needScope.add("admin");
	await expect(manager.callTool("docs", "admin", {})).rejects.toThrow(`MCP server "docs" refused the call: ${NEEDS_SIGN_IN}`);
	expect(manager.status("docs")).toEqual({ status: "connected" });
	expect(fake.initialized, "no new connection").toBe(1);
	expect(await whoami()).toBe("you hold access-token-1-abcdef");
	// The link asks for the scope, with the client the server knows.
	const login = await mcp({ action: "login", server: "docs" });
	expect(new URL(login.signInUrl).searchParams.get("scope")).toBe("admin");
	expect(fake.registered).toBe(1);

	// A server that wants the scope of every connection refuses the sign-in for that alone: it keeps its client too.
	fake.needScope.add("initialize");
	fake.restart();
	await expect(whoami()).rejects.toThrow(`MCP server "docs" is not connected: ${NEEDS_SIGN_IN}`);
	expect(manager.status("docs")).toEqual({ status: "failed", error: NEEDS_SIGN_IN });
	expect(new URL((await mcp({ action: "login", server: "docs" })).signInUrl).searchParams.get("scope")).toBe("admin");
	expect(fake.registered).toBe(1);
});

it("a server that lets anyone connect and wants a sign-in for a call says so in the call's error", async () => {
	const { fake, manager, mcp, approve, whoami } = await withOAuth({ prepare: (fake) => void (fake.openConnect = true) });
	expect(manager.status("docs")).toEqual({ status: "connected" });
	await expect(whoami()).rejects.toThrow(`MCP server "docs" refused the call: ${NEEDS_SIGN_IN}`);
	expect(fake.initialized, "one new connection, which the server accepted as it had the first").toBe(2);
	expect(manager.status("docs")).toEqual({ status: "connected" });
	expect(fake.calls).toBe(0);
	await approve((await mcp({ action: "login", server: "docs" })).signInUrl);
	expect(await whoami()).toBe("you hold access-token-1-abcdef");
});
