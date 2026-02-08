# Workflow Orchestrator Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the workflow orchestrator to emulate superpowers' full development pipeline (brainstorm → design → plan → review → execute → finalize) while keeping all flow control in deterministic TypeScript. LLMs are dispatched as subagents for creative tasks only. Users interact through pi's native UI dialogs.

**Architecture:** The orchestrator is a deterministic state machine in TypeScript. Each phase (brainstorm, plan-write, plan-review, configure, execute, finalize) is a pure-ish function that takes state + context, dispatches agents for creative work, uses `ctx.ui.*` for user interaction, and returns updated state. A central `runWorkflowLoop` drives phase transitions. All agent output is parsed via structured fenced blocks (`superteam-brainstorm`, `superteam-json`). State is persisted to `.superteam-workflow.json` after every step. A human-readable `progress.md` file is maintained alongside.

**Tech Stack:** TypeScript (ESM, .js extensions), vitest for testing, pi extension API (`ctx.ui.*`, `registerCommand`, `registerTool`), pi JSON mode events for streaming visibility.

**Design doc:** `docs/plans/2026-02-07-workflow-redesign-design.md`

---

## Task 1: Create brainstormer and planner agent profiles

Create two new agent markdown profiles for the brainstormer (read-only, structured JSON output) and planner (writes plan files, no bash/edit).

**Files:**
- Create: `agents/brainstormer.md`
- Create: `agents/planner.md`
- Test: `agents/agents.test.ts`

**Step 1: Write the failing test**

Write a test that uses `discoverAgents` to load agents from the package `agents/` directory and asserts that `brainstormer` and `planner` profiles exist with the correct tools and properties.

```typescript
// agents/agents.test.ts
import { describe, it, expect } from "vitest";
import { discoverAgents } from "../src/dispatch.js";
import * as path from "node:path";

describe("agent profiles", () => {
  // Use the actual package agents dir
  const { agents } = discoverAgents(path.resolve("."), false);

  it("brainstormer agent exists with read-only tools", () => {
    const brainstormer = agents.find(a => a.name === "brainstormer");
    expect(brainstormer).toBeDefined();
    expect(brainstormer!.tools).toEqual(expect.arrayContaining(["read", "find", "grep", "ls"]));
    expect(brainstormer!.tools).not.toContain("write");
    expect(brainstormer!.tools).not.toContain("edit");
    expect(brainstormer!.tools).not.toContain("bash");
    expect(brainstormer!.description).toBeTruthy();
    expect(brainstormer!.systemPrompt).toContain("superteam-brainstorm");
  });

  it("planner agent exists with write but no bash/edit", () => {
    const planner = agents.find(a => a.name === "planner");
    expect(planner).toBeDefined();
    expect(planner!.tools).toEqual(expect.arrayContaining(["read", "write", "find", "grep", "ls"]));
    expect(planner!.tools).not.toContain("bash");
    expect(planner!.tools).not.toContain("edit");
    expect(planner!.description).toBeTruthy();
    expect(planner!.systemPrompt).toContain("superteam-tasks");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run agents/agents.test.ts`
Expected: FAIL — brainstormer and planner agents not found.

**Step 3: Write brainstormer.md**

Create `agents/brainstormer.md` with frontmatter (`name: brainstormer`, `tools: read,find,grep,ls`) and system prompt instructing the agent to return structured `superteam-brainstorm` JSON for questions, approaches, and design sections.

**Step 4: Write planner.md**

Create `agents/planner.md` with frontmatter (`name: planner`, `tools: read,write,find,grep,ls`) and system prompt instructing the agent to write detailed TDD implementation plans with `superteam-tasks` YAML blocks.

**Step 5: Run tests to verify they pass**

Run: `npx vitest run agents/agents.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add agents/brainstormer.md agents/planner.md agents/agents.test.ts
git commit -m "feat: add brainstormer and planner agent profiles"
```

---

## Task 2: Add streaming event callback to dispatch.ts

Add an `onStreamEvent` callback parameter to `runAgent` and `dispatchAgent` in `dispatch.ts`. Parse `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` JSON events from the subprocess stdout and fire the callback.

**Files:**
- Modify: `src/dispatch.ts`
- Test: `src/dispatch-stream.test.ts`

**Step 1: Write the failing test**

Test that `runAgent` (via `dispatchAgent`) fires `onStreamEvent` with the correct event shape. Mock the subprocess to emit JSON lines including tool execution events. Since we can't easily mock `spawn`, test at the type/integration level by verifying the `StreamEvent` type is exported and the signature accepts the callback.

```typescript
// src/dispatch-stream.test.ts
import { describe, it, expect } from "vitest";
import type { StreamEvent, OnStreamEvent } from "./dispatch.js";

describe("StreamEvent types", () => {
  it("StreamEvent has required fields", () => {
    const event: StreamEvent = {
      type: "tool_execution_start",
      toolName: "read",
      args: { path: "src/index.ts" },
    };
    expect(event.type).toBe("tool_execution_start");
    expect(event.toolName).toBe("read");
  });

  it("OnStreamEvent is a function type accepting StreamEvent", () => {
    const handler: OnStreamEvent = (event) => {
      // no-op
    };
    const event: StreamEvent = { type: "tool_execution_end", toolName: "bash" };
    handler(event);
  });

  it("StreamEvent supports all tool execution event types", () => {
    const start: StreamEvent = { type: "tool_execution_start", toolName: "read", args: { path: "x" } };
    const update: StreamEvent = { type: "tool_execution_update", toolName: "bash", result: "partial" };
    const end: StreamEvent = { type: "tool_execution_end", toolName: "write", isError: false };
    expect(start.type).toBe("tool_execution_start");
    expect(update.type).toBe("tool_execution_update");
    expect(end.type).toBe("tool_execution_end");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/dispatch-stream.test.ts`
Expected: FAIL — `StreamEvent` and `OnStreamEvent` not exported from dispatch.

**Step 3: Implement StreamEvent types and callback wiring**

In `dispatch.ts`:
1. Export `StreamEvent` type and `OnStreamEvent` callback type.
2. Add optional `onStreamEvent?: OnStreamEvent` parameter to `runAgent` (after `onResultUpdate`).
3. In the `processLine` function inside `runAgent`, detect `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events and call `onStreamEvent` if provided.
4. Add optional `onStreamEvent?: OnStreamEvent` parameter to `dispatchAgent` and thread it through to `runAgent`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dispatch-stream.test.ts`
Expected: PASS

