// A failed browser action must not discard the page: an element timeout is a normal tool error, and the next call
// should be able to inspect the same form. This protects the session from the hard tool timeout path.
import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import { BrowserSessions, type SharedBrowserProvider } from "../src/browser.ts";

function fakePage(): Page {
	return {
		setDefaultTimeout: () => undefined,
		on: () => undefined,
		url: () => "https://example.com/",
		title: async () => "Example",
		locator: () => ({ innerText: async () => "body text" }),
		fill: async () => {
			throw new Error("fill timeout");
		},
	} as unknown as Page;
}

describe("browser sessions", () => {
	it("keeps the session after an ordinary action failure", async () => {
		const page = fakePage();
		const shared: SharedBrowserProvider = async () => ({
			id: "shared",
			page,
			touch: () => undefined,
			close: async () => undefined,
		});
		const sessions = new BrowserSessions();
		sessions.useShared(shared);
		const opened = await sessions.open(1 as never, { url: "https://example.com", maxChars: 100 });
		expect(opened.sessionId).toBe("shared");
		await expect(sessions.act(1 as never, "shared", [{ action: "fill", selector: "#hidden", text: "x" }])).rejects.toThrow("fill timeout");
		const after = await sessions.read(1 as never, "shared", 100);
		expect(after.text).toBe("body text");
	});
});
