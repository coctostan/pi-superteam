# Workflow Orchestrator Redesign (Brainstorm → Plan → Execute) — TDD Implementation Plan (GPT)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the workflow orchestrator to emulate superpowers’ full development pipeline (brainstorm → plan-write → plan-review → configure → execute → finalize) while keeping *all* flow control in deterministic TypeScript. LLMs are dispatched as isolated subagents for creative work only. The primary UI is the `/workflow` command using `ctx.ui.*` dialogs.

**Architecture:**
- Deterministic workflow loop in TypeScript (`runWorkflowLoop`) drives phase transitions.
- Creative steps (scout/brainstorm/design/plan writing/reviews/implementation) are *subagent dispatches*.
- All subagent outputs that affect control flow are **structured** (`superteam-brainstorm`, `superteam-json`, `superteam-tasks`). Parsing failures trigger retries, never “best guesses”.
- State is persisted to `.superteam-workflow.json` after every step and is resumable.
- A human-readable progress file is maintained alongside plan/design docs.

**Tech Stack:** TypeScript (ESM, runtime loaded via jiti), vitest, pi extension API (`ctx.ui.select/confirm/input/editor/notify/setStatus/setWidget`), pi JSON stream events (`tool_execution_*`).

**Design doc (spec):** `docs/plans/2026-02-07-workflow-redesign-design.md`

---

## Constraints / Non-negotiables

1. **No build step:** pi loads TS directly via jiti.
2. **ESM import specifiers in `src/` must use `.js` extensions.** (Tests can import `.ts`, matching the existing test style in this repo.)
3. **Tests must not spawn subprocesses.**
   - Phase tests **must mock** `dispatchAgent` (and `dispatchParallel` where relevant).
   - Dispatch streaming tests may mock `child_process.spawn` (still no real subprocess).
4. **Tests should verify behavior, not implementation.**
   - Verify state transitions, UI calls, prompts passed to dispatch, parse/error handling.
   - Don’t assert on internal helper functions beyond their public outputs.

---

## Task 1: Add brainstormer + planner agent profiles

**Why:** The redesign needs two new roles:
- `brainstormer` (read-only) to produce structured brainstorm output.
- `planner` (write-only) to write plan files (no bash/edit).

**Files:**
- Create: `agents/brainstormer.md`
- Create: `agents/planner.md`
- Test (modify): `src/dispatch.test.ts`

### Step 1: Write the failing test (RED)
Add a new test in `src/dispatch.test.ts` asserting `discoverAgents(process.cwd(), false)` includes `brainstormer` and `planner`, and that their tool allowlists match the design:
- brainstormer tools include `read,find,grep,ls` and exclude `write,edit,bash`
- planner tools include `read,write,find,grep,ls` and exclude `bash,edit`

### Step 2: Run the test to verify it fails (RED)
Run: `npx vitest run src/dispatch.test.ts`
Expected: FAIL — agents not found.

### Step 3: Implement minimal agent profiles (GREEN)
Create:
- `agents/brainstormer.md` with frontmatter:
  - `name: brainstormer`
  - `description: Generate structured brainstorm outputs (questions/approaches/design sections)`
  - `tools: read,find,grep,ls`
  - System prompt must require ending with a fenced ` ```superteam-brainstorm` JSON block.
- `agents/planner.md` with frontmatter:
  - `name: planner`
  - `description: Write detailed TDD implementation plans to a specified file path`
  - `tools: read,write,find,grep,ls`
  - System prompt must require writing the plan file and including a fenced ` ```superteam-tasks` YAML block.

### Step 4: Re-run tests (GREEN)
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
Create `src/dispatch-stream-events.test.ts` that:
- `vi.mock("node:child_process", ...)` to replace `spawn()` with a fake process.
- The fake process emits JSON lines on stdout for:
  - `tool_execution_start` (e.g. `{ toolName: "read", args: { path: "src/index.ts" } }`)
  - `tool_execution_update`
  - `tool_execution_end`
  - plus at least one `message_end` so dispatch completes normally.
