import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

/**
 * The workspace's files and shell: pi-durable's own coding tools, unchanged except `callers: ["tools"]` — the model
 * is never offered them, only codemode scripts call them. They run against the call's `ExecutionEnv`, which the
 * harness builds as pi-env's `RemoteExecutionEnv` over SSH to the workspace container.
 */
export function workspaceTools(): ToolRegistration[] {
	return [
		{ ...createReadTool(), callers: ["tools"] as const },
		{ ...createWriteTool(), callers: ["tools"] as const },
		{ ...createBashTool(), callers: ["tools"] as const },
	];
}
