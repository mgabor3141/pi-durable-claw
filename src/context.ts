import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, section, type ConversationRecord, type Extension, type Tx } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { loadSkills } from "./skills.ts";
import { WORKSPACE_HOME as DEFAULT_HOME } from "./workspace.ts";
import { LOCAL_PRECEDENCE, agentsSection, conversationTimeSection, cwdSection, skillsSection } from "./prompts.ts";


/** When a conversation started (epoch ms). A fork keeps its parent's: T3's undo and edit fork a thread's conversation. */
export const ConversationStartDoc = defineDoc<{ at: number | null }>({
	kind: "claw.conversation-start",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ at: null }),
	// Written once, and only a number: every change is a complete base.
	checkpointWhen: () => true,
});

/** `HarnessOptions.conversationCreated`: record when a conversation started, unless it is a fork that has its parent's. */
export function recordConversationStart(now: () => number = Date.now) {
	return async (tx: Tx, conversation: ConversationRecord): Promise<void> => {
		const started = await tx.doc(ConversationStartDoc, conversation.id);
		if (started.at === null) started.at = now();
	};
}

export interface WorkspaceContextOptions {
	/** The workspace home. Default `/home/agent`; tests override it. */
	readonly home?: string;
	/** The clock for a conversation with no recorded start (one created before it was recorded). Default `new Date()`. */
	readonly now?: () => Date;
}

/**
 * The system context after the preamble and tools: the global AGENTS.md, the
 * global skills, the working directory, the project's AGENTS.md and skills,
 * and the local time when the conversation started. A missing or unreadable
 * file is omitted; the prompt is never truncated.
 *
 * The files live in the workspace, so every read goes through pi-env over SSH.
 */
export function workspaceContextExtension(options: WorkspaceContextOptions = {}): Extension {
	const home = options.home ?? DEFAULT_HOME;
	const now = options.now ?? (() => new Date());

	return defineExtension({
		name: "workspace-context",
		sections: [
			section(
				"global-agents",
				async (input, context) => {
					const env = input.env;
					if (env === undefined) return undefined;
					const path = join(home, "AGENTS.md");
					const body = await readBody(env, path, context);
					return body === undefined ? undefined : agentsSection("global", path, body);
				},
				{ tag: false },
			),

			section(
				"global-skills",
				async (input, context) => {
					const env = input.env;
					if (env === undefined) return undefined;
					const global = await loadSkills(env, join(home, ".agents", "skills"), context);
					const local = env.cwd === home ? [] : await loadSkills(env, join(env.cwd, ".agents", "skills"), context);
					const shadows = new Set(local.map((skill) => skill.name));
					return skillsSection("global", global.filter((skill) => !shadows.has(skill.name)));
				},
				{ tag: false },
			),

			section("cwd", (input) => (input.env === undefined ? undefined : cwdSection(input.env.cwd)), { tag: false }),

			section(
				"local-agents",
				async (input, context) => {
					const env = input.env;
					if (env === undefined || env.cwd === home) return undefined;
					const path = join(env.cwd, "AGENTS.md");
					const body = await readBody(env, path, context);
					return body === undefined ? undefined : agentsSection("local", path, body, LOCAL_PRECEDENCE);
				},
				{ tag: false },
			),

			section(
				"local-skills",
				async (input, context) => {
					const env = input.env;
					if (env === undefined || env.cwd === home) return undefined;
					return skillsSection("local", await loadSkills(env, join(env.cwd, ".agents", "skills"), context));
				},
				{ tag: false },
			),

			section(
				"conversation-time",
				// The recorded start, so a prompt rendered again (`/reload`, a compaction) still names when the conversation began.
				async (input, context) => {
					const started = (await input.read.snapshot(ConversationStartDoc, input.conversationId, context))?.at ?? null;
					return conversationTimeSection(formatLocalTime(started === null ? now() : new Date(started)));
				},
				{ tag: false },
			),
		],
	});
}

async function readBody(env: ExecutionEnv, path: string, context: Context): Promise<string | undefined> {
	const result = await env.readTextFile(path, context);
	if (!result.ok) return undefined;
	const body = result.value.trim();
	return body.length === 0 ? undefined : body;
}

function formatLocalTime(date: Date): string {
	const zone = process.env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	try {
		const local = new Intl.DateTimeFormat("sv-SE", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(date);
		const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
			.formatToParts(date)
			.find((part) => part.type === "timeZoneName")
			?.value.replace(/^GMT/, "UTC");
		return offset === undefined ? `${local} ${zone}` : `${local} ${zone} (${offset})`;
	} catch {
		return date.toISOString();
	}
}
