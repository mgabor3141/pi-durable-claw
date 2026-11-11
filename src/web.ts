import { isIP } from "node:net";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { WEB_FETCH_TOOL_DESCRIPTION, WEB_SEARCH_TOOL_DESCRIPTION, untrusted } from "./prompts.ts";
import { arr, int, opt, str, union } from "@earendil-works/pi-schema";
import { literal, object } from "./schema.ts";

/**
 * Web tools for the workspace agent: search through a private SearXNG and view
 * one page through a private page-reader service. The services carry no account
 * credentials, so the tools only need these two URLs; the harness never asks
 * the workspace to run network code.
 *
 * Like every outside service, each is on only when configured (`SEARXNG_URL`, `READER_URL`): without its URL the tool is
 * not offered, and the host logs that at start.
 */
export interface WebConfig {
	/** A SearXNG with its JSON API on: `web_search`. */
	readonly searxngUrl?: string;
	/** A page reader answering `POST /read`: `web_fetch`. */
	readonly readerUrl?: string;
}

/** The configuration from the environment; a malformed URL fails loudly. */
export function webConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
	const url = (name: string): string | undefined => {
		const value = env[name]?.trim() ?? "";
		if (value === "") return undefined;
		if (!URL.canParse(value) || !/^https?:$/u.test(new URL(value).protocol)) throw new Error(`${name} must be an http(s) URL: ${value}`);
		return value.replace(/\/+$/u, "");
	};
	const searxngUrl = url("SEARXNG_URL");
	const readerUrl = url("READER_URL");
	return { ...(searxngUrl === undefined ? {} : { searxngUrl }), ...(readerUrl === undefined ? {} : { readerUrl }) };
}

const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;
// The reader may fall back from HTTP to a browser.
const DEFAULT_READ_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 500;
const MAX_RESPONSE_CHARS = 2_000_000;

export interface SearchResult {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
	readonly engine?: string;
	readonly published?: string;
}

export interface SearchOutput {
	readonly query: string;
	readonly results: readonly SearchResult[];
}

export interface WebFetchOutput {
	/** The URL the caller asked for. */
	readonly url: string;
	/** The URL the reader finished on, after redirects when it reports one. */
	readonly finalUrl: string;
	/** The complete page Markdown; the codemode output limit decides what reaches the model. */
	readonly markdown: string;
}

export interface WebRequestOptions {
	/** HTTP timeout for one backend call. */
	readonly timeoutMs?: number;
	/** Override for tests. */
	readonly fetch?: typeof fetch;
	/** The call's Stop: aborts the request. */
	readonly signal?: AbortSignal;
}

/** The request's own timeout, and the caller's Stop. */
function requestSignal(options: WebRequestOptions, defaultTimeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs);
	return options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
}

function fetcher(options: WebRequestOptions): typeof fetch {
	return options.fetch ?? fetch;
}

function errorDetail(body: string): string {
	try {
		const value = JSON.parse(body) as { detail?: unknown; error?: unknown };
		if (typeof value.detail === "string") return value.detail;
		if (typeof value.error === "string") return value.error;
	} catch {
		// The response was not JSON; the clipped body is still useful.
	}
	return body.slice(0, 500);
}

export interface FetchUrlPolicy {
	/**
	 * Exact hostnames that a caller may reach even though they are normally
	 * rejected as internal. The browser uses this for the workspace's own dev
	 * server; the page reader never does.
	 */
	readonly allowHosts?: readonly string[];
}