**Step 5: Verify existing tests still pass**

Run: `npx vitest run src/dispatch.test.ts`
Expected: PASS (no breaking changes — parameter is optional)

**Step 6: Commit**

```bash
git add src/dispatch.ts src/dispatch-stream.test.ts
git commit -m "feat: add onStreamEvent callback to dispatch for streaming visibility"
```

---

## Task 3: Brainstorm output parser

Create `src/workflow/brainstorm-parser.ts` that extracts and validates `superteam-brainstorm` fenced blocks. Supports three response types: questions, approaches, and design sections. Follows the same pattern as `review-parser.ts`.

**Files:**
- Create: `src/workflow/brainstorm-parser.ts`
- Test: `src/workflow/brainstorm-parser.test.ts`

**Step 1: Write the failing test**

```typescript
// src/workflow/brainstorm-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseBrainstormOutput, type BrainstormParseResult } from "./brainstorm-parser.js";

describe("parseBrainstormOutput", () => {
  it("parses questions response from superteam-brainstorm block", () => {
    const raw = `Some preamble text\n\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "questions",
      questions: [
        { id: "q1", text: "What auth?", type: "choice", options: ["OAuth", "SAML"] },
        { id: "q2", text: "Performance target?", type: "input" },
      ],
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("questions");
      expect(result.data.questions).toHaveLength(2);
      expect(result.data.questions![0].options).toEqual(["OAuth", "SAML"]);
    }
  });

  it("parses approaches response", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "approaches",
      approaches: [
        { id: "a1", title: "State machine", summary: "Clean", tradeoffs: "Boilerplate", taskEstimate: 5 },
      ],
      recommendation: "a1",
      reasoning: "Best fit",
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("approaches");
      expect(result.data.approaches).toHaveLength(1);
      expect(result.data.recommendation).toBe("a1");
    }
  });

  it("parses design response", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({
      type: "design",
      sections: [
        { id: "s1", title: "Architecture", content: "The system uses..." },
        { id: "s2", title: "Data Flow", content: "User input flows..." },
      ],
    })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.type).toBe("design");
      expect(result.data.sections).toHaveLength(2);
    }
  });

  it("returns error when no fenced block found", () => {
    const result = parseBrainstormOutput("No structured output here");
    expect(result.status).toBe("error");
  });

  it("returns error for malformed JSON", () => {
    const result = parseBrainstormOutput("```superteam-brainstorm\n{bad json\n```");
    expect(result.status).toBe("error");
  });

  it("returns error when type field is missing", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({ noType: true })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("error");
  });

  it("falls back to last JSON brace block when no fenced block", () => {
    const raw = `Text before ${JSON.stringify({ type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] })} text after`;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/brainstorm-parser.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement brainstorm-parser.ts**

Create `src/workflow/brainstorm-parser.ts`:
- Export types: `BrainstormQuestion`, `BrainstormApproach`, `DesignSection`, `BrainstormData`, `BrainstormParseResult`.
- Export `parseBrainstormOutput(rawOutput: string): BrainstormParseResult`.
- Extract `superteam-brainstorm` fenced block (fallback to last `{...}` brace block, same as review-parser).
- Parse JSON, validate `type` field is one of `"questions"`, `"approaches"`, `"design"`.
- Validate and normalize child arrays with sensible defaults.
- Return `{ status: "ok", data }` or `{ status: "error", rawOutput, parseError }`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/brainstorm-parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/brainstorm-parser.ts src/workflow/brainstorm-parser.test.ts
git commit -m "feat: add brainstorm output parser for superteam-brainstorm blocks"
```

---

## Task 4: Progress file generator

Create `src/workflow/progress.ts` — a pure function that takes `OrchestratorState` and produces a markdown progress file. Called after every `saveState()`.

**Files:**
- Create: `src/workflow/progress.ts`
- Test: `src/workflow/progress.test.ts`

**Step 1: Write the failing test**

```typescript
// src/workflow/progress.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Will import after implementation
// import { generateProgressMarkdown, writeProgressFile } from "./progress.js";

describe("generateProgressMarkdown", () => {
  it("generates markdown with workflow title and phase status", async () => {
    const { generateProgressMarkdown } = await import("./progress.js");
    const state = makeState({ phase: "brainstorm", userDescription: "Add auth" });
    const md = generateProgressMarkdown(state);
    expect(md).toContain("# Workflow: Add auth");
    expect(md).toContain("**Status:** Brainstorm");
  });

  it("includes brainstorm checklist items", async () => {
    const { generateProgressMarkdown } = await import("./progress.js");
    const state = makeState({
      phase: "brainstorm",
      brainstorm: { step: "questions", scoutOutput: "scout data" },
    });
    const md = generateProgressMarkdown(state);
    expect(md).toContain("[x] Scout codebase");
    expect(md).toContain("[ ] Requirements");
  });

  it("includes task list with status markers", async () => {
    const { generateProgressMarkdown } = await import("./progress.js");
    const state = makeState({
      phase: "execute",
      currentTaskIndex: 1,
      tasks: [
        { id: 1, title: "Create model", status: "complete" },
        { id: 2, title: "Add routes", status: "implementing" },
        { id: 3, title: "Add tests", status: "pending" },
      ],
    });
    const md = generateProgressMarkdown(state);
    expect(md).toContain("[x] 1. Create model");
    expect(md).toContain("[ ] 2. Add routes — implementing");
    expect(md).toContain("[ ] 3. Add tests");
  });

  it("includes cost in header", async () => {
    const { generateProgressMarkdown } = await import("./progress.js");
    const state = makeState({ totalCostUsd: 3.42 });
    const md = generateProgressMarkdown(state);
    expect(md).toContain("$3.42");
  });
});

describe("writeProgressFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "progress-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes progress file to docs/plans/ directory", async () => {
    const { writeProgressFile } = await import("./progress.js");
    const state = makeState({
      userDescription: "Add auth",
      designPath: "docs/plans/2026-02-07-add-auth-design.md",
    });
    writeProgressFile(state, tmpDir);
    const progressPath = path.join(tmpDir, "docs/plans/2026-02-07-add-auth-progress.md");
    expect(fs.existsSync(progressPath)).toBe(true);
  });

  it("derives path from planPath when designPath is missing", async () => {
    const { writeProgressFile } = await import("./progress.js");
    const state = makeState({
      planPath: "docs/plans/2026-02-07-my-feature-plan.md",
    });
    writeProgressFile(state, tmpDir);
    const progressPath = path.join(tmpDir, "docs/plans/2026-02-07-my-feature-progress.md");
    expect(fs.existsSync(progressPath)).toBe(true);
  });
});

