// A stand-in for an OpenAI-compatible engine with a prefix cache (llama.cpp, vLLM, Maya): it records every request,
// answers it, and says how much of it an ideal prefix cache would have held. A request's "state" is what the engine
// holds after answering it: the messages it was sent and the answer it wrote. The checks are about what the harness
// sends, not about any engine's eviction: does each request continue the state its conversation left, and does a
// fork's first request continue the state its parent had at the fork point?
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A message as an engine renders it: what changes its tokens, not how the JSON is spelled. */
export type Rendered = string;

type WireMessage = {
	role: string;
	content?: unknown;
	reasoning_content?: string;
	tool_calls?: { id?: string; function?: { name: string; arguments: string } }[];
	tool_call_id?: string;
	name?: string;
};

const text = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : JSON.stringify(part))).join("") : content === undefined || content === null ? "" : JSON.stringify(content);

/** Maya parses a call's arguments and renders them again (`encode_arguments_to_dsml`), so their spacing does not count. */
export function render(message: WireMessage): Rendered {
	const calls = (message.tool_calls ?? []).map((call) => {
		let args: unknown = call.function?.arguments;
		try {
			args = JSON.parse(String(args));
		} catch {}
		return { name: call.function?.name, args };
	});
	return JSON.stringify({ role: message.role === "developer" ? "system" : message.role, text: text(message.content), reasoning: message.reasoning_content ?? "", calls, toolCallId: message.tool_call_id ?? "" });
}

export type Request = {
	readonly index: number;
	readonly session: string | undefined;
	/** The tools as the request declares them, rendered: they come before every message. */
	readonly tools: string;
	readonly messages: readonly Rendered[];
	/** The state the engine holds after this request: its messages and the answer it wrote. */
	readonly state: readonly Rendered[];
	readonly chars: number;
	/** The longest prefix of this request an earlier state holds, in characters, and which request left it. */
	readonly reused: number;
	readonly reusedFrom: number | undefined;
	readonly lastUser: string;
};

/** How long a run of rendered messages is, the tools first. */
const size = (tools: string, messages: readonly Rendered[], upTo = messages.length) => tools.length + messages.slice(0, upTo).reduce((sum, message) => sum + message.length, 0);

export type Answer = { readonly reasoning?: string; readonly text?: string; readonly call?: { readonly name: string; readonly args: Record<string, unknown> } };

export class PrefixEngine {
	readonly requests: Request[] = [];
	#server: Server | undefined;
	#calls = 0;

	/**
	 * `answer` decides each reply from the request's messages, and may hold it back; `delayMs` keeps two conversations'
	 * requests interleaved. A request is recorded when it arrives, its answer once written.
	 */
	constructor(
		private readonly answer: (messages: readonly WireMessage[]) => Answer | Promise<Answer>,
		private readonly delayMs = 15,
	) {}

	async start(): Promise<string> {
		this.#server = createServer((request, response) => void this.#handle(request, response));
		await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/v1`;
	}

	async close() {
		await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
	}

	/** How much a request's state holds: its messages and its answer, the tools first. */
	static held(state: { tools: string; state: readonly Rendered[] }): number {
		return size(state.tools, state.state);
	}

	/** The common prefix of a request with a state, in characters (whole messages; the tools must match first). */
	static common(request: { tools: string; messages: readonly Rendered[] }, state: { tools: string; state: readonly Rendered[] }): number {
		if (request.tools !== state.tools) return 0;
		let n = 0;
		while (n < request.messages.length && n < state.state.length && request.messages[n] === state.state[n]) n++;
		return size(request.tools, request.messages, n);
	}

	async #handle(request: IncomingMessage, response: import("node:http").ServerResponse) {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		if (!request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: WireMessage[]; tools?: unknown[]; thinking?: unknown; reasoning_effort?: unknown };
		// Maya's DeepSeek V4.1 encoding starts a thinking-mode prompt with "Reasoning Effort: N": the mode and the effort
		// come before everything, as the tools do here.
		const tools = JSON.stringify({ thinking: body.thinking ?? null, effort: body.reasoning_effort ?? null, tools: body.tools ?? [] });
		const messages = body.messages.map(render);
		let reused = 0;
		let reusedFrom: number | undefined;
		for (const earlier of this.requests) {
			const common = PrefixEngine.common({ tools, messages }, earlier);
			if (common > reused) [reused, reusedFrom] = [common, earlier.index];
		}
		const header = request.headers["x-session-affinity"];
		const lastUser = body.messages.findLast((message) => message.role === "user");
		const record: Request = {
			index: this.requests.length,
			session: typeof header === "string" ? header : undefined,
			tools,
			messages,
			state: messages,
			chars: size(tools, messages),
			reused,
			reusedFrom,
			lastUser: text(lastUser?.content).slice(0, 80),
		};
		this.requests.push(record);
		const answer = await this.answer(body.messages);
		// The client went away while the answer was held: nothing to write to.
		if (response.destroyed || request.socket.destroyed) return;
		const call = answer.call === undefined ? undefined : { id: `call_${++this.#calls}`, type: "function", function: { name: answer.call.name, arguments: JSON.stringify(answer.call.args) } };
		const wrote = render({ role: "assistant", content: answer.text ?? "", ...(answer.reasoning === undefined ? {} : { reasoning_content: answer.reasoning }), ...(call === undefined ? {} : { tool_calls: [call] }) });
		(record as { state: readonly Rendered[] }).state = [...messages, wrote];
		await new Promise((resolve) => setTimeout(resolve, this.delayMs));
		response.writeHead(200, { "content-type": "text/event-stream" });
		const send = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
		const base = { id: `r${record.index}`, object: "chat.completion.chunk", created: 0, model: "engine" };
		if (answer.reasoning !== undefined) send({ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: answer.reasoning } }] });
		if (answer.text !== undefined) send({ ...base, choices: [{ index: 0, delta: { content: answer.text } }] });
		if (call !== undefined) send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] } }] });
		const tokens = (chars: number) => Math.max(1, Math.round(chars / 4));
		send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call === undefined ? "stop" : "tool_calls" }] });
		send({ ...base, choices: [], usage: { prompt_tokens: tokens(record.chars), completion_tokens: 10, total_tokens: tokens(record.chars) + 10, prompt_tokens_details: { cached_tokens: reused === 0 ? 0 : tokens(reused) } } });
		response.end("data: [DONE]\n\n");
	}
}
