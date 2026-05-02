/**
 * Submit result tool for structured subagent output.
 *
 * Subagents must call this tool to finish and return structured JSON output.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { dereferenceJsonSchema, sanitizeSchemaForStrictMode } from "@oh-my-pi/pi-ai/utils/schema";
import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ToolSession } from ".";
import { jtdToJsonSchema, normalizeSchema } from "./jtd-to-json-schema";

export interface YieldDetails {
	data: unknown;
	status: "success" | "aborted";
	error?: string;
}

const ajv = new Ajv({ allErrors: true, strict: false, logger: false });

function formatSchema(schema: unknown): string {
	if (schema === undefined) return "No schema provided.";
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema, null, 2);
	} catch {
		return "[unserializable schema]";
	}
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
	if (!errors || errors.length === 0) return "Unknown schema validation error.";
	return errors
		.map(err => {
			const path = err.instancePath ? `${err.instancePath}: ` : "";
			return `${path}${err.message ?? "invalid"}`;
		})
		.join("; ");
}

function isEmptySchemaError(schemaError: string | undefined | null): boolean {
	return schemaError === null || schemaError === undefined || schemaError === "";
}

function sanitizeNormalizedSchema(
	normalizedSchema: unknown,
	schemaError: string | undefined | null,
): Record<string, unknown> | undefined {
	if (!isEmptySchemaError(schemaError)) return undefined;
	if (normalizedSchema === true) return {};
	if (normalizedSchema !== null && typeof normalizedSchema === "object" && !Array.isArray(normalizedSchema)) {
		return sanitizeSchemaForStrictMode(normalizedSchema as Record<string, unknown>);
	}
	return undefined;
}

function buildSchemaDescription(schemaError: string | undefined | null, schemaHint: string): string {
	return isEmptySchemaError(schemaError)
		? `Structured output matching the schema:\n${schemaHint}`
		: `Structured JSON output (output schema invalid; accepting unconstrained object): ${schemaError}`;
}

function buildDataSchema(
	sanitizedSchema: Record<string, unknown> | undefined,
	schemaDescription: string,
	schemaError: string | undefined | null,
): TSchema {
	if (sanitizedSchema === undefined) {
		return Type.Record(Type.String(), Type.Any(), {
			description: isEmptySchemaError(schemaError)
				? "Structured JSON output (no schema specified)"
				: schemaDescription,
		});
	}
	const resolved = dereferenceJsonSchema({
		...sanitizedSchema,
		description: schemaDescription,
	});
	return Type.Unsafe(resolved as Record<string, unknown>);
}

function compileSchemaValidator(
	normalizedSchema: unknown,
	schemaError: string | undefined | null,
): { validate: ValidateFunction | undefined; schemaError: string | undefined | null } {
	if (normalizedSchema === undefined || normalizedSchema === false || !isEmptySchemaError(schemaError)) {
		return { validate: undefined, schemaError };
	}
	try {
		const validate = ajv.compile(normalizedSchema as Record<string, unknown> | boolean);
		return { validate, schemaError };
	} catch (error) {
		return { validate: undefined, schemaError: error instanceof Error ? error.message : String(error) };
	}
}

function createYieldParameters(dataSchema: TSchema): TSchema {
	return Type.Object(
		{
			result: Type.Union([
				Type.Object({ data: dataSchema }, { description: "task succeeded" }),
				Type.Object({
					error: Type.String({ description: "error message" }),
				}),
			]),
		},
		{
			additionalProperties: false,
			description: "submit data or error",
		},
	) as TSchema;
}

interface ParsedYieldResult {
	data: unknown;
	errorMessage: string | undefined;
}

function parseYieldResult(params: Static<TSchema>): ParsedYieldResult {
	const raw = params as Record<string, unknown>;
	const rawResult = raw.result;
	if (rawResult === null || rawResult === undefined || typeof rawResult !== "object" || Array.isArray(rawResult)) {
		throw new Error("result must be an object containing either data or error");
	}

	const resultRecord = rawResult as Record<string, unknown>;
	const errorMessage = typeof resultRecord.error === "string" ? resultRecord.error : undefined;
	const data = resultRecord.data;

	if (errorMessage !== undefined && data !== undefined) {
		throw new Error("result cannot contain both data and error");
	}
	if (errorMessage === undefined && data === undefined) {
		throw new Error(
			'result must contain either `data` or `error`. Use `{result: {data: <your output>}}` for success or `{result: {error: "message"}}` for failure.',
		);
	}
	return { data, errorMessage };
}

function buildYieldResponseText(
	status: "success" | "aborted",
	errorMessage: string | undefined,
	schemaValidationOverridden: boolean,
	failures: number,
): string {
	if (status === "aborted") return `Task aborted: ${errorMessage}`;
	if (schemaValidationOverridden) {
		return `Result submitted (schema validation overridden after ${failures} failed attempt(s)).`;
	}
	return "Result submitted.";
}

export class YieldTool implements AgentTool<TSchema, YieldDetails> {
	readonly name = "yield";
	readonly label = "Submit Result";
	readonly description =
		"Finish the task with structured JSON output. Call exactly once at the end of the task.\n\n" +
		'Pass `result: { data: <your output> }` for success, or `result: { error: "message" }` for failure.\n' +
		"The `data`/`error` wrapper is required — do not put your output directly in `result`.";
	readonly parameters: TSchema;
	strict = true;
	readonly intent = "omit" as const;
	lenientArgValidation = true;

	readonly #validate?: ValidateFunction;
	#schemaValidationFailures = 0;

	constructor(session: ToolSession) {
		let validate: ValidateFunction | undefined;
		let dataSchema: TSchema;
		let parameters: TSchema;

		try {
			const schemaResult = normalizeSchema(session.outputSchema);
			// Convert JTD to JSON Schema if needed (auto-detected)
			const normalizedSchema =
				schemaResult.normalized === undefined ? undefined : jtdToJsonSchema(schemaResult.normalized);
			let schemaError = schemaResult.error;

			if (isEmptySchemaError(schemaError) && normalizedSchema === false) {
				schemaError = "boolean false schema rejects all outputs";
			}

			const compiled = compileSchemaValidator(normalizedSchema, schemaError);
			validate = compiled.validate;
			schemaError = compiled.schemaError ?? undefined;

			const schemaHint = formatSchema(normalizedSchema ?? session.outputSchema);
			const schemaDescription = buildSchemaDescription(schemaError, schemaHint);
			const sanitizedSchema = sanitizeNormalizedSchema(normalizedSchema, schemaError);
			dataSchema = buildDataSchema(sanitizedSchema, schemaDescription, schemaError);
			parameters = createYieldParameters(dataSchema);
			JSON.stringify(parameters);
			// Verify the final parameters compile with AJV (catches unresolved $ref, etc.)
			ajv.compile(parameters as Record<string, unknown>);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			dataSchema = Type.Record(Type.String(), Type.Any(), {
				description: `Structured JSON output (schema processing failed: ${errorMsg})`,
			});
			parameters = createYieldParameters(dataSchema);
			validate = undefined;
			this.strict = false;
		}

		this.#validate = validate;
		this.parameters = parameters;
	}

	#validateSuccessData(data: unknown): boolean {
		if (data === undefined || data === null) {
			throw new Error("data is required when yield indicates success");
		}
		if (!this.#validate || this.#validate(data)) return false;
		this.#schemaValidationFailures++;
		if (this.#schemaValidationFailures <= 1) {
			throw new Error(`Output does not match schema: ${formatAjvErrors(this.#validate.errors)}`);
		}
		return true;
	}

	async execute(
		_toolCallId: string,
		params: Static<TSchema>,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<YieldDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<YieldDetails>> {
		const { data, errorMessage } = parseYieldResult(params);
		const status = errorMessage === undefined ? "success" : "aborted";
		const schemaValidationOverridden = status === "success" ? this.#validateSuccessData(data) : false;
		const responseText = buildYieldResponseText(
			status,
			errorMessage,
			schemaValidationOverridden,
			this.#schemaValidationFailures,
		);
		return {
			content: [{ type: "text", text: responseText }],
			details: { data, status, error: errorMessage },
		};
	}
}

// Register subprocess tool handler for extraction + termination.
subprocessToolRegistry.register<YieldDetails>("yield", {
	extractData: event => {
		const details = event.result?.details;
		if (details === null || details === undefined || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const status = record.status;
		if (status !== "success" && status !== "aborted") return undefined;
		return {
			data: record.data,
			status,
			error: typeof record.error === "string" ? record.error : undefined,
		};
	},
	shouldTerminate: event => event.isError !== true,
});
