/**
 * Smithery subcommand handlers for `/mcp smithery-search`, `/mcp smithery-login`,
 * `/mcp smithery-logout`.
 *
 * Owns:
 * - The Smithery API-key lifecycle (browser CLI auth + paste-key fallback, cache
 *   read/write, polling the CLI session, expiry-driven re-prompt).
 * - Registry search + result picker + parameter-collection prompts.
 *
 * Delegates back to the parent controller via {@link MCPSmitheryFlowContext.deployServer}
 * for actual server registration — the wizard-complete pipeline (config write, source
 * registration, hot reload) stays in `MCPCommandController` because the Add flow uses
 * it too.
 */
import { Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { readMCPConfigFile } from "../../mcp/config-writer";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	getSmitheryLoginUrl,
	pollSmitheryCliAuthSession,
	saveSmitheryApiKey,
} from "../../mcp/smithery-auth";
import { SmitheryConnectError } from "../../mcp/smithery-connect";
import {
	SmitheryRegistryError,
	type SmitherySearchResult,
	searchSmitheryRegistry,
	toConfigName,
} from "../../mcp/smithery-registry";
import type { MCPServerConfig } from "../../mcp/types";
import { openPath } from "../../utils/open";
import { DynamicBorder } from "../components/dynamic-border";
import { parseCommandArgs } from "../shared";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

export type MCPAddScope = "user" | "project";

/**
 * Dependencies the Smithery flow needs from its owning controller.
 */
export interface MCPSmitheryFlowContext {
	ctx: InteractiveModeContext;
	/**
	 * Register a server with the given name, config, and scope. Owned by
	 * `MCPCommandController.#handleWizardComplete` because the Add flow also
	 * funnels through it.
	 */
	deployServer(name: string, config: MCPServerConfig, scope: MCPAddScope): Promise<void>;
}

type MCPSearchParsed = {
	keyword: string;
	scope: MCPAddScope;
	limit: number;
	semantic: boolean;
	error?: string;
};

export class MCPSmitheryFlow {
	#ctx: MCPSmitheryFlowContext;

	constructor(ctx: MCPSmitheryFlowContext) {
		this.#ctx = ctx;
	}

	async handleLogin(): Promise<void> {
		const ok = await this.#promptSmitheryLogin("login");
		if (!ok) {
			this.#ctx.ctx.showStatus("Smithery login cancelled.");
		}
	}

	async handleLogout(): Promise<void> {
		const removed = await clearSmitheryApiKey();
		this.#ctx.ctx.showStatus(removed ? "Smithery API key removed." : "No cached Smithery API key found.");
	}

