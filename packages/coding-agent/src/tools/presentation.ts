import { Text, type Component } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { renderCodeCell, renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import type { State } from "../tui/types";
import type { ToolUIStatus } from "./render-utils";

export type ToolPresentationCodeStatus = "pending" | "running" | "warning" | "complete" | "error";

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

export interface ToolPresentationCode {
	code: string;
	language?: string;
	title?: string;
	status?: ToolPresentationCodeStatus;
	spinnerFrame?: number;
	output?: string;
	outputMaxLines?: number;
	codeMaxLines?: number;
	expanded?: boolean;
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
	  }
	| {
			type: "code";
			code: ToolPresentationCode;
	  };

export type ToolPresentationResult = ToolPresentation | undefined;

export type ToolPresentationOptions = RenderResultOptions & { renderContext?: Record<string, unknown> };

export function renderToolPresentation(presentation: ToolPresentation, uiTheme: Theme): Component {
	if (presentation.type === "status") {
		return new Text(renderStatusLine(presentation.status, uiTheme), 0, 0);
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
