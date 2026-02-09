# Git Discipline & Execution Quality Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make the workflow execution phase git-safe, faster, and more reliable — with preflight checks, orchestrator-controlled squash commits, parallel reviews, progress summaries, context forwarding, ANSI stripping, and a test-file-only review guard.

**Architecture:** Six deliverable groups built incrementally. Git safety (D1→D2→D3) forms the core chain. Parallel reviews (D4) restructures the review loop in execute.ts. Progress summaries + context forwarding (D5→D6) add deterministic post-task reporting. ANSI stripping + test-file guard (D7+D8a) are small independent hardening fixes.

**Tech Stack:** TypeScript, Vitest, Node.js child_process (git commands), existing dispatch/review-parser infrastructure.

**Test baseline:** 439 tests passing across 33 files. Every task must preserve this baseline.

---

## Task 1: Add `gitStartingSha` and `gitBranch` to OrchestratorState

**Files:**
- Modify: `src/workflow/orchestrator-state.ts:71-80` (OrchestratorState type)
- Modify: `src/workflow/orchestrator-state.test.ts`

**Step 1: Write the failing test**

Add to `src/workflow/orchestrator-state.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createInitialState } from "./orchestrator-state.ts";

describe("OrchestratorState git fields", () => {
  it("createInitialState does not set gitStartingSha or gitBranch", () => {
    const state = createInitialState("test");
    expect(state.gitStartingSha).toBeUndefined();
    expect(state.gitBranch).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/orchestrator-state.test.ts -v`
Expected: FAIL — `gitStartingSha` is not a property of OrchestratorState (TypeScript error).

**Step 3: Write minimal implementation**

Add two optional fields to the `OrchestratorState` type in `src/workflow/orchestrator-state.ts`:

```typescript
export type OrchestratorState = {
  phase: OrchestratorPhase;
  config: Partial<OrchestratorConfig>;
  userDescription: string;
  brainstorm: BrainstormState;
  designPath?: string;
  designContent?: string;
  planPath?: string;
  planContent?: string;
  tasks: TaskExecState[];
  currentTaskIndex: number;
  planReviewCycles: number;
  totalCostUsd: number;
  startedAt: number;
  /** @deprecated Kept for backward compatibility. Use ctx.ui.* instead. */
  pendingInteraction?: PendingInteraction;
  error?: string;
  testBaseline?: TestBaseline;
  gitStartingSha?: string;
  gitBranch?: string;
};
```

No changes to `createInitialState` needed — fields are optional and default to `undefined`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/orchestrator-state.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing (no regressions)

**Step 6: Commit**

```bash
git add src/workflow/orchestrator-state.ts src/workflow/orchestrator-state.test.ts
git commit -m "feat(state): add gitStartingSha and gitBranch to OrchestratorState"
```

---

## Task 2: Create `git-preflight.ts` with `runGitPreflight()`

**Files:**
- Create: `src/workflow/git-preflight.ts`
- Create: `src/workflow/git-preflight.test.ts`

**Step 1: Write the failing test**

Create `src/workflow/git-preflight.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runGitPreflight, type GitPreflightResult } from "./git-preflight.ts";

// We test with a mock execFileAsync to avoid real git
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:util", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:util")>();
  return {
    ...orig,
    promisify: vi.fn(() => vi.fn()),
  };
});

// Instead: test the pure logic by mocking the git helpers we'll extract
// Strategy: runGitPreflight uses git-utils functions, so mock those

vi.mock("./git-utils.js", () => ({
  getCurrentSha: vi.fn(),
  computeChangedFiles: vi.fn(),
  resetToSha: vi.fn(),
  getTrackedFiles: vi.fn(),
  squashCommitsSince: vi.fn(),
}));

import { getCurrentSha } from "./git-utils.ts";
const mockGetCurrentSha = vi.mocked(getCurrentSha);

describe("runGitPreflight", () => {
  it("returns clean=true, branch name, and sha for clean non-main repo", async () => {
    const mockExec = vi.fn()
      .mockResolvedValueOnce({ stdout: "" })            // git status --porcelain → clean
      .mockResolvedValueOnce({ stdout: "feat/my-work\n" }) // git branch --show-current
      .mockResolvedValueOnce({ stdout: "abc123def456\n" }); // git rev-parse HEAD

    const result = await runGitPreflight("/fake", mockExec as any);
    expect(result.clean).toBe(true);
    expect(result.branch).toBe("feat/my-work");
    expect(result.isMainBranch).toBe(false);
    expect(result.sha).toBe("abc123def456");
    expect(result.uncommittedFiles).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns clean=false with uncommitted files for dirty repo", async () => {
    const mockExec = vi.fn()
      .mockResolvedValueOnce({ stdout: " M src/a.ts\n?? new.ts\n" }) // dirty
      .mockResolvedValueOnce({ stdout: "feat/work\n" })
      .mockResolvedValueOnce({ stdout: "abc123\n" });

    const result = await runGitPreflight("/fake", mockExec as any);
    expect(result.clean).toBe(false);
    expect(result.uncommittedFiles).toEqual(["src/a.ts", "new.ts"]);
  });

  it("detects main branch", async () => {
    const mockExec = vi.fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "main\n" })
      .mockResolvedValueOnce({ stdout: "abc123\n" });

    const result = await runGitPreflight("/fake", mockExec as any);
    expect(result.isMainBranch).toBe(true);
    expect(result.warnings).toContain("On main branch");
  });

  it("detects master branch", async () => {
    const mockExec = vi.fn()
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "master\n" })
      .mockResolvedValueOnce({ stdout: "abc123\n" });

    const result = await runGitPreflight("/fake", mockExec as any);
    expect(result.isMainBranch).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/git-preflight.test.ts -v`
Expected: FAIL — module `./git-preflight.ts` does not exist.

**Step 3: Write minimal implementation**

Create `src/workflow/git-preflight.ts`:

```typescript
/**
 * Git preflight checks — ensure clean, isolated git state before workflow starts.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFileCb);

export interface GitPreflightResult {
  clean: boolean;
  branch: string;
  isMainBranch: boolean;
  sha: string;
  uncommittedFiles: string[];
  warnings: string[];
}

type ExecFn = (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) => Promise<{ stdout: string }>;

const MAIN_BRANCHES = ["main", "master"];

/**
 * Check git state. Returns a pure result object — caller decides what to do.
 * Accepts optional execFn for testability.
 */
export async function runGitPreflight(
  cwd: string,
  execFn: ExecFn = defaultExecFile as unknown as ExecFn,
): Promise<GitPreflightResult> {
  const warnings: string[] = [];

  // 1. Check dirty state
  const { stdout: statusOut } = await execFn("git", ["status", "--porcelain"], { cwd, timeout: 5000 });
  const statusLines = statusOut.split("\n").map(l => l.trim()).filter(Boolean);
  const clean = statusLines.length === 0;
  const uncommittedFiles = statusLines.map(line => line.replace(/^.{2}\s+/, "").trim());

  // 2. Get current branch
  const { stdout: branchOut } = await execFn("git", ["branch", "--show-current"], { cwd, timeout: 5000 });
  const branch = branchOut.trim();
  const isMainBranch = MAIN_BRANCHES.includes(branch);
  if (isMainBranch) {
    warnings.push("On main branch");
  }

  // 3. Get current SHA
  const { stdout: shaOut } = await execFn("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 });
  const sha = shaOut.trim();

  return { clean, branch, isMainBranch, sha, uncommittedFiles, warnings };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/git-preflight.test.ts -v`
