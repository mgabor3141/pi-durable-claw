// `ssh`: bash running one ssh command line, so a script hands over the remote command as a plain string. The host and
// the command each reach ssh as one argument, exactly as given; secrets go in as ${NAME} only, and everything else is
// left to the remote shell.
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import { SecretStore, withSecrets } from "../src/secrets.ts";
import { sshCommandLine, workspaceTools } from "../src/tools.ts";
import { object } from "../src/schema.ts";

/** What ssh would get: the line run by bash, with `ssh` a function that prints its arguments, one per line. */
const argv = (line: string) =>
	execFileSync("bash", ["-c", `ssh() { printf '%s\\0' "$@"; }; ${line}`], { encoding: "utf8" }).split("\0").slice(0, -1);

describe("the ssh command line", () => {
	it("passes the host and the remote command as one argument each, exactly as given", () => {
		const command = `cd /srv && grep -c "it's" 'a b' | awk '{print $1}'; echo "$HOME" \`date\` 80 \\n; exit 3`;
		expect(argv(sshCommandLine("deploy@web-1", command))).toEqual(["-n", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "--", "deploy@web-1", command]);
		expect(argv(sshCommandLine("ssh://me@host:2222", "uptime")).slice(-2)).toEqual(["ssh://me@host:2222", "uptime"]);
	});

	it("refuses what is not a host, and an empty command", () => {
		expect(() => sshCommandLine("-oProxyCommand=evil", "true")).toThrow("is not a host");
		expect(() => sshCommandLine("two words", "true")).toThrow("is not a host");
		expect(() => sshCommandLine("", "true")).toThrow("is not a host");
		expect(() => sshCommandLine("host", "  ")).toThrow("the command is empty");
	});

	it("runs through bash in the environment, with bash's result", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdc-ssh-run-"));
		// A fake ssh first on PATH: prints its arguments, one per line, and fails as a refused connection would not.
		await writeFile(join(dir, "ssh"), "#!/bin/sh\nfor a in \"$@\"; do printf '<%s>\\n' \"$a\"; done\nexit 7\n");
		await chmod(join(dir, "ssh"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${dir}:${path}`;
		try {
			const ssh = workspaceTools().find((tool) => tool.name === "ssh")!;
			let output = "";
			const api = {
				env: new NodeExecutionEnv({ cwd: dir }),
				output: (text: string) => void (output += text),
				retainedOutput: () => ({ text: output, truncated: false }),
				diagnostic: () => {},
			};
			const result = (await ssh.execute({ host: "web-1", command: "echo \"it's $HOME\"" } as never, api as never, {} as never)) as {
				structuredOutput: { output: string; exitCode: number };
				isError?: boolean;
			};
			expect(result.structuredOutput).toEqual({ output: "<-n>\n<-o>\n<BatchMode=yes>\n<-o>\n<StrictHostKeyChecking=accept-new>\n<-->\n<web-1>\n<echo \"it's $HOME\">\n", truncated: false, exitCode: 7 });
			expect(result.isError).toBe(true);
		} finally {
			process.env.PATH = path;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("is a workspace tool only scripts call, with bash's result", () => {
		const ssh = workspaceTools().find((tool) => tool.name === "ssh")!;
		const bash = workspaceTools().find((tool) => tool.name === "bash")!;
		expect(ssh.callers).toEqual(["tools"]);
		expect(ssh.structuredOutputSchema).toEqual(bash.structuredOutputSchema);
	});
});

describe("secrets in a remote command", () => {
	const dirs: string[] = [];
	afterEach(async () => void (await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))));
	const log = { info: () => {}, warn: () => {} };
	const api = () => ({ conversationId: 7, output: () => {} });
	async function setup() {
		const dir = await mkdtemp(join(tmpdir(), "pdc-ssh-"));
		dirs.push(dir);
		const secrets = new SecretStore(join(dir, "secrets.json"));
		await secrets.save("DEPLOY_TOKEN", "tok_0123456789abcdef");
		const seen: unknown[] = [];
		const tool = {
			name: "ssh",
			description: "fake",
			parameters: object({}),
			async execute(args: unknown) {
				seen.push(args);
				return { output: [{ type: "text", text: JSON.stringify(args) }] };
			},
		} as unknown as ToolRegistration;
		return { wrapped: withSecrets(tool, secrets, log), seen };
	}

	it("replaces ${NAME} of a secret, leaves the remote shell's own variables, and scrubs the result", async () => {
		const { wrapped, seen } = await setup();
		const command = 'curl -H "Authorization: Bearer ${DEPLOY_TOKEN}" localhost:8080 -o "$HOME/out"';
		const result = await wrapped.execute({ host: "web-1", command } as never, api() as never, {} as never);
		expect(seen[0]).toEqual({ host: "web-1", command: 'curl -H "Authorization: Bearer tok_0123456789abcdef" localhost:8080 -o "$HOME/out"' });
		expect(JSON.stringify(result)).not.toContain("tok_0123456789abcdef");
	});

	it("refuses a secret named bare: an export cannot reach the remote shell", async () => {
		const { wrapped, seen } = await setup();
		await expect(wrapped.execute({ host: "web-1", command: "echo $DEPLOY_TOKEN" } as never, api() as never, {} as never)).rejects.toThrow(
			"ssh: write ${DEPLOY_TOKEN} to put the secret into the remote command; $DEPLOY_TOKEN would be the remote shell's own variable",
		);
		expect(seen).toEqual([]);
		// A name that only starts with a secret's is not that secret.
		await wrapped.execute({ host: "web-1", command: "echo $DEPLOY_TOKEN_2" } as never, api() as never, {} as never);
		expect(seen).toHaveLength(1);
	});
});
