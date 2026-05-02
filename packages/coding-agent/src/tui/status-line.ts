/**
 * Standardized status header rendering for tool output.
 */
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { statusBadge, type BadgeKind } from "../modes/components/status-badge";
import type { ToolUIStatus } from "../tools/render-utils";
import { formatStatusIcon } from "../tools/render-utils";

export interface StatusLineOptions {
	icon?: ToolUIStatus;
	spinnerFrame?: number;
	title: string;
	titleColor?: ThemeColor;
	description?: string;
	badge?: { label: string; color: ThemeColor };
	meta?: string[];
}

const DEFAULT_STATUS_BADGES: Record<ToolUIStatus, { label: string; color: ThemeColor; kind: BadgeKind }> = {
	success: { label: "done", color: "success", kind: "ok" },
	error: { label: "error", color: "error", kind: "err" },
	warning: { label: "warning", color: "warning", kind: "warn" },
	info: { label: "info", color: "muted", kind: "info" },
	pending: { label: "pending", color: "muted", kind: "info" },
	running: { label: "running", color: "accent", kind: "hey" },
	aborted: { label: "aborted", color: "error", kind: "err" },
};

export function renderStatusLine(options: StatusLineOptions, theme: Theme): string {
	const icon = options.icon ? formatStatusIcon(options.icon, theme, options.spinnerFrame) : "";
	const titleColor = options.titleColor ?? "accent";
	const title = theme.fg(titleColor, options.title);
	let line = icon ? `${icon} ${title}` : title;

	if (options.description !== null && options.description !== undefined && options.description !== "") {
		line += `: ${theme.fg("muted", options.description)}`;
	}

	const defaultBadge = options.icon ? DEFAULT_STATUS_BADGES[options.icon] : undefined;
	const badge = options.badge ?? defaultBadge;
	if (badge) {
		const { label, color } = badge;
		if (!options.badge && defaultBadge && theme.layout === "vivid") {
			line += ` ${statusBadge(theme, defaultBadge.kind, label)}`;
		} else {
			line += ` ${theme.fg(color, `${theme.format.bracketLeft}${label}${theme.format.bracketRight}`)}`;
		}
	}

	const meta = options.meta?.filter(value => value.trim().length > 0) ?? [];
	if (meta.length > 0) {
		line += ` ${theme.fg("dim", meta.join(theme.sep.dot))}`;
	}

	return line;
}
