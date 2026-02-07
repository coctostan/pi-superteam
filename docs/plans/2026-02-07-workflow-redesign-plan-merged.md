# Workflow Orchestrator Redesign — TDD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the workflow orchestrator to emulate superpowers' full development pipeline (brainstorm → plan-write → plan-review → configure → execute → finalize) while keeping *all* flow control in deterministic TypeScript. LLMs are dispatched as isolated subagents for creative work only. The primary UI is the `/workflow` command using `ctx.ui.*` dialogs.

**Architecture:**
- Deterministic workflow loop in TypeScript (`runWorkflowLoop`) drives phase transitions.
- Creative steps (scout/brainstorm/design/plan writing/reviews/implementation) are *subagent dispatches*.
- All subagent outputs that affect control flow are **structured** (`superteam-brainstorm`, `superteam-json`, `superteam-tasks`). Parsing failures trigger retries, never "best guesses".
- State is persisted to `.superteam-workflow.json` after every step and is resumable.
- A human-readable progress file is maintained alongside plan/design docs.

**Tech Stack:** TypeScript (ESM, runtime loaded via jiti), vitest, pi extension API (`ctx.ui.select/confirm/input/editor/notify/setStatus/setWidget`), pi JSON stream events (`tool_execution_*`).

**Design doc (spec):** `docs/plans/2026-02-07-workflow-redesign-design.md`

---

## Constraints / Non-negotiables

1. **No build step:** pi loads TS directly via jiti.
2. **ESM import specifiers in `src/` must use `.js` extensions.** (Tests can import `.ts` for mocking, matching the existing test style in this repo.)
3. **Tests must not spawn subprocesses.**
   - Phase tests **must mock** `dispatchAgent` (and `dispatchParallel` where relevant).
   - Dispatch streaming tests may mock `child_process.spawn` (still no real subprocess).
4. **Tests should verify behavior, not implementation.**
   - Verify state transitions, UI calls, prompts passed to dispatch, parse/error handling.
   - Don't assert on internal helper functions beyond their public outputs.
5. **vi.mock paths must use `.js` extensions** to match the ESM import specifiers used in source files. When importing mocked modules in test code, `.ts` extensions are acceptable.

---

## Task 1: Add brainstormer + planner agent profiles

**Why:** The redesign needs two new roles:
- `brainstormer` (read-only) to produce structured brainstorm output.
- `planner` (read + write, no bash/edit) to write plan files.

**Files:**
- Create: `agents/brainstormer.md`
- Create: `agents/planner.md`
- Test (modify): `src/dispatch.test.ts`

### Step 1: Write the failing test (RED)

Add a new `describe` block in `src/dispatch.test.ts`:

```typescript
describe("new agent profiles", () => {
  it("brainstormer agent exists with read-only tools", () => {
    const { agents } = discoverAgents(process.cwd(), false);
    const brainstormer = agents.find(a => a.name === "brainstormer");
    expect(brainstormer).toBeDefined();
    expect(brainstormer!.tools).toEqual(expect.arrayContaining(["read", "find", "grep", "ls"]));
    expect(brainstormer!.tools).not.toContain("write");
    expect(brainstormer!.tools).not.toContain("edit");
    expect(brainstormer!.tools).not.toContain("bash");
    expect(brainstormer!.systemPrompt).toContain("superteam-brainstorm");
  });

  it("planner agent exists with write but no bash/edit", () => {
    const { agents } = discoverAgents(process.cwd(), false);
    const planner = agents.find(a => a.name === "planner");
    expect(planner).toBeDefined();
    expect(planner!.tools).toEqual(expect.arrayContaining(["read", "write", "find", "grep", "ls"]));
    expect(planner!.tools).not.toContain("bash");
    expect(planner!.tools).not.toContain("edit");
    expect(planner!.systemPrompt).toContain("superteam-tasks");
  });
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/dispatch.test.ts`
Expected: FAIL — agents not found.

### Step 3: Implement agent profiles (GREEN)

Create `agents/brainstormer.md`:
- Frontmatter: `name: brainstormer`, `description: Generate structured brainstorm outputs (questions/approaches/design sections)`, `tools: read,find,grep,ls`
- System prompt instructs: always end with a fenced ` ```superteam-brainstorm` JSON block containing structured output. Must support `type: "questions"`, `type: "approaches"`, and `type: "design"` response formats per the design doc.

Create `agents/planner.md`:
- Frontmatter: `name: planner`, `description: Write detailed TDD implementation plans to a specified file path`, `tools: read,write,find,grep,ls`
- System prompt instructs: write the plan file to the path provided in the task. Include a fenced ` ```superteam-tasks` YAML block. Write bite-sized TDD steps (2-5 min each). Exact file paths, complete test code, exact verification commands.

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/dispatch.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add agents/brainstormer.md agents/planner.md src/dispatch.test.ts
git commit -m "feat(agents): add brainstormer and planner profiles"
```

---

## Task 2: Add `onStreamEvent` callback to `dispatchAgent()` / `runAgent()`

**Why:** The orchestrator needs real-time visibility into tool activity (status bar + activity widget) while subagents run.

**Files:**
- Modify: `src/dispatch.ts`
- Test (create): `src/dispatch-stream-events.test.ts`

### Step 1: Write the failing test (RED)

Create `src/dispatch-stream-events.test.ts` that mocks `child_process.spawn` to simulate JSON line output:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// Mock child_process.spawn to emit controlled JSON lines
vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from "node:child_process";
import type { StreamEvent, OnStreamEvent } from "./dispatch.js";

const mockSpawn = vi.mocked(spawn);

function createFakeProcess(jsonLines: string[]) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: null,
    pid: 1234,
    killed: false,
    kill: vi.fn(),
  });

  // Emit lines async so dispatch can set up listeners first
  setTimeout(() => {
    for (const line of jsonLines) {
      stdout.push(line + "\n");
    }
    stdout.push(null);
    proc.emit("close", 0);
  }, 10);

  return proc;
}

describe("onStreamEvent callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires for tool_execution_start events with toolName and args", async () => {
    const events: StreamEvent[] = [];
    const onStreamEvent: OnStreamEvent = (e) => events.push(e);

    const jsonLines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: { path: "src/index.ts" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "tc1", toolName: "read", result: "file contents", isError: false }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 10, output: 5, cost: { total: 0.01 } } } }),
    ];

    mockSpawn.mockReturnValue(createFakeProcess(jsonLines) as any);

    const { dispatchAgent } = await import("./dispatch.js");
    // dispatchAgent needs an agent profile — minimal stub
    const agent = { name: "test", description: "test", systemPrompt: "", source: "package" as const, filePath: "/test.md", tools: ["read"] };
    await dispatchAgent(agent, "test task", "/tmp", undefined, undefined, onStreamEvent);

    const starts = events.filter(e => e.type === "tool_execution_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].toolName).toBe("read");
    expect(starts[0].args).toEqual({ path: "src/index.ts" });

    const ends = events.filter(e => e.type === "tool_execution_end");
    expect(ends).toHaveLength(1);
    expect(ends[0].isError).toBe(false);
  });

  it("fires for tool_execution_update events with partial results", async () => {
    const events: StreamEvent[] = [];

    const jsonLines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "npm test" } }),
      JSON.stringify({ type: "tool_execution_update", toolCallId: "tc1", toolName: "bash", args: { command: "npm test" }, partialResult: "PASS 3/3" }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "PASS", isError: false }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 10, output: 5, cost: { total: 0.01 } } } }),
    ];

    mockSpawn.mockReturnValue(createFakeProcess(jsonLines) as any);

    const { dispatchAgent } = await import("./dispatch.js");
    const agent = { name: "test", description: "test", systemPrompt: "", source: "package" as const, filePath: "/test.md", tools: ["bash"] };
    await dispatchAgent(agent, "test", "/tmp", undefined, undefined, (e) => events.push(e));

    const updates = events.filter(e => e.type === "tool_execution_update");
    expect(updates).toHaveLength(1);
    expect(updates[0].partialResult).toBe("PASS 3/3");
  });

  it("StreamEvent type exports compile correctly", async () => {
    const start: StreamEvent = { type: "tool_execution_start", toolName: "read", args: { path: "x" } };
    const update: StreamEvent = { type: "tool_execution_update", toolName: "bash", partialResult: "partial" };
    const end: StreamEvent = { type: "tool_execution_end", toolName: "write", isError: false };
    expect(start.type).toBe("tool_execution_start");
    expect(update.type).toBe("tool_execution_update");
    expect(end.type).toBe("tool_execution_end");
  });
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/dispatch-stream-events.test.ts`
Expected: FAIL — `StreamEvent` and `OnStreamEvent` not exported, callback not wired.

