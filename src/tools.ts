import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { Type } from "@earendil-works/pi-ai";
import type { ImageContent } from "@earendil-works/pi-ai";
import { READ_TOOL_DESCRIPTION, SSH_TOOL_DESCRIPTION } from "./prompts.ts";

/**
 * The workspace's files and shell: pi-durable's own coding tools, unchanged except `callers: ["tools"]` — the model
 * is never offered them, only codemode scripts call them. They run against the call's `ExecutionEnv`, which the
 * harness builds as pi-env's `RemoteExecutionEnv` over SSH to the workspace container. `ssh` is `bash` running one
 * `ssh` command line, so a script passes the remote command as a plain string instead of quoting it twice.
 */
export function workspaceTools(): ToolRegistration[] {
	return [
		readTool(),
		{ ...createWriteTool(), callers: ["tools"] as const },
		{ ...createEditTool(), callers: ["tools"] as const },
		{ ...createBashTool(), callers: ["tools"] as const },
		sshTool(),
	];
}

/**
 * What `read` gives a script: a text file's text, or an image as the block `image()` shows. pi-durable's `read` returns an
 * image block as its content, but a tool without an output schema gives scripts only its text, so the image would arrive
 * as "". Every other tool that returns an image (`browser_screenshot`, `models.generateImages`) already hands scripts
 * the block; this does the same for `read`.
 */
const READ_RESULT_SCHEMA = Type.Union([
	Type.Object({ type: Type.Literal("text"), text: Type.String() }),
	Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
]);

export function readTool(): ToolRegistration {
	const read = createReadTool();
	return {
		...read,
		description: READ_TOOL_DESCRIPTION,
		structuredOutputSchema: READ_RESULT_SCHEMA,
		async execute(args: never, api, context) {
			const result = await read.execute(args, api, context);
			// An error (a file too large to send, or one that is not there) carries its reason as an error diagnostic,
			// which a script's rejected call shows; no structured output, so nothing pretends to be read.
			if (result.isError === true) return result;
			const output = result.output ?? [];
			const picture = output.find((item) => item.type === "image");
			const structuredOutput: ImageContent | { type: "text"; text: string } =
				picture === undefined
					? { type: "text", text: output.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n") }
					: { type: "image", data: picture.data, mimeType: picture.mimeType };
			return { ...result, structuredOutput };
		},
	} as ToolRegistration;
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
