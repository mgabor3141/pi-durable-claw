// A call the model makes to a tool only scripts call. The model is offered `codemode` (and the bridge's
// `request_secret`); `bash`, `read`, MCP tools and the rest are `callers: ["tools"]`. A model used to calling `bash`
// itself still does, now and then, and pi-durable answers "Tool bash is not available", which tells it nothing about
// what to do instead: it may give up on a tool it has. This turns that answer into the call it meant, as a script to
// send: the same tool, the same arguments, inside `codemode`. A name no tool has gets a pointer to `searchTools()`.
import { defineExtension, hook, ToolTask, type Extension, type RegistryReader, type ToolExecutionResult } from "@earendil-works/pi-durable";

const UNAVAILABLE = "tool_unavailable";

/** The answer to a direct call of `name` with `args`: a script-only tool's script, or how to find the tool meant. */
export function directCallAnswer(name: string, args: unknown, scriptTool: boolean): string {
	if (!scriptTool) {
		return `There is no tool named \`${name}\` to call directly. Call \`codemode\` and find it from the script with searchTools("${name}"), or describeNamespace() for an MCP server's tools.`;
	}
	const argument = args === undefined || (typeof args === "object" && args !== null && Object.keys(args).length === 0) ? "" : JSON.stringify(args, null, 2);
	return [
		`\`${name}\` is called from a script, not directly: nothing ran. Call \`codemode\` with this code:`,
		"",
		"```js",
		`return await tools.${name}(${argument});`,
		"```",
	].join("\n");
}

/** The extension: `afterTool` on a call the model made that pi-durable refused as unavailable. */
export function directCallsExtension(registry: RegistryReader): Extension {
	return defineExtension({
		name: "direct-calls",
		hooks: [
			hook(ToolTask, {
				afterTool: (call, result): ToolExecutionResult | undefined => {
					if (call.parent !== undefined || !(result.diagnostics ?? []).some((diagnostic) => diagnostic.code === UNAVAILABLE)) return undefined;
					const tool = registry.snapshot().tools().find((entry) => entry.tool.name === call.name)?.tool;
					const scriptTool = tool !== undefined && (tool.callers === undefined || tool.callers.includes("tools"));
					// pi-durable shows its diagnostic after the output ("<harness>[error] Tool bash is not available"); say the same
					// thing the answer does, so the two do not read as a contradiction.
					const diagnostics = (result.diagnostics ?? []).map((diagnostic) =>
						diagnostic.code === UNAVAILABLE && scriptTool ? { ...diagnostic, message: `Tool ${call.name} is called from codemode scripts, not directly` } : diagnostic,
					);
					return { ...result, output: [{ type: "text", text: directCallAnswer(call.name, call.arguments, scriptTool) }], diagnostics };
				},
			}),
		],
	});
}
