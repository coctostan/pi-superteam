# Design Spec: Git Discipline & Execution Quality

**Branch:** `feat/validation-engine` (continues current work)
**Depends on:** v0.3.0 (validation engine, skill rename) ✅ Complete
**Test baseline:** 439 tests passing across 33 files

---

## Review Amendments (2026-02-09)

Post-design code audit revealed scope reductions and two design corrections:

1. **D2 changed to squash-after-complete** — instead of forbidding implementer commits (unreliable — LLMs ignore instructions), let implementers commit freely during TDD, then squash via existing `squashCommitsSince()` after all reviews pass. One clean commit per task, zero reliance on prompt compliance.
2. **D4 changed to re-run both reviews after any fix** — if a spec fix breaks quality, running only the failed reviewer creates a blind spot. Re-running both via `dispatchParallel` after any fix round is cheap and eliminates regressions.
3. **D7 shrunk** — `parse-utils.ts` already has the quote-aware line-walker with `inString`/`escape` tracking. Only ANSI stripping + edge case tests remain.
4. **D6 shrunk** — `buildImplPrompt` already accepts `previousTaskSummary`. Just extend to last 5 tasks and wire it up in execute.ts.
5. **D8b dropped** — `REVIEW_OUTPUT_FORMAT` doesn't exist in prompt-builder.ts. Phantom deliverable.
6. **D8c dropped** — `bash` already in security-reviewer tools (commit `b75217f`).
7. **D5 location** — `computeProgressSummary`/`formatProgressSummary` go in `progress.ts` (not `ui.ts`), co-located with existing progress logic.

**Net scope: 6 deliverables** (D1, D2, D3, D4, D5+D6, D7+D8a).

---

## Motivation

The validation engine (batch 2) catches regressions mid-workflow. But the execution phase still has structural weaknesses:

1. **No git safety net** — workflow starts on whatever branch in whatever state. Dirty trees, work on `main`, no isolation.
2. **Implementer controls commits** — inconsistent messages, timing varies, rollback unreliable because we don't own the commit graph.
3. **Reviews run sequentially** — spec review then quality review, wasting wall-clock time on independent checks.
4. **No context forwarding** — each implementer starts cold. Task 5 doesn't know what task 4 changed.
5. **Review parser fragile** — `review-parser.ts` uses simple regex; brainstorm parser already proved that's insufficient.
6. **Small quality gaps** — reviewers can't run `npm audit`, no check for test-file-only changes, duplicate prompt boilerplate.

This batch makes the execution phase git-safe, faster, and more reliable.

---

## Status of next-batch.md items

Before scoping this batch, a code audit against the 20-item backlog:

| # | Item | Status |
|---|------|--------|
| 1 | Streaming activity feedback | ✅ Done — all phases have `makeOnStreamEvent()` |
| 3 | Brainstorm skip option | ✅ Done — `ui.select` skip choice in brainstorm.ts |
| 4 | Inject .pi/context.md | ✅ Done — `buildSubprocessArgs` reads it |
| 6 | Plan file path fallback | ✅ Done — plan-write.ts searches docs/plans/ |
| 7 | Rollback on failure | ⚠️ Partial — escalate() offers Rollback, uses `resetToSha` |
| 12 | Pre-review validation gate | ⚠️ Partial — validation engine handles this |
| 16 | Fix AT-7 brainstorm test | ✅ Done — all 439 tests pass |

**Items 1, 3, 4, 6, 16 should be marked complete in next-batch.md.**

---

## Scope — 8 deliverables

### D1. Git Safety Preflight

**New file:** `src/workflow/git-preflight.ts`

Before the workflow loop starts, check git state and ensure a clean, isolated environment.

```typescript
export interface GitPreflightResult {
  clean: boolean;
  branch: string;
  isMainBranch: boolean;
  uncommittedFiles: string[];
  warnings: string[];
}

export async function runGitPreflight(cwd: string): Promise<GitPreflightResult>;
```

