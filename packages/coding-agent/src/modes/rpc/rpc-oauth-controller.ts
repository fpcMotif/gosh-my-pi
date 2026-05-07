import { Snowflake } from "@oh-my-pi/pi-utils";
import type { OAuthAuthInfo, OAuthController, OAuthPrompt } from "@oh-my-pi/pi-ai/utils/oauth/types";
import type { RequestCorrelator } from "./request-correlator";
import { AuthMethod, type AuthRequestPayload, type RpcExtensionUIResponse } from "./rpc-types";
import type { WireFrame } from "./wire/v1";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface RpcOAuthControllerOptions {
	provider: string;
	correlator: RequestCorrelator;
	output: (frame: WireFrame) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * OAuthController that drives gmp's per-provider OAuth flow over the RPC wire.
 *
 * Each callback emits a method-discriminated `extension_ui_request` frame and
 * awaits the matching `extension_ui_response`. The Go-side `apps/tui-go/`
 * dispatcher routes these to the `GmpAuth` dialog, keeping legacy Crush
 * credential writers out of gmp bridge mode.
 */
export class RpcOAuthController implements OAuthController {
	#provider: string;
	#correlator: RequestCorrelator;
	#output: (frame: WireFrame) => void;
	#timeoutMs: number;
	#signal?: AbortSignal;

	constructor(opts: RpcOAuthControllerOptions) {
		this.#provider = opts.provider;
		this.#correlator = opts.correlator;
		this.#output = opts.output;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#signal = opts.signal;
	}

	onAuth(info: OAuthAuthInfo): void {
		this.#fireAndForget({
			method: AuthMethod.ShowLoginURL,
			provider: this.#provider,
			url: info.url,
			instructions: info.instructions,
		});
	}

	onProgress(message: string): void {
		this.#fireAndForget({
			method: AuthMethod.ShowProgress,
			provider: this.#provider,
			message,
		});
	}

	async onPrompt(prompt: OAuthPrompt): Promise<string> {
		return this.#awaitDialog(
			{
				method: AuthMethod.PromptCode,
				provider: this.#provider,
				placeholder: prompt.placeholder,
				allowEmpty: prompt.allowEmpty,
			},
			prompt.message,
		);
	}

	async onManualCodeInput(): Promise<string> {
		return this.#awaitDialog(
			{
				method: AuthMethod.PromptManualRedirect,
				provider: this.#provider,
				instructions: "Paste the full callback URL from your browser",
			},
			"manual code",
		);
	}

	/**
	 * Caller-side helper: emit auth.show_result after the login flow
	 * finishes. When success=true, callers should pass the post-login
	 * authenticated provider list via `providers` so the Go-side workspace
	 * can refresh its catalog without a separate providers.list round-trip.
	 */
	emitResult(success: boolean, error?: string, providers?: string[]): void {
		this.#fireAndForget({
			method: AuthMethod.ShowResult,
			provider: this.#provider,
			success,
			error,
			...(providers !== undefined ? { providers } : {}),
		});
	}

	/** Fire-and-forget: gmp does not register a correlator entry for these
	 * frames. We mint a fresh Snowflake id (matches RpcExtensionUIContext.notify
	 * pattern) so the wire `id` is still unique without polluting the pending
	 * map with a 1s timeout entry per frame.
	 *
	 * Generic over the concrete `AuthRequestPayload` variant so callsite
	 * literals narrow to one variant (with its full per-method field set)
	 * rather than the union — TypeScript's excess-property check otherwise
	 * rejects fields like `provider` that exist in 5 of 6 variants but not all.
	 */
	#fireAndForget<P extends AuthRequestPayload>(req: P): void {
		const id = Snowflake.next() as string;
		this.#output({ type: "extension_ui_request", id, ...req });
	}

	async #awaitDialog<P extends AuthRequestPayload>(req: P, fallbackLabel: string): Promise<string> {
		const { id, promise } = this.#correlator.register<RpcExtensionUIResponse | undefined>({
			signal: this.#signal,
			timeoutMs: this.#timeoutMs,
			defaultValue: undefined,
		});
		this.#output({ type: "extension_ui_request", id, ...req });
		const response = await promise;
		if (response === undefined) throw new Error(`auth dialog cancelled (${fallbackLabel})`);
		if ("cancelled" in response && response.cancelled === true) {
			throw new Error(`auth dialog cancelled (${fallbackLabel})`);
		}
		if ("value" in response && typeof response.value === "string") return response.value;
		throw new Error(`auth dialog returned unexpected response (${fallbackLabel})`);
	}
}