- Call `dispatchAgent(agent, task, cwd, signal, onUpdate, onStreamEvent)` (after implementation) and assert:
  - `onStreamEvent` is called with the parsed tool execution events in order.
  - The callback receives `type`, `toolName`, `args/partialResult/result`, and `isError` where applicable.

Behavior assertion: **given a JSON tool event line, the callback is fired with a friendly normalized object**.

### Step 2: Run the test to verify it fails
Run: `npx vitest run src/dispatch-stream-events.test.ts`
Expected: FAIL — signature/types missing, callback not invoked.

### Step 3: Implement streaming callback (GREEN)
In `src/dispatch.ts`:
- Export:
  - `export type StreamEvent = { type: string; toolName?: string; args?: Record<string, any>; partialResult?: any; result?: any; isError?: boolean; toolCallId?: string }`
  - `export type OnStreamEvent = (event: StreamEvent) => void`
- Extend `runAgent(..., onResultUpdate, onStreamEvent?)`.
- In `processLine()`, when `event.type` is one of:
  - `tool_execution_start`
  - `tool_execution_update`
  - `tool_execution_end`
  then call `onStreamEvent?.({ type, toolName, args, partialResult, result, isError, toolCallId })`.
- Extend `dispatchAgent()` to accept optional `onStreamEvent` and pass it through.
- Keep the parameter optional so existing callers/tests remain valid.

### Step 4: Re-run tests (GREEN)
Run:
- `npx vitest run src/dispatch-stream-events.test.ts`
- `npx vitest run src/dispatch.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/dispatch.ts src/dispatch-stream-events.test.ts
git commit -m "feat(dispatch): stream tool_execution events via onStreamEvent"
```

---

## Task 3: Implement `superteam-brainstorm` output parser

**Why:** The brainstorm phase must parse brainstormer outputs deterministically and retry on parse failures.

**Files:**
- Create: `src/workflow/brainstorm-parser.ts`
- Test (create): `src/workflow/brainstorm-parser.test.ts`

### Step 1: Write the failing test (RED)
Create tests covering:
- Parses a fenced ` ```superteam-brainstorm` JSON block for:
  - `type: "questions"`
  - `type: "approaches"`
  - `type: "design"`
- Returns `{ status: "inconclusive" }` (or `{ status: "error" }`) for:
  - missing fenced block and no fallback JSON
  - malformed JSON
  - unknown `type`

### Step 2: Run test (RED)
Run: `npx vitest run src/workflow/brainstorm-parser.test.ts`
Expected: FAIL — module missing.

### Step 3: Implement parser (GREEN)
In `src/workflow/brainstorm-parser.ts`:
- Export types:
  - `BrainstormQuestion`, `BrainstormApproach`, `DesignSection`
  - `BrainstormPayload = QuestionsPayload | ApproachesPayload | DesignPayload`
  - `BrainstormParseResult = { status: "ok"; data: BrainstormPayload } | { status: "inconclusive"; rawOutput: string; parseError: string }`
- Implement `parseBrainstormOutput(raw: string): BrainstormParseResult`:
  - Extract preferred fenced block with regex `/```superteam-brainstorm\s*\n([\s\S]*?)```/`
  - Fallback to last brace-matched JSON object (copy algorithm from `src/review-parser.ts`)
  - Parse JSON
  - Validate/normalize arrays and fields; never throw.

### Step 4: Re-run test (GREEN)
Run: `npx vitest run src/workflow/brainstorm-parser.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/brainstorm-parser.ts src/workflow/brainstorm-parser.test.ts
git commit -m "feat(workflow): add brainstorm output parser"
```

---

## Task 4: Add progress file generator (`progress.md`)

**Why:** Users need a persistent, human-readable tracker that survives crashes and can be viewed outside pi.

**Files:**
- Create: `src/workflow/progress.ts`
- Test (create): `src/workflow/progress.test.ts`
- Modify: `CHANGELOG.md`

### Step 1: Write failing tests (RED)
`src/workflow/progress.test.ts` should verify:
- `renderProgressMarkdown(state)` includes:
  - `# Workflow: <userDescription>`
  - phase name and cost summary
  - tasks section with `[x]` for complete and `[ ]` for pending
