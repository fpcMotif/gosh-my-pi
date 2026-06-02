/**
 * Effect Language Service CLI-based diagnostics client.
 *
 * `effect-language-service diagnostics` is a JSON-reporting CLI, not a
 * stdio LSP server. This client plugs it into the existing custom-linter
 * path so Effect diagnostics participate in LSP-aware write diagnostics
 * without trying to spawn the CLI as a language server.
 */
import * as path from "node:path";
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../../lsp/types";

interface EffectLanguageServiceOutput {
	diagnostics?: EffectLanguageServiceDiagnostic[];
}

interface EffectLanguageServiceDiagnostic {
	file?: string;
	line?: number;
	column?: number;
	endLine?: number;
	endColumn?: number;
	severity?: "error" | "warning" | "message";
	code?: string | number;
	name?: string;
	message?: string;
}

function parseSeverity(severity: string | undefined): DiagnosticSeverity {
	switch (severity) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "message":
			return 3;
		default:
			return 2;
	}
}

async function runEffectLanguageService(
	args: string[],
	cwd: string,
	resolvedCommand?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const command = resolvedCommand ?? "effect-language-service";

	try {
		const proc = Bun.spawn([command, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});

		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;

		return { stdout, stderr, success: exitCode === 0 || stdout.trim().length > 0 };
	} catch (error) {
		return { stdout: "", stderr: String(error), success: false };
	}
}

export class EffectLanguageServiceClient implements LinterClient {
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new EffectLanguageServiceClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async format(_filePath: string, content: string): Promise<string> {
		return content;
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		const args = [...(this.config.args ?? ["diagnostics", "--format", "json"]), "--file", filePath];
		const result = await runEffectLanguageService(args, this.cwd, this.config.resolvedCommand);
		if (!result.success) {
			return [];
		}
		return this.#parseJsonOutput(result.stdout, filePath);
	}

	#parseJsonOutput(jsonOutput: string, targetFile: string): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];

		try {
			const parsed: EffectLanguageServiceOutput = JSON.parse(jsonOutput);
			for (const diag of parsed.diagnostics ?? []) {
				if (diag.message === undefined || diag.message === null || diag.message === "") continue;
				if (diag.file !== undefined && diag.file !== null && diag.file !== "") {
					const diagFile = path.isAbsolute(diag.file) ? diag.file : path.join(this.cwd, diag.file);
					if (path.resolve(diagFile) !== path.resolve(targetFile)) continue;
				}

				const startLine = Math.max(0, (diag.line ?? 1) - 1);
				const startColumn = Math.max(0, (diag.column ?? 1) - 1);
				const endLine = Math.max(startLine, (diag.endLine ?? diag.line ?? 1) - 1);
				const endColumn = Math.max(startColumn, (diag.endColumn ?? diag.column ?? 1) - 1);

				diagnostics.push({
					range: {
						start: { line: startLine, character: startColumn },
						end: { line: endLine, character: endColumn },
					},
					severity: parseSeverity(diag.severity),
					message: diag.message,
					source: "effect-language-service",
					code: diag.name ?? diag.code,
				});
			}
		} catch {
			return [];
		}

		return diagnostics;
	}

	dispose(): void {
		// Nothing to dispose for CLI diagnostics.
	}
}
