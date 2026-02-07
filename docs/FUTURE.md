# Future Plans

Living document tracking potential features, known weaknesses, use cases to explore, and lessons learned. Items are roughly prioritized within each section.

---

## Bugs Found in Smoke Test (2026-02-07)

### 🔴 CRITICAL: superteam-tasks YAML parser drops tasks
The plan file had 3 tasks in its `superteam-tasks` block, but the parser only extracted 2. Task 3 ("Add the /health route — TDD green") was silently dropped. The workflow completed thinking it was done, but the actual feature was never implemented — tests left in RED state with no GREEN step.

**Impact:** Workflows can silently skip work. The user sees "2/2 complete" and thinks everything is done, but the feature is missing.

**Root cause:** Likely a YAML parsing issue with multi-line `description` fields. Task 3's description contained a code block inside YAML, which may have confused the parser. Need to investigate the plan-write phase's task extraction logic and the underlying YAML parsing.

**Fix approach:** Debug the parser with the actual plan file from the smoke test (`test-workflow-smoke/docs/plans/*-plan.md`). Harden the YAML parser to handle multi-line descriptions, embedded code blocks, and edge cases. Add test cases for these patterns.

### 🟡 HIGH: Brainstorm JSON parse failures (60% failure rate)
3 out of 5 brainstormer dispatches produced invalid JSON (unterminated strings). The retry mechanism handled it gracefully — retry twice, then escalate to user with Retry/Abort. But 60% failure rate is expensive ($0.58 in wasted dispatches) and slow (adds ~5 min of retries).

**Root cause:** The brainstormer agent produces JSON with literal newlines inside string values. The `JSON.parse()` call fails because JSON strings can't contain unescaped newlines.

**Fix approach (pick one or combine):**
1. **Pre-process:** Before parsing, replace literal newlines inside JSON strings with `\n` escape sequences
2. **Harden prompt:** Add explicit "IMPORTANT: JSON strings must not contain literal newlines — use \\n instead" to brainstormer system prompt
3. **Use relaxed parser:** Try `JSON5.parse()` or a custom parser that handles unescaped newlines
4. **Reduce JSON complexity:** Shorten the design section content that goes into JSON strings (the long paragraphs are what cause the newline issue)

### 🟡 MEDIUM: Status bar sub-step label stuck on "scouting"
During the brainstorm phase, the footer status showed `⚡ Workflow: brainstorm (scouting...)` even during the questions, approaches, and design sub-steps. Should update to show the current sub-step name.

**Root cause:** The `formatStatus()` function in `ui.ts` likely reads `state.brainstorm.step` but the step value isn't being updated in state before the status bar refresh, or the status bar text is hardcoded.

**Fix:** Verify `state.brainstorm.step` is updated before each `ctx.ui.setStatus()` call in the brainstorm phase.

### 🟢 LOW: `undefined` displayed in design section content
When presenting design sections for approval, the word "undefined" appears at the end of the section content. Minor cosmetic issue.

**Root cause:** Likely a `section.title` or trailing field being `undefined` and concatenated into the display string.

**Fix:** Add null checks in the section presentation code.

---

## Immediate (post-redesign)

### One task per agent dispatch — lightweight context always wins
**Lesson learned:** Running 13 TDD tasks in a single session causes context compaction, which destroys accumulated understanding. The model forgets earlier tasks, misses connections, and quality degrades.

**The fix:** The orchestrator should dispatch a **fresh implementer per task**, not run all tasks in one session. This is exactly what superpowers does — and exactly what our execute phase is designed to do. Each dispatch gets:
- The single task description with inline context (file paths, test code, spec)
- No accumulated baggage from previous tasks
- Fresh context window = maximum quality per task

This also means the **implementation plan prompt** should not say "execute tasks 1-13 in order." It should be consumed by the orchestrator, which dispatches one agent per task. The plan is for the orchestrator, not for a human pasting into a session.

**For manual execution** (before the orchestrator works): break the plan into 3-4 session chunks along natural boundaries:
- Session 1: Tasks 1-5 (independent foundation)
- Session 2: Tasks 6-8 (state model + brainstorm + plan-write)
- Session 3: Tasks 9-11 (phase updates)
- Session 4: Tasks 12-13 (integration + docs)

Each session starts fresh with a focused prompt listing only its tasks plus "read these files for context." Compaction should never happen within a 3-4 task session.

### Post-task summaries in execute phase
After each task completes (implementation + reviews pass), the orchestrator should generate a brief summary of what was done. Three purposes:
1. **User visibility** — show a concise "Task 3 complete: Added brainstorm parser with 7 test cases. Files: brainstorm-parser.ts, brainstorm-parser.test.ts. Cost: $0.38" notification after each task.
2. **Context for next task** — the summary (not the full agent output) gets passed to the next implementer dispatch as "what was done so far." This gives the next agent situational awareness without blowing up its context.
3. **Progress file** — append each summary to the log section of the progress.md file for a permanent audit trail.

This could be: (a) a deterministic summary extracted from the dispatch result (changed files, test count, cost — no LLM needed), or (b) a lightweight summarizer agent dispatch that reads the implementer's output and produces a 2-3 sentence summary. Option (a) first, (b) if we need richer context.

