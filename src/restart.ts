import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
	GenerationTask,
	defineExtension,
	defineTool,
	hook,
	type Extension,
	type Harness,
	type TaskId,
	type TaskInspection,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { RESTART_REASON_DESCRIPTION, RESTART_TOOL_DESCRIPTION } from "./prompts.ts";

/** A marker left by a restart request, consumed by the next process. */
export interface RestartMarker {
	readonly requestedAt: string;
	readonly pid: number;
	readonly reason: string;
}

export interface ConsumedRestartMarker {
	readonly marker?: RestartMarker;
	readonly error?: string;
}

/** The host's logger subset, kept structural so tests and the host can share it. */
export interface RestartLog {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

export interface RestartCoordinatorOptions {
	readonly markerPath: string;
	readonly log: RestartLog;
	/** How long to let other agents reach a post-tool boundary before forcing the restart. */
	readonly drainTimeoutMs?: number;
	/** How long close may take after the pause before the host forces the process out. */
	readonly closeGraceMs?: number;
	/** How often to inspect live tasks while draining. */
	readonly pollIntervalMs?: number;
	/** How long a forced restart waits for the requesting tool's result to settle before stop. */
	readonly forcedSettleMs?: number;
	/** The host's shutdown closure; a restart is not possible until it is installed. */
	readonly shutdown?: () => Promise<void>;
	readonly exit?: (code: number) => void;
	readonly onStop?: () => void;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const FORCED_SETTLE_MS = 1_000;
const MAX_REASON_CHARS = 500;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The restart controller shared by the host and the model-facing tool.
 *
 * A restart request pauses every live agent after its current tool results are stored. The requesting tool waits
 * synchronously until the others are paused, then returns "Restarting..."; its own afterTools hook then pauses too.
 * The host closes the harness, which leaves the paused tasks pending, and exits; the supervisor (the compose
 * restart policy) starts the next process. The next process consumes the marker and resumes.
 */
export class RestartCoordinator {
	readonly #markerPath: string;
	readonly #log: RestartLog;
	readonly #drainTimeoutMs: number;
	readonly #closeGraceMs: number;
	readonly #pollIntervalMs: number;
	readonly #forcedSettleMs: number;
	#shutdown: (() => Promise<void>) | undefined;
	readonly #exit: (code: number) => void;
	readonly #onStop: (() => void) | undefined;
	#harness: Pick<Harness, "inspect"> | undefined;
	#draining = false;
	#stopping = false;
	#forced = false;
	#deadline: number | undefined;
	#reason = "agent request";
	/** Live generation tasks paused at afterTools. */
	readonly #held = new Set<TaskId>();
	/** Tool tasks that are themselves restart requests; they are allowed to be live while the drain waits. */
	readonly #restartTasks = new Set<TaskId>();
	/** Generations that own a restart tool task; they cannot reach afterTools until that tool returns. */
	readonly #restartOwners = new Set<TaskId>();

	constructor(options: RestartCoordinatorOptions) {
		this.#markerPath = options.markerPath;
		this.#log = options.log;
		this.#drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
		this.#closeGraceMs = Math.max(0, options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS);
		this.#pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		this.#forcedSettleMs = Math.max(0, options.forcedSettleMs ?? FORCED_SETTLE_MS);
		this.#shutdown = options.shutdown;
		this.#exit = options.exit ?? ((code) => process.exit(code));
		this.#onStop = options.onStop;
	}

	/** The host attaches its Harness after opening it; the tool cannot be called before then. */
	attach(harness: Pick<Harness, "inspect">): void {
		this.#harness = harness;
	}

	/** The host installs the closure that closes MCP, T3 and the Harness; a restart is possible only after this. */
	setShutdown(shutdown: () => Promise<void>): void {
		this.#shutdown = shutdown;
	}

	get draining(): boolean {
		return this.#draining;
	}

	get forced(): boolean {
		return this.#forced;
	}

