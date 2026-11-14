// The image's launcher (launcher/launcher.ts): it installs the harness as a package, runs it, switches versions on
// `claw update`, and goes back when a version does not come up. Here the "harness" is a small script and the
// dependency install does nothing, so every path runs in seconds with no network: real directories, real archives
// (`git archive`, the format GitHub serves), real child processes.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { archiveCommit, check, describe, install, type LauncherConfig, nodeIsEnough, readState, rollback, stage, supervise, update } from "../launcher/launcher.ts";

/** A harness that serves, or one that changes the data and exits before it serves. Each writes what it was started with. */
const HOST = (name: string, behaviour: "serves" | "breaks") => `
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[process.argv.indexOf("--root") + 1];
// Beside the data dir, not in it: the data is put back when a version is undone.
appendFileSync(join(root, "..", "starts.log"), ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");
writeFileSync(join(root, "..", "launcher-command.json"), process.env.CLAW_LAUNCHER ?? "none");
if (${JSON.stringify(behaviour)} === "breaks") {
	writeFileSync(join(root, "durable.db"), "migrated by ${name}");
	process.exit(3);
}
const server = createServer((request, response) => response.writeHead(200).end("{}")).listen(Number(process.env.CLAW_PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

async function setup() {
	const base = mkdtempSync(join(tmpdir(), "claw-launcher-"));
	onTestFinished(() => rmSync(base, { recursive: true, force: true }));
	const repo = join(base, "repo");
	const app = join(base, "app");
	const root = join(base, "data");
	mkdirSync(repo);
	mkdirSync(root);
	git(repo, "init", "-q", "-b", "main");
	/** Commit a version of the harness to `branch` and return its commit. */
	const publish = (name: string, behaviour: "serves" | "breaks", options: { branch?: string; node?: string } = {}) => {
		git(repo, "checkout", "-q", "-B", options.branch ?? "main");
		writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "harness", type: "module", main: "host.mjs", ...(options.node === undefined ? {} : { engines: { node: options.node } }) }));
		writeFileSync(join(repo, "host.mjs"), HOST(name, behaviour));
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", name);
		return git(repo, "rev-parse", "HEAD");
	};
	const port = await new Promise<number>((done) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => done(port));
		});
	});
	process.env.CLAW_PORT = String(port);
	const log: string[] = [];
	const signals = new EventEmitter();
	const config = (pin = ""): LauncherConfig => ({
		app,
		root,
		listen: "127.0.0.1",
		pin,
		port,
		log: (line) => void log.push(line),
		signals,
		// GitHub's archive of a ref, made the way GitHub makes it.
		download: async (ref, file) => {
			try {
				execFileSync("git", ["archive", "--format=tar.gz", `--prefix=harness-${ref}/`, "-o", file, ref], { cwd: repo, stdio: "pipe" });
			} catch {
				throw new Error(`no version ${ref}`);
			}
		},
		installDependencies: async (dir) => writeFileSync(join(dir, "installed"), "yes"),
	});
	const until = async (what: string, check: () => boolean) => {
		for (let waited = 0; !check(); waited += 50) {
			if (waited > 15_000) throw new Error(`timed out waiting for ${what}\n${log.join("\n")}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const starts = () => (existsSync(join(base, "starts.log")) ? readFileSync(join(base, "starts.log"), "utf8").trim().split("\n") : []);
	const serving = async () => {
		try {
			return (await fetch(`http://127.0.0.1:${port}/`)).ok;
		} catch {
			return false;
		}
	};
	return { app, root, repo, publish, config, log, signals, until, starts, serving };
}

it("reads the commit out of an archive, and compares Node versions", async () => {
	const { repo, publish } = await setup();
	const commit = publish("one", "serves");
	const archive = execFileSync("git", ["archive", "--format=tar.gz", "--prefix=harness-main/", "main"], { cwd: repo, maxBuffer: 1 << 24 });
	expect(archiveCommit(archive)).toBe(commit);
	expect(nodeIsEnough(">=22.19.0", "v24.3.0")).toBe(true);
	expect(nodeIsEnough(">=22.19.0", "v22.19.0")).toBe(true);
	expect(nodeIsEnough(">=22.19.0", "v22.18.9")).toBe(false);
	expect(nodeIsEnough(">=26.0.0", "v24.3.0")).toBe(false);
	expect(nodeIsEnough(undefined, "v24.3.0")).toBe(true);
});

