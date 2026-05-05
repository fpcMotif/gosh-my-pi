#!/usr/bin/env bun
import * as readline from "node:readline";
import { AuthCredentialStore } from "./auth-credential-store";
import { getOAuthProviders } from "./utils/oauth";
import { loginKagi } from "./utils/oauth/kagi";
import { loginKimi } from "./utils/oauth/kimi";
import { loginMiniMaxCode, loginMiniMaxCodeCn } from "./utils/oauth/minimax-code";
import { loginOpenAICodex } from "./utils/oauth/openai-codex";
import { loginParallel } from "./utils/oauth/parallel";
import { loginTavily } from "./utils/oauth/tavily";
import type { OAuthController, OAuthCredentials, OAuthProvider } from "./utils/oauth/types";
import { loginZai } from "./utils/oauth/zai";

const PROVIDERS = getOAuthProviders();

async function prompt(rl: readline.Interface, question: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const input = process.stdin as NodeJS.ReadStream;
	const supportsRawMode = input.isTTY && typeof input.setRawMode === "function";
	const wasRaw = supportsRawMode ? input.isRaw : false;
	let settled = false;

	const cleanup = () => {
		rl.off("SIGINT", onSigint);
		if (supportsRawMode) {
			input.off("keypress", onKeypress);
			input.setRawMode?.(wasRaw);
		}
	};

	const finish = (result: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		result();
	};

	const cancel = () => {
		finish(() => {
			reject(new Error("Login cancelled"));
		});
	};

	function onSigint() {
		cancel();
	}
	function onKeypress(_str: string, key: readline.Key) {
		if (key.name === "escape" || (key.ctrl === true && key.name === "c")) {
			cancel();
			rl.close();
		}
	}

	if (supportsRawMode) {
		readline.emitKeypressEvents(input, rl);
		input.setRawMode(true);
		input.on("keypress", onKeypress);
	}

	rl.once("SIGINT", onSigint);
	rl.question(question, answer => {
		finish(() => {
			resolve(answer);
		});
	});
	return promise;
}

async function selectProviderToLogout(storage: AuthCredentialStore): Promise<OAuthProvider | undefined> {
	const providers = storage.listProviders();
	if (providers.length === 0) {
		console.log("No credentials stored.");
		return undefined;
	}

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	console.log("Select a provider to logout:\n");
	for (let i = 0; i < providers.length; i += 1) {
		console.log(`  ${i + 1}. ${providers[i]}`);
	}
	console.log();

	const choice = await prompt(rl, `Enter number (1-${providers.length}): `);
	rl.close();

	const index = Number.parseInt(choice, 10) - 1;
	if (index < 0 || index >= providers.length) {
		console.error("Invalid selection");
		process.exit(1);
	}
	return providers[index] as OAuthProvider;
}

async function handleLogoutCommand(args: string[]): Promise<void> {
	let provider = args[1] as OAuthProvider | undefined;
	const storage = await AuthCredentialStore.open();

	try {
		if (provider === undefined || provider === null) {
			provider = await selectProviderToLogout(storage);
		}

		if (provider === undefined || provider === null) return;

		const oauth = storage.getOAuth(provider);
		const apiKey = storage.getApiKey(provider);
		if ((oauth === null || oauth === undefined) && (apiKey === null || apiKey === undefined || apiKey === "")) {
			console.error(`Not logged in to ${provider}`);
			process.exit(1);
		}

		storage.deleteProvider(provider);
		console.log(`Logged out from ${provider}`);
	} finally {
		storage.close();
	}
}

async function performOAuthLogin(
	provider: OAuthProvider,
	storage: AuthCredentialStore,
	loginFn: (handlers: OAuthController) => Promise<OAuthCredentials>,
	handlers: OAuthController,
): Promise<void> {
	const credentials = await loginFn(handlers);
	storage.saveOAuth(provider, credentials);
	console.log(`\nCredentials saved to ~/.omp/agent/agent.db`);
}

async function performApiKeyLogin(
	provider: OAuthProvider,
	storage: AuthCredentialStore,
	loginFn: (handlers: OAuthController) => Promise<string>,
	handlers: OAuthController,
): Promise<void> {
	const apiKey = await loginFn(handlers);
	storage.saveApiKey(provider, apiKey);
	console.log(`\nAPI key saved to ~/.omp/agent/agent.db`);
}

