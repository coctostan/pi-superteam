# Workflow Orchestrator Redesign — Design Document

## Goal

Rebuild the workflow orchestrator to emulate superpowers' full development pipeline (brainstorm → design → plan → review → execute → finalize) while keeping all flow control in deterministic TypeScript. LLMs are dispatched as subagents with fresh context for creative tasks only. Users interact through pi's native UI dialogs, not through LLM-mediated tool calls.

## Design Principles

1. **Orchestrator controls flow, agents do creative work.** Every decision point, every approval gate, every retry is TypeScript. Agents generate questions, proposals, designs, code — but never decide what to do next.

2. **Fresh context per dispatch.** Every agent call is a subagent with `--mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-themes` plus only the tools/skills/extensions that specific role needs. No context bleed between dispatches.

3. **Structured agent output.** Agents return structured data in fenced code blocks (`superteam-json`, `superteam-brainstorm`, `superteam-plan`). The orchestrator parses these deterministically. If parsing fails, the orchestrator retries with a clearer prompt — it never guesses.

4. **Direct user interaction.** The `/workflow` command uses `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.input()`, and `ctx.ui.editor()` for all user interaction. No `pendingInteraction` round-trip through an LLM.

5. **Persistent state, resumable.** Full state saved to `.superteam-workflow.json` after every step. `/workflow` with an active state resumes from exactly where it left off, re-presenting any pending question.

6. **Visibility.** Footer status shows current phase + progress. Every agent dispatch shows what's happening. Every error includes the agent's output and the exact failure point.

---

## Real-Time Visibility

### The Problem

When an agent runs (2-10 minutes per dispatch), the user currently sees nothing until it finishes. The orchestrator also has no insight into whether the agent is making progress or stuck.

### Solution: Streaming Event Callback

Pi's JSON mode emits granular events for every tool call:

```
tool_execution_start  → {toolName: "read", args: {path: "src/auth.ts"}}
tool_execution_update → {toolName: "bash", partialResult: "PASS 3/3 tests"}
tool_execution_end    → {toolName: "write", args: {path: "src/auth.test.ts"}}
```

`runAgent` in `dispatch.ts` already parses these line-by-line but discards most. We add an `onStreamEvent` callback:

```typescript
type StreamEvent = {
  type: string;
  toolName?: string;
  args?: Record<string, any>;
  result?: any;
  isError?: boolean;
};

type OnStreamEvent = (event: StreamEvent) => void;

async function runAgent(
  agent, task, cwd, step, signal,
  onResultUpdate,
  onStreamEvent?:  OnStreamEvent,  // NEW
): Promise<DispatchResult>
```

The orchestrator passes an `onStreamEvent` that updates the UI:

### Activity Widget

A live-updating widget above the editor showing the last 6-8 agent actions:

```
┌─ ⚡ Task 3/7: Add auth middleware ─────────────────┐
│  implementer (claude-opus-4-6)                     │
│  ├ read src/middleware/index.ts                     │
│  ├ write src/middleware/auth.test.ts                │
│  ├ bash: vitest run auth ✗ (RED — expected)        │
│  ├ write src/middleware/auth.ts                     │
│  ├ bash: vitest run auth ✓ (GREEN)                 │
│  └ edit src/middleware/auth.ts (refactoring)        │
└────────────────────────────────────────────────────┘
```

Implementation: `ctx.ui.setWidget("workflow-activity", lines)` — the orchestrator maintains a ring buffer of recent activity lines and updates the widget on each stream event.

### Status Bar

One-liner in the footer showing current action:

```
⚡ implementer: running vitest auth...
⚡ spec-reviewer: reading src/middleware/auth.ts
⚡ quality-reviewer: reviewing 4 files...
```

Updated via `ctx.ui.setStatus("workflow", text)` on each `tool_execution_start` event. The `formatToolAction()` helper extracts a human-readable summary:

- `read` → `reading <path>`
- `bash` → `running <command snippet>`
- `write` → `writing <path>`
- `edit` → `editing <path>`
- `grep` → `searching for <pattern>`
- `find` → `finding files...`