### Step 3: Implement streaming callback (GREEN)

In `src/dispatch.ts`:
1. Export types:
   ```typescript
   export type StreamEvent = {
     type: string;
     toolCallId?: string;
     toolName?: string;
     args?: Record<string, any>;
     partialResult?: any;
     result?: any;
     isError?: boolean;
   };
   export type OnStreamEvent = (event: StreamEvent) => void;
   ```
2. Add optional `onStreamEvent?: OnStreamEvent` parameter to `runAgent` (after `onResultUpdate`).
3. In `processLine()`, when `event.type` is `tool_execution_start`, `tool_execution_update`, or `tool_execution_end`, call `onStreamEvent?.({ type, toolCallId, toolName, args, partialResult, result, isError })`.
4. Add optional `onStreamEvent?: OnStreamEvent` parameter to `dispatchAgent` and thread through to `runAgent`.
5. Keep parameter optional so all existing callers remain valid.

### Step 4: Run tests (GREEN)
Run:
- `npx vitest run src/dispatch-stream-events.test.ts`
- `npx vitest run src/dispatch.test.ts` (existing tests still pass)
Expected: PASS.

### Step 5: Commit
```bash
git add src/dispatch.ts src/dispatch-stream-events.test.ts
git commit -m "feat(dispatch): stream tool_execution events via onStreamEvent callback"
```

---

## Task 3: Brainstorm output parser

**Why:** The brainstorm phase must parse brainstormer outputs deterministically. Parsing failures trigger retries, never guesses.

**Files:**
- Create: `src/workflow/brainstorm-parser.ts`
- Test (create): `src/workflow/brainstorm-parser.test.ts`

### Step 1: Write the failing test (RED)

```typescript
// src/workflow/brainstorm-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseBrainstormOutput } from "./brainstorm-parser.js";

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

  it("parses design response with sections", () => {
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

  it("returns error when no fenced block found and no fallback JSON", () => {
    const result = parseBrainstormOutput("No structured output here");
    expect(result.status).toBe("error");
  });

  it("returns error for malformed JSON in fenced block", () => {
    const result = parseBrainstormOutput("```superteam-brainstorm\n{bad json\n```");
    expect(result.status).toBe("error");
  });

  it("returns error when type field is missing", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({ noType: true })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("error");
  });

  it("returns error for unknown type value", () => {
    const raw = `\`\`\`superteam-brainstorm\n${JSON.stringify({ type: "unknown_thing" })}\n\`\`\``;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("error");
  });

  it("falls back to last JSON brace block when no fenced block", () => {
    const raw = `Text before ${JSON.stringify({
      type: "questions",
      questions: [{ id: "q1", text: "Q?", type: "input" }],
    })} text after`;
    const result = parseBrainstormOutput(raw);
    expect(result.status).toBe("ok");
  });
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/brainstorm-parser.test.ts`
Expected: FAIL — module doesn't exist.

### Step 3: Implement brainstorm-parser.ts (GREEN)

Create `src/workflow/brainstorm-parser.ts`:
- Export types: `BrainstormQuestion`, `BrainstormApproach`, `DesignSection`, `BrainstormPayload` (union of `QuestionsPayload | ApproachesPayload | DesignPayload`), `BrainstormParseResult`.
- Export `parseBrainstormOutput(rawOutput: string): BrainstormParseResult`.
- Extract `superteam-brainstorm` fenced block via regex. Fallback: extract last `{...}` brace-matched JSON (same algorithm as `src/review-parser.ts`).
- Parse JSON, validate `type` is one of `"questions"`, `"approaches"`, `"design"`.
- Validate child arrays exist and normalize with sensible defaults.
- Return `{ status: "ok", data }` or `{ status: "error", rawOutput, parseError }`. Never throw.

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/brainstorm-parser.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/brainstorm-parser.ts src/workflow/brainstorm-parser.test.ts
git commit -m "feat(workflow): add brainstorm output parser for superteam-brainstorm blocks"
```

---

## Task 4: Progress file generator

**Why:** Users need a persistent, human-readable progress tracker that survives crashes and can be viewed outside pi.

**Files:**
- Create: `src/workflow/progress.ts`
- Test (create): `src/workflow/progress.test.ts`

