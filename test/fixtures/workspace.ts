import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { connectWorkspace, type WorkspaceConfig } from "../../src/workspace.ts";

export const CONTAINER = "pdc-spike-workspace";
/** Test SSH material lives in the repo's ignored .memory/. */
export const SSH_DIR = join(process.cwd(), ".memory", "ssh");
export const PORT = 4961;
export const testWorkspaceConfig = (): WorkspaceConfig => ({ host: "127.0.0.1", port: PORT, sshDir: SSH_DIR });
export const connectTestWorkspace = () => connectWorkspace(testWorkspaceConfig(), 30_000);

/** Run a shell command inside the workspace container through `docker exec` (not pi-env): our own inspection. */
export function dockerWorkspace(command: string): string {
	return execFileSync("docker", ["exec", CONTAINER, "sh", "-c", command], { encoding: "utf8" });
}
