import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Markdown, Spacer } from "@oh-my-pi/pi-tui";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage } from "../../session/messages";
import { MessageFrame } from "./message-frame";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	#frame: MessageFrame;
	#customComponent?: Component;
	#expanded = false;

	constructor(
		private readonly message: CustomMessage<unknown>,
		private readonly customRenderer?: MessageRenderer,
	) {
		super();

		this.addChild(new Spacer(1));

		// Create the default lightweight message frame (custom renderers keep their own styling)
		this.#frame = new MessageFrame({
			railColor: "customMessageLabel",
			label: `custom ${this.message.customType}`,
			labelColor: "customMessageLabel",
		});

		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		// Remove previous content component
		if (this.#customComponent) {
			this.removeChild(this.#customComponent);
			this.#customComponent = undefined;
		}
		this.removeChild(this.#frame);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(this.message, { expanded: this.#expanded }, theme);
				if (component) {
					this.#customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our shared conversation frame
		this.addChild(this.#frame);
		this.#frame.clear();

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map(c => c.text)
				.join("\n");
		}

		this.#frame.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (value: string) => theme.fg("customMessageText", value),
			}),
		);
	}
}
