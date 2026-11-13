import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { ensureKeypair } from "../src/workspace.ts";
import { CONTAINER, PORT, SSH_DIR } from "./fixtures/workspace.ts";

const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build and run the workspace image with the harness's public key in /pubkey (as compose does), wait for its sshd. */
export async function setup(): Promise<() => Promise<void>> {
	const pubDir = join(SSH_DIR, "pub");
	ensureKeypair(SSH_DIR, pubDir);
	// Start from an empty trust: the host key is scanned and accepted fresh in the tests.
	await rm(join(SSH_DIR, "known_hosts"), { force: true });
	docker(["build", "-q", "-t", CONTAINER, join(process.cwd(), "images", "workspace")]);
	// Left from an interrupted run, if any. With none, docker's "No such container" is not an error here.
	execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
	docker(["run", "-d", "--name", CONTAINER, "-p", `127.0.0.1:${PORT}:22`, CONTAINER]);
	// sshd takes a key file only from its user's own uid (agent, 1000). In compose the harness writes it as that uid;
	// a bind mount of this machine's file would carry this user's uid, which need not be 1000 (1001 on GitHub runners).
	execFileSync("docker", ["exec", "-i", CONTAINER, "sh", "-c", "mkdir -p /pubkey && cat > /pubkey/id_ed25519.pub && chown -R agent:agent /pubkey"], {
		input: readFileSync(join(pubDir, "id_ed25519.pub")),
		stdio: ["pipe", "ignore", "inherit"],
	});
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
