import { type Component, padding, replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type ThemeColor, theme } from "../../modes/theme/theme";

export const MESSAGE_MAX_WIDTH = 120;

export interface MessageFrameOptions {
	label?: string;
	labelColor?: ThemeColor;
	railColor: ThemeColor;
	maxWidth?: number;
	/**
	 * When the theme uses vivid layout, focused messages get the thick rail (`▌`)
	 * in `borderRailFocused` color; non-focused messages keep the thin rail (`│`).
	 * Ignored under classic layout.
	 */
	focused?: boolean;
}

/**
 * Lightweight conversation frame with a left rail and capped reading width.
 * Keeps message chrome consistent without changing message semantics.
 */
export class MessageFrame implements Component {
	children: Component[] = [];
	#label?: string;
	#labelColor: ThemeColor;
	#railColor: ThemeColor;
	#maxWidth: number;
	#focused: boolean;

	constructor(options: MessageFrameOptions) {
		this.#label = options.label;
		this.#labelColor = options.labelColor ?? options.railColor;
		this.#railColor = options.railColor;
		this.#maxWidth = options.maxWidth ?? MESSAGE_MAX_WIDTH;
		this.#focused = options.focused ?? false;
	}

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	setFocused(focused: boolean): void {
		this.#focused = focused;
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const frameWidth = Math.min(Math.max(0, width), this.#maxWidth);
		if (frameWidth <= 0) return [];

		const isVivid = theme.layout === "vivid";
		const railGlyph = isVivid ? theme.symbol(this.#focused ? "rail.thick" : "rail.thin") : theme.boxRound.vertical;
		const railColor: ThemeColor = isVivid && this.#focused ? "borderRailFocused" : this.#railColor;
		const railRaw = `${railGlyph} `;
		const railWidth = visibleWidth(railRaw);
		const contentWidth = frameWidth - railWidth;

		const contentLines = this.#renderContentLines(Math.max(1, contentWidth));
		if (contentLines.length === 0) return [];

		if (contentWidth <= 0) {
			const railOnly = theme.fg(railColor, truncateToWidth(railRaw, frameWidth));
			return contentLines.map(() => railOnly);
		}

		const rail = theme.fg(railColor, railRaw);
		return contentLines.map(line => {
			const sanitized = replaceTabs(line);
			const clipped = truncateToWidth(sanitized, contentWidth);
			const fill = padding(Math.max(0, contentWidth - visibleWidth(clipped)));
			return `${rail}${clipped}${fill}`;
		});
	}

	#renderContentLines(width: number): string[] {
		const lines: string[] = [];
		// Vivid layout suppresses inline labels — the rail color carries the role semantics.
		const showLabel = this.#label && theme.layout !== "vivid";
		if (showLabel) {
			lines.push(theme.fg(this.#labelColor, theme.bold(this.#label as string)));
		}

		for (const child of this.children) {
			lines.push(...child.render(width));
		}

		return lines;
	}
}
