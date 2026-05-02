export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
	return !(value === null || value === undefined) && typeof value === "object" && !Array.isArray(value);
}
