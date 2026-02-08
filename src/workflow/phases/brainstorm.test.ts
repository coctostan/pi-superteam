// src/workflow/phases/brainstorm.test.ts — brainstorm skip option + onStreamEvent wiring
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

vi.mock("../brainstorm-parser.js", () => ({
  parseBrainstormOutput: vi.fn(),
}));

import { discoverAgents, dispatchAgent, getFinalOutput } from "../../dispatch.ts";
import { saveState } from "../orchestrator-state.ts";
import { parseBrainstormOutput } from "../brainstorm-parser.ts";
import type { AgentProfile, DispatchResult } from "../../dispatch.ts";

const mockDiscoverAgents = vi.mocked(discoverAgents);
const mockDispatchAgent = vi.mocked(dispatchAgent);
const mockGetFinalOutput = vi.mocked(getFinalOutput);
const mockParseBrainstorm = vi.mocked(parseBrainstormOutput);

function makeAgent(name: string): AgentProfile {
  return { name, description: name, systemPrompt: "", source: "package", filePath: `/agents/${name}.md` };
}

function makeDispatchResult(cost = 0.1): DispatchResult {
  return {
    agent: "test", agentSource: "package", task: "", exitCode: 0, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 0 },
  };
}

function makeCtx(tmpDir: string) {
  return {
    cwd: tmpDir,
    hasUI: true,
    ui: {
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      editor: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  } as any;
}

function makeState(overrides: any = {}): any {
  return {
    phase: "brainstorm",
    brainstorm: { step: "scout" },
    config: {},
    userDescription: "Add authentication",
    tasks: [],
    currentTaskIndex: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    planReviewCycles: 0,
    ...overrides,
  };
}

describe("runBrainstormPhase", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brainstorm-"));
    mockDiscoverAgents.mockReturnValue({
      agents: [makeAgent("scout"), makeAgent("brainstormer")],
      projectAgentsDir: null,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dispatches scout agent and stores output", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout summary: 42 files, Express app");

    // After scout, questions dispatch happens — set up parse
    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);
    // User cancels at first question
    ctx.ui.input.mockResolvedValue(undefined);

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    expect(mockDispatchAgent).toHaveBeenCalled();
    expect(mockDispatchAgent.mock.calls[0][0].name).toBe("scout");
    expect(result.brainstorm.scoutOutput).toBe("scout summary: 42 files, Express app");
  });

  it("presents questions to user via ctx.ui and stores answers", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("agent output");

    const state = makeState({
      brainstorm: { step: "questions", scoutOutput: "scout data" },
    });

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "questions",
          questions: [
            { id: "q1", text: "What auth?", type: "choice", options: ["OAuth", "SAML"] },
            { id: "q2", text: "Perf target?", type: "input" },
          ],
        },
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [{ id: "a1", title: "Approach A", summary: "S", tradeoffs: "T", taskEstimate: 3 }],
          recommendation: "a1",
          reasoning: "Best",
        },
      } as any);

    ctx.ui.select.mockResolvedValueOnce("OAuth");     // q1 choice
    ctx.ui.input.mockResolvedValueOnce("100ms");       // q2 input
    ctx.ui.select.mockResolvedValueOnce("Approach A"); // approach selection
    ctx.ui.confirm.mockResolvedValue(undefined);       // cancel at design step

    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.questions![0].answer).toBe("OAuth");
    expect(result.brainstorm.questions![1].answer).toBe("100ms");
    expect(result.brainstorm.chosenApproach).toBe("a1");
  });

  it("saves design document when all sections approved", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("agent output");

    const state = makeState({
      brainstorm: {
        step: "design",
        scoutOutput: "scout data",
        questions: [{ id: "q1", text: "Q?", type: "input", answer: "A" }],
        chosenApproach: "a1",
        approaches: [{ id: "a1", title: "Approach A", summary: "S", tradeoffs: "T", taskEstimate: 3 }],
      },
    });

    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: {
        type: "design",
        sections: [
          { id: "s1", title: "Architecture", content: "The system uses..." },
          { id: "s2", title: "Data Flow", content: "Data flows..." },
        ],
      },
    } as any);

    ctx.ui.confirm.mockResolvedValue(true); // approve both sections

    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.step).toBe("done");
    expect(result.designPath).toBeDefined();
    expect(result.designContent).toBeTruthy();
    expect(result.designContent).toContain("Architecture");
    expect(result.designContent).toContain("Data Flow");
    expect(result.phase).toBe("plan-write");
  });

  it("handles section rejection with revision dispatch", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("agent output");

    const state = makeState({
      brainstorm: {
        step: "design",
        scoutOutput: "scout data",
        questions: [{ id: "q1", text: "Q?", type: "input", answer: "A" }],
        chosenApproach: "a1",
        approaches: [{ id: "a1", title: "Approach A", summary: "S", tradeoffs: "T", taskEstimate: 3 }],
      },
    });

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "design",
          sections: [
            { id: "s1", title: "Architecture", content: "The system uses..." },
          ],
        },
      } as any)
      // Revision response
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "design",
          sections: [
            { id: "s1", title: "Architecture", content: "Revised: The system..." },
          ],
        },
      } as any);

    ctx.ui.confirm
      .mockResolvedValueOnce(false)  // reject first version
      .mockResolvedValueOnce(true);  // approve revision
    ctx.ui.input.mockResolvedValueOnce("Add more detail about error handling");

    const result = await runBrainstormPhase(state, ctx);

    // Revision dispatch happened (brainstormer called at least twice for design)
    expect(mockDispatchAgent.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.brainstorm.step).toBe("done");
  });

  it("accumulates cost from all dispatches", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult(0.15));
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({ brainstorm: { step: "scout" }, totalCostUsd: 1.0 });

    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);
    ctx.ui.input.mockResolvedValue(undefined); // cancel at questions

    const result = await runBrainstormPhase(state, ctx);

    expect(result.totalCostUsd).toBeGreaterThan(1.0);
  });

  it("sets error when required agent not found", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDiscoverAgents.mockReturnValue({ agents: [], projectAgentsDir: null });

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/scout|brainstormer/i);
  });

  it("retries once on parse failure then errors", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("no structured output");

    const state = makeState({ brainstorm: { step: "questions", scoutOutput: "scout data" } });

    mockParseBrainstorm.mockReturnValue({ status: "error", rawOutput: "garbage", parseError: "no block" } as any);
    ctx.ui.select.mockResolvedValue("Abort");

    const result = await runBrainstormPhase(state, ctx);

    // Should have dispatched brainstormer at least twice (original + retry)
    const brainstormCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "brainstormer");
    expect(brainstormCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles user cancellation gracefully — saves state without advancing", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({ brainstorm: { step: "questions", scoutOutput: "scout data" } });

    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);
    ctx.ui.input.mockResolvedValue(undefined); // user cancels

    const result = await runBrainstormPhase(state, ctx);

    expect(result.phase).toBe("brainstorm"); // did not advance
    expect(result.error).toBeUndefined();
  });

  it("offers skip option before scout and skips to plan-write when selected", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    // User selects "Skip brainstorm"
    ctx.ui.select.mockResolvedValueOnce("Skip brainstorm");

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    expect(result.phase).toBe("plan-write");
    expect(result.brainstorm.step).toBe("done");
    // Scout should NOT have been dispatched
    expect(mockDispatchAgent).not.toHaveBeenCalled();
  });

  it("proceeds with brainstorm when user selects 'Start brainstorm'", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");
    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);

    // User selects "Start brainstorm", then cancels at first question
    ctx.ui.select.mockResolvedValueOnce("Start brainstorm");
    ctx.ui.input.mockResolvedValue(undefined);

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    // Scout should have been dispatched
    expect(mockDispatchAgent).toHaveBeenCalled();
    expect(mockDispatchAgent.mock.calls[0][0].name).toBe("scout");
  });

  it("does not offer skip option when brainstorm is already past scout step", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("output");
    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);
    ctx.ui.input.mockResolvedValue(undefined);

    const state = makeState({ brainstorm: { step: "questions", scoutOutput: "data" } });
    await runBrainstormPhase(state, ctx);

    // select should only be called for questions, not for skip prompt
    // The first select call should NOT have "Skip brainstorm" as an option
    if (ctx.ui.select.mock.calls.length > 0) {
      const firstCallOptions = ctx.ui.select.mock.calls[0][1];
      expect(firstCallOptions).not.toContain("Skip brainstorm");
    }
  });

  it("forwards onStreamEvent callback to dispatchAgent", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");
    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);
    ctx.ui.input.mockResolvedValue(undefined);

    const onStreamEvent = vi.fn();
    const state = makeState();
    await runBrainstormPhase(state, ctx, undefined, onStreamEvent);

    // Verify dispatchAgent was called with onStreamEvent in the 6th position
    const firstDispatchCall = mockDispatchAgent.mock.calls[0];
    expect(firstDispatchCall.length).toBeGreaterThanOrEqual(6);
    expect(firstDispatchCall[5]).toBeDefined();
  });
});
