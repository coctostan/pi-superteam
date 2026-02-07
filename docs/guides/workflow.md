# Workflow Orchestrator

The workflow orchestrator is a deterministic state machine that drives the entire plan → review → implement → finalize pipeline. Agents do the creative work (writing code, reviewing code). The orchestrator makes all structural decisions in TypeScript — no prompt-based flow control.

## Overview

```
/workflow "Add rate limiting"
         │
         ▼
   ┌─────────────┐     ┌──────────────┐     ┌───────────┐     ┌─────────┐     ┌──────────┐
   │ plan-draft   │────▶│ plan-review   │────▶│ configure  │────▶│ execute  │────▶│ finalize │
   │              │     │              │     │           │     │         │     │          │
   │ scout +      │     │ architect +  │     │ user picks│     │ impl →  │     │ final    │
   │ planner      │     │ spec review  │     │ review &  │     │ review →│     │ review + │
   └─────────────┘     └──────────────┘     │ exec mode │     │ fix loop│     │ report   │
                              │              └───────────┘     └─────────┘     └──────────┘
                              │ review fails                        │
                              └──── revise plan ────┘               │ task fails
                                                                    └── escalate ──▶ user
```

State is persisted to `.superteam-workflow.json` in your working directory. If interrupted, `/workflow` resumes from the last saved state.

## Quick Start

```
# Start a new workflow
/workflow Add user authentication with JWT tokens

# Resume an interrupted workflow
/workflow

# Check progress
/workflow status

# Abort and clear state
/workflow abort
```

The orchestrator is also available as a **tool** — the AI can invoke it directly via the `workflow` tool with an `input` parameter.

## Phases

### 1. Plan Draft (`plan-draft`)

The orchestrator dispatches two agents sequentially:

1. **Scout** — explores the codebase, identifies tech stack, key files, and conventions
2. **Implementer** (acting as planner) — writes a plan file at `docs/plans/YYYY-MM-DD-<slug>.md` with a `superteam-tasks` block

The plan is read back from disk and parsed into tasks. If no tasks are found, the planner retries once with feedback. If still empty, the workflow errors out.

**Output:** A plan file on disk with parsed tasks stored in state.

**Source:** `src/workflow/phases/plan.ts`

### 2. Plan Review (`plan-review`)

Two reviewers run in parallel:

- **Architect** — reviews plan structure, architecture decisions, task decomposition
- **Spec reviewer** — checks task descriptions, completeness, feasibility

**If both pass:** You're asked to approve the plan.

**If either fails (iterative mode):** The implementer is re-dispatched with specific findings to revise the plan. The updated plan is re-read from disk and re-parsed. This loops up to `maxPlanReviewCycles` times (default: 3).

**If either fails (single-pass mode):** Findings are stored as an error/warning, and you're asked to approve anyway.

**If no reviewers are available:** Skips straight to plan approval.

**Interaction:** You must approve the plan before proceeding. Options: approve or revise.

**Source:** `src/workflow/phases/plan-review.ts`

### 3. Configure (`configure`)

Pure TypeScript — no agents dispatched. The orchestrator asks you structured questions in sequence:

1. **Review mode** — how code reviews are handled:
   - `single-pass` — one round of reviews, findings shown as warnings
   - `iterative` — review-fix loop until reviewers pass (up to `maxTaskReviewCycles`)

2. **Execution mode** — how to run tasks:
   - `auto` — run all tasks without pausing
   - `checkpoint` — pause after each task for you to review
   - `batch` — run N tasks, then pause

3. **Batch size** — if batch mode, how many tasks per batch (default: 3)

Once all questions are answered, the orchestrator sets defaults for any unconfigured values and advances to execution.

**Source:** `src/workflow/phases/configure.ts`

### 4. Execute (`execute`)

The core loop. For each task:

```
implement → spec review → quality review → optional reviews → complete
    ▲            │              │
    │       fail │         fail │
    └── fix ─────┘    └── fix ──┘
```

**Per task:**

1. **Cost check** — budget verified before every dispatch via `checkCostBudget()`
2. **Git snapshot** — records HEAD SHA before implementation via `getCurrentSha()`
3. **Implement** — dispatches implementer with TDD enforcement
4. **Spec review** — dispatches spec-reviewer, checks against task requirements
5. **Quality review** — dispatches quality-reviewer, checks code and test quality
6. **Optional reviews** — security-reviewer + performance-reviewer in parallel (findings noted, only critical findings trigger escalation)

**Review ordering:** Spec review runs first, then quality review. This is deliberate — spec compliance is checked before code quality, so quality review doesn't waste time on code that doesn't meet requirements.

**Fix loop:** On review failure, the implementer is re-dispatched with specific findings from `formatFindings()`. Changed files are recomputed after each fix via `computeChangedFiles()`. Loops up to `maxTaskReviewCycles` (default: 3).

