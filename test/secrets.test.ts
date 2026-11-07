// The harness's secrets: substituted where a tool runs (exported to a shell command instead), scrubbed from what the
// tool returns and streams, kept owner-only on disk.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SecretStore, secretsTool, withSecrets } from "../src/secrets.ts";

const dirs: string[] = [];
afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));
async function store() {
	const dir = await mkdtemp(join(tmpdir(), "pdc-secrets-"));
	dirs.push(dir);
	const path = join(dir, "secrets.json");
	const secrets = new SecretStore(path);
	await secrets.save("GITHUB_TOKEN", "ghp_0123456789abcdef");
	await secrets.save("PIN", "1234");
	return { secrets, path };
}
const logs: unknown[] = [];
const log = { info: (message: string, fields?: unknown) => void logs.push([message, fields]), warn: () => {} };

/** A tool that echoes its arguments, streams one chunk, and returns them. */
function echo(name: string): ToolRegistration & { seen: unknown[]; streamed: unknown[] } {
	const seen: unknown[] = [];
	const streamed: unknown[] = [];
	return {
		seen,
		streamed,
		name,
		description: "echo",
		parameters: Type.Object({}),
		async execute(args: unknown, api: { output(chunk: string): void }) {
			seen.push(args);
			api.output(JSON.stringify(args));
			return { output: [{ type: "text", text: JSON.stringify(args) }], details: { args } };
		},
	} as never;
}
const api = (streamed: unknown[]) => ({ conversationId: 7, output: (chunk: string) => void streamed.push(chunk) }) as never;

it("substitutes known names (and defaults), leaves other templates alone, and scrubs values back", async () => {
	const { secrets, path } = await store();
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(secrets.substitute("Bearer ${GITHUB_TOKEN}").text).toBe("Bearer ghp_0123456789abcdef");
	expect(secrets.substitute("${NOPE:-fallback} ${NOPE} ${{ secrets.X }}")).toMatchObject({ text: "fallback ${NOPE} ${{ secrets.X }}", missing: ["NOPE"] });
	expect(secrets.scrub("token=ghp_0123456789abcdef pin=1234")).toBe("token=${GITHUB_TOKEN} pin=1234");
	expect(secrets.referenced('curl -H "Authorization: Bearer $GITHUB_TOKEN" && echo ${PIN:-0}')).toEqual(["GITHUB_TOKEN", "PIN"]);
	expect(secrets.referenced("echo $GITHUB_TOKENS")).toEqual([]);
	// A new store reads what was saved.
	expect(new SecretStore(path).get("GITHUB_TOKEN")).toBe("ghp_0123456789abcdef");
});

it("a tool gets the value where it runs; the model and the record see the placeholder", async () => {
	const { secrets } = await store();
	const tool = echo("web_fetch");
	const wrapped = withSecrets(tool, secrets, log);
	const streamed: unknown[] = [];
	const result = await wrapped.execute({ url: "https://api.github.com", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } as never, api(streamed), {} as never);
	expect(tool.seen[0]).toEqual({ url: "https://api.github.com", headers: { Authorization: "Bearer ghp_0123456789abcdef" } });
	expect(JSON.stringify(result)).not.toContain("ghp_0123456789abcdef");
	expect(JSON.stringify(result)).toContain("Bearer ${GITHUB_TOKEN}");
	expect(JSON.stringify(streamed)).not.toContain("ghp_0123456789abcdef");
	expect(logs).toContainEqual(["secrets used", { tool: "web_fetch", names: ["GITHUB_TOKEN"], conversationId: 7 }]);
});

it("a shell command gets the secrets it names as environment variables, not as text", async () => {
	const { secrets } = await store();
	const tool = echo("bash");
	await withSecrets(tool, secrets, log).execute({ command: 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com' } as never, api([]), {} as never);
	expect((tool.seen[0] as { command: string }).command).toBe("export GITHUB_TOKEN='ghp_0123456789abcdef'; curl -H \"Authorization: Bearer $GITHUB_TOKEN\" https://api.github.com");
});

it("scripts list, set and delete secrets by name", async () => {
	const { secrets } = await store();
	const tool = secretsTool(secrets);
	const run = async (args: unknown) => JSON.parse(((await tool.execute(args as never, {} as never, {} as never)) as { output: { text: string }[] }).output[0]!.text);
	expect((await run({ action: "list" })).secrets.map((entry: { name: string }) => entry.name)).toEqual(["GITHUB_TOKEN", "PIN"]);
	expect(await run({ action: "set", name: "OPENAI_API_KEY", value: "sk-test-abcdefgh" })).toEqual({ saved: "OPENAI_API_KEY" });
	expect(secrets.get("OPENAI_API_KEY")).toBe("sk-test-abcdefgh");
	expect(await run({ action: "delete", name: "PIN" })).toEqual({ deleted: true });
});
