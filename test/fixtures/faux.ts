import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

/** Models with only the faux provider registered. */
export function fauxModels() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models };
}

export function codemodeToolCall(script: string, id = "c1") {
	return fauxAssistantMessage([fauxToolCall("codemode", { code: script }, { id })], { stopReason: "toolUse" });
}

export function codemodeAnswer(text: string) {
	return fauxAssistantMessage([fauxText(text)]);
}
