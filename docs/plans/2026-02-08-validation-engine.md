# Validation Engine Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Build infrastructure to catch regressions as they happen: test baseline capture, failure classification, cross-task validation with flake detection, and a failure taxonomy that drives all escalation paths.

**Architecture:** Four new modules — `test-baseline.ts` (baseline capture + classification), `failure-taxonomy.ts` (failure types + default actions + resolution), `test-output-parser.ts` (framework-specific test output parsing), and `cross-task-validation.ts` (orchestration of validation runs) — plus modifications to `execute.ts` to wire validation between review completion and task-complete, and a pre-review auto-fix retry for the existing validation gate. All pure functions are unit-tested; integration points use the existing mock patterns from `execute.test.ts`.

**Tech Stack:** TypeScript ESM, vitest, `node:child_process` (promisified `execFile`), existing `git-utils.ts` for SHA tracking, existing `config.ts` for `testCommand`/`validationCadence`/`validationInterval` config keys (already defined in `SuperteamConfig`).

---

### Task 1: Create test output parser

**Files:**
- Create: `src/workflow/test-output-parser.ts`
- Create: `src/workflow/test-output-parser.test.ts`

**Step 1: Write the failing tests**

Create `src/workflow/test-output-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseTestOutput, type TestResult } from "./test-output-parser.js";

describe("parseTestOutput", () => {
  it("parses vitest/jest passing test lines", () => {
    const output = [
      " ✓ src/a.test.ts > describe > adds numbers (2ms)",
      " ✓ src/a.test.ts > describe > subtracts numbers (1ms)",
    ].join("\n");
    const results = parseTestOutput(output);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      name: "src/a.test.ts > describe > adds numbers",
      passed: true,
      duration: 2,
    });
    expect(results[1]).toEqual({
      name: "src/a.test.ts > describe > subtracts numbers",
      passed: true,
      duration: 1,
    });
  });

  it("parses vitest/jest failing test lines", () => {
    const output = [
      " ✗ src/b.test.ts > fails gracefully (3ms)",
      "   → expected true, got false",
    ].join("\n");
    const results = parseTestOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      name: "src/b.test.ts > fails gracefully",
      passed: false,
      duration: 3,
      output: "expected true, got false",
    });
  });

  it("parses × as failure marker (bun test style)", () => {
    const output = " × src/c.test.ts > broken (1ms)\n   → assertion failed";
    const results = parseTestOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].name).toBe("src/c.test.ts > broken");
  });

  it("handles mixed pass and fail", () => {
    const output = [
      " ✓ src/a.test.ts > passes (1ms)",
      " ✗ src/b.test.ts > fails (2ms)",
      "   → error details",
      " ✓ src/c.test.ts > also passes (0ms)",
    ].join("\n");
    const results = parseTestOutput(output);
    expect(results).toHaveLength(3);
    expect(results.filter(r => r.passed)).toHaveLength(2);
    expect(results.filter(r => !r.passed)).toHaveLength(1);
  });

  it("returns empty array for unparseable output", () => {
    const output = "some random text\nno test markers here";
    const results = parseTestOutput(output);
    expect(results).toEqual([]);
  });

  it("handles duration without ms suffix", () => {
    const output = " ✓ src/a.test.ts > fast";
    const results = parseTestOutput(output);
    expect(results).toHaveLength(1);
    expect(results[0].duration).toBeUndefined();
  });

  it("captures multi-line failure output up to next test line", () => {
    const output = [
      " ✗ src/x.test.ts > complex fail (5ms)",
      "   → line 1 of error",
      "   → line 2 of error",
      " ✓ src/y.test.ts > next test (1ms)",
    ].join("\n");
    const results = parseTestOutput(output);
    expect(results).toHaveLength(2);
    expect(results[0].output).toContain("line 1 of error");
    expect(results[0].output).toContain("line 2 of error");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/test-output-parser.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/workflow/test-output-parser.ts`:

```typescript
/**
 * Test output parser — extract individual test results from CLI output.
 *
 * Supports vitest/jest (✓/✗) and bun test (✓/×) output formats.
 * Falls back to empty array if output is unparseable.
 */

export interface TestResult {
  name: string;
  passed: boolean;
  duration?: number;
  output?: string;
}

// Match: " ✓ test name (Nms)" or " ✗ test name (Nms)" or " × test name (Nms)"
const TEST_LINE_RE = /^\s*([✓✗×])\s+(.+?)(?:\s+\((\d+)ms\))?\s*$/;
// Match: "   → error text"
const ERROR_LINE_RE = /^\s+→\s+(.+)$/;

export function parseTestOutput(output: string): TestResult[] {
  const lines = output.split("\n");
  const results: TestResult[] = [];
  let currentFailOutput: string[] = [];
  let lastResult: TestResult | null = null;

  function flushFailOutput() {
    if (lastResult && !lastResult.passed && currentFailOutput.length > 0) {
      lastResult.output = currentFailOutput.join("\n");
    }
    currentFailOutput = [];
  }

  for (const line of lines) {
    const testMatch = line.match(TEST_LINE_RE);
    if (testMatch) {
      flushFailOutput();
      const [, marker, name, durationStr] = testMatch;
      const passed = marker === "✓";
      const result: TestResult = {
        name: name.trim(),
        passed,
        ...(durationStr ? { duration: parseInt(durationStr, 10) } : {}),
      };
      results.push(result);
      lastResult = result;
      continue;
    }

    const errorMatch = line.match(ERROR_LINE_RE);
    if (errorMatch && lastResult && !lastResult.passed) {
      currentFailOutput.push(errorMatch[1]);
    }
  }

  flushFailOutput();
  return results;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/test-output-parser.test.ts`
Expected: PASS — all 7 tests green

**Step 5: Commit**

```bash
git add src/workflow/test-output-parser.ts src/workflow/test-output-parser.test.ts
git commit -m "feat: add test output parser for vitest/jest/bun formats"
```

---

### Task 2: Create failure taxonomy module

**Files:**
- Create: `src/workflow/failure-taxonomy.ts`
- Create: `src/workflow/failure-taxonomy.test.ts`

**Step 1: Write the failing tests**

