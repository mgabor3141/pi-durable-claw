// A codemode script that allocates without bound fails with QuickJS's own "out of memory" instead of taking the host
// process (whose worker threads run the VMs) down with it.
import { expect, it } from "vitest";
import { codemodeMemoryLimitBytes, codemodeSandbox } from "../src/harness.ts";

it("bounds a script's memory, and the sandbox runs the next script normally", async () => {
	const sandbox = codemodeSandbox();
	const runaway = await sandbox.execute("const kept = []; for (;;) kept.push('x'.repeat(1 << 20));");
	expect(runaway.ok).toBe(false);
	expect(JSON.stringify(runaway)).toMatch(/out of memory/i);
	const next = await sandbox.execute("return 1 + 1;");
	expect(next.ok).toBe(true);
}, 60_000);

it("reads the limit from CLAW_CODEMODE_MEMORY_MB, defaulting to 256 MiB", () => {
	expect(codemodeMemoryLimitBytes({})).toBe(256 * 1024 * 1024);
	expect(codemodeMemoryLimitBytes({ CLAW_CODEMODE_MEMORY_MB: "64" })).toBe(64 * 1024 * 1024);
	expect(codemodeMemoryLimitBytes({ CLAW_CODEMODE_MEMORY_MB: "nonsense" })).toBe(256 * 1024 * 1024);
});
