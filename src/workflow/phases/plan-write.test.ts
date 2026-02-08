// src/workflow/phases/plan-write.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../../dispatch.js", () => ({
  discoverAgents: vi.fn(),
  dispatchAgent: vi.fn(),
  getFinalOutput: vi.fn(),
}));

vi.mock("../orchestrator-state.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../orchestrator-state.ts")>();
  return { ...orig, saveState: vi.fn() };
});

import { discoverAgents, dispatchAgent, getFinalOutput } from "../../dispatch.ts";
import type { AgentProfile, DispatchResult } from "../../dispatch.ts";

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
const mockGetFinalOutput = vi.mocked(getFinalOutput);

function makeAgent(name: string): AgentProfile {
  return { name, description: name, systemPrompt: "", source: "package", filePath: `/agents/${name}.md` };
}

function makeDispatchResult(cost = 0.2): DispatchResult {
  return {
    agent: "test", agentSource: "package", task: "", exitCode: 0, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 0 },
  };
}

function makeState(overrides: any = {}): any {
  return {
    phase: "plan-write",
    brainstorm: { step: "done", scoutOutput: "scout data" },
    config: {},
    userDescription: "Add auth",
    designPath: "docs/plans/2026-02-07-add-auth-design.md",
    designContent: "# Design\nArchitecture section...",
    tasks: [],
    currentTaskIndex: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    planReviewCycles: 0,
    ...overrides,
  };
}

describe("runPlanWritePhase", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-write-"));
    mockDiscoverAgents.mockReturnValue({
      agents: [makeAgent("planner"), makeAgent("implementer")],
      projectAgentsDir: null,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dispatches planner agent (not implementer)", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async (agent) => {
      if (agent.name === "planner") {
        const planDir = path.join(tmpDir, "docs/plans");
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(
          path.join(planDir, "2026-02-07-add-auth-plan.md"),
          "# Plan\n```superteam-tasks\n- title: Task1\n  description: Do the thing\n  files: [src/a.ts]\n```"
        );
      }
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState();
    await runPlanWritePhase(state, ctx);

    expect(mockDispatchAgent.mock.calls[0][0].name).toBe("planner");
  });

  it("includes design content in planner prompt", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async (agent) => {
      if (agent.name === "planner") {
        const planDir = path.join(tmpDir, "docs/plans");
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(
          path.join(planDir, "2026-02-07-add-auth-plan.md"),
          "# Plan\n```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```"
        );
      }
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({ designContent: "# My Custom Design\nPassport.js approach" });
    await runPlanWritePhase(state, ctx);

    const prompt = mockDispatchAgent.mock.calls[0][1];
    expect(prompt).toContain("My Custom Design");
    expect(prompt).toContain("Passport.js");
  });

  it("advances to plan-review with parsed tasks", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async (agent) => {
      if (agent.name === "planner") {
        const planDir = path.join(tmpDir, "docs/plans");
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(
          path.join(planDir, "2026-02-07-add-auth-plan.md"),
          "# Plan\n```superteam-tasks\n- title: Create model\n  description: Set up user model\n  files: [src/model.ts]\n- title: Add routes\n  description: REST endpoints\n  files: [src/routes.ts]\n```"
        );
      }
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState();
    const result = await runPlanWritePhase(state, ctx);

    expect(result.phase).toBe("plan-review");
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].title).toBe("Create model");
    expect(result.planPath).toBeDefined();
    expect(result.planContent).toBeTruthy();
  });

  it("sets error when planner agent not found", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;
    mockDiscoverAgents.mockReturnValue({ agents: [], projectAgentsDir: null });

    const state = makeState();
    const result = await runPlanWritePhase(state, ctx);

    expect(result.error).toContain("planner");
  });

  it("retries once when no tasks parsed", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

    let callCount = 0;
    mockDispatchAgent.mockImplementation(async (agent) => {
      callCount++;
      if (agent.name === "planner") {
        const planDir = path.join(tmpDir, "docs/plans");
        fs.mkdirSync(planDir, { recursive: true });
        if (callCount === 1) {
          // First attempt: plan with no parseable tasks
          fs.writeFileSync(path.join(planDir, "2026-02-07-add-auth-plan.md"), "# Plan\nNo tasks block");
        } else {
          // Retry: plan with valid tasks
          fs.writeFileSync(
            path.join(planDir, "2026-02-07-add-auth-plan.md"),
            "# Plan\n```superteam-tasks\n- title: Task1\n  description: D\n  files: [a.ts]\n```"
          );
        }
      }
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState();
    const result = await runPlanWritePhase(state, ctx);

    expect(callCount).toBe(2);
    expect(result.tasks).toHaveLength(1);
  });

  it("accumulates cost from dispatch", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async (agent) => {
      if (agent.name === "planner") {
        const planDir = path.join(tmpDir, "docs/plans");
        fs.mkdirSync(planDir, { recursive: true });
        fs.writeFileSync(
          path.join(planDir, "2026-02-07-add-auth-plan.md"),
          "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```"
        );
      }
      return makeDispatchResult(0.35);
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({ totalCostUsd: 1.0 });
    const result = await runPlanWritePhase(state, ctx);

    expect(result.totalCostUsd).toBeGreaterThan(1.0);
  });

  it("forwards onStreamEvent callback to dispatchAgent", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async () => {
      const planDir = path.join(tmpDir, "docs/plans");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, "2026-02-07-add-auth-plan.md"),
        "# Plan\n```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```"
      );
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const onStreamEvent = vi.fn();
    const state = makeState();
    await runPlanWritePhase(state, ctx, undefined, onStreamEvent);

    // Verify dispatchAgent was called with onStreamEvent in the 6th position
    const firstDispatchCall = mockDispatchAgent.mock.calls[0];
    expect(firstDispatchCall.length).toBeGreaterThanOrEqual(6);
    expect(firstDispatchCall[5]).toBeDefined();
  });

  it("falls back to searching docs/plans/ for recent design file when designPath is undefined", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

    // Create a design file in docs/plans/
    const planDir = path.join(tmpDir, "docs/plans");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, "2026-02-07-auth-design.md"), "# Design\nSome design content");

    mockDispatchAgent.mockImplementation(async () => {
      // The plan path should be derived from the discovered design file
      const today = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(
        path.join(planDir, "2026-02-07-auth-plan.md"),
        "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```"
      );
      return makeDispatchResult();
    });

    const state = makeState({ designPath: undefined, designContent: undefined });
    const result = await runPlanWritePhase(state, ctx);

    expect(result.tasks).toHaveLength(1);
    expect(result.phase).toBe("plan-review");
  });

  it("generates a date-based plan path when designPath is undefined and no design file found", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

    const today = new Date().toISOString().slice(0, 10);

    mockDispatchAgent.mockImplementation(async () => {
      const planDir = path.join(tmpDir, "docs/plans");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, `${today}-plan.md`),
        "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```"
      );
      return makeDispatchResult();
    });

    const state = makeState({ designPath: undefined, designContent: undefined });
    const result = await runPlanWritePhase(state, ctx);

    expect(result.planPath).toBeDefined();
    expect(result.planPath).toContain("plan.md");
  });
});
