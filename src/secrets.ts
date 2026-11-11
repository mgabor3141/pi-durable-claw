// The harness's secrets: named values the agent writes as `${NAME}` (`default`) instead of the value, kept in
// an owner-only file beside the harness's data — never in `durable.db`, never in the model's context.
//
// The agent is trusted (it may use, and even read, its secrets); this is hygiene, not a boundary. A value is
// substituted inside a tool's execution, after the call's arguments are recorded, so the record keeps the placeholder;
// a shell command gets the secrets it names as environment variables instead; and every value that comes back in a
// tool's output is scrubbed to its placeholder before the model or the record sees it. Scrubbing matches exact
// values, so a transformed value (base64, a substring) passes, as GitHub Actions' masking does: it catches accidents.
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { SECRETS_TOOL_DESCRIPTION } from "./prompts.ts";
import { opt, str, union } from "@earendil-works/pi-schema";
import { literal, object } from "./schema.ts";

/** A secret's name: an environment variable's, so a shell can use it as one. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Shorter values are not scrubbed: they would match unrelated output. */
const MIN_SCRUB_LENGTH = 8;
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]{0,127})(?::-([^}]*))?\}/g;

type Logger = { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
type Stored = {
	readonly secrets: Record<string, { value: string; updatedAt: string }>;
	/** Each MCP server's OAuth sign-in (`mcp/oauth.ts`): its client, tokens, and a pending authorization. */
	readonly oauth?: Record<string, McpOAuthState>;
};

export class SecretStore {
	readonly #path: string;
	#secrets: Stored["secrets"] = {};
	#oauth: NonNullable<Stored["oauth"]> = {};
	readonly #listeners = new Set<() => void>();

	constructor(path: string) {
		this.#path = path;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
			this.#secrets = parsed.secrets ?? {};
			this.#oauth = parsed.oauth ?? {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read the secrets file ${path}: ${(error as Error).message}`);
		}
	}

	names(): { name: string; updatedAt: string }[] {
		return Object.entries(this.#secrets).map(([name, entry]) => ({ name, updatedAt: entry.updatedAt })).sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): string | undefined {
		return this.#secrets[name]?.value;
	}

	async save(name: string, value: string): Promise<void> {
		if (!SECRET_NAME.test(name)) throw new Error(`Not a secret name: ${name}. Use an environment variable's name, like GITHUB_TOKEN.`);
		this.#secrets = { ...this.#secrets, [name]: { value, updatedAt: new Date().toISOString() } };
		this.#write();
	}

	async delete(name: string): Promise<boolean> {
		if (this.#secrets[name] === undefined) return false;
		const { [name]: _removed, ...rest } = this.#secrets;
		this.#secrets = rest;
		this.#write();
		return true;
	}

	oauthState(server: string): McpOAuthState | undefined {
		return this.#oauth[server];
	}

	oauthServers(): string[] {
		return Object.keys(this.#oauth);
	}

	/** Saved without telling `subscribe`rs: a refreshed token is not a changed secret. `undefined` forgets the sign-in. */
	async saveOAuthState(server: string, state: McpOAuthState | undefined): Promise<void> {
		const { [server]: _previous, ...rest } = this.#oauth;
		this.#oauth = state === undefined ? rest : { ...rest, [server]: state };
		this.#write(false);
	}

	/** Called after every change of a named secret (a server whose config names one reconnects with the new value). */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** `text` with each `${NAME}` of a known secret replaced by its value (an unknown name with a default, by the default;
	 * an unknown name without one is left as it is). Answers the secrets it used. */
	substitute(text: string): { text: string; used: string[]; missing: string[] } {
		const used = new Set<string>();
		const missing = new Set<string>();
		const result = text.replace(PLACEHOLDER, (match, name: string, fallback: string | undefined) => {
			const value = this.get(name);
			if (value !== undefined) {
				used.add(name);
				return value;
			}
			if (fallback !== undefined) return fallback;
			missing.add(name);
			return match;
		});
		return { text: result, used: [...used], missing: [...missing] };
	}

	/** Replace `${NAME}` only where NAME is a secret: every other `${...}` (a fallback included) is left as written, : a
	 * tool's arguments (a file's content, a remote shell's command). */
	substituteKnown(text: string, used: Set<string>): string {
		return text.replace(PLACEHOLDER, (match, name: string) => {
			const value = this.get(name);
			if (value === undefined) return match;
			used.add(name);
			return value;
		});
	}

	/** The secrets a command names bare, as `$NAME` (not `${NAME}`). */
	namedBare(command: string): string[] {
		return Object.keys(this.#secrets).filter((name) => new RegExp(`\\$${name}(?![A-Za-z0-9_])`).test(command));
	}

	/** The known secrets a shell command names (`$NAME` or `${NAME…}`). */
	referenced(command: string): string[] {
		return Object.keys(this.#secrets).filter((name) => new RegExp(`\\$(?:\\{${name}(?:[:}]|-)|${name}(?![A-Za-z0-9_]))`).test(command));
	}

	/** `text` with every secret value in it replaced by its placeholder, and every OAuth token or client secret by a
	 * marker naming its server. */
	scrub(text: string): string {
		const values: [string, string][] = Object.entries(this.#secrets).map(([name, entry]) => [entry.value, "${" + name + "}"]);
		for (const [server, state] of Object.entries(this.#oauth)) {
			const marker = `[${server} OAuth credential]`;
			for (const value of [state.tokens?.access_token, state.tokens?.refresh_token, (state.clientInformation as { client_secret?: string } | undefined)?.client_secret]) {
				if (value !== undefined) values.push([value, marker]);
			}
		}
		let result = text;
		for (const [value, placeholder] of values.filter(([value]) => value.length >= MIN_SCRUB_LENGTH).sort(([a], [b]) => b.length - a.length)) {
			if (result.includes(value)) result = result.split(value).join(placeholder);
		}
		return result;
	}

	#write(notify = true): void {
		const temporary = join(dirname(this.#path), `.secrets.${process.pid}.${Date.now()}.tmp`);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeSync(fd, `${JSON.stringify({ secrets: this.#secrets, oauth: this.#oauth }, null, 2)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.#path);
		if (notify) for (const listener of this.#listeners) listener();
	}
}

/** Every string in a JSON value, mapped. */
function mapStrings<T>(value: T, map: (text: string) => string): T {
	if (typeof value === "string") return map(value) as T;
	if (Array.isArray(value)) return value.map((item) => mapStrings(item, map)) as T;
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)])) as T;
	return value;
}

/** A single-quoted shell word. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * `tool` with the secrets resolved where it runs and scrubbed from what it returns. A shell command (`bash`) gets the
 * secrets it names exported in front of it. A remote command (`ssh`) gets `${NAME}` replaced where NAME is a secret,
 * and everything else left to the remote shell; a bare `$NAME` of a secret is refused, since an export cannot reach
 * that shell. Any other tool gets `${NAME}` replaced in its arguments. Output streamed
 * while it runs and its result are scrubbed. Each use is logged (names only).
 */
export function withSecrets(tool: ToolRegistration, store: SecretStore, log: Logger): ToolRegistration {
	return {
		...tool,
		async execute(args, api, context) {
			const used = new Set<string>();
			let runArgs = args;
			if (tool.name === "bash" && typeof (args as { command?: unknown }).command === "string") {
				const command = (args as { command: string }).command;
				const names = store.referenced(command);
				for (const name of names) used.add(name);
				if (names.length > 0) runArgs = { ...(args as object), command: `${names.map((name) => `export ${name}=${shellQuote(store.get(name)!)}`).join("; ")}; ${command}` } as typeof args;
			} else if (tool.name === "ssh" && typeof (args as { command?: unknown }).command === "string") {
				const command = (args as { command: string }).command;
				const bare = store.namedBare(command);
				if (bare.length > 0) {
					throw new Error(`ssh: write ${bare.map((name) => `\${${name}}`).join(", ")} to put the secret${bare.length === 1 ? "" : "s"} into the remote command; $${bare[0]} would be the remote shell's own variable`);
				}
				runArgs = mapStrings(args, (text) => store.substituteKnown(text, used));
			} else {
				// Only the names of secrets: anything else that looks like a template (a compose or shell default such as
				// `${PORT:-8080}` in a file being written) is the tool's text, left as written. Defaults for unknown names
				// are `.mcp.json`'s expansion (`substitute`), not a tool argument's.
				runArgs = mapStrings(args, (text) => store.substituteKnown(text, used));
			}
			if (used.size > 0) log.info("secrets used", { tool: tool.name, names: [...used], conversationId: api.conversationId });
			const scrubbing = new Proxy(api, {
				get(target, key, receiver) {
					if (key !== "output") return Reflect.get(target, key, receiver);
					return (chunk: string | Uint8Array, skipped?: never) =>
						target.output(typeof chunk === "string" ? store.scrub(chunk) : new TextEncoder().encode(store.scrub(new TextDecoder().decode(chunk))), skipped);
				},
			}) as ToolExecutionApi;
			try {
				const result = (await tool.execute(runArgs as never, scrubbing as never, context)) as ToolExecutionResult<JsonValue>;
				return mapStrings(result, (text) => store.scrub(text));
			} catch (error) {
				if (error instanceof Error) error.message = store.scrub(error.message);
				throw error;
			}
		},
	} as ToolRegistration;
}

/** The agent's own tool for its secrets: list their names, set one it already has, delete one. Scripts only. */
export function secretsTool(store: SecretStore): ToolRegistration {
	return defineTool({
		name: "secrets",
		description: SECRETS_TOOL_DESCRIPTION,
		parameters: object({
			action: union([literal("list"), literal("set"), literal("delete")]),
			name: opt(str({ pattern: SECRET_NAME.source })),
			value: opt(str()),
		}),
		callers: ["tools"],
		async execute(args) {
			const answer = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
			if (args.action === "list") return answer({ secrets: store.names() });
			if (args.name === undefined) throw new Error(`${args.action} needs a name.`);
			if (args.action === "delete") return answer({ deleted: await store.delete(args.name) });
			if (args.value === undefined || args.value === "") throw new Error("set needs a value.");
			await store.save(args.name, args.value);
			return answer({ saved: args.name });
		},
	});
}
