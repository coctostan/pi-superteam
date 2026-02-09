/**
 * Checkpoint evaluation — pure functions for determining when to pause
 * execution and present the user with control options.
 */

export type CheckpointTriggerType =
  | "scheduled"
  | "test-failure"
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
  lastValidationFailed?: boolean;
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

  // Test failure: cross-task validation detected an issue
  if (state.lastValidationFailed) {
    triggers.push({
      type: "test-failure",
      message: "Cross-task validation detected test failures",
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

export interface PlanAdjustment {
  droppedTaskIds: number[];
  skippedTaskIds: number[];
  reorderedTaskIds?: number[];
}

interface AdjustableTask {
  id: number;
  title: string;
  description: string;
  files: string[];
  status: string;
  reviewsPassed: string[];
  reviewsFailed: string[];
  fixAttempts: number;
  [key: string]: any;
}

/**
 * Apply plan adjustments to the task list.
 * - Completed tasks are protected from drop/skip.
 * - Dropped tasks are removed entirely.
 * - Skipped tasks have status set to "skipped".
 * - Reorder changes the array order.
 * Returns a new array — does not mutate input.
 */
export function applyPlanAdjustment(
  tasks: AdjustableTask[],
  adjustment: PlanAdjustment,
): AdjustableTask[] {
  const completedStatuses = new Set(["complete", "skipped", "escalated"]);

  // 1. Drop (only non-completed)
  let result = tasks.filter(t => {
    if (completedStatuses.has(t.status)) return true; // protect completed
    return !adjustment.droppedTaskIds.includes(t.id);
  });

  // 2. Skip (only non-completed)
  result = result.map(t => {
    if (completedStatuses.has(t.status)) return t;
    if (adjustment.skippedTaskIds.includes(t.id)) {
      return { ...t, status: "skipped" };
    }
    return t;
  });

  // 3. Reorder (if provided)
  if (adjustment.reorderedTaskIds && adjustment.reorderedTaskIds.length > 0) {
    const byId = new Map(result.map(t => [t.id, t]));
    const reordered: AdjustableTask[] = [];
    for (const id of adjustment.reorderedTaskIds) {
      const task = byId.get(id);
      if (task) {
        reordered.push(task);
        byId.delete(id);
      }
    }
    // Append any tasks not in the reorder list (shouldn't happen, but defensive)
    for (const task of byId.values()) {
      reordered.push(task);
    }
    result = reordered;
  }

  return result;
}

/**
 * Parse the user's edited task list into a PlanAdjustment.
 * Input format: one task per line as "N. Title" or "skip: N. Title".
 * Lines deleted = dropped tasks. Lines prefixed with "skip:" = skipped.
 * Order of remaining lines = reorder (if different from original).
 * Returns null if input is empty (cancelled).
 */
export function parsePlanRevisionInput(
  editedText: string,
  originalPendingIds: number[],
): PlanAdjustment | null {
  const trimmed = editedText.trim();
  if (!trimmed) return null;

  const lines = trimmed.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  const parsedIds: number[] = [];
  const skippedIds: number[] = [];

  for (const line of lines) {
    const skipMatch = line.match(/^skip:\s*(\d+)\./);
    const normalMatch = line.match(/^(\d+)\./);

    if (skipMatch) {
      const id = parseInt(skipMatch[1], 10);
      skippedIds.push(id);
      parsedIds.push(id);
    } else if (normalMatch) {
      const id = parseInt(normalMatch[1], 10);
      parsedIds.push(id);
    }
  }

  // Dropped = in original but not in parsed
  const parsedSet = new Set(parsedIds);
  const droppedTaskIds = originalPendingIds.filter(id => !parsedSet.has(id));

  // Reorder: compare parsedIds (minus dropped) against original order (minus dropped)
  const originalFiltered = originalPendingIds.filter(id => parsedSet.has(id));
  const isReordered = JSON.stringify(parsedIds) !== JSON.stringify(originalFiltered);

  return {
    droppedTaskIds,
    skippedTaskIds: skippedIds,
    reorderedTaskIds: isReordered ? parsedIds : undefined,
  };
}

/**
 * Present plan revision UI. Uses ui.editor if available, falls back to ui.select.
 * Returns PlanAdjustment or null if cancelled.
 */
export async function presentPlanRevision(
  tasks: AdjustableTask[],
  ui: {
    editor?: (prompt: string, initial: string) => Promise<string | undefined>;
    select?: (prompt: string, options: string[]) => Promise<string | undefined>;
    confirm?: (prompt: string) => Promise<boolean>;
    notify?: (msg: string, level?: string) => void;
  },
): Promise<PlanAdjustment | null> {
  const pendingTasks = tasks.filter(
    t => t.status !== "complete" && t.status !== "skipped" && t.status !== "escalated",
  );
  const pendingIds = pendingTasks.map(t => t.id);

  if (ui.editor) {
    // Editor path: show editable task list
    const initial = pendingTasks.map(t => `${t.id}. ${t.title}`).join("\n");
    const edited = await ui.editor(
      "Edit remaining tasks. Delete lines to drop, prefix with 'skip:' to skip, reorder as needed.",
      initial,
    );

    if (edited === undefined) return null;

    const adjustment = parsePlanRevisionInput(edited, pendingIds);
    if (!adjustment) return null;

    // Confirm
    const confirmed = await ui.confirm?.(
      formatAdjustmentSummary(adjustment, tasks),
    );
    if (!confirmed) return null;

    return adjustment;
  }

  // Fallback: ui.select loop
  if (ui.select) {
    const droppedIds: number[] = [];
    const skippedIds: number[] = [];

    while (true) {
      const remaining = pendingTasks.filter(t => !droppedIds.includes(t.id) && !skippedIds.includes(t.id));
      const options = [
        ...remaining.map(t => `Drop task ${t.id}`),
        ...remaining.map(t => `Skip task ${t.id}`),
        "Done",
      ];
      const choice = await ui.select("Adjust plan:", options);
      if (!choice || choice === "Done") break;

      const dropMatch = choice.match(/^Drop task (\d+)$/);
      const skipMatch = choice.match(/^Skip task (\d+)$/);
      if (dropMatch) droppedIds.push(parseInt(dropMatch[1], 10));
      if (skipMatch) skippedIds.push(parseInt(skipMatch[1], 10));
    }

    if (droppedIds.length === 0 && skippedIds.length === 0) {
      return { droppedTaskIds: [], skippedTaskIds: [], reorderedTaskIds: undefined };
    }

    return { droppedTaskIds: droppedIds, skippedTaskIds: skippedIds, reorderedTaskIds: undefined };
  }

  return null;
}

function formatAdjustmentSummary(adj: PlanAdjustment, tasks: AdjustableTask[]): string {
  const parts: string[] = [];
  if (adj.droppedTaskIds.length > 0) {
    const names = adj.droppedTaskIds.map(id => {
      const t = tasks.find(t => t.id === id);
      return t ? `${t.id}. ${t.title}` : `#${id}`;
    });
    parts.push(`Drop: ${names.join(", ")}`);
  }
  if (adj.skippedTaskIds.length > 0) {
    const names = adj.skippedTaskIds.map(id => {
      const t = tasks.find(t => t.id === id);
      return t ? `${t.id}. ${t.title}` : `#${id}`;
    });
    parts.push(`Skip: ${names.join(", ")}`);
  }
  if (adj.reorderedTaskIds) {
    parts.push(`Reorder: [${adj.reorderedTaskIds.join(", ")}]`);
  }
  return parts.length > 0 ? `Confirm changes?\n${parts.join("\n")}` : "No changes. Continue?";
}
