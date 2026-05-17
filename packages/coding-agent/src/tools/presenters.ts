/**
 * Per-tool presentation producers.
 *
 * Each {@link ToolPresenter} returns optional {@link ToolPresentation} data for a
 * tool's call and/or result. The data is neutral — no pi-tui dependency — and is
 * consumed by two sites:
 *
 * - The OMP-RPC v1 wire translator ({@link "../modes/rpc/wire/translate"})
 *   projects it onto `WireToolPresentationV1` so tui-go can render the call
 *   summary or result block natively.
 * - The in-process TUI ({@link "../modes/components/tool-execution"}) renders it
 *   to a pi-tui {@link Component} via {@link renderToolPresentation}, when
 *   present; otherwise falls back to the tool's pi-tui-coupled renderer in
 *   {@link "./renderers"}.
 *
 * Separating the presenter registry from the renderer registry keeps the wire
 * layer free of pi-tui transitive imports, makes "this tool participates in
 * the wire vocabulary" a separate decision from "this tool has a rich TUI
 * renderer," and gives migrations a single registry to grow.
 */
import { editToolPresenter } from "../edit/renderer";
import { bashToolPresenter } from "./bash";
import type { ToolPresentationOptions, ToolPresentationResult } from "./presentation";
import { readToolPresenter } from "./read";
import { recipeToolPresenter } from "./recipe/render";

export type ToolPresenter = {
	presentCall?: (args: unknown, options: ToolPresentationOptions) => ToolPresentationResult;
	presentResult?: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: ToolPresentationOptions,
		args?: unknown,
	) => ToolPresentationResult;
};

export const toolPresenters: Record<string, ToolPresenter> = {
	bash: bashToolPresenter as ToolPresenter,
	recipe: recipeToolPresenter as ToolPresenter,
	read: readToolPresenter as ToolPresenter,
	edit: editToolPresenter as ToolPresenter,
	apply_patch: editToolPresenter as ToolPresenter,
};