### Orchestrator Monitoring

The `onStreamEvent` callback also enables orchestrator-side monitoring:

- **Stuck detection:** If no `tool_execution_start` arrives for 90+ seconds, the agent may be stuck (model timeout, infinite loop). The orchestrator can warn the user.
- **Error early detection:** If a `tool_execution_end` has `isError: true` on a critical tool (like bash returning non-zero repeatedly), the orchestrator can surface a warning before the agent finishes.
- **Cost tracking:** Update running cost display as `message_end` events arrive with usage data.

### During Reviews

The same widget shows reviewer activity:

```
┌─ ⚡ Task 3/7: spec review ─────────────────────────┐
│  spec-reviewer (claude-opus-4-6)                   │
│  ├ read src/middleware/auth.ts                      │
│  ├ read src/middleware/auth.test.ts                 │
│  ├ grep "authenticate" src/                        │
│  └ (analyzing spec compliance...)                  │
└────────────────────────────────────────────────────┘
```

### During Brainstorm

For brainstorm dispatches (shorter, read-only), a simpler status:

```
⚡ Brainstorm: scout exploring codebase...
⚡ Brainstorm: generating questions...
⚡ Brainstorm: proposing approaches...
```

---

## Progress File (todo.md)

### Purpose

A persistent, human-readable progress tracker that the orchestrator maintains. Updated after every state change. Lives alongside the design and plan files.

**Location:** `docs/plans/YYYY-MM-DD-<slug>-progress.md`

### Format

```markdown
# Workflow: Add user authentication

**Status:** Executing (task 3/7) | **Cost:** $3.42 | **Started:** 2026-02-07 13:52 UTC

## Brainstorm
- [x] Scout codebase
- [x] Requirements (5 questions answered)
- [x] Approach: Passport.js middleware pattern
- [x] Design validated (4/4 sections)
- [x] Design: docs/plans/2026-02-07-auth-design.md

## Plan
- [x] Plan: docs/plans/2026-02-07-auth-plan.md
- [x] Architect review: ✓
- [x] Spec review: ✓
- [x] Approved by user

## Config
- Execution: auto | Review: iterative | TDD: enforced

## Tasks
- [x] 1. Create user model — spec ✓ quality ✓
- [x] 2. Add Passport strategies — spec ✓ quality ✓ 
- [ ] 3. Add auth middleware — implementing...
- [ ] 4. Add login/logout endpoints
- [ ] 5. Add session management
- [ ] 6. Add integration tests
- [ ] 7. Update API docs

## Log
- 13:52 — Workflow started
- 13:53 — Scout completed (42 files mapped)
- 13:55 — Design approved
- 13:57 — Plan written (7 tasks)
- 13:58 — Plan review passed
- 14:02 — Task 1 complete ($0.48)
- 14:07 — Task 2 complete ($0.62)
- 14:08 — Task 3 started
```

### Benefits

- **Human readable** — glance at it anytime, even outside pi
- **Persistent** — survives crashes, restarts, session switches
- **Git trackable** — commit with the project for team visibility
- **Agent context** — agents could read it if needed
- **Log section** — timestamped audit trail of what happened

### Implementation

A `writeProgressFile(state: OrchestratorState, cwd: string)` function in `src/workflow/progress.ts`. Called after every `saveState()`. Pure function — takes state, produces markdown string, writes to disk. Easy to test.

---

## Phase Architecture

```
/workflow "Add user authentication"
    │
    ▼
┌─────────────┐
│  BRAINSTORM  │  Interactive design refinement
│              │  Scout → Questions → Approaches → Design sections
└──────┬──────┘
       │ design doc saved
       ▼
┌─────────────┐
│  PLAN-WRITE  │  Planner agent writes detailed TDD implementation plan
└──────┬──────┘
       │ plan file saved
       ▼
┌─────────────┐
│  PLAN-REVIEW │  Architect + spec review of plan (fix loop if needed)
└──────┬──────┘
       │ plan approved
       ▼
┌─────────────┐
│  CONFIGURE   │  Execution mode, review mode, batch size
└──────┬──────┘
       │ config set
       ▼
┌─────────────┐
│   EXECUTE    │  Per task: implement → spec review → quality review → fix loop
└──────┬──────┘
       │ all tasks done
       ▼
┌─────────────┐
│   FINALIZE   │  Final cross-task review + completion report
└─────────────┘
```

