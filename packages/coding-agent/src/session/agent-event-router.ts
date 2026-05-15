import type { Message } from "@oh-my-pi/pi-ai";
import type { AgentEvent } from "../extensibility/extensions";
import type { SecretObfuscator } from "../secrets/obfuscator";

export interface AgentEventRouterDependencies {
	emitSessionEvent: (event: AgentEvent) => Promise<void>;
	getUserMessageText: (message: Message) => string;
	removeVisibleQueuedMessage: (messageText: string) => void;
	getObfuscator: () => SecretObfuscator | undefined;
}

/**
 * Minimal event routing adapter for AgentSession event handling.
 *
 * The current event-router owns ordered display-layer concerns:
 * - user queue visibility cleanup before event emission,
 * - deobfuscation for emitted assistant message content,
 * - and display emission itself.
 */
export class AgentEventRouter {
	#deps: AgentEventRouterDependencies;

	constructor(deps: AgentEventRouterDependencies) {
		this.#deps = deps;
	}

	/**
	 * Apply display-layer pre-processing for the event and emit it through
	 * AgentSession's public event stream.
	 */
	async handle(event: AgentEvent): Promise<void> {
		if (event.type === "message_start" && event.message.role === "user") {
			const messageText = this.#deps.getUserMessageText(event.message);
			if (messageText) {
				this.#deps.removeVisibleQueuedMessage(messageText);
			}
		}

		let displayEvent: AgentEvent = event;
		const obfuscator = this.#deps.getObfuscator();
		if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const deobfuscatedContent = obfuscator.deobfuscateObject(message.content);
			if (deobfuscatedContent !== message.content) {
				displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } };
			}
		}

		await this.#deps.emitSessionEvent(displayEvent);
	}
}
