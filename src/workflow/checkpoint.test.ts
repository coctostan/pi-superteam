import { describe, it, expect } from "vitest";
import { evaluateCheckpointTriggers, formatCheckpointMessage, presentCheckpoint, applyPlanAdjustment, parsePlanRevisionInput, presentPlanRevision, type CheckpointTrigger, type PlanAdjustment } from "./checkpoint.js";

function makeState(overrides: any = {}): any {
  return {
    phase: "execute",
    config: { executionMode: "auto" },
    tasks: [],
    currentTaskIndex: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("evaluateCheckpointTriggers", () => {
  it("returns empty array when no triggers fire", () => {
    const state = makeState({
      totalCostUsd: 1.0,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "pending" },
      ],
      currentTaskIndex: 1,
    });
    const triggers = evaluateCheckpointTriggers(state, {
      warnAtUsd: 25,
      hardLimitUsd: 75,
    });
    expect(triggers).toEqual([]);
  });

  it("returns budget-warning when cost >= warnAtUsd", () => {
    const state = makeState({
      totalCostUsd: 26.0,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "pending" },
      ],
      currentTaskIndex: 1,
    });
    const triggers = evaluateCheckpointTriggers(state, {
      warnAtUsd: 25,
      hardLimitUsd: 75,
    });
    expect(triggers).toContainEqual(
      expect.objectContaining({ type: "budget-warning" }),
    );
  });

  it("returns budget-critical when cost >= 90% of hardLimitUsd", () => {
    const state = makeState({
      totalCostUsd: 68.0,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "pending" },
      ],
      currentTaskIndex: 1,
    });
    const triggers = evaluateCheckpointTriggers(state, {
      warnAtUsd: 25,
      hardLimitUsd: 75,
    });
    expect(triggers).toContainEqual(
      expect.objectContaining({ type: "budget-critical" }),
    );
  });

  it("does not duplicate budget-warning when budget-critical also fires", () => {
    const state = makeState({
      totalCostUsd: 68.0,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "pending" },
      ],
      currentTaskIndex: 1,
    });
    const triggers = evaluateCheckpointTriggers(state, {
      warnAtUsd: 25,
      hardLimitUsd: 75,
    });
    const types = triggers.map(t => t.type);
    expect(types).toContain("budget-critical");
    expect(types).not.toContain("budget-warning");
  });

  it("returns scheduled trigger when executionMode is checkpoint", () => {
    const state = makeState({
      config: { executionMode: "checkpoint" },
      totalCostUsd: 1.0,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "pending" },
      ],
      currentTaskIndex: 1,
    });
    const triggers = evaluateCheckpointTriggers(state, {
      warnAtUsd: 25,
      hardLimitUsd: 75,
    });
    expect(triggers).toContainEqual(
      expect.objectContaining({ type: "scheduled" }),
    );
  });

  it("does not return scheduled trigger when executionMode is auto", () => {
    const state = makeState({
      config: { executionMode: "auto" },
      totalCostUsd: 1.0,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "pending" },
      ],
      currentTaskIndex: 1,
    });
    const triggers = evaluateCheckpointTriggers(state, {
      warnAtUsd: 25,
      hardLimitUsd: 75,
    });
    const types = triggers.map(t => t.type);
    expect(types).not.toContain("scheduled");
  });

  it("does not fire any triggers when all tasks are complete (nothing remaining)", () => {
    const state = makeState({
      totalCostUsd: 30.0,
      tasks: [
        { id: 1, title: "A", status: "complete" },
      ],
      currentTaskIndex: 1,
    });
    const triggers = evaluateCheckpointTriggers(state, {
      warnAtUsd: 25,
      hardLimitUsd: 75,
    });
    expect(triggers).toEqual([]);
  });
});

describe("formatCheckpointMessage", () => {
  it("formats single trigger with progress stats", () => {
    const msg = formatCheckpointMessage(
      [{ type: "budget-warning", message: "Budget warning: $26.00 spent" }],
      { tasksCompleted: 5, tasksTotal: 20, costUsd: 26.0, estimatedRemainingUsd: 39.0 },
    );
    expect(msg).toContain("5/20");
    expect(msg).toContain("$26.00");
    expect(msg).toContain("$39.00");
    expect(msg).toContain("Budget warning");
  });

  it("formats multiple triggers", () => {
    const msg = formatCheckpointMessage(
      [
        { type: "budget-critical", message: "Budget critical" },
        { type: "scheduled", message: "Scheduled" },
      ],
      { tasksCompleted: 10, tasksTotal: 15, costUsd: 68.0, estimatedRemainingUsd: 22.0 },
    );
    expect(msg).toContain("Budget critical");
    expect(msg).toContain("Scheduled");
  });
});

