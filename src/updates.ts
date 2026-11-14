import { execFile } from "node:child_process";
import type { HostUpdates } from "@mgabor3141/pi-durable-t3";

/** What a person runs instead of T3's button; T3 shows it beside the button. */
const UPDATE_COMMAND = "docker compose exec harness claw update";
/** An install prints pnpm's progress; T3 keeps the last of it. */
const MAX_OUTPUT = 4 * 1024 * 1024;

type Check = { current: string | null; latest: string | null; undone: { id: string; at: string; code: number } | null };

/** A version as T3 shows it: a commit by its first seven characters, as git abbreviates one. */
const short = (id: string) => (/^[0-9a-f]{12,}$/.test(id) ? id.slice(0, 7) : id);

/**
 * The harness's updates, for T3's Update button on the `pi` provider. The image's launcher (launcher/launcher.ts)
 * installs versions and restarts the harness; it gives the harness its own command line in `CLAW_LAUNCHER`, and
 * answers `check`, `install` and `restart` with a line of JSON. Run outside the image (a checkout, the tests) there is
 * no launcher and nothing to offer: `undefined`.
 */
export function launcherUpdates(env: NodeJS.ProcessEnv, log: { warn(message: string, fields?: Record<string, unknown>): void }): HostUpdates | undefined {
	const raw = env.CLAW_LAUNCHER?.trim();
	if (raw === undefined || raw === "") return undefined;
	const launcher = JSON.parse(raw) as string[];
	const run = (command: string, signal?: AbortSignal) =>
		new Promise<string>((resolve, reject) => {
			execFile(launcher[0]!, [...launcher.slice(1), command], { maxBuffer: MAX_OUTPUT, ...(signal === undefined ? {} : { signal }) }, (error, stdout, stderr) => {
				if (error === null) return resolve(stdout);
				// The launcher says why on its last line, as `claw: ...`.
				const said = stderr.trim().split("\n").findLast((line) => line.startsWith("claw: "))?.slice("claw: ".length);
				reject(new Error(said ?? (stderr.trim().split("\n").at(-1) || error.message)));
			});
		});
	const answer = <T>(output: string): T => JSON.parse(output.trim().split("\n").at(-1) ?? "") as T;
	return {
		command: UPDATE_COMMAND,
		// T3 shows the provider's version as "claw 680f25f, pi 1.5.2, t3 0.1.9".
		name: "claw",
		check: async ({ signal }) => {
			const { current, latest, undone } = answer<Check>(await run("check", signal));
			if (current === null) throw new Error("the launcher has no version installed");
			return {
				current: short(current),
				...(latest === null ? {} : { latest: short(latest) }),
				// A version that was tried and undone is still the newest: say so, where T3 says an update is available.
				...(undone !== null && undone.id === latest
					? { note: `Version ${short(undone.id)} was installed on ${undone.at.slice(0, 10)}, exited before it served (code ${undone.code}), and was undone. Update tries it again.` }
					: {}),
			};
		},
		install: async () => {
			const output = await run("install");
			return { version: short(answer<{ version: string }>(output).version), output };
		},
		restart: () => void run("restart").catch((error: unknown) => log.warn("could not restart into the installed version", { error: error instanceof Error ? error.message : String(error) })),
	};
}
