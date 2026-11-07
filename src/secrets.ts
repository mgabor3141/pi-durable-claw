// The harness's secrets: named values the agent writes as `${NAME}` (`${NAME:-default}`) instead of the value, kept in
// an owner-only file beside the harness's data — never in `durable.db`, never in the model's context.
//
// The agent is trusted (it may use, and even read, its secrets); this is hygiene, not a boundary. A value is
// substituted inside a tool's execution, after the call's arguments are recorded, so the record keeps the placeholder;
// a shell command gets the secrets it names as environment variables instead; and every value that comes back in a
// tool's output is scrubbed to its placeholder before the model or the record sees it. Scrubbing matches exact
// values, so a transformed value (base64, a substring) passes, as GitHub Actions' masking does: it catches accidents.
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

/** A secret's name: an environment variable's, so a shell can use it as one. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Shorter values are not scrubbed: they would match unrelated output. */
const MIN_SCRUB_LENGTH = 8;
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]{0,127})(?::-([^}]*))?\}/g;

type Logger = { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
type Stored = { readonly secrets: Record<string, { value: string; updatedAt: string }> };

export class SecretStore {
	readonly #path: string;
	#secrets: Stored["secrets"] = {};
	readonly #listeners = new Set<() => void>();

	constructor(path: string) {
		this.#path = path;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
			this.#secrets = parsed.secrets ?? {};
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

	/** Called after every change (a server whose config names a secret reconnects with the new value). */
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

	/** The known secrets a shell command names (`$NAME` or `${NAME…}`). */
	referenced(command: string): string[] {
		return Object.keys(this.#secrets).filter((name) => new RegExp(`\\$(?:\\{${name}(?:[:}]|-)|${name}(?![A-Za-z0-9_]))`).test(command));
	}

	/** `text` with every secret value in it replaced by its placeholder. */
	scrub(text: string): string {
		const entries = Object.entries(this.#secrets).filter(([, entry]) => entry.value.length >= MIN_SCRUB_LENGTH).sort(([, a], [, b]) => b.value.length - a.value.length);
		let result = text;
		for (const [name, entry] of entries) if (result.includes(entry.value)) result = result.split(entry.value).join("${" + name + "}");
		return result;
	}

	#write(): void {
		const temporary = join(dirname(this.#path), `.secrets.${process.pid}.${Date.now()}.tmp`);
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeSync(fd, `${JSON.stringify({ secrets: this.#secrets }, null, 2)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.#path);
		for (const listener of this.#listeners) listener();
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
 * secrets it names exported in front of it; any other tool gets `${NAME}` replaced in its arguments. Output streamed
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
			} else {
				runArgs = mapStrings(args, (text) => {
					const result = store.substitute(text);
					for (const name of result.used) used.add(name);
					return result.text;
				});
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
		description:
			"The harness's secrets, by name. list: their names. set: save a value you already have (one you generated or received); to get one from the user, use request_secret instead, so it never enters the chat. delete: remove one. Use a secret by writing ${NAME} where its value goes (tool arguments, MCP config) or $NAME in a shell command; output shows ${NAME} where a value appeared.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("set"), Type.Literal("delete")]),
			name: Type.Optional(Type.String({ pattern: SECRET_NAME.source })),
			value: Type.Optional(Type.String()),
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