Expected: PASS (4 tests)

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/git-preflight.ts src/workflow/git-preflight.test.ts
git commit -m "feat(git): add runGitPreflight with clean/branch/sha checks"
```

---

## Task 3: Integrate git preflight into `runWorkflowLoop()`

**Files:**
- Modify: `src/workflow/orchestrator.ts:27-33` (top of runWorkflowLoop)
- Modify: `src/workflow/orchestrator.test.ts`

**Step 1: Write the failing test**

Add to `src/workflow/orchestrator.test.ts`:

```typescript
// Add mock at top of file, alongside existing mocks:
vi.mock("./git-preflight.js", () => ({ runGitPreflight: vi.fn() }));

import { runGitPreflight } from "./git-preflight.ts";
const mockGitPreflight = vi.mocked(runGitPreflight);

// Add test case inside the "runWorkflowLoop" describe:
describe("git preflight integration", () => {
  it("calls runGitPreflight and stores sha/branch on first run", async () => {
    mockGitPreflight.mockResolvedValue({
      clean: true, branch: "feat/work", isMainBranch: false,
      sha: "abc123", uncommittedFiles: [], warnings: [],
    });
    // Make brainstorm transition to done immediately
    mockBrainstorm.mockImplementation(async (state) => {
      state.phase = "done";
      return state;
    });

    const state = createInitialState("test");
    const ctx = makeCtx();
    const result = await runWorkflowLoop(state, ctx);

    expect(mockGitPreflight).toHaveBeenCalledWith(ctx.cwd);
    expect(result.gitStartingSha).toBe("abc123");
    expect(result.gitBranch).toBe("feat/work");
  });

  it("skips preflight when gitStartingSha is already set (resume)", async () => {
    mockBrainstorm.mockImplementation(async (state) => {
      state.phase = "done";
      return state;
    });

    const state = createInitialState("test");
    state.gitStartingSha = "already-set";
    state.gitBranch = "feat/existing";
    const ctx = makeCtx();
    await runWorkflowLoop(state, ctx);

    expect(mockGitPreflight).not.toHaveBeenCalled();
  });

  it("offers stash/continue/abort when repo is dirty", async () => {
    mockGitPreflight.mockResolvedValue({
      clean: false, branch: "feat/work", isMainBranch: false,
      sha: "abc123", uncommittedFiles: ["src/a.ts"], warnings: [],
    });
    mockBrainstorm.mockImplementation(async (state) => {
      state.phase = "done";
      return state;
    });

    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Continue anyway");

    const state = createInitialState("test");
    const result = await runWorkflowLoop(state, ctx);

    expect(ctx.ui.select).toHaveBeenCalled();
    expect(result.gitStartingSha).toBe("abc123");
  });

  it("aborts when user selects Abort on dirty repo", async () => {
    mockGitPreflight.mockResolvedValue({
      clean: false, branch: "feat/work", isMainBranch: false,
      sha: "abc123", uncommittedFiles: ["src/a.ts"], warnings: [],
    });

    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Abort");

    const state = createInitialState("test");
    const result = await runWorkflowLoop(state, ctx);

    expect(result.phase).toBe("done");
    expect(result.error).toContain("Abort");
  });

  it("offers branch creation when on main branch", async () => {
    mockGitPreflight.mockResolvedValue({
      clean: true, branch: "main", isMainBranch: true,
      sha: "abc123", uncommittedFiles: [], warnings: ["On main branch"],
    });
    mockBrainstorm.mockImplementation(async (state) => {
      state.phase = "done";
      return state;
    });

    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Continue on main");

    const state = createInitialState("test");
    const result = await runWorkflowLoop(state, ctx);

    expect(ctx.ui.select).toHaveBeenCalled();
    const selectArgs = ctx.ui.select.mock.calls[0];
    expect(selectArgs[1]).toEqual(expect.arrayContaining(["Continue on main"]));
  });
});
```

Note: You'll also need to import `createInitialState` and `runWorkflowLoop` — check the existing imports in the test file.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/orchestrator.test.ts -v`
Expected: FAIL — `runGitPreflight` was not called.

**Step 3: Write minimal implementation**

Modify `src/workflow/orchestrator.ts`. Add import at top:

```typescript
import { runGitPreflight } from "./git-preflight.js";
```

Add preflight call at the start of `runWorkflowLoop`, right before the `while` loop:

```typescript
export async function runWorkflowLoop(
	state: OrchestratorState,
	ctx: Ctx,
	signal?: AbortSignal,
): Promise<OrchestratorState> {
	const ui = (ctx as any).ui;

	// Git preflight — only on first run (not resume)
	if (!state.gitStartingSha) {
		try {
			const preflight = await runGitPreflight(ctx.cwd);
			
			// Dirty repo check
			if (!preflight.clean && ui?.select) {
				const dirtyChoice = await ui.select(
					`Working tree has uncommitted changes: ${preflight.uncommittedFiles.join(", ")}`,
					["Stash changes", "Continue anyway", "Abort"],
				);
				if (dirtyChoice === "Abort") {
					state.phase = "done";
					state.error = "Aborted: dirty working tree";
					saveState(state, ctx.cwd);
					return state;
				}
				if (dirtyChoice === "Stash changes") {
					const { execFile: execFileCb } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const exec = promisify(execFileCb);
					await exec("git", ["stash", "push", "-m", "superteam-workflow-preflight"], { cwd: ctx.cwd });
				}
			}

			// Main branch check
			if (preflight.isMainBranch && ui?.select) {
				const branchChoice = await ui.select(
					`On ${preflight.branch} branch. Create a workflow branch?`,
					["Create workflow branch", "Continue on main", "Abort"],
				);
				if (branchChoice === "Abort") {
					state.phase = "done";
					state.error = "Aborted: on main branch";
					saveState(state, ctx.cwd);
					return state;
				}
				if (branchChoice === "Create workflow branch") {
					const slug = state.userDescription
						.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
					const branchName = `workflow/${slug}`;
					const { execFile: execFileCb } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const exec = promisify(execFileCb);
					await exec("git", ["checkout", "-b", branchName], { cwd: ctx.cwd });
					ui?.notify?.(`Created branch: ${branchName}`, "info");
				}
			}

			state.gitStartingSha = preflight.sha;
			state.gitBranch = preflight.branch;
			saveState(state, ctx.cwd);
		} catch (err: any) {
			// Non-fatal — not a git repo or git not available
			ui?.notify?.(`Git preflight skipped: ${err.message}`, "info");
		}
	}

	while (state.phase !== "done") {
		// ... existing loop unchanged
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/orchestrator.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/orchestrator.ts src/workflow/orchestrator.test.ts
git commit -m "feat(git): integrate git preflight into workflow loop"
```

---

## Task 4: Add `squashTaskCommits()` to `git-utils.ts`