it("the first start installs the newest version and runs it; an update restarts into the next, keeping the one before and the data as it was", { timeout: 60_000 }, async () => {
	const t = await setup();
	const one = t.publish("one", "serves");
	writeFileSync(join(t.root, "durable.db"), "conversations");
	const running = supervise(t.config());
	await t.until("the first version to start", () => t.starts().length === 1);
	const id = one.slice(0, 12);
	expect(readState(t.app)).toEqual({ current: id, previous: null, pending: null, unproven: false });
	expect(t.starts()[0]).toBe(`one --root ${t.root} --listen 127.0.0.1`);
	expect(readFileSync(join(t.app, "versions", id, "installed"), "utf8"), "its dependencies were installed").toBe("yes");
	expect(describe(t.config())).toContain(`running: ${id} (latest, commit ${one})`);
	expect(await update(t.config(), undefined)).toBe(`already at version ${id} (latest): nothing to do`);

	// The harness is told how to run this launcher, and can ask what is newest without installing anything.
	const command = JSON.parse(readFileSync(join(t.root, "..", "launcher-command.json"), "utf8")) as string[];
	expect(command.slice(1)).toEqual([expect.stringMatching(/launcher\.ts$/), "--app", t.app, "--root", t.root, "--listen", "127.0.0.1", "--"]);
	expect(await check(t.config())).toEqual({ current: id, latest: id, undone: null });

	// A newer commit on main: installed beside the first, and run after the restart `claw update` asks for.
	const two = t.publish("two", "serves");
	expect(await check(t.config())).toEqual({ current: id, latest: two.slice(0, 12), undone: null });
	expect(readdirSync(join(t.app, "versions")), "a check installs nothing").toEqual([id]);
	expect(await update(t.config(), undefined)).toContain(`version ${two.slice(0, 12)} is installed`);
	expect(readState(t.app).pending).toBe(two.slice(0, 12));
	t.signals.emit("SIGHUP");
	await t.until("the second version to serve", () => readState(t.app).current === two.slice(0, 12) && !readState(t.app).unproven);
	expect(readState(t.app)).toEqual({ current: two.slice(0, 12), previous: id, pending: null, unproven: false, undone: null });
	expect(t.starts().map((line) => line.split(" ")[0])).toEqual(["one", "two"]);
	expect(readFileSync(join(t.app, "data-before-update", "durable.db"), "utf8")).toBe("conversations");
	expect(readdirSync(join(t.app, "versions")).sort()).toEqual([id, two.slice(0, 12)].sort());

	// Back to the one before, by hand.
	expect(rollback(t.config())).toContain(`version ${id}`);
	t.signals.emit("SIGHUP");
	await t.until("the first version to serve again", () => readState(t.app).current === id && !readState(t.app).unproven);
	expect(t.starts().map((line) => line.split(" ")[0])).toEqual(["one", "two", "one"]);

	t.signals.emit("SIGTERM");
	expect(await running).toBe(0);
	expect(await t.serving()).toBe(false);
});