Create `src/workflow/failure-taxonomy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  resolveFailureAction,
  DEFAULT_FAILURE_ACTIONS,
  type FailureType,
  type FailureAction,
} from "./failure-taxonomy.js";

describe("DEFAULT_FAILURE_ACTIONS", () => {
  it("maps every FailureType to a FailureAction", () => {
    const expectedTypes: FailureType[] = [
      "parse-error",
      "test-regression",
      "test-flake",
      "test-preexisting",
      "tool-timeout",
      "budget-threshold",
      "review-max-retries",
      "validation-failure",
      "impl-crash",
    ];
    for (const ft of expectedTypes) {
      expect(DEFAULT_FAILURE_ACTIONS[ft]).toBeDefined();
    }
  });

  it("test-regression defaults to stop-show-diff", () => {
    expect(DEFAULT_FAILURE_ACTIONS["test-regression"]).toBe("stop-show-diff");
  });

  it("test-flake defaults to warn-continue", () => {
    expect(DEFAULT_FAILURE_ACTIONS["test-flake"]).toBe("warn-continue");
  });

  it("test-preexisting defaults to ignore", () => {
    expect(DEFAULT_FAILURE_ACTIONS["test-preexisting"]).toBe("ignore");
  });

  it("parse-error defaults to auto-retry", () => {
    expect(DEFAULT_FAILURE_ACTIONS["parse-error"]).toBe("auto-retry");
  });

  it("budget-threshold defaults to checkpoint", () => {
    expect(DEFAULT_FAILURE_ACTIONS["budget-threshold"]).toBe("checkpoint");
  });
});

describe("resolveFailureAction", () => {
  it("returns default action when no overrides", () => {
    expect(resolveFailureAction("test-flake")).toBe("warn-continue");
  });

  it("returns default action when overrides don't contain the type", () => {
    expect(resolveFailureAction("test-flake", { "parse-error": "escalate" })).toBe("warn-continue");
  });

  it("returns overridden action when override matches type", () => {
    expect(resolveFailureAction("test-flake", { "test-flake": "escalate" })).toBe("escalate");
  });

  it("returns overridden action for multiple overrides", () => {
    const overrides: Partial<Record<FailureType, FailureAction>> = {
      "test-regression": "auto-retry",
      "impl-crash": "escalate",
    };
    expect(resolveFailureAction("test-regression", overrides)).toBe("auto-retry");
    expect(resolveFailureAction("impl-crash", overrides)).toBe("escalate");
  });

  it("returns default when overrides is undefined", () => {
    expect(resolveFailureAction("validation-failure", undefined)).toBe("retry-then-escalate");
  });

  it("returns default when overrides is empty object", () => {
    expect(resolveFailureAction("tool-timeout", {})).toBe("retry-then-escalate");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/failure-taxonomy.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/workflow/failure-taxonomy.ts`:

```typescript
/**
 * Failure taxonomy — codified failure types, default actions, and resolution.
 *
 * Used by execute phase to determine how to handle each type of failure.
 * Users can override defaults per-type in their config.
 */

export type FailureType =
  | "parse-error"
  | "test-regression"
  | "test-flake"
  | "test-preexisting"
  | "tool-timeout"
  | "budget-threshold"
  | "review-max-retries"
  | "validation-failure"
  | "impl-crash";

export type FailureAction =
  | "auto-retry"
  | "warn-continue"
  | "ignore"
  | "stop-show-diff"
  | "retry-then-escalate"
  | "checkpoint"
  | "escalate";

export const DEFAULT_FAILURE_ACTIONS: Record<FailureType, FailureAction> = {
  "parse-error": "auto-retry",
  "test-regression": "stop-show-diff",
  "test-flake": "warn-continue",
  "test-preexisting": "ignore",
  "tool-timeout": "retry-then-escalate",
  "budget-threshold": "checkpoint",
  "review-max-retries": "escalate",
  "validation-failure": "retry-then-escalate",
  "impl-crash": "retry-then-escalate",
};

/** Given a failure type, return the action to take. Supports per-type overrides. */
export function resolveFailureAction(
  type: FailureType,
  overrides?: Partial<Record<FailureType, FailureAction>>,
): FailureAction {
  if (overrides && type in overrides) {
    return overrides[type]!;
  }
  return DEFAULT_FAILURE_ACTIONS[type];
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/failure-taxonomy.test.ts`
Expected: PASS — all 12 tests green

**Step 5: Commit**

```bash
git add src/workflow/failure-taxonomy.ts src/workflow/failure-taxonomy.test.ts
git commit -m "feat: add failure taxonomy with default actions and resolution"
```

---

### Task 3: Create test baseline module — types and `classifyFailures`

**Files:**
- Create: `src/workflow/test-baseline.ts`
- Create: `src/workflow/test-baseline.test.ts`

**Step 1: Write the failing tests**

Create `src/workflow/test-baseline.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  classifyFailures,
  type TestBaseline,
  type ClassifiedResults,
} from "./test-baseline.js";
import type { TestResult } from "./test-output-parser.js";

function makeBaseline(overrides: Partial<TestBaseline> = {}): TestBaseline {
  return {
    capturedAt: Date.now(),
    sha: "abc123",
    command: "npx vitest run",
    results: [],
    knownFailures: [],
    ...overrides,
  };
}

function makeResult(name: string, passed: boolean): TestResult {
  return { name, passed };
}

describe("classifyFailures", () => {
  it("classifies new failures (passed in baseline, fail now) as newFailures", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", true), makeResult("test-b", true)],
      knownFailures: [],
    });
    const current: TestResult[] = [
      makeResult("test-a", true),
      makeResult("test-b", false),
    ];
    const classified = classifyFailures(current, baseline);
    expect(classified.newFailures).toHaveLength(1);
    expect(classified.newFailures[0].name).toBe("test-b");
  });

  it("classifies pre-existing failures (failed in baseline too) as preExisting", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", false)],
      knownFailures: ["test-a"],
    });
    const current: TestResult[] = [makeResult("test-a", false)];
    const classified = classifyFailures(current, baseline);
    expect(classified.preExisting).toHaveLength(1);
    expect(classified.preExisting[0].name).toBe("test-a");
    expect(classified.newFailures).toHaveLength(0);
  });

  it("classifies new passes (failed in baseline, pass now) as newPasses", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", false)],
      knownFailures: ["test-a"],
    });
    const current: TestResult[] = [makeResult("test-a", true)];
    const classified = classifyFailures(current, baseline);
    expect(classified.newPasses).toHaveLength(1);
    expect(classified.newPasses[0].name).toBe("test-a");
  });

  it("marks new failures as flake candidates", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", true)],
      knownFailures: [],
    });
    const current: TestResult[] = [makeResult("test-a", false)];
    const classified = classifyFailures(current, baseline);
    expect(classified.flakeCandidates).toHaveLength(1);
    expect(classified.flakeCandidates[0].name).toBe("test-a");
  });

  it("handles empty baseline (all current failures are new)", () => {
    const baseline = makeBaseline({ results: [], knownFailures: [] });
    const current: TestResult[] = [makeResult("test-a", false)];
    const classified = classifyFailures(current, baseline);
    expect(classified.newFailures).toHaveLength(1);
    expect(classified.flakeCandidates).toHaveLength(1);
  });

  it("handles empty current results", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", true)],
      knownFailures: [],
    });
    const classified = classifyFailures([], baseline);
    expect(classified.newFailures).toHaveLength(0);
    expect(classified.preExisting).toHaveLength(0);
    expect(classified.newPasses).toHaveLength(0);
    expect(classified.flakeCandidates).toHaveLength(0);
  });

  it("handles tests not in baseline (new tests that fail are new failures)", () => {
    const baseline = makeBaseline({
      results: [makeResult("test-a", true)],
      knownFailures: [],
    });
    const current: TestResult[] = [
      makeResult("test-a", true),
      makeResult("test-new", false),
    ];
    const classified = classifyFailures(current, baseline);
    expect(classified.newFailures).toHaveLength(1);
    expect(classified.newFailures[0].name).toBe("test-new");
  });

  it("handles complex mixed scenario", () => {
    const baseline = makeBaseline({
      results: [
        makeResult("passes-stays", true),
        makeResult("passes-regresses", true),
        makeResult("fails-stays", false),
        makeResult("fails-fixed", false),
      ],
      knownFailures: ["fails-stays", "fails-fixed"],
    });
    const current: TestResult[] = [
      makeResult("passes-stays", true),
      makeResult("passes-regresses", false),
      makeResult("fails-stays", false),
      makeResult("fails-fixed", true),
    ];
    const classified = classifyFailures(current, baseline);
    expect(classified.newFailures.map(r => r.name)).toEqual(["passes-regresses"]);
    expect(classified.preExisting.map(r => r.name)).toEqual(["fails-stays"]);
    expect(classified.newPasses.map(r => r.name)).toEqual(["fails-fixed"]);
    expect(classified.flakeCandidates.map(r => r.name)).toEqual(["passes-regresses"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/test-baseline.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/workflow/test-baseline.ts`:

