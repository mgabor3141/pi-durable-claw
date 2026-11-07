import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import { afterEach, describe, expect, it } from "vitest";
import { fileSource, getMcpToolExposure, parseMcpConfig, resolveConnection } from "../src/mcp/config.ts";
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
					headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Region": "${REGION:-eu}" },
					timeout: 30000,
					alwaysLoad: true,
					description: "Documentation",
				},
				// Claude Code's alias for the same transport.
				issues: { type: "streamable-http", url: "https://issues.test/mcp" },
			},
		});
		expect(loaded.errors).toEqual([]);
		const docs = loaded.servers[0]!;
		expect(docs.namespace).toBe("mcp__docs");
		expect(docs.config).toMatchObject({ timeout: 30000, exposure: "direct" });
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
		expect(parseMcpConfig("{ nope", "~/.mcp.json").errors[0]).toMatch(/^~\/\.mcp\.json: /);
		expect(parseMcpConfig(undefined, "~/.mcp.json")).toEqual({ servers: [], errors: [] });
	});

	it("uses exact tool overrides, then patterns, then the server default", () => {
		const config = {
			url: "https://example.test/mcp",
			exposure: "codemode" as const,
			toolExposure: { search: "deferred" as const, "delete_*": "hidden" as const },
		};
		expect(getMcpToolExposure(config, "search")).toBe("deferred");
		expect(getMcpToolExposure(config, "delete_all")).toBe("hidden");
		expect(getMcpToolExposure(config, "other")).toBe("codemode");
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
	it("renders only indirect servers and explains both reaches", () => {
		const text = mcpServersSection([
			{ name: "docs", namespace: "mcp__docs", description: "Docs", reaches: ["tool_search"] },
			{ name: "issues", namespace: "mcp__issues", description: "Issues", reaches: ["codemode"] },
			{ name: "direct", namespace: "mcp__direct", reaches: [] },
		]);
		expect(text).toContain("MCP servers whose tools are not declared to you.");
		expect(text).toContain("Load the tools of tool_search servers with tool_search.");
		expect(text).toContain("Call the tools of codemode servers from codemode scripts.");
		expect(text).toContain("- mcp__docs (tool_search): Docs");
		expect(text).toContain("- mcp__issues (codemode): Issues");
		expect(text).not.toContain("mcp__direct");
	});

	it("returns undefined without indirect servers", () => {
		expect(mcpServersSection([{ name: "x", namespace: "mcp__x", reaches: [] }])).toBeUndefined();
	});

	it("puts problems first, even with no server to list", () => {
		expect(mcpServersSection([], ['server "docs" is not connected: refused'])).toBe(
			'Problems with your MCP configuration (~/.mcp.json):\n- server "docs" is not connected: refused',
		);
	});
});

describe("tool search and the MCP manager", () => {
	it("tool_search loads a deferred MCP tool for the next call", async () => {
		const tool = createToolSearchTool();
		const deferred = [
			{
				name: "mcp__docs__search",
				description: "Search the documentation",
				parameters: { type: "object", properties: { query: { type: "string" } } },
			},
		] as unknown as ToolRegistration[];
		const result = await tool.execute(
			{ query: "documentation" },
			{ agent: async () => ({ deferred }) } as never,
			BACKGROUND_CONTEXT,
		);
		expect(result.control?.addTools).toEqual(["mcp__docs__search"]);
		expect(result.output).toEqual([{ type: "text", text: expect.stringContaining("mcp__docs__search") }]);
	});

	it("connects an HTTP-style server over an in-memory transport and registers deferred tools", async () => {
		const path = await tempConfig({
			mcpServers: {
				docs: {
					type: "http",
					url: "http://example.test/mcp",
					description: "Documentation",
					exposure: "deferred",
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
		expect(registered.deferred).toBe(true);
		expect(registered.callers).toEqual(["model", "tools"]);
		expect(manager.hasIndirectTools()).toBe(true);

		const result = await manager.callTool("docs", "search", { query: "x" });
		expect(result.structuredContent).toEqual({ answer: "found it" });
		await manager.close();
	});

	it("reconnects a server that failed at startup in the background, and stops when closed", async () => {
		const path = await tempConfig({ mcpServers: { docs: { type: "http", url: "http://example.test/mcp", exposure: "deferred" } } });
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

	it("applies an edit of the config: a new server connects, a removed one leaves, tool_search follows", async () => {
		const path = await tempConfig({ mcpServers: {} });
		const manager = new McpManager({ source: fileSource(path), transportFactory: () => fakeServer(), connectTimeoutMs: 1000 });
		await manager.load();
		const registry = createRegistry();
		manager.attach(registry);
		await manager.start();
		expect(registry.snapshot().extension("tool-search")).toBeUndefined();

		await writeFile(path, JSON.stringify({ mcpServers: { docs: { type: "http", url: "http://example.test/mcp" } } }));
		await manager.reload();
		await until(() => (registry.snapshot().extension("mcp:docs")?.tools?.length ?? 0) > 0);
		expect(registry.snapshot().extension("mcp:docs")?.tools?.map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
		expect(manager.namespaces().map((namespace) => namespace.name)).toEqual(["mcp__docs"]);
		expect(registry.snapshot().extension("tool-search"), "deferred tools: tool_search is offered").toBeDefined();

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
		expect(manager.namespaces()).toEqual([]);
		expect(registry.snapshot().extension("tool-search")).toBeUndefined();
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
});
