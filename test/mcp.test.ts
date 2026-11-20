import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { getMcpToolExposure, parseMcpConfig, resolveConnection } from "../src/mcp/config.ts";
import { fileSource } from "./fixtures/mcp-config.ts";
import { SecretStore } from "../src/secrets.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { mcpServersSection } from "../src/mcp/section.ts";
import { createMcpResultSchema, createMcpToolName } from "../src/mcp/tools.ts";

const tempDirs: string[] = [];

async function tempConfig(content: unknown): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pdc-mcp-"));
	tempDirs.push(directory);
	const path = join(directory, "mcp.json");
	await writeFile(path, JSON.stringify(content));
	return path;
}

const load = (content: unknown) => parseMcpConfig(JSON.stringify(content), "~/.mcp.json");

/** A transport to an in-memory server with one tool, `search`. */
function fakeServer() {
	const { client, server } = createInMemoryTransportPair();
	void server.start();
	server.onMessage((message) => {
		const request = message as { id?: unknown; method?: string };
		if (request.id === undefined) return;
		const result =
			request.method === "initialize"
				? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
				: { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] };
		void server.send({ jsonrpc: "2.0", id: request.id, result } as never);
	});
	return client;
}

/** Like `fakeServer`, but it answers `initialize` only once `release()` is called; `closed` says whether the client hung up. */
function heldServer() {
	const { client, server } = createInMemoryTransportPair();
	void server.start();
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	server.onMessage((message) => {
		const request = message as { id?: unknown; method?: string };
		if (request.id === undefined) return;
		const result =
			request.method === "initialize"
				? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
				: { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] };
		// A reply held past the client's hang-up has nowhere to go.
		void (request.method === "initialize" ? released : Promise.resolve()).then(() => server.send({ jsonrpc: "2.0", id: request.id, result } as never)).catch(() => {});
	});
	const state = { transport: client, release, closed: false };
	client.onClose(() => (state.closed = true));
	return state;
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MCP configuration", () => {
	it("reads Claude Code's format and resolves ${NAME} from the secrets", () => {
		const loaded = load({
			mcpServers: {
				docs: {
					type: "http",
					url: "https://example.test/mcp?key=${DOCS_KEY}",
					headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Region": "eu" },
					timeout: 30000,
					alwaysLoad: false,
					description: "Documentation",
				},
				// Claude Code's alias for the same transport.
				issues: { type: "streamable-http", url: "https://issues.test/mcp" },
			},
		});
		expect(loaded.errors).toEqual([]);
		const docs = loaded.servers[0]!;
		expect(docs.namespace).toBe("mcp__docs");
		expect(docs.config).toMatchObject({ timeout: 30000, description: "Documentation" });
		expect(getMcpToolExposure(docs.config, "search"), "scripts call every tool by default").toBe("codemode");
		const secrets = { substitute: (text: string) => {
			const known: Record<string, string> = { DOCS_KEY: "k1", DOCS_TOKEN: "t1" };
			const missing: string[] = [];
			const out = text.replace(/\$\{([A-Z_]+)(?::-([^}]*))?\}/g, (match, name: string, fallback?: string) => known[name] ?? fallback ?? (missing.push(name), match));
			return { text: out, used: [], missing };
		} };
		expect(resolveConnection(docs.config, secrets)).toEqual({ url: "https://example.test/mcp?key=k1", headers: { Authorization: "Bearer t1", "X-Region": "eu" } });
		expect(resolveConnection({ url: "https://x.test/${NOPE}" }, secrets)).toEqual({ missing: ["NOPE"] });
	});

	it("refuses what this harness does not run, and says how to fix it", () => {
		const loaded = load({
			mcpServers: {
				local: { command: "npx", args: ["server"] },
				legacy: { type: "sse", url: "https://example.test/sse" },
				untyped: { url: "https://example.test/mcp" },
				good: { type: "http", url: "http://127.0.0.1:1234/mcp" },
			},
		});
		expect(loaded.errors.join("\n")).toContain("stdio servers are not supported");
		expect(loaded.errors.join("\n")).toContain("the sse transport is not supported");
		expect(loaded.errors.join("\n")).toContain('has a "url" but no "type"; add "type": "http"');
		expect(loaded.servers.map((server) => server.name)).toEqual(["good"]);
		expect(load({ mcpServers: { x: { type: "http", url: "https://x.test", timeout: -1 } } }).errors[0]).toContain("milliseconds");
		// Every tool is called from codemode: Claude Code's alwaysLoad, and model-facing exposures, fail loudly.
		expect(load({ mcpServers: { x: { type: "http", url: "https://x.test", alwaysLoad: true } } }).errors[0]).toContain("alwaysLoad is not supported here");
		expect(load({ mcpServers: { x: { type: "http", url: "https://x.test", exposure: "deferred" } } }).errors[0]).toContain('exposure must be one of "codemode", "hidden"');
		expect(load({ mcpServers: { x: { type: "http", url: "https://x.test", toolExposure: { a: "direct" } } } }).errors[0]).toContain('toolExposure "a" must be one of');
		expect(parseMcpConfig("{ nope", "~/.mcp.json").errors[0]).toMatch(/^~\/\.mcp\.json: /);
		expect(parseMcpConfig(undefined, "~/.mcp.json")).toEqual({ servers: [], errors: [] });
	});

	it("uses exact tool overrides, then patterns, then the server default", () => {
		const config = {
			url: "https://example.test/mcp",
			exposure: "hidden" as const,
			toolExposure: { "delete_*": "hidden" as const, delete_draft: "codemode" as const, "*": "codemode" as const },
		};
		expect(getMcpToolExposure(config, "delete_draft")).toBe("codemode");
		expect(getMcpToolExposure(config, "delete_all")).toBe("hidden");
		expect(getMcpToolExposure(config, "other")).toBe("codemode");
		expect(getMcpToolExposure({ url: "https://example.test/mcp", exposure: "hidden" }, "other")).toBe("hidden");
	});
});