```typescript
/**
 * Test baseline — capture and classify test results against a known state.
 *
 * Captures which tests pass/fail before execute begins. During execution,
 * classifies failures as new regressions, pre-existing, or flake candidates.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentSha } from "./git-utils.js";
import { parseTestOutput, type TestResult } from "./test-output-parser.js";

export type { TestResult };

const execFile = promisify(execFileCb);

export interface TestBaseline {
  capturedAt: number;
  sha: string;
  command: string;
  results: TestResult[];
  knownFailures: string[];
}

export interface ClassifiedResults {
  newFailures: TestResult[];
  preExisting: TestResult[];
  flakeCandidates: TestResult[];
  newPasses: TestResult[];
}

/** Compare current test run against baseline. Classify each failure. */
export function classifyFailures(
  current: TestResult[],
  baseline: TestBaseline,
): ClassifiedResults {
  const baselineMap = new Map<string, boolean>();
  for (const r of baseline.results) {
    baselineMap.set(r.name, r.passed);
  }
  const knownSet = new Set(baseline.knownFailures);

  const newFailures: TestResult[] = [];
  const preExisting: TestResult[] = [];
  const flakeCandidates: TestResult[] = [];
  const newPasses: TestResult[] = [];

  for (const result of current) {
    if (result.passed) {
      // Was it a known failure that now passes?
      if (knownSet.has(result.name)) {
        newPasses.push(result);
      }
      continue;
    }

    // result.passed === false
    if (knownSet.has(result.name)) {
      // Failed in baseline too
      preExisting.push(result);
    } else {
      // New failure — also a flake candidate for re-run
      newFailures.push(result);
      flakeCandidates.push(result);
    }
  }

  return { newFailures, preExisting, flakeCandidates, newPasses };
}

/** Run test command, parse output, return baseline. */
export async function captureBaseline(
  testCommand: string,
  cwd: string,
): Promise<TestBaseline> {
  const sha = await getCurrentSha(cwd);
  const capturedAt = Date.now();
  let stdout = "";
  let stderr = "";

  try {
    const result = await execFile("bash", ["-c", testCommand], {
      cwd,
      timeout: 120_000,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    // Test command may exit non-zero if some tests fail — that's expected
    stdout = err.stdout || "";
    stderr = err.stderr || "";
  }

  const combinedOutput = stdout + "\n" + stderr;
  const results = parseTestOutput(combinedOutput);
  const knownFailures = results.filter(r => !r.passed).map(r => r.name);

  return {
    capturedAt,
    sha,
    command: testCommand,
    results,
    knownFailures,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/test-baseline.test.ts`
Expected: PASS — all 8 tests green

**Step 5: Commit**

```bash
git add src/workflow/test-baseline.ts src/workflow/test-baseline.test.ts
git commit -m "feat: add test baseline with classifyFailures and captureBaseline"
```

---

### Task 4: Add `captureBaseline` integration test

**Files:**
- Modify: `src/workflow/test-baseline.test.ts`

**Step 1: Write the integration test**

Append to `src/workflow/test-baseline.test.ts`:

```typescript
import { captureBaseline } from "./test-baseline.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("captureBaseline (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-int-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures baseline from a command that outputs test-like lines", async () => {
    // Create a script that mimics vitest output
    const script = path.join(tmpDir, "fake-test.sh");
    fs.writeFileSync(script, [
      "#!/bin/bash",
      'echo " ✓ test-a > passes (1ms)"',
      'echo " ✗ test-b > fails (2ms)"',
      'echo "   → expected 1, got 2"',
      "exit 1",
    ].join("\n"), { mode: 0o755 });

    // Need a git repo for getCurrentSha
    const { execFile: execCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execCb);
    await run("git", ["init"], { cwd: tmpDir });
    await run("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
    await run("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "dummy.txt"), "x");
    await run("git", ["add", "."], { cwd: tmpDir });
    await run("git", ["commit", "-m", "init"], { cwd: tmpDir });

    const baseline = await captureBaseline(`bash ${script}`, tmpDir);

    expect(baseline.sha).toBeTruthy();
    expect(baseline.command).toBe(`bash ${script}`);
    expect(baseline.results).toHaveLength(2);
    expect(baseline.results[0].name).toBe("test-a > passes");
    expect(baseline.results[0].passed).toBe(true);
    expect(baseline.results[1].name).toBe("test-b > fails");
    expect(baseline.results[1].passed).toBe(false);
    expect(baseline.knownFailures).toEqual(["test-b > fails"]);
  });

  it("returns empty results for unparseable output", async () => {
    const { execFile: execCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execCb);
    await run("git", ["init"], { cwd: tmpDir });
    await run("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
    await run("git", ["config", "user.name", "Test"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "dummy.txt"), "x");
    await run("git", ["add", "."], { cwd: tmpDir });
    await run("git", ["commit", "-m", "init"], { cwd: tmpDir });

    const baseline = await captureBaseline("echo 'no test output'", tmpDir);

    expect(baseline.results).toEqual([]);
    expect(baseline.knownFailures).toEqual([]);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run src/workflow/test-baseline.test.ts`
Expected: PASS — all 10 tests green (8 unit + 2 integration)

**Step 3: Commit**

```bash
git add src/workflow/test-baseline.test.ts
git commit -m "test: add captureBaseline integration tests"
```

