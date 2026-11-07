import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Page } from "playwright-core";
import { assertFetchableUrl } from "./web.ts";
import {
	BROWSER_ACT_TOOL_DESCRIPTION,
	BROWSER_CLOSE_TOOL_DESCRIPTION,
	BROWSER_CLOSED_NOTE,
	BROWSER_OPEN_TOOL_DESCRIPTION,
	BROWSER_SCREENSHOT_NOTE,
	BROWSER_SCREENSHOT_TOOL_DESCRIPTION,
	BROWSER_SNAPSHOT_TOOL_DESCRIPTION,
	browserSnapshotPrompt,
	browserTruncationNote,
} from "./prompts.ts";

/**
 * An interactive browser for the workspace agent: the agent's page is a tab of T3's preview browser (Browserless
 * Chromium, attached by the bridge), the same page the user sees in the Browser panel. This module holds one page per
 * conversation and closes it after its maximum age. It is deliberately not the page reader: `web_fetch` is the cheap,
 * stateless path for reading, and this is for pages that need clicking, typing, JavaScript or a screenshot. Without
 * the preview browser there is no browser: the host does not offer these tools.
 */
// Browser-only allowlist for local dev servers (normally "workspace"). The page
// reader never sees this; web_fetch keeps rejecting all internal hosts.
const LOCAL_HOSTS = (process.env.BROWSER_LOCAL_HOSTS ?? "")
	.split(",")
	.map((host) => host.trim())
	.filter((host) => host !== "");

const NAVIGATION_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 15_000;
const OPEN_TIMEOUT_MS = 75_000;
const TOOL_TIMEOUT_MS = 60_000;
const SHARED_OPEN_TIMEOUT_MS = 50_000;
const CLOSE_TIMEOUT_MS = 10_000;
const MAX_SESSION_AGE_MS = 1_800_000;
const MAX_MESSAGE_CHARS = 10_000;
const MAX_SNAPSHOT_CHARS = 20_000;
const MAX_CONSOLE_LINES = 30;
const MAX_SCREENSHOT_BYTES = 4_000_000;
const MAX_EVALUATE_CHARS = 20_000;

export interface BrowserSnapshot {
	readonly sessionId: string;
	readonly url: string;
	readonly title: string;
	readonly text: string;
	readonly truncated: boolean;
	readonly console: readonly string[];
	/** Results of evaluate actions from this call, if any. */
	readonly evaluated?: string;
}

interface BrowserSession {
	readonly id: string;
	readonly conversationId: ConversationId;
	readonly page: Page;
	readonly closeShared: () => Promise<void>;
	readonly touchShared: () => void;
	readonly logs: string[];
	readonly createdAt: number;
	maxTimer: NodeJS.Timeout | undefined;
	closed: boolean;
}

/** A page owned elsewhere (T3's preview browser) and a way to close it. */
export interface SharedBrowserPage {
	readonly id: string;
	readonly page: Page;
	touch(): void;
	close(): Promise<void>;
}

/** Resolve a conversation's URL to a page of the user's T3 preview, or undefined when the conversation has no thread. */
export type SharedBrowserProvider = (conversationId: ConversationId, url: string) => Promise<SharedBrowserPage | undefined>;

function browserUrl(value: string): string {
	return assertFetchableUrl(value, { allowHosts: LOCAL_HOSTS });
}

function timeoutError(what: string, ms: number): Error {
	const error = new Error(`${what} timed out after ${String(ms)} ms`);
	error.name = "TimeoutError";
	return error;
}

