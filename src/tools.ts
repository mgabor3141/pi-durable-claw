import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { Type } from "@earendil-works/pi-ai";
import { SSH_TOOL_DESCRIPTION } from "./prompts.ts";

/**
 * The workspace's files and shell: pi-durable's own coding tools, unchanged except `callers: ["tools"]` — the model
 * is never offered them, only codemode scripts call them. They run against the call's `ExecutionEnv`, which the
 * harness builds as pi-env's `RemoteExecutionEnv` over SSH to the workspace container. `ssh` is `bash` running one
 * `ssh` command line, so a script passes the remote command as a plain string instead of quoting it twice.
 */
export function workspaceTools(): ToolRegistration[] {
	return [
		{ ...createReadTool(), callers: ["tools"] as const },
		{ ...createWriteTool(), callers: ["tools"] as const },
		{ ...createEditTool(), callers: ["tools"] as const },
		{ ...createBashTool(), callers: ["tools"] as const },
		sshTool(),
	];
}

/** A single-quoted shell word: the shell passes it on exactly as it is. */
const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * The command line `ssh` runs in the workspace. The host and the remote command are each one quoted word, so the remote
 * shell receives the command exactly as given. `-n`: no stdin (nothing to read from, and nothing to hang on);
 * `BatchMode`: never prompt, so a password or an unknown host key fails at once (exit 255) instead of waiting.
 */
export function sshCommandLine(host: string, command: string): string {
	if (host === "" || /\s/.test(host) || host.startsWith("-")) {
		throw new Error(`ssh: ${JSON.stringify(host)} is not a host: give a name from ~/.ssh/config, user@host, or ssh://user@host:port`);
	}
	if (command.trim() === "") throw new Error("ssh: the command is empty");
	return `ssh -n -o BatchMode=yes -- ${shellWord(host)} ${shellWord(command)}`;
}

/** `ssh`: run a command on another machine, from the workspace, with bash's result (output, exitCode, truncated). */
export function sshTool(): ToolRegistration {
	const bash = createBashTool();
	return {
		...bash,
		name: "ssh",
		description: SSH_TOOL_DESCRIPTION,
		parameters: Type.Object({
			host: Type.String({ description: "As you would pass it to ssh: a name from ~/.ssh/config, user@host, or ssh://user@host:port" }),
			command: Type.String({ description: "The remote command line, as you would type it in the remote shell" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
		}),
		callers: ["tools"],
		execute: (args: { host: string; command: string; timeout?: number }, api, context) =>
			bash.execute({ command: sshCommandLine(args.host, args.command), ...(args.timeout === undefined ? {} : { timeout: args.timeout }) }, api, context),
	} as ToolRegistration;
}