**Escalation:** After max retries, on inconclusive reviews, or on unexpected errors (non-zero exit code), you're asked:
- **Continue** — retry the current task (resets to pending)
- **Skip** — mark task as skipped, move on
- **Abort** — stop the workflow entirely (`phase` set to `done` with error)

**Execution mode behavior:**
- `auto` — continues to next task immediately after completion
- `checkpoint` — saves state and returns after each task; `/workflow` resumes
- `batch` — returns after every N completed tasks (counter resets on resume)

**Source:** `src/workflow/phases/execute.ts`

### 5. Finalize (`finalize`)

1. Collects all completed tasks (excludes skipped/escalated)
2. Computes total changed files via `computeChangedFiles()` using the earliest `gitShaBeforeImpl`
3. Dispatches quality-reviewer for a final cross-task review
4. Builds a markdown summary report: tasks completed/skipped/escalated, total cost, final review findings, changed files
5. Clears workflow state file from disk via `clearState()`
6. Sets phase to `done`

**Source:** `src/workflow/phases/finalize.ts`

## State Machine

### Phase Transitions

```
plan-draft ──→ plan-review ──→ configure ──→ execute ──→ finalize ──→ done
                    │                           │
                    └── revise (loop) ──┘       └── escalate abort ──→ done
```

### Task States

Each task goes through these states during execution:

```
pending → implementing → reviewing → complete
              │              │
              │              └→ fixing → reviewing (loop)
              │
              └→ escalated
              └→ skipped
```

Task state type: `"pending" | "implementing" | "reviewing" | "fixing" | "complete" | "skipped" | "escalated"`

### Orchestrator State (`OrchestratorState`)

The full state is persisted to `.superteam-workflow.json`:

```typescript
{
  phase: OrchestratorPhase;              // Current phase
  config: {
    tddMode: "tdd";                     // Always TDD during workflow
    reviewMode?: "single-pass" | "iterative";
    executionMode?: "auto" | "checkpoint" | "batch";
    batchSize?: number;
    maxPlanReviewCycles?: number;        // Default: 3
    maxTaskReviewCycles?: number;        // Default: 3
  };
  userDescription: string;               // Original user request
  planPath?: string;                     // Path to plan file
  planContent?: string;                  // Full plan content
  tasks: TaskExecState[];                // All tasks with status
  currentTaskIndex: number;              // Next task to process
  planReviewCycles: number;              // How many plan revisions done
  totalCostUsd: number;                  // Cumulative cost
  startedAt: number;                     // Timestamp
  pendingInteraction?: PendingInteraction;  // Waiting for user input
  error?: string;                        // Error message if any
}
```

## Interaction Points

The orchestrator pauses for user input at these points via `PendingInteraction`:

| Phase | Question | Type | Options |
|-------|----------|------|---------|
| Plan review | Approve plan? | choice | Approve / Revise |
| Configure | Review mode? | choice | Single-pass / Iterative |
| Configure | Execution mode? | choice | Auto / Checkpoint / Batch |
| Configure | Batch size? | input | Number (batch mode only, default: 3) |
| Execute | Task escalation | choice | Continue / Skip / Abort |

**Interaction types:**
- `choice` — select from predefined options (by key, number, or label)
- `input` — free text with optional default
- `confirm` — yes/no

When paused, the orchestrator saves state and returns a message with `formatInteractionForAgent()`. The answer is passed via the next `/workflow` invocation or `workflow` tool call. User responses are validated by `parseUserResponse()` — invalid input returns an error message.

**Source:** `src/workflow/interaction.ts`

## Resuming Workflows

Workflow state persists to `.superteam-workflow.json` in your working directory. This means:

- **Terminal crash?** Run `/workflow` to resume from the last phase.
- **Need to step away?** In checkpoint mode, each task boundary is a safe pause point.
- **Cost limit hit?** Increase the budget in `.superteam.json`, then `/workflow` to continue.

The state file includes:
- Current phase and task index
- All task statuses and review results
- Pending interaction (if waiting for user input)
- Cumulative cost

The orchestrator uses atomic writes for persistence (write to `.tmp` file, then rename) to prevent corruption on crash.

On session start, superteam checks for an existing workflow file and notifies you if one is in progress.

## Cost Tracking

The orchestrator checks the cost budget before every agent dispatch:

- **Pre-dispatch:** If cumulative cost exceeds `costs.hardLimitUsd`, the workflow sets an error and stops
- **Mid-stream:** If the hard limit is reached during agent execution, the subprocess is killed (SIGTERM, then SIGKILL after 5s)
- **Cost accumulation:** Each dispatch result's `usage.cost` is added to `state.totalCostUsd`
- **Status:** `/workflow status` shows current cost alongside phase and task progress

