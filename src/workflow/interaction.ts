import type { PendingInteraction } from "./orchestrator-state.js";

export function askReviewMode(): PendingInteraction {
  return {
    id: "review-mode",
    type: "choice",
    question: "How should code reviews be handled?",
    options: [
      {
        key: "single-pass",
        label: "One round of reviews",
        description: "One round of reviews — findings shown as warnings",
      },
      {
        key: "iterative",
        label: "Review-fix loop",
        description: "Review-fix loop until reviewers pass",
      },
    ],
  };
}

export function askExecutionMode(): PendingInteraction {
  return {
    id: "execution-mode",
    type: "choice",
    question: "How should tasks be executed?",
    options: [
      {
        key: "auto",
        label: "Auto",
        description: "Run all tasks without pausing",
      },
      {
        key: "checkpoint",
        label: "Checkpoint",
        description: "Pause after each task for review",
      },
      {
        key: "batch",
        label: "Batch",
        description: "Run N tasks then pause",
      },
    ],
  };
}

export function askBatchSize(): PendingInteraction {
  return {
    id: "batch-size",
    type: "input",
    question: "How many tasks per batch?",
    default: "3",
  };
}

export function confirmPlanApproval(
  taskCount: number,
  taskTitles: string[]
): PendingInteraction {
  const titleList = taskTitles.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
  return {
    id: "plan-approval",
    type: "choice",
    question: `The plan contains ${taskCount} tasks:\n${titleList}\n\nDo you approve this plan?`,
    options: [
      {
        key: "approve",
        label: "Approve",
        description: "Approve and proceed to execution",
      },
      {
        key: "revise",
        label: "Revise",
        description: "Request revisions to the plan",
      },
    ],
  };
}

export function confirmTaskEscalation(
  taskTitle: string,
  reason: string
): PendingInteraction {
  return {
    id: "task-escalation",
    type: "choice",
    question: `Task "${taskTitle}" needs attention: ${reason}\n\nHow would you like to proceed?`,
    options: [
      {
        key: "continue",
        label: "Continue",
        description: "Retry the task",
      },
      {
        key: "skip",
        label: "Skip",
        description: "Skip and move to next",
      },
      {
        key: "abort",
        label: "Abort",
        description: "Stop the workflow",
      },
    ],
  };
}

export function formatInteractionForAgent(req: PendingInteraction): string {
  const lines: string[] = [req.question, ""];

  switch (req.type) {
    case "choice": {
      for (let i = 0; i < (req.options?.length ?? 0); i++) {
        const opt = req.options![i];
        let line = `  ${i + 1}) ${opt.label}`;
        if (opt.description) {
          line += ` — ${opt.description}`;
        }
        lines.push(line);
      }
      break;
    }
    case "confirm": {
      lines.push("  Enter yes or no");
      break;
    }
    case "input": {
      if (req.default !== undefined) {
        lines.push(`  (default: ${req.default})`);
      }
      break;
    }
  }

  return lines.join("\n");
}

export function parseUserResponse(
  req: PendingInteraction,
  rawInput: string
): string {
  const trimmed = rawInput.trim();

  switch (req.type) {
    case "choice": {
      const options = req.options ?? [];
      const lower = trimmed.toLowerCase();

      // Match by key
      for (const opt of options) {
        if (opt.key.toLowerCase() === lower) {
          return opt.key.toLowerCase();
        }
      }

      // Match by 1-based number
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        return options[num - 1].key.toLowerCase();
      }

      // Match by label
      for (const opt of options) {
        if (opt.label.toLowerCase() === lower) {
          return opt.key.toLowerCase();
        }
      }

      const validKeys = options.map((o) => o.key).join(", ");
      throw new Error(
        `Invalid choice: "${trimmed}". Valid options: ${validKeys} (or enter 1-${options.length})`
      );
    }

    case "input": {
      if (trimmed === "") {
        return req.default ?? "";
      }
      return trimmed;
    }

    case "confirm": {
      const lower = trimmed.toLowerCase();
      if (lower === "y" || lower === "yes") {
        return "yes";
      }
      if (lower === "n" || lower === "no") {
        return "no";
      }
      throw new Error(
        `Invalid response: "${trimmed}". Enter yes/y or no/n.`
      );
    }

    default:
      throw new Error(`Unknown interaction type: ${req.type}`);
  }
}