**Behavior:**
1. `git status --porcelain` — if dirty, offer via `ui.select`:
   - "Stash changes" → `git stash push -m "superteam-workflow-preflight"`
   - "Continue anyway" (proceed with warning)
   - "Abort"
2. Check current branch — if `main`/`master`, offer via `ui.select`:
   - "Create workflow branch" → prompt name (default: `workflow/<slug>`), `git checkout -b <name>`
   - "Continue on main" (proceed with warning)
   - "Abort"
3. Store `gitStartingSha` and `gitBranch` in `OrchestratorState`.

**State changes** (add to `OrchestratorState`):
```typescript
gitStartingSha?: string;
gitBranch?: string;
```

**Integration point:** Call at top of `runWorkflowLoop()` in `orchestrator.ts`, before the phase switch. Only runs once (skip if `state.gitStartingSha` already set).

**Tests:** Unit tests with mock `execFileAsync` for clean/dirty/main-branch scenarios.

---

### D2. Orchestrator-Controlled Commits (Squash Strategy)

**Modified files:** `src/workflow/phases/execute.ts`, `src/workflow/git-utils.ts`

After a task passes all reviews, the orchestrator squashes all implementer commits since `gitShaBeforeImpl` into one clean commit. This lets implementers commit freely during TDD (natural workflow) while producing a clean commit graph.

**Uses existing function:** `squashCommitsSince()` in `git-utils.ts` — already implemented and tested.

**New helper** in `git-utils.ts`:
```typescript
export async function squashTaskCommits(
  cwd: string,
  baseSha: string,
  taskId: number,
  taskTitle: string,
): Promise<{ sha: string; success: boolean; error?: string }>;
```

**Behavior:**
1. `git add -A` (stage any unstaged changes from fix cycles).
2. If dirty, `git commit -m "wip"` (ensure everything is committed before squash).
3. `squashCommitsSince(cwd, baseSha, "workflow: task ${taskId} — ${taskTitle}")`.
4. Return new SHA. Store in `TaskExecState.commitSha`.
5. If baseSha equals HEAD (no changes), return `{ success: true, sha: currentSha }`.

**State changes** (add to `TaskExecState`):
```typescript
commitSha?: string;
```

**No prompt changes needed** — implementers keep committing naturally during TDD.

**Integration in `execute.ts`:**
- After step (h) `task.status = "complete"`, call `squashTaskCommits()`.
- Store SHA in task state.
- If squash fails, `ui.notify` warning but don't block.

**Tests:** Integration test with real temp git repo: multiple commits → squash → verify single commit with correct message format and SHA stored.

---

### D3. Enhanced Rollback

**Modified file:** `src/workflow/phases/execute.ts`

The existing `escalate()` already offers "Rollback" and calls `resetToSha()`. Enhance it:

1. Before rollback, show what will be lost: "Rolling back task {title}. Reverting {N} files changed since {sha}."
2. After rollback, reset task state: `status: "pending"`, clear `reviewsPassed`/`reviewsFailed`/`fixAttempts`.
3. If orchestrator-controlled commits exist after the rollback point, they're cleanly removed by `git reset --hard`.

**Changes to `escalate()`:**
```typescript
if (choice === "Rollback") {
  if (task.gitShaBeforeImpl) {
    const files = await computeChangedFiles(cwd, task.gitShaBeforeImpl);
    ui?.notify?.(`Rolling back: reverting ${files.length} files to ${task.gitShaBeforeImpl.slice(0, 7)}`, "info");
    await resetToSha(cwd, task.gitShaBeforeImpl);
    // Reset task state for clean retry
    task.reviewsPassed = [];
    task.reviewsFailed = [];
    task.fixAttempts = 0;
  }
  return "retry";
}
```

**Tests:** Integration test: implement → commit → rollback → verify repo matches pre-task SHA and task state is clean.

---

### D4. Parallelize Spec + Quality Reviews

