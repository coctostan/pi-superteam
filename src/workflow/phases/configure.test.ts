import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInitialState, type OrchestratorState } from "../orchestrator-state.ts";

// Mock saveState
vi.mock("../orchestrator-state.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
  return {
    ...orig,
    saveState: vi.fn(),
  };
});

import { saveState } from "../orchestrator-state.ts";
import { runConfigurePhase } from "./configure.ts";

const mockSaveState = vi.mocked(saveState);

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  const base = createInitialState("test task");
  base.phase = "configure";
  return { ...base, ...overrides };
}

describe("runConfigurePhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks reviewMode first when no config answers exist", async () => {
    const state = makeState();
    const result = await runConfigurePhase(state, { cwd: "/tmp" });

    expect(result.pendingInteraction).toBeDefined();
    expect(result.pendingInteraction!.id).toBe("review-mode");
    expect(mockSaveState).toHaveBeenCalledWith(result, "/tmp");
  });

  it("stores reviewMode answer and asks executionMode next", async () => {
    const state = makeState({
      pendingInteraction: {
        id: "review-mode",
        type: "choice",
        question: "How should code reviews be handled?",
        options: [
          { key: "single-pass", label: "One round of reviews" },
          { key: "iterative", label: "Review-fix loop" },
        ],
      },
    });

    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "single-pass");

    expect(result.config.reviewMode).toBe("single-pass");
    expect(result.pendingInteraction).toBeDefined();
    expect(result.pendingInteraction!.id).toBe("execution-mode");
  });

  it("stores executionMode=auto and completes configuration", async () => {
    const state = makeState({
      config: { tddMode: "tdd", reviewMode: "single-pass", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
      pendingInteraction: {
        id: "execution-mode",
        type: "choice",
        question: "How should tasks be executed?",
        options: [
          { key: "auto", label: "Auto" },
          { key: "checkpoint", label: "Checkpoint" },
          { key: "batch", label: "Batch" },
        ],
      },
    });

    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "auto");

    expect(result.config.executionMode).toBe("auto");
    expect(result.config.batchSize).toBe(3);
    expect(result.phase).toBe("execute");
    expect(result.pendingInteraction).toBeUndefined();
    expect(mockSaveState).toHaveBeenCalled();
  });

  it("asks batchSize when executionMode is batch", async () => {
    const state = makeState({
      config: { tddMode: "tdd", reviewMode: "iterative", maxPlanReviewCycles: 3, maxTaskReviewCycles: 3 },
      pendingInteraction: {
        id: "execution-mode",
        type: "choice",
        question: "How should tasks be executed?",
        options: [
          { key: "auto", label: "Auto" },
          { key: "checkpoint", label: "Checkpoint" },
          { key: "batch", label: "Batch" },
        ],
      },
    });

    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "batch");

    expect(result.config.executionMode).toBe("batch");
    expect(result.pendingInteraction).toBeDefined();
    expect(result.pendingInteraction!.id).toBe("batch-size");
    expect(result.phase).toBe("configure"); // not done yet
  });

  it("stores batchSize and completes configuration", async () => {
    const state = makeState({
      config: {
        tddMode: "tdd",
        reviewMode: "iterative",
        executionMode: "batch",
        maxPlanReviewCycles: 3,
        maxTaskReviewCycles: 3,
      },
      pendingInteraction: {
        id: "batch-size",
        type: "input",
        question: "How many tasks per batch?",
        default: "3",
      },
    });

    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "5");

    expect(result.config.batchSize).toBe(5);
    expect(result.phase).toBe("execute");
    expect(result.pendingInteraction).toBeUndefined();
  });

  it("defaults batchSize to 3 when empty input given", async () => {
    const state = makeState({
      config: {
        tddMode: "tdd",
        reviewMode: "iterative",
        executionMode: "batch",
        maxPlanReviewCycles: 3,
        maxTaskReviewCycles: 3,
      },
      pendingInteraction: {
        id: "batch-size",
        type: "input",
        question: "How many tasks per batch?",
        default: "3",
      },
    });

    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "");

    expect(result.config.batchSize).toBe(3);
    expect(result.phase).toBe("execute");
  });

  it("clamps batchSize to minimum of 1", async () => {
    const state = makeState({
      config: {
        tddMode: "tdd",
        reviewMode: "iterative",
        executionMode: "batch",
        maxPlanReviewCycles: 3,
        maxTaskReviewCycles: 3,
      },
      pendingInteraction: {
        id: "batch-size",
        type: "input",
        question: "How many tasks per batch?",
        default: "3",
      },
    });

    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "0");

    expect(result.config.batchSize).toBe(1);
  });

  it("sets defaults for maxPlanReviewCycles and maxTaskReviewCycles on completion", async () => {
    const state = makeState({
      config: { tddMode: "tdd", reviewMode: "single-pass" },
      pendingInteraction: {
        id: "execution-mode",
        type: "choice",
        question: "How should tasks be executed?",
        options: [
          { key: "auto", label: "Auto" },
          { key: "checkpoint", label: "Checkpoint" },
          { key: "batch", label: "Batch" },
        ],
      },
    });

    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "checkpoint");

    expect(result.config.maxPlanReviewCycles).toBe(3);
    expect(result.config.maxTaskReviewCycles).toBe(3);
    expect(result.phase).toBe("execute");
  });

  it("accepts reviewMode by number selection", async () => {
    const state = makeState({
      pendingInteraction: {
        id: "review-mode",
        type: "choice",
        question: "How should code reviews be handled?",
        options: [
          { key: "single-pass", label: "One round of reviews" },
          { key: "iterative", label: "Review-fix loop" },
        ],
      },
    });

    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "2");

    expect(result.config.reviewMode).toBe("iterative");
  });

  it("does nothing with userInput when no pendingInteraction exists", async () => {
    const state = makeState();
    // userInput provided but no pending interaction — should just ask first question
    const result = await runConfigurePhase(state, { cwd: "/tmp" }, "some-input");

    expect(result.pendingInteraction).toBeDefined();
    expect(result.pendingInteraction!.id).toBe("review-mode");
  });
});