---

## Phase 1: Brainstorm

The brainstorm phase is the biggest addition and most nuanced. It replaces the old plan-draft's "dispatch scout + dispatch planner" with an interactive, multi-step design refinement.

### Sub-steps

**1a. Scout** — Dispatch scout agent to explore codebase. Returns structured summary of files, tech stack, conventions, existing patterns.

**1b. Questions** — Dispatch brainstormer agent with scout output + user description. Agent returns 3-7 questions as structured JSON. Orchestrator presents each question to the user one-by-one via `ctx.ui.select()` (for multiple choice) or `ctx.ui.input()` (for open-ended). Answers accumulated in state.

**1c. Approaches** — Dispatch brainstormer agent with scout output + user description + all Q&A answers. Agent proposes 2-3 implementation approaches with trade-offs, plus its recommendation. Returns structured JSON. Orchestrator presents via `ctx.ui.select()` with the recommendation highlighted. User picks one, or selects "Other" to describe their own approach via `ctx.ui.input()`.

**1d. Design Sections** — Dispatch brainstormer agent with everything above + chosen approach. Agent writes the full design as structured JSON: array of `{title, content}` sections (200-300 words each). Covers: architecture, components, data flow, error handling, testing approach. Orchestrator presents each section via `ctx.ui.confirm()` with the section content shown. If user rejects a section, `ctx.ui.input()` collects feedback, and a revision dispatch updates just that section.

**1e. Save** — Orchestrator assembles all approved sections into markdown. Saves to `docs/plans/YYYY-MM-DD-<topic>-design.md`. Path stored in state.

### Agent Dispatches

| Dispatch | Agent | What it gets | What it returns |
|----------|-------|-------------|----------------|
| Scout | `scout` | cwd path | Text summary |
| Questions | `brainstormer` | scout output + user description | `superteam-brainstorm` JSON with questions array |
| Approaches | `brainstormer` | scout output + user desc + Q&A answers | `superteam-brainstorm` JSON with approaches array |
| Design | `brainstormer` | all above + chosen approach | `superteam-brainstorm` JSON with sections array |
| Section revision | `brainstormer` | section + user feedback + context | `superteam-brainstorm` JSON with revised section |

### Structured Output Format

```json
// Questions response
{
  "type": "questions",
  "questions": [
    {"id": "q1", "text": "What auth provider?", "type": "choice", "options": ["OAuth", "SAML", "Custom"]},
    {"id": "q2", "text": "What's the performance target?", "type": "input", "placeholder": "e.g., <100ms p99"}
  ]
}

// Approaches response
{
  "type": "approaches",
  "approaches": [
    {
      "id": "a1",
      "title": "State machine pattern",
      "summary": "Clean separation, easy to test",
      "tradeoffs": "More boilerplate upfront",
      "taskEstimate": 5
    },
    ...
  ],
  "recommendation": "a1",
  "reasoning": "Best fit given the project's existing patterns"
}

// Design response
{
  "type": "design",
  "sections": [
    {"id": "s1", "title": "Architecture", "content": "The system uses..."},
    {"id": "s2", "title": "Data Flow", "content": "User input flows..."},
    ...
  ]
}
```

### Error Handling

- Agent dispatch fails (non-zero exit) → show error + agent output snippet, offer retry or abort
- Structured output parse fails → retry dispatch with explicit format reminder (max 2 retries)
- User cancels any dialog (presses Escape) → save state, return cleanly. Resume picks up at that question.
- Scout returns empty → warn user, proceed with just user description

### State Tracking