---

### Task 5: Add `testBaseline` field to `OrchestratorState`

**Files:**
- Modify: `src/workflow/orchestrator-state.ts`
- Modify: `src/workflow/orchestrator-state.test.ts`

**Step 1: Write the failing test**

Add to `src/workflow/orchestrator-state.test.ts` inside the existing `describe("orchestrator-state")` block:

```typescript
describe("testBaseline state field", () => {
  it("OrchestratorState accepts optional testBaseline", () => {
    const state = createInitialState("test");
    expect(state.testBaseline).toBeUndefined();
  });

  it("testBaseline round-trips through save/load", () => {
    const state = createInitialState("test");
    (state as any).testBaseline = {
      capturedAt: 1700000000000,
      sha: "abc123",
      command: "npx vitest run",
      results: [
        { name: "test-a", passed: true, duration: 5 },
        { name: "test-b", passed: false, output: "error" },
      ],
      knownFailures: ["test-b"],
    };
    saveState(state, tmpDir);
    const loaded = loadState(tmpDir);
    expect(loaded!.testBaseline).toBeDefined();
    expect(loaded!.testBaseline!.knownFailures).toEqual(["test-b"]);
    expect(loaded!.testBaseline!.results).toHaveLength(2);
  });

  it("missing testBaseline in loaded state defaults to undefined", () => {
    const state = createInitialState("test");
    saveState(state, tmpDir);
    const loaded = loadState(tmpDir);
    expect(loaded!.testBaseline).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/orchestrator-state.test.ts`
Expected: FAIL — `testBaseline` not a property on `OrchestratorState`

**Step 3: Write minimal implementation**

In `src/workflow/orchestrator-state.ts`, add the import and field:

After the existing imports, add:
```typescript
import type { TestBaseline } from "./test-baseline.js";
```

In the `OrchestratorState` type, add after `error?: string;`:
```typescript
testBaseline?: TestBaseline;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/orchestrator-state.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/orchestrator-state.ts src/workflow/orchestrator-state.test.ts
git commit -m "feat: add testBaseline field to OrchestratorState"
```

---

### Task 6: Create cross-task validation module

**Files:**
- Create: `src/workflow/cross-task-validation.ts`
- Create: `src/workflow/cross-task-validation.test.ts`

**Step 1: Write the failing tests**

Create `src/workflow/cross-task-validation.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./test-baseline.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./test-baseline.js")>();
  return { ...orig, captureBaseline: vi.fn() };
});

import {
  runCrossTaskValidation,
  shouldRunValidation,
  type ValidationResult,
} from "./cross-task-validation.js";
import { captureBaseline, classifyFailures, type TestBaseline } from "./test-baseline.js";
import type { TestResult } from "./test-output-parser.js";

const mockCaptureBaseline = vi.mocked(captureBaseline);

function makeBaseline(overrides: Partial<TestBaseline> = {}): TestBaseline {
  return {
    capturedAt: Date.now(),
    sha: "abc123",
    command: "npx vitest run",
    results: [],
    knownFailures: [],
    ...overrides,
  };
}

function makeTestResult(name: string, passed: boolean): TestResult {
  return { name, passed };
}

describe("shouldRunValidation", () => {
  it("returns true when cadence is 'every'", () => {
    expect(shouldRunValidation("every", 1, 1)).toBe(true);
    expect(shouldRunValidation("every", 1, 5)).toBe(true);
  });

  it("returns true when cadence is 'every-N' and taskIndex is multiple of interval", () => {
    expect(shouldRunValidation("every-N", 3, 3)).toBe(true);
    expect(shouldRunValidation("every-N", 3, 6)).toBe(true);
  });

  it("returns false when cadence is 'every-N' and taskIndex is not multiple of interval", () => {
    expect(shouldRunValidation("every-N", 3, 1)).toBe(false);
    expect(shouldRunValidation("every-N", 3, 2)).toBe(false);
    expect(shouldRunValidation("every-N", 3, 4)).toBe(false);
  });

  it("returns false when cadence is 'on-demand'", () => {
    expect(shouldRunValidation("on-demand", 1, 1)).toBe(false);
    expect(shouldRunValidation("on-demand", 1, 5)).toBe(false);
  });
});

describe("runCrossTaskValidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns passed=true when no new failures", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    // Current run: all pass
    mockCaptureBaseline.mockResolvedValue({
      ...baseline,
      capturedAt: Date.now(),
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(true);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("detects genuine regression (fails on re-run too)", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    // First run: test-a fails. Re-run: test-a still fails.
    mockCaptureBaseline
      .mockResolvedValueOnce({
        ...baseline,
        capturedAt: Date.now(),
        results: [makeTestResult("test-a", false)],
        knownFailures: ["test-a"],
      })
      .mockResolvedValueOnce({
        ...baseline,
        capturedAt: Date.now(),
        results: [makeTestResult("test-a", false)],
        knownFailures: ["test-a"],
      });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(false);
    expect(result.blockingFailures).toHaveLength(1);
    expect(result.blockingFailures[0].name).toBe("test-a");
    expect(result.flakyTests).toHaveLength(0);
  });

  it("detects flake (fails first run, passes re-run)", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    // First run: test-a fails. Re-run: test-a passes.
    mockCaptureBaseline
      .mockResolvedValueOnce({
        ...baseline,
        capturedAt: Date.now(),
        results: [makeTestResult("test-a", false)],
        knownFailures: ["test-a"],
      })
      .mockResolvedValueOnce({
        ...baseline,
        capturedAt: Date.now(),
        results: [makeTestResult("test-a", true)],
        knownFailures: [],
      });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(true);
    expect(result.flakyTests).toEqual(["test-a"]);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("ignores pre-existing failures", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", false), makeTestResult("test-b", true)],
      knownFailures: ["test-a"],
    });

    // Current run: test-a still fails (pre-existing), test-b passes
    mockCaptureBaseline.mockResolvedValue({
      ...baseline,
      capturedAt: Date.now(),
      results: [makeTestResult("test-a", false), makeTestResult("test-b", true)],
      knownFailures: ["test-a"],
    });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(true);
    expect(result.classified.preExisting).toHaveLength(1);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("skips flake re-run when no flake candidates", async () => {
    const baseline = makeBaseline({
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    // All pass — no flake candidates
    mockCaptureBaseline.mockResolvedValue({
      ...baseline,
      capturedAt: Date.now(),
      results: [makeTestResult("test-a", true)],
      knownFailures: [],
    });

    const result = await runCrossTaskValidation("npx vitest run", baseline, "/fake");
    expect(result.passed).toBe(true);
    // captureBaseline called only once (no re-run needed)
    expect(mockCaptureBaseline).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/cross-task-validation.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/workflow/cross-task-validation.ts`:

```typescript
/**
 * Cross-task validation — run full test suite after task completion,
 * classify failures against baseline, detect flakes via re-run.
 */

import { captureBaseline, classifyFailures, type TestBaseline, type ClassifiedResults } from "./test-baseline.js";
import type { TestResult } from "./test-output-parser.js";

export type { ClassifiedResults };

export interface ValidationResult {
  passed: boolean;
  classified: ClassifiedResults;
  flakyTests: string[];
  blockingFailures: TestResult[];
}

/** Determine whether to run cross-task validation based on cadence config. */
export function shouldRunValidation(
  cadence: "every" | "every-N" | "on-demand",
  interval: number,
  completedTaskCount: number,
): boolean {
  if (cadence === "every") return true;
  if (cadence === "on-demand") return false;
  // "every-N"
  return completedTaskCount > 0 && completedTaskCount % interval === 0;
}

/** Run full test suite, classify against baseline, detect flakes. */
export async function runCrossTaskValidation(
  testCommand: string,
  baseline: TestBaseline,
  cwd: string,
): Promise<ValidationResult> {
  // 1. Run the test suite
  const currentRun = await captureBaseline(testCommand, cwd);

  // 2. Classify against baseline
  const classified = classifyFailures(currentRun.results, baseline);

  // 3. If no new failures, we're done
  if (classified.flakeCandidates.length === 0) {
    return {
      passed: true,
      classified,
      flakyTests: [],
      blockingFailures: [],
    };
  }

  // 4. Re-run to detect flakes
  const rerun = await captureBaseline(testCommand, cwd);
  const rerunResults = new Map<string, boolean>();
  for (const r of rerun.results) {
    rerunResults.set(r.name, r.passed);
  }

  const flakyTests: string[] = [];
  const blockingFailures: TestResult[] = [];

  for (const candidate of classified.flakeCandidates) {
    const passedOnRerun = rerunResults.get(candidate.name) ?? false;
    if (passedOnRerun) {
      flakyTests.push(candidate.name);
    } else {
      blockingFailures.push(candidate);
    }
  }

  return {
    passed: blockingFailures.length === 0,
    classified,
    flakyTests,
    blockingFailures,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/cross-task-validation.test.ts`
Expected: PASS — all 9 tests green

**Step 5: Commit**

```bash
git add src/workflow/cross-task-validation.ts src/workflow/cross-task-validation.test.ts
git commit -m "feat: add cross-task validation with flake detection"
```

---

### Task 7: Enhance validation gate with auto-fix retry

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Modify: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing tests**

Add to `src/workflow/phases/execute.test.ts` inside the existing `describe("validation gate (validationCommand)")` block:

```typescript
it("auto-fix retry: dispatches implementer with error on first validation failure, then re-validates", async () => {
  setupDefaultMocks();

  // Validation fails first, passes second (after auto-fix)
  let validationCallCount = 0;
  mockGetConfig.mockImplementation(() => {
    validationCallCount++;
    return { validationCommand: validationCallCount <= 1 ? "false" : "true" } as any;
  });

  // Need to mock runValidation behavior through the real command
  // Instead, we test the flow: impl succeeds, validation fails, implementer re-dispatched for fix, validation passes

  const ctx = makeCtx("/tmp");
  const state = makeState();
  const result = await runExecutePhase(state, ctx);

  // Should have dispatched implementer at least twice (impl + auto-fix)
  const implCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "implementer");
  expect(implCalls.length).toBeGreaterThanOrEqual(2);
  // Task should complete (validation passed on retry)
  expect(result.tasks[0].status).toBe("complete");
});

it("auto-fix retry: escalates after auto-fix still fails validation", async () => {
  setupDefaultMocks();
  mockGetConfig.mockReturnValue({ validationCommand: "false" } as any);

  const ctx = makeCtx("/tmp");
  ctx.ui.select.mockResolvedValue("Skip");
  const state = makeState();
  const result = await runExecutePhase(state, ctx);

  // After auto-fix attempt, validation still fails → escalate
  expect(ctx.ui.select).toHaveBeenCalled();
  expect(result.tasks[0].status).toBe("skipped");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: FAIL — the auto-fix retry behavior doesn't exist yet

**Step 3: Write minimal implementation**

In `src/workflow/phases/execute.ts`, replace the existing validation gate section (comment: `// c. VALIDATION GATE`) with:

```typescript
// c. VALIDATION GATE (with auto-fix retry)
const config = getConfig(ctx.cwd);
const validationCommand = config.validationCommand || "";
if (validationCommand) {
  const valResult = await runValidation(validationCommand, ctx.cwd);
  if (!valResult.success) {
    // Auto-fix attempt: dispatch implementer with error details
    if (implementer) {
      ui?.notify?.(`Validation failed, attempting auto-fix...`, "warning");
      const fixPrompt = `Fix these validation errors for task "${task.title}":\n\n${valResult.error}\n\nRun the validation command to verify: ${validationCommand}`;
      const fixResult = await dispatchAgent(
        implementer, fixPrompt, ctx.cwd, signal, undefined, makeOnStreamEvent(),
      );
      state.totalCostUsd += fixResult.usage.cost;

      // Re-run validation after fix
      const revalResult = await runValidation(validationCommand, ctx.cwd);
      if (!revalResult.success) {
        const reason = `Validation still failing after auto-fix: ${revalResult.error || "command exited with non-zero"}`;
        const escalation = await escalate(task, reason, ui, ctx.cwd);
        if (escalation === "abort") {
          state.error = "Aborted by user";
          saveState(state, ctx.cwd);
          return state;
        }
        if (escalation === "skip") {
          task.status = "skipped";
          saveState(state, ctx.cwd);
          continue;
        }
        task.status = "pending";
        continue;
      }
    } else {
      const reason = `Validation failed: ${valResult.error || "command exited with non-zero"}`;
      const escalation = await escalate(task, reason, ui, ctx.cwd);
      if (escalation === "abort") {
        state.error = "Aborted by user";
        saveState(state, ctx.cwd);
        return state;
      }
      if (escalation === "skip") {
        task.status = "skipped";
        saveState(state, ctx.cwd);
        continue;
      }
      task.status = "pending";
      continue;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: PASS — all existing tests plus new auto-fix tests pass

**Step 5: Commit**

```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat: add auto-fix retry to validation gate before escalation"
```

---

### Task 8: Wire cross-task validation into execute phase

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Modify: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing tests**

Add new mock at the top of `execute.test.ts` alongside the existing mocks:

```typescript
vi.mock("../cross-task-validation.js", () => ({
  runCrossTaskValidation: vi.fn(),
  shouldRunValidation: vi.fn(),
}));

vi.mock("../test-baseline.js", () => ({
  captureBaseline: vi.fn(),
}));
```

Add imports:

```typescript
import { runCrossTaskValidation, shouldRunValidation } from "../cross-task-validation.js";
import { captureBaseline } from "../test-baseline.js";

