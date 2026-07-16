import { Text, type Component } from "@oh-my-pi/pi-tui";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { renderCodeCell, renderStatusLine, type StatusLineOptions } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import type { ToolPresentation, ToolPresentationStatus } from "./presentation-types";

export * from "./presentation-types";

function toStatusLineOptions(status: ToolPresentationStatus): StatusLineOptions {
	const { titleColor, ...options } = status;
	return titleColor === undefined ? options : { ...options, titleColor: titleColor as ThemeColor };
}

export function renderToolPresentation(presentation: ToolPresentation, uiTheme: Theme): Component {
	if (presentation.type === "status") {
		return new Text(renderStatusLine(toStatusLineOptions(presentation.status), uiTheme), 0, 0);
	}

	if (presentation.type === "code") {
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;
				cachedLines = renderCodeCell({ ...presentation.code, width }, uiTheme);
				cachedWidth = width;
				return cachedLines;
			},
			invalidate(): void {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
	}

	const outputBlock = new CachedOutputBlock();
	return {
		render(width: number): string[] {
			return outputBlock.render(
				{
					header: presentation.status
						? renderStatusLine(toStatusLineOptions(presentation.status), uiTheme)
						: undefined,
					state: presentation.state,
					sections: presentation.sections,
					width,
					applyBg: presentation.applyBg,
				},
				uiTheme,
			);
		},
		invalidate(): void {
			outputBlock.invalidate();
		},
	};
}
