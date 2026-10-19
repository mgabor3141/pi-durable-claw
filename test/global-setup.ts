import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { ensureKeypair } from "../src/workspace.ts";
import { CONTAINER, PORT, SSH_DIR } from "./fixtures/workspace.ts";

const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build and run the workspace image (as compose does, with the public key in a mounted dir), wait for its sshd. */
export async function setup(): Promise<() => Promise<void>> {
	const pubDir = join(SSH_DIR, "pub");
	ensureKeypair(SSH_DIR, pubDir);
	// Start from an empty trust: the host key is scanned and accepted fresh in the tests.
	await rm(join(SSH_DIR, "known_hosts"), { force: true });
	docker(["build", "-q", "-t", CONTAINER, join(process.cwd(), "images", "workspace")]);
	docker(["rm", "-f", CONTAINER]);
	docker(["run", "-d", "--name", CONTAINER, "-p", `127.0.0.1:${PORT}:22`, "-v", `${pubDir}:/pubkey:ro`, CONTAINER]);
	for (let i = 0; i < 100; i++) {
		const open = await new Promise<boolean>((resolve) => {
			const s = new Socket();
			s.once("connect", () => { s.destroy(); resolve(true); });
			s.once("error", () => resolve(false));
			s.connect(PORT, "127.0.0.1");
		});
		if (open) break;
		await sleep(100);
	}
	return async () => {
		docker(["rm", "-f", CONTAINER]);
	};
}
