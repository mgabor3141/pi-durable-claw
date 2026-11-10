// Remote access built in (`tailnet.ts`): the harness starts `claw-tailnet` when `claw remote` turns it on, restarts it
// when it exits, stops it when turned off, and tells T3 what it reports. A stand-in program records how it was started
// and prints the status lines the test gives it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { advertised, deviceName, readRemoteEnabled, Tailnet, tailnetUrl, writeRemoteEnabled, type TailnetStatus } from "../src/tailnet.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => void (await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))));

const STAND_IN = `
const fs = require("node:fs");
const [control, ...args] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(control, "utf8"));
fs.appendFileSync(control + ".runs", JSON.stringify(args) + "\\n");
for (const line of plan.lines) console.log(typeof line === "string" ? line : JSON.stringify(line));
console.error("tsnet says hello");
if (plan.exit) process.exit(3);
process.on("SIGTERM", () => { fs.appendFileSync(control + ".runs", "stopped\\n"); process.exit(0); });
setInterval(() => {}, 1000);
`;

async function setup(plan: { lines: unknown[]; exit?: boolean }) {
	const root = await mkdtemp(join(tmpdir(), "claw-tailnet-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const script = join(root, "stand-in.cjs");
	const control = join(root, "plan.json");
	await writeFile(script, STAND_IN);
	await writeFile(control, JSON.stringify(plan));
	const infos: string[] = [];
	const warnings: string[] = [];
	const tailnet = new Tailnet({
		root,
		hostname: "claw",
		allow: ["friend@example.com"],
		port: 3775,
		workspace: { host: "workspace", port: 22, user: "agent", sshDir: "/data/ssh", hostKeyAlias: "claw-workspace" },
		command: [process.execPath, script, control],
		log: { info: (message, fields) => void infos.push(fields === undefined ? message : `${message} ${JSON.stringify(fields)}`), warn: (message) => void warnings.push(message) },
		pollMs: 50,
	});
	cleanups.unshift(() => tailnet.close());
	const runs = async () => (await readFile(`${control}.runs`, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
	return { root, tailnet, infos, warnings, runs, control };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
	for (let waited = 0; waited < ms; waited += 25) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out");
};

const RUNNING: TailnetStatus = { state: "running", dnsName: "claw.tail1234.ts.net", magicDns: true, https: true, owner: "me@example.com" };

it("is off until turned on; then it runs claw-tailnet with the harness's paths, and T3 learns what it reports", { timeout: 20_000 }, async () => {
	const { root, tailnet, infos, runs } = await setup({ lines: [{ state: "needs-login", authUrl: "https://login.tailscale.com/a/xyz", magicDns: false, https: false }, RUNNING] });
	const changes: unknown[] = [];
	tailnet.subscribe(() => changes.push(tailnet.current()));
	tailnet.start();
	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(await runs()).toEqual([]);
	expect(tailnet.current()).toEqual({});

	writeRemoteEnabled(root, true);
	expect(readRemoteEnabled(root)).toBe(true);
	await until(() => tailnet.current().ssh !== undefined);
	expect(JSON.parse((await runs())[0]!)).toEqual([
		"--state-dir", join(root, "tailscale"),
		"--hostname", "claw",
		"--upstream", "http://127.0.0.1:3775",
		"--workspace", "workspace:22",
		"--workspace-user", "agent",
		"--identity", "/data/ssh/id_ed25519",
		"--known-hosts", "/data/ssh/known_hosts",
		"--host-key-alias", "claw-workspace",
		"--allow", "friend@example.com",
	]);
	expect(tailnet.current()).toEqual({ httpBaseUrl: "https://claw.tail1234.ts.net", ssh: { host: "claw.tail1234.ts.net", username: "agent" } });
	expect(changes).toEqual([tailnet.current()]);
	expect(infos).toContain('remote access: log this device in to your tailnet {"url":"https://login.tailscale.com/a/xyz"}');
	expect(infos.some((line) => line.startsWith("remote access: on the tailnet"))).toBe(true);
	await until(() => infos.includes("tailnet: tsnet says hello"));

	writeRemoteEnabled(root, false);
	await until(async () => (await runs()).includes("stopped"));
	expect(tailnet.current()).toEqual({});
	expect(changes.at(-1)).toEqual({});
});

it("restarts the program when it exits, and stops for good when closed", { timeout: 20_000 }, async () => {
	const { root, tailnet, warnings, runs } = await setup({ lines: [RUNNING], exit: true });
	writeRemoteEnabled(root, true);
	tailnet.start();
	await until(async () => (await runs()).length >= 2);
	expect(warnings.filter((warning) => warning === "remote access: claw-tailnet exited; restarting").length).toBeGreaterThanOrEqual(1);
	await tailnet.close();
	const after = (await runs()).length;
	await new Promise((resolve) => setTimeout(resolve, 2_500));
	expect((await runs()).length).toBe(after);
});

it("tells T3 the SSH host as soon as the node runs, and the HTTPS URL only once certificates work", () => {
	expect(advertised(undefined, "agent")).toEqual({});
	expect(advertised({ ...RUNNING, state: "needs-login" }, "agent")).toEqual({});
	expect(advertised({ ...RUNNING, https: false }, "agent")).toEqual({ ssh: { host: "claw.tail1234.ts.net", username: "agent" } });
	expect(deviceName("Gábor's claw")).toBe("g-bor-s-claw");
	expect(deviceName("---")).toBe("claw");
});

it("links use the tailnet address while remote access is on and serves HTTPS, from its last report", async () => {
	const { root } = await setup({ lines: [] });
	await mkdir(join(root, "tailscale"), { recursive: true });
	await writeFile(join(root, "tailscale", "status.json"), JSON.stringify({ ...RUNNING, state: "stopped" }));
	expect(tailnetUrl(root), "off").toBeUndefined();
	writeRemoteEnabled(root, true);
	expect(tailnetUrl(root)).toBe("https://claw.tail1234.ts.net");
	await writeFile(join(root, "tailscale", "status.json"), JSON.stringify({ ...RUNNING, https: false }));
	expect(tailnetUrl(root), "no certificates yet").toBeUndefined();
});

it("a malformed remote.json fails loudly", async () => {
	const { root } = await setup({ lines: [] });
	await writeFile(join(root, "remote.json"), JSON.stringify({ enabled: "yes" }));
	expect(() => readRemoteEnabled(root)).toThrow(/"enabled" must be true or false/);
});
