# Workflow Redesign — TDD Implementation Plan Prompt

Copy everything below the line into a fresh pi session (started from `~/superteam/`).

---

You are working on `pi-superteam`, a TypeScript ESM extension package for the `pi` coding agent CLI. The project is at `~/superteam/` and the installed copy lives at `/home/pi/.npm-global/lib/node_modules/pi-superteam/`. There is no build step — pi loads TypeScript source directly via jiti. All imports must use `.js` extensions (ESM convention). Tests use vitest.

## Your Task

Read the design document at `docs/plans/2026-02-07-workflow-redesign-design.md` and write a detailed TDD implementation plan following the superpowers "writing-plans" format.

## Context Files to Read First

Read these files to understand the current codebase before writing the plan:

**Design doc (the spec you're implementing):**
- `docs/plans/2026-02-07-workflow-redesign-design.md`

**Current source (what exists today):**
- `src/index.ts` — extension entry point, `/workflow` command (line ~647), `workflow` tool (line ~680)
- `src/dispatch.ts` — `runAgent`, `dispatchAgent`, `buildSubprocessArgs`, `discoverAgents`
- `src/workflow/orchestrator.ts` — current `runOrchestrator` entry point
- `src/workflow/orchestrator-state.ts` — state types, persistence
- `src/workflow/phases/plan.ts` — current plan-draft phase (to be replaced)
- `src/workflow/phases/plan-review.ts` — plan review (to be updated)
- `src/workflow/phases/configure.ts` — configure phase (to be updated)
- `src/workflow/phases/execute.ts` — execute phase (to be updated)
- `src/workflow/phases/finalize.ts` — finalize phase (minor updates)
- `src/workflow/prompt-builder.ts` — all prompt templates
- `src/workflow/interaction.ts` — interaction helpers (to be simplified)
- `src/review-parser.ts` — `superteam-json` parser (reuse pattern for `superteam-brainstorm`)
- `src/config.ts` — config discovery
- `src/workflow/git-utils.ts` — git helpers

**Existing agents:**
- `agents/scout.md`, `agents/implementer.md`, `agents/architect.md`
- `agents/spec-reviewer.md`, `agents/quality-reviewer.md`
- `agents/security-reviewer.md`, `agents/performance-reviewer.md`

**Pi extension API reference:**
- `/home/pi/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` — registerCommand, registerTool, ctx.ui.*, ExtensionCommandContext
- `/home/pi/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/json.md` — JSON mode event types (tool_execution_start/end/update)

**Superpowers reference (the process we're emulating):**
- `/tmp/pi-github-repos/obra/superpowers/skills/brainstorming/SKILL.md`
- `/tmp/pi-github-repos/obra/superpowers/skills/writing-plans/SKILL.md`
- `/tmp/pi-github-repos/obra/superpowers/skills/subagent-driven-development/SKILL.md`

## Plan Requirements

1. **Use the writing-plans skill format.** Read `/home/pi/.npm-global/lib/node_modules/pi-superteam/skills/writing-plans/SKILL.md` for the format. Each task needs: title, files (create/modify/test), bite-sized TDD steps (write failing test → verify RED → implement → verify GREEN → commit).

2. **Tasks must be ordered by dependency.** Later tasks depend on earlier ones. Each task should be completable independently given its predecessors.

3. **Task granularity: 2-5 minutes each.** Each task touches 1-3 files. One test file, one or two implementation files.

4. **Include exact file paths.** Use the existing project structure — `src/workflow/` for workflow code, `agents/` for agent profiles, `docs/` for documentation.

5. **Tests mock `dispatchAgent`.** No actual subprocess calls in tests. Mock the dispatch layer and verify prompts, agent selection, state transitions, and UI calls.

6. **The plan must include a `superteam-tasks` YAML block** at the end for machine parsing.

7. **Roughly 13 tasks** matching the implementation summary in the design doc:
   - Agent profiles (brainstormer, planner)
   - Streaming event callback in dispatch.ts
   - Brainstorm output parser
   - Progress file generator
   - UI helpers
   - Updated state model
   - Brainstorm phase
   - Plan-write phase
   - Plan-review update
   - Configure update
   - Execute update
   - Orchestrator + /workflow command rewrite
   - Docs

8. **Each task's test should verify behavior, not implementation.** Test what the function does (state transitions, UI calls, output format), not how it does it.

Save the plan to `docs/plans/2026-02-07-workflow-redesign-plan.md`.