```typescript
brainstormState: {
  step: "scout" | "questions" | "approaches" | "design" | "done";
  scoutOutput?: string;
  questions?: Array<{id, text, type, options?, answer?}>;
  approaches?: Array<{id, title, summary, tradeoffs, taskEstimate}>;
  chosenApproach?: string;
  designSections?: Array<{id, title, content, approved: boolean}>;
}
```

---

## Phase 2: Plan-Write

Dispatch a dedicated `planner` agent with:
- The approved design document (full text)
- Scout output (codebase context)
- User's original description

The planner writes a detailed implementation plan following the superpowers format:
- Goal, Architecture, Tech Stack header
- Bite-sized tasks (2-5 minutes each)
- Each task has exact file paths, test-first steps, verification commands
- Tasks have `superteam-tasks` YAML block for machine parsing

The orchestrator reads the plan file, parses the `superteam-tasks` block, extracts tasks into state.

### Planner Agent Profile

```yaml
name: planner
description: Write detailed TDD implementation plans from approved designs
tools: read,write,find,grep,ls
```

System prompt instructs: write extremely detailed plans. Each task has exact file paths, complete test code, exact commands with expected output. Assume the implementer has zero project context and questionable taste. DRY, YAGNI, TDD.

Key difference from old approach: planner is NOT the implementer. No TDD guard, no TDD skill, no "you are implementing" system prompt. Just planning.

### Error Handling

- Agent fails → show error + output, offer retry or abort
- Plan file not written → show agent output, offer retry
- No parseable tasks → show plan content, offer retry with more explicit instructions
- 0 tasks after retry → abort with full context

---

## Phase 3: Plan-Review

Two sequential reviews of the plan:

1. **Architect review** — Design patterns, modularity, task ordering, dependencies
2. **Spec review** — Completeness, task independence, file coverage, design alignment

If either fails → dispatch planner to revise plan based on findings → re-review. Max 3 cycles (configurable).

After both pass → present plan summary to user for final approval:
- Show task count and titles
- `ctx.ui.select()`: Approve / Revise (with user feedback via `ctx.ui.editor()`) / Abort

### Reviewers Check Against Design

The review prompts include the design document as context. Reviewers verify the plan implements the approved design — not more, not less. This is a key difference from the current implementation where reviewers only see the plan in isolation.

---

## Phase 4: Configure

Interactive configuration using `ctx.ui.select()`:

1. **Execution mode**: Auto (run all) / Checkpoint (pause per task) / Batch (pause per N tasks)
2. **Review mode**: Single-pass (one round, findings as warnings) / Iterative (review-fix loop until pass)
3. **Batch size** (if batch mode): `ctx.ui.input()` with default "3"

---

## Phase 5: Execute

Per task, in order:

```
For each task:
  1. Cost check
  2. Record git SHA before
  3. Dispatch implementer → implement + TDD + self-review + commit
  4. Compute changed files
  5. Dispatch spec-reviewer → verify against task spec
     - If fail → dispatch implementer to fix → re-review (max N cycles)
  6. Dispatch quality-reviewer → verify code quality
     - If fail → dispatch implementer to fix → re-review (max N cycles)
  7. Optional reviewers (security, performance) → parallel dispatch
     - Critical findings → escalate to user
  8. Mark complete
  9. Execution mode check (checkpoint/batch pause)
```

This is **largely unchanged** from current implementation. The execute phase is solid.

### Implementer Agent

