// One copy of each pi package at runtime: the bridge (linked from ~/dev/pi-durable-t3), our code and pi-env all load
// the same chord / pi-ai / pi-durable / pi-codemode files. package.json links them into the bridge repo's tree and
// overrides pi-env's own dependencies to the same links.
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";

const real = (specifier: string, from: string): string => realpathSync(new URL(import.meta.resolve(specifier, from)));
const BRIDGE = import.meta.resolve("pi-durable-t3/src/bridge.ts");
const PI_ENV = import.meta.resolve("@earendil-works/pi-env");
const CODEMODE = import.meta.resolve("@earendil-works/pi-durable/codemode");

describe("one copy of each pi package", () => {
	it("the bridge resolves to its repo, outside node_modules (Node strips types only there)", () => {
		expect(new URL(BRIDGE).pathname).not.toContain("/node_modules/");
	});
	for (const pkg of ["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable"]) {
		it(`${pkg}: ours, the bridge's and pi-env's are the same file`, () => {
			const ours = real(pkg, import.meta.url);
			expect(real(pkg, BRIDGE)).toBe(ours);
			expect(real(pkg, PI_ENV)).toBe(ours);
		});
	}
	it("@earendil-works/pi-codemode: ours is the copy pi-durable/codemode loads", () => {
		expect(real("@earendil-works/pi-codemode", import.meta.url)).toBe(real("@earendil-works/pi-codemode", CODEMODE));
	});
});
