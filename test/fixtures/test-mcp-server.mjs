#!/usr/bin/env node
// A tiny streamable-HTTP MCP server for live smoke tests. It has no dependencies and offers
// two tools: echo and add. Run it as a disposable container on the workspace network:
//
//   docker run --rm --name claw-test-mcp --network claw-<user>-workspace \
//     -v "$PWD/test/fixtures/test-mcp-server.mjs:/server.mjs:ro" \
//     -e PORT=8080 node:22-alpine node /server.mjs
//
// The harness config then points at http://claw-test-mcp:8080/mcp.

import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const SERVER_INFO = { name: "claw-test-mcp", version: "1.0.0" };

const tools = [
	{
		name: "echo",
		title: "Echo",
		description: "Echo text back to the caller.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", description: "Text to echo" } },
			required: ["text"],
		},
		outputSchema: {
			type: "object",
			properties: { echo: { type: "string" }, text: { type: "string" } },
			required: ["echo", "text"],
		},
	},
	{
		name: "add",
		title: "Add",
		description: "Add two numbers.",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
		outputSchema: {
			type: "object",
			properties: { sum: { type: "number" } },
			required: ["sum"],
		},
	},
];

function result(value) {
	return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function callTool(params) {
	const name = params?.name;
	const args = params?.arguments ?? {};
	if (name === "echo") {
		if (typeof args.text !== "string") throw new Error("echo.text must be a string");
		const value = { echo: `echo: ${args.text}`, text: args.text };
		return result(value);
	}
	if (name === "add") {
		if (typeof args.a !== "number" || typeof args.b !== "number") throw new Error("add.a and add.b must be numbers");
		return result({ sum: args.a + args.b });
	}
	throw new Error(`unknown tool ${name}`);
}

function handle(message) {
	const { id, method, params } = message;
	if (id === undefined) return undefined;
	try {
		switch (method) {
			case "initialize":
				return {
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: params?.protocolVersion ?? "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: SERVER_INFO,
						instructions: "Disposable test server for claw. Use echo or add.",
					},
				};
			case "ping":
				return { jsonrpc: "2.0", id, result: {} };
			case "tools/list":
				return { jsonrpc: "2.0", id, result: { tools } };
			case "tools/call":
				return { jsonrpc: "2.0", id, result: callTool(params) };
			case "resources/list":
				return { jsonrpc: "2.0", id, result: { resources: [] } };
			case "resources/templates/list":
				return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
			default:
				return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } };
		}
	} catch (error) {
		return {
			jsonrpc: "2.0",
			id,
			result: { content: [{ type: "text", text: String(error) }], isError: true },
		};
	}
}

const server = http.createServer(async (request, response) => {
	if (request.method !== "POST") {
		response.writeHead(405, { allow: "POST" });
		response.end();
		return;
	}
	let body = "";
	try {
		for await (const chunk of request) body += chunk;
		const parsed = JSON.parse(body);
		const messages = Array.isArray(parsed) ? parsed : [parsed];
		const replies = messages.map(handle).filter((reply) => reply !== undefined);
		if (replies.length === 0) {
			response.writeHead(202);
			response.end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "claw-test" });
		response.end(JSON.stringify(replies.length === 1 ? replies[0] : replies));
	} catch (error) {
		response.writeHead(400, { "content-type": "application/json" });
		response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } }));
	}
});

server.listen(PORT, "0.0.0.0", () => {
	console.error(`claw test MCP listening on 0.0.0.0:${PORT}`);
});
