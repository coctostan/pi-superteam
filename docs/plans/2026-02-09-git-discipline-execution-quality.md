# Design Spec: Git Discipline & Execution Quality

**Branch:** `feat/validation-engine` (continues current work)
**Depends on:** v0.3.0 (validation engine, skill rename) ✅ Complete
**Test baseline:** 439 tests passing across 33 files

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

### D2. Orchestrator-Controlled Commits

**Modified file:** `src/workflow/git-utils.ts`

After a task passes all reviews, the orchestrator commits — not the implementer.

```typescript
export async function commitTaskChanges(
  cwd: string,
  taskId: number,
  taskTitle: string,
): Promise<{ sha: string; success: boolean; error?: string }>;
```

**Behavior:**
1. `git add -A`
2. `git commit -m "workflow: task ${taskId} — ${taskTitle}"`
3. Return new SHA. Store in `TaskExecState.commitSha`.
4. If nothing to commit (clean tree), return `{ success: true, sha: currentSha }`.

**State changes** (add to `TaskExecState`):
```typescript
commitSha?: string;
```

**Prompt change** in `prompt-builder.ts`:
- Change `buildImplPrompt` instruction from "Commit after each green cycle" to "Do NOT commit. The orchestrator manages git commits."

**Integration in `execute.ts`:**
- After step (h) `task.status = "complete"`, call `commitTaskChanges()`.
- Store SHA in task state.
- If commit fails, `ui.notify` warning but don't block.

**Tests:** Integration test with real temp git repo: create file → commit → verify message format and SHA stored.

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

**New flow (parallel first pass, sequential fixes):**
```
impl → [spec review ‖ quality review] → fix any failures sequentially → complete
```

**Implementation:**
1. After implementation, dispatch spec + quality reviewers via `dispatchParallel()`.
2. If both pass, done.
3. If either fails, run fix loop for each failed review sequentially (fixes may overlap in files).
4. After fix, re-review only the failed reviewer.

**Constraint:** Optional reviewers (security, performance) already run in parallel. This extends the pattern to required reviewers.

**Tests:** Unit test with mock dispatch verifying parallel dispatch call. Test: one passes + one fails → only the failed one re-runs.

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
  changedFilesSoFar: string[];
  fixCyclesSoFar: number;
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

**Modified file:** `src/workflow/prompt-builder.ts`

Each implementer gets a lightweight summary of what prior tasks changed.

**Change `buildImplPrompt` signature:**
```typescript
export interface PriorTaskContext {
  title: string;
  status: string;
  changedFiles: string[];
}

export function buildImplPrompt(
  task: TaskExecState,
  planContext: string,
  priorTasks?: PriorTaskContext[],
): string;
```

**In `execute.ts`:** Before dispatching implementer, collect summaries from completed tasks:
```typescript
const priorTasks = state.tasks
  .filter(t => t.status === "complete" && t.summary)
  .slice(-5)  // cap at last 5 to avoid prompt bloat
  .map(t => t.summary!);
```

**Tests:** Unit test for `buildImplPrompt` with 0, 3, and 7 prior tasks (verify cap at 5). Verify output contains file lists.

---

### D7. Harden Review Parser

**Modified file:** `src/review-parser.ts` (+ new `src/parse-utils.ts` if not already extracted)

Apply the same defense-in-depth from `brainstorm-parser.ts`:

1. **Quote-aware fence extraction** — the current `extractFencedBlock` can be fooled by triple-backticks inside JSON strings. Replace with the line-walker from brainstorm-parser that tracks `inString`/`escape` state.
2. **Newline sanitization** — `sanitizeJsonNewlines()` before `JSON.parse()` (already imported but verify it's applied on all paths).
3. **Fallback chain:** fenced `superteam-json` → brace-on-fenced → last brace block → inconclusive.
4. **ANSI strip** — reviewers running via subprocess may emit ANSI escape codes. Strip before parsing.

**Current code already imports from `parse-utils.ts`** — verify `extractFencedBlock` there uses the hardened walker. If not, replace it.

**Tests:** Add edge case tests: JSON with embedded triple-backticks, ANSI escape codes in output, literal newlines in strings.

---

### D8. Small Quality Fixes

Three small, independent changes:

**D8a. Test-file-only review check (#13)**
- File: `src/workflow/prompt-builder.ts`
- In `buildSpecReviewPrompt()`, add: "Verify that implementation files were modified, not just test files. If only test files changed, flag as critical finding."
- ~2 lines.

**D8b. Remove duplicate review output format (#14)**
- File: `src/workflow/prompt-builder.ts`
- If `REVIEW_OUTPUT_FORMAT` exists in prompt-builder and duplicates what's in the reviewer agent markdown files, remove it. The agent `.md` file is authoritative.
- Verify by checking `agents/spec-reviewer.md` and `agents/quality-reviewer.md` for the format.

**D8c. Add bash to security-reviewer (#20)**
- File: `agents/security-reviewer.md`
- Change frontmatter `tools:` from `read,grep,find,ls` to `read,grep,find,ls,bash`.
- Enables `npm audit`, `git log` for secret detection, file permission checks.

**Tests:** D8a: unit test verifying the prompt string contains the new instruction. D8c: agent discovery test verifying security-reviewer has bash in tools.

---

## Dependency Graph

```
D1 (git preflight) ──────┐
                          ├── D2 (orchestrator commits) ── D3 (enhanced rollback)
                          │
D7 (review parser) ──────┤
                          ├── D4 (parallel reviews)
D8 (small fixes) ────────┘

D5 (summaries) ──── D6 (context forwarding)
```

- D1 → D2 → D3: Sequential — commits need preflight, rollback needs commits.
- D4, D5, D6, D7, D8: Independent of each other and of the D1→D3 chain.
- D5 → D6: Context forwarding uses the summary data from D5.

**Parallelizable groups:**
- Group A: D1 → D2 → D3 (git chain)
- Group B: D4 (parallel reviews)
- Group C: D5 → D6 (summaries + context)
- Group D: D7 (review parser)
- Group E: D8a, D8b, D8c (independent small fixes)

Groups B, D, E can run in parallel with Group A. Group C can start in parallel and D6 wires into D2's execute.ts changes.

---

## Files Changed

| File | Deliverable | Change |
|------|------------|--------|
| `src/workflow/git-preflight.ts` | D1 | **New** — git safety checks |
| `src/workflow/orchestrator-state.ts` | D1, D2 | Add `gitStartingSha`, `gitBranch`, `commitSha` fields |
| `src/workflow/orchestrator.ts` | D1 | Call git preflight at workflow start |
| `src/workflow/git-utils.ts` | D2 | Add `commitTaskChanges()` |
| `src/workflow/phases/execute.ts` | D2, D3, D4, D5, D6 | Orchestrator commit, enhanced rollback, parallel reviews, summaries, context forwarding |
| `src/workflow/prompt-builder.ts` | D2, D6, D8a, D8b | Remove "commit" instruction, add prior context, add test-file check, remove duplicate format |
| `src/workflow/progress.ts` | D5 | Add `computeProgressSummary`, `formatProgressSummary` |
| `src/workflow/ui.ts` | D5 | Summary formatting helpers |
| `src/review-parser.ts` | D7 | Hardened extraction with quote-aware walker |
| `agents/security-reviewer.md` | D8c | Add `bash` to tools |

---

## Exit Criteria

- [ ] Workflow refuses to start on dirty working tree (offers stash/continue/abort)
- [ ] Warning on main branch with branch creation option
- [ ] Orchestrator commits land with `workflow: task N — <title>` format after every completed task
- [ ] Rollback reverts to pre-task state and resets task metadata for clean retry
- [ ] Spec + quality reviews dispatch in parallel (verify via mock test)
- [ ] Progress summary displayed after each task with cost + estimate
- [ ] Implementer prompt includes prior task context (capped at 5)
- [ ] Review parser handles embedded backticks, ANSI codes, literal newlines
- [ ] Spec review prompt includes test-file-only check instruction
- [ ] Security reviewer has bash access
- [ ] All existing 439 tests still pass + new tests added for each deliverable
- [ ] No state schema breaks — all new fields are optional with backwards compat

---

## Estimated Size

- **New code:** ~300 lines across git-preflight.ts + additions to existing files
- **New tests:** ~150-200 lines
- **Modified code:** ~200 lines across execute.ts, prompt-builder.ts, git-utils.ts, review-parser.ts
- **Total:** ~700-800 lines of changes
- **Risk:** Low-medium. Git operations are the riskiest part (D1-D3) — integration tests with real repos needed.
