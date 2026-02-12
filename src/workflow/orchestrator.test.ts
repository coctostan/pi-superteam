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
vi.mock("./git-preflight.js", () => ({ runGitPreflight: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: any) => cb(null, "", "")) }));
vi.mock("node:util", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:util")>();
  return { ...orig, promisify: (_fn: any) => vi.fn().mockResolvedValue({ stdout: "", stderr: "" }) };
});

import { saveState } from "./orchestrator-state.ts";
import { runBrainstormPhase } from "./phases/brainstorm.ts";
import { runPlanWritePhase } from "./phases/plan-write.ts";
import { runPlanReviewPhase } from "./phases/plan-review.ts";
import { runConfigurePhase } from "./phases/configure.ts";
import { runExecutePhase } from "./phases/execute.ts";
import { runFinalizePhase } from "./phases/finalize.ts";
import { writeProgressFile } from "./progress.ts";
import { runGitPreflight } from "./git-preflight.ts";

const mockSaveState = vi.mocked(saveState);
const mockGitPreflight = vi.mocked(runGitPreflight);
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

  describe("git preflight integration", () => {
    it("calls runGitPreflight and stores sha/branch on first run", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      mockGitPreflight.mockResolvedValue({
        clean: true, branch: "feat/work", isMainBranch: false,
        sha: "abc123", uncommittedFiles: [], warnings: [],
      });
      mockBrainstorm.mockImplementation(async (state) => {
        state.phase = "done";
        return state;
      });

      const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test", tasks: [], currentTaskIndex: 0 } as any;
      const ctx = makeCtx();
      const result = await runWorkflowLoop(state, ctx);

      expect(mockGitPreflight).toHaveBeenCalledWith(ctx.cwd);
      expect(result.gitStartingSha).toBe("abc123");
      expect(result.gitBranch).toBe("feat/work");
    });

    it("skips preflight when gitStartingSha is already set (resume)", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      mockBrainstorm.mockImplementation(async (state) => {
        state.phase = "done";
        return state;
      });

      const state = {
        phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0,
        userDescription: "test", tasks: [], currentTaskIndex: 0,
        gitStartingSha: "already-set", gitBranch: "feat/existing",
      } as any;
      const ctx = makeCtx();
      await runWorkflowLoop(state, ctx);

      expect(mockGitPreflight).not.toHaveBeenCalled();
    });

    it("offers stash/continue/abort when repo is dirty", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      mockGitPreflight.mockResolvedValue({
        clean: false, branch: "feat/work", isMainBranch: false,
        sha: "abc123", uncommittedFiles: ["src/a.ts"], warnings: [],
      });
      mockBrainstorm.mockImplementation(async (state) => {
        state.phase = "done";
        return state;
      });

      const ctx = makeCtx();
      ctx.ui.select.mockResolvedValue("Continue anyway");

      const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test", tasks: [], currentTaskIndex: 0 } as any;
      const result = await runWorkflowLoop(state, ctx);

      expect(ctx.ui.select).toHaveBeenCalled();
      expect(result.gitStartingSha).toBe("abc123");
    });

    it("aborts when user selects Abort on dirty repo", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      mockGitPreflight.mockResolvedValue({
        clean: false, branch: "feat/work", isMainBranch: false,
        sha: "abc123", uncommittedFiles: ["src/a.ts"], warnings: [],
      });

      const ctx = makeCtx();
      ctx.ui.select.mockResolvedValue("Abort");

      const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test", tasks: [], currentTaskIndex: 0 } as any;
      const result = await runWorkflowLoop(state, ctx);

      expect(result.phase).toBe("done");
      expect(result.error).toContain("Abort");
    });

    it("offers branch creation when on main branch", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      mockGitPreflight.mockResolvedValue({
        clean: true, branch: "main", isMainBranch: true,
        sha: "abc123", uncommittedFiles: [], warnings: ["On main branch"],
      });
      mockBrainstorm.mockImplementation(async (state) => {
        state.phase = "done";
        return state;
      });

      const ctx = makeCtx();
      ctx.ui.select.mockResolvedValue("Continue on main");

      const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test", tasks: [], currentTaskIndex: 0 } as any;
      const result = await runWorkflowLoop(state, ctx);

      expect(ctx.ui.select).toHaveBeenCalled();
      const selectArgs = ctx.ui.select.mock.calls[0];
      expect(selectArgs[1]).toEqual(expect.arrayContaining(["Continue on main"]));
    });

    it("sets gitBranch to new branch name when user creates workflow branch", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      mockGitPreflight.mockResolvedValue({
        clean: true, branch: "main", isMainBranch: true,
        sha: "abc123", uncommittedFiles: [], warnings: ["On main branch"],
      });
      mockBrainstorm.mockImplementation(async (state) => {
        state.phase = "done";
        return state;
      });

      const ctx = makeCtx();
      ctx.ui.select.mockResolvedValue("Create workflow branch");

      const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "Add login feature", tasks: [], currentTaskIndex: 0 } as any;
      const result = await runWorkflowLoop(state, ctx);

      expect(result.gitBranch).toBe("workflow/add-login-feature");
      expect(result.gitStartingSha).toBe("abc123");
    });

    it("silently skips preflight in non-git directories", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      mockGitPreflight.mockRejectedValue(new Error("not a git repository"));
      mockBrainstorm.mockImplementation(async (state) => {
        state.phase = "done";
        return state;
      });

      const ctx = makeCtx();
      const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0, userDescription: "test", tasks: [], currentTaskIndex: 0 } as any;
      const result = await runWorkflowLoop(state, ctx);

      expect(result.phase).toBe("done");
      expect(result.error).toBeUndefined();
    });
  });

  describe("batch looping", () => {
    it("loops back to plan-write for next batch after execute completes", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      const ctx = makeCtx();

      const state = {
        phase: "execute",
        brainstorm: { step: "done" },
        totalCostUsd: 0,
        userDescription: "test",
        tasks: [{ id: 1, title: "T1", status: "complete" }],
        currentTaskIndex: 0,
        gitStartingSha: "abc",
        gitBranch: "feat/test",
        batches: [
          { title: "Batch 1", description: "First", status: "active" },
          { title: "Batch 2", description: "Second", status: "pending" },
        ],
        currentBatchIndex: 0,
      } as any;

      // Execute completes → finalize
      mockExecute.mockImplementation(async (s) => { s.phase = "finalize"; return s; });
      // User continues to next batch
      ctx.ui.select.mockResolvedValueOnce("Continue to next batch");
      // Plan-write for batch 2 → done
      mockPlanWrite.mockImplementation(async (s) => { s.phase = "done"; return s; });
      // Finalize for batch 1
      mockFinalize.mockImplementation(async (s) => { return { state: s, report: "done" }; });

      const result = await runWorkflowLoop(state, ctx);

      expect(result.currentBatchIndex).toBe(1);
      expect(result.batches![0].status).toBe("complete");
      expect(result.batches![1].status).toBe("active");
    });

    it("stops at finalize when user selects 'Stop here'", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      const ctx = makeCtx();

      const state = {
        phase: "execute",
        brainstorm: { step: "done" },
        totalCostUsd: 0,
        userDescription: "test",
        tasks: [],
        currentTaskIndex: 0,
        gitStartingSha: "abc",
        gitBranch: "feat/test",
        batches: [
          { title: "Batch 1", description: "First", status: "active" },
          { title: "Batch 2", description: "Second", status: "pending" },
        ],
        currentBatchIndex: 0,
      } as any;

      mockExecute.mockImplementation(async (s) => { s.phase = "finalize"; return s; });
      ctx.ui.select.mockResolvedValueOnce("Stop here");
      mockFinalize.mockImplementation(async (s) => { return { state: s, report: "done" }; });

      const result = await runWorkflowLoop(state, ctx);

      expect(result.phase).toBe("done");
      expect(result.currentBatchIndex).toBe(0);
    });
  });

  describe("queue processing", () => {
    it("offers to run queued workflows after completion", async () => {
      const { runWorkflowLoop } = await import("./orchestrator.js");
      const { enqueueWorkflow, clearQueue } = await import("./workflow-queue.js");
      const ctx = makeCtx("/tmp/test-queue");

      // Set up queue
      const fs = await import("node:fs");
      fs.mkdirSync("/tmp/test-queue", { recursive: true });
      clearQueue("/tmp/test-queue");
      enqueueWorkflow("/tmp/test-queue", { title: "Next task", description: "Do next thing" });

      const state = {
        phase: "finalize",
        brainstorm: { step: "done" },
        totalCostUsd: 0,
        userDescription: "first task",
        tasks: [],
        currentTaskIndex: 0,
        gitStartingSha: "abc",
        gitBranch: "feat/test",
      } as any;

      mockFinalize.mockImplementation(async (s) => { return { state: s, report: "done" }; });
      ctx.ui.select.mockResolvedValue("Stop");

      const result = await runWorkflowLoop(state, ctx);
      expect(result.phase).toBe("done");

      // Clean up
      clearQueue("/tmp/test-queue");
      fs.rmSync("/tmp/test-queue", { recursive: true, force: true });
    });
  });
});
