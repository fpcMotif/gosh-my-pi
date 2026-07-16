export type ToolPresentationIcon = "success" | "error" | "warning" | "info" | "pending" | "running" | "aborted";

export type ToolPresentationState = "pending" | "running" | "success" | "error" | "warning";

export type ToolPresentationCodeStatus = "pending" | "running" | "warning" | "complete" | "error";

export interface ToolPresentationStatus {
	icon?: ToolPresentationIcon;
	spinnerFrame?: number;
	title: string;
	titleColor?: string;
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
			state?: ToolPresentationState;
			sections: ToolPresentationSection[];
			applyBg?: boolean;
	  }
	| {
			type: "code";
			code: ToolPresentationCode;
	  };

export type ToolPresentationResult = ToolPresentation | undefined;

export interface ToolPresentationOptions {
	expanded: boolean;
	isPartial: boolean;
	spinnerFrame?: number;
	renderContext?: Record<string, unknown>;
}
