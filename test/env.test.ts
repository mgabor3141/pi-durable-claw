// One rule for every setting: a line left blank in `.env` is a setting that is not set.
import { expect, it } from "vitest";
import { setting, settingList } from "../src/env.ts";
import { hindsightConfig } from "../src/hindsight.ts";
import { webConfig } from "../src/web.ts";

it("a blank setting is an unset one, a set one is trimmed, and a list drops its blanks", () => {
	const env = { A: "  value ", B: "", C: "   ", LIST: " one, ,two ,", EMPTY: "" };
	expect(setting(env, "A")).toBe("value");
	expect(setting(env, "B")).toBeUndefined();
	expect(setting(env, "C")).toBeUndefined();
	expect(setting(env, "MISSING")).toBeUndefined();
	expect(settingList(env, "LIST")).toEqual(["one", "two"]);
	expect(settingList(env, "EMPTY")).toEqual([]);
	expect(settingList(env, "MISSING")).toEqual([]);
});

it("the services read their settings by it: blank is off", () => {
	expect(hindsightConfig({ HINDSIGHT_URL: " " })).toBeUndefined();
	expect(hindsightConfig({ HINDSIGHT_URL: " http://h:8888/ ", HINDSIGHT_BANK: "", HINDSIGHT_API_KEY: " " })).toEqual({ url: "http://h:8888", bank: "claw" });
	expect(webConfig({ SEARXNG_URL: "", READER_URL: " http://r:3000/ " })).toEqual({ readerUrl: "http://r:3000" });
});