describe("MCP tool names and schemas", () => {
	it("sanitizes names and adds a hash only when needed", () => {
		expect(createMcpToolName("docs", "find/page")).toBe("mcp__docs__find_page");
		const long = createMcpToolName("docs", "a".repeat(80));
		expect(long.length).toBeLessThanOrEqual(64);
		expect(long).toMatch(/_[0-9a-f]{8}$/);
		expect(createMcpToolName("docs", "a".repeat(80))).toBe(long);
	});

	it("declares the complete structured result for scripts", () => {
		const schema = createMcpResultSchema({
			type: "object",
			properties: { answer: { type: "string" } },
			$defs: { Text: { type: "string" } },
		}) as { required: string[]; properties: Record<string, unknown> };
		expect(schema.required).toEqual(["content"]);
		expect(schema.properties.structuredContent).toMatchObject({
			type: "object",
			properties: { answer: { type: "string" } },
		});
	});
});

describe("MCP prompt section", () => {
	it("lists the configured servers with their descriptions, and how to reach their tools", () => {
		const text = mcpServersSection([
			{ name: "issues", namespace: "mcp__issues", description: "Issues and pull requests\nmore detail" },
			{ name: "docs", namespace: "mcp__docs" },
		]);
		expect(text).toBe(
			[
				'Your MCP servers (~/.mcp.json), as of this prompt. Call their tools from codemode: searchTools("<server>") or describeNamespace("mcp__<server>") lists them; the mcp tool\'s status says which servers are connected.',
				"- docs (mcp__docs)",
				"- issues (mcp__issues): Issues and pull requests",
			].join("\n"),
		);
	});

	it("returns undefined without servers", () => {
		expect(mcpServersSection([])).toBeUndefined();
	});
});

