import type { Models } from "@earendil-works/pi-ai";

const LISTS = new Set<PropertyKey>(["getModels", "getModelsOfType", "getAvailable", "getAvailableOfType"]);

/**
 * The chat models a script is listed (`models.getModelsOfType("chat")`, `models.getAvailableOfType("chat")`) are the
 * ones in T3's model picker: a model hidden there (Settings → Providers) is left out, so the agent picks among the
 * models the user works with, for a script's own calls and for a thread it starts. Only the lists change. A hidden
 * model named outright is found as before (`getModelOfType`, a thread's model): whoever names it has a reason. Image
 * and classifier models are all listed, since the picker has none of them. `hidden` holds `provider/model` slugs and is
 * read at each call, so a change in Settings shows in the next list; no prompt text carries the list.
 */
export function listedModels<M extends Models>(models: M, hidden: () => ReadonlySet<string>): M {
	const shown = <T extends { readonly provider: string; readonly id: string }>(list: readonly T[]): readonly T[] => {
		const slugs = hidden();
		return slugs.size === 0 ? list : list.filter((model) => !slugs.has(`${model.provider}/${model.id}`));
	};
	// The unqualified lists are chat models; an `*OfType` list names its type first.
	const chat = (key: PropertyKey, args: readonly unknown[]) => key === "getModels" || key === "getAvailable" || args[0] === "chat";
	return new Proxy(models, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			// Bound to the runtime itself: its methods read private state a proxy does not have.
			const method = value.bind(target) as (...args: unknown[]) => unknown;
			if (!LISTS.has(key)) return method;
			return (...args: unknown[]) => {
				const result = method(...args);
				if (!chat(key, args)) return result;
				return result instanceof Promise ? result.then((list) => shown(list as readonly { provider: string; id: string }[])) : shown(result as readonly { provider: string; id: string }[]);
			};
		},
	});
}