async function login(provider: OAuthProvider): Promise<void> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const promptFn = (msg: string) => prompt(rl, `${msg} `);
	const storage = await AuthCredentialStore.open();

	const handlers: OAuthController = {
		onAuth(info) {
			const { url, instructions } = info;
			console.log(`\nOpen this URL in your browser:\n${url}`);
			if (instructions !== null && instructions !== undefined && instructions !== "") console.log(instructions);
			console.log();
		},
		onPrompt(p) {
			const ph =
				p.placeholder !== null && p.placeholder !== undefined && p.placeholder !== "" ? ` (${p.placeholder})` : "";
			return promptFn(`${p.message}${ph}:`);
		},
	};

	try {
		switch (provider) {
			case "openai-codex":
				await performOAuthLogin(provider, storage, loginOpenAICodex, handlers);
				break;
			case "kimi-code":
				await performOAuthLogin(provider, storage, loginKimi, handlers);
				break;
			case "kagi":
				await performApiKeyLogin(provider, storage, loginKagi, handlers);
				break;
			case "tavily":
				await performApiKeyLogin(provider, storage, loginTavily, handlers);
				break;
			case "parallel":
				await performApiKeyLogin(provider, storage, loginParallel, handlers);
				break;
			case "zai":
				await performApiKeyLogin(provider, storage, loginZai, handlers);
				break;
			case "minimax-code":
				await performApiKeyLogin(provider, storage, loginMiniMaxCode, handlers);
				break;
			case "minimax-code-cn":
				await performApiKeyLogin(provider, storage, loginMiniMaxCodeCn, handlers);
				break;
			default:
				throw new Error(`Unknown provider: ${provider}`);
		}
	} finally {
		storage.close();
		rl.close();
	}
}

async function handleStatusCommand(): Promise<void> {
	const storage = await AuthCredentialStore.open();
	try {
		const providers = storage.listProviders();
		if (providers.length === 0) {
			console.log("No credentials stored.\nUse 'bunx @oh-my-pi/pi-ai login' to authenticate.");
		} else {
			console.log("Logged-in providers:\n");
			for (const provider of providers) {
				const oauth = storage.getOAuth(provider as OAuthProvider);
				if (oauth !== undefined && oauth !== null) {
					const status =
						Date.now() >= oauth.expires ? "(expired)" : `(expires ${new Date(oauth.expires).toLocaleString()})`;
					console.log(`  ${provider.padEnd(20)} ${status}`);
					continue;
				}
				const apiKey = storage.getApiKey(provider);
				if (apiKey !== null && apiKey !== undefined && apiKey !== "")
					console.log(`  ${provider.padEnd(20)} (api key)`);
			}
		}
	} finally {
		storage.close();
	}
}

function handleListCommand(): void {
	console.log("Available providers:\n");
	if (Array.isArray(PROVIDERS)) {
		for (const p of PROVIDERS) console.log(`  ${p.id.padEnd(20)} ${p.name}`);
	}
}

async function selectProviderFromList(): Promise<OAuthProvider | undefined> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	console.log("Select a provider:\n");
	if (Array.isArray(PROVIDERS)) {
		for (let i = 0; i < PROVIDERS.length; i += 1) console.log(`  ${i + 1}. ${PROVIDERS[i].name}`);
	}
	console.log();
	const choice = await prompt(rl, `Enter number (1-${PROVIDERS.length}): `);
	rl.close();
	const index = Number.parseInt(choice, 10) - 1;
	if (Array.isArray(PROVIDERS) && (index < 0 || index >= PROVIDERS.length)) {
		console.error("Invalid selection");
		process.exit(1);
	}
	return PROVIDERS[index].id as OAuthProvider;
}

async function handleLoginCommand(args: string[]): Promise<void> {
	let provider = args[1] as OAuthProvider | undefined;
	if (provider === undefined || provider === null) provider = await selectProviderFromList();
	if (provider === undefined || provider === null) {
		console.error("No provider selected");
		process.exit(1);
	}
	if (Array.isArray(PROVIDERS) && PROVIDERS.some(p => p.id === provider) === false) {
		console.error(`Unknown provider: ${provider}\nUse 'bunx @oh-my-pi/pi-ai list' to see available providers`);
		process.exit(1);
	}
	console.log(`Logging in to ${provider}…`);
	await login(provider);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const [command] = args;
	if (command === undefined || command === "help" || command === "--help" || command === "-h") {
		console.log(`Usage: bunx @oh-my-pi/pi-ai <command> [provider]

Commands:
  login [provider]  Login to a provider
  logout [provider] Logout from a provider
  status            Show logged-in providers
  list              List available providers

Providers:
  openai-codex      OpenAI Codex (ChatGPT Plus/Pro)
  kimi-code         Kimi Code
  minimax-code      MiniMax Coding Plan (International)
  minimax-code-cn   MiniMax Coding Plan (China)
  zai               Z.AI (GLM Coding Plan)
  kagi              Kagi
  tavily            Tavily
  parallel          Parallel

Examples:
  bunx @oh-my-pi/pi-ai login              # interactive provider selection
  bunx @oh-my-pi/pi-ai login openai-codex # login to specific provider
  bunx @oh-my-pi/pi-ai logout openai-codex
  bunx @oh-my-pi/pi-ai status             # show logged-in providers
  bunx @oh-my-pi/pi-ai list               # list providers
`);
		return;
	}
	if (command === "status") {
		await handleStatusCommand();
		return;
	}
	if (command === "list") {
		handleListCommand();
		return;
	}
	if (command === "logout") {
		await handleLogoutCommand(args);
		return;
	}
	if (command === "login") {
		await handleLoginCommand(args);
		return;
	}
	console.error(`Unknown command: ${command}\nUse 'bunx @oh-my-pi/pi-ai --help' for usage`);
	process.exit(1);
}

main().catch(error => {
	const msg = error instanceof Error ? error.message : String(error);
	console.error("Error:", msg);
	process.exit(1);
});