- `getProgressPath(state)` derives:
  - from `designPath` by replacing `-design.md` → `-progress.md`
  - else from `planPath` by replacing `-plan.md` → `-progress.md`
- `writeProgressFile(state, cwd)` writes the file under `docs/plans/` and creates dirs.

### Step 2: Run tests (RED)
Run: `npx vitest run src/workflow/progress.test.ts`
Expected: FAIL — module missing.

### Step 3: Implement minimal progress module (GREEN)
In `src/workflow/progress.ts`:
- Export:
  - `getProgressPath(state: OrchestratorState): string | null`
  - `renderProgressMarkdown(state: OrchestratorState): string`
  - `writeProgressFile(state: OrchestratorState, cwd: string): void`
- Keep it deterministic and side-effect free except `writeProgressFile`.
- Add a brief CHANGELOG entry noting the workflow redesign groundwork (progress file + upcoming brainstorm pipeline).

### Step 4: Re-run tests (GREEN)
Run: `npx vitest run src/workflow/progress.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/progress.ts src/workflow/progress.test.ts CHANGELOG.md
git commit -m "feat(workflow): add progress.md tracker"
```

---

## Task 5: Add workflow UI helpers (`formatStatus`, `formatToolAction`, widgets)

**Why:** Keep UI formatting/presentation deterministic, reusable, and testable.

**Files:**
- Create: `src/workflow/ui.ts`
- Modify: `src/workflow/interaction.ts`
- Test (create): `src/workflow/ui.test.ts`

### Step 1: Write failing tests (RED)
In `src/workflow/ui.test.ts`, verify:
- `formatStatus(state)`:
  - includes phase name
  - includes brainstorm sub-step when `phase === "brainstorm"`
  - includes `task i/n` when `phase === "execute"`
- `formatToolAction(streamEvent)`:
  - `read` shows `reading <path>`
  - `bash` shows `running <snippet>` and truncates long commands
  - `write/edit/grep/find/ls` produce human text
- `createActivityBuffer(max)` ring-buffer behavior:
  - pushes actions and only retains last N

### Step 2: Run tests (RED)
Run: `npx vitest run src/workflow/ui.test.ts`
Expected: FAIL — module missing.

### Step 3: Implement UI helpers (GREEN)
In `src/workflow/ui.ts` export:
- `formatStatus(state)`
- `formatToolAction(event)`
- `createActivityBuffer(maxLines)` (or a small `ActivityBuffer` class)
- `renderActivityWidgetLines({ agentName, taskLabel, actions })` returning string[]

(Phase code/orchestrator code will own *when* to call `ctx.ui.setWidget` / `ctx.ui.setStatus`; helpers should only format.)

In `src/workflow/interaction.ts` (simplification required by the redesign):
- Keep only the pieces needed for the **secondary** `workflow` tool adapter (e.g. `formatInteractionForAgent`, `parseUserResponse`).
- Remove or clearly deprecate the old `PendingInteraction` *builder* helpers that were tied to the old `/workflow` flow (`askReviewMode`, `confirmPlanApproval`, etc.), since `/workflow` will now use `ctx.ui.*` directly.
- Add/adjust unit tests only if interaction behavior changes; otherwise keep changes minimal and type-safe.

### Step 4: Re-run tests (GREEN)
Run: `npx vitest run src/workflow/ui.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/ui.ts src/workflow/interaction.ts src/workflow/ui.test.ts
git commit -m "feat(workflow): add UI helpers and simplify interaction adapter"
```

---

## Task 6: Update workflow state model for brainstorm + design + plan

**Why:** The workflow needs new phases (`brainstorm`, `plan-write`) and new persisted fields (`designPath`, `designContent`, brainstorm step tracking).

**Files:**
- Modify: `src/workflow/orchestrator-state.ts`
- Test (modify): `src/workflow/orchestrator-state.test.ts`
- Modify: `src/workflow/orchestrator-state.ts` (same file) to call `writeProgressFile()` after saving (integration with Task 4)

