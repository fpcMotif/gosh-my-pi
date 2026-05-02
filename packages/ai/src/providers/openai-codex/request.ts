// I'll need to move normalizeCodexToolChoice to utils or keep it in main
import type { RequestBody, InputItem } from "./request-transformer";

export type CodexToolPayload = {
	type: "function" | "custom";
	name: string;
	description: string;
	parameters?: Record<string, unknown>;
	format?: {
		type: "grammar";
		syntax: "lark" | "regex";
		definition: string;
	};
	strict?: boolean;
};

export function buildAppendInput(previous: RequestBody | undefined, current: RequestBody): InputItem[] | null {
	if (previous === undefined || previous === null) return null;
	if (Array.isArray(previous.input) === false || Array.isArray(current.input) === false) return null;
	if (current.input!.length <= previous.input!.length) return null;

	const previousWithoutInput = { ...previous, input: undefined };
	const currentWithoutInput = { ...current, input: undefined };
	if (JSON.stringify(previousWithoutInput) !== JSON.stringify(currentWithoutInput)) {
		return null;
	}

	const prevInput = previous.input!;
	const currInput = current.input!;
	for (let index = 0; index < prevInput.length; index += 1) {
		if (JSON.stringify(prevInput[index]) !== JSON.stringify(currInput[index])) {
			return null;
		}
	}
	return currInput.slice(prevInput.length) as InputItem[];
}