Configure budgets in `.superteam.json`:
```json
{
  "costs": {
    "warnAtUsd": 5.0,
    "hardLimitUsd": 20.0
  }
}
```

## Prompt Construction

All prompts are built deterministically by `src/workflow/prompt-builder.ts`. Prompts:

- Are concise and structured
- Include metadata inline (task title, description, files)
- Instruct agents to read source files by path (not inlined in prompt)
- Include previous review findings when doing fix passes
- Use `superteam-json` fenced blocks for structured output contracts

Available prompt builders:
- `buildScoutPrompt(cwd)` — scout codebase exploration
- `buildPlannerPrompt(scoutOutput, description, planPath)` — write plan file with `superteam-tasks` block
- `buildPlanRevisionPrompt(planContent, findings)` — revise plan based on review findings
- `buildPlanReviewPrompt(planContent, reviewType)` — architect or spec review of plan
- `buildImplPrompt(task, planContext)` — implement a task with TDD
- `buildFixPrompt(task, reviewType, findings, changedFiles)` — fix specific review findings
- `buildSpecReviewPrompt(task, changedFiles)` — spec review of implementation
- `buildQualityReviewPrompt(task, changedFiles)` — quality review of implementation
- `buildFinalReviewPrompt(completedTasks, changedFiles)` — final cross-task review

## Git Utilities

The workflow uses async git utilities from `src/workflow/git-utils.ts`:

- `getCurrentSha(cwd)` — get HEAD SHA (used to snapshot state before implementation)
- `computeChangedFiles(cwd, baseSha?)` — get files changed since a SHA (used for review scoping)
- `getTrackedFiles(cwd)` — list all tracked files

All functions are async, use `execFile` with 5-second timeout, and return empty values on error (graceful degradation).

## Workflow vs. SDD

The `/workflow` command provides end-to-end orchestration. The `/sdd` command is a lower-level tool for running individual tasks. Key differences:

| | `/sdd` | `/workflow` |
|---|--------|------------|
| Plan creation | Manual (you write the plan) | Automated (scout + planner) |
| Plan review | None | Architect + spec review with iterative revision |
| Configuration | None | Structured choices (review mode, exec mode, batch size) |
| Flow control | Prompt-driven | Deterministic state machine |
| Resumability | Limited | Full (persisted state file with atomic writes) |
| Final review | None | Cross-task quality review |
| Cost tracking | Per-dispatch | Cumulative with budget enforcement |
| Escalation | Manual | Structured (continue/skip/abort) |

The `/sdd` command still works as a lower-level tool for running individual tasks through the review pipeline.

## Example Session

```
> /workflow Add rate limiting with token bucket algorithm

🔍 Scouting codebase...
📝 Drafting plan → docs/plans/2026-02-07-rate-limiting.md

📋 Plan review: architect ✓, spec-reviewer ✓
   3 tasks found:
   1. Token bucket implementation
   2. Rate limit middleware
   3. Configuration and tests

? Approve this plan? [approve/revise]: approve

? How should code reviews be handled?
  1) One round of reviews — findings shown as warnings
  2) Review-fix loop until reviewers pass
: 2

? How should tasks be executed?
  1) Auto — run all tasks without pausing
  2) Checkpoint — pause after each task for review
  3) Batch — run N tasks then pause
: checkpoint

🔨 Task 1/3: Token bucket implementation
   ✓ Implemented (TDD enforced)
   ✓ Spec review passed
   ✓ Quality review passed
   ⏸ Checkpoint — run /workflow to continue

> /workflow

🔨 Task 2/3: Rate limit middleware
   ✓ Implemented
   ✗ Spec review: missing IP extraction
   🔧 Fix attempt 1/3...
   ✓ Spec review passed
   ✓ Quality review passed
   ⏸ Checkpoint

> /workflow

🔨 Task 3/3: Configuration and tests
   ✓ Implemented
   ✓ All reviews passed

📊 Final review...

# Workflow Complete

## Tasks
✅ Token bucket implementation
✅ Rate limit middleware
✅ Configuration and tests

## Stats
- 3 completed
- 0 skipped
- 0 escalated
- Total cost: $4.82

## Final Review
Good overall implementation. Clean code, tests cover edge cases.

## Changed Files
- src/rate-limiter.ts
- src/rate-limiter.test.ts
- src/middleware/rate-limit.ts
- src/middleware/rate-limit.test.ts
- src/config.ts
- src/config.test.ts
```

## Error Handling

The orchestrator handles errors at multiple levels:

- **Agent dispatch failures** (non-zero exit) → escalation to user
- **Missing agents** (no scout, no implementer) → error with descriptive message
- **Empty plans** (no parseable tasks) → retry once, then error
- **Review parse failures** (inconclusive) → escalation to user
- **Cost budget exceeded** → workflow stops with error
- **User abort** → phase set to done with error message
- **State corruption** → `loadState()` returns null, treated as no active workflow
