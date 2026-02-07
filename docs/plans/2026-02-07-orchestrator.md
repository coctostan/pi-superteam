# Workflow Orchestrator Implementation Plan

**Goal:** Replace the current prompt-driven SDD workflow with a deterministic TypeScript state machine that controls the entire plan→review→implement→review→finalize pipeline. Agents get minimal, pre-built context. The orchestrator makes all structural decisions in code — agents only do creative work (writing code, reviewing code).

**Architecture:** A state machine (`OrchestratorPhase`) with typed transitions. Each phase is a function that either advances to the next phase or returns an `InteractionRequest` for user input. State is persisted to `.superteam-workflow.json` in cwd. The orchestrator is invoked via `/workflow` command and resumes from saved state on each invocation.

**Principles:**
- Deterministic TS logic for all flow control — no prompt-based discipline
- Agents receive pre-built task strings with metadata inline (task spec, file lists, findings)
- Agents DO read actual source files — orchestrator provides file paths and instructions, not file contents
- User decisions are structured (multiple-choice), collected by the orchestrator
- Existing modules (`dispatch.ts`, `review-parser.ts`) are reused; `state.ts` is superseded by orchestrator state
- Cost budget checked before every agent dispatch
- TUI widget updated after every state transition

**Re-entry contract:** When the orchestrator needs user input, it stores a `pendingInteraction` in state with an ID, returns the question to the parent agent, and saves state. On next `/workflow` invocation, the user's answer is matched to the pending interaction by ID to resume.

---

