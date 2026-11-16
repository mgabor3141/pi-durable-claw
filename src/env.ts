// Settings come from the environment (`.env`, passed whole). One rule for all of them: a line left blank is a setting
// that is not set.

export type Env = Readonly<Record<string, string | undefined>>;

/** A setting's value, trimmed; `undefined` when it is unset or blank. */
export function setting(env: Env, name: string): string | undefined {
	const value = env[name]?.trim();
	return value === undefined || value === "" ? undefined : value;
}

/** A setting that is a list: comma-separated, each item trimmed, blanks dropped. Unset is the empty list. */
export function settingList(env: Env, name: string): string[] {
	return (setting(env, name) ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
}
