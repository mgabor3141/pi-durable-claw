import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HostKeyUnknownError, RemoteExecutionEnv, acceptHostKey, connectSsh, scanHostKey, type Connection, type SshTarget } from "@earendil-works/pi-env";

/** Where the workspace container is and where the harness keeps its SSH material (never inside the workspace). */
export interface WorkspaceConfig {
	host: string;
	port: number;
	/** Holds `id_ed25519` and `known_hosts`. */
	sshDir: string;
}

/** The workspace: key-only sshd, non-root `agent`, reached over SSH with pi-env. */
export function workspaceTarget(config: WorkspaceConfig): SshTarget {
	return {
		host: config.host,
		port: config.port,
		user: "agent",
		identityFile: join(config.sshDir, "id_ed25519"),
		knownHostsFile: join(config.sshDir, "known_hosts"),
		hostKeyAlias: "claw-workspace",
	};
}

/** Generate the harness's keypair on first use; with `publishDir`, copy the public key there for the workspace. */
export function ensureKeypair(sshDir: string, publishDir?: string): void {
	mkdirSync(sshDir, { recursive: true, mode: 0o700 });
	const key = join(sshDir, "id_ed25519");
	if (!existsSync(key)) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "claw-harness", "-f", key]);
	if (publishDir !== undefined) {
		mkdirSync(publishDir, { recursive: true });
		copyFileSync(`${key}.pub`, join(publishDir, "id_ed25519.pub"));
	}
}

export type WorkspaceConnection = { connection: Connection; remote: { home: string; platform: string; arch: string } };

/**
 * Connect once and deploy pi-env's daemon. The host key is accepted on first use (scan + accept, kept in `sshDir`);
 * a CHANGED key is never accepted. Retries while the workspace is still starting.
 */
export async function connectWorkspace(config: WorkspaceConfig, timeoutMs = 60_000): Promise<WorkspaceConnection> {
	const target = workspaceTarget(config);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await connectSsh(target);
		} catch (error) {
			if (error instanceof HostKeyUnknownError) {
				await acceptHostKey(target, (await scanHostKey(target)).lines);
				continue;
			}
			if (Date.now() > deadline || (error as Error).name === "HostKeyChangedError") throw error;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
}

/** The workspace as a pi-durable ExecutionEnv: the agent's files and bash, over SSH. */
export function workspaceEnv(connection: Connection, cwd = "/workspace"): RemoteExecutionEnv {
	return new RemoteExecutionEnv({ connection, id: "pi-env:claw-workspace", cwd });
}
