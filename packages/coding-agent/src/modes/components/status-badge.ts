import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme, ThemeBg, ThemeColor } from "../theme/theme";

/**
 * Status badges modeled as high-contrast colored pills:
 *   [ OKAY! ]  bright bg + dark text  →  ok
 *   [ ERROR ]  red bg + light text    →  err
 *   [ WARN  ]  amber bg + dark text   →  warn
 *   [ INFO  ]  blue bg + dark text    →  info
 *   [ HEY!  ]  violet bg + light text →  hey
 *
 * Default labels match the pi-vivid vocabulary; pass a custom `text` to override.
 */
export type BadgeKind = "ok" | "err" | "warn" | "info" | "hey";

interface BadgeTokens {
	bg: ThemeBg;
	fg: ThemeColor;
	defaultText: string;
}

const BADGE_TOKENS: Record<BadgeKind, BadgeTokens> = {
	ok: { bg: "badgeOkBg", fg: "badgeOkFg", defaultText: "OKAY!" },
	err: { bg: "badgeErrBg", fg: "badgeErrFg", defaultText: "ERROR" },
	warn: { bg: "badgeWarnBg", fg: "badgeWarnFg", defaultText: "WARNING" },
	info: { bg: "badgeInfoBg", fg: "badgeInfoFg", defaultText: "INFO" },
	hey: { bg: "badgeHeyBg", fg: "badgeHeyFg", defaultText: "HEY!" },
};

/**
 * Render a badge as an inline string. One space of padding on each side,
 * bold colored text on a colored background.
 */
export function statusBadge(uiTheme: Theme, kind: BadgeKind, text?: string): string {
	const tokens = BADGE_TOKENS[kind];
	const label = text ?? tokens.defaultText;
	return uiTheme.bg(tokens.bg, ` ${uiTheme.bold(uiTheme.fg(tokens.fg, label))} `);
}

/**
 * Component wrapper around statusBadge() for cases where the badge needs
 * to be mounted into a Container. Most callers should prefer the function form.
 */
export class StatusBadge implements Component {
	#kind: BadgeKind;
	#text?: string;

	constructor(
		private readonly uiTheme: Theme,
		kind: BadgeKind,
		text?: string,
	) {
		this.#kind = kind;
		this.#text = text;
	}

	setKind(kind: BadgeKind): void {
		this.#kind = kind;
	}

	setText(text: string | undefined): void {
		this.#text = text;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const rendered = statusBadge(this.uiTheme, this.#kind, this.#text);
		const vis = visibleWidth(rendered);
		if (vis > width) {
			// Caller gave us less width than the badge fits. Return empty rather than
			// draw a broken badge — status lines should fall back to the next preset.
			return [];
		}
		return [rendered];
	}
}
