import type { OrchestratorState } from "../orchestrator-state.js";
import { saveState } from "../orchestrator-state.js";
import { askExecutionMode, askBatchSize, askReviewMode, parseUserResponse } from "../interaction.js";

export async function runConfigurePhase(
  state: OrchestratorState,
  ctx: { cwd: string },
  userInput?: string,
): Promise<OrchestratorState> {
  // a. Process pending interaction response
  if (state.pendingInteraction && userInput !== undefined) {
    const response = parseUserResponse(state.pendingInteraction, userInput);
    const id = state.pendingInteraction.id;

    if (id === "review-mode") {
      state.config.reviewMode = response as OrchestratorState["config"]["reviewMode"];
    } else if (id === "execution-mode") {
      state.config.executionMode = response as OrchestratorState["config"]["executionMode"];
    } else if (id === "batch-size") {
      const parsed = parseInt(response, 10);
      state.config.batchSize = Math.max(1, isNaN(parsed) ? 3 : parsed);
    }

    state.pendingInteraction = undefined;
  }

  // b. Determine next question needed
  if (!state.config.reviewMode) {
    state.pendingInteraction = askReviewMode();
    saveState(state, ctx.cwd);
    return state;
  }

  if (!state.config.executionMode) {
    state.pendingInteraction = askExecutionMode();
    saveState(state, ctx.cwd);
    return state;
  }

  if (state.config.executionMode === "batch" && !state.config.batchSize) {
    state.pendingInteraction = askBatchSize();
    saveState(state, ctx.cwd);
    return state;
  }

  // c. All config collected — set defaults and advance
  if (!state.config.batchSize) {
    state.config.batchSize = 3;
  }
  if (!state.config.maxPlanReviewCycles) {
    state.config.maxPlanReviewCycles = 3;
  }
  if (!state.config.maxTaskReviewCycles) {
    state.config.maxTaskReviewCycles = 3;
  }

  state.phase = "execute";
  saveState(state, ctx.cwd);
  return state;
}