describe("the MCP manager", () => {
	it("connects an HTTP-style server over an in-memory transport and registers tools only scripts call", async () => {
		const path = await tempConfig({
			mcpServers: {
				docs: {
					type: "http",
					url: "http://example.test/mcp",
					description: "Documentation",
				},
			},
		});
		const { client, server } = createInMemoryTransportPair();
		await server.start();
		server.onMessage((message) => {
			const request = message as { id?: unknown; method?: string; params?: Record<string, unknown> };
			if (request.id === undefined) return;
			const respond = (result: unknown) =>
				void server.send({ jsonrpc: "2.0", id: request.id, result } as never);
			if (request.method === "initialize") {
				respond({
					protocolVersion: "2025-06-18",
					capabilities: { tools: {} },
					serverInfo: { name: "test", version: "1" },
				});
			} else if (request.method === "tools/list") {
				respond({
					tools: [
						{
							name: "search",
							description: "Search the documentation",
							inputSchema: {
								type: "object",
								properties: { query: { type: "string" } },
								required: ["query"],
							},
							outputSchema: { type: "object", properties: { answer: { type: "string" } } },
						},
					],
				});
			} else if (request.method === "tools/call") {
				respond({
					content: [{ type: "text", text: "found it" }],
					structuredContent: { answer: "found it" },
				});
			} else {
				void server.send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32601, message: `unknown method ${request.method}` },
				} as never);
			}
		});

		const manager = new McpManager({
			source: fileSource(path),
			transportFactory: () => client,
			connectTimeoutMs: 2000,
		});
		await manager.load();
		const registry = createRegistry();
		manager.attach(registry);
		await manager.start();

		const extension = registry.snapshot().extension("mcp:docs");
		expect(extension?.tools?.map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
		const registered = extension!.tools![0]!;
		// Script-only, and `deferred` keeps it out of the codemode listing: `searchTools()` finds it.
		expect(registered.callers).toEqual(["tools"]);
		expect(registered.deferred).toBe(true);
		expect(manager.extension().sections?.[0]?.render({} as never, BACKGROUND_CONTEXT)).toContain("- docs (mcp__docs): Documentation");

		const result = await manager.callTool("docs", "search", { query: "x" });
		expect(result.structuredContent).toEqual({ answer: "found it" });
		await manager.close();
	});

	it("reconnects a server that failed at startup in the background, and stops when closed", async () => {
		const path = await tempConfig({ mcpServers: { docs: { type: "http", url: "http://example.test/mcp" } } });
		let attempts = 0;
		const manager = new McpManager({
			source: fileSource(path),
			connectTimeoutMs: 500,
			retryDelaysMs: [20],
			transportFactory: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("server not up yet");
				const { client, server } = createInMemoryTransportPair();
				void server.start();
				server.onMessage((message) => {
					const request = message as { id?: unknown; method?: string };
					if (request.id === undefined) return;
					const result =
						request.method === "initialize"
							? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
							: { tools: [{ name: "search", inputSchema: { type: "object", properties: {} } }] };
					void server.send({ jsonrpc: "2.0", id: request.id, result } as never);
				});
				return client;
			},
		});
		await manager.load();
		const registry = createRegistry();
		manager.attach(registry);
		await manager.start();
		expect(registry.snapshot().extension("mcp:docs")?.tools ?? []).toHaveLength(0);
		for (let i = 0; i < 100 && (registry.snapshot().extension("mcp:docs")?.tools?.length ?? 0) === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(registry.snapshot().extension("mcp:docs")?.tools?.map((tool) => tool.name), "registered once it came up, with no call").toEqual(["mcp__docs__search"]);
		await manager.close();
		const after = attempts;
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(attempts, "no retry after close").toBe(after);
	});

	it("applies an edit of the config: a new server connects, a removed one leaves", async () => {
		const path = await tempConfig({ mcpServers: {} });
		const manager = new McpManager({ source: fileSource(path), transportFactory: () => fakeServer(), connectTimeoutMs: 1000 });
		await manager.load();
		const registry = createRegistry();
		manager.attach(registry);
		await manager.start();

		await writeFile(path, JSON.stringify({ mcpServers: { docs: { type: "http", url: "http://example.test/mcp" } } }));
		await manager.reload();
		await until(() => (registry.snapshot().extension("mcp:docs")?.tools?.length ?? 0) > 0);
		expect(registry.snapshot().extension("mcp:docs")?.tools?.map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
		expect(registry.snapshot().extension("mcp:docs")?.namespace, "the server is its tools' codemode namespace").toEqual({ name: "mcp__docs", description: "" });

		// A broken file, or a broken entry, is reported and leaves the running server alone.
		await writeFile(path, "{ broken");
		await manager.reload();
		expect(manager.problems()[0]).toContain("mcp.json: ");
		expect(registry.snapshot().extension("mcp:docs")?.tools).toHaveLength(1);
		await writeFile(path, JSON.stringify({ mcpServers: { docs: { url: "http://example.test/mcp" } } }));
		await manager.reload();
		expect(manager.problems()[0]).toContain('add "type": "http"');
		expect(registry.snapshot().extension("mcp:docs")?.tools).toHaveLength(1);

		await writeFile(path, JSON.stringify({ mcpServers: {} }));
		await manager.reload();
		expect(registry.snapshot().extension("mcp:docs")).toBeUndefined();
		await manager.close();
	});

	it("mcp's status reads an edited config at once and answers once the server's connection settled", async () => {
		const path = await tempConfig({ mcpServers: {} });
		const manager = new McpManager({ source: fileSource(path), transportFactory: () => fakeServer(), connectTimeoutMs: 1000 });
		await manager.load();
		manager.attach(createRegistry());
		await manager.start();
		const tool = manager.extension().tools!.find((candidate) => candidate.name === "mcp")!;
		const status = async () => {
			const result = await tool.execute({ action: "status" } as never, {} as never, BACKGROUND_CONTEXT);
			return JSON.parse((result.output as { text: string }[])[0]!.text) as { problems: string[]; servers: { name: string; status: string; tools: number }[] };
		};
		expect(await status()).toMatchObject({ problems: [], servers: [] });
		// No reload in between: the status call itself notices the edit.
		await writeFile(path, JSON.stringify({ mcpServers: { docs: { type: "http", url: "http://example.test/mcp" }, broken: { url: "http://x.test" } } }));
		const after = await status();
		expect(after.servers).toEqual([expect.objectContaining({ name: "docs", status: "connected", tools: 1 })]);
		expect(after.problems).toEqual([expect.stringContaining('add "type": "http"')]);
		await expect(tool.execute({ action: "login", server: "docs" } as never, {} as never, BACKGROUND_CONTEXT)).rejects.toThrow("OAuth sign-in is not configured");
		await manager.close();
	});

	it("a server that names a missing secret waits for it, then connects when it is saved", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdc-mcp-secrets-"));
		tempDirs.push(dir);
		const secrets = new SecretStore(join(dir, "secrets.json"));
		const path = await tempConfig({ mcpServers: { docs: { type: "http", url: "http://example.test/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } } } });
		const seen: unknown[] = [];
		const manager = new McpManager({
			source: fileSource(path),
			secrets,
			transportFactory: (_server, config) => {
				seen.push(config.headers);
				return fakeServer();
			},
			connectTimeoutMs: 1000,
		});
		secrets.subscribe(() => void manager.secretsChanged());
		await manager.load();
		const registry = createRegistry();
		manager.attach(registry);
		await manager.start();
		expect(manager.status("docs")).toMatchObject({ status: "failed", error: expect.stringContaining("needs the secret DOCS_TOKEN") });
		expect(manager.problems()).toEqual([expect.stringContaining('server "docs" is not connected: it needs the secret DOCS_TOKEN; ask the user for it with request_secret')]);
		expect(seen).toEqual([]);

		await secrets.save("DOCS_TOKEN", "t0ken-value-123");
		await until(() => (registry.snapshot().extension("mcp:docs")?.tools?.length ?? 0) > 0);
		expect(registry.snapshot().extension("mcp:docs")?.tools?.map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
		expect(seen).toEqual([{ Authorization: "Bearer t0ken-value-123" }]);
		await manager.close();
	});

	it("a server removed while it is still connecting is not retried, nor reconnected for a secret, once its connect fails", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const path = await tempConfig({ mcpServers: {} });
		let attempts = 0;
		// It never answers: the connect times out after the server left the config.
		const manager = new McpManager({ source: fileSource(path), transportFactory: () => (attempts++, heldServer().transport), connectTimeoutMs: 300, retryDelaysMs: [10] });
		try {
			await manager.load();
			manager.attach(createRegistry());
			await manager.start();
			await writeFile(path, JSON.stringify({ mcpServers: { slow: { type: "http", url: "http://slow.test/mcp?key=${KEY}" } } }));
			await manager.reload();
			expect(manager.status("slow")).toMatchObject({ status: "connecting" });
			// A secret is saved: it waits for the connect in flight before connecting again.
			const secretsChanged = manager.secretsChanged();
			await writeFile(path, JSON.stringify({ mcpServers: {} }));
			await manager.reload();
			await expect(secretsChanged).resolves.toBeUndefined();
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(unhandled).toEqual([]);
			expect(attempts, "no retry of a removed server").toBe(1);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await manager.close();
		}
	});

	it("a connect that succeeds after its server was removed or edited, or the manager closed, installs nothing and closes its client", async () => {
		const path = await tempConfig({ mcpServers: {} });
		const held: ReturnType<typeof heldServer>[] = [];
		const manager = new McpManager({
			source: fileSource(path),
			transportFactory: (_server, config) => {
				if (config.url.includes("fast")) return fakeServer();
				const server = heldServer();
				held.push(server);
				return server.transport;
			},
			connectTimeoutMs: 2000,
		});
		await manager.load();
		const registry = createRegistry();
		manager.attach(registry);
		await manager.start();
		const slow = JSON.stringify({ mcpServers: { slow: { type: "http", url: "http://slow.test/mcp" } } });

		// Removed while connecting, then the connect succeeds.
		await writeFile(path, slow);
		await manager.reload();
		await until(() => held.length === 1);
		await writeFile(path, JSON.stringify({ mcpServers: {} }));
		await manager.reload();
		held[0]!.release();
		await until(() => held[0]!.closed);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(held[0]!.closed, "the late client is closed").toBe(true);
		expect(registry.snapshot().extension("mcp:slow"), "the removed server's tools stay gone").toBeUndefined();

		// Edited while connecting: the new entry connects, then the old connect succeeds.
		await writeFile(path, slow);
		await manager.reload();
		await until(() => held.length === 2);
		await writeFile(path, JSON.stringify({ mcpServers: { slow: { type: "http", url: "http://fast.test/mcp" } } }));
		await manager.reload();
		await until(() => (registry.snapshot().extension("mcp:slow")?.tools?.length ?? 0) > 0);
		held[1]!.release();
		await until(() => held[1]!.closed);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(held[1]!.closed, "the late client is closed").toBe(true);
		expect(registry.snapshot().extension("mcp:slow")?.tools?.map((tool) => tool.name), "the edited entry's tools, not the old one's").toEqual(["mcp__slow__search"]);

		// Closed while connecting.
		await writeFile(path, slow);
		await manager.reload();
		await until(() => held.length === 3);
		await manager.close();
		held[2]!.release();
		await until(() => held[2]!.closed);
		expect(held[2]!.closed, "the late client is closed").toBe(true);
	});

	it("a server removed while it lists its tools does not put them back", async () => {
		const path = await tempConfig({ mcpServers: {} });
		const { client, server } = createInMemoryTransportPair();
		void server.start();
		// It answers `initialize` and never `tools/list`.
		server.onMessage((message) => {
			const request = message as { id?: unknown; method?: string };
			if (request.method !== "initialize") return;
			void server.send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } } as never);
		});
		// Closing resolves at once, as StreamableHttpTransport's does without a session: before the pending listing fails.
		const close = client.close.bind(client);
		client.close = async () => void close();
		const manager = new McpManager({ source: fileSource(path), transportFactory: () => client, connectTimeoutMs: 2000 });
		await manager.load();
		const registry = createRegistry();
		manager.attach(registry);
		await manager.start();
		await writeFile(path, JSON.stringify({ mcpServers: { slow: { type: "http", url: "http://slow.test/mcp" } } }));
		await manager.reload();
		await until(() => manager.status("slow")?.status === "connected");
		await writeFile(path, JSON.stringify({ mcpServers: {} }));
		await manager.reload();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(registry.snapshot().extension("mcp:slow"), "the removed server's tools stay gone").toBeUndefined();
		await manager.close();
	});
});