### Step 1: Write the failing test (RED)

```typescript
// src/workflow/progress.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("renderProgressMarkdown", () => {
  it("includes workflow title and phase status", async () => {
    const { renderProgressMarkdown } = await import("./progress.js");
    const state = makeState({ phase: "brainstorm", userDescription: "Add auth" });
    const md = renderProgressMarkdown(state);
    expect(md).toContain("# Workflow: Add auth");
    expect(md).toContain("Brainstorm");
  });

  it("includes brainstorm checklist with completed and pending items", async () => {
    const { renderProgressMarkdown } = await import("./progress.js");
    const state = makeState({
      phase: "brainstorm",
      brainstorm: { step: "questions", scoutOutput: "scout data" },
    });
    const md = renderProgressMarkdown(state);
    expect(md).toContain("[x] Scout codebase");
    expect(md).toContain("[ ] Requirements");
  });

  it("includes task list with status markers", async () => {
    const { renderProgressMarkdown } = await import("./progress.js");
    const state = makeState({
      phase: "execute",
      currentTaskIndex: 1,
      tasks: [
        { id: 1, title: "Create model", status: "complete" },
        { id: 2, title: "Add routes", status: "implementing" },
        { id: 3, title: "Add tests", status: "pending" },
      ],
    });
    const md = renderProgressMarkdown(state);
    expect(md).toContain("[x] 1. Create model");
    expect(md).toContain("[ ] 2. Add routes");
    expect(md).toMatch(/implementing/);
    expect(md).toContain("[ ] 3. Add tests");
  });

  it("includes cost in header", async () => {
    const { renderProgressMarkdown } = await import("./progress.js");
    const state = makeState({ totalCostUsd: 3.42 });
    const md = renderProgressMarkdown(state);
    expect(md).toContain("$3.42");
  });
});

describe("getProgressPath", () => {
  it("derives from designPath by replacing -design.md with -progress.md", async () => {
    const { getProgressPath } = await import("./progress.js");
    const state = makeState({ designPath: "docs/plans/2026-02-07-auth-design.md" });
    expect(getProgressPath(state)).toBe("docs/plans/2026-02-07-auth-progress.md");
  });

  it("derives from planPath when designPath is missing", async () => {
    const { getProgressPath } = await import("./progress.js");
    const state = makeState({ planPath: "docs/plans/2026-02-07-auth-plan.md" });
    expect(getProgressPath(state)).toBe("docs/plans/2026-02-07-auth-progress.md");
  });

  it("returns null when neither path is set", async () => {
    const { getProgressPath } = await import("./progress.js");
    const state = makeState({});
    expect(getProgressPath(state)).toBeNull();
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

  it("writes progress file to derived path and creates dirs", async () => {
    const { writeProgressFile } = await import("./progress.js");
    const state = makeState({
      userDescription: "Add auth",
      designPath: "docs/plans/2026-02-07-add-auth-design.md",
    });
    writeProgressFile(state, tmpDir);
    const progressPath = path.join(tmpDir, "docs/plans/2026-02-07-add-auth-progress.md");
    expect(fs.existsSync(progressPath)).toBe(true);
    const content = fs.readFileSync(progressPath, "utf-8");
    expect(content).toContain("# Workflow: Add auth");
  });
});

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

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/progress.test.ts`
Expected: FAIL — module doesn't exist.

### Step 3: Implement progress.ts (GREEN)

Create `src/workflow/progress.ts`:
- `getProgressPath(state: OrchestratorState): string | null` — derives path from `designPath` (replace `-design.md` → `-progress.md`) or `planPath` (replace `-plan.md` → `-progress.md`).
- `renderProgressMarkdown(state: OrchestratorState): string` — pure function producing markdown with: title + status header, brainstorm checklist, plan checklist, config summary, task list, cost.
- `writeProgressFile(state: OrchestratorState, cwd: string): void` — calls `getProgressPath`, creates dirs, writes file. No-op if path is null.

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/progress.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/progress.ts src/workflow/progress.test.ts
git commit -m "feat(workflow): add progress.md file generator for human-readable tracking"
```

---

## Task 5: UI helper functions + simplify interaction.ts

**Why:** Keep UI formatting deterministic, reusable, testable. Clean up the old `pendingInteraction` builder helpers early so Tasks 7-11 don't accidentally use the old pattern.

**Files:**
- Create: `src/workflow/ui.ts`
- Modify: `src/workflow/interaction.ts`
- Test (create): `src/workflow/ui.test.ts`

### Step 1: Write the failing test (RED)

```typescript
// src/workflow/ui.test.ts
import { describe, it, expect } from "vitest";
import {
  formatStatus,
  formatToolAction,
  formatTaskProgress,
  createActivityBuffer,
} from "./ui.js";

describe("formatStatus", () => {
  it("formats brainstorm phase with sub-step and cost", () => {
    const state = { phase: "brainstorm", brainstorm: { step: "questions" }, totalCostUsd: 0.42, tasks: [], currentTaskIndex: 0 } as any;
    const status = formatStatus(state);
    expect(status).toContain("brainstorm");
    expect(status).toContain("questions");
    expect(status).toContain("$0.42");
  });

  it("formats execute phase with task progress", () => {
    const state = {
      phase: "execute",
      tasks: [{}, {}, { status: "implementing" }, {}, {}],
      currentTaskIndex: 2,
      totalCostUsd: 4.18,
    } as any;
    const status = formatStatus(state);
    expect(status).toContain("execute");
    expect(status).toContain("task 3/5");
    expect(status).toContain("$4.18");
  });
});

describe("formatToolAction", () => {
  it("formats read action with path", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
    expect(result).toContain("read");
    expect(result).toContain("src/index.ts");
  });

  it("formats bash action with command snippet", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "bash", args: { command: "vitest run auth" } });
    expect(result).toContain("vitest run auth");
  });

  it("formats write action with path", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "write", args: { path: "src/auth.ts" } });
    expect(result).toContain("write");
    expect(result).toContain("src/auth.ts");
  });

  it("formats edit action with path", () => {
    const result = formatToolAction({ type: "tool_execution_start", toolName: "edit", args: { path: "src/auth.ts" } });
    expect(result).toContain("edit");
    expect(result).toContain("src/auth.ts");
  });

  it("formats grep action with pattern", () => {
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
  it("generates widget lines with status markers", () => {
    const tasks = [
      { id: 1, title: "Create model", status: "complete" },
      { id: 2, title: "Add routes", status: "implementing" },
      { id: 3, title: "Add tests", status: "pending" },
    ] as any[];
    const lines = formatTaskProgress(tasks, 1);
    expect(lines.some((l: string) => l.includes("✓") && l.includes("Create model"))).toBe(true);
    expect(lines.some((l: string) => l.includes("▸") && l.includes("Add routes"))).toBe(true);
    expect(lines.some((l: string) => l.includes("○") && l.includes("Add tests"))).toBe(true);
  });
});