	async handleSearch(text: string): Promise<void> {
		const parsed = this.#parseSearchCommand(text);
		if (parsed.error !== null && parsed.error !== undefined && parsed.error !== "") {
			this.#ctx.ctx.showError(parsed.error);
			return;
		}

		try {
			this.#showMessage(
				["", theme.fg("muted", `Searching Smithery registry for "${parsed.keyword}"...`), ""].join("\n"),
			);
			const results = await this.#runSmitheryOperationWithAuthRetry(
				apiKey =>
					searchSmitheryRegistry(parsed.keyword, {
						limit: parsed.limit,
						apiKey,
						includeSemantic: parsed.semantic,
					}),
				"required for smithery-search",
			);
			if (results.length === 0) {
				this.#showMessage(
					["", theme.fg("warning", `No Smithery results found for "${parsed.keyword}".`), ""].join("\n"),
				);
				return;
			}

			const selected = await this.#pickRegistryResult(results, parsed.keyword);
			if (!selected) {
				this.#ctx.ctx.showStatus("MCP Smithery selection cancelled.");
				return;
			}

			await this.#deployRegistryResult(selected, parsed.scope);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/authentication was cancelled|login cancelled/i.test(message)) {
				this.#ctx.ctx.showError(`${message} Run /mcp smithery-login to authenticate first.`);
				return;
			}
			this.#ctx.ctx.showError(`Smithery search failed: ${message}`);
		}
	}

	#parseSearchCommand(text: string): MCPSearchParsed {
		const prefixMatch = text.match(/^\/mcp\s+smithery-search\b\s*(.*)$/i);
		const rest = prefixMatch?.[1]?.trim() ?? "";
		const tokens = parseCommandArgs(rest);
		if (tokens.length === 0) {
			return {
				keyword: "",
				scope: "project",
				limit: 20,
				semantic: false,
				error: "Keyword required. Usage: /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		const keywordParts: string[] = [];
		let scope: MCPAddScope = "project";
		let limit = 20;
		let semantic = false;

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "--scope") {
				const value = tokens[i + 1];
				if (!value || (value !== "project" && value !== "user")) {
					return { keyword: "", scope, limit, semantic, error: "Invalid --scope value. Use project or user." };
				}
				scope = value;
				i++;
				continue;
			}
			if (token === "--limit") {
				const value = tokens[i + 1];
				if (!value) {
					return { keyword: "", scope, limit, semantic, error: "Missing value for --limit." };
				}
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
					return {
						keyword: "",
						scope,
						limit,
						semantic,
						error: "Invalid --limit value. Use an integer between 1 and 100.",
					};
				}
				limit = parsed;
				i++;
				continue;
			}
			if (token === "--semantic") {
				semantic = true;
				continue;
			}
			if (token.startsWith("--")) {
				return { keyword: "", scope, limit, semantic, error: `Unknown option: ${token}` };
			}
			keywordParts.push(token);
		}

		const keyword = keywordParts.join(" ").trim();
		if (!keyword) {
			return {
				keyword: "",
				scope,
				limit,
				semantic,
				error: "Keyword required. Usage: /mcp smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			};
		}

		return { keyword, scope, limit, semantic };
	}

	async #validateSmitheryApiKey(apiKey: string): Promise<void> {
		await searchSmitheryRegistry("mcp", { limit: 1, apiKey });
	}

	async #promptSmitheryApiKey(promptLabel: string): Promise<string | null> {
		for (;;) {
			const input = await this.#ctx.ctx.showHookInput(promptLabel);
			if (input === undefined) return null;
			const apiKey = input.trim();
			if (!apiKey) {
				this.#ctx.ctx.showError("Smithery API key cannot be empty.");
				continue;
			}
			try {
				await this.#validateSmitheryApiKey(apiKey);
				return apiKey;
			} catch (error) {
				this.#ctx.ctx.showError(
					`Smithery API key validation failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	async #handleSmitheryLoginWithApiKey(): Promise<boolean> {
		const apiKey = await this.#promptSmitheryApiKey("Smithery API key (Esc to cancel)");
		if (apiKey === null || apiKey === undefined || apiKey === "") return false;
		await saveSmitheryApiKey(apiKey);
		this.#ctx.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #waitForSmitheryCliApiKey(sessionId: string, signal: AbortSignal): Promise<string> {
		const pollIntervalMs = 2_000;
		const timeoutMs = 300_000;
		const startedAt = Date.now();

		while (!signal.aborted) {
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error("Smithery authorization timed out after 5 minutes.");
			}
			const response = await pollSmitheryCliAuthSession(sessionId, signal);
			if (
				response.status === "success" &&
				response.apiKey !== null &&
				response.apiKey !== undefined &&
				response.apiKey !== ""
			) {
				return response.apiKey;
			}
			if (response.status === "error") {
				throw new Error(response.message ?? "Smithery authorization failed.");
			}
			await Bun.sleep(pollIntervalMs);
		}

		throw new Error("Smithery authorization cancelled.");
	}

	async #handleSmitheryBrowserLogin(): Promise<boolean> {
		const session = await createSmitheryCliAuthSession();
		const fallbackLoginUrl = getSmitheryLoginUrl();
		this.#showMessage(
			[
				"",
				theme.bold("Smithery Login"),
				theme.fg("muted", "Browser authorization started. Complete auth in your browser."),
				theme.fg("dim", "Authorize URL:"),
				theme.fg("accent", session.authUrl),
				theme.fg("dim", `Fallback: ${fallbackLoginUrl}`),
				"",
			].join("\n"),
		);
		try {
			openPath(session.authUrl);
		} catch {
			// URL is already shown above.
		}

		const apiKey = await this.#waitForSmitheryCliApiKey(session.sessionId, new AbortController().signal);
		await this.#validateSmitheryApiKey(apiKey);
		await saveSmitheryApiKey(apiKey);
		this.#ctx.ctx.showStatus("Smithery API key saved.");
		return true;
	}

	async #promptSmitheryLogin(reason: string): Promise<boolean> {
		this.#showMessage(
			[
				"",
				theme.fg("muted", `Smithery authentication required (${reason}).`),
				theme.fg("muted", "If browser auth fails, you can paste an API key."),
				"",
			].join("\n"),
		);
		try {
			return await this.#handleSmitheryBrowserLogin();
		} catch (error) {
			this.#ctx.ctx.showWarning(
				`Browser authorization failed: ${error instanceof Error ? error.message : String(error)}. Falling back to API key.`,
			);
			return await this.#handleSmitheryLoginWithApiKey();
		}
	}

	#getSmitheryErrorStatus(error: unknown): number | undefined {
		if (error instanceof SmitheryRegistryError || error instanceof SmitheryConnectError) {
			return error.status;
		}
		return undefined;
	}

	#toSmitheryAuthReason(status: number): string {
		return status === 429 ? "rate limited by Smithery" : "forbidden/unauthorized with Smithery";
	}

	async #requireSmitheryApiKey(reason: string): Promise<string> {
		let apiKey = await getSmitheryApiKey();
		if (apiKey !== null && apiKey !== undefined && apiKey !== "") return apiKey;

		const loggedIn = await this.#promptSmitheryLogin(reason);
		if (!loggedIn) {
			throw new Error("Smithery login cancelled. Run /mcp smithery-login, then retry /mcp smithery-search.");
		}

		apiKey = await getSmitheryApiKey();
		if (apiKey === null || apiKey === undefined || apiKey === "") {
			throw new Error("Smithery API key not found after login.");
		}
		return apiKey;
	}

	async #runSmitheryOperationWithAuthRetry<T>(operation: (apiKey: string) => Promise<T>, reason: string): Promise<T> {
		const apiKey = await this.#requireSmitheryApiKey(reason);
		try {
			return await operation(apiKey);
		} catch (error) {
			const status = this.#getSmitheryErrorStatus(error);
			if (status === undefined || ![401, 403, 429].includes(status)) {
				throw error;
			}
			const loggedIn = await this.#promptSmitheryLogin(this.#toSmitheryAuthReason(status));
			if (!loggedIn) {
				throw error;
			}
			const retryApiKey = await this.#requireSmitheryApiKey(reason);
			return await operation(retryApiKey);
		}
	}

	async #nextAvailableServerName(scope: MCPAddScope, baseName: string): Promise<string> {
		const filePath = getMCPConfigPath(scope, getProjectDir());
		const config = await readMCPConfigFile(filePath);
		const existingNames = new Set(Object.keys(config.mcpServers ?? {}));
		if (!existingNames.has(baseName)) return baseName;
		for (let i = 2; i <= 999; i++) {
			const candidate = `${baseName}-${i}`;
			if (!existingNames.has(candidate)) return candidate;
		}
		return `${baseName}-${Date.now()}`;
	}

	async #promptDeploymentServerName(scope: MCPAddScope, defaultName: string): Promise<string | null> {
		for (;;) {
			const input = await this.#ctx.ctx.showHookInput(
				`Server name for deploy (default: ${defaultName})`,
				defaultName,
			);
			if (input === undefined) return null;
			const proposed = input.trim() || defaultName;
			if (!proposed) {
				this.#ctx.ctx.showError("Server name cannot be empty.");
				continue;
			}
			const filePath = getMCPConfigPath(scope, getProjectDir());
			const config = await readMCPConfigFile(filePath);
			if (config.mcpServers?.[proposed]) {
				this.#ctx.ctx.showError(`Server "${proposed}" already exists in ${scope} config.`);
				continue;
			}
			return proposed;
		}
	}

	async #promptRequiredRegistryInputs(result: SmitherySearchResult): Promise<Record<string, string> | null> {
		const values: Record<string, string> = {};
		for (const input of result.requiredInputs) {
			const label = input.required ? `${input.key} (required)` : `${input.key} (optional)`;
			const prompt = `${label}${input.description !== null && input.description !== undefined && input.description !== "" ? ` - ${input.description}` : ""}`;
			const userInput = await this.#ctx.ctx.showHookInput(prompt, input.defaultValue);
			if (userInput === undefined) {
				if (input.required) return null;
				continue;
			}
			const value = userInput.trim();
			if (!value) {
				if (input.required) {
					this.#ctx.ctx.showError(`Missing required value for "${input.key}".`);
					return null;
				}
				continue;
			}
			values[input.key] = value;
		}
		return values;
	}

	#applyRegistryInputOverrides(config: MCPServerConfig, values: Record<string, string>): MCPServerConfig {
		if (Object.keys(values).length === 0) return config;
		if (config.type !== "stdio") {
			return config;
		}
		const args = [...(config.args ?? [])];
		const configJson = JSON.stringify(values);
		const index = args.indexOf("--config");
		if (index >= 0) {
			if (index + 1 < args.length) {
				args[index + 1] = configJson;
			} else {
				args.push(configJson);
			}
		} else {
			args.push("--config", configJson);
		}
		return { ...config, args };
	}

	async #pickRegistryResult(results: SmitherySearchResult[], keyword: string): Promise<SmitherySearchResult | null> {
		const options = results.map((result, index) => {
			const label = `${index + 1}. ${result.display.displayName} (${result.display.transport}, uses ${result.display.useCount})`;
			return label.length > 120 ? `${label.slice(0, 117)}...` : label;
		});
		const selected = await this.#ctx.ctx.showHookSelector(`Registry results for "${keyword}"`, options);
		if (selected === null || selected === undefined || selected === "") return null;
		const prefix = selected.split(".", 1)[0];
		const index = Number(prefix) - 1;
		if (!Number.isInteger(index) || index < 0 || index >= results.length) return null;
		return results[index] ?? null;
	}

	async #deployRegistryResult(result: SmitherySearchResult, scope: MCPAddScope): Promise<void> {
		const baseName = toConfigName(result.name);
		const defaultName = await this.#nextAvailableServerName(scope, baseName);
		const serverName = await this.#promptDeploymentServerName(scope, defaultName);
		if (serverName === null || serverName === undefined || serverName === "") {
			this.#ctx.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const inputValues = await this.#promptRequiredRegistryInputs(result);
		if (inputValues === null) {
			this.#ctx.ctx.showStatus("MCP deploy cancelled.");
			return;
		}
		const config = this.#applyRegistryInputOverrides(result.config, inputValues);
		await this.#ctx.deployServer(serverName, config, scope);
	}

	#showMessage(text: string): void {
		this.#ctx.ctx.chatContainer.addChild(new Spacer(1));
		this.#ctx.ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.ctx.chatContainer.addChild(new Text(text, 1, 1));
		this.#ctx.ctx.chatContainer.addChild(new DynamicBorder());
		this.#ctx.ctx.ui.requestRender();
	}
}