const mockRunCrossTaskValidation = vi.mocked(runCrossTaskValidation);
const mockShouldRunValidation = vi.mocked(shouldRunValidation);
const mockCaptureBaseline = vi.mocked(captureBaseline);
```

Update `setupDefaultMocks()` to include the new mocks:

```typescript
// Add to setupDefaultMocks():
mockShouldRunValidation.mockReturnValue(false); // default: skip validation
mockGetConfig.mockReturnValue({ validationCommand: "", testCommand: "", validationCadence: "every", validationInterval: 3 } as any);
```

Add test describe block:

```typescript
describe("cross-task validation", () => {
  it("captures baseline on first task when testCommand is configured", async () => {
    setupDefaultMocks();
    mockGetConfig.mockReturnValue({
      validationCommand: "",
      testCommand: "npx vitest run",
      validationCadence: "every",
      validationInterval: 3,
    } as any);
    mockShouldRunValidation.mockReturnValue(true);
    mockCaptureBaseline.mockResolvedValue({
      capturedAt: Date.now(),
      sha: "abc",
      command: "npx vitest run",
      results: [],
      knownFailures: [],
    });
    mockRunCrossTaskValidation.mockResolvedValue({
      passed: true,
      classified: { newFailures: [], preExisting: [], flakeCandidates: [], newPasses: [] },
      flakyTests: [],
      blockingFailures: [],
    });

    const state = makeState();
    const result = await runExecutePhase(state, fakeCtx);

    expect(mockCaptureBaseline).toHaveBeenCalledWith("npx vitest run", fakeCtx.cwd);
    expect(result.tasks[0].status).toBe("complete");
  });

  it("skips cross-task validation when testCommand is empty", async () => {
    setupDefaultMocks();
    mockGetConfig.mockReturnValue({
      validationCommand: "",
      testCommand: "",
      validationCadence: "every",
      validationInterval: 3,
    } as any);

    const state = makeState();
    await runExecutePhase(state, fakeCtx);

    expect(mockRunCrossTaskValidation).not.toHaveBeenCalled();
  });

  it("skips validation when shouldRunValidation returns false", async () => {
    setupDefaultMocks();
    mockGetConfig.mockReturnValue({
      validationCommand: "",
      testCommand: "npx vitest run",
      validationCadence: "every-N",
      validationInterval: 3,
    } as any);
    mockShouldRunValidation.mockReturnValue(false);
    mockCaptureBaseline.mockResolvedValue({
      capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
      results: [], knownFailures: [],
    });

    const state = makeState();
    await runExecutePhase(state, fakeCtx);

    expect(mockRunCrossTaskValidation).not.toHaveBeenCalled();
  });

  it("escalates on blocking failures from cross-task validation", async () => {
    setupDefaultMocks();
    mockGetConfig.mockReturnValue({
      validationCommand: "",
      testCommand: "npx vitest run",
      validationCadence: "every",
      validationInterval: 3,
    } as any);
    mockShouldRunValidation.mockReturnValue(true);
    mockCaptureBaseline.mockResolvedValue({
      capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
      results: [{ name: "test-a", passed: true }], knownFailures: [],
    });
    mockRunCrossTaskValidation.mockResolvedValue({
      passed: false,
      classified: {
        newFailures: [{ name: "test-a", passed: false }],
        preExisting: [],
        flakeCandidates: [{ name: "test-a", passed: false }],
        newPasses: [],
      },
      flakyTests: [],
      blockingFailures: [{ name: "test-a", passed: false }],
    });

    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Skip");
    const state = makeState();
    const result = await runExecutePhase(state, ctx);

    expect(ctx.ui.select).toHaveBeenCalled();
    const callArgs = ctx.ui.select.mock.calls[0][0];
    expect(callArgs).toContain("test regression");
  });

  it("warns and continues on flaky tests", async () => {
    setupDefaultMocks();
    mockGetConfig.mockReturnValue({
      validationCommand: "",
      testCommand: "npx vitest run",
      validationCadence: "every",
      validationInterval: 3,
    } as any);
    mockShouldRunValidation.mockReturnValue(true);
    mockCaptureBaseline.mockResolvedValue({
      capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
      results: [{ name: "test-a", passed: true }], knownFailures: [],
    });
    mockRunCrossTaskValidation.mockResolvedValue({
      passed: true,
      classified: {
        newFailures: [{ name: "test-a", passed: false }],
        preExisting: [],
        flakeCandidates: [{ name: "test-a", passed: false }],
        newPasses: [],
      },
      flakyTests: ["test-a"],
      blockingFailures: [],
    });

    const ctx = makeCtx();
    const state = makeState();
    const result = await runExecutePhase(state, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("flaky"), "warning");
    expect(result.tasks[0].status).toBe("complete");
  });

  it("stores baseline in state.testBaseline after capture", async () => {
    setupDefaultMocks();
    const fakeBaseline = {
      capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
      results: [{ name: "test-a", passed: true }], knownFailures: [],
    };
    mockGetConfig.mockReturnValue({
      validationCommand: "",
      testCommand: "npx vitest run",
      validationCadence: "every",
      validationInterval: 3,
    } as any);
    mockShouldRunValidation.mockReturnValue(true);
    mockCaptureBaseline.mockResolvedValue(fakeBaseline);
    mockRunCrossTaskValidation.mockResolvedValue({
      passed: true,
      classified: { newFailures: [], preExisting: [], flakeCandidates: [], newPasses: [] },
      flakyTests: [],
      blockingFailures: [],
    });

    const state = makeState();
    const result = await runExecutePhase(state, fakeCtx);

    expect(result.testBaseline).toBeDefined();
    expect(result.testBaseline!.sha).toBe("abc");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: FAIL — cross-task validation not wired in execute.ts yet

**Step 3: Write minimal implementation**

In `src/workflow/phases/execute.ts`, add imports at top:

```typescript
import { runCrossTaskValidation, shouldRunValidation } from "../cross-task-validation.js";
import { captureBaseline } from "../test-baseline.js";
```

Before the task loop (`// 5. Task loop`), add baseline capture:

```typescript
// 4b. Capture test baseline if testCommand configured
const config = getConfig(ctx.cwd);
const testCommand = config.testCommand || "";
if (testCommand && !state.testBaseline) {
  ui?.notify?.("Capturing test baseline...", "info");
  state.testBaseline = await captureBaseline(testCommand, ctx.cwd);
  saveState(state, ctx.cwd);
}
```

Inside the task loop, after the `// h. COMPLETE` section (after `task.status = "complete"`) and before `// h. EXECUTION MODE CHECK`, add:

```typescript
// h2. CROSS-TASK VALIDATION
const testCmd = getConfig(ctx.cwd).testCommand || "";
if (testCmd && state.testBaseline) {
  const valCadence = getConfig(ctx.cwd).validationCadence || "every";
  const valInterval = getConfig(ctx.cwd).validationInterval || 3;
  const completedCount = state.tasks.filter(t => t.status === "complete").length;

  if (shouldRunValidation(valCadence, valInterval, completedCount)) {
    const valResult = await runCrossTaskValidation(testCmd, state.testBaseline, ctx.cwd);

    // Warn about flaky tests
    if (valResult.flakyTests.length > 0) {
      ui?.notify?.(`Detected flaky tests: ${valResult.flakyTests.join(", ")}`, "warning");
    }

    // Block on genuine regressions
    if (!valResult.passed) {
      const failNames = valResult.blockingFailures.map(f => f.name).join(", ");
      const escalation = await escalate(
        task,
        `Task introduced test regression: ${failNames}`,
        ui,
        ctx.cwd,
      );
      if (escalation === "abort") {
        state.error = "Aborted by user";
        saveState(state, ctx.cwd);
        return state;
      }
      if (escalation === "skip") {
        task.status = "skipped";
        saveState(state, ctx.cwd);
        continue;
      }
      task.status = "pending";
      continue;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: PASS — all tests green

**Step 5: Commit**

```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat: wire cross-task validation with baseline capture into execute phase"
```

---

### Task 9: Wire failure taxonomy into execute phase escalation paths

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Modify: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing tests**

Add to `execute.test.ts`:

```typescript
vi.mock("../failure-taxonomy.js", () => ({
  resolveFailureAction: vi.fn(),
  DEFAULT_FAILURE_ACTIONS: {
    "parse-error": "auto-retry",
    "test-regression": "stop-show-diff",
    "test-flake": "warn-continue",
    "test-preexisting": "ignore",
    "tool-timeout": "retry-then-escalate",
    "budget-threshold": "checkpoint",
    "review-max-retries": "escalate",
    "validation-failure": "retry-then-escalate",
    "impl-crash": "retry-then-escalate",
  },
}));

import { resolveFailureAction } from "../failure-taxonomy.js";
const mockResolveFailureAction = vi.mocked(resolveFailureAction);
```

Update `setupDefaultMocks()` to include:

```typescript
mockResolveFailureAction.mockImplementation((type) => {
  // Default: delegate to escalate for most types
  const defaults: Record<string, string> = {
    "test-regression": "stop-show-diff",
    "test-flake": "warn-continue",
    "validation-failure": "retry-then-escalate",
    "impl-crash": "retry-then-escalate",
  };
  return (defaults[type] || "escalate") as any;
});
```

Add test block:

```typescript
describe("failure taxonomy integration", () => {
  it("calls resolveFailureAction for test-regression on cross-task validation failure", async () => {
    setupDefaultMocks();
    mockGetConfig.mockReturnValue({
      validationCommand: "",
      testCommand: "npx vitest run",
      validationCadence: "every",
      validationInterval: 3,
    } as any);
    mockShouldRunValidation.mockReturnValue(true);
    mockCaptureBaseline.mockResolvedValue({
      capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
      results: [{ name: "test-a", passed: true }], knownFailures: [],
    });
    mockRunCrossTaskValidation.mockResolvedValue({
      passed: false,
      classified: {
        newFailures: [{ name: "test-a", passed: false }],
        preExisting: [], flakeCandidates: [], newPasses: [],
      },
      flakyTests: [],
      blockingFailures: [{ name: "test-a", passed: false }],
    });
    mockResolveFailureAction.mockReturnValue("stop-show-diff");

    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Skip");
    const state = makeState();
    await runExecutePhase(state, ctx);

    expect(mockResolveFailureAction).toHaveBeenCalledWith("test-regression", undefined);
  });

  it("calls resolveFailureAction for test-flake and warns when action is warn-continue", async () => {
    setupDefaultMocks();
    mockGetConfig.mockReturnValue({
      validationCommand: "",
      testCommand: "npx vitest run",
      validationCadence: "every",
      validationInterval: 3,
    } as any);
    mockShouldRunValidation.mockReturnValue(true);
    mockCaptureBaseline.mockResolvedValue({
      capturedAt: Date.now(), sha: "abc", command: "npx vitest run",
      results: [{ name: "test-a", passed: true }], knownFailures: [],
    });
    mockRunCrossTaskValidation.mockResolvedValue({
      passed: true,
      classified: {
        newFailures: [], preExisting: [],
        flakeCandidates: [{ name: "test-a", passed: false }],
        newPasses: [],
      },
      flakyTests: ["test-a"],
      blockingFailures: [],
    });
    mockResolveFailureAction.mockReturnValue("warn-continue");

    const ctx = makeCtx();
    const state = makeState();
    const result = await runExecutePhase(state, ctx);

    expect(mockResolveFailureAction).toHaveBeenCalledWith("test-flake", undefined);
    expect(result.tasks[0].status).toBe("complete");
  });

  it("calls resolveFailureAction for validation-failure on validation gate failure", async () => {
    setupDefaultMocks();
    mockGetConfig.mockReturnValue({ validationCommand: "false", testCommand: "" } as any);
    mockResolveFailureAction.mockReturnValue("retry-then-escalate");

    const ctx = makeCtx("/tmp");
    ctx.ui.select.mockResolvedValue("Skip");
    const state = makeState();
    await runExecutePhase(state, ctx);

    expect(mockResolveFailureAction).toHaveBeenCalledWith("validation-failure", undefined);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: FAIL — `resolveFailureAction` not called in execute.ts yet

**Step 3: Write minimal implementation**

In `src/workflow/phases/execute.ts`, add import:

```typescript
import { resolveFailureAction, type FailureType } from "../failure-taxonomy.js";
```

Modify the cross-task validation section to use the taxonomy. Replace the direct flake warning and regression escalation with:

```typescript
// Classify flakes via taxonomy
if (valResult.flakyTests.length > 0) {
  const flakeAction = resolveFailureAction("test-flake");
  if (flakeAction === "warn-continue") {
    ui?.notify?.(`Detected flaky tests: ${valResult.flakyTests.join(", ")}`, "warning");
  }
  // Other actions could be added later (e.g., "escalate")
}

// Classify regressions via taxonomy
if (!valResult.passed) {
  const regressionAction = resolveFailureAction("test-regression");
  const failNames = valResult.blockingFailures.map(f => f.name).join(", ");

  if (regressionAction === "stop-show-diff" || regressionAction === "escalate") {
    const escalation = await escalate(
      task,
      `Task introduced test regression: ${failNames}`,
      ui,
      ctx.cwd,
    );
    if (escalation === "abort") {
      state.error = "Aborted by user";
      saveState(state, ctx.cwd);
      return state;
    }
    if (escalation === "skip") {
      task.status = "skipped";
      saveState(state, ctx.cwd);
      continue;
    }
    task.status = "pending";
    continue;
  }
}
```

In the validation gate section, add taxonomy call before escalation:

```typescript
// Before escalating on validation failure:
const _valAction = resolveFailureAction("validation-failure");
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: PASS — all tests green

**Step 5: Commit**

```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat: wire failure taxonomy into execute phase escalation paths"
```

---

### Task 10: Run full test suite and verify no regressions

**Files:**
- No files changed — verification only

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All 386+ tests pass (original 386 + new tests from tasks 1-9)

**Step 2: Verify new test count**

Run: `npx vitest run --reporter=verbose 2>&1 | grep -c "✓"`
Expected: Count should be 386 + approximately 45 new tests ≈ 430+

**Step 3: Commit (if any formatting/lint fixes needed)**

```bash
git status
# If clean, nothing to commit. If not:
git add -A
git commit -m "chore: verify full test suite passes with validation engine"
```

---

## Task Dependency Summary

```
Task 1 (test-output-parser) — independent, no deps
Task 2 (failure-taxonomy) — independent, no deps
Task 3 (test-baseline types + classifyFailures) — depends on Task 1
Task 4 (captureBaseline integration test) — depends on Task 3
Task 5 (testBaseline in OrchestratorState) — depends on Task 3
Task 6 (cross-task-validation module) — depends on Task 3
Task 7 (validation gate auto-fix) — independent of Tasks 1-6
Task 8 (wire cross-task into execute) — depends on Tasks 5, 6
Task 9 (wire failure taxonomy into execute) — depends on Tasks 2, 8
Task 10 (full test suite verification) — depends on all above
```

```
Parallelizable: Tasks 1, 2, 7 can run in parallel
Sequential chain: 1 → 3 → 4,5,6 → 8 → 9 → 10
```

---

```superteam-tasks
- title: Create test output parser
  description: >
    Write tests for parseTestOutput(output) in src/workflow/test-output-parser.test.ts,
    then implement in src/workflow/test-output-parser.ts. Parses vitest/jest (✓/✗) and
    bun test (✓/×) output lines into TestResult[]. Tests cover passing lines, failing lines
    with error output, mixed pass/fail, unparseable output, missing duration, multi-line
    failure output. Returns empty array for unparseable output.
  files: [src/workflow/test-output-parser.ts, src/workflow/test-output-parser.test.ts]

- title: Create failure taxonomy module
  description: >
    Write tests for DEFAULT_FAILURE_ACTIONS mapping and resolveFailureAction(type, overrides?)
    in src/workflow/failure-taxonomy.test.ts, then implement in src/workflow/failure-taxonomy.ts.
    Defines FailureType union (parse-error, test-regression, test-flake, test-preexisting,
    tool-timeout, budget-threshold, review-max-retries, validation-failure, impl-crash) and
    FailureAction union (auto-retry, warn-continue, ignore, stop-show-diff, retry-then-escalate,
    checkpoint, escalate). Tests cover all defaults and override scenarios.
  files: [src/workflow/failure-taxonomy.ts, src/workflow/failure-taxonomy.test.ts]

- title: Create test baseline module with classifyFailures
  description: >
    Write tests for classifyFailures(current, baseline) in src/workflow/test-baseline.test.ts,
    then implement types (TestBaseline, ClassifiedResults) and classifyFailures in
    src/workflow/test-baseline.ts. Also implements captureBaseline(testCommand, cwd) using
    execFile + parseTestOutput. Tests cover new failures, pre-existing, new passes, flake
    candidates, empty baseline/current, unknown tests, and mixed scenarios.
  files: [src/workflow/test-baseline.ts, src/workflow/test-baseline.test.ts]

- title: Add captureBaseline integration test
  description: >
    Append integration tests to src/workflow/test-baseline.test.ts that exercise
    captureBaseline with real temp git repos and fake test scripts. Tests cover parsing
    vitest-like output from a bash script and handling unparseable output.
  files: [src/workflow/test-baseline.test.ts]

- title: Add testBaseline field to OrchestratorState
  description: >
    Import TestBaseline type from ./test-baseline.js and add optional testBaseline? field
    to OrchestratorState type in orchestrator-state.ts. Add tests in
    orchestrator-state.test.ts verifying the field is undefined by default, round-trips
    through save/load, and defaults to undefined when missing from loaded state.
  files: [src/workflow/orchestrator-state.ts, src/workflow/orchestrator-state.test.ts]

- title: Create cross-task validation module
  description: >
    Write tests for shouldRunValidation(cadence, interval, completedTaskCount) and
    runCrossTaskValidation(testCommand, baseline, cwd) in
    src/workflow/cross-task-validation.test.ts, then implement in
    src/workflow/cross-task-validation.ts. shouldRunValidation checks cadence config
    (every/every-N/on-demand). runCrossTaskValidation runs test suite, classifies against
    baseline, re-runs for flake detection. Tests mock captureBaseline to simulate regressions,
    flakes, pre-existing failures, and clean runs.
  files: [src/workflow/cross-task-validation.ts, src/workflow/cross-task-validation.test.ts]

- title: Enhance validation gate with auto-fix retry
  description: >
    Modify execute.ts validation gate section. On first validation failure, dispatch
    implementer with error details as fix prompt. Re-run validation after fix. If still
    failing, then escalate. Add tests in execute.test.ts for auto-fix-then-pass and
    auto-fix-still-fails paths. No new modules — enhances existing runValidation flow.
  files: [src/workflow/phases/execute.ts, src/workflow/phases/execute.test.ts]

- title: Wire cross-task validation into execute phase
  description: >
    Import runCrossTaskValidation, shouldRunValidation, and captureBaseline into execute.ts.
    Before task loop, capture baseline if testCommand configured and state.testBaseline not
    set. After task completion (before execution mode check), run cross-task validation per
    cadence config. Warn on flaky tests, escalate on blocking regressions. Store baseline in
    state.testBaseline. Add mocks and tests in execute.test.ts for baseline capture, skip
    when no testCommand, cadence check, regression escalation, flake warning, and state
    persistence.
  files: [src/workflow/phases/execute.ts, src/workflow/phases/execute.test.ts]

- title: Wire failure taxonomy into execute phase escalation
  description: >
    Import resolveFailureAction into execute.ts. Replace direct escalation calls in
    cross-task validation section with taxonomy-driven actions: resolveFailureAction for
    test-regression (stop-show-diff → escalate), test-flake (warn-continue → notify),
    and validation-failure. Add mock for failure-taxonomy.js in execute.test.ts. Tests
    verify resolveFailureAction is called with correct FailureType for each failure scenario.
  files: [src/workflow/phases/execute.ts, src/workflow/phases/execute.test.ts]

- title: Run full test suite verification
  description: >
    Run npx vitest run and verify all tests pass (original 386 + ~45 new tests). No code
    changes — verification only. Fix any regressions if found.
  files: []
```
