import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";
import { afterEach, describe, expect, it } from "vitest";
import {
	getMcpToolExposure,
	loadMcpConfig,
	resolveHeaders,
} from "../src/mcp/config.ts";
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

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MCP configuration", () => {
	it("accepts HTTP servers and expands header variables", async () => {
		const path = await tempConfig({
			mcpServers: {
				docs: {
					url: "https://example.test/mcp",
					headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
					description: "Documentation",
					exposure: "deferred",
				},
			},
		});
		const loaded = await loadMcpConfig(path);
		expect(loaded.errors).toEqual([]);
		expect(loaded.servers).toHaveLength(1);
		expect(loaded.servers[0]!.namespace).toBe("mcp__docs");
		expect(resolveHeaders(loaded.servers[0]!.config.headers, { DOCS_TOKEN: "secret" })).toEqual({
			Authorization: "Bearer secret",
		});
	});

	it("rejects stdio entries and does not read a workspace file", async () => {
		const path = await tempConfig({
			mcpServers: {
				local: { command: "npx", args: ["server"] },
				good: { url: "http://127.0.0.1:1234/mcp" },
			},
		});
		const loaded = await loadMcpConfig(path);
		expect(loaded.errors.join("\n")).toContain("stdio servers are not supported");
		expect(loaded.servers.map((server) => server.name)).toEqual(["good"]);
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
			configPath: path,
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
});
