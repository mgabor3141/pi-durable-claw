// The harness's side of T3's Update button (src/updates.ts): it asks the image's launcher, whose command line it is
// given in CLAW_LAUNCHER, and reads the last line of what the launcher prints. Here the launcher is a script.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { launcherUpdates } from "../src/updates.ts";

function fakeLauncher(check: object, installFails = false) {
	const dir = mkdtempSync(join(tmpdir(), "claw-updates-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const script = join(dir, "launcher.mjs");
	writeFileSync(
		script,
		`import { appendFileSync } from "node:fs";
const command = process.argv.at(-1);
appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, process.argv.slice(2).join(" ") + "\\n");
if (command === "check") console.log(JSON.stringify(${JSON.stringify(check)}));
if (command === "install") {
	console.log("claw: downloading the harness, version latest\\nProgress: resolved 189");
	if (${installFails}) { console.error("some pnpm noise\\nclaw: version latest needs Node >=26.0.0, and this image has v24.3.0"); process.exit(1); }
	console.log(JSON.stringify({ version: "bbb222bbb222" }));
}
if (command === "restart") console.log(JSON.stringify({ restarting: true }));
`,
	);
	const warnings: string[] = [];
	const updates = launcherUpdates({ CLAW_LAUNCHER: JSON.stringify([process.execPath, script, "--app", "/app", "--"]) }, { warn: (message) => void warnings.push(message) })!;
	const calls = () => readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
	return { updates, calls, warnings };
}

it("outside the image there is no launcher, and nothing to offer", () => {
	expect(launcherUpdates({}, { warn: () => {} })).toBeUndefined();
	expect(launcherUpdates({ CLAW_LAUNCHER: " " }, { warn: () => {} })).toBeUndefined();
});

it("asks the launcher what runs and what is newest, installs, and restarts", async () => {
	const { updates, calls } = fakeLauncher({ current: "aaa111aaa111", latest: "bbb222bbb222", undone: null });
	expect(updates.command).toBe("docker compose exec harness claw update");
	expect(await updates.check({ signal: AbortSignal.timeout(10_000) })).toEqual({ current: "aaa111aaa111", latest: "bbb222bbb222" });
	const installed = await updates.install();
	expect(installed.version).toBe("bbb222bbb222");
	expect(installed.output, "what the install printed, for T3").toContain("Progress: resolved 189");
	updates.restart();
	for (let waited = 0; calls().length < 3 && waited < 5_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
	expect(calls()).toEqual(["--app /app -- check", "--app /app -- install", "--app /app -- restart"]);
});

it("a directory has no newest; a version that was undone is said where T3 offers it again; a failure is the launcher's own words", async () => {
	expect(await fakeLauncher({ current: "local-1", latest: null, undone: null }).updates.check({ signal: AbortSignal.timeout(10_000) })).toEqual({ current: "local-1" });

	const undone = fakeLauncher({ current: "aaa111aaa111", latest: "bbb222bbb222", undone: { id: "bbb222bbb222", at: "2026-11-14T10:00:00.000Z", code: 3 } });
	expect(await undone.updates.check({ signal: AbortSignal.timeout(10_000) })).toEqual({
		current: "aaa111aaa111",
		latest: "bbb222bbb222",
		note: "Version bbb222bbb222 was installed on 2026-11-14, exited before it served (code 3), and was undone. Update tries it again.",
	});
	// An older failure says nothing about a newer version.
	const moved = fakeLauncher({ current: "aaa111aaa111", latest: "ccc333ccc333", undone: { id: "bbb222bbb222", at: "2026-11-14T10:00:00.000Z", code: 3 } });
	expect(await moved.updates.check({ signal: AbortSignal.timeout(10_000) })).toEqual({ current: "aaa111aaa111", latest: "ccc333ccc333" });

	await expect(fakeLauncher({}, true).updates.install()).rejects.toThrow("version latest needs Node >=26.0.0, and this image has v24.3.0");
});
