import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Test fixture: a key-bearing harness tool. It reads a key and returns a record derived from it — never the key. It is
 * registered with `callers: ["tools"]`: the model is never offered it, only a codemode script can call it. The tests
 * use it to prove the key never reaches the workspace.
 */
export function secretLookupTool(key: string | undefined): ToolRegistration {
	return defineTool({
		name: "secret_lookup",
		description: "Look up a secret record by name. Returns the record, not the key.",
		parameters: Type.Object({ name: Type.String() }),
		structuredOutputSchema: Type.Object({ name: Type.String(), value: Type.String(), scope: Type.String() }),
		callers: ["tools"],
		async execute(args) {
			if (key === undefined || key === "") throw new Error("secret_lookup: no key configured in the harness");
			const record = { name: args.name, value: `record-for-${args.name}-sig-${key.slice(-6)}`, scope: "harness" as const };
			return { output: [{ type: "text", text: JSON.stringify(record) }], structuredOutput: record };
		},
	});
}
