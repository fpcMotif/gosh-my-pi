import { Text, type Component } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import type { State } from "../tui/types";
import type { ToolUIStatus } from "./render-utils";

export interface ToolPresentationStatus {
	icon?: ToolUIStatus;
	spinnerFrame?: number;
	title: string;
	titleColor?: ThemeColor;
	description?: string;
	meta?: string[];
}

export interface ToolPresentationSection {
	label?: string;
	lines: string[];
}

export type ToolPresentation =
	| {
			type: "status";
			status: ToolPresentationStatus;
	  }
	| {
			type: "block";
			status?: ToolPresentationStatus;
			state?: State;
			sections: ToolPresentationSection[];
			applyBg?: boolean;
	  };

export type ToolPresentationResult = ToolPresentation | undefined;

export type ToolPresentationOptions = RenderResultOptions & { renderContext?: Record<string, unknown> };

export function renderToolPresentation(presentation: ToolPresentation, uiTheme: Theme): Component {
	if (presentation.type === "status") {
		return new Text(renderStatusLine(presentation.status, uiTheme), 0, 0);
	}

	const outputBlock = new CachedOutputBlock();
	return {
		render(width: number): string[] {
			return outputBlock.render(
				{
					header: presentation.status ? renderStatusLine(presentation.status, uiTheme) : undefined,
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