Dispatched with full task text + plan context inline (agent doesn't read plan file). Gets:
- TDD guard extension (loaded because `agent.name === "implementer"`)
- TDD skill
- Tools: read, bash, edit, write, grep, find, ls
- Instruction to self-review before reporting

### Spec Reviewer

Dispatched with task spec + list of changed files. Reads actual code. Verifies implementation matches spec. Returns `superteam-json` with pass/fail + findings.

Key instruction (from superpowers): "Do NOT trust the implementer's report. Read the actual code and compare to requirements line by line."

### Quality Reviewer

Dispatched after spec review passes. Reviews code quality, naming, DRY, error handling, test quality. Returns `superteam-json`.

### Escalation

When a task fails reviews after max retries, or encounters a critical error:
- `ctx.ui.select()`: Continue (retry) / Skip / Abort

---

## Phase 6: Finalize

1. Dispatch final cross-task reviewer with all changed files + all completed tasks
2. If issues found → report to user, offer fix dispatch or accept
3. Generate completion report: tasks done, tasks skipped, total cost, time elapsed
4. `ctx.ui.notify()` with report
5. Clear workflow state

---

## User Interface Design

### Footer Status (persistent during workflow)

```
⚡ Workflow: brainstorm (questions 2/5) | $0.42
⚡ Workflow: execute (task 3/7 — reviewing) | $4.18
```

Updated via `ctx.ui.setStatus("workflow", text)` after every state change.

### Widget (above editor, during execution)

```
│ Workflow: Add user authentication
│ ■■■■■■■■■■■□□□□□□□□□ 55%  (task 4/7)
│ ✓ Create user model  ✓ Add auth middleware  ✓ Add login endpoint
│ ▸ Add session management  ○ Add logout  ○ Add tests  ○ Update docs
```

Updated via `ctx.ui.setWidget("workflow-progress", lines)` after each task completes.

### Dialog Flow (what the user actually sees)

```
User: /workflow

  ┌─ Start Workflow ────────────────────────────┐
  │ What do you want to build?                   │
  │ > Add user authentication with OAuth         │
  └──────────────────────────────────────────────┘

  Status: ⚡ Scouting codebase...

  ┌─ Question 1 of 4 ───────────────────────────┐
  │ What auth provider should be supported?      │
  │   > OAuth 2.0 (Google, GitHub)               │
  │     SAML                                     │
  │     Custom username/password                 │
  │     Multiple providers                       │
  └──────────────────────────────────────────────┘

  ┌─ Question 2 of 4 ───────────────────────────┐
  │ Should sessions be stateless (JWT) or        │
  │ server-side?                                 │
  │   > JWT (stateless)                          │
  │     Server-side sessions                     │
  └──────────────────────────────────────────────┘

  Status: ⚡ Generating approaches...

  ┌─ Choose Approach ───────────────────────────┐
  │ ★ Passport.js middleware pattern             │
  │     Clean, well-tested, 5 tasks              │
  │   Express middleware + custom JWT            │
  │     More control, 7 tasks                    │
  │   Auth0 integration                          │
  │     Fastest, 3 tasks, vendor lock-in         │
  └──────────────────────────────────────────────┘

  Status: ⚡ Writing design...

  Notification: "## Architecture
  The auth system uses Passport.js with a strategy
  pattern. Each provider (Google, GitHub) registers as
  a Passport strategy. Sessions use JWT tokens stored
  in HTTP-only cookies..."

  ┌─ Design Section: Architecture ──────────────┐
  │ Does this section look right?                │
  │   > Yes     No, revise                       │
  └──────────────────────────────────────────────┘

  [... more sections ...]

  Status: ⚡ Writing implementation plan...
  Status: ⚡ Reviewing plan...
  
  Notification: "Plan has 5 tasks:
    1. Create user model and migration
    2. Add Passport.js OAuth strategies
    3. Add auth middleware
    4. Add login/logout endpoints  
    5. Add session tests"

  ┌─ Plan Approval ─────────────────────────────┐
  │   > Approve                                  │
  │     Revise (provide feedback)                │
  │     Abort                                    │
  └──────────────────────────────────────────────┘

  ┌─ Execution Mode ────────────────────────────┐
  │   > Auto (run all tasks)                     │
  │     Checkpoint (pause after each task)       │
  │     Batch (pause every N tasks)              │
  └──────────────────────────────────────────────┘

  ┌─ Review Mode ───────────────────────────────┐
  │   > Iterative (review-fix loop until pass)   │
  │     Single-pass (one round, warnings only)   │
  └──────────────────────────────────────────────┘

  Widget: [progress bar appears]
  Status: ⚡ Executing task 1/5 — implementing...
  
  [... tasks execute with progress updates ...]

  Status: ⚡ Complete! 5/5 tasks. $3.42 total.
  Widget: [cleared]
```

### Error Presentation

Errors are shown via `ctx.ui.notify(message, "warning")` with actionable context:

```
Notification (warning): "Brainstormer agent failed (exit code 1).
  Error: Model rate limited
  Output: 'Error: 429 Too Many Requests...'

  Use /workflow to retry from this step."
```

For recoverable errors during execution:
```
  ┌─ Task Escalation ──────────────────────────┐
  │ Task "Add auth middleware" failed spec       │
  │ review after 3 attempts.                     │
  │                                              │
  │ Last findings:                               │
  │   - Missing: CORS header handling            │
  │   - Missing: Rate limiting                   │
  │                                              │
  │   > Retry                                    │
  │     Skip this task                           │
  │     Abort workflow                           │
  └──────────────────────────────────────────────┘
```

---

## Agent Roster

### Existing (unchanged)

| Agent | Role | Tools | Model | Extras |
|-------|------|-------|-------|--------|
| `scout` | Codebase reconnaissance | read,grep,find,ls,bash | claude-sonnet-4-5 | — |
| `implementer` | TDD implementation | read,bash,edit,write,grep,find,ls | claude-opus-4-6 | TDD guard ext + TDD skill |
| `spec-reviewer` | Spec compliance check | read,grep,find,ls | claude-opus-4-6 | — |
| `quality-reviewer` | Code quality check | read,grep,find,ls | claude-sonnet-4-5 | — |
| `architect` | Architecture review | read,grep,find,ls | gpt-5.2 | — |
| `security-reviewer` | Security review | read,grep,find,ls | gpt-5.3-codex | — |
| `performance-reviewer` | Performance review | read,grep,find,ls | gemini-3-pro-high | — |

### New

| Agent | Role | Tools | Why new |
|-------|------|-------|---------|
| `brainstormer` | Generate questions, proposals, design sections | read,find,grep,ls | Read-only. Returns structured JSON. Not an implementer — no write/edit/bash. |
| `planner` | Write detailed TDD implementation plans | read,write,find,grep,ls | Writes plan file. No bash/edit. No TDD guard. Separate system prompt focused on planning. |

### Dispatch Configuration

The `buildSubprocessArgs` function in `dispatch.ts` currently hardcodes `if (agent.name === "implementer")` to load TDD extras. This stays unchanged — new agents (`brainstormer`, `planner`) don't match this check and get dispatched clean.

All agents get model/thinking overrides from `.superteam.json` via `resolveAgentModel()` / `resolveAgentThinking()`.

---

## State Model

```typescript
type OrchestratorPhase =
  | "brainstorm"
  | "plan-write"
  | "plan-review"
  | "configure"
  | "execute"
  | "finalize"
  | "done";

type BrainstormStep = "scout" | "questions" | "approaches" | "design" | "done";

type BrainstormQuestion = {
  id: string;
  text: string;
  type: "choice" | "input";
  options?: string[];
  answer?: string;
};

type BrainstormApproach = {
  id: string;
  title: string;
  summary: string;
  tradeoffs: string;
  taskEstimate: number;
};

type DesignSection = {
  id: string;
  title: string;
  content: string;
  approved: boolean;
};

type BrainstormState = {
  step: BrainstormStep;
  scoutOutput?: string;
  questions?: BrainstormQuestion[];
  currentQuestionIndex?: number;
  approaches?: BrainstormApproach[];
  recommendation?: string;
  chosenApproach?: string;
  customApproach?: string;
  designSections?: DesignSection[];
  currentSectionIndex?: number;
};

type OrchestratorState = {
  phase: OrchestratorPhase;
  brainstorm: BrainstormState;
  config: Partial<OrchestratorConfig>;
  userDescription: string;
  designPath?: string;
  designContent?: string;
  planPath?: string;
  planContent?: string;
  tasks: TaskExecState[];
  currentTaskIndex: number;
  planReviewCycles: number;
  totalCostUsd: number;
  startedAt: number;
  error?: string;
};
```

---

## Command Interface

### /workflow (primary entry point)

```typescript
pi.registerCommand("workflow", {
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    
    // Subcommands
    if (trimmed === "status") { ... }
    if (trimmed === "abort") { ... }
    
    // Start or resume
    let state = loadState(ctx.cwd);
    
    if (trimmed && state) {
      // Active workflow exists + user gave description
      const replace = await ctx.ui.confirm(
        "Active Workflow",
        "A workflow is already in progress. Start a new one?"
      );
      if (!replace) { /* resume existing */ }
      else { clearState(ctx.cwd); state = null; }
    }
    
    if (!state && !trimmed) {
      // No state, no args → prompt for description
      const desc = await ctx.ui.input("Start Workflow", "Describe what you want to build...");
      if (!desc) return; // user cancelled
      trimmed = desc;
    }
    
    if (!state) {
      state = createInitialState(trimmed);
      saveState(state, ctx.cwd);
    }
    
    // Run orchestrator loop — handles all phases with direct UI
    await runWorkflowLoop(state, ctx);
  }
});
```

### runWorkflowLoop

The core loop that drives the entire workflow from within the command handler:

```typescript
async function runWorkflowLoop(state, ctx) {
  while (state.phase !== "done") {
    ctx.ui.setStatus("workflow", formatStatus(state));
    
    switch (state.phase) {
      case "brainstorm":
        state = await runBrainstormPhase(state, ctx);
        break;
      case "plan-write":
        state = await runPlanWritePhase(state, ctx);
        break;
      // ... etc
    }
    
    saveState(state, ctx.cwd);
    
    if (state.error) {
      ctx.ui.notify(state.error, "warning");
      ctx.ui.notify("Use /workflow to retry from this step.", "info");
      break;
    }
  }
  
  ctx.ui.setStatus("workflow", undefined);
  ctx.ui.setWidget("workflow-progress", undefined);
}
```

Each phase function calls `ctx.ui.*` directly for user interaction. No more `pendingInteraction` pattern for the command path.

### workflow tool (secondary, for LLM-initiated)

Kept as-is but simplified. When the tool returns "waiting" (for phases that need user input), the tool's response text describes what the user should answer. The LLM mediates.

This path is secondary — the `/workflow` command is the primary interface.

---

## Error Handling Strategy

### Per-dispatch error capture

Every `dispatchAgent()` call is wrapped:

```typescript
const result = await dispatchAgent(agent, prompt, cwd, signal);
state.totalCostUsd += result.usage.cost;

if (result.exitCode !== 0) {
  const output = getFinalOutput(result.messages);
  const snippet = output.slice(0, 500);
  const errorDetail = [
    `${agent.name} agent failed (exit ${result.exitCode}).`,
    result.errorMessage ? `Error: ${result.errorMessage}` : "",
    `Output preview: ${snippet}`,
  ].filter(Boolean).join("\n");
  
  // For recoverable phases: offer retry
  const action = await ctx.ui.select(
    `Agent Error: ${agent.name}`,
    ["Retry", "Abort workflow"]
  );
  if (action === "Retry") continue;
  state.error = errorDetail;
  return state;
}
```

### Structured output parse failure

When a `superteam-brainstorm` or `superteam-json` block can't be parsed:

```typescript
const parsed = parseBrainstormOutput(output);
if (!parsed) {
  // Retry once with explicit format instructions
  retryCount++;
  if (retryCount <= MAX_PARSE_RETRIES) {
    prompt = addFormatReminder(prompt);
    continue;
  }
  // Show raw output, let user decide
  ctx.ui.notify(`Could not parse ${agent.name} output. Raw:\n${output.slice(0, 300)}`, "warning");
  const action = await ctx.ui.select("Parse Error", ["Retry", "Abort"]);
  ...
}
```

### Cost budget

Checked before each dispatch via existing `checkCostBudget()`. If over budget:
```
ctx.ui.notify("Cost budget exceeded ($X.XX of $Y.YY)", "warning");
ctx.ui.select("Over Budget", ["Continue anyway", "Abort"]);
```

### User cancellation

If user presses Escape on any dialog → function returns `undefined`. The phase function checks for `undefined` and saves state + returns cleanly. Next `/workflow` invocation resumes from that exact point.

---

## What Changes vs Current Code

### Files Modified

| File | Change |
|------|--------|
| `src/index.ts` | Rewrite `/workflow` command, keep tool as secondary |
| `src/workflow/orchestrator.ts` | Major rewrite — new phase flow, direct UI interaction |
| `src/workflow/orchestrator-state.ts` | Add `BrainstormState`, `designPath`, new phase types |
| `src/workflow/phases/plan.ts` | Rewrite → becomes `plan-write.ts`, uses planner agent |
| `src/workflow/prompt-builder.ts` | Add brainstormer prompts, planner prompt with design context |
| `src/workflow/interaction.ts` | Simplify — remove `pendingInteraction` formatters, add `presentInteraction()` UI helpers |

### Files Added

| File | Purpose |
|------|---------|
| `agents/brainstormer.md` | Brainstormer agent profile |
| `agents/planner.md` | Planner agent profile |
| `src/workflow/phases/brainstorm.ts` | Brainstorm phase logic |
| `src/workflow/phases/plan-write.ts` | Plan-write phase (replaces plan.ts) |
| `src/workflow/brainstorm-parser.ts` | Parse `superteam-brainstorm` structured output |
| `src/workflow/ui.ts` | UI helper functions (formatStatus, formatToolAction, updateActivityWidget, presentQuestion, presentApproaches, presentDesignSection) |
| `src/workflow/progress.ts` | Generate and write progress markdown file from state |

### Files Modified (minor)

| File | Change |
|------|--------|
| `src/dispatch.ts` | Add `onStreamEvent` callback to `runAgent` and `dispatchAgent`. Parse `tool_execution_start/end/update` events in the JSON stream and fire callback. No other changes. |

### Files Unchanged

| File | Why |
|------|-----|
| `src/config.ts` | Config discovery works |
| `src/review-parser.ts` | Review parsing works |
| `src/workflow/git-utils.ts` | Git helpers work |
| `src/workflow/phases/execute.ts` | Execute phase is solid — minor updates only (use `ctx.ui` for escalation instead of `pendingInteraction`) |
| `src/workflow/phases/plan-review.ts` | Plan review phase is solid — add design doc as context |
| `src/workflow/phases/configure.ts` | Rewrite to use `ctx.ui` directly instead of `pendingInteraction` |
| `src/workflow/phases/finalize.ts` | Minor updates |
| `src/workflow/tdd-guard.ts` | TDD guard unchanged |

### Files Removed

| File | Why |
|------|-----|
| `src/workflow/phases/plan.ts` | Replaced by `plan-write.ts` |

---

## Implementation Task Summary

The implementation plan will have tasks roughly in this order (dependencies flow downward):

1. Brainstormer + planner agent profiles
2. Add `onStreamEvent` callback to `dispatch.ts` (`runAgent`, `dispatchAgent`)
3. Brainstorm output parser (`brainstorm-parser.ts`)
4. Progress file generator (`progress.ts`)
5. UI helpers (`ui.ts` — formatStatus, formatToolAction, activity widget, interaction presenters)
6. Updated state model (`orchestrator-state.ts` — add BrainstormState, designPath, new phases)
7. Brainstorm phase (`phases/brainstorm.ts`)
8. Plan-write phase (`phases/plan-write.ts`)
9. Update plan-review to include design doc as reviewer context
10. Update configure to use `ctx.ui` directly
11. Update execute to use `ctx.ui` for escalation + streaming activity widget
12. Rewrite orchestrator entry point (`orchestrator.ts`) + `/workflow` command (`index.ts`)
13. Docs update (README, workflow guide, agents guide, CHANGELOG)
