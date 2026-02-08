import * as fs from "node:fs";
import * as path from "node:path";
import { writeProgressFile } from "./progress.js";
import type { TestBaseline } from "./test-baseline.js";

const STATE_FILE = ".superteam-workflow.json";

export type BrainstormStep = "scout" | "questions" | "approaches" | "design" | "done";

export type BrainstormQuestion = {
  id: string;
  text: string;
  type: "choice" | "input";
  options?: string[];
  answer?: string;
};

export type BrainstormApproach = {
  id: string;
  title: string;
  summary: string;
  tradeoffs: string;
  taskEstimate: number;
};

export type DesignSection = {
  id: string;
  title: string;
  content: string;
};

export type BrainstormState = {
  step: BrainstormStep;
  scoutOutput?: string;
  questions?: BrainstormQuestion[];
  currentQuestionIndex?: number;
  approaches?: BrainstormApproach[];
  recommendation?: string;
  chosenApproach?: string;
  designSections?: DesignSection[];
  currentSectionIndex?: number;
};

export type OrchestratorPhase =
  | "brainstorm"
  | "plan-write"
  | "plan-draft"
  | "plan-review"
  | "configure"
  | "execute"
  | "finalize"
  | "done";

export type OrchestratorConfig = {
  tddMode: "tdd";
  reviewMode: "single-pass" | "iterative";
  executionMode: "auto" | "checkpoint" | "batch";
  batchSize: number;
  maxPlanReviewCycles: number;
  maxTaskReviewCycles: number;
};

export type TaskExecState = {
  id: number;
  title: string;
  description: string;
  files: string[];
  status:
    | "pending"
    | "implementing"
    | "reviewing"
    | "fixing"
    | "complete"
    | "skipped"
    | "escalated";
  reviewsPassed: string[];
  reviewsFailed: string[];
  fixAttempts: number;
  gitShaBeforeImpl?: string;
  summary?: { title: string; status: string; changedFiles: string[] };
};

export type PendingInteraction = {
  id: string;
  type: "choice" | "confirm" | "input";
  question: string;
  options?: { key: string; label: string; description?: string }[];
  default?: string;
};

export type OrchestratorState = {
  phase: OrchestratorPhase;
  config: Partial<OrchestratorConfig>;
  userDescription: string;
  brainstorm: BrainstormState;
  designPath?: string;
  designContent?: string;
  planPath?: string;
  planContent?: string;
  tasks: TaskExecState[];
  currentTaskIndex: number;
  planReviewCycles: number;
  totalCostUsd: number;
  startedAt: number;
  /** @deprecated Kept for backward compatibility. Use ctx.ui.* instead. */
  pendingInteraction?: PendingInteraction;
  error?: string;
  testBaseline?: TestBaseline;
};

export function createInitialState(description: string): OrchestratorState {
  return {
    phase: "brainstorm",
    config: {
      tddMode: "tdd",
      maxPlanReviewCycles: 3,
      maxTaskReviewCycles: 3,
    },
    userDescription: description,
    brainstorm: { step: "scout" },
    tasks: [],
    currentTaskIndex: 0,
    planReviewCycles: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
  };
}

export function saveState(state: OrchestratorState, cwd: string): void {
  const filePath = path.join(cwd, STATE_FILE);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);

  // Write human-readable progress file
  try {
    writeProgressFile(state, cwd);
  } catch {
    // Non-fatal — progress file is a convenience
  }
}

export function loadState(cwd: string): OrchestratorState | null {
  const filePath = path.join(cwd, STATE_FILE);
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as OrchestratorState;
  } catch {
    return null;
  }
}

export function clearState(cwd: string): void {
  const filePath = path.join(cwd, STATE_FILE);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // File doesn't exist, nothing to do
  }
}