### Step 1: Write failing tests (RED)
Update `src/workflow/orchestrator-state.test.ts` to assert:
- `createInitialState("x")` starts in `phase: "brainstorm"`
- `state.brainstorm.step === "scout"`
- `OrchestratorPhase` union includes:
  - `brainstorm | plan-write | plan-review | configure | execute | finalize | done`
- State round-trips through `saveState/loadState` with new fields.
- `OrchestratorState` no longer persists `pendingInteraction` (command-driven UI resumes from state fields like `brainstorm.currentQuestionIndex`).

### Step 2: Run tests (RED)
Run: `npx vitest run src/workflow/orchestrator-state.test.ts`
Expected: FAIL.

### Step 3: Implement state changes (GREEN)
In `src/workflow/orchestrator-state.ts`:
- Add types from the design doc:
  - `BrainstormStep`, `BrainstormQuestion`, `BrainstormApproach`, `DesignSection`, `BrainstormState`
- Update `OrchestratorState`:
  - add `brainstorm: BrainstormState`
  - add `designPath?: string`, `designContent?: string`
  - keep `planPath/planContent/tasks/currentTaskIndex/...`
  - remove the persisted `pendingInteraction` field (primary `/workflow` uses direct `ctx.ui.*` and resumes from state indices instead)
- Update `createInitialState(description)`:
  - `phase: "brainstorm"`
  - `brainstorm: { step: "scout" }`
- In `saveState()`, after writing `.superteam-workflow.json`, call `writeProgressFile(state, cwd)` (import from `./progress.js`).

### Step 4: Re-run tests (GREEN)
Run: `npx vitest run src/workflow/orchestrator-state.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/orchestrator-state.ts src/workflow/orchestrator-state.test.ts
git commit -m "feat(workflow): extend orchestrator state for brainstorm pipeline"
```

---

## Task 7: Implement brainstorm phase (`phases/brainstorm.ts`)

**Why:** This is the new interactive design refinement loop (scout → questions → approaches → design sections → save design doc).

**Files:**
- Create: `src/workflow/phases/brainstorm.ts`
- Test (create): `src/workflow/phases/brainstorm.test.ts`
- Modify: `src/workflow/prompt-builder.ts`

### Step 1: Write failing tests (RED)
Create `src/workflow/phases/brainstorm.test.ts` that mocks:
- `vi.mock("../../dispatch.js", () => ({ discoverAgents, dispatchAgent, getFinalOutput }))`
- `dispatchAgent` returns deterministic `DispatchResult` objects (no subprocess)
- `getFinalOutput` returns the raw assistant text containing a `superteam-brainstorm` block

Test behaviors:
1. **Scout step:** when `state.brainstorm.step === "scout"`, it dispatches `scout`, stores `scoutOutput`, advances to `questions`.
2. **Questions step:** it dispatches `brainstormer` for questions, calls `ctx.ui.select`/`ctx.ui.input` for each question, stores answers, advances to `approaches`.
3. **Approaches step:** it dispatches `brainstormer`, calls `ctx.ui.select` to pick an approach (supports “Other”), stores `chosenApproach`, advances to `design`.
4. **Design step:** it dispatches `brainstormer`, iterates sections, calls `ctx.ui.confirm` to approve; when all approved it writes `docs/plans/YYYY-MM-DD-<slug>-design.md` and sets `designPath/designContent`, sets `phase: "plan-write"`.

Also add cancellation behavior tests:
- if any UI call returns `undefined`, the phase function returns without advancing (state still persisted by orchestrator loop).

### Step 2: Run tests (RED)
Run: `npx vitest run src/workflow/phases/brainstorm.test.ts`
Expected: FAIL — module missing.

### Step 3: Implement prompts + brainstorm phase (GREEN)
In `src/workflow/prompt-builder.ts` add:
- `buildBrainstormQuestionsPrompt(...)`
- `buildBrainstormApproachesPrompt(...)`
- `buildBrainstormDesignPrompt(...)`
- `buildBrainstormSectionRevisionPrompt(...)` (minimal; can be used when a section is rejected)
- `buildPlannerPromptFromDesign(...)` (used by the next phase; keeps all prompt templates centralized)

