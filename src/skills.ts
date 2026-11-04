import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** One skill as the system prompt sees it: metadata only, never the body. */
export interface Skill {
	readonly name: string;
	readonly description: string;
	readonly path: string;
}

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Load the skills directly under `dir`. A skill is a `<name>/SKILL.md` entry;
 * references and other files are not scanned. Files live in the workspace, so
 * this goes through the same ExecutionEnv as the workspace tools.
 */
export async function loadSkills(env: ExecutionEnv, dir: string, context: Context): Promise<Skill[]> {
	const paths = await skillPaths(env, dir, context);
	const skills: Skill[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		const skill = await loadSkill(env, path, context);
		if (skill === undefined || seen.has(skill.name)) continue;
		seen.add(skill.name);
		skills.push(skill);
	}
	return skills;
}

async function skillPaths(env: ExecutionEnv, dir: string, context: Context): Promise<string[]> {
	const exists = await env.exists(dir, context);
	if (!exists.ok || !exists.value) return [];

	if (env.listFiles !== undefined) {
		const listing = await env.listFiles(dir, { hidden: true, gitignore: false, exclude: ["node_modules"], maxEntries: 10_000 }, context);
		if (listing.ok) {
			return listing.value.entries
				.filter((entry) => entry.kind !== "directory" && isSkillPath(entry.path))
				.map((entry) => join(dir, entry.path))
				.sort();
		}
	}

	const listing = await env.listDir(dir, context);
	if (!listing.ok) return [];
	const paths: string[] = [];
	for (const entry of listing.value) {
		if (entry.kind !== "directory" && entry.kind !== "symlink") continue;
		const path = join(entry.path, "SKILL.md");
		const found = await env.exists(path, context);
		if (found.ok && found.value) paths.push(path);
	}
	return paths.sort();
}

function isSkillPath(path: string): boolean {
	const parts = path.split("/");
	return parts.length === 2 && parts[1] === "SKILL.md";
}

async function loadSkill(env: ExecutionEnv, path: string, context: Context): Promise<Skill | undefined> {
	const result = await env.readTextFile(path, context);
	if (!result.ok) return undefined;
	const frontmatter = parseFrontmatter(result.value);
	if (frontmatter === undefined) return undefined;

	const description = frontmatter.description;
	if (typeof description !== "string") return undefined;
	const trimmed = description.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_DESCRIPTION) return undefined;

	const rawName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : basename(dirname(path));
	if (rawName.length === 0 || rawName.length > MAX_NAME || !NAME.test(rawName)) return undefined;
	if (frontmatter["disable-model-invocation"] === true) return undefined;

	return { name: rawName, description: trimmed, path };
}

type Frontmatter = Record<string, string | boolean>;

function parseFrontmatter(text: string): Frontmatter | undefined {
	const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (match === null) return undefined;
	const fields: Frontmatter = {};
	const lines = match[1].split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || /^\s/.test(line)) continue;
		const key = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (key === null) continue;
		const name = key[1];
		const raw = key[2].trim();
		if (raw === ">" || raw === ">-" || raw === "|" || raw === "|-") {
			const block: string[] = [];
			let next = index + 1;
			while (next < lines.length) {
				const candidate = lines[next];
				if (candidate === undefined || (!/^\s/.test(candidate) && candidate.trim() !== "")) break;
				block.push(candidate);
				next += 1;
			}
			while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
			fields[name] = raw.startsWith(">")
				? block.map((entry) => entry.trim()).filter((entry) => entry !== "").join(" ")
				: block.map((entry) => entry.replace(/^\s{2}/, "")).join("\n");
			index = next - 1;
			continue;
		}
		fields[name] = scalar(raw);
	}
	return fields;
}

function scalar(raw: string): string | boolean {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw.startsWith('"') && raw.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed === "string") return parsed;
		} catch {
			// Fall through to the quoted form.
		}
		return raw.slice(1, -1);
	}
	if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
	return raw.replace(/\s+#.*$/, "").trim();
}