**Modified file:** `src/workflow/phases/execute.ts`

Spec and quality reviews are independent. Run them concurrently.

**Current flow (sequential):**
```
impl → spec review → (fix loop) → quality review → (fix loop) → complete
```

**New flow (parallel with full re-review after fixes):**
```
impl → [spec review ‖ quality review] → if any fail: fix → [re-run BOTH] → repeat up to maxRetries → complete
```

**Implementation:**
1. After implementation, dispatch spec + quality reviewers via `dispatchParallel()`.
2. If both pass, done.
3. If either fails, merge all findings and dispatch implementer to fix.
4. After fix, re-run **both** reviewers in parallel (a spec fix may break quality and vice versa).
5. Repeat up to `maxRetries`. Escalate if still failing.

**Rationale:** Re-running both after any fix eliminates the blind spot where a spec fix could regress quality. `dispatchParallel` makes the extra call cheap (wall-clock same as one review).

**Replaces:** The current sequential `runReviewLoop` calls for spec then quality. The new parallel review function replaces both calls.

**Tests:** Unit test with mock dispatch verifying parallel dispatch call. Test: one passes + one fails → fix → both re-run. Test: both pass first try → no fix loop.

---

### D5. Post-Task Deterministic Summaries

**Modified files:** `src/workflow/progress.ts`, `src/workflow/ui.ts`

After each task completes, compute and display a summary. No LLM needed.

```typescript
export interface TaskProgressSummary {
  tasksCompleted: number;
  tasksRemaining: number;
  tasksSkipped: number;
  cumulativeCost: number;
  estimatedRemainingCost: number;
  currentTaskTitle: string;
}

export function computeProgressSummary(state: OrchestratorState): TaskProgressSummary;
export function formatProgressSummary(summary: TaskProgressSummary): string;
```

**Estimated remaining cost:** `(cumulativeCost / tasksCompleted) * tasksRemaining`

**Display:** `ui.notify(formatProgressSummary(summary), "info")` after each task completion in execute.ts.

**Store in task state:** Add `summary` field to `TaskExecState` (already typed but not populated):
```typescript
task.summary = {
  title: task.title,
  status: task.status,
  changedFiles: await computeChangedFiles(cwd, task.gitShaBeforeImpl),
};
```

**Tests:** Unit test for `computeProgressSummary` with various state snapshots. Test cost estimation math.

---

### D6. Post-Task Context Forwarding

**Modified files:** `src/workflow/prompt-builder.ts`, `src/workflow/phases/execute.ts`

`buildImplPrompt` already accepts an optional `previousTaskSummary` param (single task). Two changes:

1. **Extend param to accept array** — change from single `previousTaskSummary?` to `priorTasks?: Array<{ title: string; status: string; changedFiles: string[] }>`. Render the last 5 completed tasks in the prompt.
2. **Wire in execute.ts** — before dispatching implementer, collect summaries:
```typescript
const priorTasks = state.tasks
  .filter(t => t.status === "complete" && t.summary)
  .slice(-5)
  .map(t => t.summary!);
// Pass to buildImplPrompt(task, planContext, priorTasks)
```

**Tests:** Unit test for `buildImplPrompt` with 0, 3, and 7 prior tasks (verify cap at 5). Verify output contains file lists from each prior task.

---

### D7. ANSI Stripping for Review Parser

**Modified files:** `src/parse-utils.ts`, `src/review-parser.ts`

Code audit found that `parse-utils.ts` already has the quote-aware line-walker with `inString`/`escape` tracking, and `sanitizeJsonNewlines()` is already applied. The only missing defense is **ANSI escape code stripping**.

1. **Add `stripAnsi()` to `parse-utils.ts`** — strip ANSI escape sequences (CSI codes like `\x1b[31m`) before any parsing. Reviewers running via subprocess may emit color codes.
2. **Call `stripAnsi()` at the top of `parseReviewOutput()`** in `review-parser.ts`, before `extractFencedBlock`.

