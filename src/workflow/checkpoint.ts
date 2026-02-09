/**
 * Checkpoint evaluation — pure functions for determining when to pause
 * execution and present the user with control options.
 */

export type CheckpointTriggerType =
  | "scheduled"
  | "budget-warning"
  | "budget-critical";

export interface CheckpointTrigger {
  type: CheckpointTriggerType;
  message: string;
}

export interface CostThresholds {
  warnAtUsd: number;
  hardLimitUsd: number;
}

// Loose state type to avoid circular dependency
interface CheckpointState {
  config: { executionMode?: string };
  tasks: Array<{ status: string }>;
  currentTaskIndex: number;
  totalCostUsd: number;
}

/**
 * Evaluate all checkpoint triggers after a task completes.
 * Returns an array of triggers that fired (may be empty).
 * Pure function — no side effects.
 */
export function evaluateCheckpointTriggers(
  state: CheckpointState,
  costs: CostThresholds,
): CheckpointTrigger[] {
  const triggers: CheckpointTrigger[] = [];

  // Don't fire checkpoints if no remaining tasks
  const hasRemaining = state.tasks.some(
    (t, i) => i >= state.currentTaskIndex && t.status !== "complete" && t.status !== "skipped",
  );
  if (!hasRemaining) return triggers;

  // Budget critical: cost >= 90% of hard limit (takes priority over warning)
  const criticalThreshold = costs.hardLimitUsd * 0.9;
  if (state.totalCostUsd >= criticalThreshold) {
    triggers.push({
      type: "budget-critical",
      message: `Budget critical: $${state.totalCostUsd.toFixed(2)} spent (hard limit: $${costs.hardLimitUsd.toFixed(2)})`,
    });
  } else if (state.totalCostUsd >= costs.warnAtUsd) {
    // Budget warning: cost >= warnAtUsd (only if critical didn't fire)
    triggers.push({
      type: "budget-warning",
      message: `Budget warning: $${state.totalCostUsd.toFixed(2)} spent (warn threshold: $${costs.warnAtUsd.toFixed(2)})`,
    });
  }

  // Scheduled: checkpoint execution mode
  if (state.config.executionMode === "checkpoint") {
    triggers.push({
      type: "scheduled",
      message: "Scheduled checkpoint after task completion",
    });
  }

  return triggers;
}

export interface CheckpointStats {
  tasksCompleted: number;
  tasksTotal: number;
  costUsd: number;
  estimatedRemainingUsd: number;
}

/**
 * Format the checkpoint message shown to the user.
 * Pure function — returns a string.
 */
export function formatCheckpointMessage(
  triggers: CheckpointTrigger[],
  stats: CheckpointStats,
): string {
  const header = `Checkpoint: ${stats.tasksCompleted}/${stats.tasksTotal} tasks done | $${stats.costUsd.toFixed(2)} spent | ~$${stats.estimatedRemainingUsd.toFixed(2)} remaining`;

  const triggerLines = triggers.map(t => `  • ${t.message}`).join("\n");

  return `${header}\nTrigger:\n${triggerLines}`;
}

/**
 * Present the checkpoint UI to the user. Returns user's choice.
 */
export async function presentCheckpoint(
  triggers: CheckpointTrigger[],
  stats: CheckpointStats,
  ui: { select?: (prompt: string, options: string[]) => Promise<string | undefined> },
): Promise<"continue" | "adjust" | "abort"> {
  const message = formatCheckpointMessage(triggers, stats);

  const choice = await ui.select?.(message, ["Continue", "Adjust plan", "Abort"]);

  if (choice === "Adjust plan") return "adjust";
  if (choice === "Abort") return "abort";
  return "continue";
}