// Helper
function makeState(overrides: any = {}): any {
  return {
    phase: "brainstorm",
    userDescription: "test task",
    brainstorm: { step: "scout" },
    config: {},
    tasks: [],
    currentTaskIndex: 0,
    totalCostUsd: 0,
    startedAt: Date.now(),
    planReviewCycles: 0,
    ...overrides,
  };
}
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/progress.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement progress.ts**

Create `src/workflow/progress.ts`:
- `generateProgressMarkdown(state: OrchestratorState): string` — pure function, formats state as markdown with sections for brainstorm, plan, config, tasks, and a timestamped log.
- `writeProgressFile(state: OrchestratorState, cwd: string): void` — derives file path from `state.designPath` or `state.planPath` (replace `-design.md`/`-plan.md` with `-progress.md`), writes to disk.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/progress.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/progress.ts src/workflow/progress.test.ts
git commit -m "feat: add progress file generator for human-readable workflow tracking"
```

---

## Task 5: UI helper functions

Create `src/workflow/ui.ts` with helper functions for formatting status bar text, formatting tool actions for the activity widget, and presenting brainstorm interactions (questions, approaches, design sections) via `ctx.ui.*`.

**Files:**
- Create: `src/workflow/ui.ts`
- Test: `src/workflow/ui.test.ts`

**Step 1: Write the failing test**

```typescript
// src/workflow/ui.test.ts
import { describe, it, expect } from "vitest";
import {
  formatStatus,
  formatToolAction,
  formatTaskProgress,
} from "./ui.js";

describe("formatStatus", () => {
  it("formats brainstorm phase status", () => {
    const state = { phase: "brainstorm", brainstorm: { step: "questions" }, totalCostUsd: 0.42, tasks: [], currentTaskIndex: 0 };
    expect(formatStatus(state as any)).toContain("brainstorm");
    expect(formatStatus(state as any)).toContain("questions");
    expect(formatStatus(state as any)).toContain("$0.42");
  });

  it("formats execute phase status", () => {
    const state = {
      phase: "execute",
      tasks: [
        { status: "complete" }, { status: "complete" }, { status: "implementing" },
        { status: "pending" }, { status: "pending" },
      ],
      currentTaskIndex: 2,
      totalCostUsd: 4.18,
    };
    expect(formatStatus(state as any)).toContain("execute");
    expect(formatStatus(state as any)).toContain("task 3/5");
    expect(formatStatus(state as any)).toContain("$4.18");
  });
});

describe("formatToolAction", () => {
  it("formats read action", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
    expect(result).toContain("read");
    expect(result).toContain("src/index.ts");
  });

  it("formats bash action with command snippet", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "bash", args: { command: "vitest run auth" } });
    expect(result).toContain("vitest run auth");
  });

  it("formats write action", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "write", args: { path: "src/auth.ts" } });
    expect(result).toContain("write");
    expect(result).toContain("src/auth.ts");
  });

  it("formats edit action", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "edit", args: { path: "src/auth.ts" } });
    expect(result).toContain("edit");
    expect(result).toContain("src/auth.ts");
  });

  it("formats grep action", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "grep", args: { pattern: "authenticate" } });
    expect(result).toContain("grep");
    expect(result).toContain("authenticate");
  });

  it("truncates long bash commands", () => {
    const longCmd = "a".repeat(200);
    const result = formatToolAction({ type: "tool_execution_start", toolName: "bash", args: { command: longCmd } });
    expect(result.length).toBeLessThan(150);
  });
});