**Files:**
- Modify: `src/workflow/git-utils.ts`
- Modify: `src/workflow/git-utils.test.ts`

**Step 1: Write the failing test**

Add to `src/workflow/git-utils.test.ts`:

```typescript
import { squashTaskCommits } from "./git-utils.ts";

describe("squashTaskCommits", () => {
  it("stages unstaged changes, squashes commits, returns new SHA", async () => {
    const dir = await makeTempRepo();
    const baseSha = await getCurrentSha(dir);

    // Make two commits (simulating implementer TDD cycles)
    fs.writeFileSync(path.join(dir, "src.ts"), "impl");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "wip: red"], { cwd: dir });

    fs.writeFileSync(path.join(dir, "test.ts"), "test");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "wip: green"], { cwd: dir });

    const result = await squashTaskCommits(dir, baseSha, 1, "Add widget");
    expect(result.success).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    // Verify single squashed commit on top of initial
    const { stdout } = await run("git", ["log", "--oneline"], { cwd: dir });
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(2); // initial + squashed
    expect(lines[0]).toContain("workflow: task 1");
    expect(lines[0]).toContain("Add widget");

    // Files still exist
    expect(fs.existsSync(path.join(dir, "src.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "test.ts"))).toBe(true);
  });

  it("handles unstaged changes by committing them before squash", async () => {
    const dir = await makeTempRepo();
    const baseSha = await getCurrentSha(dir);

    fs.writeFileSync(path.join(dir, "a.ts"), "committed");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "wip"], { cwd: dir });

    // Leave an unstaged file
    fs.writeFileSync(path.join(dir, "b.ts"), "unstaged");

    const result = await squashTaskCommits(dir, baseSha, 2, "Another task");
    expect(result.success).toBe(true);

    // Both files present after squash
    expect(fs.existsSync(path.join(dir, "a.ts"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "b.ts"))).toBe(true);
  });

  it("returns success with current SHA when no changes since baseSha", async () => {
    const dir = await makeTempRepo();
    const sha = await getCurrentSha(dir);

    const result = await squashTaskCommits(dir, sha, 3, "No changes");
    expect(result.success).toBe(true);
    expect(result.sha).toBe(sha);
  });

  it("returns error for non-repo directory", async () => {
    const dir = makeTempDir();
    const result = await squashTaskCommits(dir, "abc", 1, "Test");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/git-utils.test.ts -v`
Expected: FAIL — `squashTaskCommits` is not exported from git-utils.

**Step 3: Write minimal implementation**

Add to `src/workflow/git-utils.ts`:

```typescript
/**
 * Squash all commits since baseSha into one clean workflow commit.
 * Stages any unstaged changes first. Returns the new SHA.
 */
export async function squashTaskCommits(
  cwd: string,
  baseSha: string,
  taskId: number,
  taskTitle: string,
): Promise<{ sha: string; success: boolean; error?: string }> {
  try {
    const currentSha = await getCurrentSha(cwd);
    if (!currentSha) return { sha: "", success: false, error: "Could not get current SHA" };

    // Stage any unstaged changes
    await execFile("git", ["add", "-A"], { cwd, timeout: 5000 });

    // Check if there are staged changes to commit
    try {
      const { stdout: statusOut } = await execFile("git", ["status", "--porcelain"], { cwd, timeout: 5000 });
      if (statusOut.trim()) {
        await execFile("git", ["commit", "-m", "wip"], { cwd, timeout: 5000 });
      }
    } catch {
      // No staged changes — fine
    }

    // Check if HEAD moved from baseSha
    const headNow = await getCurrentSha(cwd);
    if (headNow === baseSha) {
      return { sha: baseSha, success: true };
    }

    const message = `workflow: task ${taskId} — ${taskTitle}`;
    const squashed = await squashCommitsSince(cwd, baseSha, message);
    if (!squashed) {
      return { sha: headNow, success: false, error: "squashCommitsSince failed" };
    }

    const newSha = await getCurrentSha(cwd);
    return { sha: newSha, success: true };
  } catch (err: any) {
    return { sha: "", success: false, error: err.message };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/git-utils.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/git-utils.ts src/workflow/git-utils.test.ts
git commit -m "feat(git): add squashTaskCommits helper"
```

---

## Task 5: Add `commitSha` to `TaskExecState` and integrate squash into execute.ts

**Files:**
- Modify: `src/workflow/orchestrator-state.ts:63-69` (TaskExecState type)
- Modify: `src/workflow/phases/execute.ts`
- Modify: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing test**

Add `commitSha` to the `TaskExecState` type first (it's optional, so existing tests won't break). Then add test to `execute.test.ts`:

```typescript
// Add squashTaskCommits to the git-utils mock at top of execute.test.ts:
vi.mock("../git-utils.js", () => ({
  getCurrentSha: vi.fn(),
  computeChangedFiles: vi.fn(),
  resetToSha: vi.fn(),
  squashTaskCommits: vi.fn(),
}));

import { squashTaskCommits } from "../git-utils.ts";
const mockSquashTaskCommits = vi.mocked(squashTaskCommits);

// Add to setupDefaultMocks():
mockSquashTaskCommits.mockResolvedValue({ sha: "squashed123", success: true });

// Add test case inside "task completion" describe:
it("squashes commits after task completion and stores commitSha", async () => {
  setupDefaultMocks();
  const state = makeState();
  const result = await runExecutePhase(state, fakeCtx);

  expect(mockSquashTaskCommits).toHaveBeenCalledWith(
    "/fake/project",
    "abc123",  // gitShaBeforeImpl
    1,         // task id
    "Task 1",  // task title
  );
  expect(result.tasks[0].commitSha).toBe("squashed123");
});

it("warns but does not block when squash fails", async () => {
  setupDefaultMocks();
  mockSquashTaskCommits.mockResolvedValue({ sha: "", success: false, error: "squash error" });

  const ctx = makeCtx();
  const state = makeState();
  const result = await runExecutePhase(state, ctx);

  expect(result.tasks[0].status).toBe("complete");
  expect(result.tasks[0].commitSha).toBeUndefined();
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("squash"), "warning");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: FAIL — `squashTaskCommits` not called, `commitSha` not set.

**Step 3: Write minimal implementation**

In `src/workflow/orchestrator-state.ts`, add to `TaskExecState`:

```typescript
export type TaskExecState = {
  // ... existing fields ...
  summary?: { title: string; status: string; changedFiles: string[] };
  commitSha?: string;
};
```

In `src/workflow/phases/execute.ts`, add import:

```typescript
import { getCurrentSha, computeChangedFiles, resetToSha, squashTaskCommits } from "../git-utils.js";
```

After `task.status = "complete"` (section h), add squash:

```typescript
		// h. COMPLETE
		task.status = "complete";

		// h1. SQUASH COMMITS
		if (task.gitShaBeforeImpl) {
			const squashResult = await squashTaskCommits(ctx.cwd, task.gitShaBeforeImpl, task.id, task.title);
			if (squashResult.success) {
				task.commitSha = squashResult.sha;
			} else {
				ui?.notify?.(`Warning: commit squash failed for task ${task.id}: ${squashResult.error}`, "warning");
			}
		}

		state.currentTaskIndex = i + 1;
		saveState(state, ctx.cwd);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/orchestrator-state.ts src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat(git): squash implementer commits after task completion"