describe("presentCheckpoint", () => {
  it("returns 'continue' when user selects Continue", async () => {
    const ui = { select: async () => "Continue" };
    const result = await presentCheckpoint(
      [{ type: "scheduled", message: "Scheduled" }],
      { tasksCompleted: 3, tasksTotal: 10, costUsd: 5.0, estimatedRemainingUsd: 12.0 },
      ui as any,
    );
    expect(result).toBe("continue");
  });

  it("returns 'adjust' when user selects Adjust plan", async () => {
    const ui = { select: async () => "Adjust plan" };
    const result = await presentCheckpoint(
      [{ type: "budget-warning", message: "Budget warning" }],
      { tasksCompleted: 5, tasksTotal: 20, costUsd: 26.0, estimatedRemainingUsd: 39.0 },
      ui as any,
    );
    expect(result).toBe("adjust");
  });

  it("returns 'abort' when user selects Abort", async () => {
    const ui = { select: async () => "Abort" };
    const result = await presentCheckpoint(
      [{ type: "budget-critical", message: "Critical" }],
      { tasksCompleted: 10, tasksTotal: 15, costUsd: 68.0, estimatedRemainingUsd: 22.0 },
      ui as any,
    );
    expect(result).toBe("abort");
  });

  it("defaults to 'continue' when ui.select returns undefined", async () => {
    const ui = { select: async () => undefined };
    const result = await presentCheckpoint(
      [{ type: "scheduled", message: "Scheduled" }],
      { tasksCompleted: 1, tasksTotal: 5, costUsd: 1.0, estimatedRemainingUsd: 4.0 },
      ui as any,
    );
    expect(result).toBe("continue");
  });
});

describe("applyPlanAdjustment", () => {
  function makeTasks(statuses: string[]) {
    return statuses.map((s, i) => ({
      id: i + 1,
      title: `Task ${i + 1}`,
      description: `Do task ${i + 1}`,
      files: [`src/${i + 1}.ts`],
      status: s,
      reviewsPassed: [] as string[],
      reviewsFailed: [] as string[],
      fixAttempts: 0,
    }));
  }

  it("drops tasks by ID — removes from array", () => {
    const tasks = makeTasks(["complete", "pending", "pending", "pending"]);
    const adj: PlanAdjustment = { droppedTaskIds: [3], skippedTaskIds: [], reorderedTaskIds: undefined };
    const result = applyPlanAdjustment(tasks, adj);
    expect(result.length).toBe(3);
    expect(result.map(t => t.id)).toEqual([1, 2, 4]);
  });

  it("skips tasks by ID — sets status to skipped", () => {
    const tasks = makeTasks(["complete", "pending", "pending", "pending"]);
    const adj: PlanAdjustment = { droppedTaskIds: [], skippedTaskIds: [3], reorderedTaskIds: undefined };
    const result = applyPlanAdjustment(tasks, adj);
    expect(result.length).toBe(4);
    expect(result.find(t => t.id === 3)!.status).toBe("skipped");
  });

  it("reorders remaining tasks by ID sequence", () => {
    const tasks = makeTasks(["complete", "pending", "pending", "pending"]);
    const adj: PlanAdjustment = { droppedTaskIds: [], skippedTaskIds: [], reorderedTaskIds: [1, 4, 2, 3] };
    const result = applyPlanAdjustment(tasks, adj);
    expect(result.map(t => t.id)).toEqual([1, 4, 2, 3]);
  });

  it("ignores drop/skip on completed tasks", () => {
    const tasks = makeTasks(["complete", "pending", "pending"]);
    const adj: PlanAdjustment = { droppedTaskIds: [1], skippedTaskIds: [], reorderedTaskIds: undefined };
    const result = applyPlanAdjustment(tasks, adj);
    // Task 1 is complete — should NOT be dropped
    expect(result.map(t => t.id)).toContain(1);
    expect(result.length).toBe(3);
  });

  it("handles combined drop + skip + reorder", () => {
    const tasks = makeTasks(["complete", "pending", "pending", "pending", "pending"]);
    const adj: PlanAdjustment = { droppedTaskIds: [4], skippedTaskIds: [3], reorderedTaskIds: [1, 5, 2, 3] };
    const result = applyPlanAdjustment(tasks, adj);
    expect(result.map(t => t.id)).toEqual([1, 5, 2, 3]);
    expect(result.find(t => t.id === 3)!.status).toBe("skipped");
    expect(result.find(t => t.id === 4)).toBeUndefined();
  });

  it("returns tasks unchanged when adjustment is empty", () => {
    const tasks = makeTasks(["complete", "pending", "pending"]);
    const adj: PlanAdjustment = { droppedTaskIds: [], skippedTaskIds: [], reorderedTaskIds: undefined };
    const result = applyPlanAdjustment(tasks, adj);
    expect(result.map(t => t.id)).toEqual([1, 2, 3]);
  });
});

