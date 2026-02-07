// src/workflow/phases/configure.test.ts (rewrite)
import { describe, it, expect, vi } from "vitest";

function makeCtx() {
  return {
    cwd: "/tmp",
    hasUI: true,
    ui: {
      select: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as any;
}

function makeState(overrides: any = {}): any {
  return {
    phase: "configure",
    config: {},
    tasks: [{ id: 1, title: "T", status: "pending" }],
    brainstorm: { step: "done" },
    userDescription: "test",
    currentTaskIndex: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    planReviewCycles: 0,
    ...overrides,
  };
}

describe("runConfigurePhase (direct UI)", () => {
  it("prompts execution mode and review mode via ctx.ui.select", async () => {
    const { runConfigurePhase } = await import("./configure.js");
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Auto")
      .mockResolvedValueOnce("Iterative");

    const state = makeState();
    const result = await runConfigurePhase(state, ctx);

    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    expect(result.config.executionMode).toBe("auto");
    expect(result.config.reviewMode).toBe("iterative");
    expect(result.phase).toBe("execute");
  });

  it("asks for batch size when Batch mode selected", async () => {
    const { runConfigurePhase } = await import("./configure.js");
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Batch")
      .mockResolvedValueOnce("Single-pass");
    ctx.ui.input.mockResolvedValue("5");

    const state = makeState();
    const result = await runConfigurePhase(state, ctx);

    expect(ctx.ui.input).toHaveBeenCalled();
    expect(result.config.batchSize).toBe(5);
    expect(result.config.executionMode).toBe("batch");
  });

  it("defaults batch size to 3 when input is empty", async () => {
    const { runConfigurePhase } = await import("./configure.js");
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Batch")
      .mockResolvedValueOnce("Iterative");
    ctx.ui.input.mockResolvedValue("");

    const state = makeState();
    const result = await runConfigurePhase(state, ctx);

    expect(result.config.batchSize).toBe(3);
  });

  it("does not advance when user cancels (Escape)", async () => {
    const { runConfigurePhase } = await import("./configure.js");
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(undefined);

    const state = makeState();
    const result = await runConfigurePhase(state, ctx);

    expect(result.phase).toBe("configure");
    expect(result.error).toBeUndefined();
  });
});