```

---

## Task 6: Enhanced rollback — show what will be lost and reset task state

**Files:**
- Modify: `src/workflow/phases/execute.ts` (escalate function)
- Modify: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing test**

Add to execute.test.ts "escalate with rollback option" describe:

```typescript
it("resets task metadata on rollback for clean retry", async () => {
  setupDefaultMocks();
  mockGetCurrentSha.mockResolvedValue("abc123sha");
  mockResetToSha.mockResolvedValue(true);
  mockComputeChangedFiles.mockResolvedValue(["src/changed.ts", "src/other.ts"]);

  // First impl fails → Rollback → retry succeeds
  let implCallCount = 0;
  mockDispatchAgent.mockImplementation(async (agent) => {
    if (agent.name === "implementer") {
      implCallCount++;
      if (implCallCount === 1) return makeResult({ exitCode: 1, errorMessage: "Failed" });
    }
    return makeResult();
  });
  mockParseReviewOutput.mockReturnValue({
    status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
  });

  const ctx = makeCtx();
  ctx.ui.select.mockResolvedValueOnce("Rollback");

  const state = makeState({
    tasks: [makeTask({
      reviewsPassed: ["spec"],
      reviewsFailed: ["quality"],
      fixAttempts: 2,
    })],
  });
  const result = await runExecutePhase(state, ctx);

  // After rollback, task retries and completes
  expect(result.tasks[0].status).toBe("complete");
  // Verify notify was called with file count info
  expect(ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("Rolling back"),
    "info",
  );
});

it("notifies how many files will be reverted on rollback", async () => {
  setupDefaultMocks();
  mockGetCurrentSha.mockResolvedValue("abc123sha");
  mockResetToSha.mockResolvedValue(true);
  mockComputeChangedFiles.mockResolvedValue(["a.ts", "b.ts", "c.ts"]);

  mockDispatchAgent.mockResolvedValue(makeResult({ exitCode: 1, errorMessage: "Failed" }));

  const ctx = makeCtx();
  ctx.ui.select
    .mockResolvedValueOnce("Rollback")
    .mockResolvedValueOnce("Skip");

  const state = makeState();
  await runExecutePhase(state, ctx);

  // Check that notify mentioned the file count
  const notifyCalls = ctx.ui.notify.mock.calls.map((c: any) => c[0]);
  const rollbackNotify = notifyCalls.find((msg: string) => msg.includes("Rolling back"));
  expect(rollbackNotify).toContain("3 files");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: FAIL — rollback doesn't show file count or reset metadata.

**Step 3: Write minimal implementation**

Update the `escalate()` function in `src/workflow/phases/execute.ts`:

```typescript
async function escalate(
	task: TaskExecState,
	reason: string,
	ui: any,
	cwd: string,
): Promise<"retry" | "skip" | "abort"> {
	if (!ui?.select) {
		return "skip";
	}

	const choice = await ui.select(
		`Task "${task.title}" needs attention: ${reason}`,
		["Retry", "Rollback", "Skip", "Abort"],
	);

	if (choice === "Abort") return "abort";
	if (choice === "Skip") return "skip";
	if (choice === "Rollback") {
		if (task.gitShaBeforeImpl) {
			const files = await computeChangedFiles(cwd, task.gitShaBeforeImpl);
			ui?.notify?.(
				`Rolling back task "${task.title}": reverting ${files.length} files to ${task.gitShaBeforeImpl.slice(0, 7)}`,
				"info",
			);
			await resetToSha(cwd, task.gitShaBeforeImpl);
			// Reset task state for clean retry
			task.reviewsPassed = [];
			task.reviewsFailed = [];
			task.fixAttempts = 0;
		}
		return "retry";
	}
	return "retry";
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat(git): enhanced rollback with file count and task state reset"
```

---

## Task 7: Parallel spec + quality reviews — replace sequential `runReviewLoop` calls

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Modify: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing tests**

Add new describe block in `execute.test.ts`:

```typescript
describe("parallel reviews (D4)", () => {
  it("dispatches spec and quality reviews in parallel via dispatchParallel", async () => {
    setupDefaultMocks();
    // Override to use dispatchParallel for required reviews
    mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
    mockGetFinalOutput.mockReturnValue('```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```');
    mockParseReviewOutput.mockReturnValue({
      status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
    });

    const state = makeState();
    const result = await runExecutePhase(state, fakeCtx);

    // dispatchParallel should be called at least once for spec+quality
    expect(mockDispatchParallel).toHaveBeenCalled();
    const parallelCall = mockDispatchParallel.mock.calls[0];
    const agentNames = parallelCall[0].map((a: any) => a.name);
    expect(agentNames).toContain("spec-reviewer");
    expect(agentNames).toContain("quality-reviewer");
    expect(result.tasks[0].status).toBe("complete");
  });

  it("re-runs BOTH reviews after a fix when one fails", async () => {
    setupDefaultMocks();
    let parallelCallCount = 0;
    mockDispatchParallel.mockImplementation(async () => {
      parallelCallCount++;
      return [makeResult(), makeResult()];
    });

    // First parallel: spec passes, quality fails. Second parallel: both pass.
    mockParseReviewOutput
      .mockReturnValueOnce({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } })
      .mockReturnValueOnce({ status: "fail", findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" } })
      .mockReturnValue({ status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" } });

    const state = makeState();
    const result = await runExecutePhase(state, fakeCtx);

    // Two parallel dispatches: initial + after fix
    expect(parallelCallCount).toBe(2);
    expect(result.tasks[0].status).toBe("complete");
  });

  it("escalates after maxRetries when reviews keep failing", async () => {
    setupDefaultMocks();
    mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
    mockParseReviewOutput.mockReturnValue({
      status: "fail",
      findings: { passed: false, findings: [{ severity: "high", file: "a.ts", issue: "bad" }], mustFix: ["fix"], summary: "fail" },
    });

    const ctx = makeCtx();
    ctx.ui.select.mockResolvedValue("Skip");
    const state = makeState({
      config: {
        tddMode: "tdd", reviewMode: "iterative", executionMode: "auto",
        batchSize: 3, maxPlanReviewCycles: 3, maxTaskReviewCycles: 2,
      },
    });
    const result = await runExecutePhase(state, ctx);

    expect(ctx.ui.select).toHaveBeenCalled();
    expect(result.tasks[0].status).toBe("skipped");
  });

  it("completes when both reviews pass first try — no fix loop", async () => {
    setupDefaultMocks();
    mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
    mockParseReviewOutput.mockReturnValue({
      status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
    });

    const state = makeState();
    const result = await runExecutePhase(state, fakeCtx);

    expect(result.tasks[0].fixAttempts).toBe(0);
    expect(result.tasks[0].status).toBe("complete");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: FAIL — `dispatchParallel` not called for spec+quality reviews (still sequential).

**Step 3: Write minimal implementation**

Replace the sequential spec review (section e) and quality review (section f) in execute.ts with a parallel review function. Replace the two `runReviewLoop` calls (sections e and f) with:

```typescript
		// e+f. PARALLEL SPEC + QUALITY REVIEW
		{
			const reviewResult = await runParallelReviewLoop(
				state, task, specReviewer, qualityReviewer, implementer,
				changedFiles, maxRetries, ctx, signal, ui, makeOnStreamEvent,
			);
			if (reviewResult === "escalated") return state;
		}
```

Add the new function above `runReviewLoop` (or replace the call sites):

```typescript
async function runParallelReviewLoop(
	state: OrchestratorState,
	task: TaskExecState,
	specReviewer: AgentProfile | undefined,
	qualityReviewer: AgentProfile | undefined,
	implementer: AgentProfile,
	changedFiles: string[],
	maxRetries: number,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	ui: any,
	makeOnStreamEvent: () => OnStreamEvent,
): Promise<"passed" | "escalated"> {
	// If neither reviewer exists, auto-pass
	const reviewers: AgentProfile[] = [];
	const reviewNames: string[] = [];
	if (specReviewer) { reviewers.push(specReviewer); reviewNames.push("spec"); }
	if (qualityReviewer) { reviewers.push(qualityReviewer); reviewNames.push("quality"); }

	if (reviewers.length === 0) {
		task.reviewsPassed.push("spec", "quality");
		return "passed";
	}

	task.status = "reviewing";
	saveState(state, ctx.cwd);

	let currentChangedFiles = changedFiles;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		// Build prompts for each reviewer
		const prompts = reviewers.map((r, i) => {
			if (reviewNames[i] === "spec") return buildSpecReviewPrompt(task, currentChangedFiles);
			return buildQualityReviewPrompt(task, currentChangedFiles);
		});

		// Dispatch in parallel
		const results = await dispatchParallel(reviewers, prompts, ctx.cwd, signal);
		for (const r of results) {
			state.totalCostUsd += r.usage.cost;
		}

		// Parse results
		const parsed: ParseResult[] = results.map(r => {
			const output = getFinalOutput(r.messages);
			return parseReviewOutput(output);
		});

		// Check if all passed
		const allPassed = parsed.every(p => p.status === "pass");
		if (allPassed) {
			for (const name of reviewNames) {
				if (!task.reviewsPassed.includes(name)) task.reviewsPassed.push(name);
			}
			return "passed";
		}

		// Check for inconclusive
		const inconclusive = parsed.find(p => p.status === "inconclusive");
		if (inconclusive) {
			const parseError = inconclusive.status === "inconclusive" ? inconclusive.parseError : "unknown";
			const escalation = await escalate(task, `Review inconclusive: ${parseError}`, ui, ctx.cwd);
			if (escalation === "abort") { state.error = "Aborted by user"; saveState(state, ctx.cwd); return "escalated"; }
			if (escalation === "skip") { task.status = "skipped"; saveState(state, ctx.cwd); return "escalated"; }
			continue;
		}

		// Collect all failures
		if (attempt < maxRetries - 1) {
			task.status = "fixing";
			task.fixAttempts++;
			saveState(state, ctx.cwd);

			// Merge findings from all failed reviews
			const allFindings: string[] = [];
			for (let i = 0; i < parsed.length; i++) {
				if (parsed[i].status === "fail") {
					const p = parsed[i] as { status: "fail"; findings: ReviewFindings };
					allFindings.push(formatFindings(p.findings, reviewNames[i]));
				}
			}

			const fixResult = await dispatchAgent(
				implementer,
				buildFixPrompt(task, "spec+quality", parsed.find(p => p.status === "fail")!.findings as ReviewFindings, currentChangedFiles),
				ctx.cwd, signal, undefined, makeOnStreamEvent(),
			);
			state.totalCostUsd += fixResult.usage.cost;

			currentChangedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);
			task.status = "reviewing";
			saveState(state, ctx.cwd);
		} else {
			const escalation = await escalate(task, `Reviews failed after ${maxRetries} attempts`, ui, ctx.cwd);
			if (escalation === "abort") { state.error = "Aborted by user"; saveState(state, ctx.cwd); return "escalated"; }
			if (escalation === "skip") { task.status = "skipped"; saveState(state, ctx.cwd); return "escalated"; }
		}
	}

	return "passed";
}
```

**Important:** You'll need to add the `ParseResult` and `ReviewFindings` types to the import from `review-parser.js`. The existing import already has `ParseResult` as an implicit type — add it explicitly:

```typescript
import { parseReviewOutput, formatFindings, hasCriticalFindings, type ReviewFindings, type ParseResult } from "../../review-parser.js";
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: PASS. Note: some existing tests that relied on sequential dispatch ordering will need adjustment. The key changes are:
- Tests that check `dispatchAgent` call order for spec→quality may now see `dispatchParallel` instead
- The `setupDefaultMocks` should add a default for `mockSquashTaskCommits`

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing (after adjusting existing tests for parallel dispatch)