describe("parsePlanRevisionInput", () => {
  it("returns null for empty/whitespace input", () => {
    expect(parsePlanRevisionInput("", [2, 3, 4])).toBeNull();
    expect(parsePlanRevisionInput("  \n  ", [2, 3, 4])).toBeNull();
  });

  it("identifies dropped tasks (IDs present in original but missing from edited)", () => {
    const result = parsePlanRevisionInput(
      "2. Task 2\n4. Task 4",
      [2, 3, 4],
    );
    expect(result).not.toBeNull();
    expect(result!.droppedTaskIds).toEqual([3]);
  });

  it("identifies skipped tasks (lines prefixed with skip:)", () => {
    const result = parsePlanRevisionInput(
      "2. Task 2\nskip: 3. Task 3\n4. Task 4",
      [2, 3, 4],
    );
    expect(result).not.toBeNull();
    expect(result!.skippedTaskIds).toEqual([3]);
  });

  it("detects reordering", () => {
    const result = parsePlanRevisionInput(
      "4. Task 4\n2. Task 2\n3. Task 3",
      [2, 3, 4],
    );
    expect(result).not.toBeNull();
    expect(result!.reorderedTaskIds).toEqual([4, 2, 3]);
  });

  it("returns no reorder when order is unchanged", () => {
    const result = parsePlanRevisionInput(
      "2. Task 2\n3. Task 3\n4. Task 4",
      [2, 3, 4],
    );
    expect(result).not.toBeNull();
    expect(result!.reorderedTaskIds).toBeUndefined();
  });

  it("handles combined drop + skip + reorder", () => {
    const result = parsePlanRevisionInput(
      "4. Task 4\nskip: 2. Task 2",
      [2, 3, 4],
    );
    expect(result).not.toBeNull();
    expect(result!.droppedTaskIds).toEqual([3]);
    expect(result!.skippedTaskIds).toEqual([2]);
    expect(result!.reorderedTaskIds).toEqual([4, 2]);
  });
});

describe("presentPlanRevision", () => {
  function makeTasks(statuses: string[]) {
    return statuses.map((s, i) => ({
      id: i + 1,
      title: `Task ${i + 1}`,
      description: `Do task ${i + 1}`,
      files: [`src/${i + 1}.ts`],
      status: s,
      reviewsPassed: [] as string[],
      reviewsFailed: [] as string[],
      fixAttempts: 0,
    }));
  }

  it("returns null when editor returns undefined (cancelled)", async () => {
    const ui = {
      editor: async () => undefined,
      confirm: async () => false,
    };
    const tasks = makeTasks(["complete", "pending", "pending"]);
    const result = await presentPlanRevision(tasks, ui as any);
    expect(result).toBeNull();
  });

  it("returns null when user rejects confirmation", async () => {
    const ui = {
      editor: async () => "2. Task 2\n3. Task 3",
      confirm: async () => false,
    };
    const tasks = makeTasks(["complete", "pending", "pending"]);
    const result = await presentPlanRevision(tasks, ui as any);
    expect(result).toBeNull();
  });

  it("returns PlanAdjustment when user edits and confirms", async () => {
    const ui = {
      editor: async () => "3. Task 3", // dropped task 2
      confirm: async () => true,
    };
    const tasks = makeTasks(["complete", "pending", "pending"]);
    const result = await presentPlanRevision(tasks, ui as any);
    expect(result).not.toBeNull();
    expect(result!.droppedTaskIds).toEqual([2]);
  });

  it("pre-fills editor with only non-complete tasks", async () => {
    let editorContent = "";
    const ui = {
      editor: async (prompt: string, initial: string) => {
        editorContent = initial;
        return initial; // no changes
      },
      confirm: async () => true,
    };
    const tasks = makeTasks(["complete", "complete", "pending", "pending"]);
    await presentPlanRevision(tasks, ui as any);
    expect(editorContent).not.toContain("Task 1");
    expect(editorContent).not.toContain("Task 2");
    expect(editorContent).toContain("Task 3");
    expect(editorContent).toContain("Task 4");
  });

  it("uses ui.select fallback when ui.editor is not available", async () => {
    const selectResponses = ["Drop task 3", "Done"];
    let selectIdx = 0;
    const ui = {
      select: async () => selectResponses[selectIdx++],
      notify: async () => {},
    };
    const tasks = makeTasks(["complete", "pending", "pending"]);
    const result = await presentPlanRevision(tasks, ui as any);
    expect(result).not.toBeNull();
    expect(result!.droppedTaskIds).toEqual([3]);
  });
});
