import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { TextGenerationModel } from "@mgabor3141/pi-durable-t3";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { SUMMARIZE_DEFAULT_INSTRUCTION, SUMMARIZE_INSTRUCTION_DESCRIPTION, SUMMARIZE_PATH_DESCRIPTION, SUMMARIZE_SYSTEM_PROMPT, SUMMARIZE_TEXT_DESCRIPTION, SUMMARIZE_TOOL_DESCRIPTION, summarizePrompt } from "./prompts.ts";
import { opt, str } from "@earendil-works/pi-schema";
import { object } from "./schema.ts";

/** A page can be large; this is still a single model call, not a subagent. */
const MAX_INPUT_CHARS = 200_000;
const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 20_000;

function textOf(message: { content: readonly { type: string; text?: string }[] }): string {
	return message.content.flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("").trim();
}

function resultValue(value: { ok: true; value: string } | { ok: false; error: { message: string } }): string {
	if (!value.ok) throw new Error(value.error.message);
	return value.value;
}

/** `late.textGenerationModel`: T3's text-generation model (Settings), when it names one of ours; it exists once the bridge
 * is attached. */
export function summarizeTools(late: { readonly textGenerationModel?: () => TextGenerationModel | undefined } = {}): ToolRegistration[] {
	return [
		defineTool({
			name: "summarize",
			description: SUMMARIZE_TOOL_DESCRIPTION,
			parameters: object({
				path: opt(str({ minLength: 1, maxLength: 4_000, description: SUMMARIZE_PATH_DESCRIPTION })),
				text: opt(str({ minLength: 1, maxLength: MAX_INPUT_CHARS, description: SUMMARIZE_TEXT_DESCRIPTION })),
				instruction: opt(str({ maxLength: MAX_INSTRUCTION_CHARS, description: SUMMARIZE_INSTRUCTION_DESCRIPTION })),
			}),
			structuredOutputSchema: object({ summary: str() }),
			callers: ["tools"],
			async execute(args, api, context) {
				if ((args.path === undefined) === (args.text === undefined)) throw new Error("summarize needs exactly one of path or text");
				let input = args.text ?? "";
				if (args.path !== undefined) {
					const env: ExecutionEnv | undefined = api.env;
					if (env === undefined) throw new Error("summarize cannot read a file without a workspace environment");
					input = resultValue(await env.readTextFile(args.path, context));
				}
				if (input.length > MAX_INPUT_CHARS) throw new Error(`input is too large (${input.length} chars; max ${MAX_INPUT_CHARS})`);
				// T3's text-generation model when Settings names one; else the conversation's own.
				const configured = late.textGenerationModel?.();
				const ref = configured ?? (await api.agent(context)).model;
				if (ref === undefined) throw new Error("summarize has no model selected");
				const model = api.models.getModel(ref.provider, ref.modelId);
				if (model === undefined) throw new Error(`summarize cannot resolve ${ref.provider}/${ref.modelId}`);
				const task = args.instruction?.trim() || SUMMARIZE_DEFAULT_INSTRUCTION;
				const reply = await api.models.completeSimple(
					model,
					{
						systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
						messages: [{ role: "user", content: summarizePrompt(task, input), timestamp: Date.now() }],
					},
					{ signal: context.abortSignal, ...(configured?.thinkingLevel === undefined || configured.thinkingLevel === "off" ? {} : { reasoning: configured.thinkingLevel as never }) },
				);
				if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
				const summary = textOf(reply).slice(0, MAX_SUMMARY_CHARS);
				if (summary === "") throw new Error("summarize returned no text");
				return { output: [{ type: "text", text: summary }], structuredOutput: { summary } as unknown as JsonValue };
			},
		}),
	];
}
