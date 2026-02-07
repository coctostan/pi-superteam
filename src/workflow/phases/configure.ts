/**
 * Configure phase — direct ctx.ui dialogs for execution and review settings.
 */

import type { OrchestratorState } from "../orchestrator-state.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type Ctx = ExtensionContext | { cwd: string; hasUI?: boolean; ui?: any };

export async function runConfigurePhase(
	state: OrchestratorState,
	ctx: Ctx,
): Promise<OrchestratorState> {
	const ui = (ctx as any).ui;

	// 1. Execution mode
	const execModeLabel = await ui?.select?.("Execution Mode", ["Auto", "Checkpoint", "Batch"]);
	if (execModeLabel === undefined) {
		// User cancelled
		return state;
	}

	const execModeMap: Record<string, "auto" | "checkpoint" | "batch"> = {
		"Auto": "auto",
		"Checkpoint": "checkpoint",
		"Batch": "batch",
	};
	state.config.executionMode = execModeMap[execModeLabel] || "auto";

	// 2. Batch size (if batch mode)
	if (state.config.executionMode === "batch") {
		const batchInput = await ui?.input?.("Batch Size", "3");
		if (batchInput === undefined) {
			return state;
		}
		const parsed = parseInt(batchInput, 10);
		state.config.batchSize = Math.max(1, isNaN(parsed) || batchInput === "" ? 3 : parsed);
	} else {
		state.config.batchSize = state.config.batchSize || 3;
	}

	// 3. Review mode
	const reviewModeLabel = await ui?.select?.("Review Mode", ["Iterative", "Single-pass"]);
	if (reviewModeLabel === undefined) {
		return state;
	}

	const reviewModeMap: Record<string, "iterative" | "single-pass"> = {
		"Iterative": "iterative",
		"Single-pass": "single-pass",
	};
	state.config.reviewMode = reviewModeMap[reviewModeLabel] || "iterative";

	// Set defaults
	if (!state.config.maxPlanReviewCycles) state.config.maxPlanReviewCycles = 3;
	if (!state.config.maxTaskReviewCycles) state.config.maxTaskReviewCycles = 3;

	// Advance
	state.phase = "execute";
	return state;
}