```superteam-tasks
- title: Extract git utilities to shared module
  description: |
    Create src/workflow/git-utils.ts by extracting from sdd.ts:
    1. getTrackedFiles(cwd): string[] — list tracked files (async, use execFile not execSync)
    2. computeChangedFiles(cwd, baseSha?: string): string[] — git diff --name-only (async)
    3. getCurrentSha(cwd): string — git rev-parse HEAD (async)
    4. All functions async using child_process.execFile with promisify, not execSync
    5. Graceful fallback: return empty array on git errors (not in a repo, etc.)
    Pure utility module, no state, no dependencies on other superteam modules.
  files: [src/workflow/git-utils.ts]
- title: Define orchestrator state types and persistence
  description: |
    Create src/workflow/orchestrator-state.ts. This becomes the single source of truth for workflow state, superseding state.ts for orchestrated workflows.
    Types:
    1. OrchestratorPhase: "plan-draft" | "plan-review" | "configure" | "execute" | "finalize" | "done"
    2. OrchestratorConfig: tddMode (always "tdd" for now), reviewMode ("single-pass" | "iterative"), executionMode ("auto" | "checkpoint" | "batch"), batchSize (number, default 3), maxPlanReviewCycles (number, default 3), maxTaskReviewCycles (number, default 3)
    3. TaskExecState: { id, title, description, files, status (pending|implementing|reviewing|fixing|complete|skipped|escalated), reviewsPassed: string[], reviewsFailed: string[], fixAttempts, gitShaBeforeImpl? }
    4. PendingInteraction: { id: string, type: "choice"|"confirm"|"input", question: string, options?: {key,label}[], default?: string }
    5. OrchestratorState: { phase, config (partial until configure completes), userDescription (initial task from user), planPath?, planContent?, tasks: TaskExecState[], currentTaskIndex, planReviewCycles, totalCostUsd, startedAt, pendingInteraction?, error? }
    Functions:
    6. createInitialState(description: string): OrchestratorState
    7. saveState(state, cwd): void — writes .superteam-workflow.json atomically (write tmp, rename)
    8. loadState(cwd): OrchestratorState | null
    9. clearState(cwd): void
  files: [src/workflow/orchestrator-state.ts]
- title: Build prompt builder module
  description: |
    Create src/workflow/prompt-builder.ts. Builds all agent prompt strings deterministically. Prompts include task metadata inline but instruct agents to read source files by path (orchestrator can't inline entire codebases).
    Functions:
    1. buildScoutPrompt(cwd: string): string — "List key files, tech stack, directory structure, conventions. Be brief. Output structured summary."
    2. buildPlannerPrompt(scoutOutput: string, userDescription: string, planPath: string): string — instructions to write a plan .md with superteam-tasks block to the given path
    3. buildPlanRevisionPrompt(planContent: string, findings: string): string — revise plan based on review findings
    4. buildPlanReviewPrompt(planContent: string, reviewType: "architect" | "spec"): string — plan inline, review instructions, mandates superteam-json output
    5. buildImplPrompt(task: TaskExecState, planContext: string): string — task description, file list, TDD instructions. No plan file reading.
    6. buildFixPrompt(task: TaskExecState, reviewType: string, findings: ReviewFindings, changedFiles: string[]): string — findings inline, mustFix items, changed files
    7. buildSpecReviewPrompt(task: TaskExecState, changedFiles: string[]): string — task spec inline, changed file paths for reviewer to read, mandates superteam-json
    8. buildQualityReviewPrompt(task: TaskExecState, changedFiles: string[]): string — same pattern for quality
    9. buildFinalReviewPrompt(completedTasks: TaskExecState[], changedFiles: string[]): string — summary of all completed tasks, file list for final review
    10. extractPlanContext(planContent: string): string — extract Goal/Architecture/Tech Stack header from plan markdown (everything before the first task)
    All prompts: concise, no preamble, explicit output format.
  files: [src/workflow/prompt-builder.ts]
- title: Build user interaction helpers
  description: |
    Create src/workflow/interaction.ts with typed user interaction construction.
    Types:
    1. InteractionRequest: { id: string, type: "choice"|"confirm"|"input", question: string, options?: {key: string, label: string, description?: string}[], default?: string }
    Factory functions (each returns InteractionRequest):
    2. askReviewMode(): choice between "single-pass" (one round of plan review) and "iterative" (review-fix loop until pass)
    3. askExecutionMode(): choice between "auto", "checkpoint", "batch"
    4. askBatchSize(): input for number (only used if batch mode)
    5. confirmPlanApproval(taskCount: number, taskTitles: string[]): confirm
    6. confirmTaskEscalation(taskTitle: string, reason: string): choice between "continue" (retry), "skip", "abort"
    Rendering:
    7. formatInteractionForAgent(req: InteractionRequest): string — renders as text the parent agent can present to the user
    8. parseUserResponse(req: InteractionRequest, rawInput: string): string — validates user input against options, returns normalized key
  files: [src/workflow/interaction.ts]
- title: Implement plan-draft phase
  description: |
    Create src/workflow/phases/plan.ts:
    1. runPlanDraftPhase(state, ctx, signal): async function
    2. Dispatch scout with buildScoutPrompt(ctx.cwd). Extract output text.
    3. Generate planPath: docs/plans/YYYY-MM-DD-<slugified-description>.md
    4. Dispatch implementer (as planner) with buildPlannerPrompt(scoutOutput, state.userDescription, planPath). The agent writes the plan file.
    5. Read the plan file back from disk. Parse tasks via parseTaskBlock() from state.ts (reuse existing parser).
    6. If 0 tasks parsed: retry once with feedback prompt ("Plan must contain a superteam-tasks block with at least one task"). If still 0: set state.error, return.
    7. Store planPath, planContent, tasks in state. Set phase="plan-review".
    8. Save state, update widget.
    Uses dispatch.ts for dispatching scout and implementer agents.
  files: [src/workflow/phases/plan.ts]
- title: Implement plan-review phase
  description: |
    Create src/workflow/phases/plan-review.ts:
    1. runPlanReviewPhase(state, ctx, signal): async function
    2. Dispatch architect and spec-reviewer in parallel (dispatchParallel) with buildPlanReviewPrompt(planContent, type). Plan content passed inline — reviewers don't read the file.
    3. Parse both outputs via parseReviewOutput().
    4. If both pass: set pendingInteraction = confirmPlanApproval(). Return (user must confirm).
    5. On user confirmation ("approve"): set phase="configure". On "revise": stay in plan-review, set a flag for manual revision.
    6. If either fails AND reviewMode="iterative": dispatch implementer with buildPlanRevisionPrompt(). Read revised plan, re-parse tasks. Increment planReviewCycles. Loop up to maxPlanReviewCycles.
    7. If either fails AND reviewMode="single-pass": show findings as warning, set pendingInteraction = confirmPlanApproval() anyway.
    8. On max cycles exceeded: escalate — show accumulated findings, ask user to approve or abort.
    9. Update widget after each review cycle.
    Note: reviewMode defaults to "single-pass" initially (configure phase hasn't run yet). The plan review always does at least one pass. The reviewMode question in configure is for task-level reviews.
  files: [src/workflow/phases/plan-review.ts]
- title: Implement configure phase
  description: |
    Create src/workflow/phases/configure.ts:
    1. runConfigurePhase(state, ctx, userInput?): async function. Pure TS, no agent dispatches.
    2. Uses pendingInteraction to track which question we're on. Sequence:
       a. askExecutionMode() → user picks auto/checkpoint/batch
       b. If batch: askBatchSize() → user enters number
       c. (reviewMode was already set for plan-review; for task-level reviews use same setting)
    3. Each call: if pendingInteraction exists and userInput provided, parse response, store in config, clear pending, ask next question.
    4. When all config collected: set state.config fully, print summary ("Ready to execute N tasks, mode=auto, review=iterative, TDD enforced"), set phase="execute".
    5. Save state after each question/answer.
  files: [src/workflow/phases/configure.ts]
- title: Implement execute phase
  description: |
    Create src/workflow/phases/execute.ts. This is the core SDD loop, driven entirely by orchestrator state.
    1. runExecutePhase(state, ctx, signal): async function
    2. Per task (starting from state.currentTaskIndex):
       a. Check cost budget (checkCostBudget from dispatch.ts). If exceeded, set error, return.
       b. Record gitShaBeforeImpl via getCurrentSha()
       c. Set task status "implementing", save state, update widget
       d. Dispatch implementer with buildImplPrompt(). Implementer agent gets TDD skill via existing dispatch.ts logic (no changes needed — buildSubprocessArgs already loads TDD skill for implementer).
       e. If implementer fails (exit != 0): escalate via pendingInteraction (continue/skip/abort)
       f. Compute changedFiles via computeChangedFiles(cwd, gitShaBeforeImpl)
       g. Set task status "reviewing", save state, update widget
       h. SPEC REVIEW: dispatch spec-reviewer with buildSpecReviewPrompt(). Parse output.
          - If pass: proceed to quality
          - If fail: dispatch implementer with buildFixPrompt(), re-run spec review. Loop up to maxTaskReviewCycles.
          - If max retries: escalate
       i. QUALITY REVIEW: same loop as spec, with buildQualityReviewPrompt()
       j. OPTIONAL REVIEWS: dispatch security + performance in parallel (dispatchParallel). Parse outputs. Record findings but don't block on failure (unless critical findings — then escalate).
       k. Set task status "complete", save state, update widget
       l. Add cost from all dispatches
    3. Execution mode handling:
       - "auto": continue to next task immediately
       - "checkpoint": save state, return status text. Next /workflow call resumes.
       - "batch": count tasks in this batch, pause when batchSize reached.
    4. When all tasks done (or all remaining are skipped): set phase="finalize".
    5. On escalation: set pendingInteraction with continue/skip/abort. On "skip": mark task skipped, advance. On "abort": set phase="done" with error. On "continue": retry current task.
    Review order hardcoded: spec → quality → optional. Never quality before spec.
  files: [src/workflow/phases/execute.ts]
- title: Implement finalize phase
  description: |
    Create src/workflow/phases/finalize.ts:
    1. runFinalizePhase(state, ctx, signal): async function
    2. Collect only completed tasks (not skipped/escalated).
    3. If no completed tasks: skip final review, just report.
    4. Compute changed files: git diff from earliest gitShaBeforeImpl to HEAD.
    5. Dispatch quality-reviewer with buildFinalReviewPrompt(completedTasks, changedFiles).
    6. Build summary report: tasks completed/skipped/escalated, total cost, final review findings, all changed files.
    7. Set phase="done", clearState(cwd).
    8. Return the summary report text.
  files: [src/workflow/phases/finalize.ts]
- title: Wire orchestrator entry point and /workflow command
  description: |
    Create src/workflow/orchestrator.ts:
    1. runOrchestrator(ctx, signal, userInput?): async function. Top-level dispatch:
       a. Load state from disk. If no state and no userInput: return error "use /workflow <description>".
       b. If pendingInteraction and userInput: parse response, clear pending, continue.
       c. Switch on state.phase, call appropriate phase function.
       d. If phase function sets pendingInteraction: save state, return formatted question.
       e. If phase function advances phase: save state, recurse (continue to next phase) UNLESS execution mode requires pause.
       f. If phase="done": return final report.
    2. In src/index.ts, register:
       a. /workflow command: parse subcommands (status, abort, or description/resume)
       b. "workflow" tool: same logic, callable by agent programmatically
       c. /sdd as deprecated alias
    3. Widget: call updateWidget with orchestrator state (map OrchestratorState to display lines)
    4. On session_start event: check for existing .superteam-workflow.json, notify user if workflow in progress.
  files: [src/workflow/orchestrator.ts, src/index.ts]
- title: Update docs
  description: |
    1. README.md: Add /workflow command section, update workflow description
    2. docs/guides/configuration.md: Document maxPlanReviewCycles, maxTaskReviewCycles if added to .superteam.json
    3. Create docs/guides/workflow.md: Full guide — phases, interaction points, execution modes, resuming after interruption, cost tracking
    4. CHANGELOG.md: New feature entry
  files: [README.md, docs/guides/configuration.md, docs/guides/workflow.md, CHANGELOG.md]
```