describe("createActivityBuffer", () => {
  it("maintains a ring buffer of max size", () => {
    const buffer = createActivityBuffer(3);
    buffer.push("line 1");
    buffer.push("line 2");
    buffer.push("line 3");
    buffer.push("line 4");
    expect(buffer.lines()).toEqual(["line 2", "line 3", "line 4"]);
  });

  it("returns all lines when under max", () => {
    const buffer = createActivityBuffer(5);
    buffer.push("a");
    buffer.push("b");
    expect(buffer.lines()).toEqual(["a", "b"]);
  });
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/ui.test.ts`
Expected: FAIL — module doesn't exist.

### Step 3: Implement UI helpers (GREEN)

Create `src/workflow/ui.ts` exporting:
- `formatStatus(state): string` — one-line footer (e.g., `⚡ Workflow: brainstorm (questions) | $0.42`)
- `formatToolAction(event: StreamEvent): string` — human-readable tool action
- `formatTaskProgress(tasks, currentIndex): string[]` — widget lines
- `createActivityBuffer(maxLines: number)` — ring buffer with `.push(line)` and `.lines()` methods

In `src/workflow/interaction.ts`:
- Remove the old `pendingInteraction` builder helpers (`askReviewMode`, `askExecutionMode`, `askBatchSize`, `confirmPlanApproval`, `confirmTaskEscalation`).
- Keep `formatInteractionForAgent` and `parseUserResponse` for the secondary tool path.
- Update `src/workflow/interaction.test.ts` to remove tests for deleted helpers.

### Step 4: Run tests (GREEN)
Run:
- `npx vitest run src/workflow/ui.test.ts`
- `npx vitest run src/workflow/interaction.test.ts` (updated, still passes)
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/ui.ts src/workflow/ui.test.ts src/workflow/interaction.ts src/workflow/interaction.test.ts
git commit -m "feat(workflow): add UI helpers, simplify interaction.ts (remove pendingInteraction builders)"
```

---

## Task 6: Update workflow state model for brainstorm pipeline

**Why:** New phases (`brainstorm`, `plan-write`), new fields (`designPath`, `designContent`, `BrainstormState`), and progress file integration.

**Files:**
- Modify: `src/workflow/orchestrator-state.ts`
- Test (modify): `src/workflow/orchestrator-state.test.ts`

### Step 1: Write the failing test (RED)

Add a new `describe` block in `src/workflow/orchestrator-state.test.ts`:

```typescript
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
    const bs: BrainstormState = { step: "scout" };
    expect(bs.step).toBe("scout");
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

  it("state round-trips through save/load with new fields", () => {
    const state = createInitialState("Build auth");
    state.brainstorm.scoutOutput = "scout data";
    state.brainstorm.step = "questions";
    state.designPath = "docs/plans/test-design.md";
    state.designContent = "# Design";
    saveState(state, tmpDir);
    const loaded = loadState(tmpDir);
    expect(loaded).toBeDefined();
    expect(loaded!.brainstorm.scoutOutput).toBe("scout data");
    expect(loaded!.designPath).toBe("docs/plans/test-design.md");
  });
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/orchestrator-state.test.ts`
Expected: FAIL — `BrainstormState` not exported, `createInitialState` returns `"plan-draft"` phase, no `brainstorm` field.

### Step 3: Implement state model changes (GREEN)

In `src/workflow/orchestrator-state.ts`:
1. Update `OrchestratorPhase` union: add `"brainstorm" | "plan-write"`, remove `"plan-draft"`.
2. Export new types: `BrainstormStep`, `BrainstormQuestion`, `BrainstormApproach`, `DesignSection`, `BrainstormState`.
3. Add fields to `OrchestratorState`: `brainstorm: BrainstormState`, `designPath?: string`, `designContent?: string`.
4. Remove `pendingInteraction` from `OrchestratorState`.
5. Update `createInitialState(description)`: set `phase: "brainstorm"`, `brainstorm: { step: "scout" }`.
6. In `saveState()`, after writing `.superteam-workflow.json`, call `writeProgressFile(state, cwd)` (import from `./progress.js`).

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/orchestrator-state.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/orchestrator-state.ts src/workflow/orchestrator-state.test.ts
git commit -m "feat(workflow): extend state model with brainstorm pipeline, integrate progress file"
```

---

## Task 7: Brainstorm phase

**Why:** This is the core new phase — interactive design refinement (scout → questions → approaches → design sections → save design doc).

**Files:**
- Create: `src/workflow/phases/brainstorm.ts`
- Test (create): `src/workflow/phases/brainstorm.test.ts`
- Modify: `src/workflow/prompt-builder.ts`

### Step 1: Write the failing test (RED)

```typescript
// src/workflow/phases/brainstorm.test.ts
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
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/phases/brainstorm.test.ts`
Expected: FAIL — module doesn't exist.

### Step 3: Implement brainstorm phase + prompt templates (GREEN)

In `src/workflow/prompt-builder.ts` add:
- `buildScoutPrompt(userDescription: string): string`
- `buildBrainstormQuestionsPrompt(scoutOutput: string, userDescription: string): string`
- `buildBrainstormApproachesPrompt(scoutOutput: string, userDescription: string, questionsAndAnswers: BrainstormQuestion[]): string`
- `buildBrainstormDesignPrompt(scoutOutput: string, userDescription: string, questionsAndAnswers: BrainstormQuestion[], chosenApproach: BrainstormApproach): string`
- `buildBrainstormSectionRevisionPrompt(section: DesignSection, feedback: string, context: string): string`

In `src/workflow/phases/brainstorm.ts` implement `runBrainstormPhase(state, ctx, signal?)`:
- Uses `discoverAgents(ctx.cwd, true)`. Requires `scout` and `brainstormer` agents.
- Sub-steps driven by `state.brainstorm.step`:
  - **scout**: dispatch scout, store `scoutOutput`, advance to `questions`.
  - **questions**: dispatch brainstormer, parse questions, present each via `ctx.ui.select()` (choice) or `ctx.ui.input()` (open-ended). Store answers. If user cancels → return without advancing.
  - **approaches**: dispatch brainstormer, parse approaches, present via `ctx.ui.select()` with recommendation highlighted. Support "Other" → `ctx.ui.input()`. Store `chosenApproach`.
  - **design**: dispatch brainstormer, parse sections, present each section content + `ctx.ui.confirm()`. If rejected → `ctx.ui.input()` for feedback → dispatch revision. When all approved → assemble markdown, write to `docs/plans/YYYY-MM-DD-<slug>-design.md`, set `designPath`, `designContent`, advance to `plan-write`.
- Accumulates `state.totalCostUsd` from every dispatch.
- On parse failure: retry once with explicit format reminder, then offer Retry/Abort via `ctx.ui.select`.

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/phases/brainstorm.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/brainstorm.ts src/workflow/phases/brainstorm.test.ts src/workflow/prompt-builder.ts
git commit -m "feat(workflow): implement interactive brainstorm phase"
```

---

## Task 8: Plan-write phase

**Why:** Replace old `plan-draft` with a dedicated `planner` agent that writes a plan from the approved design.

**Files:**
- Create: `src/workflow/phases/plan-write.ts`
- Remove: `src/workflow/phases/plan.ts`
- Test (create): `src/workflow/phases/plan-write.test.ts`

### Step 1: Write the failing test (RED)

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
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/phases/plan-write.test.ts`
Expected: FAIL — module doesn't exist.

### Step 3: Implement plan-write phase (GREEN)

In `src/workflow/prompt-builder.ts` add:
- `buildPlannerPromptFromDesign(designContent: string, scoutOutput: string, userDescription: string, planFilePath: string): string`

Create `src/workflow/phases/plan-write.ts`:
- `runPlanWritePhase(state, ctx, signal?): Promise<OrchestratorState>`
- Discover agents, require `planner`.
- Build prompt with `buildPlannerPromptFromDesign()`.
- Dispatch planner.
- Read plan file from disk, parse `superteam-tasks` YAML block.
- If 0 tasks parsed → retry once with more explicit format instructions.
- If still 0 → set `state.error`.
- Convert parsed tasks to `TaskExecState[]`, set `planPath`, `planContent`, advance to `plan-review`.

Delete `src/workflow/phases/plan.ts` and `src/workflow/phases/plan.test.ts`.

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/phases/plan-write.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/plan-write.ts src/workflow/phases/plan-write.test.ts src/workflow/prompt-builder.ts
git rm src/workflow/phases/plan.ts src/workflow/phases/plan.test.ts
git commit -m "feat(workflow): replace plan-draft with plan-write phase using planner agent"
```

---

## Task 9: Update plan-review (design context + planner revision loop)

**Why:** Reviewers must validate the plan against the approved design. If reviews fail, the **planner** (not implementer) revises, then re-review.

**Files:**
- Modify: `src/workflow/phases/plan-review.ts`
- Modify: `src/workflow/prompt-builder.ts`
- Test (modify): `src/workflow/phases/plan-review.test.ts`

### Step 1: Write the failing test (RED)

Add/update tests in `src/workflow/phases/plan-review.test.ts`:

```typescript
// Add these test cases

it("passes design content to review prompts", async () => {
  // Set up: state with designContent, mock dispatches to pass all reviews
  const state = makeState({
    designContent: "# Design\nThe system uses Passport.js...",
    planContent: "# Plan\n...",
    tasks: [makeTask()],
  });

  // Mock reviews to pass
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');
  ctx.ui.select.mockResolvedValue("Approve");

  const result = await runPlanReviewPhase(state, ctx);

  const reviewPrompt = mockDispatchAgent.mock.calls[0][1];
  expect(reviewPrompt).toContain("Passport.js");
});

it("uses ctx.ui.select for plan approval (Approve/Revise/Abort)", async () => {
  const state = makeState({ ... }); // plan with tasks, reviews pass
  // Mock reviews to pass
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');
  ctx.ui.select.mockResolvedValue("Approve");

  const result = await runPlanReviewPhase(state, ctx);

  expect(ctx.ui.select).toHaveBeenCalled();
  expect(result.phase).toBe("configure");
});

it("dispatches planner for revision when review fails", async () => {
  const state = makeState({ designContent: "# Design\n..." });

  // First round: architect review fails
  mockGetFinalOutput
    .mockReturnValueOnce('```superteam-json\n{"passed":false,"findings":["Missing error handling"],"mustFix":["Add try-catch"],"summary":"fail"}\n```')
    // After planner revision, second round: reviews pass
    .mockReturnValueOnce('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```')
    .mockReturnValueOnce('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');

  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  ctx.ui.select.mockResolvedValue("Approve");

  const result = await runPlanReviewPhase(state, ctx);

  // Verify planner was dispatched for revision (not implementer)
  const plannerCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "planner");
  expect(plannerCalls.length).toBeGreaterThanOrEqual(1);
  // Verify revision prompt includes findings
  expect(plannerCalls[0][1]).toContain("Missing error handling");
});

