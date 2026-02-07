# Fix Workflow Command Interaction Model

**Goal:** Make `/workflow` the primary entry point that works end-to-end. Use pi's native interactive UI (`ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.input`) for user decisions instead of the broken indirect tool pattern.

**Root causes:**
1. `/workflow` command never calls `runOrchestrator` — dead-end notification
2. No planner agent — implementer misused with TDD guard/skill/prompt
3. No error visibility when phases fail
4. Interaction model relies on LLM calling a tool, not direct user interaction

**Architecture:**
- `/workflow` command calls `runOrchestrator` directly
- When orchestrator returns "waiting" (pending interaction), the command handler uses `ctx.ui.select()` / `ctx.ui.confirm()` / `ctx.ui.input()` to ask the user interactively, then re-invokes orchestrator with the answer — all within a single command invocation loop
- New `planner` agent profile — no TDD baggage
- `workflow` tool kept for LLM-initiated flows but command is primary
- Active workflow check prevents accidental overwrites

---

```superteam-tasks
- title: Create planner agent profile
  description: |
    Create agents/planner.md with:
      name: planner
      description: Break work into small, testable implementation tasks
      tools: read,write,find,grep,ls
    System prompt: "You are a technical planner. Given a project description and codebase context, write a structured implementation plan. The plan must contain a ```superteam-tasks block. Each task should be small (1-3 files), testable, and independent. Include Goal, Architecture, and Tech Stack headers. Use TDD in task descriptions. Do NOT implement anything — only plan."
    Test: write a test that discoverAgents finds "planner" when agents/ dir is scanned.
  files: [agents/planner.md, src/dispatch.test.ts]
- title: Update plan-draft phase to use planner agent
  description: |
    In src/workflow/phases/plan.ts:
    1. Change agent lookup from "implementer" to "planner"
    2. If "planner" not found, fall back to "implementer" (log warning)
    3. On dispatchAgent failure (exitCode != 0): set state.error with agent name, exit code, errorMessage, and first 300 chars of agent output
    4. On plan file not found: set state.error with full path and first 300 chars of agent output
    5. On 0 tasks after retry: include plan file content snippet in error
    Test: update existing plan.test.ts — test planner agent selection, fallback to implementer, all error paths include agent output context.
  files: [src/workflow/phases/plan.ts, src/workflow/phases/plan.test.ts]
- title: Rewrite /workflow command as interactive entry point
  description: |
    In src/index.ts, rewrite the /workflow command handler:
    1. /workflow status — unchanged
    2. /workflow abort — unchanged
    3. /workflow (no args, no state) — use ctx.ui.input("Start workflow", "Describe what you want to build...") to get description, then start
    4. /workflow (no args, active state, no pending) — call runOrchestrator to resume
    5. /workflow (no args, active state, pending interaction) — present the pending question using ctx.ui.select/confirm/input based on interaction type, then call runOrchestrator with the answer
    6. /workflow <description> — check for active state first. If exists, ctx.ui.confirm("Active workflow exists. Start new one?"). If confirmed, clearState then start. Otherwise resume.
    7. After runOrchestrator returns: loop while result.status === "waiting" — present each interaction via ctx.ui, collect answer, re-invoke runOrchestrator. This handles the configure phase's multi-question sequence in one command invocation.
    8. result.status === "error" — ctx.ui.notify with warning level, show full error
    9. result.status === "running" — ctx.ui.notify with progress info
    10. result.status === "done" — ctx.ui.notify with completion report
    Helper function: presentInteraction(ctx, pending: PendingInteraction): Promise<string | undefined>
      - type "choice": ctx.ui.select(question, option labels) → map back to option key
      - type "confirm": ctx.ui.confirm(question, "") → "yes"/"no"  
      - type "input": ctx.ui.input(question, default) → raw string
      - Returns undefined if user cancels (escape)
    Test: test each command branch. Mock ctx.ui.select/confirm/input. Test the interaction loop (runOrchestrator returns waiting, presentInteraction called, re-invoked with answer). Test active state guard. Test user cancellation (escape).
  files: [src/index.ts]
- title: Keep workflow tool as secondary path
  description: |
    The workflow tool in src/index.ts stays as-is — it calls runOrchestrator and returns the result to the LLM. No changes needed. But update the tool description to note that /workflow command is the primary interface.
    Also: when the tool returns "waiting", format the interaction as text so the LLM can present it to the user and relay the answer back.
    Test: verify tool still works (existing tests should pass). Add test that "waiting" result includes formatted interaction text.
  files: [src/index.ts]
- title: Update docs
  description: |
    1. README.md: Update /workflow docs — show it as primary entry, describe interactive flow
    2. docs/guides/workflow.md: Rewrite interaction model section — /workflow uses native UI dialogs, show the full user experience flow
    3. CHANGELOG.md: Add entry
    4. docs/guides/agents.md: Document the new planner agent
  files: [README.md, docs/guides/workflow.md, CHANGELOG.md, docs/guides/agents.md]
```
