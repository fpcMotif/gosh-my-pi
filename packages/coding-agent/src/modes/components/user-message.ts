import { Container, Markdown, Spacer } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { MessageFrame } from "./message-frame";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, synthetic = false) {
		super();
		const color = synthetic
			? (value: string) => theme.fg("dim", value)
			: (value: string) => theme.fg("userMessageText", value);
		const frame = new MessageFrame({
			railColor: synthetic ? "dim" : "borderRailUser",
			label: synthetic ? "developer" : "you",
			labelColor: synthetic ? "dim" : "customMessageLabel",
		});
		frame.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color,
			}),
		);
		this.addChild(new Spacer(1));
		this.addChild(frame);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
		return lines;
	}
}