describe("formatTaskProgress", () => {
  it("generates progress lines for widget", () => {
    const tasks = [
      { id: 1, title: "Create model", status: "complete" },
      { id: 2, title: "Add routes", status: "implementing" },
      { id: 3, title: "Add tests", status: "pending" },
    ];
    const lines = formatTaskProgress(tasks as any[], 1);
    expect(lines.some(l => l.includes("✓") && l.includes("Create model"))).toBe(true);
    expect(lines.some(l => l.includes("▸") && l.includes("Add routes"))).toBe(true);
    expect(lines.some(l => l.includes("○") && l.includes("Add tests"))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/ui.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement ui.ts**

Create `src/workflow/ui.ts`:
- `formatStatus(state): string` — one-line footer status (e.g. `⚡ Workflow: brainstorm (questions) | $0.42`)
- `formatToolAction(event): string` — human-readable tool action from a stream event
- `formatTaskProgress(tasks, currentIndex): string[]` — array of lines for the widget display
- `updateActivityWidget(ctx, agentName, recentActions: string[]): void` — calls `ctx.ui.setWidget` with formatted activity lines
- `updateStatusBar(ctx, state): void` — calls `ctx.ui.setStatus` with `formatStatus`

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/ui.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/ui.ts src/workflow/ui.test.ts
git commit -m "feat: add UI helper functions for workflow status, activity, and progress"
```

---

## Task 6: Updated state model

Update `src/workflow/orchestrator-state.ts` to add `BrainstormState`, new phase types (`brainstorm`, `plan-write`), `designPath`, `designContent`, and remove `pendingInteraction`. Update `createInitialState` to start in `brainstorm` phase.

**Files:**
- Modify: `src/workflow/orchestrator-state.ts`
- Test: `src/workflow/orchestrator-state.test.ts`

**Step 1: Write the failing test**

Add tests for the new state shape:

```typescript
// Add to src/workflow/orchestrator-state.test.ts (or create new section)
import { describe, it, expect } from "vitest";
import { createInitialState, type OrchestratorState, type BrainstormState } from "./orchestrator-state.js";

describe("updated state model", () => {
  it("createInitialState starts in brainstorm phase", () => {
    const state = createInitialState("Build auth");
    expect(state.phase).toBe("brainstorm");
  });

  it("createInitialState has initialized brainstorm sub-state", () => {
    const state = createInitialState("Build auth");
    expect(state.brainstorm).toBeDefined();
    expect(state.brainstorm.step).toBe("scout");
  });

  it("state supports designPath and designContent", () => {
    const state = createInitialState("Build auth");
    state.designPath = "docs/plans/2026-02-07-auth-design.md";
    state.designContent = "# Design\n...";
    expect(state.designPath).toBeTruthy();
    expect(state.designContent).toBeTruthy();
  });

  it("OrchestratorPhase includes brainstorm and plan-write", () => {
    const state = createInitialState("test");
    state.phase = "brainstorm";
    expect(state.phase).toBe("brainstorm");
    state.phase = "plan-write";
    expect(state.phase).toBe("plan-write");
  });

  it("BrainstormState has all required fields", () => {
    const bs: BrainstormState = {
      step: "scout",
    };
    expect(bs.step).toBe("scout");
    // Verify optional fields compile
    bs.scoutOutput = "output";
    bs.questions = [];
    bs.currentQuestionIndex = 0;
    bs.approaches = [];
    bs.recommendation = "a1";
    bs.chosenApproach = "a1";
    bs.designSections = [];
    bs.currentSectionIndex = 0;
  });

  it("no pendingInteraction field on state", () => {
    const state = createInitialState("test");
    expect("pendingInteraction" in state).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/orchestrator-state.test.ts`
Expected: FAIL — `BrainstormState` not exported, `createInitialState` starts at `plan-draft`, no `brainstorm` field.

**Step 3: Implement state model changes**

In `src/workflow/orchestrator-state.ts`:
1. Add `"brainstorm" | "plan-write"` to `OrchestratorPhase` union, remove `"plan-draft"`.
2. Export `BrainstormStep`, `BrainstormQuestion`, `BrainstormApproach`, `DesignSection`, `BrainstormState` types.
3. Add `brainstorm: BrainstormState`, `designPath?: string`, `designContent?: string` to `OrchestratorState`.
4. Remove `pendingInteraction` from `OrchestratorState`.
5. Update `createInitialState` to set `phase: "brainstorm"` and `brainstorm: { step: "scout" }`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/orchestrator-state.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/orchestrator-state.ts src/workflow/orchestrator-state.test.ts
git commit -m "feat: update state model with brainstorm state, new phases, remove pendingInteraction"
```

---

## Task 7: Brainstorm phase

Create `src/workflow/phases/brainstorm.ts` implementing the full brainstorm flow: scout → questions → approaches → design sections → save design. Uses `ctx.ui.*` for all user interaction, `dispatchAgent` for creative work, and `parseBrainstormOutput` for structured parsing.

**Files:**
- Create: `src/workflow/phases/brainstorm.ts`
- Test: `src/workflow/phases/brainstorm.test.ts`

**Step 1: Write the failing test**

```typescript
// src/workflow/phases/brainstorm.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock dispatch
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
  return { name, description: `${name}`, systemPrompt: "", source: "package", filePath: `/agents/${name}.md` };
}

function makeDispatchResult(): DispatchResult {
  return { agent: "test", agentSource: "package", task: "", exitCode: 0, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 0, turns: 0 } };
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

  it("dispatches scout agent in scout step", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("scout summary");

    // After scout, it will try questions — set up parse to return questions
    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);

    // User cancels at first question
    ctx.ui.input.mockResolvedValue(undefined);

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    expect(mockDispatchAgent).toHaveBeenCalled();
    const scoutCall = mockDispatchAgent.mock.calls[0];
    expect(scoutCall[0].name).toBe("scout");
    expect(result.brainstorm.scoutOutput).toBe("scout summary");
  });

  it("presents questions to user and stores answers", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult());
    mockGetFinalOutput.mockReturnValue("agent output");

    // Scout already done, start at questions step
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
      // After questions answered, approaches dispatch
      .mockReturnValueOnce({
        status: "ok",
        data: {
          type: "approaches",
          approaches: [{ id: "a1", title: "Approach A", summary: "S", tradeoffs: "T", taskEstimate: 3 }],
          recommendation: "a1",
          reasoning: "Best",
        },
      } as any);

    ctx.ui.select.mockResolvedValueOnce("OAuth");  // q1 choice
    ctx.ui.input.mockResolvedValueOnce("100ms");    // q2 input
    ctx.ui.select.mockResolvedValueOnce("Approach A"); // choose approach
    // Will cancel at design step
    ctx.ui.confirm.mockResolvedValue(undefined);

    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.questions![0].answer).toBe("OAuth");
    expect(result.brainstorm.questions![1].answer).toBe("100ms");
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
          { id: "s1", title: "Architecture", content: "The system..." },
          { id: "s2", title: "Data Flow", content: "Data flows..." },
        ],
      },
    } as any);

    // Approve both sections
    ctx.ui.confirm.mockResolvedValue(true);

    const result = await runBrainstormPhase(state, ctx);

    expect(result.brainstorm.step).toBe("done");
    expect(result.designPath).toBeDefined();
    expect(result.designContent).toBeTruthy();
    expect(result.phase).toBe("plan-write");
  });

  it("accumulates cost from all dispatches", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDispatchAgent.mockResolvedValue(makeDispatchResult()); // cost = 0.1 each
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({ brainstorm: { step: "scout" } });

    // Scout returns, then questions dispatch returns, user cancels at question
    mockParseBrainstorm.mockReturnValue({
      status: "ok",
      data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
    } as any);
    ctx.ui.input.mockResolvedValue(undefined); // cancel

    const result = await runBrainstormPhase(state, ctx);

    // At least scout dispatch cost was accumulated
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it("sets error when scout agent not found", async () => {
    const { runBrainstormPhase } = await import("./brainstorm.js");
    const ctx = makeCtx(tmpDir);
    mockDiscoverAgents.mockReturnValue({ agents: [], projectAgentsDir: null });

    const state = makeState();
    const result = await runBrainstormPhase(state, ctx);

    expect(result.error).toContain("scout");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/brainstorm.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement brainstorm.ts**

Create `src/workflow/phases/brainstorm.ts`:
- `runBrainstormPhase(state, ctx, signal?): Promise<OrchestratorState>` 
- Sub-steps driven by `state.brainstorm.step`: scout → questions → approaches → design → done.
- Each sub-step: dispatch agent, parse output, present to user via `ctx.ui.*`, update state, save, continue to next step.
- For questions: present each question via `ctx.ui.select()` (choice) or `ctx.ui.input()` (open-ended). If user cancels (returns `undefined`), save state and return.
- For approaches: present via `ctx.ui.select()` with recommendation highlighted. Support "Other" option with `ctx.ui.input()`.
- For design: present each section content via `ctx.ui.notify()` + `ctx.ui.confirm()`. If rejected, collect feedback via `ctx.ui.input()`, dispatch revision, replace section.
- On completion: assemble markdown from sections, write to `docs/plans/YYYY-MM-DD-<slug>-design.md`, set `state.designPath`, `state.designContent`, advance to `plan-write`.
- Build prompts using new prompt builder functions (to be added in this file or prompt-builder.ts).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/phases/brainstorm.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/phases/brainstorm.ts src/workflow/phases/brainstorm.test.ts
git commit -m "feat: implement brainstorm phase with interactive design refinement"
```

---

## Task 8: Plan-write phase

Create `src/workflow/phases/plan-write.ts` to replace the old `plan.ts`. Dispatches the dedicated `planner` agent (not implementer) with the approved design document and scout output. Parses the `superteam-tasks` block from the written plan file.

**Files:**
- Create: `src/workflow/phases/plan-write.ts`
- Remove: `src/workflow/phases/plan.ts` (replaced)
- Test: `src/workflow/phases/plan-write.test.ts`

**Step 1: Write the failing test**

```typescript
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

function makeDispatchResult(): DispatchResult {
  return { agent: "test", agentSource: "package", task: "", exitCode: 0, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.2, contextTokens: 0, turns: 0 } };
}

function makeState(overrides: any = {}): any {
  return {
    phase: "plan-write",
    brainstorm: { step: "done", scoutOutput: "scout data" },
    config: {},
    userDescription: "Add auth",
    designPath: "docs/plans/2026-02-07-add-auth-design.md",
    designContent: "# Design\nArchitecture...",
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
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async (agent, task) => {
      if (agent.name === "planner") {
        const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
        if (pathMatch) {
          const fullPath = path.join(tmpDir, pathMatch[0]);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "```superteam-tasks\n- title: Task1\n  description: Desc\n  files: [a.ts]\n```");
        }
      }
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState();
    await runPlanWritePhase(state, ctx);

    const plannerCall = mockDispatchAgent.mock.calls[0];
    expect(plannerCall[0].name).toBe("planner");
  });

  it("includes design content in planner prompt", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async (agent, task) => {
      if (agent.name === "planner") {
        const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
        if (pathMatch) {
          const fullPath = path.join(tmpDir, pathMatch[0]);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```");
        }
      }
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({ designContent: "# My Custom Design" });
    await runPlanWritePhase(state, ctx);

    const prompt = mockDispatchAgent.mock.calls[0][1];
    expect(prompt).toContain("My Custom Design");
  });

  it("advances to plan-review on success", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async (agent, task) => {
      if (agent.name === "planner") {
        const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
        if (pathMatch) {
          const fullPath = path.join(tmpDir, pathMatch[0]);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "```superteam-tasks\n- title: Task\n  description: Desc\n  files: [a.ts]\n```");
        }
      }
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState();
    const result = await runPlanWritePhase(state, ctx);

    expect(result.phase).toBe("plan-review");
    expect(result.tasks).toHaveLength(1);
    expect(result.planPath).toBeDefined();
    expect(result.planContent).toBeTruthy();
  });

  it("sets error when planner agent not found", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn() } } as any;
    mockDiscoverAgents.mockReturnValue({ agents: [], projectAgentsDir: null });

    const state = makeState();
    const result = await runPlanWritePhase(state, ctx);

    expect(result.error).toContain("planner");
  });

  it("accumulates cost from dispatch", async () => {
    const { runPlanWritePhase } = await import("./plan-write.js");
    const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn() } } as any;

    mockDispatchAgent.mockImplementation(async (agent, task) => {
      if (agent.name === "planner") {
        const pathMatch = task.match(/docs\/plans\/[^\s]+\.md/);
        if (pathMatch) {
          const fullPath = path.join(tmpDir, pathMatch[0]);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```");
        }
      }
      return makeDispatchResult();
    });
    mockGetFinalOutput.mockReturnValue("output");

    const state = makeState({ totalCostUsd: 1.0 });
    const result = await runPlanWritePhase(state, ctx);

    expect(result.totalCostUsd).toBeGreaterThan(1.0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/plan-write.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement plan-write.ts**

Create `src/workflow/phases/plan-write.ts`:
- `runPlanWritePhase(state, ctx, signal?): Promise<OrchestratorState>`
- Discover agents, find `planner` (not `implementer`).
- Build prompt with design content, scout output, user description, and plan file path.
- Dispatch planner agent.
- Read plan file from disk, parse `superteam-tasks` block.
- Retry once if no tasks parsed.
- Convert parsed tasks to `TaskExecState[]`, set `planPath`, `planContent`, advance to `plan-review`.

Delete `src/workflow/phases/plan.ts` (the old plan-draft phase).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/phases/plan-write.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/phases/plan-write.ts src/workflow/phases/plan-write.test.ts
git rm src/workflow/phases/plan.ts
git commit -m "feat: replace plan-draft with plan-write phase using dedicated planner agent"
```

---

## Task 9: Update plan-review to include design context

Update `src/workflow/phases/plan-review.ts` to pass the design document as additional context to reviewers, and use `ctx.ui.*` for plan approval instead of `pendingInteraction`.

**Files:**
- Modify: `src/workflow/phases/plan-review.ts`
- Modify: `src/workflow/prompt-builder.ts` (update `buildPlanReviewPrompt` signature)
- Test: `src/workflow/phases/plan-review.test.ts`

**Step 1: Write the failing test**

Add tests to the existing `plan-review.test.ts`:

```typescript
// Add to plan-review.test.ts

it("passes design content to review prompts", async () => {
  // Set up state with designContent
  const state = makeState({
    designContent: "# Design\nThe system uses Passport.js...",
    planContent: "# Plan\n...",
    tasks: [makeTask()],
  });

  // ...dispatch mocks that pass all reviews...
  // ...mock ctx.ui.select to approve...

  const result = await runPlanReviewPhase(state, ctx);

  const reviewPrompt = mockDispatchAgent.mock.calls[0][1];
  expect(reviewPrompt).toContain("Passport.js");
});

it("uses ctx.ui.select for plan approval instead of pendingInteraction", async () => {
  // Set up state, mock reviews to pass
  // Assert ctx.ui.select was called
  // Assert no pendingInteraction on returned state

  const state = makeState({ ... });
  ctx.ui.select.mockResolvedValue("Approve");

  const result = await runPlanReviewPhase(state, ctx);

  expect(ctx.ui.select).toHaveBeenCalled();
  expect(result.pendingInteraction).toBeUndefined();
  expect(result.phase).toBe("configure");
});

it("handles user selecting Revise with feedback", async () => {
  const state = makeState({ ... });
  ctx.ui.select.mockResolvedValue("Revise");
  ctx.ui.editor.mockResolvedValue("Add more error handling tasks");

  // After revision, mock second review round passing
  // ...

  const result = await runPlanReviewPhase(state, ctx);
  // Verify revision dispatch happened
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/plan-review.test.ts`
Expected: FAIL — design content not included in prompts, `ctx.ui.select` not called.

**Step 3: Implement changes**

1. Update `buildPlanReviewPrompt` in `prompt-builder.ts` to accept an optional `designContent` parameter and include it in the prompt.
2. Update `plan-review.ts` to:
   - Pass `state.designContent` to `buildPlanReviewPrompt`.
   - After reviews pass, use `ctx.ui.select("Plan Approval", ["Approve", "Revise", "Abort"])` instead of setting `pendingInteraction`.
   - Handle "Revise": call `ctx.ui.editor()` for feedback, dispatch planner for revision.
   - Handle "Abort": set error and return.
   - Remove all `pendingInteraction` usage.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/phases/plan-review.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/phases/plan-review.ts src/workflow/prompt-builder.ts src/workflow/phases/plan-review.test.ts
git commit -m "feat: update plan-review to include design context and use ctx.ui for approval"
```

---

## Task 10: Update configure phase to use ctx.ui directly

Rewrite `src/workflow/phases/configure.ts` to use `ctx.ui.select()` and `ctx.ui.input()` directly instead of the `pendingInteraction` round-trip pattern.

**Files:**
- Modify: `src/workflow/phases/configure.ts`
- Test: `src/workflow/phases/configure.test.ts`

**Step 1: Write the failing test**

Rewrite configure tests to verify `ctx.ui.select` / `ctx.ui.input` calls:

```typescript
// Replace configure.test.ts

describe("runConfigurePhase (direct UI)", () => {
  it("calls ctx.ui.select for execution mode", async () => {
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Auto")       // execution mode
      .mockResolvedValueOnce("Iterative"); // review mode
    
    const state = makeState();
    const result = await runConfigurePhase(state, ctx);
    
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    expect(result.config.executionMode).toBe("auto");
    expect(result.config.reviewMode).toBe("iterative");
    expect(result.phase).toBe("execute");
  });

  it("asks for batch size when batch mode selected", async () => {
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

  it("saves state and returns when user cancels", async () => {
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(undefined); // user pressed Escape
    
    const state = makeState();
    const result = await runConfigurePhase(state, ctx);
    
    // Should not advance phase
    expect(result.phase).toBe("configure");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/configure.test.ts`
Expected: FAIL — current implementation uses `pendingInteraction`, not `ctx.ui.select`.

**Step 3: Rewrite configure.ts**

Replace the entire `runConfigurePhase` to use direct `ctx.ui.*` calls:
1. `ctx.ui.select("Execution Mode", ["Auto", "Checkpoint", "Batch"])` → set `config.executionMode`.
2. `ctx.ui.select("Review Mode", ["Iterative", "Single-pass"])` → set `config.reviewMode`.
3. If batch: `ctx.ui.input("Batch Size", "3")` → set `config.batchSize`.
4. If any dialog returns `undefined` (cancelled), save state and return without advancing.
5. Set defaults, advance to `execute`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/phases/configure.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/phases/configure.ts src/workflow/phases/configure.test.ts
git commit -m "feat: rewrite configure phase to use ctx.ui directly"
```

---

## Task 11: Update execute phase for streaming activity and ctx.ui escalation

Update `src/workflow/phases/execute.ts` to use `ctx.ui.select()` for task escalation (instead of `pendingInteraction`), pass `onStreamEvent` to agent dispatches for the activity widget, and update the progress widget after each task.

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Test: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing test**

Add new tests and update existing ones:

```typescript
// Add to execute.test.ts

it("calls ctx.ui.select for task escalation instead of pendingInteraction", async () => {
  const ctx = makeCtx();
  // Mock implementer to fail
  mockDispatchAgent.mockResolvedValue({ ...makeDispatchResult(), exitCode: 1, errorMessage: "failed" });
  ctx.ui.select.mockResolvedValue("Skip");

  const state = makeState({ tasks: [makeTask()] });
  const result = await runExecutePhase(state, ctx);

  expect(ctx.ui.select).toHaveBeenCalled();
  const selectCall = ctx.ui.select.mock.calls[0];
  expect(selectCall[1]).toEqual(expect.arrayContaining(["Retry", "Skip", "Abort"]));
  expect(result.tasks[0].status).toBe("skipped");
});

it("updates status bar during execution", async () => {
  const ctx = makeCtx();
  // Mock successful implementation + reviews pass
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');

  const state = makeState({ tasks: [makeTask()] });
  await runExecutePhase(state, ctx);

  expect(ctx.ui.setStatus).toHaveBeenCalled();
});

it("calls ctx.ui.select with Abort option and aborts workflow", async () => {
  const ctx = makeCtx();
  mockDispatchAgent.mockResolvedValue({ ...makeDispatchResult(), exitCode: 1, errorMessage: "fail" });
  ctx.ui.select.mockResolvedValue("Abort");

  const state = makeState({ tasks: [makeTask()] });
  const result = await runExecutePhase(state, ctx);

  expect(result.phase).toBe("done");
  expect(result.error).toContain("Abort");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: FAIL — current implementation uses `pendingInteraction` for escalation.

**Step 3: Implement changes**

In `execute.ts`:
1. Accept `ctx: ExtensionContext` (require UI access).
2. Replace all `pendingInteraction = confirmTaskEscalation(...)` with `const action = await ctx.ui.select("Task Escalation", ["Retry", "Skip", "Abort"])`.
3. Handle response inline: Retry → loop, Skip → `task.status = "skipped"`, Abort → set error + return.
4. Add `onStreamEvent` callback to `dispatchAgent` calls that updates activity widget via `updateActivityWidget(ctx, agent, recentActions)`.
5. Call `ctx.ui.setStatus("workflow", formatStatus(state))` at the start of each task.
6. Call `ctx.ui.setWidget("workflow-progress", formatTaskProgress(...))` after each task completes.
7. Remove `userInput` parameter (no longer needed — interaction is direct).

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat: update execute phase with streaming activity widget and direct UI escalation"
```

---

## Task 12: Rewrite orchestrator entry point and /workflow command

Rewrite `src/workflow/orchestrator.ts` with the new `runWorkflowLoop` that drives all phases with direct UI interaction. Rewrite the `/workflow` command in `src/index.ts` to call `runWorkflowLoop` directly (not through the tool). Simplify the `workflow` tool to be secondary.

**Files:**
- Modify: `src/workflow/orchestrator.ts`
- Modify: `src/index.ts`
- Modify: `src/workflow/interaction.ts` (simplify — remove `pendingInteraction` helpers)
- Test: `src/workflow/orchestrator.test.ts`

**Step 1: Write the failing test**

```typescript
// Rewrite orchestrator.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

import { loadState, saveState, clearState, createInitialState } from "./orchestrator-state.ts";
import { runBrainstormPhase } from "./phases/brainstorm.ts";
import { runPlanWritePhase } from "./phases/plan-write.ts";
import { runConfigurePhase } from "./phases/configure.ts";
import { runExecutePhase } from "./phases/execute.ts";
import { runFinalizePhase } from "./phases/finalize.ts";
import { writeProgressFile } from "./progress.ts";

const mockLoadState = vi.mocked(loadState);
const mockSaveState = vi.mocked(saveState);
const mockBrainstorm = vi.mocked(runBrainstormPhase);
const mockPlanWrite = vi.mocked(runPlanWritePhase);
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

  it("chains phases: brainstorm → plan-write → plan-review → configure → execute → finalize", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = createInitialState("Build auth");

    // Each phase advances to the next
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "plan-write"; return s; });
    mockPlanWrite.mockImplementation(async (s) => { s.phase = "plan-review"; return s; });
    // plan-review mock would need to be imported...
    // Just test that phases chain correctly by having brainstorm → plan-write → done
    mockPlanWrite.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(mockBrainstorm).toHaveBeenCalled();
    expect(mockPlanWrite).toHaveBeenCalled();
  });

  it("saves state and writes progress after each phase", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = createInitialState("test");
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(mockSaveState).toHaveBeenCalled();
    expect(mockWriteProgress).toHaveBeenCalled();
  });

  it("stops on error and notifies user", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = createInitialState("test");
    mockBrainstorm.mockImplementation(async (s) => { s.error = "Agent failed"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Agent failed"), "warning");
  });

  it("clears status and widget when done", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = createInitialState("test");
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("workflow", undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-progress", undefined);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/orchestrator.test.ts`
Expected: FAIL — `runWorkflowLoop` doesn't exist.

**Step 3: Implement orchestrator rewrite**

In `src/workflow/orchestrator.ts`:
1. Export `runWorkflowLoop(state, ctx, signal?)` that drives the phase loop with `while (state.phase !== "done")`.
2. Each iteration: update status, switch on phase, call phase function, save state, write progress file, check for error.
3. On error: `ctx.ui.notify(state.error, "warning")`, break loop.
4. On done: clear status/widget, notify completion.
5. Keep `runOrchestrator` as a wrapper for the tool path (loads/creates state, calls `runWorkflowLoop`).

In `src/index.ts`:
1. Rewrite `/workflow` command handler to:
   - Handle `status`/`abort` subcommands.
   - Load existing state or prompt for description via `ctx.ui.input()`.
   - If state exists and user provides new description, ask `ctx.ui.confirm()` to replace.
   - Call `runWorkflowLoop(state, ctx)` directly.
2. Keep the `workflow` tool as secondary interface.

In `src/workflow/interaction.ts`:
1. Remove `pendingInteraction`-related helpers (`askReviewMode`, `askExecutionMode`, `askBatchSize`, `confirmPlanApproval`, `confirmTaskEscalation`).
2. Keep `formatInteractionForAgent` and `parseUserResponse` for the tool path.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/orchestrator.test.ts`
Expected: PASS

**Step 5: Verify all existing tests still pass**

Run: `npx vitest run`
Expected: All tests pass (some tests for old plan.ts removed, replaced by plan-write tests).

**Step 6: Commit**

```bash
git add src/workflow/orchestrator.ts src/index.ts src/workflow/interaction.ts src/workflow/orchestrator.test.ts
git commit -m "feat: rewrite orchestrator with runWorkflowLoop and direct /workflow command"
```

---

## Task 13: Documentation update

Update README, create workflow guide, update agents guide, and add CHANGELOG entry documenting the redesign.

**Files:**
- Modify: `README.md`
- Create: `docs/workflow-guide.md`
- Modify: `docs/agents.md` (if it exists, otherwise create)
- Modify: `CHANGELOG.md` (if it exists, otherwise create)

**Step 1: Write the failing test**

```typescript
// docs/docs.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

describe("documentation completeness", () => {
  it("README mentions brainstorm phase", () => {
    const readme = fs.readFileSync("README.md", "utf-8");
    expect(readme).toContain("brainstorm");
  });

  it("workflow guide exists and covers all phases", () => {
    const guide = fs.readFileSync("docs/workflow-guide.md", "utf-8");
    expect(guide).toContain("Brainstorm");
    expect(guide).toContain("Plan");
    expect(guide).toContain("Review");
    expect(guide).toContain("Configure");
    expect(guide).toContain("Execute");
    expect(guide).toContain("Finalize");
  });

  it("workflow guide documents brainstormer and planner agents", () => {
    const guide = fs.readFileSync("docs/workflow-guide.md", "utf-8");
    expect(guide).toContain("brainstormer");
    expect(guide).toContain("planner");
  });

  it("workflow guide documents /workflow command", () => {
    const guide = fs.readFileSync("docs/workflow-guide.md", "utf-8");
    expect(guide).toContain("/workflow");
    expect(guide).toContain("status");
    expect(guide).toContain("abort");
  });

  it("workflow guide documents progress file", () => {
    const guide = fs.readFileSync("docs/workflow-guide.md", "utf-8");
    expect(guide).toContain("progress");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run docs/docs.test.ts`
Expected: FAIL — docs don't exist or don't mention brainstorm.

**Step 3: Write documentation**

1. **README.md**: Add/update the workflow section to describe the full brainstorm → plan → review → configure → execute → finalize pipeline. Mention `/workflow` command, new agent profiles.

2. **docs/workflow-guide.md**: Comprehensive guide covering:
   - Overview of the workflow pipeline
   - Each phase explained with UI screenshots/examples
   - Agent roster (brainstormer, planner, scout, implementer, reviewers)
   - Progress file format and location
   - Configuration options
   - Error handling and recovery
   - `/workflow` command usage (start, resume, status, abort)
   - Streaming activity widget

3. **CHANGELOG.md**: Add entry for the redesign.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run docs/docs.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add README.md docs/workflow-guide.md CHANGELOG.md docs/docs.test.ts
git commit -m "docs: add workflow guide, update README for orchestrator redesign"
```

---

## Dependency Graph

```
Task 1 (agent profiles)          — no deps
Task 2 (stream callback)         — no deps
Task 3 (brainstorm parser)       — no deps
Task 4 (progress file)           — no deps
Task 5 (UI helpers)              — no deps
Task 6 (state model)             — no deps
Task 7 (brainstorm phase)        — depends on 1, 3, 5, 6
Task 8 (plan-write phase)        — depends on 1, 6
Task 9 (plan-review update)      — depends on 6
Task 10 (configure update)       — depends on 6
Task 11 (execute update)         — depends on 2, 5, 6
Task 12 (orchestrator rewrite)   — depends on 7, 8, 9, 10, 11
Task 13 (docs)                   — depends on 12
```

Tasks 1-6 can be done in any order (or in parallel). Tasks 7-11 depend on the foundation tasks. Task 12 integrates everything. Task 13 documents the result.

---

```superteam-tasks
- title: Create brainstormer and planner agent profiles
  description: Create agents/brainstormer.md (read-only, superteam-brainstorm JSON output) and agents/planner.md (writes plan files, superteam-tasks YAML). Test via discoverAgents integration test.
  files: [agents/brainstormer.md, agents/planner.md, agents/agents.test.ts]
- title: Add streaming event callback to dispatch.ts
  description: Export StreamEvent type and OnStreamEvent callback. Add optional onStreamEvent parameter to runAgent and dispatchAgent. Parse tool_execution_start/update/end events in processLine and fire callback.
  files: [src/dispatch.ts, src/dispatch-stream.test.ts]
- title: Brainstorm output parser
  description: Create brainstorm-parser.ts that extracts superteam-brainstorm fenced blocks. Supports questions, approaches, and design response types. Fallback to last JSON brace block. Same pattern as review-parser.ts.
  files: [src/workflow/brainstorm-parser.ts, src/workflow/brainstorm-parser.test.ts]
- title: Progress file generator
  description: Create progress.ts with generateProgressMarkdown (pure function, state → markdown) and writeProgressFile (derives path from designPath/planPath, writes to disk). Sections for brainstorm, plan, config, tasks, log.
  files: [src/workflow/progress.ts, src/workflow/progress.test.ts]
- title: UI helper functions
  description: Create ui.ts with formatStatus (footer one-liner), formatToolAction (human-readable tool action from stream event), formatTaskProgress (widget lines), updateActivityWidget, updateStatusBar.
  files: [src/workflow/ui.ts, src/workflow/ui.test.ts]
- title: Updated state model
  description: Add BrainstormState, BrainstormStep, BrainstormQuestion, BrainstormApproach, DesignSection types. Add brainstorm, designPath, designContent fields. Replace plan-draft with brainstorm/plan-write phases. Remove pendingInteraction.
  files: [src/workflow/orchestrator-state.ts, src/workflow/orchestrator-state.test.ts]
- title: Brainstorm phase
  description: Implement full brainstorm flow (scout → questions → approaches → design sections → save design). Uses ctx.ui.* for interaction, dispatchAgent for creative work, parseBrainstormOutput for structured parsing. Writes design file to docs/plans/.
  files: [src/workflow/phases/brainstorm.ts, src/workflow/phases/brainstorm.test.ts, src/workflow/prompt-builder.ts]
- title: Plan-write phase
  description: Replace old plan.ts with plan-write.ts. Dispatches planner agent (not implementer) with design content + scout output. Parses superteam-tasks from written plan file. Delete old plan.ts.
  files: [src/workflow/phases/plan-write.ts, src/workflow/phases/plan-write.test.ts]
- title: Update plan-review with design context
  description: Pass design document as additional reviewer context in buildPlanReviewPrompt. Use ctx.ui.select for plan approval (Approve/Revise/Abort) instead of pendingInteraction. Handle Revise with ctx.ui.editor feedback.
  files: [src/workflow/phases/plan-review.ts, src/workflow/prompt-builder.ts, src/workflow/phases/plan-review.test.ts]
- title: Update configure phase to use ctx.ui directly
  description: Rewrite runConfigurePhase to call ctx.ui.select for execution mode and review mode, ctx.ui.input for batch size. Remove pendingInteraction pattern. Handle cancellation by saving state without advancing.
  files: [src/workflow/phases/configure.ts, src/workflow/phases/configure.test.ts]
- title: Update execute phase for streaming activity and ctx.ui escalation
  description: Replace pendingInteraction escalation with ctx.ui.select (Retry/Skip/Abort). Pass onStreamEvent to dispatchAgent for activity widget. Update status bar and progress widget after each task.
  files: [src/workflow/phases/execute.ts, src/workflow/phases/execute.test.ts]
- title: Rewrite orchestrator entry point and /workflow command
  description: Export runWorkflowLoop driving all phases with direct UI. Rewrite /workflow command to load/create state and call runWorkflowLoop. Simplify interaction.ts by removing pendingInteraction helpers. Keep workflow tool as secondary interface.
  files: [src/workflow/orchestrator.ts, src/index.ts, src/workflow/interaction.ts, src/workflow/orchestrator.test.ts]
- title: Documentation update
  description: Update README with brainstorm pipeline. Create docs/workflow-guide.md covering all phases, agents, progress file, /workflow command, streaming widget. Add CHANGELOG entry.
  files: [README.md, docs/workflow-guide.md, CHANGELOG.md, docs/docs.test.ts]
```
