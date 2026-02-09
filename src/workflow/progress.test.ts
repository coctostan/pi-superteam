// src/workflow/progress.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("renderProgressMarkdown", () => {
  it("includes workflow title and phase status", async () => {
    const { renderProgressMarkdown } = await import("./progress.js");
    const state = makeState({ phase: "brainstorm", userDescription: "Add auth" });
    const md = renderProgressMarkdown(state);
    expect(md).toContain("# Workflow: Add auth");
    expect(md).toContain("Brainstorm");
  });

  it("includes brainstorm checklist with completed and pending items", async () => {
    const { renderProgressMarkdown } = await import("./progress.js");
    const state = makeState({
      phase: "brainstorm",
      brainstorm: { step: "questions", scoutOutput: "scout data" },
    });
    const md = renderProgressMarkdown(state);
    expect(md).toContain("[x] Scout codebase");
    expect(md).toContain("[ ] Requirements");
  });

  it("includes task list with status markers", async () => {
    const { renderProgressMarkdown } = await import("./progress.js");
    const state = makeState({
      phase: "execute",
      currentTaskIndex: 1,
      tasks: [
        { id: 1, title: "Create model", status: "complete" },
        { id: 2, title: "Add routes", status: "implementing" },
        { id: 3, title: "Add tests", status: "pending" },
      ],
    });
    const md = renderProgressMarkdown(state);
    expect(md).toContain("[x] 1. Create model");
    expect(md).toContain("[ ] 2. Add routes");
    expect(md).toMatch(/implementing/);
    expect(md).toContain("[ ] 3. Add tests");
  });

  it("includes cost in header", async () => {
    const { renderProgressMarkdown } = await import("./progress.js");
    const state = makeState({ totalCostUsd: 3.42 });
    const md = renderProgressMarkdown(state);
    expect(md).toContain("$3.42");
  });
});

describe("getProgressPath", () => {
  it("derives from designPath by replacing -design.md with -progress.md", async () => {
    const { getProgressPath } = await import("./progress.js");
    const state = makeState({ designPath: "docs/plans/2026-02-07-auth-design.md" });
    expect(getProgressPath(state)).toBe("docs/plans/2026-02-07-auth-progress.md");
  });

  it("derives from planPath when designPath is missing", async () => {
    const { getProgressPath } = await import("./progress.js");
    const state = makeState({ planPath: "docs/plans/2026-02-07-auth-plan.md" });
    expect(getProgressPath(state)).toBe("docs/plans/2026-02-07-auth-progress.md");
  });

  it("returns null when neither path is set", async () => {
    const { getProgressPath } = await import("./progress.js");
    const state = makeState({});
    expect(getProgressPath(state)).toBeNull();
  });
});

describe("writeProgressFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "progress-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes progress file to derived path and creates dirs", async () => {
    const { writeProgressFile } = await import("./progress.js");
    const state = makeState({
      userDescription: "Add auth",
      designPath: "docs/plans/2026-02-07-add-auth-design.md",
    });
    writeProgressFile(state, tmpDir);
    const progressPath = path.join(tmpDir, "docs/plans/2026-02-07-add-auth-progress.md");
    expect(fs.existsSync(progressPath)).toBe(true);
    const content = fs.readFileSync(progressPath, "utf-8");
    expect(content).toContain("# Workflow: Add auth");
  });
});

function makeState(overrides: any = {}): any {
  return {
    phase: "brainstorm",
    userDescription: "test task",
    brainstorm: { step: "scout" },
    config: {},
    tasks: [],
    currentTaskIndex: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    planReviewCycles: 0,
    ...overrides,
  };
}

describe("computeProgressSummary", () => {
  it("computes correct counts for mixed task states", async () => {
    const { computeProgressSummary } = await import("./progress.js");
    const state = makeState({
      phase: "execute",
      totalCostUsd: 1.50,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "complete" },
        { id: 3, title: "C", status: "skipped" },
        { id: 4, title: "D", status: "implementing" },
        { id: 5, title: "E", status: "pending" },
      ],
      currentTaskIndex: 3,
    });

    const summary = computeProgressSummary(state);
    expect(summary.tasksCompleted).toBe(2);
    expect(summary.tasksRemaining).toBe(2); // implementing + pending
    expect(summary.tasksSkipped).toBe(1);
    expect(summary.cumulativeCost).toBe(1.50);
    expect(summary.currentTaskTitle).toBe("D");
  });

  it("estimates remaining cost based on average", async () => {
    const { computeProgressSummary } = await import("./progress.js");
    const state = makeState({
      totalCostUsd: 3.00,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "complete" },
        { id: 3, title: "C", status: "complete" },
        { id: 4, title: "D", status: "pending" },
        { id: 5, title: "E", status: "pending" },
        { id: 6, title: "F", status: "pending" },
      ],
      currentTaskIndex: 3,
    });

    const summary = computeProgressSummary(state);
    // 3.00 / 3 completed * 3 remaining = 3.00
    expect(summary.estimatedRemainingCost).toBeCloseTo(3.00, 1);
  });

  it("returns 0 estimated cost when no tasks completed", async () => {
    const { computeProgressSummary } = await import("./progress.js");
    const state = makeState({
      totalCostUsd: 0,
      tasks: [{ id: 1, title: "A", status: "pending" }],
      currentTaskIndex: 0,
    });

    const summary = computeProgressSummary(state);
    expect(summary.estimatedRemainingCost).toBe(0);
  });
});

describe("formatProgressSummary", () => {
  it("formats a readable progress line", async () => {
    const { formatProgressSummary } = await import("./progress.js");
    const summary = {
      tasksCompleted: 3,
      tasksRemaining: 2,
      tasksSkipped: 1,
      cumulativeCost: 1.50,
      estimatedRemainingCost: 1.00,
      currentTaskTitle: "Add widget",
    };

    const formatted = formatProgressSummary(summary);
    expect(formatted).toContain("3");
    expect(formatted).toContain("2");
    expect(formatted).toContain("$1.50");
    expect(formatted).toContain("$1.00");
  });
});
