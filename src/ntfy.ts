// Notifications on your phone, through ntfy (https://ntfy.sh): a server you run, as with the other services. The bridge
// decides when a user who is not looking at T3 is told (`notifyUser`: a thread needs them, failed or finished, and no
// T3 client showed them so); this sends it to one topic. Tapping it opens the thread in T3's phone app.
//
// Like every outside service it is on only when configured (`NTFY_URL`): without it nobody is told, and the host logs
// that at start.
import type { UserNotification } from "@mgabor3141/pi-durable-t3";
import { setting, type Env } from "./env.ts";

export interface NtfyConfig {
	/** The server's address, with a trailing slash: where a message is published. */
	readonly server: string;
	readonly topic: string;
	/** An access token, when the topic needs one. */
	readonly token?: string;
}

/** The configuration from the environment: `NTFY_URL` is the topic's own address, as ntfy's apps show it
 * (`https://ntfy.example.com/claw`). A malformed one fails loudly. */
export function ntfyConfig(env: Env): NtfyConfig | undefined {
	const value = setting(env, "NTFY_URL");
	if (value === undefined) return undefined;
	if (!URL.canParse(value) || !/^https?:$/u.test(new URL(value).protocol)) throw new Error(`NTFY_URL must be an http(s) URL: ${value}`);
	const url = new URL(value);
	if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") throw new Error(`NTFY_URL is the topic's address and nothing more (a token goes in NTFY_TOKEN): ${url.origin}${url.pathname}`);
	const path = url.pathname.split("/").filter((part) => part !== "");
	const topic = path.pop();
	// ntfy's own rule for a topic's name.
	if (topic === undefined || !/^[-_A-Za-z0-9]{1,64}$/u.test(topic)) throw new Error(`NTFY_URL must end with the topic's name (letters, digits, "-" and "_"), as in https://ntfy.example.com/claw: ${value}`);
	const token = setting(env, "NTFY_TOKEN");
	return { server: `${url.origin}/${path.map((part) => `${part}/`).join("")}`, topic, ...(token === undefined ? {} : { token }) };
}

interface Log {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

/** At startup: say whether the server answers, and as ntfy does. Not fatal; it may come up after the harness. */
export async function ntfyCheck(config: NtfyConfig, log: Log, request: typeof fetch = fetch): Promise<void> {
	let response: Response;
	try {
		response = await request(`${config.server}v1/health`, { signal: AbortSignal.timeout(5_000) });
	} catch (error) {
		log.warn("notifications: ntfy does not answer yet; a notification is tried three times and then lost", { server: config.server, error: (error as Error).message });
		return;
	}
	await response.body?.cancel().catch(() => {});
	if (response.ok) log.info("notifications on: ntfy answers", { server: config.server, topic: config.topic });
	// Nothing is there: the address is another server's, or lacks the path ntfy is served under.
	else if (response.status === 404) log.warn("notifications: what answers at NTFY_URL's server is not ntfy; is the address the topic's?", { server: config.server });
	else log.warn("notifications: ntfy does not answer yet; a notification is tried three times and then lost", { server: config.server, error: `HTTP ${response.status}` });
}

/** The message as ntfy takes it in JSON (titles are not ASCII, which a header would have to be). T3's own phone
 * alert reads the same: the thread as the title, then what happened and in which project. */
export function ntfyMessage(config: NtfyConfig, notification: UserNotification): Record<string, string> {
	return {
		topic: config.topic,
		title: notification.threadTitle,
		message: notification.projectTitle === "" ? notification.headline : `${notification.headline}: ${notification.projectTitle}`,
		// T3's phone app opens the thread (its `t3code://threads/<environment>/<thread>` links).
		click: `t3code://threads/${encodeURIComponent(notification.environmentId)}/${encodeURIComponent(notification.threadId)}`,
	};
}

/** How long after a failed try the next one is made: a server that restarts is back within seconds. */
const RETRY_AFTER_MS = [1_000, 5_000];

/** The bridge's `notifyUser`: publish the notification, trying again when the server does not answer or answers that
 * it cannot just now. What ntfy refuses (a bad token, no access to the topic) is not tried again. */
export function ntfySender(config: NtfyConfig, options: { readonly fetch?: typeof fetch; readonly retryAfterMs?: readonly number[] } = {}): (notification: UserNotification) => Promise<void> {
	const request = options.fetch ?? fetch;
	const retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
	/** One try: nothing when it was taken, else why not and whether another try may do better. */
	const publish = async (body: string): Promise<{ readonly why: string; readonly again: boolean } | undefined> => {
		let response: Response;
		try {
			response = await request(config.server, {
				method: "POST",
				headers: { "content-type": "application/json", ...(config.token === undefined ? {} : { authorization: `Bearer ${config.token}` }) },
				body,
				signal: AbortSignal.timeout(10_000),
			});
		} catch (error) {
			return { why: `ntfy did not answer: ${(error as Error).message}`, again: true };
		}
		// Read either way: an answer left unread keeps its connection.
		const said = (await response.text().catch(() => "")).slice(0, 200);
		if (response.ok) return undefined;
		return { why: `ntfy answered ${response.status}: ${said}`, again: response.status >= 500 || response.status === 429 };
	};
	return async (notification) => {
		const body = JSON.stringify(ntfyMessage(config, notification));
		for (let attempt = 0; ; attempt++) {
			const failed = await publish(body);
			if (failed === undefined) return;
			const wait = failed.again ? retryAfterMs[attempt] : undefined;
			if (wait === undefined) throw new Error(failed.why);
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	};
}