In `src/workflow/phases/brainstorm.ts` implement `runBrainstormPhase(state, ctx, signal?)`:
- Uses `discoverAgents(ctx.cwd, true)`; requires `scout` and `brainstormer`.
- Accumulates `state.totalCostUsd += result.usage.cost`.
- Writes design doc to `docs/plans/<date>-<slug>-design.md`.
- Sets `state.phase = "plan-write"` on completion.

### Step 4: Re-run tests (GREEN)
Run: `npx vitest run src/workflow/phases/brainstorm.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/brainstorm.ts src/workflow/phases/brainstorm.test.ts src/workflow/prompt-builder.ts
git commit -m "feat(workflow): add interactive brainstorm phase"
```

---

## Task 8: Implement plan-write phase (`phases/plan-write.ts`)

**Why:** Replace old `plan-draft` with a dedicated `planner` agent that writes a plan from the approved design.

**Files:**
- Create: `src/workflow/phases/plan-write.ts`
- Remove: `src/workflow/phases/plan.ts`
- Test (create): `src/workflow/phases/plan-write.test.ts`

### Step 1: Write failing tests (RED)
In `plan-write.test.ts` mock `dispatchAgent` so that when the planner is dispatched it writes a plan file into the temp cwd, containing a valid `superteam-tasks` block.

Verify behaviors:
- chooses the `planner` agent (not implementer)
- prompt includes `state.designContent`
- reads plan back, parses tasks, updates:
  - `state.planPath`, `state.planContent`
  - `state.tasks` and `state.currentTaskIndex = 0`
  - `state.phase = "plan-review"`
- retry once if task parsing yields 0 tasks (planner re-dispatched)

### Step 2: Run tests (RED)
Run: `npx vitest run src/workflow/phases/plan-write.test.ts`
Expected: FAIL.

### Step 3: Implement (GREEN)
- Implement `runPlanWritePhase(state, ctx, signal?)`.
- Use `buildPlannerPromptFromDesign(...)` from `src/workflow/prompt-builder.ts` (added in Task 7) to keep prompt text deterministic and reusable.
- Keep file path generation consistent with brainstorm: `docs/plans/<date>-<slug>-plan.md`.
- Delete the old phase implementation `src/workflow/phases/plan.ts` (superseded by `plan-write.ts`).

### Step 4: Re-run tests (GREEN)
Run: `npx vitest run src/workflow/phases/plan-write.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/plan-write.ts src/workflow/phases/plan-write.test.ts
git rm src/workflow/phases/plan.ts
git commit -m "feat(workflow): add plan-write phase using planner agent"
```

---

## Task 9: Update plan-review phase (include design context + planner revision loop)

**Why:** Reviewers must validate the plan against the approved design. If reviews fail, the **planner** revises the plan, then re-review.

**Files:**
- Modify: `src/workflow/phases/plan-review.ts`
- Test (create): `src/workflow/phases/plan-review.test.ts`
- Modify: `src/workflow/prompt-builder.ts`

### Step 1: Write failing tests (RED)
Create `plan-review.test.ts` that mocks `dispatchAgent` and verifies:
- Review prompts contain both `<plan>` and `<design>` content.
- Reviews are dispatched **sequentially**: architect, then spec-reviewer.
- If a reviewer fails (returns `passed:false` in `superteam-json`), the planner is dispatched with a revision prompt and the plan is re-read.
- When both pass, the phase asks the user to approve via `ctx.ui.select` (Approve / Revise / Abort), and:
  - Approve → `state.phase = "configure"`
  - Revise → collects feedback via `ctx.ui.editor`, dispatch planner revision, then re-review
  - Abort → sets `state.error` and exits

### Step 2: Run tests (RED)
Run: `npx vitest run src/workflow/phases/plan-review.test.ts`
Expected: FAIL.

