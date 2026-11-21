// Notifications through ntfy: the settings (`NTFY_URL` is the topic's address), the message as ntfy takes it, and the
// sender's tries. When a user is told is the bridge's to decide (its own tests); this is what is sent, and where.
import { describe, expect, it } from "vitest";
import type { UserNotification } from "@mgabor3141/pi-durable-t3";
import { ntfyCheck, ntfyConfig, ntfyMessage, ntfySender } from "../src/ntfy.ts";

const notification: UserNotification = { kind: "completed", threadId: "thread 1", environmentId: "pi-abc", threadTitle: "Árvíztűrő tükörfúrógép 🚀", projectTitle: "claw", headline: "Agent finished" };

type Call = { readonly url: string; readonly init: RequestInit | undefined };
/** A server that answers each request with the next of `answers` (a status, or an error to throw). */
function server(answers: readonly (number | Error)[]) {
	const calls: Call[] = [];
	const request = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		const answer = answers[calls.length - 1] ?? 200;
		if (answer instanceof Error) throw answer;
		return new Response(answer === 200 ? '{"id":"x"}' : '{"code":40101,"http":401,"error":"unauthorized"}', { status: answer });
	}) as typeof fetch;
	return { calls, request };
}

describe("ntfy settings", () => {
	it("is off without NTFY_URL, blank included", () => {
		expect(ntfyConfig({})).toBeUndefined();
		expect(ntfyConfig({ NTFY_URL: "  ", NTFY_TOKEN: "tk_1" })).toBeUndefined();
	});

	it("reads the server and the topic from the topic's address", () => {
		expect(ntfyConfig({ NTFY_URL: "https://ntfy.example.com/claw" })).toEqual({ server: "https://ntfy.example.com/", topic: "claw" });
		expect(ntfyConfig({ NTFY_URL: "http://ntfy:80/claw_alerts-1/", NTFY_TOKEN: " tk_1 " })).toEqual({ server: "http://ntfy/", topic: "claw_alerts-1", token: "tk_1" });
		// A server behind a path of its own.
		expect(ntfyConfig({ NTFY_URL: "https://example.com/push/ntfy/claw" })).toEqual({ server: "https://example.com/push/ntfy/", topic: "claw" });
	});

	it("refuses an address that is not a topic's", () => {
		expect(() => ntfyConfig({ NTFY_URL: "ntfy.example.com/claw" })).toThrow("NTFY_URL must be an http(s) URL");
		expect(() => ntfyConfig({ NTFY_URL: "ntfy://ntfy.example.com/claw" })).toThrow("NTFY_URL must be an http(s) URL");
		expect(() => ntfyConfig({ NTFY_URL: "https://ntfy.example.com" })).toThrow("must end with the topic's name");
		expect(() => ntfyConfig({ NTFY_URL: "https://ntfy.example.com/my topic" })).toThrow("must end with the topic's name");
		expect(() => ntfyConfig({ NTFY_URL: "https://ntfy.example.com/claw?auth=abc" })).toThrow("a token goes in NTFY_TOKEN");
		// The refusal does not repeat what may be a credential.
		expect(() => ntfyConfig({ NTFY_URL: "https://me:secret@ntfy.example.com/claw" })).toThrow("https://ntfy.example.com/claw");
		expect(() => ntfyConfig({ NTFY_URL: "https://me:secret@ntfy.example.com/claw" })).not.toThrow("secret");
		expect(() => ntfyConfig({ NTFY_URL: "https://:secret@ntfy.example.com/claw" })).toThrow("a token goes in NTFY_TOKEN");
	});
});

