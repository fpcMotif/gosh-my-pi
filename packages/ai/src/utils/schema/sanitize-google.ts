import { CCA_UNSUPPORTED_SCHEMA_FIELDS, UNSUPPORTED_SCHEMA_FIELDS } from "./fields";

export interface SanitizeSchemaOptions {
	seen: WeakSet<object>;
	unsupportedFields: Set<string>;
	stripNullableKeyword: boolean;
	normalizeTypeArrayToNullable: boolean;
	insideProperties: boolean;
}

/**
 * Sanitize a JSON schema for Google's Generative AI API.
 * Google's API expects a subset of JSON Schema and is strict about unknown fields.
 */
export function sanitizeSchemaForGoogle(schema: unknown, options: Partial<SanitizeSchemaOptions> = {}): unknown {
	const fullOptions: SanitizeSchemaOptions = {
		seen: new WeakSet(),
		unsupportedFields: new Set(UNSUPPORTED_SCHEMA_FIELDS),
		stripNullableKeyword: false,
		normalizeTypeArrayToNullable: true,
		insideProperties: false,
		...options,
	};
	return sanitizeSchemaImpl(schema, fullOptions);
}

/**
 * Sanitize a JSON Schema for Cloud Code Assist Claude.
 */
export function sanitizeSchemaForCCA(schema: unknown, options: Partial<SanitizeSchemaOptions> = {}): unknown {
	return sanitizeSchemaImpl(schema, {
		seen: new WeakSet(),
		unsupportedFields: new Set(CCA_UNSUPPORTED_SCHEMA_FIELDS),
		stripNullableKeyword: true,
		normalizeTypeArrayToNullable: true,
		insideProperties: false,
		...options,
	});
}

/**
 * Sanitize a JSON Schema for MCP tool parameter validation (AJV compatibility).
 */
export function sanitizeSchemaForMCP(schema: unknown, options: Partial<SanitizeSchemaOptions> = {}): unknown {
	return sanitizeSchemaImpl(schema, {
		seen: new WeakSet(),
		unsupportedFields: new Set(["$schema"]),
		stripNullableKeyword: true,
		normalizeTypeArrayToNullable: false,
		insideProperties: false,
		...options,
	});
}

function sanitizeSchemaImpl(value: unknown, options: SanitizeSchemaOptions): unknown {
	if (Array.isArray(value)) {
		return sanitizeArray(value, options);
	}
	if (value === null || value === undefined || typeof value !== "object") {
		return value;
	}
	if (options.seen.has(value as object)) return {};
	options.seen.add(value as object);

	const obj = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	// Handle combiners (anyOf, oneOf) - Google expects enum if they all have const
	const combinerResult = handleSchemaCombiners(obj, options);
	if (combinerResult !== null) return combinerResult;

	// Regular field processing
	let constValue: unknown;
	for (const [key, entry] of Object.entries(obj)) {
		if (shouldSkipField(key, options)) continue;
		if (key === "const") {
			constValue = entry;
			continue;
		}
		result[key] = sanitizeSchemaImpl(entry, {
			...options,
			insideProperties: key === "properties",
		});
	}

	normalizeSchemaType(result, options);
	handleConstValue(result, constValue);

	return result;
}

function sanitizeArray(value: unknown, options: SanitizeSchemaOptions): unknown[] {
	if (!Array.isArray(value)) return [];
	if (options.seen.has(value)) return [];
	options.seen.add(value);
	return value.map(entry => sanitizeSchemaImpl(entry, options));
}

function shouldSkipField(key: string, options: SanitizeSchemaOptions): boolean {
	if (!options.insideProperties && options.unsupportedFields.has(key)) return true;
	if (options.stripNullableKeyword && key === "nullable") return true;
	return false;
}