### Finalize phase: workflow completion report
The finalize phase should automatically generate a comprehensive execution summary (like the manual one the implementer wrote in `2026-02-07-workflow-redesign-execution-summary.md`). Most of it is deterministic — pulled straight from state:
- **Task table:** title + commit SHA + test count + status — from `tasks[]` and git history
- **File inventory:** created/modified/deleted — from `computeChangedFiles()` accumulated across tasks
- **Cost breakdown:** per-task and total — from `usage.cost` on each dispatch result
- **Timeline:** started/finished timestamps per task — from state

The only part that needs an LLM is a prose "Key Changes" section summarizing what was built at a high level. This is a good candidate for a lightweight summarizer dispatch in finalize — it reads the task titles + changed files + design doc and writes 5-6 bullet points. Low cost, high value.

Output: saved to `docs/plans/YYYY-MM-DD-<slug>-summary.md` alongside the design, plan, and progress files. The full artifact chain becomes: `design.md` → `plan.md` → `progress.md` → `summary.md`.

### Planner prompt refinement
The GPT-generated implementation plan was structurally better but lacked inline test code for complex tasks. Opus had great test code but weaker structure. After executing the merged plan, refine the planner agent's system prompt:
- Require complete inline test code for complex tasks (parsers, state machines, multi-step phase logic)
- Allow prose-only test descriptions for simple tasks (agent profiles, config changes, docs)
- Add examples of good vs bad task granularity

