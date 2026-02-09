import { describe, it, expect } from "vitest";
import { evaluateCheckpointTriggers, formatCheckpointMessage, presentCheckpoint, type CheckpointTrigger } from "./checkpoint.js";

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