function isToolTimeout(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

/** A dead browser target can leave a Playwright promise pending forever; bound every public tool call. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(timeoutError(what, ms)), ms);
		timer.unref();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function clip(value: string, max: number): { text: string; truncated: boolean } {
	return value.length > max ? { text: `${value.slice(0, max)}\n\n${browserTruncationNote(max, value.length)}`, truncated: true } : { text: value, truncated: false };
}

/** Keep browser logs bounded; a page can emit thousands of console lines. */
function recordLog(session: BrowserSession, line: string): void {
	session.logs.push(line.slice(0, 500));
	if (session.logs.length > MAX_CONSOLE_LINES) session.logs.splice(0, session.logs.length - MAX_CONSOLE_LINES);
}

/**
 * One page per conversation. Browserless gives each connection its own
 * Chromium, so the page is isolated from every other connection and the
 * browserless timeout is the unavoidable backstop if this process dies.
 */
export class BrowserSessions {
	private readonly sessions = new Map<string, BrowserSession>();
	private readonly byConversation = new Map<ConversationId, string>();
	private shared: SharedBrowserProvider | undefined;

	/** Use a page owned by the T3 preview, when one is available for the conversation. */
	useShared(provider: SharedBrowserProvider | undefined): void {
		this.shared = provider;
	}

	async open(
		conversationId: ConversationId,
		options: { url: string; waitMs?: number; maxChars?: number },
	): Promise<BrowserSnapshot> {
		try {
			return await withTimeout(this.#open(conversationId, options), OPEN_TIMEOUT_MS, "browser_open");
		} catch (error) {
			void withTimeout(this.closeConversation(conversationId), CLOSE_TIMEOUT_MS, "browser session close").catch(() => undefined);
			throw error;
		}
	}

	async #open(
		conversationId: ConversationId,
		options: { url: string; waitMs?: number; maxChars?: number },
	): Promise<BrowserSnapshot> {
		await withTimeout(this.closeConversation(conversationId), CLOSE_TIMEOUT_MS, "browser session close").catch(() => undefined);
		const targetUrl = browserUrl(options.url);
		// The page is T3's preview tab, the one the user sees; there is no other browser, so a failure here is the answer.
		if (this.shared === undefined) throw new Error("The browser is not ready: T3's preview browser has not attached yet.");
		const shared = await withTimeout(this.shared(conversationId, targetUrl), SHARED_OPEN_TIMEOUT_MS, "T3 preview browser open");
		if (shared === undefined) throw new Error("This conversation is not a T3 thread, so it has no browser panel to open a page in.");
		const page = shared.page;
		const session: BrowserSession = {
			id: shared.id,
			conversationId,
			page,
			closeShared: () => shared.close(),
			touchShared: () => shared.touch(),
			logs: [],
			createdAt: Date.now(),
			maxTimer: undefined,
			closed: false,
		};
		try {
			page.setDefaultTimeout(ACTION_TIMEOUT_MS);
			page.on("console", (message) => {
				if (message.type() === "error" || message.type() === "warning") recordLog(session, `${message.type()}: ${message.text()}`);
			});
			page.on("pageerror", (error) => recordLog(session, `pageerror: ${error.message}`));
			page.on("dialog", (dialog) => {
				recordLog(session, `dialog (${dialog.type()}): ${dialog.message()}`);
				void dialog.dismiss().catch(() => undefined);
			});
			page.on("close", () => {
				session.closed = true;
				if (session.maxTimer !== undefined) clearTimeout(session.maxTimer);
				this.forget(session);
			});
			if (options.waitMs !== undefined && options.waitMs > 0) await page.waitForTimeout(Math.min(options.waitMs, 10_000));

			this.sessions.set(session.id, session);
			this.byConversation.set(conversationId, session.id);
			this.armTimers(session);
			return this.snapshot(session, options.maxChars);
		} catch (error) {
			await shared.close().catch(() => undefined);
			throw error;
		}
	}

	async act(
		conversationId: ConversationId,
		sessionId: string,
		actions: readonly BrowserAction[],
		maxChars?: number,
	): Promise<BrowserSnapshot> {
		try {
			return await withTimeout(this.#act(conversationId, sessionId, actions, maxChars), TOOL_TIMEOUT_MS, "browser_act");
		} catch (error) {
			// An action timeout is a normal page result; the session is still usable. Only a hard tool timeout
			// means the page may be wedged enough to close it.
			if (isToolTimeout(error)) void withTimeout(this.closeConversation(conversationId), CLOSE_TIMEOUT_MS, "browser session close").catch(() => undefined);
			throw error;
		}
	}

	async #act(
		conversationId: ConversationId,
		sessionId: string,
		actions: readonly BrowserAction[],
		maxChars?: number,
	): Promise<BrowserSnapshot> {
		const session = this.require(conversationId, sessionId);
		this.touch(session);
		const evaluated: string[] = [];
		for (const [index, action] of actions.entries()) {
			try {
				const value = await this.perform(session, action);
				if (action.action === "evaluate") evaluated.push(clip(evaluateResult(value), MAX_EVALUATE_CHARS).text);
			} catch (error) {
				throw new Error(`action ${index + 1} (${action.action}) failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		await session.page.waitForTimeout(100);
		const snapshot = await this.snapshot(session, maxChars);
		return evaluated.length === 0 ? snapshot : { ...snapshot, evaluated: clip(evaluated.join("\n\n"), MAX_EVALUATE_CHARS).text };
	}

	async read(conversationId: ConversationId, sessionId: string, maxChars?: number): Promise<BrowserSnapshot> {
		try {
			return await withTimeout(this.#read(conversationId, sessionId, maxChars), TOOL_TIMEOUT_MS, "browser_snapshot");
		} catch (error) {
			if (isToolTimeout(error)) void withTimeout(this.closeConversation(conversationId), CLOSE_TIMEOUT_MS, "browser session close").catch(() => undefined);
			throw error;
		}
	}

	async #read(conversationId: ConversationId, sessionId: string, maxChars?: number): Promise<BrowserSnapshot> {
		const session = this.require(conversationId, sessionId);
		this.touch(session);
		return this.snapshot(session, maxChars);
	}

	async screenshot(conversationId: ConversationId, sessionId: string): Promise<Buffer> {
		try {
			return await withTimeout(this.#screenshot(conversationId, sessionId), TOOL_TIMEOUT_MS, "browser_screenshot");
		} catch (error) {
			if (isToolTimeout(error)) void withTimeout(this.closeConversation(conversationId), CLOSE_TIMEOUT_MS, "browser session close").catch(() => undefined);
			throw error;
		}
	}

	async #screenshot(conversationId: ConversationId, sessionId: string): Promise<Buffer> {
		const session = this.require(conversationId, sessionId);
		this.touch(session);
		return session.page.screenshot({ type: "png", fullPage: true });
	}

	async close(conversationId: ConversationId, sessionId: string): Promise<void> {
		try {
			await withTimeout(this.#close(conversationId, sessionId), CLOSE_TIMEOUT_MS, "browser_close");
		} catch (error) {
			if (isToolTimeout(error)) void withTimeout(this.closeConversation(conversationId), CLOSE_TIMEOUT_MS, "browser session close").catch(() => undefined);
			throw error;
		}
	}

	async #close(conversationId: ConversationId, sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session === undefined || session.conversationId !== conversationId) throw new Error(`no browser session ${sessionId}`);
		await this.closeSession(session);
	}

	private require(conversationId: ConversationId, sessionId: string): BrowserSession {
		const session = this.sessions.get(sessionId);
		if (session === undefined || session.conversationId !== conversationId) throw new Error(`no browser session ${sessionId}; call browser_open first`);
		return session;
	}

	private async snapshot(session: BrowserSession, maxChars = MAX_SNAPSHOT_CHARS): Promise<BrowserSnapshot> {
		const limit = Math.max(1, Math.min(maxChars, 100_000));
		const text = await session.page.locator("body").innerText().catch(() => "");
		const title = await session.page.title().catch(() => "");
		const clipped = clip(text.trim(), limit);
		return {
			sessionId: session.id,
			url: session.page.url(),
			title,
			text: clipped.text,
			truncated: clipped.truncated,
			console: session.logs.slice(-MAX_CONSOLE_LINES),
		};
	}

	private armTimers(session: BrowserSession): void {
		// A T3 preview tab has a human viewer, so it has no idle timer; the bridge's own sweep closes abandoned tabs.
		session.maxTimer = setTimeout(() => void this.closeSession(session), MAX_SESSION_AGE_MS);
		session.maxTimer.unref();
	}

	private touch(session: BrowserSession): void {
		session.touchShared();
	}

	private async closeConversation(conversationId: ConversationId): Promise<void> {
		const id = this.byConversation.get(conversationId);
		if (id === undefined) return;
		const session = this.sessions.get(id);
		if (session !== undefined) await this.closeSession(session);
	}

	private async closeSession(session: BrowserSession): Promise<void> {
		if (session.maxTimer !== undefined) clearTimeout(session.maxTimer);
		this.forget(session);
		if (session.closed) return;
		session.closed = true;
		await withTimeout(session.closeShared(), CLOSE_TIMEOUT_MS, "T3 preview tab close").catch(() => undefined);
	}

	private forget(session: BrowserSession): void {
		this.sessions.delete(session.id);
		if (this.byConversation.get(session.conversationId) === session.id) this.byConversation.delete(session.conversationId);
	}

	private async perform(session: BrowserSession, action: BrowserAction): Promise<unknown> {
		const page = session.page;
		switch (action.action) {
			case "goto":
				await page.goto(browserUrl(action.url), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
				return;
			case "click":
				await page.click(action.selector, { timeout: action.timeoutMs ?? ACTION_TIMEOUT_MS });
				return;
			case "fill":
				await page.fill(action.selector, action.text, { timeout: action.timeoutMs ?? ACTION_TIMEOUT_MS });
				return;
			case "press":
				await page.press(action.selector ?? "body", action.key, { timeout: action.timeoutMs ?? ACTION_TIMEOUT_MS });
				return;
			case "select":
				await page.selectOption(action.selector, action.value, { timeout: action.timeoutMs ?? ACTION_TIMEOUT_MS });
				return;
			case "wait_for":
				await page.waitForSelector(action.selector, { timeout: action.timeoutMs ?? ACTION_TIMEOUT_MS });
				return;
			case "wait":
				await page.waitForTimeout(Math.min(action.ms, 10_000));
				return;
			case "evaluate": {
				if (action.expression.length > MAX_MESSAGE_CHARS) throw new Error("expression is too long");
				const value = await page.evaluate(action.expression);
				recordLog(session, `evaluate: ${JSON.stringify(value).slice(0, 500)}`);
				return value;
			}
			case "back":
				await page.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
				return;
			case "forward":
				await page.goForward({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
				return;
			case "reload":
				await page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
				return;
		}
	}
}

type BrowserAction =
	| { action: "goto"; url: string }
	| { action: "click"; selector: string; timeoutMs?: number }
	| { action: "fill"; selector: string; text: string; timeoutMs?: number }
	| { action: "press"; key: string; selector?: string; timeoutMs?: number }
	| { action: "select"; selector: string; value: string; timeoutMs?: number }
	| { action: "wait_for"; selector: string; timeoutMs?: number }
	| { action: "wait"; ms: number }
	| { action: "evaluate"; expression: string }
	| { action: "back" | "forward" | "reload" };

const ActionSchema = Type.Union([
	Type.Object({ action: Type.Literal("goto"), url: Type.String({ minLength: 1, maxLength: 4_000 }) }),
	Type.Object({ action: Type.Literal("click"), selector: Type.String({ minLength: 1, maxLength: 2_000 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })) }),
	Type.Object({ action: Type.Literal("fill"), selector: Type.String({ minLength: 1, maxLength: 2_000 }), text: Type.String({ maxLength: MAX_MESSAGE_CHARS }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })) }),
	Type.Object({ action: Type.Literal("press"), key: Type.String({ minLength: 1, maxLength: 100 }), selector: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })) }),
	Type.Object({ action: Type.Literal("select"), selector: Type.String({ minLength: 1, maxLength: 2_000 }), value: Type.String({ maxLength: 2_000 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })) }),
	Type.Object({ action: Type.Literal("wait_for"), selector: Type.String({ minLength: 1, maxLength: 2_000 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })) }),
	Type.Object({ action: Type.Literal("wait"), ms: Type.Integer({ minimum: 0, maximum: 10_000 }) }),
	Type.Object({ action: Type.Literal("evaluate"), expression: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS }) }),
	Type.Object({ action: Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")]) }),
]);

const SnapshotSchema = Type.Object({
	sessionId: Type.String(),
	url: Type.String(),
	title: Type.String(),
	text: Type.String(),
	truncated: Type.Boolean(),
	console: Type.Array(Type.String()),
	evaluated: Type.Optional(Type.String()),
});

const ScreenshotSchema = Type.Object({
	type: Type.Literal("image"),
	data: Type.String({ minLength: 1 }),
	mimeType: Type.Literal("image/png"),
	bytes: Type.Integer({ minimum: 1 }),
});

/** Turn an evaluate result into bounded text the model can read. */
function evaluateResult(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function snapshotStructured(snapshot: BrowserSnapshot): JsonValue {
	return {
		sessionId: snapshot.sessionId,
		url: snapshot.url,
		title: snapshot.title,
		text: snapshot.text,
		truncated: snapshot.truncated,
		console: [...snapshot.console],
		...(snapshot.evaluated === undefined ? {} : { evaluated: snapshot.evaluated }),
	} as unknown as JsonValue;
}

const sessions = new BrowserSessions();

/** Let agent browser pages use T3's preview browser (set once the T3 bridge has been attached). */
export function setSharedBrowser(provider: SharedBrowserProvider | undefined): void {
	sessions.useShared(provider);
}

export function browserTools(): ToolRegistration[] {
	return [
		defineTool({
			name: "browser_open",
			description: BROWSER_OPEN_TOOL_DESCRIPTION,
			parameters: Type.Object({
				url: Type.String({ minLength: 1, maxLength: 4_000 }),
				wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
				max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
			}),
			structuredOutputSchema: SnapshotSchema,
			callers: ["tools"],
			async execute(args, api) {
				const snapshot = await sessions.open(api.conversationId, {
					url: args.url,
					...(args.wait_ms === undefined ? {} : { waitMs: args.wait_ms }),
					...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }),
				});
				return { output: [{ type: "text", text: browserSnapshotPrompt(snapshot) }], structuredOutput: snapshotStructured(snapshot), details: { sessionId: snapshot.sessionId } };
			},
		}),
		defineTool({
			name: "browser_act",
			description: BROWSER_ACT_TOOL_DESCRIPTION,
			parameters: Type.Object({
				session_id: Type.String({ minLength: 1, maxLength: 100 }),
				actions: Type.Array(ActionSchema, { minItems: 1, maxItems: 20 }),
				max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
			}),
			structuredOutputSchema: SnapshotSchema,
			callers: ["tools"],
			async execute(args, api) {
				const snapshot = await sessions.act(api.conversationId, args.session_id, args.actions as BrowserAction[], args.max_chars);
				return { output: [{ type: "text", text: browserSnapshotPrompt(snapshot) }], structuredOutput: snapshotStructured(snapshot), details: { sessionId: snapshot.sessionId } };
			},
		}),
		defineTool({
			name: "browser_snapshot",
			description: BROWSER_SNAPSHOT_TOOL_DESCRIPTION,
			parameters: Type.Object({
				session_id: Type.String({ minLength: 1, maxLength: 100 }),
				max_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
			}),
			structuredOutputSchema: SnapshotSchema,
			callers: ["tools"],
			async execute(args, api) {
				const snapshot = await sessions.read(api.conversationId, args.session_id, args.max_chars);
				return { output: [{ type: "text", text: browserSnapshotPrompt(snapshot) }], structuredOutput: snapshotStructured(snapshot), details: { sessionId: snapshot.sessionId } };
			},
		}),
		defineTool({
			name: "browser_screenshot",
			description: BROWSER_SCREENSHOT_TOOL_DESCRIPTION,
			parameters: Type.Object({ session_id: Type.String({ minLength: 1, maxLength: 100 }) }),
			structuredOutputSchema: ScreenshotSchema,
			outputLimits: { maxBytes: 4_500_000 },
			callers: ["tools"],
			async execute(args, api) {
				const png = await sessions.screenshot(api.conversationId, args.session_id);
				if (png.length > MAX_SCREENSHOT_BYTES) throw new Error(`screenshot is too large (${png.length} bytes); the page is too tall`);
				const data = png.toString("base64");
				return {
					output: [{ type: "text", text: BROWSER_SCREENSHOT_NOTE }],
					structuredOutput: { type: "image", data, mimeType: "image/png", bytes: png.length },
					details: { sessionId: args.session_id, bytes: png.length },
				};
			},
		}),
		defineTool({
			name: "browser_close",
			description: BROWSER_CLOSE_TOOL_DESCRIPTION,
			parameters: Type.Object({ session_id: Type.String({ minLength: 1, maxLength: 100 }) }),
			structuredOutputSchema: Type.Object({ closed: Type.Boolean() }),
			callers: ["tools"],
			async execute(args, api) {
				await sessions.close(api.conversationId, args.session_id);
				return { output: [{ type: "text", text: BROWSER_CLOSED_NOTE }], structuredOutput: { closed: true } };
			},
		}),
	];
}