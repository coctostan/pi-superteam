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
   │ planner      │     │ spec review  │     │ exec mode │     │ review →│     │ review + │
   └─────────────┘     └──────────────┘     └───────────┘     │ fix loop│     │ report   │
                              │                                └─────────┘     └──────────┘
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

## Phases

### 1. Plan Draft (`plan-draft`)

The orchestrator dispatches two agents:

1. **Scout** — explores the codebase, identifies tech stack, key files, and conventions
2. **Planner** (implementer agent) — writes a plan file at `docs/plans/YYYY-MM-DD-<slug>.md` with a `superteam-tasks` block

The plan is read back from disk and parsed. If no tasks are found, the planner retries once with feedback. If still empty, the workflow errors out.

**Output:** A plan file on disk with parsed tasks stored in state.

### 2. Plan Review (`plan-review`)

Two reviewers run in parallel:

- **Architect** — reviews plan structure, architecture decisions, task decomposition
- **Spec reviewer** — checks task descriptions, completeness, feasibility

**If both pass:** You're asked to approve the plan.

**If either fails (iterative mode):** The planner is re-dispatched with specific findings to revise the plan. This loops up to `maxPlanReviewCycles` times (default: 3).

**If either fails (single-pass mode):** Findings are shown as warnings, and you're asked to approve anyway.

**Interaction:** You must approve the plan before proceeding. Options: approve or request revision.

### 3. Configure (`configure`)

Pure TypeScript — no agents dispatched. The orchestrator asks you structured questions:

1. **Execution mode** — how to run tasks:
   - `auto` — run all tasks without pausing
   - `checkpoint` — pause after each task for you to review
   - `batch` — run N tasks, then pause
2. **Batch size** — if batch mode, how many tasks per batch (default: 3)

Once configured, the orchestrator prints a summary and moves to execution.

### 4. Execute (`execute`)

The core loop. For each task:

```
implement → spec review → quality review → optional reviews → complete
    ▲            │              │
    │       fail │         fail │
    └── fix ─────┘    └── fix ──┘
```

**Per task:**

1. **Cost check** — budget verified before every dispatch
2. **Git snapshot** — records SHA before implementation
3. **Implement** — dispatches implementer with TDD enforcement
4. **Spec review** — dispatches spec-reviewer, checks against task requirements
5. **Quality review** — dispatches quality-reviewer, checks code and test quality
6. **Optional reviews** — security + performance in parallel (findings noted, only critical issues block)

**Fix loop:** On review failure, the implementer is re-dispatched with specific findings. Loops up to `maxTaskReviewCycles` (default: 3).

**Escalation:** After max retries or on unexpected errors, you're asked:
- **Continue** — retry the current task
- **Skip** — mark task as skipped, move on
- **Abort** — stop the workflow

**Execution mode behavior:**
- `auto` — continues to next task immediately after completion
- `checkpoint` — saves state and pauses after each task; `/workflow` resumes
- `batch` — pauses after every N tasks

### 5. Finalize (`finalize`)

1. Collects all completed tasks (excludes skipped/escalated)
2. Computes total changed files via git diff
3. Dispatches quality-reviewer for a final cross-task review
4. Builds a summary report: tasks completed/skipped/escalated, total cost, final review findings
5. Clears workflow state from disk

## Interaction Points

The orchestrator pauses for user input at these points:

| Phase | Question | Options |
|-------|----------|---------|
| Plan review | Approve plan? | Approve / Revise |
| Configure | Execution mode? | Auto / Checkpoint / Batch |
| Configure | Batch size? | Number (batch mode only) |
| Execute | Task escalation | Continue / Skip / Abort |

When paused, the orchestrator saves state and returns the question. Your answer is passed via the next `/workflow` invocation or tool call.

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

On session start, superteam checks for an existing workflow file and notifies you if one is in progress.

## Cost Tracking

The orchestrator checks the cost budget before every agent dispatch:

- **Pre-dispatch:** If cumulative cost exceeds `costs.hardLimitUsd`, the workflow pauses with an error
- **Mid-stream:** If the hard limit is reached during agent execution, the subprocess is killed
- **Optional reviews:** Skipped if approaching the budget limit
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

## Workflow vs. SDD

The `/workflow` command replaces the older `/sdd` command. Key differences:

| | `/sdd` | `/workflow` |
|---|--------|------------|
| Plan creation | Manual (you write the plan) | Automated (scout + planner) |
| Plan review | None | Architect + spec review |
| Flow control | Prompt-driven | Deterministic state machine |
| User config | None | Structured choices (exec mode, etc.) |
| Resumability | Limited | Full (persisted state file) |
| Final review | None | Cross-task quality review |

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

⚙ Execution mode? [auto/checkpoint/batch]: checkpoint

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
✅ Workflow complete
   Tasks: 3/3 completed
   Cost: $4.82
   Changed files: 6
```