**Step 6: Commit**

```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat(reviews): parallelize spec + quality reviews with full re-review after fixes"
```

---

## Task 8: Add `computeProgressSummary()` and `formatProgressSummary()` to `progress.ts`

**Files:**
- Modify: `src/workflow/progress.ts`
- Modify: `src/workflow/progress.test.ts`

**Step 1: Write the failing test**

Add to `src/workflow/progress.test.ts`:

```typescript
describe("computeProgressSummary", () => {
  it("computes correct counts for mixed task states", async () => {
    const { computeProgressSummary } = await import("./progress.js");
    const state = makeState({
      phase: "execute",
      totalCostUsd: 1.50,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "complete" },
        { id: 3, title: "C", status: "skipped" },
        { id: 4, title: "D", status: "implementing" },
        { id: 5, title: "E", status: "pending" },
      ],
      currentTaskIndex: 3,
    });

    const summary = computeProgressSummary(state);
    expect(summary.tasksCompleted).toBe(2);
    expect(summary.tasksRemaining).toBe(2); // implementing + pending
    expect(summary.tasksSkipped).toBe(1);
    expect(summary.cumulativeCost).toBe(1.50);
    expect(summary.currentTaskTitle).toBe("D");
  });

  it("estimates remaining cost based on average", async () => {
    const { computeProgressSummary } = await import("./progress.js");
    const state = makeState({
      totalCostUsd: 3.00,
      tasks: [
        { id: 1, title: "A", status: "complete" },
        { id: 2, title: "B", status: "complete" },
        { id: 3, title: "C", status: "complete" },
        { id: 4, title: "D", status: "pending" },
        { id: 5, title: "E", status: "pending" },
        { id: 6, title: "F", status: "pending" },
      ],
      currentTaskIndex: 3,
    });

    const summary = computeProgressSummary(state);
    // 3.00 / 3 completed * 3 remaining = 3.00
    expect(summary.estimatedRemainingCost).toBeCloseTo(3.00, 1);
  });

  it("returns 0 estimated cost when no tasks completed", async () => {
    const { computeProgressSummary } = await import("./progress.js");
    const state = makeState({
      totalCostUsd: 0,
      tasks: [{ id: 1, title: "A", status: "pending" }],
      currentTaskIndex: 0,
    });

    const summary = computeProgressSummary(state);
    expect(summary.estimatedRemainingCost).toBe(0);
  });
});

describe("formatProgressSummary", () => {
  it("formats a readable progress line", async () => {
    const { formatProgressSummary } = await import("./progress.js");
    const summary = {
      tasksCompleted: 3,
      tasksRemaining: 2,
      tasksSkipped: 1,
      cumulativeCost: 1.50,
      estimatedRemainingCost: 1.00,
      currentTaskTitle: "Add widget",
    };

    const formatted = formatProgressSummary(summary);
    expect(formatted).toContain("3");
    expect(formatted).toContain("2");
    expect(formatted).toContain("$1.50");
    expect(formatted).toContain("$1.00");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/progress.test.ts -v`