it("handles user selecting Revise with editor feedback", async () => {
  const state = makeState({ ... }); // reviews pass
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');

  ctx.ui.select
    .mockResolvedValueOnce("Revise")    // first time: user wants revisions
    .mockResolvedValueOnce("Approve");  // second time: approve
  ctx.ui.editor.mockResolvedValue("Add more error handling tasks");

  const result = await runPlanReviewPhase(state, ctx);

  expect(ctx.ui.editor).toHaveBeenCalled();
  // Planner was dispatched with user feedback
  const plannerCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "planner");
  expect(plannerCalls.length).toBeGreaterThanOrEqual(1);
  expect(plannerCalls[0][1]).toContain("error handling");
});

it("handles Abort", async () => {
  const state = makeState({ ... }); // reviews pass
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');
  ctx.ui.select.mockResolvedValue("Abort");

  const result = await runPlanReviewPhase(state, ctx);

  expect(result.error).toBeDefined();
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/phases/plan-review.test.ts`
Expected: FAIL — design content not in prompts, `ctx.ui.select` not called, no planner revision dispatch.

### Step 3: Implement changes (GREEN)

In `src/workflow/prompt-builder.ts`:
- Update `buildPlanReviewPrompt(planContent, reviewType, designContent?)` to embed design context.
- Add `buildPlanRevisionPromptFromFindings(planContent: string, designContent: string, findingsText: string): string` — prompts the planner to revise the plan based on review findings.

In `src/workflow/phases/plan-review.ts`:
- Discover agents: require `architect`, `spec-reviewer`, `planner`.
- Sequential review: architect → spec-reviewer (both get design context in prompt).
- On review failure → dispatch `planner` with `buildPlanRevisionPromptFromFindings` → re-read plan → re-review. Max `state.config.maxPlanReviewCycles ?? 3` cycles.
- After reviews pass → `ctx.ui.select("Plan Approval", ["Approve", "Revise", "Abort"])`.
  - Approve → advance to `configure`.
  - Revise → `ctx.ui.editor()` for feedback → dispatch planner revision → re-review.
  - Abort → set `state.error`.
- Remove all `pendingInteraction` usage.

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/phases/plan-review.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/plan-review.ts src/workflow/phases/plan-review.test.ts src/workflow/prompt-builder.ts
git commit -m "feat(workflow): review plan against design with planner revision loop"
```

---

## Task 10: Rewrite configure phase with direct `ctx.ui.*`

**Why:** `/workflow` command must use native UI dialogs, not LLM-mediated `pendingInteraction`.

**Files:**
- Modify: `src/workflow/phases/configure.ts`
- Test (rewrite): `src/workflow/phases/configure.test.ts`

### Step 1: Write the failing test (RED)

```typescript
// src/workflow/phases/configure.test.ts (rewrite)
import { describe, it, expect, vi } from "vitest";

function makeCtx() {
  return {
    cwd: "/tmp",
    hasUI: true,
    ui: {
      select: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as any;
}

function makeState(overrides: any = {}): any {
  return {
    phase: "configure",
    config: {},
    tasks: [{ id: 1, title: "T", status: "pending" }],
    ...overrides,
  };
}

describe("runConfigurePhase (direct UI)", () => {
  it("prompts execution mode and review mode via ctx.ui.select", async () => {
    const { runConfigurePhase } = await import("./configure.js");
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Auto")
      .mockResolvedValueOnce("Iterative");

    const state = makeState();
    const result = await runConfigurePhase(state, ctx);

    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    expect(result.config.executionMode).toBe("auto");
    expect(result.config.reviewMode).toBe("iterative");
    expect(result.phase).toBe("execute");
  });

  it("asks for batch size when Batch mode selected", async () => {
    const { runConfigurePhase } = await import("./configure.js");
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

  it("defaults batch size to 3 when input is empty", async () => {
    const { runConfigurePhase } = await import("./configure.js");
    const ctx = makeCtx();
    ctx.ui.select
      .mockResolvedValueOnce("Batch")
      .mockResolvedValueOnce("Iterative");
    ctx.ui.input.mockResolvedValue("");

    const state = makeState();
    const result = await runConfigurePhase(state, ctx);

    expect(result.config.batchSize).toBe(3);
  });

  it("does not advance when user cancels (Escape)", async () => {
    const { runConfigurePhase } = await import("./configure.js");
    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue(undefined);

    const state = makeState();
    const result = await runConfigurePhase(state, ctx);

    expect(result.phase).toBe("configure");
    expect(result.error).toBeUndefined();
  });
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/phases/configure.test.ts`
Expected: FAIL — current configure uses `pendingInteraction` pattern.

### Step 3: Rewrite configure.ts (GREEN)

Replace `runConfigurePhase` to:
1. `ctx.ui.select("Execution Mode", ["Auto", "Checkpoint", "Batch"])` → map to `config.executionMode`.
2. If Batch → `ctx.ui.input("Batch Size", "3")` → parse int, default 3.
3. `ctx.ui.select("Review Mode", ["Iterative", "Single-pass"])` → map to `config.reviewMode`.
4. If any returns `undefined` → save state, return without advancing.
5. Set defaults for `maxPlanReviewCycles`, `maxTaskReviewCycles`.
6. Advance to `execute`.

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/phases/configure.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/configure.ts src/workflow/phases/configure.test.ts
git commit -m "feat(workflow): rewrite configure phase with direct ctx.ui dialogs"
```

---

## Task 11: Update execute phase (streaming activity + UI escalation)

**Why:** Execute phase must show real-time agent activity and handle task escalation with `ctx.ui.select`, not `pendingInteraction`.

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Test (modify): `src/workflow/phases/execute.test.ts`

### Step 1: Write the failing test (RED)

Add/update tests in `src/workflow/phases/execute.test.ts`:

```typescript
// Add these test cases

it("calls ctx.ui.select for task escalation (Retry/Skip/Abort)", async () => {
  const ctx = makeCtx();
  // Mock implementer to fail repeatedly
  mockDispatchAgent.mockResolvedValue({ ...makeDispatchResult(), exitCode: 1, errorMessage: "compilation error" });
  ctx.ui.select.mockResolvedValue("Skip");

  const state = makeState({ tasks: [makeTask()] });
  const result = await runExecutePhase(state, ctx);

  expect(ctx.ui.select).toHaveBeenCalled();
  const selectCall = ctx.ui.select.mock.calls[0];
  expect(selectCall[1]).toEqual(expect.arrayContaining(["Retry", "Skip", "Abort"]));
  expect(result.tasks[0].status).toBe("skipped");
});

it("aborts workflow when user selects Abort on escalation", async () => {
  const ctx = makeCtx();
  mockDispatchAgent.mockResolvedValue({ ...makeDispatchResult(), exitCode: 1, errorMessage: "fail" });
  ctx.ui.select.mockResolvedValue("Abort");

  const state = makeState({ tasks: [makeTask()] });
  const result = await runExecutePhase(state, ctx);

  expect(result.error).toBeDefined();
});

it("passes onStreamEvent to dispatchAgent and updates status bar", async () => {
  const ctx = makeCtx();

  // Mock dispatchAgent to call the onStreamEvent callback
  mockDispatchAgent.mockImplementation(async (agent, task, cwd, signal, onUpdate, onStreamEvent) => {
    if (onStreamEvent) {
      onStreamEvent({ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
    }
    return makeDispatchResult();
  });
  mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');

  const state = makeState({ tasks: [makeTask()], config: { reviewMode: "iterative" } });
  await runExecutePhase(state, ctx);

  // Status bar should have been updated with tool action
  expect(ctx.ui.setStatus).toHaveBeenCalledWith("workflow", expect.stringContaining("read"));
});

it("updates progress widget after task completion", async () => {
  const ctx = makeCtx();
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');

  const state = makeState({ tasks: [makeTask(), makeTask()], config: { reviewMode: "iterative" } });
  await runExecutePhase(state, ctx);

  expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-progress", expect.any(Array));
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: FAIL — `pendingInteraction` used for escalation, no `onStreamEvent` passed.

### Step 3: Implement changes (GREEN)

In `src/workflow/phases/execute.ts`:
1. Replace all `pendingInteraction` escalation with `await ctx.ui.select("Task Escalation", ["Retry", "Skip", "Abort"])`.
2. Handle: Retry → loop, Skip → `task.status = "skipped"`, Abort → set error + return.
3. When dispatching agents, pass `onStreamEvent` callback that:
   - Calls `ctx.ui.setStatus("workflow", formatToolAction(event))` on `tool_execution_start`.
   - Appends to an `ActivityBuffer` and calls `ctx.ui.setWidget("workflow-activity", buffer.lines())`.
4. After each task completion: `ctx.ui.setWidget("workflow-progress", formatTaskProgress(tasks, currentIndex))`.
5. Remove `userInput` parameter (no longer needed).

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat(workflow): add streaming activity and direct UI escalation to execute phase"
```

---

## Task 12: Rewrite orchestrator loop and `/workflow` command

**Why:** The `/workflow` command becomes the primary interface. The orchestrator loop drives all phases with direct UI interaction.

**Files:**
- Modify: `src/workflow/orchestrator.ts`
- Modify: `src/index.ts`
- Test (modify): `src/workflow/orchestrator.test.ts`

### Step 1: Write the failing test (RED)

```typescript
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

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0 } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(mockBrainstorm).toHaveBeenCalledWith(state, ctx, undefined);
  });

  it("chains phases: brainstorm → plan-write → done", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0 } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "plan-write"; return s; });
    mockPlanWrite.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(mockBrainstorm).toHaveBeenCalled();
    expect(mockPlanWrite).toHaveBeenCalled();
  });

  it("saves state and writes progress after each phase", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0 } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(mockSaveState).toHaveBeenCalled();
    expect(mockWriteProgress).toHaveBeenCalled();
  });

  it("stops and notifies on error", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0 } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.error = "Agent failed"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Agent failed"), "warning");
    expect(mockPlanWrite).not.toHaveBeenCalled();
  });

  it("clears status and widget when done", async () => {
    const { runWorkflowLoop } = await import("./orchestrator.js");
    const ctx = makeCtx();

    const state = { phase: "brainstorm", brainstorm: { step: "scout" }, totalCostUsd: 0 } as any;
    mockBrainstorm.mockImplementation(async (s) => { s.phase = "done"; return s; });

    await runWorkflowLoop(state, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("workflow", undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-progress", undefined);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("workflow-activity", undefined);
  });
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/orchestrator.test.ts`
Expected: FAIL — `runWorkflowLoop` doesn't exist, old orchestrator has different API.

### Step 3: Implement orchestrator + command (GREEN)

In `src/workflow/orchestrator.ts`:
- Export `runWorkflowLoop(state, ctx, signal?)`:
  ```
  while (state.phase !== "done") {
    ctx.ui.setStatus("workflow", formatStatus(state));
    switch (state.phase) {
      case "brainstorm": state = await runBrainstormPhase(state, ctx, signal); break;
      case "plan-write": state = await runPlanWritePhase(state, ctx, signal); break;
      case "plan-review": state = await runPlanReviewPhase(state, ctx, signal); break;
      case "configure": state = await runConfigurePhase(state, ctx); break;
      case "execute": state = await runExecutePhase(state, ctx, signal); break;
      case "finalize": state = await runFinalizePhase(state, ctx, signal); break;
    }
    saveState(state, ctx.cwd);
    writeProgressFile(state, ctx.cwd);
    if (state.error) {
      ctx.ui.notify(state.error, "warning");
      ctx.ui.notify("Use /workflow to resume.", "info");
      break;
    }
  }
  ctx.ui.setStatus("workflow", undefined);
  ctx.ui.setWidget("workflow-progress", undefined);
  ctx.ui.setWidget("workflow-activity", undefined);
  ```
- Keep a `runWorkflowTool(...)` wrapper for the secondary tool path.

In `src/index.ts`, rewrite `/workflow` command:
- `status` → show current state summary.
- `abort` → clear state, notify.
- No args + no state → `ctx.ui.input("Start Workflow", ...)` for description.
- No args + state exists → resume from saved state.
- Args + state exists → `ctx.ui.confirm()` to replace or resume.
- Call `runWorkflowLoop(state, ctx)`.

### Step 4: Run tests (GREEN)
Run:
- `npx vitest run src/workflow/orchestrator.test.ts`
- `npx vitest run` (full suite)
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/orchestrator.ts src/index.ts src/workflow/orchestrator.test.ts
git commit -m "feat(workflow): rewrite orchestrator loop and /workflow command for direct UI"
```

---

## Task 13: Documentation update

**Why:** Docs describe the old plan-draft pipeline. Users need guidance on the new brainstorm → plan → execute workflow.

**Files:**
- Modify: `README.md`
- Create: `docs/guides/workflow.md`
- Modify: `docs/guides/agents.md` (or create if missing)
- Test (create): `src/workflow/docs.test.ts`

### Step 1: Write the failing test (RED)

```typescript
// src/workflow/docs.test.ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";

describe("documentation completeness", () => {
  it("README mentions brainstorm phase", () => {
    const readme = fs.readFileSync("README.md", "utf-8");
    expect(readme).toContain("brainstorm");
  });

  it("workflow guide exists and covers all phases", () => {
    const guide = fs.readFileSync("docs/guides/workflow.md", "utf-8");
    expect(guide).toContain("Brainstorm");
    expect(guide).toContain("Plan");
    expect(guide).toContain("Review");
    expect(guide).toContain("Configure");
    expect(guide).toContain("Execute");
    expect(guide).toContain("Finalize");
  });

  it("workflow guide documents brainstormer and planner agents", () => {
    const guide = fs.readFileSync("docs/guides/workflow.md", "utf-8");
    expect(guide).toContain("brainstormer");
    expect(guide).toContain("planner");
  });

  it("workflow guide documents /workflow command", () => {
    const guide = fs.readFileSync("docs/guides/workflow.md", "utf-8");
    expect(guide).toContain("/workflow");
    expect(guide).toContain("status");
    expect(guide).toContain("abort");
  });

  it("workflow guide documents progress file and streaming activity", () => {
    const guide = fs.readFileSync("docs/guides/workflow.md", "utf-8");
    expect(guide).toContain("progress");
    expect(guide).toContain("activity");
  });
});
```

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/docs.test.ts`
Expected: FAIL — docs don't exist or don't mention brainstorm.

### Step 3: Write documentation (GREEN)

1. **README.md**: Update workflow section with brainstorm → plan → execute pipeline overview. Mention `/workflow` command, new agents.

2. **docs/guides/workflow.md**: Comprehensive guide:
   - Phase diagram
   - Each phase explained
   - Agent roster (brainstormer, planner, scout, implementer, reviewers)
   - Progress file format and location
   - Streaming activity widget
   - `/workflow` command usage (start, resume, status, abort)
   - Configuration options
   - Error handling and recovery

3. **docs/guides/agents.md**: Add brainstormer and planner with tool constraints.

### Step 4: Run tests (GREEN)
Run: `npx vitest run src/workflow/docs.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add README.md docs/guides/workflow.md docs/guides/agents.md src/workflow/docs.test.ts
git commit -m "docs: workflow guide, agent docs for brainstorm redesign"
```

---

## Dependency Graph

```
Task 1 (agent profiles)          — no deps
Task 2 (stream callback)         — no deps
Task 3 (brainstorm parser)       — no deps
Task 4 (progress file)           — no deps
Task 5 (UI helpers)              — no deps
Task 6 (state model)             — depends on Task 4 (calls writeProgressFile from saveState)
Task 7 (brainstorm phase)        — depends on 1, 3, 5, 6
Task 8 (plan-write phase)        — depends on 1, 6
Task 9 (plan-review update)      — depends on 6
Task 10 (configure update)       — depends on 6
Task 11 (execute update)         — depends on 2, 5, 6
Task 12 (orchestrator rewrite)   — depends on 7, 8, 9, 10, 11
Task 13 (docs)                   — depends on 12
```

Tasks 1-5 can be done in any order (or in parallel). Task 6 depends on Task 4. Tasks 7-11 depend on foundation tasks. Task 12 integrates everything. Task 13 documents the result.

---

```superteam-tasks
- title: Add brainstormer + planner agent profiles
  description: Create agents/brainstormer.md (read-only, superteam-brainstorm JSON output) and agents/planner.md (writes plans, superteam-tasks YAML). Test via discoverAgents in dispatch.test.ts.
  files: [agents/brainstormer.md, agents/planner.md, src/dispatch.test.ts]
- title: Stream tool execution events from dispatch
  description: Export StreamEvent/OnStreamEvent types. Add optional onStreamEvent callback to runAgent/dispatchAgent. Parse tool_execution_start/update/end from JSON stream. Test by mocking child_process.spawn.
  files: [src/dispatch.ts, src/dispatch-stream-events.test.ts]
- title: Parse superteam-brainstorm outputs
  description: Create brainstorm-parser.ts extracting superteam-brainstorm fenced blocks. Supports questions/approaches/design payloads. Fallback to last JSON brace block. Same pattern as review-parser.ts.
  files: [src/workflow/brainstorm-parser.ts, src/workflow/brainstorm-parser.test.ts]
- title: Generate and write workflow progress markdown
  description: Implement getProgressPath, renderProgressMarkdown (pure), writeProgressFile. Sections for brainstorm, plan, config, tasks, cost.
  files: [src/workflow/progress.ts, src/workflow/progress.test.ts]
- title: Add workflow UI helpers and simplify interaction.ts
  description: Create ui.ts with formatStatus, formatToolAction, formatTaskProgress, createActivityBuffer. Remove old pendingInteraction builder helpers from interaction.ts.
  files: [src/workflow/ui.ts, src/workflow/ui.test.ts, src/workflow/interaction.ts, src/workflow/interaction.test.ts]
- title: Update orchestrator state model for brainstorm pipeline
  description: Add BrainstormState, new phase types (brainstorm/plan-write), designPath/designContent fields. Remove pendingInteraction. Update createInitialState. Call writeProgressFile from saveState.
  files: [src/workflow/orchestrator-state.ts, src/workflow/orchestrator-state.test.ts]
- title: Implement brainstorm phase
  description: Full brainstorm flow (scout → questions → approaches → design sections → save design doc). Uses ctx.ui for interaction, dispatchAgent for creative work, parseBrainstormOutput for parsing. Add prompt templates to prompt-builder.ts.
  files: [src/workflow/phases/brainstorm.ts, src/workflow/phases/brainstorm.test.ts, src/workflow/prompt-builder.ts]
- title: Implement plan-write phase
  description: Dispatch planner agent (not implementer) with design content + scout output. Parse superteam-tasks from written plan. Retry once on empty tasks. Delete old plan.ts.
  files: [src/workflow/phases/plan-write.ts, src/workflow/phases/plan-write.test.ts]
- title: Update plan-review with design context and planner revision loop
  description: Pass design content to review prompts. On review failure, dispatch planner for revision (not implementer). Use ctx.ui.select for Approve/Revise/Abort. Add buildPlanRevisionPromptFromFindings.
  files: [src/workflow/phases/plan-review.ts, src/workflow/phases/plan-review.test.ts, src/workflow/prompt-builder.ts]
- title: Rewrite configure phase with direct UI
  description: Replace pendingInteraction with ctx.ui.select for execution mode and review mode, ctx.ui.input for batch size. Handle cancellation.
  files: [src/workflow/phases/configure.ts, src/workflow/phases/configure.test.ts]
- title: Update execute phase for streaming activity and UI escalation
  description: Pass onStreamEvent to dispatchAgent for activity widget. Replace pendingInteraction escalation with ctx.ui.select (Retry/Skip/Abort). Update progress widget after each task.
  files: [src/workflow/phases/execute.ts, src/workflow/phases/execute.test.ts]
- title: Rewrite orchestrator loop and /workflow command
  description: Export runWorkflowLoop driving all phases. Rewrite /workflow command to start/resume with direct UI. Keep workflow tool as secondary. Mock phases by .js import specifiers.
  files: [src/workflow/orchestrator.ts, src/index.ts, src/workflow/orchestrator.test.ts]
- title: Update documentation for redesigned workflow
  description: Update README with brainstorm pipeline. Create docs/guides/workflow.md covering all phases, agents, progress file, streaming, /workflow command. Update agents docs.
  files: [README.md, docs/guides/workflow.md, docs/guides/agents.md, src/workflow/docs.test.ts]
```
