import { createShellPresenter, createShellRenderer } from "../bash";
import type { DetectedRunner } from "./runner";
import { commandFromOp, cwdFromOp, titleFromOp } from "./runner";

export interface RecipeRenderArgs {
	op?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

function recipeShellConfig(runners: DetectedRunner[]) {
	return {
		resolveTitle: (args: RecipeRenderArgs | undefined) => titleFromOp(args?.op, runners),
		resolveCommand: (args: RecipeRenderArgs | undefined) => commandFromOp(args?.op, runners),
		resolveCwd: (args: RecipeRenderArgs | undefined) => cwdFromOp(args?.op, runners),
	};
}

export function createRecipeToolPresenter(runners: DetectedRunner[]) {
	return createShellPresenter<RecipeRenderArgs>(recipeShellConfig(runners));
}

export function createRecipeToolRenderer(runners: DetectedRunner[]) {
	return createShellRenderer<RecipeRenderArgs>(recipeShellConfig(runners));
}

export const recipeToolPresenter = createRecipeToolPresenter([]);
export const recipeToolRenderer = createRecipeToolRenderer([]);