### Step 3: Implement (GREEN)
In `prompt-builder.ts`:
- Update `buildPlanReviewPrompt(planContent, reviewType, designContent?)` to embed design context.
- Add `buildPlanRevisionPromptFromFindings({ planContent, designContent, findingsText })`.

In `plan-review.ts`:
- Use `discoverAgents` to locate `architect`, `spec-reviewer`, `planner`.
- Sequential dispatch:
  1) architect review
  2) spec review
- Parse outputs via existing `parseReviewOutput`.
- Revision loop: max `state.config.maxPlanReviewCycles ?? 3`.

### Step 4: Re-run tests (GREEN)
Run: `npx vitest run src/workflow/phases/plan-review.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/plan-review.ts src/workflow/phases/plan-review.test.ts src/workflow/prompt-builder.ts
git commit -m "feat(workflow): review plan against design with iterative planner revisions"
```

---

## Task 10: Rewrite configure phase to use direct `ctx.ui.*`

**Why:** `/workflow` command must not rely on LLM round-trips for user interaction.

**Files:**
- Modify: `src/workflow/phases/configure.ts`
- Test (create): `src/workflow/phases/configure.test.ts`

### Step 1: Write failing tests (RED)
Create `configure.test.ts` verifying:
- Prompts execution mode via `ctx.ui.select` (Auto / Checkpoint / Batch).
- Prompts review mode via `ctx.ui.select` (Iterative / Single-pass).
- If Batch chosen, prompts batch size via `ctx.ui.input` and parses int with default 3.
- If user cancels (`undefined`), state does not advance.

### Step 2: Run tests
Run: `npx vitest run src/workflow/phases/configure.test.ts`
Expected: FAIL.

### Step 3: Implement (GREEN)
Rewrite `runConfigurePhase(state, ctx)` to:
- call `ctx.ui.select()` / `ctx.ui.input()` directly
- populate `state.config.{executionMode, reviewMode, batchSize}`
- set defaults for `maxPlanReviewCycles/maxTaskReviewCycles` if unset
- advance to `execute`.

### Step 4: Re-run tests
Run: `npx vitest run src/workflow/phases/configure.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/configure.ts src/workflow/phases/configure.test.ts
git commit -m "feat(workflow): configure phase uses direct UI dialogs"
```

---

## Task 11: Update execute phase (UI escalation + streaming activity widget)

**Why:** Execute phase becomes the primary UX; it must show progress and handle escalation with `ctx.ui.select`, while updating status/widget from streaming tool events.

**Files:**
- Modify: `src/workflow/phases/execute.ts`
- Test (create): `src/workflow/phases/execute.test.ts`

### Step 1: Write failing tests (RED)
In `execute.test.ts`, mock:
- `../../dispatch.js` (`dispatchAgent`, `dispatchParallel`, `discoverAgents`, `getFinalOutput`, `checkCostBudget`)
- `../git-utils.js` (`getCurrentSha`, `computeChangedFiles`)
- `../../review-parser.js` `parseReviewOutput` to return pass/fail deterministically.

Test behaviors:
1. **Escalation uses UI:** when implementer dispatch returns `exitCode !== 0`, it calls `ctx.ui.select` (Retry / Skip / Abort) and updates task status accordingly.
2. **Passes onStreamEvent through:** mock `dispatchAgent` to call the provided `onStreamEvent` with a `tool_execution_start` event; assert `ctx.ui.setStatus("workflow", ...)` called with a human-readable action.
3. **Marks task complete and advances index** on happy path (impl pass + reviews pass).

### Step 2: Run tests (RED)
Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: FAIL.

### Step 3: Implement minimal changes (GREEN)
In `execute.ts`:
- Replace all `pendingInteraction` escalation logic with `await ctx.ui.select(...)`.
- When dispatching agents, pass an `onStreamEvent` callback to `dispatchAgent` that:
  - updates `ctx.ui.setStatus("workflow", `⚡ ${agentName}: ${formatToolAction(event)}`)` on `tool_execution_start`
  - appends to an activity buffer and updates `ctx.ui.setWidget("workflow-activity", lines)`
- After each task completion, update `ctx.ui.setWidget("workflow-progress", ...)` with progress lines.