function handleSchemaCombiners(
	obj: Record<string, unknown>,
	options: SanitizeSchemaOptions,
): Record<string, unknown> | null {
	for (const combiner of ["anyOf", "oneOf"] as const) {
		const variants = obj[combiner];
		if (Array.isArray(variants)) {
			const variantObjs = variants as Record<string, unknown>[];
			const allHaveConst = variantObjs.every(
				v => v !== null && v !== undefined && typeof v === "object" && "const" in v,
			);
			if (allHaveConst && variantObjs.length > 0) {
				return createEnumFromVariants(obj, variantObjs, combiner, options);
			}
		}
	}
	return null;
}

function createEnumFromVariants(
	obj: Record<string, unknown>,
	variants: Record<string, unknown>[],
	combiner: string,
	options: SanitizeSchemaOptions,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const dedupedEnum: unknown[] = [];
	for (const variant of variants) {
		pushEnumValue(dedupedEnum, variant.const);
	}
	result.enum = dedupedEnum;

	const explicitType = getCommonExplicitType(variants);
	if (explicitType !== null && explicitType !== undefined && explicitType !== "") {
		result.type = explicitType;
	} else {
		inferAndSetType(result, dedupedEnum, options);
	}

	// Copy description and other top-level fields (not the combiner)
	for (const [key, entry] of Object.entries(obj)) {
		if (key !== combiner && !(key in result)) {
			result[key] = sanitizeSchemaImpl(entry, {
				...options,
				insideProperties: key === "properties",
			});
		}
	}
	return result;
}

function getCommonExplicitType(variants: Record<string, unknown>[]): string | null {
	const explicitTypes = variants
		.map(variant => variant.type)
		.filter((variantType): variantType is string => typeof variantType === "string");
	const allHaveSameExplicitType =
		explicitTypes.length === variants.length && explicitTypes.every(variantType => variantType === explicitTypes[0]);
	return allHaveSameExplicitType && explicitTypes[0] ? explicitTypes[0] : null;
}

function inferAndSetType(result: Record<string, unknown>, dedupedEnum: unknown[], options: SanitizeSchemaOptions) {
	const inferredTypes = dedupedEnum
		.map(enumValue => inferJsonSchemaTypeFromValue(enumValue))
		.filter((inferredType): inferredType is string => inferredType !== undefined);
	const inferredTypeSet = new Set(inferredTypes);
	if (inferredTypeSet.size === 1) {
		result.type = inferredTypes[0];
	} else {
		const nonNullInferredTypes = inferredTypes.filter(inferredType => inferredType !== "null");
		const nonNullTypeSet = new Set(nonNullInferredTypes);
		if (inferredTypes.includes("null") && nonNullTypeSet.size === 1) {
			result.type = nonNullInferredTypes[0];
			if (!options.stripNullableKeyword) {
				result.nullable = true;
			}
		}
	}
}

function normalizeSchemaType(result: Record<string, unknown>, options: SanitizeSchemaOptions) {
	if (options.normalizeTypeArrayToNullable && Array.isArray(result.type)) {
		const types = (result.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter(t => t !== "null");
		if (types.includes("null") && !options.stripNullableKeyword) {
			result.nullable = true;
		}
		result.type = nonNull[0] ?? types[0];
	}
}

function handleConstValue(result: Record<string, unknown>, constValue: unknown) {
	if (constValue !== undefined) {
		// Convert const to enum
		const currentEnum = Array.isArray(result.enum) ? result.enum : [];
		pushEnumValue(currentEnum, constValue);
		result.enum = currentEnum;
		if (result.type === undefined || result.type === null || result.type === "") {
			result.type = inferJsonSchemaTypeFromValue(constValue);
		}
	}
}

function pushEnumValue(enumArray: unknown[], value: unknown): void {
	if (!enumArray.some(existing => areEqual(existing, value))) {
		enumArray.push(value);
	}
}

function areEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a === "object" && a !== null && b !== null) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return false;
}

function inferJsonSchemaTypeFromValue(value: unknown): string | undefined {
	if (value === null) return "null";
	const t = typeof value;
	if (t === "string") return "string";
	if (t === "number") return "number";
	if (t === "boolean") return "boolean";
	if (Array.isArray(value)) return "array";
	if (t === "object") return "object";
	return undefined;
}
