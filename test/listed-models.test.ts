// The models a script is listed are the model picker's: a chat model hidden in T3's Settings is left out of the lists
// and of nothing else.
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { listedModels } from "../src/listed-models.ts";

it("lists leave out the chat models hidden in the picker; a lookup still finds one", async () => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one", name: "One" }, { id: "two", name: "Two" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const hidden = new Set<string>();
	const listed = listedModels(models, () => hidden);
	const ids = (list: readonly { id: string }[]) => list.map((model) => model.id);

	expect(ids(listed.getModelsOfType("chat"))).toEqual(["one", "two"]);
	hidden.add("faux/two");
	// Read at each call: the change shows in the next list.
	expect(ids(listed.getModelsOfType("chat"))).toEqual(["one"]);
	expect(ids(listed.getModelsOfType("chat", "faux"))).toEqual(["one"]);
	expect(ids(listed.getModels())).toEqual(["one"]);
	expect(ids(await listed.getAvailableOfType("chat"))).toEqual(ids(await models.getAvailableOfType("chat")).filter((id) => id !== "two"));
	expect(ids(await listed.getAvailable())).not.toContain("two");
	// Named outright, a hidden model is the model it was.
	expect(listed.getModelOfType("chat", "faux", "two")).toBe(models.getModelOfType("chat", "faux", "two"));
	expect(listed.getModel("faux", "two")?.id).toBe("two");
	// The picker lists no image or classifier models, so those lists are whole (here: empty, and not filtered).
	expect(listed.getModelsOfType("image")).toEqual(models.getModelsOfType("image"));
	// The runtime itself is untouched.
	expect(ids(models.getModelsOfType("chat"))).toEqual(["one", "two"]);
});
