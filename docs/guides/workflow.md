# Workflow Guide

The `/workflow` command drives a fully orchestrated development pipeline. LLMs handle creative work as isolated subagents; all flow control is deterministic TypeScript.

## Phase Diagram

```
brainstorm → plan-write → plan-review → configure → execute → finalize → done
     ↑              ↑           ↑                        ↑
     │              │     planner revises           retry/skip/abort
   scout +        planner      if reviews fail       per task
  brainstormer    agent
```

## Phases

### 1. Brainstorm

The brainstorm phase is interactive and multi-step:

1. **Scout** — The `scout` agent explores the codebase (files, tech stack, conventions)
2. **Questions** — The `brainstormer` agent generates 3-7 clarifying questions. You answer each via `ctx.ui.select` (multiple choice) or `ctx.ui.input` (open-ended)
3. **Approaches** — The `brainstormer` proposes 2-3 implementation approaches with trade-offs. You pick one via `ctx.ui.select`
4. **Design Sections** — The `brainstormer` writes detailed design sections. Each section is presented for approval via `ctx.ui.confirm`. Rejected sections get revision feedback via `ctx.ui.input`
5. **Save Design** — Approved sections are assembled into a design document at `docs/plans/YYYY-MM-DD-<slug>-design.md`

### 2. Plan Write

The `planner` agent (not the implementer) writes a detailed TDD implementation plan:
- Receives the approved design, scout output, and user description
- Writes the plan to `docs/plans/YYYY-MM-DD-<slug>-plan.md`
- Plan must include a `superteam-tasks` YAML block for machine parsing
- Retries once if no tasks are parsed

### 3. Plan Review

Reviewers (`architect`, `spec-reviewer`) validate the plan against the design:
- Design content is included in review prompts
- On review failure in iterative mode: the `planner` agent revises (not the implementer)
- After reviews: `ctx.ui.select` offers **Approve** / **Revise** / **Abort**
- **Revise** opens `ctx.ui.editor` for feedback, then dispatches planner for revision

### 4. Configure

Interactive configuration via `ctx.ui.select` and `ctx.ui.input`:
- **Execution Mode**: Auto (all tasks), Checkpoint (pause after each), Batch (run N then pause)
- **Review Mode**: Iterative (review-fix loop) or Single-pass
- **Batch Size**: Number input (default: 3)

### 5. Execute

Each task goes through: implement → validation gate → spec review → quality review → optional reviews → cross-task validation

- **Validation gate**: Runs `validationCommand` (e.g., `tsc --noEmit`) after implementation. On failure, dispatches the implementer for an auto-fix attempt, re-validates, then escalates if still failing
- **Cross-task validation**: When `testCommand` is configured, captures a test baseline before execution begins. After each task completion (per `validationCadence`), runs the full test suite and classifies failures against the baseline:
  - **New regressions** → block (escalate via failure taxonomy)
  - **Pre-existing failures** → ignore (were broken before we started)
  - **Flakes** → warn and continue (failed first run, passed re-run)
- **Failure taxonomy**: `resolveFailureAction()` drives escalation behavior for `test-regression`, `test-flake`, and `validation-failure` types
- **Streaming activity**: `onStreamEvent` callback shows real-time tool actions in the status bar
- **Activity widget**: Rolling buffer of recent tool actions displayed via `ctx.ui.setWidget`
- **Progress widget**: Task completion status updated after each task via `ctx.ui.setWidget`
- **Escalation**: On failure, `ctx.ui.select` offers **Retry** / **Rollback** / **Skip** / **Abort**

### 6. Finalize

Final cross-task review and summary report.

## Agent Roster

| Agent | Role | Tools |
|-------|------|-------|
| `scout` | Fast codebase reconnaissance | read, grep, find, ls, bash |
| `brainstormer` | Generate questions, approaches, design sections | read, find, grep, ls (read-only) |
| `planner` | Write detailed TDD implementation plans | read, write, find, grep, ls (no bash/edit) |
| `implementer` | TDD implementation with guard | read, bash, edit, write, grep, find, ls |
| `architect` | Architecture review | read, grep, find, ls |
| `spec-reviewer` | Spec compliance review | read, grep, find, ls |
| `quality-reviewer` | Code quality review | read, grep, find, ls |
| `security-reviewer` | Security review (optional) | read, grep, find, ls |
| `performance-reviewer` | Performance review (optional) | read, grep, find, ls |

## `/workflow` Command

```
/workflow <description>    Start a new workflow
/workflow                  Resume an in-progress workflow (or prompt to start)
/workflow status           Show current phase, task progress, cost
/workflow abort            Abort and clear state
```

When resuming with an existing workflow, the orchestrator picks up from the saved phase. When starting with a description while a workflow exists, you're asked to confirm replacement.

## Progress File

A human-readable `*-progress.md` file is maintained alongside the design and plan documents:
- Derived from `designPath` or `planPath` (e.g., `docs/plans/2026-02-07-auth-progress.md`)
- Updated after every phase transition
- Contains: phase status, brainstorm checklist, task list with completion markers, cost
- Survives crashes — viewable outside pi

## Streaming Activity

During execution, the orchestrator passes an `onStreamEvent` callback to `dispatchAgent`:
- `tool_execution_start` events update the status bar with the current tool action
- An activity buffer (ring buffer) maintains recent actions as a widget
- `tool_execution_update` events can provide partial results (e.g., test output)
- `tool_execution_end` events signal completion

## State Persistence

State is saved to `.superteam-workflow.json` after every phase:
- Phase, config, tasks, brainstorm sub-state, design/plan paths
- Cost tracking, timestamps
- Fully resumable from any phase

## Error Handling

- **Parse failures**: Structured output parsing failures trigger retries with explicit format reminders. After 2 attempts, the user is offered Retry/Abort
- **Agent failures**: Non-zero exit codes trigger escalation (Retry/Skip/Abort)
- **Cost limits**: Hard budget stops execution automatically
- **User cancellation**: Escape/undefined responses save state without advancing — resume anytime

## Parsing Robustness (v0.2.1)

The workflow relies on agents producing structured output in fenced code blocks. Two parsers have been hardened against real-world LLM output:

### Task Parser (`superteam-tasks`)
- Uses a **line-walking extractor** instead of regex — immune to inner triple-backtick sequences
- Closing fence must be at 0-3 spaces indent; embedded code fences in `description: |` block scalars are indented 4+ and don't match
- Supports YAML-like `description: |` block scalars with automatic dedenting

### Brainstorm Parser (`superteam-brainstorm`)
- **Quote-aware fenced extractor** — tracks `inString`/`escape` state while scanning lines, only accepts closing fence when not inside a JSON string
- **Newline sanitization** — `sanitizeJsonNewlines()` replaces literal `\n` (0x0a) inside JSON strings with `\\n` before `JSON.parse()`
- **3-tier fallback chain**: fenced block → brace-match on fenced content → brace-match on full output (with fenced block stripped)
- **Prompt hardening** — all brainstorm prompts include explicit "use `\\n` escapes, not literal newlines" instructions
