export interface SchemaCompatibilityOptions {
	allowAdditionalProperties?: boolean;
	allowDefinitions?: boolean;
	allowDependencies?: boolean;
	maxDepth?: number;
}

interface TraversalState {
	depth: number;
	seen: WeakSet<object>;
	options: SchemaCompatibilityOptions;
}

/**
 * Check if a JSON schema is compatible with basic tool-calling backends.
 */
export function isSchemaCompatible(schema: unknown, options: SchemaCompatibilityOptions = {}): boolean {
	const state: TraversalState = {
		depth: 0,
		seen: new WeakSet(),
		options: {
			maxDepth: 10,
			...options,
		},
	};
	try {
		walkSchema(schema, state);
		return true;
	} catch {
		return false;
	}
}

function walkSchema(value: unknown, state: TraversalState): void {
	if (state.depth > (state.options.maxDepth ?? 10)) {
		throw new Error("Schema too deep");
	}

	if (Array.isArray(value)) {
		handleArraySchema(value, state);
		return;
	}

	if (value === null || typeof value !== "object") {
		return;
	}

	if (state.seen.has(value)) {
		return;
	}
	state.seen.add(value);

	const obj = value as Record<string, unknown>;
	checkUnsupportedKeywords(obj, state);

	const nextState = { ...state, depth: state.depth + 1 };
	for (const key of Object.keys(obj)) {
		walkSchema(obj[key], nextState);
	}
}

function handleArraySchema(value: unknown[], state: TraversalState): void {
	if (state.seen.has(value)) return;
	state.seen.add(value);
	const nextState = { ...state, depth: state.depth + 1 };
	for (const entry of value) {
		walkSchema(entry, nextState);
	}
}

function checkUnsupportedKeywords(obj: Record<string, unknown>, state: TraversalState): void {
	if (state.options.allowAdditionalProperties !== true && obj.additionalProperties !== undefined) {
		throw new Error("additionalProperties not supported");
	}
	if (state.options.allowDefinitions !== true && (obj.definitions !== undefined || obj.$defs !== undefined)) {
		throw new Error("definitions not supported");
	}
	if (state.options.allowDependencies !== true && obj.dependencies !== undefined) {
		throw new Error("dependencies not supported");
	}
	if (obj.$ref !== undefined) {
		throw new Error("$ref not supported");
	}
}