Expected: FAIL — `computeProgressSummary` and `formatProgressSummary` don't exist.

**Step 3: Write minimal implementation**

Add to `src/workflow/progress.ts`:

```typescript
// --- Task progress summary (D5) ---

export interface TaskProgressSummary {
  tasksCompleted: number;
  tasksRemaining: number;
  tasksSkipped: number;
  cumulativeCost: number;
  estimatedRemainingCost: number;
  currentTaskTitle: string;
}

export function computeProgressSummary(state: ProgressState): TaskProgressSummary {
  const tasksCompleted = state.tasks.filter(t => t.status === "complete").length;
  const tasksSkipped = state.tasks.filter(t => t.status === "skipped").length;
  const tasksRemaining = state.tasks.length - tasksCompleted - tasksSkipped;
  const cumulativeCost = state.totalCostUsd;

  const avgCostPerTask = tasksCompleted > 0 ? cumulativeCost / tasksCompleted : 0;
  const estimatedRemainingCost = avgCostPerTask * tasksRemaining;

  const currentTask = state.tasks[state.currentTaskIndex];
  const currentTaskTitle = currentTask?.title ?? "";

  return {
    tasksCompleted,
    tasksRemaining,
    tasksSkipped,
    cumulativeCost,
    estimatedRemainingCost,
    currentTaskTitle,
  };
}

export function formatProgressSummary(summary: TaskProgressSummary): string {
  const parts = [
    `Progress: ${summary.tasksCompleted} done, ${summary.tasksRemaining} remaining`,
  ];
  if (summary.tasksSkipped > 0) {
    parts[0] += `, ${summary.tasksSkipped} skipped`;
  }
  parts.push(`Cost: $${summary.cumulativeCost.toFixed(2)} (est. remaining: $${summary.estimatedRemainingCost.toFixed(2)})`);
  return parts.join(" | ");
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/progress.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/progress.ts src/workflow/progress.test.ts
git commit -m "feat(progress): add computeProgressSummary and formatProgressSummary"
```

---

## Task 9: Integrate progress summary display into execute.ts

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Modify: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing test**

Add to `execute.test.ts`:

```typescript
// Add mock for progress at top, alongside existing mocks:
vi.mock("../progress.js", () => ({
  writeProgressFile: vi.fn(),
  computeProgressSummary: vi.fn(),
  formatProgressSummary: vi.fn(),
}));

import { computeProgressSummary, formatProgressSummary } from "../progress.ts";
const mockComputeProgressSummary = vi.mocked(computeProgressSummary);
const mockFormatProgressSummary = vi.mocked(formatProgressSummary);

// Add to setupDefaultMocks():
mockComputeProgressSummary.mockReturnValue({
  tasksCompleted: 1, tasksRemaining: 0, tasksSkipped: 0,
  cumulativeCost: 0.03, estimatedRemainingCost: 0, currentTaskTitle: "Task 1",
});
mockFormatProgressSummary.mockReturnValue("Progress: 1 done, 0 remaining | Cost: $0.03");

// Add test:
describe("progress summary display (D5)", () => {
  it("displays progress summary after each task completion", async () => {
    setupDefaultMocks();
    const ctx = makeCtx();
    const state = makeState();
    const result = await runExecutePhase(state, ctx);

    expect(mockComputeProgressSummary).toHaveBeenCalled();
    expect(mockFormatProgressSummary).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Progress"),
      "info",
    );
  });

  it("populates task.summary with title, status, and changedFiles", async () => {
    setupDefaultMocks();
    mockComputeChangedFiles.mockResolvedValue(["src/a.ts", "test/a.test.ts"]);

    const state = makeState();
    const result = await runExecutePhase(state, fakeCtx);

    expect(result.tasks[0].summary).toBeDefined();
    expect(result.tasks[0].summary!.title).toBe("Task 1");
    expect(result.tasks[0].summary!.status).toBe("complete");
    expect(result.tasks[0].summary!.changedFiles).toContain("src/a.ts");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: FAIL — `computeProgressSummary` not called, `task.summary` not populated.

**Step 3: Write minimal implementation**

In `src/workflow/phases/execute.ts`, add import:

```typescript
import { computeProgressSummary, formatProgressSummary } from "../progress.js";
```

After the squash step (h1) in the task completion section, add:

```typescript
		// h1b. PROGRESS SUMMARY
		{
			const taskChangedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);
			task.summary = {
				title: task.title,
				status: task.status,
				changedFiles: taskChangedFiles,
			};
			const summary = computeProgressSummary(state);
			const formatted = formatProgressSummary(summary);
			ui?.notify?.(formatted, "info");
		}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat(progress): display post-task progress summary"
