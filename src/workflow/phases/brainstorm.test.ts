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

    // After scout, triage dispatch happens — set up parse
    mockParseBrainstorm.mockReturnValueOnce({
      status: "ok",
      data: { type: "triage", level: "exploration", reasoning: "Needs exploration" },
    } as any);
    // Cancel at triage select
    ctx.ui.select.mockResolvedValue(undefined);

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
      brainstorm: { step: "questions", scoutOutput: "scout data", conversationLog: [], complexityLevel: "exploration" },
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
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "design",
          sections: [{ id: "s1", title: "Arch", content: "Content" }],
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

    mockParseBrainstorm.mockReturnValueOnce({
      status: "ok",
      data: { type: "triage", level: "exploration", reasoning: "Needs exploration" },
    } as any);
    // Cancel at triage select
    ctx.ui.select.mockResolvedValue(undefined);

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

    const state = makeState({ brainstorm: { step: "questions", scoutOutput: "scout data", conversationLog: [], complexityLevel: "exploration" } });

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

    const state = makeState({ brainstorm: { step: "questions", scoutOutput: "scout data", conversationLog: [], complexityLevel: "exploration" } });

    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);
    ctx.ui.input.mockResolvedValue(undefined); // user cancels

    const result = await runBrainstormPhase(state, ctx);

    expect(result.phase).toBe("brainstorm"); // did not advance
    expect(result.error).toBeUndefined();
  });

  it("runs triage step after scout and stores complexity level", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");

    mockParseBrainstorm
      // Triage response
      .mockReturnValueOnce({
        status: "ok",
        data: { type: "triage", level: "exploration", reasoning: "Design choices exist" },
      } as any)
      // Questions response (after triage)
      .mockReturnValueOnce({
        status: "ok",
        data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
      } as any);

    // User agrees with triage assessment
    ctx.ui.select.mockResolvedValueOnce("Agree — exploration");
    // Cancel at question menu to stop flow
    ctx.ui.select.mockResolvedValueOnce(undefined);

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.complexityLevel).toBe("exploration");
    expect(result.brainstorm.conversationLog).toBeDefined();
  });

  it("straightforward triage skips questions and approaches", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "triage",
          level: "straightforward",
          reasoning: "Focused change",
          suggestedSkips: ["questions", "approaches"],
        },
      } as any)
      // Design response (skipping questions and approaches)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "design",
          sections: [{ id: "s1", title: "Quick Design", content: "Simple change..." }],
        },
      } as any);

    ctx.ui.select.mockResolvedValueOnce("Agree — straightforward"); // triage accept
    ctx.ui.confirm.mockResolvedValueOnce(true); // approve design section
    
    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.complexityLevel).toBe("straightforward");
    expect(result.brainstorm.step).toBe("done");
    expect(result.phase).toBe("plan-write");
  });

  it("triage skip to planning goes directly to plan-write", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");

    mockParseBrainstorm.mockReturnValueOnce({
      status: "ok",
      data: { type: "triage", level: "exploration", reasoning: "Some reasoning" },
    } as any);

    ctx.ui.select.mockResolvedValueOnce("Skip to planning");

    // Start at triage step (past scout)
    const state = makeState({ brainstorm: { step: "triage", scoutOutput: "scout data", conversationLog: [] } });
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.step).toBe("done");
    expect(result.phase).toBe("plan-write");
  });

  it("triage discuss round re-dispatches brainstormer and re-presents", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");

    mockParseBrainstorm
      // Initial triage
      .mockReturnValueOnce({
        status: "ok",
        data: { type: "triage", level: "straightforward", reasoning: "Simple" },
      } as any)
      // Revised triage after discussion
      .mockReturnValueOnce({
        status: "ok",
        data: { type: "triage", level: "complex", reasoning: "After discussion, actually complex" },
      } as any);

    ctx.ui.select
      .mockResolvedValueOnce("Discuss")  // discuss triage
      .mockResolvedValueOnce("Agree — complex")  // accept revised triage
      .mockResolvedValueOnce(undefined);  // cancel at questions
    ctx.ui.input
      .mockResolvedValueOnce("This is actually complex because...");  // discussion comment

    const state = makeState({ brainstorm: { step: "triage", scoutOutput: "scout data", conversationLog: [] } });
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.complexityLevel).toBe("complex");
    expect(result.brainstorm.conversationLog!.length).toBeGreaterThanOrEqual(2);
  });

  it("forwards onStreamEvent callback to dispatchAgent", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");
    mockParseBrainstorm.mockReturnValueOnce({
      status: "ok",
      data: { type: "triage", level: "exploration", reasoning: "Needs exploration" },
    } as any);
    ctx.ui.select.mockResolvedValue(undefined); // cancel at triage

    const onStreamEvent = vi.fn();
    const state = makeState();
    await runBrainstormPhase(state, ctx, undefined, onStreamEvent);

    // Verify dispatchAgent was called with onStreamEvent in the 6th position
    const firstDispatchCall = mockDispatchAgent.mock.calls[0];
    expect(firstDispatchCall.length).toBeGreaterThanOrEqual(6);
    expect(firstDispatchCall[5]).toBeDefined();
  });
});
