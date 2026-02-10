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

    ctx.ui.select
      .mockResolvedValueOnce("OAuth")        // q1 choice
      .mockResolvedValueOnce("Proceed")      // after questions
      .mockResolvedValueOnce("Approach A")   // approach selection
      .mockResolvedValue(undefined);         // cancel at design
    ctx.ui.input.mockResolvedValueOnce("100ms");       // q2 input

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
        conversationLog: [],
        complexityLevel: "exploration",
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

    ctx.ui.select.mockResolvedValue("Approve"); // approve both sections

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
        conversationLog: [],
        complexityLevel: "exploration",
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

    ctx.ui.select
      .mockResolvedValueOnce("Revise")  // revise first version
      .mockResolvedValueOnce("Approve"); // approve revision
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

    ctx.ui.select
      .mockResolvedValueOnce("Agree — straightforward") // triage accept
      .mockResolvedValueOnce("Approve"); // approve design section
    
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

  it("questions step offers discuss/proceed menu after answering", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("output");

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "questions",
          questions: [{ id: "q1", text: "What framework?", type: "input" }],
        },
      } as any)
      // Revised questions after discussion
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "questions",
          questions: [
            { id: "q1", text: "What framework?", type: "input" },
            { id: "q2", text: "What about testing?", type: "input" },
          ],
        },
      } as any)
      // Approaches after proceed
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [{ id: "a1", title: "App A", summary: "S", tradeoffs: "T", taskEstimate: 2 }],
          recommendation: "a1",
          reasoning: "Best",
        },
      } as any);

    ctx.ui.input
      .mockResolvedValueOnce("React")         // q1 answer first round
      .mockResolvedValueOnce("We also need testing") // discussion comment
      .mockResolvedValueOnce("React")         // q1 answer second round
      .mockResolvedValueOnce("Jest");         // q2 answer second round
    ctx.ui.select
      .mockResolvedValueOnce("Discuss")       // after first round questions
      .mockResolvedValueOnce("Proceed")       // after second round questions
      .mockResolvedValueOnce("App A")         // approach selection
      .mockResolvedValue(undefined);          // cancel at design

    const state = makeState({
      brainstorm: { step: "questions", scoutOutput: "scout data", conversationLog: [], complexityLevel: "exploration" },
    });
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.questions).toHaveLength(2);
    expect(result.brainstorm.conversationLog!.length).toBeGreaterThanOrEqual(1);
  });

  it("questions step proceeds to approaches when user selects 'Proceed'", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("output");

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "questions",
          questions: [{ id: "q1", text: "How?", type: "input" }],
        },
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [{ id: "a1", title: "App A", summary: "S", tradeoffs: "T", taskEstimate: 2 }],
          recommendation: "a1",
          reasoning: "Best",
        },
      } as any);

    ctx.ui.input.mockResolvedValueOnce("Answer");
    ctx.ui.select
      .mockResolvedValueOnce("Proceed")   // after questions
      .mockResolvedValueOnce("App A")     // approach selection
      .mockResolvedValue(undefined);      // cancel

    const state = makeState({
      brainstorm: { step: "questions", scoutOutput: "scout data", conversationLog: [], complexityLevel: "exploration" },
    });
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.chosenApproach).toBe("a1");
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

  it("approaches step allows discuss and go-back to questions", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({
      brainstorm: {
        step: "approaches",
        scoutOutput: "scout data",
        complexityLevel: "exploration",
        conversationLog: [],
        questions: [{ id: "q1", text: "What DB?", type: "input", answer: "Postgres" }],
      },
    });

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [
            { id: "a1", title: "Approach A", summary: "SA", tradeoffs: "TA", taskEstimate: 3 },
            { id: "a2", title: "Approach B", summary: "SB", tradeoffs: "TB", taskEstimate: 5 },
          ],
          recommendation: "a1",
        },
      } as any);

    // User goes back to questions
    ctx.ui.select.mockResolvedValueOnce("Go back to questions");

    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.step).toBe("questions");
    // Existing question answer should be preserved
    expect(result.brainstorm.questions![0].answer).toBe("Postgres");
  });

  it("design step allows go back to approaches", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({
      brainstorm: {
        step: "design",
        scoutOutput: "scout data",
        complexityLevel: "exploration",
        conversationLog: [],
        questions: [{ id: "q1", text: "Q?", type: "input", answer: "A" }],
        chosenApproach: "a1",
        approaches: [{ id: "a1", title: "Approach A", summary: "S", tradeoffs: "T", taskEstimate: 3 }],
      },
    });

    mockParseBrainstorm.mockReturnValueOnce({
      status: "ok",
      data: {
        type: "design",
        sections: [{ id: "s1", title: "Arch", content: "Content..." }],
      },
    } as any);

    ctx.ui.select.mockResolvedValueOnce("Go back to approaches");

    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.step).toBe("approaches");
    expect(result.brainstorm.questions![0].answer).toBe("A");
  });

  it("design step allows discuss before approving", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({
      brainstorm: {
        step: "design",
        scoutOutput: "scout data",
        complexityLevel: "exploration",
        conversationLog: [],
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
          sections: [{ id: "s1", title: "Architecture", content: "Initial design..." }],
        },
      } as any)
      // Discuss revision
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "design",
          sections: [{ id: "s1", title: "Architecture", content: "Discussed and revised..." }],
        },
      } as any);

    ctx.ui.select
      .mockResolvedValueOnce("Discuss")     // discuss section
      .mockResolvedValueOnce("Approve");    // approve after discussion
    ctx.ui.input.mockResolvedValueOnce("What about caching?");  // discussion comment

    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.step).toBe("done");
    expect(result.designContent).toContain("Discussed and revised");
  });

  it("approaches discuss round revises approaches", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({
      brainstorm: {
        step: "approaches",
        scoutOutput: "scout data",
        complexityLevel: "exploration",
        conversationLog: [],
        questions: [{ id: "q1", text: "Q?", type: "input", answer: "A" }],
      },
    });

    mockParseBrainstorm
      // Initial approaches
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [{ id: "a1", title: "Approach A", summary: "SA", tradeoffs: "TA", taskEstimate: 3 }],
          recommendation: "a1",
        },
      } as any)
      // Revised approaches
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [
            { id: "a1", title: "Approach A (revised)", summary: "SA+", tradeoffs: "TA+", taskEstimate: 4 },
            { id: "a3", title: "Approach C", summary: "SC", tradeoffs: "TC", taskEstimate: 2 },
          ],
          recommendation: "a3",
        },
      } as any);

    ctx.ui.select
      .mockResolvedValueOnce("Discuss")            // discuss approaches
      .mockResolvedValueOnce("Approach C")         // pick revised approach
      .mockResolvedValue(undefined);               // cancel at design
    ctx.ui.input.mockResolvedValueOnce("What about a hybrid approach?");  // discussion comment

    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.chosenApproach).toBe("a3");
    expect(result.brainstorm.conversationLog!.some(e => e.step === "approaches")).toBe(true);
  });

  it("triage with batches populates state.batches and continues with first batch", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "triage",
          level: "complex",
          reasoning: "Large scope, needs batching",
          batches: [
            { title: "Infrastructure", description: "Set up base types" },
            { title: "Wiring", description: "Connect to orchestrator" },
          ],
        },
      } as any);

    ctx.ui.select.mockResolvedValueOnce("Agree — complex")
      .mockResolvedValue(undefined); // cancel at questions

    const state = makeState({ brainstorm: { step: "triage", scoutOutput: "data", conversationLog: [] } });
    const result = await runBrainstormPhase(state, ctx);

    expect(result.batches).toBeDefined();
    expect(result.batches).toHaveLength(2);
    expect(result.batches![0].status).toBe("active");
    expect(result.batches![1].status).toBe("pending");
    expect(result.currentBatchIndex).toBe(0);
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
