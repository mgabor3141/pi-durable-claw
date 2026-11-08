/**
 * Adapt MCP tools to pi-durable tool registrations.
 *
 * A call has three channels. The model gets text and images, bounded to a manageable size; a
 * codemode script gets the complete `CallToolResult` without `_meta`; the UI gets details.
 */

import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type CallToolResult,
	type ContentBlock,
	type McpRequestOptions,
	type Tool as McpTool,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { McpExposure } from "./config.ts";
import { type Schema } from "@earendil-works/pi-schema";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;
/** Model-facing text beyond this is cut in the middle. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

export type McpToolDetails = {
	readonly server: string;
	readonly tool: string;
	/** Workspace temp file with the complete text output, when the model copy was truncated. */
	readonly fullOutputPath?: string;
};

/** `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. */
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** MCP content blocks as one compact schema; scripts may see any protocol-specific fields. */
const CONTENT_BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};

/** Keywords whose values are data, so a `$ref` key in them is not a reference. */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);
/** Keywords whose values map names to schemas, so their keys are names, not keywords. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rewrite local `$ref`s so a schema can be nested under another schema's `properties`. */
function relocateSchema(schema: unknown, pointer: string): unknown {
	if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
	if (!isObject(schema)) return schema;
	const relocated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
			relocated[key] = `${pointer}${value.slice(1)}`;
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			relocated[key] = value;
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
			relocated[key] = Object.fromEntries(
				Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
			);
		} else {
			relocated[key] = relocateSchema(value, pointer);
		}
	}
	return relocated;
}

/** Output schema of every MCP tool: the `CallToolResult` scripts receive, without `_meta`. */
export function createMcpResultSchema(structuredContentSchema: Record<string, unknown> | undefined): Schema {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
			structuredContent: structuredContentSchema
				? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
				: {},
			isError: { type: "boolean" },
		},
		required: ["content"],
		additionalProperties: true,
	} as unknown as Schema;
}

/** Input schemas must be objects; some providers reject an object schema without `properties`. */
function toParameters(schema: Record<string, unknown>): Schema {
	return {
		...schema,
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	} as unknown as Schema;
}

/** Cut text in the middle, byte-oriented, and return the model copy plus whether it was cut. */
function truncateMiddle(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.byteLength(text);
	if (bytes <= maxBytes) return { text, truncated: false };
	const half = Math.floor(maxBytes / 2);
	const buffer = Buffer.from(text);
	return {
		text: `${buffer.subarray(0, half).toString("utf8")}\n\n… output truncated …\n\n${buffer.subarray(bytes - half).toString("utf8")}`,
		truncated: true,
	};
}

function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const type = mimeType.split(";", 1)[0].trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

/** Write the full text to the workspace temp dir when one is available, so codemode's `read` can reach it. */
async function saveFullText(api: ToolExecutionApi, text: string, context: Context): Promise<string | undefined> {
	if (api.env === undefined) return undefined;
	const created = await api.env.createTempFile({ prefix: "claw-mcp-", suffix: ".txt" }, context);
	if (!created.ok) return undefined;
	const written = await api.env.writeFile(created.value, text, context);
	return written.ok ? created.value : undefined;
}

/** Model-facing content and the complete structured result of one MCP call. */
export async function convertMcpResult(
	server: string,
	tool: string,
	result: CallToolResult,
	api: ToolExecutionApi,
	context: Context,
): Promise<ToolExecutionResult<McpToolDetails>> {
	const converted: (TextContent | ImageContent)[] =
		result.content.length > 0
			? result.content.flatMap((block) => {
					if (block.type === "resource_link") {
						const extras = [block.mimeType, block.size === undefined ? undefined : `${block.size} bytes`]
							.filter(Boolean)
							.join(", ");
						const description = block.description ? `: ${block.description}` : "";
						return [
							{
								type: "text" as const,
								text: `[Resource ${block.uri} "${block.title ?? block.name}"${extras ? ` (${extras})` : ""}${description}]`,
							},
						];
					}
					if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
						const data = Buffer.from(block.resource.blob, "base64");
						if (isTextMimeType(block.resource.mimeType)) {
							return [{ type: "text" as const, text: data.toString("utf8") }];
						}
						return [
							{
								type: "text" as const,
								text: `[Binary resource ${block.resource.uri} (${block.resource.mimeType ?? "unknown type"}, ${data.length} bytes)]`,
							},
						];
					}
					return toLlmContent({ content: [block] });
				})
			: toLlmContent(result);

	if (result.isError && textOf(converted) === "") {
		converted.push({ type: "text", text: `MCP tool ${server}/${tool} returned an error` });
	}

	const combined = textOf(converted);
	const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
	let content = converted;
	let fullOutputPath: string | undefined;
	if (truncation.truncated) {
		fullOutputPath = await saveFullText(api, combined, context);
		const where = fullOutputPath
			? `[Full output: ${fullOutputPath}]`
			: "[The full output could not be saved; call this tool from codemode for the complete result.]";
		content = [{ type: "text", text: `Warning: truncated output\n\n${truncation.text}\n\n${where}` }, ...converted.filter((block) => block.type === "image")];
	}

	const { _meta: _ignored, ...scriptResult } = result;
	return {
		output: content,
		structuredOutput: scriptResult as unknown as ToolExecutionResult<McpToolDetails>["structuredOutput"],
		details: { server, tool, ...(fullOutputPath ? { fullOutputPath } : {}) },
		...(result.isError ? { isError: true } : {}),
	};
}

export interface McpToolOptions {
	readonly server: string;
	readonly tool: McpTool;
	readonly name: string;
	readonly exposure: McpExposure;
	readonly timeoutMs: number;
	readonly getClient: () => Promise<{ callTool(name: string, args?: Record<string, unknown>, options?: McpRequestOptions): Promise<CallToolResult> }>;
}

/** One MCP tool as a pi-durable registration, with its exposure determining how the model reaches it. */
export function createMcpToolRegistration(options: McpToolOptions): ToolRegistration<Schema, McpToolDetails> {
	const { server, tool, exposure } = options;
	const title = tool.title ?? tool.annotations?.title;
	const description = tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`;
	return {
		name: options.name,
		description,
		parameters: toParameters(tool.inputSchema),
		structuredOutputSchema: createMcpResultSchema(tool.outputSchema),
		// Only scripts call it, and `deferred` keeps it out of the codemode section's listing: `searchTools()` finds it.
		callers: exposure === "codemode" ? ["tools"] : [],
		deferred: true,
		replay: "unsafe",
		async execute(args, api, context) {
			const client = await options.getClient();
			const result = await client.callTool(tool.name, (args ?? {}) as Record<string, unknown>, {
				timeoutMs: options.timeoutMs,
			});
			return convertMcpResult(server, tool.name, result, api, context);
		},
	};
}
