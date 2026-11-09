/**
 * Timers in codemode scripts: `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval`.
 *
 * The QuickJS sandbox has no timers, so an agent that wrote `await new Promise((r) => setTimeout(r, 2000))` got a
 * ReferenceError and fell back to `tools.bash({ command: "sleep 2" })`. A timer has to be more than a host callback:
 * pi-durable replays a script after a restart, delivering the results it already got in the same order, so a wait must
 * be one of those journaled results.
 *
 * - The wait is a host global, `__codemodeTimer(deadline)`: it resolves at an absolute time (ms since the epoch). Its
 *   result is journaled like any call's, so a resumed script does not wait again for a timer that already fired; a wait
 *   a restart cut short is issued again with the same deadline (the VM's clock is deterministic) and waits only for
 *   what is left. Stop ends it at once.
 * - The four functions are appended to the script as function declarations, which hoist through the async function
 *   body the script runs as: every line of the script sees them, and its line numbers stay the same. They are appended
 *   only to a script that names one of them and declares none of them itself. The transcript, and so the thread's view,
 *   keeps the script as the agent wrote it.
 *
 * A timer is a call like any other: one still pending when the script ends is cancelled, so a script awaits what it
 * needs. A delay of 0 runs the callback after the current job (a microtask), without a host call; an interval waits at
 * least 1 ms between ticks, each on a fixed schedule from the first. An error a callback throws goes to `console.error`.
 */
import type { Context } from "@earendil-works/chord";
import type { Extension, ToolRegistration, Wrap } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, type CodemodeGlobal } from "@earendil-works/pi-durable/codemode";

const TIMER_GLOBAL = "__codemodeTimer";
/** Node's largest timer delay; a longer wait sleeps in steps. */
const MAX_STEP_MS = 2_147_483_647;
const TIMER_NAMES = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;
const NAMED = new RegExp(`\\b(?:${TIMER_NAMES.join("|")})\\b`, "u");
const DECLARED = new RegExp(`\\b(?:function\\*?|const|let|var|class)\\s+(?:${TIMER_NAMES.join("|")})\\b`, "u");

/** The script's own sentence about timers, as the codemode tool's description says it. */
const NO_TIMERS = "No Node, file system, network, or timers.";
const WITH_TIMERS = "No Node, file system, or network. `setTimeout` and `setInterval` wait in real time; a timer still pending when the script ends is cancelled.";

/** Resolves at `deadline` (ms since the epoch), or rejects when the call is stopped. */
export function timerGlobal(): CodemodeGlobal {
	return {
		name: TIMER_GLOBAL,
		async execute(args: unknown, _api: unknown, context: Context) {
			if (typeof args !== "number" || !Number.isFinite(args)) throw new Error("a timer needs a finite deadline");
			for (let left = args - Date.now(); left > 0; left = args - Date.now()) await wait(Math.min(left, MAX_STEP_MS), context.abortSignal);
			return undefined;
		},
	};
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal!.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** The timer functions, appended after a script. Hoisted declarations only: nothing here runs until the script calls it. */
const SHIM = `
function __codemodeTimers() {
	return (__codemodeTimers.state ??= { next: 1, live: new Set() });
}
function __codemodeTimerCall(callback, args) {
	try {
		const result = callback(...args);
		if (result !== null && typeof result === "object" && typeof result.then === "function") result.then(undefined, (error) => console.error(error));
	} catch (error) {
		console.error(error);
	}
}
function setTimeout(callback, delay, ...args) {
	if (typeof callback !== "function") throw new TypeError("setTimeout expects a function");
	const timers = __codemodeTimers();
	const id = timers.next++;
	timers.live.add(id);
	const ms = Math.max(0, Number(delay) || 0);
	const fire = () => {
		if (timers.live.delete(id)) __codemodeTimerCall(callback, args);
	};
	if (ms === 0) Promise.resolve().then(fire);
	else ${TIMER_GLOBAL}(Date.now() + ms).then(fire, () => timers.live.delete(id));
	return id;
}
function setInterval(callback, delay, ...args) {
	if (typeof callback !== "function") throw new TypeError("setInterval expects a function");
	const timers = __codemodeTimers();
	const id = timers.next++;
	timers.live.add(id);
	const ms = Math.max(1, Number(delay) || 0);
	let due = Date.now();
	const tick = () => {
		due += ms;
		${TIMER_GLOBAL}(due).then(() => {
			if (!timers.live.has(id)) return;
			__codemodeTimerCall(callback, args);
			if (timers.live.has(id)) tick();
		}, () => timers.live.delete(id));
	};
	tick();
	return id;
}
function clearTimeout(id) {
	__codemodeTimers().live.delete(id);
}
function clearInterval(id) {
	__codemodeTimers().live.delete(id);
}`;

/** The script with the timer functions after it, when it names one and declares none. */
export function withTimers(code: string): string {
	return NAMED.test(code) && !DECLARED.test(code) ? `${code}\n${SHIM}` : code;
}

/**
 * Timers for codemode: wraps the codemode tool (its scripts get the timer functions; its description says they exist).
 * Select it after the codemode extension, whose `globals` include {@link timerGlobal}.
 */
export function codemodeTimersExtension(): Extension {
	const wrap: Wrap = {
		tool: CODEMODE_TOOL_NAME,
		wrap: (tool: ToolRegistration) => {
			if (!tool.description.includes(NO_TIMERS)) throw new Error(`codemode timers: the codemode tool's description no longer says "${NO_TIMERS}"`);
			const execute: ToolRegistration["execute"] = (args, api, context) => {
				const input = args as { code?: unknown };
				return tool.execute((typeof input.code === "string" ? { ...input, code: withTimers(input.code) } : args) as never, api, context);
			};
			return { ...tool, description: tool.description.replace(NO_TIMERS, WITH_TIMERS), execute };
		},
	};
	return { name: "codemode-timers", wraps: [wrap] };
}