	/**
	 * Request a restart. The first caller owns the drain and resolves when the other agents are paused or the timeout
	 * forces the restart; later callers return at once, because their own afterTools is the only pause they need.
	 * Every path says "Restarting..." to the model: a restart is successful once accepted, even if another request is
	 * already in progress.
	 */
	async request(reason: string, taskId: TaskId): Promise<void> {
		this.#restartTasks.add(taskId);
		if (this.#stopping || this.#draining) return;
		if (this.#harness === undefined) throw new Error("restart is not ready: the harness is not attached");
		if (this.#shutdown === undefined) throw new Error("restart is not ready: the host has not installed its shutdown");

		this.#draining = true;
		this.#deadline = Date.now() + this.#drainTimeoutMs;
		this.#reason = reason.trim().slice(0, MAX_REASON_CHARS) || "agent request";
		try {
			writeRestartMarker(this.#markerPath, { requestedAt: new Date().toISOString(), pid: process.pid, reason: this.#reason });
		} catch (error) {
			this.#draining = false;
			this.#restartTasks.delete(taskId);
			throw error;
		}
		this.#log.info("restart requested", { reason: this.#reason, taskId: String(taskId) });

		// The drain is background work: the tool awaits only the safe point, then returns. Its own afterTools hook is the
		// final pause. Both promises are deliberately not awaited by the caller; the stop runs in the background.
		const safe = this.#waitUntilSafe().catch((error: unknown) => {
			this.#log.warn("restart drain inspection failed; forcing", { error: error instanceof Error ? error.message : String(error) });
			return true;
		});
		void safe
			.then(async (forced) => {
				this.#forced = forced;
				await this.#waitUntilPaused(forced);
				await this.#stop();
			})
			.catch((error: unknown) => {
				this.#log.warn("restart drain failed; forcing", { error: error instanceof Error ? error.message : String(error) });
				void this.#stop();
			});
		await safe;
	}

	/** The GenerationTask.afterTools hook. It is called after the round's tool results are durable. */
	async afterTools(taskId: TaskId, context: Context): Promise<void> {
		if (!this.#draining) return;
		this.#held.add(taskId);
		this.#log.info("restart paused a generation at a tool boundary", { taskId: String(taskId) });
		// A close aborts the generation's context. Rejecting on that signal lets harness.close() finish without a crash
		// count; the task stays pending and resumes in the next process.
		await pauseUntilAborted(context);
	}

	/** The model-facing restart tool and its generation hook. */
	extension(): Extension {
		const coordinator = this;
		const restart = defineTool({
			name: "restart_harness",
			description: RESTART_TOOL_DESCRIPTION,
			parameters: Type.Object({
				reason: Type.Optional(Type.String({ maxLength: MAX_REASON_CHARS, description: RESTART_REASON_DESCRIPTION })),
			}),
			callers: ["model"],
			replay: "unsafe",
			async execute(args, api) {
				await coordinator.request(args.reason ?? "agent request", api.taskId);
				return { output: [{ type: "text", text: "Restarting..." }] };
			},
		});
		return defineExtension({
			name: "harness-restart",
			tools: [restart],
			hooks: [
				hook(GenerationTask, {
					afterTools: async (_assistant, _results, api, context) => {
						await coordinator.afterTools(api.taskId, context);
					},
				}),
			],
		});
	}

	async #waitUntilSafe(): Promise<boolean> {
		const deadline = this.#deadline ?? Date.now() + this.#drainTimeoutMs;
		while (Date.now() < deadline) {
			const live = await this.#liveRecords();
			this.#rememberRestartOwners(live);
			const unsafe = live.filter(
				(task) => !this.#held.has(task.id) && !this.#restartTasks.has(task.id) && !this.#restartOwners.has(task.id),
			);
			if (unsafe.length === 0) return false;
			await delay(this.#pollIntervalMs);
		}
		this.#log.warn("restart drain timed out; forcing", { timeoutMs: this.#drainTimeoutMs, live: [...this.#liveSnapshot] });
		return true;
	}

	async #waitUntilPaused(forced: boolean): Promise<void> {
		// The requesting tool must return and commit its result before stop. Wait for its task to leave running, then
		// for the pause to be stable. A forced drain gets a short settle window; a normal drain gets the full timeout.
		const deadline = forced ? Date.now() + this.#forcedSettleMs : (this.#deadline ?? Date.now() + this.#drainTimeoutMs);
		let stable = 0;
		while (Date.now() < deadline) {
			const live = await this.#liveRecords();
			this.#rememberRestartOwners(live);
			// Unlike the safe wait, the final pause still waits for the requesting generation itself: after its tool result
			// is committed, its own afterTools hook is the last boundary before stop.
			const unsafe = live.filter((task) => !this.#held.has(task.id) && !this.#restartTasks.has(task.id));
			const restartLive = live.some((task) => this.#restartTasks.has(task.id));
			if (unsafe.length === 0 && !restartLive) {
				stable += 1;
				if (stable >= 2) return;
			} else {
				stable = 0;
			}
			await delay(this.#pollIntervalMs);
		}
		this.#log.warn("restart did not reach a clean pause; forcing exit", { forced, live: [...this.#liveSnapshot] });
	}

	/** A snapshot of live task IDs, used only for diagnostics. */
	#liveSnapshot: string[] = [];

	#rememberRestartOwners(live: readonly TaskInspection["record"][]): void {
		for (const record of live) {
			if (this.#restartTasks.has(record.id) && record.owner !== undefined) this.#restartOwners.add(record.owner);
		}
	}

	async #liveRecords(): Promise<readonly TaskInspection["record"][]> {
		if (this.#harness === undefined) return [];
		const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
		const live = inspection.tasks.filter((task) => task.state.kind === "running").map((task) => task.record);
		this.#liveSnapshot = live.map((record) => String(record.id));
		return live;
	}

	async #stop(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#onStop?.();
		this.#log.info("restarting harness", { reason: this.#reason, forced: this.#forced });
		try {
			await Promise.race([(this.#shutdown ?? (async () => {}))(), delay(this.#closeGraceMs)]);
		} catch (error) {
			this.#log.warn("harness close failed during restart; exiting anyway", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.#exit(0);
	}
}

/** Hold a generation until its context is aborted by harness.close(). */
function pauseUntilAborted(context: Context): Promise<void> {
	const signal = context.abortSignal;
	if (signal === undefined) return new Promise<void>(() => {});
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<void>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
	});
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

/** Write the request marker atomically and owner-only. */
export function writeRestartMarker(path: string, marker: RestartMarker): void {
	const temporary = path + "." + process.pid + ".tmp";
	try {
		writeFileSync(temporary, JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			/* best effort */
		}
		throw error;
	}
}

/** Read and remove the marker left by the previous process. A missing marker is normal. */
export function consumeRestartMarker(path: string): ConsumedRestartMarker {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { error: error instanceof Error ? error.message : String(error) };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<RestartMarker>;
		if (typeof parsed.requestedAt !== "string" || typeof parsed.pid !== "number" || typeof parsed.reason !== "string") {
			throw new Error("restart marker is malformed");
		}
		return { marker: { requestedAt: parsed.requestedAt, pid: parsed.pid, reason: parsed.reason } };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		try {
			unlinkSync(path);
		} catch {
			/* best effort */
		}
	}
}