### Plan file path brittleness
The plan-write phase expects the planner agent to write a file to a specific path passed in the prompt. If the agent writes it elsewhere (or doesn't write it at all), the phase fails. Need fallback: search `docs/plans/` for recently written `.md` files, or parse the agent's output for the actual path used.

### Brainstorm skip option
Not every task needs brainstorming. Add `/workflow --skip-brainstorm "description"` that jumps straight to plan-write with the raw description. Also allow skipping from the brainstorm phase itself: after scout completes, offer "Skip to planning" alongside the questions flow.

### Resume UX
When resuming `/workflow` mid-brainstorm, the user sees the next unanswered question with no context about what they already answered. Show a brief recap: "You've answered 3/5 questions so far. Continuing from question 4..."

---

## Features

### Parallel task execution
The execute phase runs tasks sequentially. Some tasks are independent and could run in parallel (especially tests, docs, or tasks touching different files). Use the dependency graph from the plan to identify parallelizable batches. Dispatch multiple implementers simultaneously via `dispatchParallel`. Challenge: merge conflicts between parallel agents.

### Git worktree integration
Superpowers uses git worktrees to isolate parallel agent work. Each implementer gets its own worktree, preventing conflicts. After both complete, the orchestrator merges worktrees. Requires: `git-utils.ts` additions for worktree create/merge/cleanup.

### Cost estimation before execution
After plan approval, estimate total cost based on task count × average cost per task (tracked from history). Show: "Estimated cost: $4-8 for 7 tasks. Proceed?" Save per-task cost history in `.superteam-history.json` for improving estimates over time.

### Task-level git commits
Currently the implementer is told to commit after each task. Make this orchestrator-controlled: after a task passes all reviews, the orchestrator commits with a standardized message format. Gives consistent commit history and enables clean rollback per task.

### Rollback on failure
If a task fails after max retries, offer to rollback to the pre-task git SHA. The execute phase already records `gitShaBefore` — just need `git reset --hard <sha>` and a confirmation dialog.

### Custom review profiles
Allow users to define project-specific review criteria in `.superteam.json`. Example: a security-focused project might want security review on every task (not just optional), while a prototype might want no reviews at all. Shape: `review.profiles: { "strict": [...], "fast": [...] }`.

### Model rotation / fallback
If a model fails (rate limit, outage), try an alternative model before erroring. Config: `modelFallbacks: { "claude-opus-4-6": ["gpt-5.2", "gemini-3-pro-high"] }`. The dispatch layer retries with the next model in the chain.

### Incremental plan updates
When a task reveals new requirements or the plan needs adjustment mid-execution, allow the user to trigger a plan revision without restarting. `/workflow revise` → edit plan in editor → re-parse tasks → continue from current position.

### Session cost dashboard
A widget or command (`/workflow costs`) showing cost breakdown by phase, by agent, by task. Which agents are expensive? Which tasks took the most retries?

### Template workflows
Pre-defined workflow templates for common tasks: "Add REST endpoint", "Add database migration", "Refactor module", "Add test coverage". Each template pre-fills brainstorm questions and approach recommendations.

### Multi-model brainstorming
During the approaches step, dispatch 2-3 different models (e.g., Claude, GPT, Gemini) to independently propose approaches. Present all proposals together. Different models catch different things.

### Plan diff on revision
When the planner revises a plan (after review failure or user feedback), show a diff of what changed rather than re-presenting the entire plan. Makes review faster.

### Workflow history
Track completed workflows in `.superteam-history.json`: what was built, how many tasks, total cost, time elapsed, which tasks failed. Useful for cost estimation and process improvement.

---

## Weaknesses / Known Issues

### Agent output parsing fragility
We rely on agents producing structured output in fenced code blocks (`superteam-brainstorm`, `superteam-json`, `superteam-tasks`). Different models have different reliability here. GPT sometimes wraps JSON in markdown prose. Gemini sometimes adds trailing commas. The parsers need to be defensive. Current mitigation: retry once with format reminder. Better: model-specific format instructions, or a post-processing normalization step.

### Brainstorm question quality varies by model
The brainstormer agent's question quality depends heavily on the model. Cheaper models ask vague questions. Expensive models ask precise, actionable ones. The model assignment matters a lot here — don't skimp.

### No abort signal for running agents
When the user wants to abort mid-agent-dispatch, there's no clean way to kill the subprocess. The `signal` parameter exists but `pi --mode json` doesn't handle SIGTERM gracefully in all cases. The agent might leave partial files. Mitigation: always commit before each task so `git reset` works.

### Context window pressure on large plans
For plans with 15+ tasks, the execute phase's cumulative state (all task results, review findings, changed files) can get large. The orchestrator should trim completed task details from the active context, keeping only summaries.

### Scout output quality
The scout agent's codebase summary varies wildly in quality. Sometimes it maps the whole project structure; sometimes it fixates on one directory. The scout prompt needs iteration. Consider: a structured scout output format (similar to `superteam-brainstorm`) instead of free-form text.

### No validation of agent-written files
When the planner or implementer writes files, we don't validate that the files compile/parse before proceeding. A syntax error in a plan file wastes a review cycle. Consider: run a quick `tsc --noEmit` or `node --check` on written files as a pre-review gate.

### Test-file-only changes pass review
If an implementer only writes tests and no implementation, the spec reviewer may pass it because "tests exist." The review prompt should explicitly check that implementation files were modified, not just test files.

### Single-reviewer bottleneck
Spec review and quality review run sequentially. For large tasks with many files, this adds up. Consider parallelizing the two reviews when possible (they're independent checks).

### Long plans cause context death in single sessions
A 13-task plan in one session will hit context compaction, losing earlier task context. This is fundamental — not a model limitation to work around, but a constraint to design for. The orchestrator's per-task dispatch model is the correct architecture. The implementation prompt we wrote ("execute tasks 1-13 in order") was wrong for manual execution — should have been split into 3-4 focused sessions.

### No learning from past workflows
Each workflow starts from scratch. The orchestrator doesn't learn from past successes/failures. Future: use workflow history to pre-populate brainstorm answers, suggest proven approaches, warn about historically problematic patterns.

---

## Use Cases to Explore

### Greenfield project bootstrap
`/workflow "Create a new Express API with TypeScript, Prisma, and JWT auth"` — the brainstorm phase maps the empty (or near-empty) project, proposes project structure, generates the full scaffold plan. Challenge: scout has nothing to scan.

### Large refactoring
`/workflow "Migrate from REST to GraphQL"` — cross-cutting change touching many files. Tests the planner's ability to order tasks with complex dependencies and the execute phase's ability to handle cascading changes.

### Bug investigation + fix
`/workflow "Fix: users can't log in after password reset"` — brainstorm should ask diagnostic questions, scout should focus on auth-related code, approach should be investigation-first. Different flow than feature development.

### Documentation overhaul
`/workflow "Add comprehensive API documentation for all endpoints"` — no code changes, just docs. Tests whether the workflow handles non-code tasks gracefully. Implementer writes markdown, not TypeScript.

### Monorepo multi-package work
`/workflow "Add shared logging utility used by api/ and worker/ packages"` — touches multiple packages in a monorepo. Scout needs to map cross-package dependencies. Plan needs package-aware task ordering.

### Security audit
`/workflow "Audit all API endpoints for authentication and authorization gaps"` — investigation-heavy, might not produce code changes. Brainstorm phase should produce an audit plan, not an implementation plan. Need a way to switch the plan format from "TDD implementation" to "investigation report."

### Performance optimization
`/workflow "Reduce API response time for /users endpoint from 500ms to <100ms"` — needs benchmarking steps in the plan. Implementer needs to run benchmarks, not just tests. Challenge: what's the "test" for a performance task?

---

## Process / Meta

### Plan quality feedback loop
After a workflow completes, ask the user: "How was the plan quality? (1-5)" and "Which tasks needed the most rework?" Store this feedback and use it to refine the planner prompt over time.

### Agent evaluation harness
Build a test harness that runs the same task against different agent configurations (model, thinking level, prompt variations) and compares output quality. Useful for: finding optimal model assignments, testing prompt changes, benchmarking new models.

### Cost optimization experiments
Track cost per task across different model configurations. Is `claude-opus-4-6` for implementation worth 3x the cost of `claude-sonnet-4-5`? Does `gpt-5.2` for architecture review catch more issues than `claude-sonnet-4-5`? Data-driven model selection.

### Extension marketplace
If pi gets an extension marketplace, `pi-superteam` could be published there. Need: clean README, good defaults that work without `.superteam.json`, sensible model fallbacks for users without all providers configured.
