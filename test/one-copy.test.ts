// One copy of each pi package at runtime: the bridge (its pi packages are peers), our code and pi-env all load the
// same chord / pi-ai / pi-durable files, and pi-durable/codemode loads our pi-codemode. A second copy would split
// classes and registries (an `instanceof` across copies fails). package.json pins them all to one version.
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";

const real = (specifier: string, from: string): string => realpathSync(new URL(import.meta.resolve(specifier, from)));
const BRIDGE = import.meta.resolve("@mgabor3141/pi-durable-t3");
const PI_ENV = import.meta.resolve("@earendil-works/pi-env");
const CODEMODE = import.meta.resolve("@earendil-works/pi-durable/codemode");

describe("one copy of each pi package", () => {
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