### Step 4: Re-run tests (GREEN)
Run: `npx vitest run src/workflow/phases/execute.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/phases/execute.ts src/workflow/phases/execute.test.ts
git commit -m "feat(workflow): execute phase uses UI escalation and streaming activity"
```

---

## Task 12: Rewrite orchestrator + `/workflow` command (primary UI) and simplify tool path

**Why:** The `/workflow` command becomes the primary interface. It must start/resume deterministically using direct UI dialogs.

**Files:**
- Modify: `src/workflow/orchestrator.ts`
- Modify: `src/index.ts`
- Test (modify): `src/workflow/orchestrator.test.ts`

### Step 1: Write failing tests (RED)
Update `src/workflow/orchestrator.test.ts` to mock phase modules by their **`.js` import specifiers** (important!):
- `vi.mock("./phases/brainstorm.js", ...)`
- `vi.mock("./phases/plan-write.js", ...)`
- `vi.mock("./phases/plan-review.js", ...)` etc.

Test behaviors:
1. `runWorkflowLoop(state, ctx)`:
   - calls the phase function matching `state.phase`
   - persists state after each phase (spy on `saveState`)
   - stops when phase becomes `done` or when a phase returns with `state.error`
   - clears status/widget on exit (`ctx.ui.setStatus("workflow", undefined)` and widgets cleared)
2. `/workflow` command behavior (unit-level):
   - If no state and no args, calls `ctx.ui.input` to request description
   - Creates initial state and saves it
   - Invokes `runWorkflowLoop`

(Keep the command tests focused on observable UI calls and state-file behavior; avoid requiring a full `ExtensionAPI` harness.)

### Step 2: Run tests (RED)
Run: `npx vitest run src/workflow/orchestrator.test.ts`
Expected: FAIL.

### Step 3: Implement (GREEN)
In `src/workflow/orchestrator.ts`:
- Replace the old `runOrchestrator()` loop with:
  - `export async function runWorkflowLoop(state, ctx, signal?)` implementing the design doc loop.
  - A small `runWorkflowTool(ctx, signal, input?)` adapter (secondary interface) that can keep the old tool contract if needed.

In `src/index.ts`:
- Rewrite `/workflow` command per design doc:
  - `status` and `abort` subcommands unchanged but updated fields if needed
  - start/resume logic:
    - load state from `.superteam-workflow.json`
    - if args provided and state exists, ask to replace (via `ctx.ui.confirm`)
    - if no args and no state, prompt via `ctx.ui.input`
    - save initial state, run `runWorkflowLoop`

### Step 4: Re-run tests (GREEN)
Run: `npx vitest run src/workflow/orchestrator.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add src/workflow/orchestrator.ts src/index.ts src/workflow/orchestrator.test.ts
git commit -m "feat(workflow): rewrite orchestrator loop and /workflow command for direct UI"
```

---

## Task 13: Update docs for new workflow (brainstorm + streaming + progress file)

**Why:** Users need updated guidance; existing docs describe the old plan-draft pipeline.

**Files:**
- Modify: `docs/guides/workflow.md`
- Modify: `docs/guides/agents.md`
- Test (create): `src/workflow/docs.test.ts`

### Step 1: Add a doc regression test (RED)
Create `src/workflow/docs.test.ts` that reads the two guides and asserts they mention:
- phases: `brainstorm` and `plan-write`
- new agents: `brainstormer` and `planner`
- progress file: `-progress.md`

### Step 2: Run the test (RED)
Run: `npx vitest run src/workflow/docs.test.ts`
Expected: FAIL.

### Step 3: Update docs (GREEN)
- Update `docs/guides/workflow.md`:
  - new phase diagram
  - explain streaming status/widget
  - explain progress file path
  - clarify `/workflow` is primary, tool is secondary
- Update `docs/guides/agents.md` to include new agents and their tool constraints.

(CHANGELOG was already updated in Task 4 to stay within the 1–3 files-per-task constraint.)

### Step 4: Re-run test (GREEN)
Run: `npx vitest run src/workflow/docs.test.ts`
Expected: PASS.

