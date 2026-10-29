import { describe, expect, it } from "vitest";
import { assertFetchableUrl, searchWeb, fetchWeb, webTools } from "../src/web.ts";

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
	return handler as typeof fetch;
}

describe("web search", () => {
	it("sends the query to SearXNG and caps the result count", async () => {
		let seen = "";
		const out = await searchWeb("rust async", {
			maxResults: 2,
			timeRange: "week",
			fetch: fakeFetch(async (input) => {
				seen = String(input);
				return response({
					results: [
						{ title: "One", url: "https://one.example", content: "first", engine: "brave" },
						{ title: "Two", url: "https://two.example", content: "second" },
						{ title: "Three", url: "https://three.example", content: "third" },
					],
				});
			}),
		});
		expect(seen).toContain("q=rust+async");
		expect(seen).toContain("format=json");
		expect(seen).toContain("time_range=week");
		expect(out.results).toHaveLength(2);
		expect(out.results[0]).toEqual({ title: "One", url: "https://one.example", snippet: "first", engine: "brave" });
	});

	it("clips long snippets", async () => {
		const out = await searchWeb("long", {
			fetch: fakeFetch(async () => response({ results: [{ title: "T", url: "https://x.example", content: "x".repeat(900) }] })),
		});
		expect(out.results[0].snippet).toHaveLength(500);
	});

	it("reports backend errors with the response detail", async () => {
		await expect(
			searchWeb("fail", { fetch: fakeFetch(async () => response({ detail: "engine unavailable" }, 502)) }),
		).rejects.toThrow("searxng returned HTTP 502: engine unavailable");
	});

	it("rejects an empty query", async () => {
		await expect(searchWeb("   ", { fetch: fakeFetch(async () => response({})) })).rejects.toThrow("non-empty query");
	});
});

describe("web view", () => {
	it("reads markdown from the page reader and reports the final URL", async () => {
		let body = "";
		const out = await fetchWeb("https://example.com/start", {
			fetch: fakeFetch(async (_input, init) => {
				body = String(init?.body ?? "");
				return response({ url: "https://example.com/end", markdown: "# Title\n\nBody" });
			}),
		});
		expect(body).toContain('"url":"https://example.com/start"');
		expect(out).toMatchObject({ url: "https://example.com/start", finalUrl: "https://example.com/end" });
		expect(out.markdown).toBe("# Title\n\nBody");
	});

	it("refuses private, internal and non-http URLs before fetching", async () => {
		let called = false;
		const never = fakeFetch(async () => {
			called = true;
			return response({});
		});
		for (const url of ["http://127.0.0.1/", "http://10.1.2.3/", "http://searxng:8080/", "file:///etc/passwd"]) {
			await expect(fetchWeb(url, { fetch: never })).rejects.toThrow();
		}
		expect(called).toBe(false);
	});

	it("refuses a redirect into a private address", async () => {
		await expect(
			fetchWeb("https://example.com", {
				fetch: fakeFetch(async () => response({ url: "http://127.0.0.1/", markdown: "# private" })),
			}),
		).rejects.toThrow(/private|internal/);
	});

	it("reports an empty page as an error", async () => {
		await expect(
			fetchWeb("https://example.com", { fetch: fakeFetch(async () => response({ url: "https://example.com", markdown: " " })) }),
		).rejects.toThrow("no readable content");
	});
});

describe("tool registration", () => {
	it("registers both web tools as script-callable only", () => {
		const tools = webTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(["web_fetch", "web_search"]);
		for (const tool of tools) expect(tool.callers).toEqual(["tools"]);
	});

	it("accepts only http(s) public URLs", () => {
		expect(assertFetchableUrl("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
		expect(assertFetchableUrl("http://workspace:3000/", { allowHosts: ["workspace"] })).toBe("http://workspace:3000/");
		expect(() => assertFetchableUrl("http://10.253.0.2:3000/", { allowHosts: ["workspace"] })).toThrow();
		for (const url of [
			"http://localhost/",
			"http://192.168.1.1/",
			"http://[::1]/",
			"http://[fd00::1]/",
			"http://[::ffff:127.0.0.1]/",
			"http://crawl4ai-extract:8000/",
			"http://scrapling:8000/",
			"http://reader:8000/",
			"ftp://example.com/",
		]) {
			expect(() => assertFetchableUrl(url)).toThrow();
		}
	});
});