describe("ntfy message", () => {
	const config = ntfyConfig({ NTFY_URL: "https://ntfy.example.com/claw", NTFY_TOKEN: "tk_1" })!;

	it("is titled with the thread, says what happened and where, and opens the thread in T3's phone app", () => {
		expect(ntfyMessage(config, notification)).toEqual({
			topic: "claw",
			title: "Árvíztűrő tükörfúrógép 🚀",
			message: "Agent finished: claw",
			click: "t3code://threads/pi-abc/thread%201",
		});
		expect(ntfyMessage(config, { ...notification, kind: "approval", headline: "Approval needed", projectTitle: "" }).message).toBe("Approval needed");
	});

	it("is published as JSON to the server, with the token", async () => {
		const { calls, request } = server([200]);
		await ntfySender(config, { fetch: request })(notification);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://ntfy.example.com/");
		expect(calls[0]!.init).toMatchObject({ method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tk_1" } });
		expect(JSON.parse(calls[0]!.init!.body as string)).toEqual(ntfyMessage(config, notification));
	});

	it("sends no authorization without a token", async () => {
		const { calls, request } = server([200]);
		await ntfySender(ntfyConfig({ NTFY_URL: "https://ntfy.example.com/claw" })!, { fetch: request })(notification);
		expect(calls[0]!.init!.headers).toEqual({ "content-type": "application/json" });
	});
});

describe("ntfy sender", () => {
	const config = ntfyConfig({ NTFY_URL: "https://ntfy.example.com/claw" })!;

	it("tries again when the server does not answer or cannot just now, three times in all", async () => {
		const down = server([new Error("connect ECONNREFUSED"), 502, 200]);
		await ntfySender(config, { fetch: down.request, retryAfterMs: [1, 1] })(notification);
		expect(down.calls).toHaveLength(3);

		const limited = server([429, 200]);
		await ntfySender(config, { fetch: limited.request, retryAfterMs: [1, 1] })(notification);
		expect(limited.calls).toHaveLength(2);

		const gone = server([503, new Error("connect ECONNREFUSED"), 503, 200]);
		await expect(ntfySender(config, { fetch: gone.request, retryAfterMs: [1, 1] })(notification)).rejects.toThrow("ntfy answered 503");
		expect(gone.calls).toHaveLength(3);
		const silent = server([new Error("timeout"), new Error("timeout"), new Error("timeout")]);
		await expect(ntfySender(config, { fetch: silent.request, retryAfterMs: [1, 1] })(notification)).rejects.toThrow("ntfy did not answer: timeout");
	});

	it("does not try again what ntfy refuses, and says what it answered", async () => {
		const refused = server([401, 200]);
		await expect(ntfySender(config, { fetch: refused.request, retryAfterMs: [1, 1] })(notification)).rejects.toThrow('ntfy answered 401: {"code":40101,"http":401,"error":"unauthorized"}');
		expect(refused.calls).toHaveLength(1);
	});
});

describe("ntfy at startup", () => {
	const config = ntfyConfig({ NTFY_URL: "https://ntfy.example.com/push/claw" })!;
	const logs = () => {
		const lines: string[] = [];
		return { lines, log: { info: (message: string) => void lines.push(`info ${message}`), warn: (message: string) => void lines.push(`warn ${message}`) } };
	};

	it("says whether the server answers, and starts either way", async () => {
		const up = server([200]);
		const said = logs();
		await ntfyCheck(config, said.log, up.request);
		expect(up.calls[0]!.url).toBe("https://ntfy.example.com/push/v1/health");
		expect(said.lines).toEqual(["info notifications on: ntfy answers"]);

		// Not there yet, or there and not well (ntfy answers 503 then).
		for (const answers of [[new Error("getaddrinfo ENOTFOUND")], [503]] as const) {
			const down = logs();
			await ntfyCheck(config, down.log, server(answers).request);
			expect(down.lines).toEqual(["warn notifications: ntfy does not answer yet; a notification is tried three times and then lost"]);
		}
		// Something answers there that is not ntfy: the address is wrong, not the server slow to start.
		const other = logs();
		await ntfyCheck(config, other.log, server([404]).request);
		expect(other.lines).toEqual(["warn notifications: what answers at NTFY_URL's server is not ntfy; is the address the topic's?"]);
	});
});