```

---

## Task 10: Extend `buildImplPrompt()` to accept array of prior tasks (D6)

**Files:**
- Modify: `src/workflow/prompt-builder.ts`
- Modify: `src/workflow/prompt-builder.test.ts`

**Step 1: Write the failing test**

Add to `src/workflow/prompt-builder.test.ts`:

```typescript
describe("buildImplPrompt prior task context (D6)", () => {
  it("includes last 5 prior tasks when provided as array", () => {
    const task = makeTask();
    const priorTasks = Array.from({ length: 7 }, (_, i) => ({
      title: `Task ${i + 1}`,
      status: "complete",
      changedFiles: [`src/file${i + 1}.ts`],
    }));

    const result = buildImplPrompt(task, "ctx", undefined, priorTasks);
    expect(result).toContain("## Prior tasks");
    // Should only have last 5 (tasks 3-7)
    expect(result).not.toContain("Task 1");
    expect(result).not.toContain("Task 2");
    expect(result).toContain("Task 3");
    expect(result).toContain("Task 7");
    expect(result).toContain("src/file7.ts");
  });

  it("includes all prior tasks when fewer than 5", () => {
    const task = makeTask();
    const priorTasks = [
      { title: "Setup", status: "complete", changedFiles: ["src/setup.ts"] },
      { title: "Config", status: "complete", changedFiles: ["src/config.ts"] },
    ];

    const result = buildImplPrompt(task, "ctx", undefined, priorTasks);
    expect(result).toContain("Setup");
    expect(result).toContain("Config");
  });

  it("omits prior tasks section when array is empty", () => {
    const task = makeTask();
    const result = buildImplPrompt(task, "ctx", undefined, []);
    expect(result).not.toContain("## Prior tasks");
  });

  it("still supports legacy single previousTaskSummary", () => {
    const task = makeTask();
    const summary = { title: "Legacy", status: "complete", changedFiles: ["src/old.ts"] };
    const result = buildImplPrompt(task, "ctx", summary);
    expect(result).toContain("## Previous task");
    expect(result).toContain("Legacy");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/prompt-builder.test.ts -v`
Expected: FAIL — `buildImplPrompt` doesn't accept 4th parameter / doesn't render prior tasks.

**Step 3: Write minimal implementation**

Update `buildImplPrompt` in `src/workflow/prompt-builder.ts`:

```typescript
export function buildImplPrompt(
	task: TaskExecState,
	planContext: string,
	previousTaskSummary?: { title: string; status: string; changedFiles: string[] },
	priorTasks?: Array<{ title: string; status: string; changedFiles: string[] }>,
): string {
	const parts = [
		`## Task: ${task.title}`,
		``,
		task.description,
		``,
		`## Files`,
		task.files.map((f) => `- ${f}`).join("\n"),
		``,
		`## Plan context`,
		planContext,
		``,
	];

	// New: array of prior tasks (capped at 5)
	if (priorTasks && priorTasks.length > 0) {
		const capped = priorTasks.slice(-5);
		parts.push(`## Prior tasks`);
		for (const pt of capped) {
			parts.push(`**${pt.title}** — ${pt.status}`);
			if (pt.changedFiles.length > 0) {
				parts.push(`Changed: ${pt.changedFiles.join(", ")}`);
			}
		}
		parts.push(``);
	} else if (previousTaskSummary) {
		// Legacy: single previous task
		parts.push(
			`## Previous task`,
			`**${previousTaskSummary.title}** — ${previousTaskSummary.status}`,
			`Changed files:`,
			previousTaskSummary.changedFiles.map((f) => `- ${f}`).join("\n"),
			``,
		);
	}

	parts.push(
		`## Process`,
		`Use strict TDD: write a failing test first, implement minimally, refactor.`,
		`Commit after each green cycle.`,
		`Self-review your changes before reporting done.`,
	);

	return parts.join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/prompt-builder.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/prompt-builder.ts src/workflow/prompt-builder.test.ts
git commit -m "feat(prompt): extend buildImplPrompt to accept array of prior tasks (capped at 5)"
```

---

## Task 11: Wire prior task context into execute.ts (D6)

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Modify: `src/workflow/phases/execute.test.ts`

**Step 1: Write the failing test**

Add to execute.test.ts:

```typescript
describe("context forwarding (D6)", () => {
  it("passes prior completed task summaries to buildImplPrompt", async () => {
    setupDefaultMocks();

    const state = makeState({
      tasks: [
        makeTask({ id: 1, title: "Task 1", status: "complete", summary: { title: "Task 1", status: "complete", changedFiles: ["src/a.ts"] } }),
        makeTask({ id: 2, title: "Task 2", status: "pending" }),
      ],
      currentTaskIndex: 1,
    });

    const result = await runExecutePhase(state, fakeCtx);

    // Check that the impl dispatch for Task 2 includes prior context
    const implCalls = mockDispatchAgent.mock.calls.filter(c => c[0].name === "implementer");
    expect(implCalls.length).toBeGreaterThanOrEqual(1);
    const implPrompt = implCalls[0][1];
    expect(implPrompt).toContain("Prior tasks");
    expect(implPrompt).toContain("Task 1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: FAIL — impl prompt doesn't contain "Prior tasks".

**Step 3: Write minimal implementation**

In execute.ts, modify the implementer dispatch call (section b). Before the `dispatchAgent` call, collect prior tasks:

```typescript
		// b. IMPLEMENT
		// ... existing implementer check ...

		task.gitShaBeforeImpl = await getCurrentSha(ctx.cwd);
		task.status = "implementing";
		saveState(state, ctx.cwd);

		// Collect prior task summaries for context forwarding (D6)
		const priorTasks = state.tasks
			.filter(t => t.status === "complete" && t.summary)
			.slice(-5)
			.map(t => t.summary!);

		const implResult = await dispatchAgent(
			implementer, buildImplPrompt(task, planContext, undefined, priorTasks), ctx.cwd, signal, undefined, makeOnStreamEvent(),
		);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat(context): forward prior task summaries to implementer prompt"
```

---

## Task 12: Add `stripAnsi()` to `parse-utils.ts` (D7)

**Files:**
- Modify: `src/parse-utils.ts`
- Modify: `src/parse-utils.test.ts`

**Step 1: Write the failing test**

Add to `src/parse-utils.test.ts`:

```typescript
import { stripAnsi } from "./parse-utils.js";

describe("stripAnsi", () => {
  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("strips basic color codes (e.g., red)", () => {
    expect(stripAnsi("\x1b[31mred text\x1b[0m")).toBe("red text");
  });

  it("strips bold/bright codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[32mbold green\x1b[0m")).toBe("bold green");
  });

  it("strips multiple ANSI codes in a string", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m and \x1b[34mblue\x1b[0m")).toBe("red and blue");
  });

  it("strips 256-color codes", () => {
    expect(stripAnsi("\x1b[38;5;196mcolor\x1b[0m")).toBe("color");
  });

  it("strips 24-bit RGB color codes", () => {
    expect(stripAnsi("\x1b[38;2;255;0;0mrgb\x1b[0m")).toBe("rgb");
  });

  it("preserves JSON structure with ANSI codes stripped", () => {
    const input = '\x1b[1m```superteam-json\x1b[0m\n{"passed":true}\n\x1b[1m```\x1b[0m';
    const result = stripAnsi(input);
    expect(result).toBe('```superteam-json\n{"passed":true}\n```');
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2Jhello\x1b[H")).toBe("hello");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/parse-utils.test.ts -v`
Expected: FAIL — `stripAnsi` is not exported.

**Step 3: Write minimal implementation**

Add to `src/parse-utils.ts`:

```typescript
/**
 * Strip ANSI escape sequences (colors, cursor, etc.) from text.
 * Handles CSI sequences (\x1b[...X), OSC sequences (\x1b]...\x07), and simple escapes.
 */
export function stripAnsi(text: string): string {
	// CSI sequences: \x1b[ followed by params and a final letter
	// OSC sequences: \x1b] ... \x07 (or \x1b\\)
	// Simple: \x1b followed by a single character
	return text.replace(
		/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[^[\]]/g,
		"",
	);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/parse-utils.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/parse-utils.ts src/parse-utils.test.ts
git commit -m "feat(parser): add stripAnsi utility for ANSI escape code removal"
```

---

## Task 13: Call `stripAnsi()` in `parseReviewOutput()` (D7)

**Files:**
- Modify: `src/review-parser.ts`
- Modify: `src/review-parser.test.ts`

**Step 1: Write the failing test**

Add to `src/review-parser.test.ts`:

```typescript
describe("parseReviewOutput with ANSI codes (D7)", () => {
  it("parses JSON correctly when output contains ANSI color codes", () => {
    const raw = '\x1b[1m```superteam-json\x1b[0m\n\x1b[32m{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\x1b[0m\n\x1b[1m```\x1b[0m';
    const result = parseReviewOutput(raw);
    expect(result.status).toBe("pass");
  });

  it("parses JSON from ANSI-wrapped fenced block", () => {
    const raw = 'Review output:\n\x1b[33m```superteam-json\x1b[0m\n{"passed":false,"findings":[{"severity":"high","file":"a.ts","issue":"bad"}],"mustFix":[],"summary":"issues found"}\n\x1b[33m```\x1b[0m';
    const result = parseReviewOutput(raw);
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.findings.findings).toHaveLength(1);
    }
  });

  it("parses fallback brace-match when ANSI codes wrap JSON object", () => {
    const raw = 'Output: \x1b[36m{"passed":true,"findings":[],"mustFix":[],"summary":"clean"}\x1b[0m';
    const result = parseReviewOutput(raw);
    expect(result.status).toBe("pass");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/review-parser.test.ts -v`
Expected: FAIL — ANSI codes prevent fence/brace matching.

**Step 3: Write minimal implementation**

In `src/review-parser.ts`, add import:

```typescript
import {
	extractFencedBlock,
	extractLastBraceBlock,
	sanitizeJsonNewlines,
	stripAnsi,
} from "./parse-utils.js";
```

Add `stripAnsi` call at the top of `parseReviewOutput`:

```typescript
export function parseReviewOutput(rawOutput: string): ParseResult {
	// Strip ANSI escape codes that reviewers may emit from subprocess output
	const cleanOutput = stripAnsi(rawOutput);

	// Try fenced block first
	const fenced = extractFencedBlock(cleanOutput, "superteam-json");
	if (fenced) {
		return parseAndValidate(fenced, rawOutput);
	}

	// Fallback: last brace-matched block
	const braceMatch = extractLastBraceBlock(cleanOutput);
	if (braceMatch) {
		return parseAndValidate(braceMatch, rawOutput);
	}

	return {
		status: "inconclusive",
		rawOutput,
		parseError: "No ```superteam-json block or JSON object found in reviewer output",
	};
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/review-parser.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/review-parser.ts src/review-parser.test.ts
git commit -m "feat(parser): strip ANSI codes before parsing review output"
```

---

## Task 14: Add test-file-only check instruction to `buildSpecReviewPrompt()` (D8a)

**Files:**
- Modify: `src/workflow/prompt-builder.ts`
- Modify: `src/workflow/prompt-builder.test.ts`

**Step 1: Write the failing test**

Add to `src/workflow/prompt-builder.test.ts` inside the "buildSpecReviewPrompt" describe:

```typescript
it("includes test-file-only check instruction (D8a)", () => {
  const task = makeTask();
  const result = buildSpecReviewPrompt(task, ["src/widget.test.ts"]);
  expect(result.toLowerCase()).toContain("only test files");
  expect(result.toLowerCase()).toContain("implementation files");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/prompt-builder.test.ts -v`
Expected: FAIL — prompt doesn't contain "only test files" instruction.

**Step 3: Write minimal implementation**

Update `buildSpecReviewPrompt` in `src/workflow/prompt-builder.ts` — add the instruction at the end:

```typescript
export function buildSpecReviewPrompt(task: TaskExecState, changedFiles: string[]): string {
	return [
		`## Spec review for: ${task.title}`,
		``,
		`### Task spec`,
		task.description,
		``,
		`### Files to read`,
		changedFiles.map((f) => `- ${f}`).join("\n"),
		``,
		`Only review files listed below — do not review test files unless the task description explicitly targets test code.`,
		`Read these files. Compare implementation against spec.`,
		`Do NOT trust the implementer's self-report — verify independently.`,
		``,
		`Verify that implementation files were modified, not only test files. If only test files changed, flag as a critical finding.`,
	].join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/prompt-builder.test.ts -v`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: 439+ tests passing

**Step 6: Commit**

```bash
git add src/workflow/prompt-builder.ts src/workflow/prompt-builder.test.ts
git commit -m "feat(review): add test-file-only check instruction to spec review prompt"
```

---

## Task 15: Final integration test and cleanup

**Files:**
- Modify: `src/workflow/phases/execute.test.ts` (verify full flow)

**Step 1: Write integration test**

Add to `execute.test.ts`:

```typescript
describe("full D1-D8 integration", () => {
  it("complete task flow: impl → parallel review → squash → summary → advance", async () => {
    setupDefaultMocks();
    mockDispatchParallel.mockResolvedValue([makeResult(), makeResult()]);
    mockParseReviewOutput.mockReturnValue({
      status: "pass", findings: { passed: true, findings: [], mustFix: [], summary: "ok" },
    });
    mockSquashTaskCommits.mockResolvedValue({ sha: "squashed-sha", success: true });
    mockComputeProgressSummary.mockReturnValue({
      tasksCompleted: 1, tasksRemaining: 0, tasksSkipped: 0,
      cumulativeCost: 0.05, estimatedRemainingCost: 0, currentTaskTitle: "Task 1",
    });
    mockFormatProgressSummary.mockReturnValue("Progress: 1 done");

    const state = makeState({
      tasks: [makeTask({ id: 1, title: "Task 1", status: "pending" })],
    });
    const result = await runExecutePhase(state, fakeCtx);

    // Verify complete flow
    expect(result.tasks[0].status).toBe("complete");
    expect(result.tasks[0].commitSha).toBe("squashed-sha");
    expect(result.tasks[0].summary).toBeDefined();
    expect(mockDispatchParallel).toHaveBeenCalled(); // parallel reviews
    expect(mockSquashTaskCommits).toHaveBeenCalled(); // squash
    expect(mockComputeProgressSummary).toHaveBeenCalled(); // progress
    expect(result.phase).toBe("finalize");
  });
});
```

**Step 2: Run test**

Run: `npx vitest run src/workflow/phases/execute.test.ts -v`
Expected: PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (439 original + ~30-40 new tests ≈ 470+ total)

**Step 4: Verify type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add -A
git commit -m "test: full integration test for D1-D8 execution flow"
```

---

## Dependency Order Summary

```
Task 1  (state fields)
  ↓
Task 2  (git-preflight.ts)
  ↓
Task 3  (integrate preflight into orchestrator)
  ↓
Task 4  (squashTaskCommits helper)
  ↓
Task 5  (integrate squash into execute.ts + commitSha)
  ↓
Task 6  (enhanced rollback)

Task 7  (parallel reviews) — independent of Tasks 1-6

Task 8  (progress summary functions)
  ↓
Task 9  (integrate progress into execute.ts)

Task 10 (extend buildImplPrompt)
  ↓
Task 11 (wire context forwarding into execute.ts)

Task 12 (stripAnsi)
  ↓
Task 13 (call stripAnsi in review-parser)

Task 14 (test-file-only check) — fully independent

Task 15 (integration test) — after all above
```

**Parallelizable groups:**
- Group A: Tasks 1→2→3→4→5→6 (git chain)
- Group B: Task 7 (parallel reviews)
- Group C: Tasks 8→9 (progress)
- Group D: Tasks 10→11 (context forwarding)
- Group E: Tasks 12→13 (ANSI strip)
- Group F: Task 14 (test-file-only)
- Final: Task 15 (integration)

Groups B, C, D, E, F are independent and can run in parallel with Group A.
