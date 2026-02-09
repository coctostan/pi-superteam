import { describe, it, expect } from "vitest";
import { evaluateCheckpointTriggers, type CheckpointTrigger } from "./checkpoint.js";

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
