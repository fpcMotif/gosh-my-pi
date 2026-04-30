import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { gradientText } from "./gradient-text";

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";
const TITLE_FLOURISH = "╱╱╱";

/**
 * Wrap pre-rendered content lines in a vivid-style rounded box with a gradient
 * title bar (`╭╱╱╱ <title> ╱╱╱─────╮`). Use this from modal `render()` methods
 * when `theme.layout === "vivid"`.
 *
 * Falls back to plain rendering if the requested width is too small to draw
 * the chrome at all.
 */
export function vividDialogChrome(opts: {
	title: string;
	contentLines: string[];
	width: number;
}): string[] {
	const { title, contentLines, width } = opts;
	if (width < 6) {
		// Not enough room for `╭─...─╮`; fall back to raw content.
		return contentLines;
	}

	const innerWidth = width - 2; // subtract two vertical chars
	const titleSegment = ` ${TITLE_FLOURISH} ${title} ${TITLE_FLOURISH} `;
	const titleVis = visibleWidth(titleSegment);
	const titleColored = gradientText(titleSegment);

	const top =
		theme.fg("dim", TOP_LEFT) +
		(titleVis + 2 <= width
			? titleColored + theme.fg("dim", HORIZONTAL.repeat(Math.max(0, width - 2 - titleVis)))
			: theme.fg("dim", HORIZONTAL.repeat(Math.max(0, width - 2)))) +
		theme.fg("dim", TOP_RIGHT);

	const bottom =
		theme.fg("dim", BOTTOM_LEFT) +
		theme.fg("dim", HORIZONTAL.repeat(Math.max(0, width - 2))) +
		theme.fg("dim", BOTTOM_RIGHT);

	const v = theme.fg("dim", VERTICAL);
	const out: string[] = [top];
	for (const line of contentLines) {
		const vis = visibleWidth(line);
		let content: string;
		if (vis === innerWidth) {
			content = line;
		} else if (vis < innerWidth) {
			content = line + padding(innerWidth - vis);
		} else {
			content = truncateToWidth(line, innerWidth);
		}
		out.push(v + content + v);
	}
	out.push(bottom);
	return out;
}
