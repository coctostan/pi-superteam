// src/workflow/orchestrator.test.ts (rewrite)
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./orchestrator-state.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./orchestrator-state.ts")>();
  return { ...orig, saveState: vi.fn(), loadState: vi.fn(), clearState: vi.fn() };
});

vi.mock("./phases/brainstorm.js", () => ({ runBrainstormPhase: vi.fn() }));
vi.mock("./phases/plan-write.js", () => ({ runPlanWritePhase: vi.fn() }));
vi.mock("./phases/plan-review.js", () => ({ runPlanReviewPhase: vi.fn() }));
vi.mock("./phases/configure.js", () => ({ runConfigurePhase: vi.fn() }));
vi.mock("./phases/execute.js", () => ({ runExecutePhase: vi.fn() }));
vi.mock("./phases/finalize.js", () => ({ runFinalizePhase: vi.fn() }));
vi.mock("./progress.js", () => ({ writeProgressFile: vi.fn() }));

import { saveState } from "./orchestrator-state.ts";
import { runBrainstormPhase } from "./phases/brainstorm.ts";
import { runPlanWritePhase } from "./phases/plan-write.ts";
import { runPlanReviewPhase } from "./phases/plan-review.ts";
import { runConfigurePhase } from "./phases/configure.ts";
import { runExecutePhase } from "./phases/execute.ts";
import { runFinalizePhase } from "./phases/finalize.ts";
import { writeProgressFile } from "./progress.ts";

const mockSaveState = vi.mocked(saveState);
const mockBrainstorm = vi.mocked(runBrainstormPhase);
const mockPlanWrite = vi.mocked(runPlanWritePhase);
const mockPlanReview = vi.mocked(runPlanReviewPhase);
const mockConfigure = vi.mocked(runConfigurePhase);
const mockExecute = vi.mocked(runExecutePhase);
const mockFinalize = vi.mocked(runFinalizePhase);
const mockWriteProgress = vi.mocked(writeProgressFile);

function makeCtx(cwd = "/tmp") {
  return {
    cwd,
    hasUI: true,
    ui: {
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  } as any;
}

describe("runWorkflowLoop", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("calls phase function matching current state.phase", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test" } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(mockBrainstorm).toHaveBeenCalledWith(state, ctx, undefined);
  });

  it("chains phases: brainstorm → plan-write → done", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test" } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "plan-write"; return s; });
    mockPlanWrite.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(mockBrainstorm).toHaveBeenCalled();
    expect(mockPlanWrite).toHaveBeenCalled();
  });

  it("saves state and writes progress after each phase", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test" } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(mockSaveState).toHaveBeenCalled();
    expect(mockWriteProgress).toHaveBeenCalled();
  });

  it("stops and notifies on error", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test" } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.error = "Agent failed"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Agent failed"), "warning");
    expect(mockPlanWrite).not.toHaveBeenCalled();
  });

  it("clears status and widget when done", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test" } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("workflow", undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-progress", undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-activity", undefined);
  });
});
