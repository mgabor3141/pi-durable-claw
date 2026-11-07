// The `subagent` tool: pi-durable's foreground subagent (README "Abort and Subagents"). The call creates a child
// conversation it owns, runs the task there, and returns the child's last answer. Aborting the call, or the parent's
// run, aborts the child; the parent is busy until the child is idle. The call's `details` name the child
// (`{ conversationId }`) while it runs and on its result: that is the convention T3 reads to show the call as a subagent
// card with its own read-only thread.
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

const parameters = Type.Object({
	prompt: Type.String({ description: "The self-contained task. The subagent sees nothing of this conversation: say everything it needs." }),
	description: Type.Optional(Type.String({ description: "A short (3-5 word) label for the task." })),
});

export const SUBAGENT_TOOL_DESCRIPTION =
	"Delegate a self-contained task to a subagent and wait for its final answer. The subagent starts with no history, has the same workspace and tools (it cannot start subagents or restart the harness), and works until it answers. Use it to keep a long side task out of this conversation's context.";

/**
 * The `subagent` extension. A child gets this conversation's agent (model, thinking level, cwd, tools) without this
 * extension, so it cannot start subagents, and without `without` (the restart tool: only the conversation a person talks
 * to may restart the harness).
 */
export function subagentExtension(options: { readonly without?: readonly Extension[] } = {}): Extension {
	const extension: Extension = defineExtension({
		name: "subagent",
		tools: [
			defineTool({
				name: "subagent",
				description: SUBAGENT_TOOL_DESCRIPTION,
				parameters,
				callers: ["model"],
				// Safe to rerun after a crash: a rerun finds the child it created and the submission it made.
				replay: "safe",
				execute: async (args, api, context) => {
					const child = await api.commit(async (tx) => {
						// Ownership records the child: a rerun of this call finds it instead of creating another.
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { extensions: { remove: [extension, ...(options.without ?? [])] } });
						return created.id;
					}, context);
					await api.details({ conversationId: child }, context);
					const handle = (await api.conversation(child, context))!;
					// The request id makes a rerun get back the submission it made before the crash.
					const settled = await (await handle.submit({ type: "input", content: args.prompt, requestId: `subagent:${api.taskId}` }, context)).wait(context);
					if (settled.status !== "done" || settled.type !== "input") throw new Error(`The subagent did not finish: ${settled.status}`);
					const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
					const message = answer?.model?.[0];
					const text = message?.role === "assistant" ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") : "";
					return { output: [{ type: "text", text: text || "(the subagent returned no text)" }], details: { conversationId: child } };
				},
			}),
		],
	});
	return extension;
}
