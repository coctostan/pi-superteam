// src/workflow/phases/brainstorm-triage.acceptance.test.ts
// Full-flow acceptance tests for the triage-first brainstorm workflow
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
    userDescription: "Add authentication to the API",
    tasks: [],
    currentTaskIndex: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    planReviewCycles: 0,
    ...overrides,
  };
}

describe("Full brainstorm triage acceptance tests", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-accept-"));
    mockDiscoverAgents.mockReturnValue({
      agents: [makeAgent("scout"), makeAgent("brainstormer")],
      projectAgentsDir: null,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("AT-TRIAGE-1: full exploration flow — scout → triage → questions → approaches → design → done", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult(0.05));
    mockGetFinalOutput.mockReturnValue("TypeScript project with Express, Vitest, 42 files");

    mockParseBrainstorm
      // Triage
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "triage",
          level: "exploration",
          reasoning: "Authentication involves meaningful design choices: session management, token format, middleware placement.",
        },
      } as any)
      // Questions
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "questions",
          questions: [
            { id: "q1", text: "JWT or session-based auth?", type: "choice", options: ["JWT", "Session cookies"] },
            { id: "q2", text: "Which routes need auth?", type: "input" },
          ],
        },
      } as any)
      // Approaches
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [
            { id: "a1", title: "Passport.js middleware", summary: "Use Passport with JWT strategy", tradeoffs: "More dependencies", taskEstimate: 4 },
            { id: "a2", title: "Custom middleware", summary: "Hand-rolled auth middleware", tradeoffs: "More code, less magic", taskEstimate: 5 },
          ],
          recommendation: "a1",
          reasoning: "Passport is battle-tested",
        },
      } as any)
      // Design
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "design",
          sections: [
            { id: "s1", title: "Authentication Architecture", content: "The auth system uses Passport.js with JWT tokens..." },
            { id: "s2", title: "Middleware Chain", content: "Express routes are protected by auth middleware..." },
          ],
        },
      } as any);

    // User flow:
    ctx.ui.select
      .mockResolvedValueOnce("Agree — exploration")         // triage
      .mockResolvedValueOnce("JWT")                          // q1
      .mockResolvedValueOnce("Proceed")                      // after questions
      .mockResolvedValueOnce("Passport.js middleware")       // approach
      .mockResolvedValueOnce("Approve")                      // design s1
      .mockResolvedValueOnce("Approve");                     // design s2
    ctx.ui.input.mockResolvedValueOnce("All /api/* routes"); // q2

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    // Assertions
    expect(result.brainstorm.step).toBe("done");
    expect(result.phase).toBe("plan-write");
    expect(result.brainstorm.complexityLevel).toBe("exploration");
    expect(result.brainstorm.scoutOutput).toContain("Express");
    expect(result.brainstorm.questions).toHaveLength(2);
    expect(result.brainstorm.questions![0].answer).toBe("JWT");
    expect(result.brainstorm.questions![1].answer).toBe("All /api/* routes");
    expect(result.brainstorm.chosenApproach).toBe("a1");
    expect(result.designContent).toContain("Authentication Architecture");
    expect(result.designContent).toContain("Middleware Chain");
    expect(result.brainstorm.conversationLog!.length).toBeGreaterThan(0);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it("AT-TRIAGE-2: straightforward flow skips questions and approaches", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult(0.03));
    mockGetFinalOutput.mockReturnValue("Small TypeScript project, 12 files");

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "triage",
          level: "straightforward",
          reasoning: "Simple rename with clear path.",
          suggestedSkips: ["questions", "approaches"],
        },
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "design",
          sections: [{ id: "s1", title: "Rename Plan", content: "Rename all occurrences of oldName to newName..." }],
        },
      } as any);

    ctx.ui.select
      .mockResolvedValueOnce("Agree — straightforward")
      .mockResolvedValueOnce("Approve");

    const state = makeState({ userDescription: "Rename function oldName to newName" });
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.step).toBe("done");
    expect(result.phase).toBe("plan-write");
    expect(result.brainstorm.complexityLevel).toBe("straightforward");
    // Should NOT have questions or approaches
    expect(result.brainstorm.questions).toBeUndefined();
    expect(result.brainstorm.approaches).toBeUndefined();
  });

  it("AT-TRIAGE-3: complex flow with batches populates batch state", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult(0.1));
    mockGetFinalOutput.mockReturnValue("Large project, 200 files");

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "triage",
          level: "complex",
          reasoning: "Broad refactor touching infrastructure, API, and CLI.",
          batches: [
            { title: "Infrastructure", description: "Add base types and validation" },
            { title: "API layer", description: "Update Express routes" },
            { title: "CLI integration", description: "Wire new API into CLI" },
          ],
        },
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "questions",
          questions: [{ id: "q1", text: "Target Node version?", type: "input" }],
        },
      } as any);

    ctx.ui.select.mockResolvedValueOnce("Agree — complex");
    ctx.ui.input.mockResolvedValue(undefined); // cancel at questions

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.complexityLevel).toBe("complex");
    expect(result.batches).toHaveLength(3);
    expect(result.batches![0].status).toBe("active");
    expect(result.batches![1].status).toBe("pending");
    expect(result.batches![2].status).toBe("pending");
    expect(result.currentBatchIndex).toBe(0);
  });

  it("AT-TRIAGE-4: discussion loop allows user to revise triage assessment", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult(0.05));
    mockGetFinalOutput.mockReturnValue("scout output");

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: { type: "triage", level: "straightforward", reasoning: "Looks simple" },
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: { type: "triage", level: "exploration", reasoning: "After discussion, this needs more thought" },
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "questions",
          questions: [{ id: "q1", text: "Q?", type: "input" }],
        },
      } as any);

    ctx.ui.select
      .mockResolvedValueOnce("Discuss")           // discuss initial triage
      .mockResolvedValueOnce("Agree — exploration") // accept revised triage
      .mockResolvedValue(undefined);              // cancel at questions
    ctx.ui.input.mockResolvedValueOnce("This is more complex than it seems because...");

    const state = makeState({ brainstorm: { step: "triage", scoutOutput: "data", conversationLog: [] } });
    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.complexityLevel).toBe("exploration");
    expect(result.brainstorm.conversationLog!.length).toBeGreaterThanOrEqual(3);
    // Should have: initial reasoning, user comment, revised reasoning
    const roles = result.brainstorm.conversationLog!.map((e: any) => e.role);
    expect(roles).toContain("brainstormer");
    expect(roles).toContain("user");
  });

  it("AT-TRIAGE-5: conversation log is filtered per step", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult(0.05));
    mockGetFinalOutput.mockReturnValue("scout output");

    // Start at questions step with pre-existing triage log
    mockParseBrainstorm.mockReturnValueOnce({
      status: "ok",
      data: {
        type: "questions",
        questions: [{ id: "q1", text: "Q?", type: "input" }],
      },
    } as any);

    ctx.ui.input.mockResolvedValue(undefined); // cancel at first question

    const state = makeState({
      brainstorm: {
        step: "questions",
        scoutOutput: "data",
        complexityLevel: "exploration",
        conversationLog: [
          { role: "brainstormer", step: "triage", content: "Triage reasoning" },
          { role: "user", step: "triage", content: "User triage comment" },
        ],
      },
    });

    const result = await runBrainstormPhase(state, ctx);

    // Triage entries should still be in the log
    const triageEntries = result.brainstorm.conversationLog!.filter((e: any) => e.step === "triage");
    expect(triageEntries).toHaveLength(2);
    // Questions entries should be added
    const questionsEntries = result.brainstorm.conversationLog!.filter((e: any) => e.step === "questions");
    expect(questionsEntries.length).toBeGreaterThanOrEqual(1);
  });
});