### Step 5: Commit
```bash
git add docs/guides/workflow.md docs/guides/agents.md src/workflow/docs.test.ts
git commit -m "docs(workflow): document brainstorm redesign and streaming UI"
```

---

## Dependency order

- Foundation (can be done in parallel): Tasks 1–6
- Phase implementations: Tasks 7–11
- Integration entry points: Task 12
- Docs: Task 13

---

```superteam-tasks
- title: Add brainstormer + planner agent profiles
  description: Create new agent profiles in agents/ and assert they are discoverable with correct tool allowlists.
  files: [agents/brainstormer.md, agents/planner.md, src/dispatch.test.ts]
- title: Stream tool execution events from dispatch
  description: Add onStreamEvent callback to dispatchAgent/runAgent; parse tool_execution_start/update/end from JSON mode and emit to orchestrator.
  files: [src/dispatch.ts, src/dispatch-stream-events.test.ts]
- title: Parse superteam-brainstorm outputs
  description: Add deterministic parser for brainstormer outputs (questions/approaches/design) using fenced block extraction with fallback.
  files: [src/workflow/brainstorm-parser.ts, src/workflow/brainstorm-parser.test.ts]
- title: Generate and write workflow progress markdown
  description: Implement renderProgressMarkdown + writeProgressFile and path derivation; used after each saveState. Also add a brief CHANGELOG entry.
  files: [src/workflow/progress.ts, src/workflow/progress.test.ts, CHANGELOG.md]
- title: Add workflow UI formatting helpers
  description: Implement formatStatus/formatToolAction and activity buffer utilities for widgets and footer status. Simplify the legacy interaction adapter module.
  files: [src/workflow/ui.ts, src/workflow/interaction.ts, src/workflow/ui.test.ts]
- title: Update orchestrator state model for brainstorm pipeline
  description: Extend OrchestratorState with brainstorm state + design fields; update phase union and initial state; call writeProgressFile from saveState.
  files: [src/workflow/orchestrator-state.ts, src/workflow/orchestrator-state.test.ts]
- title: Implement brainstorm phase
  description: Add phases/brainstorm.ts implementing scout→questions→approaches→design→save design doc, using ctx.ui dialogs and structured parsing.
  files: [src/workflow/phases/brainstorm.ts, src/workflow/phases/brainstorm.test.ts, src/workflow/prompt-builder.ts]
- title: Implement plan-write phase
  description: Add phases/plan-write.ts dispatching planner agent with design context; parse superteam-tasks and advance to plan-review. Remove the old plan-draft phase file.
  files: [src/workflow/phases/plan-write.ts, src/workflow/phases/plan.ts, src/workflow/phases/plan-write.test.ts]
- title: Update plan-review phase for design context + planner revisions
  description: Review plan against design using architect then spec reviewer; on failure iterate planner revisions; use ctx.ui.select for user approval.
  files: [src/workflow/phases/plan-review.ts, src/workflow/phases/plan-review.test.ts, src/workflow/prompt-builder.ts]
- title: Rewrite configure phase with direct UI
  description: Replace pendingInteraction/userInput with ctx.ui.select/input and advance to execute.
  files: [src/workflow/phases/configure.ts, src/workflow/phases/configure.test.ts]
- title: Update execute phase for streaming activity + UI escalation
  description: Pass onStreamEvent into dispatchAgent; update ctx.ui status/widget from tool activity; handle retry/skip/abort via ctx.ui.select.
  files: [src/workflow/phases/execute.ts, src/workflow/phases/execute.test.ts]
- title: Rewrite orchestrator loop and /workflow command
  description: Implement runWorkflowLoop across all phases; rewrite /workflow command to start/resume using direct UI. Keep workflow tool as secondary adapter.
  files: [src/workflow/orchestrator.ts, src/index.ts, src/workflow/orchestrator.test.ts]
- title: Update documentation for redesigned workflow
  description: Update workflow + agents guides; add a small doc regression test.
  files: [docs/guides/workflow.md, docs/guides/agents.md, src/workflow/docs.test.ts]
```