**Tests:** Edge case tests for: ANSI escape codes wrapping JSON, ANSI codes inside fenced blocks, mixed ANSI + valid JSON.

---

### D8. Test-File-Only Review Check

**D8a. Test-file-only review check (#13)**
- File: `src/workflow/prompt-builder.ts`
- In `buildSpecReviewPrompt()`, add: "Verify that implementation files were modified, not just test files. If only test files changed, flag as critical finding."
- ~2 lines.

**~~D8b. Remove duplicate review output format~~** — DROPPED: `REVIEW_OUTPUT_FORMAT` doesn't exist in prompt-builder.ts.

**~~D8c. Add bash to security-reviewer~~** — DROPPED: Already done in commit `b75217f`.

**Tests:** D8a: unit test verifying the prompt string contains the new instruction.

---

## Dependency Graph

```
D1 (git preflight) ── D2 (squash commits) ── D3 (enhanced rollback)

D4 (parallel reviews)

D5 (summaries) ── D6 (context forwarding)

D7 (ANSI strip) + D8a (test-file check)
```

- D1 → D2 → D3: Sequential — squash needs preflight SHA, rollback needs squash.
- D5 → D6: Context forwarding uses the summary data from D5.
- D4, D7, D8a: Fully independent of each other and of the D1→D3 chain.

**Parallelizable groups:**
- Group A: D1 → D2 → D3 (git chain)
- Group B: D4 (parallel reviews)
- Group C: D5 → D6 (summaries + context)
- Group D: D7 + D8a (small independent fixes)

Groups B, C, D can all run in parallel with Group A.

---

## Files Changed

| File | Deliverable | Change |
|------|------------|--------|
| `src/workflow/git-preflight.ts` | D1 | **New** — git safety checks |
| `src/workflow/orchestrator-state.ts` | D1, D2 | Add `gitStartingSha`, `gitBranch`, `commitSha` fields |
| `src/workflow/orchestrator.ts` | D1 | Call git preflight at workflow start |
| `src/workflow/git-utils.ts` | D2 | Add `squashTaskCommits()` |
| `src/workflow/phases/execute.ts` | D2, D3, D4, D5, D6 | Squash commits, enhanced rollback, parallel reviews, summaries, context forwarding |
| `src/workflow/prompt-builder.ts` | D6, D8a | Extend prior context to array of 5, add test-file check |
| `src/workflow/progress.ts` | D5 | Add `computeProgressSummary`, `formatProgressSummary` |
| `src/parse-utils.ts` | D7 | Add `stripAnsi()` |
| `src/review-parser.ts` | D7 | Call `stripAnsi()` before parsing |

---

## Exit Criteria

- [ ] Workflow refuses to start on dirty working tree (offers stash/continue/abort)
- [ ] Warning on main branch with branch creation option
- [ ] Squashed commits land with `workflow: task N — <title>` format after every completed task
- [ ] Rollback reverts to pre-task state and resets task metadata for clean retry
- [ ] Spec + quality reviews dispatch in parallel, both re-run after any fix
- [ ] Progress summary displayed after each task with cost + estimate
- [ ] Implementer prompt includes prior task context (capped at 5)
- [ ] Review parser strips ANSI codes before parsing
- [ ] Spec review prompt includes test-file-only check instruction
- [ ] All existing 439 tests still pass + new tests added for each deliverable
- [ ] No state schema breaks — all new fields are optional with backwards compat

---

## Estimated Size

- **New code:** ~200 lines (git-preflight.ts + progress helpers + stripAnsi)
- **New tests:** ~120-150 lines
- **Modified code:** ~150 lines across execute.ts, prompt-builder.ts, git-utils.ts, review-parser.ts
- **Total:** ~500 lines of changes (reduced from ~800 after scope cleanup)
- **Risk:** Low-medium. Git operations are the riskiest part (D1-D3) — integration tests with real repos needed.