/** Reject non-HTTP URLs and private or internal hosts before the reader sees them. */
export function assertFetchableUrl(value: string, policy: FetchUrlPolicy = {}): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`not a URL: ${JSON.stringify(value)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`only http and https URLs can be fetched, not ${url.protocol}`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new Error("URLs with embedded credentials are not allowed");
	}

	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const internalNames = new Set([
		"localhost",
		"searxng",
		"crawler",
		"reader",
		"scrapling",
		"scrapling-reader",
		"crawl4ai",
		"crawl4ai-extract",
		"browserless",
		"browser",
		"harness",
		"workspace",
		"inference-proxy",
		"traefik",
		"host.docker.internal",
		"gateway.docker.internal",
	]);
	const allowed = new Set((policy.allowHosts ?? []).map((name) => name.toLowerCase().replace(/^\[|\]$/g, "")));
	if (!allowed.has(host) && (internalNames.has(host) || host.endsWith(".local") || host.endsWith(".internal"))) {
		throw new Error(`refusing internal host: ${host}`);
	}
	if (!allowed.has(host) && isPrivateAddress(host)) {
		throw new Error(`refusing private address: ${host}`);
	}
	return url.toString();
}

function isPrivateAddress(host: string): boolean {
	if (isIP(host) === 6) {
		const lower = host.toLowerCase();
		// IPv4-mapped addresses can smuggle a private IPv4 target through an AAAA lookup.
		return (
			lower === "::1" ||
			lower === "::" ||
			lower.startsWith("::ffff:") ||
			lower.startsWith("fe80:") ||
			lower.startsWith("fc") ||
			lower.startsWith("fd")
		);
	}
	if (isIP(host) !== 4) return false;
	const parts = host.split(".");
	const octets = parts.map(Number);
	if (octets.some((octet) => octet > 255)) return false;
	const [a, b] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

export async function searchWeb(
	searxngUrl: string,
	query: string,
	options: WebRequestOptions & { maxResults?: number; timeRange?: "day" | "week" | "month" | "year" } = {},
): Promise<SearchOutput> {
	const trimmed = query.trim();
	if (trimmed === "") throw new Error("web_search needs a non-empty query");
	const count = Math.max(1, Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS));
	const url = new URL(`${searxngUrl}/search`);
	url.searchParams.set("q", trimmed);
	url.searchParams.set("format", "json");
	if (options.timeRange !== undefined) url.searchParams.set("time_range", options.timeRange);

	const response = await fetcher(options)(url, {
		headers: { accept: "application/json" },
		signal: requestSignal(options, DEFAULT_SEARCH_TIMEOUT_MS),
	});
	const body = await response.text();
	if (!response.ok) throw new Error(`searxng returned HTTP ${response.status}: ${errorDetail(body)}`);

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("searxng returned invalid JSON");
	}
	const rows = (parsed as { results?: unknown }).results;
	if (!Array.isArray(rows)) throw new Error("searxng returned no results array");

	const results = rows.slice(0, count).map((row): SearchResult => {
		const item = row as Record<string, unknown>;
		return {
			title: String(item.title ?? ""),
			url: String(item.url ?? ""),
			snippet: String(item.content ?? "").slice(0, MAX_SNIPPET_CHARS),
			...(typeof item.engine === "string" ? { engine: item.engine } : {}),
			...(typeof item.publishedDate === "string" ? { published: item.publishedDate } : {}),
		};
	});
	return { query: trimmed, results };
}

export async function fetchWeb(readerUrl: string, value: string, options: WebRequestOptions = {}): Promise<WebFetchOutput> {
	const url = assertFetchableUrl(value);
	const response = await fetcher(options)(`${readerUrl}/read`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ url }),
		signal: requestSignal(options, DEFAULT_READ_TIMEOUT_MS),
	});
	const body = await response.text();
	if (body.length > MAX_RESPONSE_CHARS) throw new Error(`reader response is too large (${body.length} chars)`);
	if (!response.ok) throw new Error(`reader returned HTTP ${response.status}: ${errorDetail(body)}`);

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("reader returned invalid JSON");
	}
	const result = parsed as { url?: unknown; markdown?: unknown };
	const finalUrl = typeof result.url === "string" ? result.url : url;
	// The reader follows redirects. A public URL must not be able to land on the
	// workspace network, so apply the same check to the final URL.
	assertFetchableUrl(finalUrl);
	const markdown = typeof result.markdown === "string" ? result.markdown.trim() : "";
	if (markdown === "") throw new Error(`reader found no readable content at ${url}`);
	return { url, finalUrl, markdown };
}

/** `web_search` and `web_fetch`, each only when its service is configured. */
export function webTools(config: WebConfig): ToolRegistration[] {
	const { searxngUrl, readerUrl } = config;
	return [
		...(searxngUrl === undefined ? [] : [searchTool(searxngUrl)]),
		...(readerUrl === undefined ? [] : [fetchTool(readerUrl)]),
	];
}

function searchTool(searxngUrl: string): ToolRegistration {
	return defineTool({
			name: "web_search",
			description: WEB_SEARCH_TOOL_DESCRIPTION,
			parameters: object({
				query: str({ minLength: 1, maxLength: 2_000 }),
				max_results: opt(int({ minimum: 1, maximum: MAX_RESULTS })),
				time_range: opt(union([literal("day"), literal("week"), literal("month"), literal("year")])),
			}),
			structuredOutputSchema: object({
				query: str(),
				results: arr(
					object({
						title: str(),
						url: str(),
						snippet: str(),
						engine: opt(str()),
						published: opt(str()),
					}),
				),
			}),
			callers: ["tools"],
			async execute(args, _api, context) {
				const output = await searchWeb(searxngUrl, args.query, { maxResults: args.max_results, timeRange: args.time_range, signal: context.abortSignal });
				const text = untrusted("web-search", args.query, JSON.stringify(output.results, null, 2));
				return { output: [{ type: "text", text }], structuredOutput: output as unknown as JsonValue };
			},
		});
}

function fetchTool(readerUrl: string): ToolRegistration {
	return defineTool({
			name: "web_fetch",
			description: WEB_FETCH_TOOL_DESCRIPTION,
			parameters: object({
				url: str({ minLength: 1, maxLength: 4_000 }),
			}),
			structuredOutputSchema: object({
				url: str(),
				finalUrl: str(),
				markdown: str(),
			}),
			callers: ["tools"],
			async execute(args, _api, context) {
				const page = await fetchWeb(readerUrl, args.url, { signal: context.abortSignal });
				const text = untrusted("web-page", page.finalUrl, page.markdown);
				return {
					output: [{ type: "text", text }],
					structuredOutput: page as unknown as JsonValue,
				};
			},
		});
}
