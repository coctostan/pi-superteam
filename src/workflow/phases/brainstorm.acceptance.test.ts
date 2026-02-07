// src/workflow/phases/brainstorm.acceptance.test.ts
// Acceptance tests for Bug 3 (status bar never updates) and Bug 4 (confirm dialog "undefined")
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
    userDescription: "Add authentication",
    tasks: [],
    currentTaskIndex: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    planReviewCycles: 0,
    ...overrides,
  };
}

describe("Brainstorm phase acceptance tests", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "brainstorm-accept-"));
    mockDiscoverAgents.mockReturnValue({
      agents: [makeAgent("scout"), makeAgent("brainstormer")],
      projectAgentsDir: null,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("AT-7: setStatus is called with strings containing each sub-step name (scout, questions, approaches, design)", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");

    // Parse calls return questions, then approaches, then design — in order
    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "questions",
          questions: [{ id: "q1", text: "What auth provider?", type: "input" }],
        },
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [{ id: "a1", title: "Approach A", summary: "Simple", tradeoffs: "None", taskEstimate: 2 }],
          recommendation: "a1",
          reasoning: "Best",
        },
      } as any)
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "design",
          sections: [{ id: "s1", title: "Architecture", content: "The system uses microservices" }],
        },
      } as any);

    // User answers the question
    ctx.ui.input.mockResolvedValueOnce("OAuth2");
    // User picks the approach
    ctx.ui.select.mockResolvedValueOnce("Approach A");
    // User approves the design section
    ctx.ui.confirm.mockResolvedValueOnce(true);

    const state = makeState({ brainstorm: { step: "scout" } });
    await runBrainstormPhase(state, ctx);

    // Collect all status strings
    const statusCalls = ctx.ui.setStatus.mock.calls.map((c: any[]) => c.join(" ").toLowerCase());
    const allStatusText = statusCalls.join(" ");

    expect(allStatusText).toContain("scout");
    expect(allStatusText).toContain("questions");
    expect(allStatusText).toContain("approach");
    expect(allStatusText).toContain("design");
  });

  it("AT-8: ui.confirm is called with at least 2 arguments (title + body) for design sections", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("agent output");

    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: {
        type: "design",
        sections: [{ id: "s1", title: "Architecture", content: "The system uses microservices" }],
      },
    } as any);

    ctx.ui.confirm.mockResolvedValueOnce(true);

    const state = makeState({
      brainstorm: {
        step: "design",
        scoutOutput: "scout data",
        questions: [{ id: "q1", text: "Q?", type: "input", answer: "A" }],
        chosenApproach: "a1",
        approaches: [{ id: "a1", title: "Approach A", summary: "S", tradeoffs: "T", taskEstimate: 3 }],
      },
    });

    await runBrainstormPhase(state, ctx);

    // ui.confirm must have been called
    expect(ctx.ui.confirm).toHaveBeenCalled();

    const firstCall = ctx.ui.confirm.mock.calls[0];

    // confirm should be called with at least 2 arguments: title and body
    expect(firstCall.length).toBeGreaterThanOrEqual(2);
    expect(firstCall[0]).toBeTruthy(); // non-empty title
    expect(firstCall[1]).toBeDefined();
    expect(String(firstCall[1])).not.toBe("undefined");
  });

  it("AT-9: when section title/content are empty strings, confirm args contain fallbacks and no 'undefined'", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("agent output");

    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: {
        type: "design",
        sections: [{ id: "s1", title: "", content: "" }],
      },
    } as any);

    ctx.ui.confirm.mockResolvedValueOnce(true);

    const state = makeState({
      brainstorm: {
        step: "design",
        scoutOutput: "scout data",
        questions: [{ id: "q1", text: "Q?", type: "input", answer: "A" }],
        chosenApproach: "a1",
        approaches: [{ id: "a1", title: "Approach A", summary: "S", tradeoffs: "T", taskEstimate: 3 }],
      },
    });

    await runBrainstormPhase(state, ctx);

    expect(ctx.ui.confirm).toHaveBeenCalled();

    const firstCall = ctx.ui.confirm.mock.calls[0];
    const allArgs = firstCall.map(String).join(" ");

    // Must not contain the literal string "undefined"
    expect(allArgs).not.toContain("undefined");

    // Must contain fallback text for missing title and content
    expect(allArgs).toMatch(/\(untitled\)/i);
    expect(allArgs).toMatch(/\(no content\)/i);
  });
});