it("a version that exits before it serves is undone: the one before runs again, on the data as it was", { timeout: 60_000 }, async () => {
	const t = await setup();
	const one = t.publish("one", "serves");
	writeFileSync(join(t.root, "durable.db"), "conversations");
	const running = supervise(t.config());
	await t.until("the first version to start", () => t.starts().length === 1);
	for (let tries = 0; !(await t.serving()); tries++) {
		if (tries > 200) throw new Error("never served");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	const bad = t.publish("bad", "breaks");
	await update(t.config(), undefined);
	t.signals.emit("SIGHUP");
	await t.until("the launcher to go back", () => t.starts().length === 3);
	expect(t.starts().map((line) => line.split(" ")[0])).toEqual(["one", "bad", "one"]);
	expect(readState(t.app)).toMatchObject({ current: one.slice(0, 12), previous: null, pending: null, unproven: false });
	expect(readFileSync(join(t.root, "durable.db"), "utf8"), "what the bad version wrote is gone").toBe("conversations");
	expect(t.log.join("\n")).toContain(`version ${bad.slice(0, 12)} exited (3) before it served: going back to version ${one.slice(0, 12)}`);
	// What the harness then tells T3: the version is still the newest, and it was tried.
	expect(await check(t.config())).toMatchObject({ current: one.slice(0, 12), latest: bad.slice(0, 12), undone: { id: bad.slice(0, 12), code: 3 } });
	for (let tries = 0; !(await t.serving()); tries++) {
		if (tries > 200) throw new Error("the version before never served again");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	t.signals.emit("SIGTERM");
	expect(await running).toBe(0);
});

it("CLAW_VERSION names the version to run: installed at a start when another runs, and not moved by claw update", { timeout: 60_000 }, async () => {
	const t = await setup();
	const one = t.publish("one", "serves");
	const next = t.publish("next", "serves", { branch: "next" });
	t.publish("one again", "serves");
	// A commit, pinned from the first start.
	let running = supervise(t.config(one));
	await t.until("the pinned commit to start", () => t.starts().length === 1);
	expect(readState(t.app).current).toBe(one.slice(0, 12));
	await expect(update(t.config(one), "next")).rejects.toThrow(`CLAW_VERSION is ${one}`);
	// A pinned commit has nothing newer; installing "the newest" is the pin itself.
	expect(await check(t.config(one))).toMatchObject({ current: one.slice(0, 12), latest: one.slice(0, 12) });
	expect(await stage(t.config(one), undefined)).toMatchObject({ waits: false, installed: { id: one.slice(0, 12) } });
	expect(() => rollback(t.config(one))).toThrow(`CLAW_VERSION is ${one}`);
	t.signals.emit("SIGTERM");
	await running;

	// The pin changed (.env, then a restart): the next start switches.
	running = supervise(t.config("next"));
	await t.until("the branch to start", () => t.starts().length === 2);
	expect(readState(t.app)).toMatchObject({ current: next.slice(0, 12), previous: one.slice(0, 12) });
	expect(t.starts().map((line) => line.split(" ")[0])).toEqual(["one", "next"]);
	t.signals.emit("SIGTERM");
	await running;

	// The same pin again: nothing is installed, though the branch could have moved. `claw update` is what follows it.
	const moved = t.publish("next moved", "serves", { branch: "next" });
	running = supervise(t.config("next"));
	await t.until("the same version to start", () => t.starts().length === 3);
	expect(readState(t.app).current).toBe(next.slice(0, 12));
	expect(await update(t.config("next"), undefined)).toContain(`version ${moved.slice(0, 12)} is installed`);
	t.signals.emit("SIGTERM");
	await running;
});

it("refuses a version it cannot run, and leaves nothing half installed", { timeout: 60_000 }, async () => {
	const t = await setup();
	t.publish("needs a newer node", "serves", { node: ">=99.0.0" });
	await expect(install(t.config(), "latest")).rejects.toThrow(/needs Node >=99\.0\.0, and this image has v\d+/);
	await expect(install(t.config(), "no-such-branch")).rejects.toThrow("no version no-such-branch");
	expect(readdirSync(join(t.app, "versions"))).toEqual([]);
	expect(existsSync(join(t.app, "install.lock"))).toBe(false);

	// A directory instead of a ref: its node_modules, .git, data and .env are not the package's.
	const checkout = join(t.repo, "..", "checkout");
	mkdirSync(join(checkout, "node_modules", "x"), { recursive: true });
	mkdirSync(join(checkout, "data"));
	mkdirSync(join(checkout, "src", "data"), { recursive: true });
	writeFileSync(join(checkout, ".env"), "SECRET=1");
	writeFileSync(join(checkout, "package.json"), JSON.stringify({ main: "host.mjs" }));
	const local = await install(t.config(), `file:${checkout}`);
	expect(local.id).toMatch(/^local-\d+$/);
	expect(readdirSync(join(t.app, "versions", local.id)).sort()).toEqual(["installed", "package.json", "src", "version.json"]);
	expect(existsSync(join(t.app, "versions", local.id, "src", "data"))).toBe(true);
});
