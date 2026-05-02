import type { TextContent } from "@oh-my-pi/pi-ai";
import { Container, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, SkillPromptDetails } from "../../session/messages";
import { MessageFrame } from "./message-frame";

export class SkillMessageComponent extends Container {
	#frame: MessageFrame;
	#expanded = false;

	constructor(private readonly message: CustomMessage<SkillPromptDetails>) {
		super();
		this.addChild(new Spacer(1));

		this.#frame = new MessageFrame({
			railColor: "customMessageLabel",
			label: "skill",
			labelColor: "customMessageLabel",
		});
		this.addChild(this.#frame);
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
		this.#frame.clear();

		const details = this.message.details;
		const args = details?.args?.trim();
		const infoLines = [
			`Skill: ${details?.name ?? "unknown"}`,
			args !== null && args !== undefined && args !== "" ? `Args: ${args}` : undefined,
			details?.path !== null && details?.path !== undefined && details?.path !== ""
				? `Path: ${details.path}`
				: undefined,
			typeof details?.lineCount === "number" ? `Prompt: ${details.lineCount} lines` : undefined,
		].filter((line): line is string => Boolean(line));

		this.#frame.addChild(
			new Markdown(infoLines.join("\n"), 0, 0, getMarkdownTheme(), {
				color: (value: string) => theme.fg("customMessageText", value),
			}),
		);

		if (!this.#expanded) {
			return;
		}

		const text = this.#extractText();
		if (!text) {
			return;
		}

		this.#frame.addChild(new Spacer(1));
		const promptHeader = theme.fg("customMessageLabel", theme.bold("Prompt"));
		this.#frame.addChild(new Text(promptHeader, 0, 0));
		this.#frame.addChild(new Spacer(1));

		this.#frame.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (value: string) => theme.fg("customMessageText", value),
			}),
		);
	}

	#extractText(): string {
		if (typeof this.message.content === "string") {
			return this.message.content;
		}
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}
}
