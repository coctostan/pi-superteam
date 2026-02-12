// src/workflow/phases/brainstorm.acceptance.test.ts
// Acceptance tests for status bar updates, design section presentation, and triage integration
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

  it("AT-7: setStatus is called with strings containing each sub-step name (scout, triage, questions, approaches, design)", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);

    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout output");

    mockParseBrainstorm
      .mockReturnValueOnce({
        status: "ok",
        data: { type: "triage", level: "exploration", reasoning: "Design choices exist" },
      } as any)
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

    ctx.ui.select
      .mockResolvedValueOnce("Agree — exploration")  // triage
      .mockResolvedValueOnce("Proceed")               // after questions
      .mockResolvedValueOnce("Approach A")            // approach selection
      .mockResolvedValueOnce("Approve");              // approve design
    ctx.ui.input.mockResolvedValueOnce("OAuth2");     // question answer

    const state = makeState({ brainstorm: { step: "scout" } });
    await runBrainstormPhase(state, ctx);

    const statusCalls = ctx.ui.setStatus.mock.calls.map((c: any[]) => c.join(" ").toLowerCase());
    const allStatusText = statusCalls.join(" ");

    expect(allStatusText).toContain("scout");
    expect(allStatusText).toContain("triage");
    expect(allStatusText).toContain("questions");
    expect(allStatusText).toContain("approach");
    expect(allStatusText).toContain("design");
  });

  it("AT-8: design sections are presented via notify with title and content, select for approval", async () => {
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

    ctx.ui.select.mockResolvedValueOnce("Approve");

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

    await runBrainstormPhase(state, ctx);

    // ui.notify should show the section content
    const notifyCalls = ctx.ui.notify.mock.calls.map((c: any[]) => c.join(" "));
    const allNotifyText = notifyCalls.join(" ");
    expect(allNotifyText).toContain("Architecture");
    expect(allNotifyText).toContain("The system uses microservices");

    // ui.select should be called with section title
    const selectCalls = ctx.ui.select.mock.calls.map((c: any[]) => c[0]);
    expect(selectCalls.some((s: string) => s.includes("Architecture"))).toBe(true);
  });

  it("AT-9: when section title/content are empty strings, notify/select contain fallbacks and no 'undefined'", async () => {
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

    ctx.ui.select.mockResolvedValueOnce("Approve");

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

    await runBrainstormPhase(state, ctx);

    const notifyCalls = ctx.ui.notify.mock.calls.map((c: any[]) => c.join(" "));
    const allNotifyText = notifyCalls.join(" ");
    expect(allNotifyText).not.toContain("undefined");
    expect(allNotifyText).toContain("(untitled)");
    expect(allNotifyText).toContain("(no content)");
  });
});
