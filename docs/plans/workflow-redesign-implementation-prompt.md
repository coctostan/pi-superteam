# Workflow Redesign — Implementation Prompt

Start a fresh pi session from `~/superteam/` and paste everything below the line.

---

You are implementing a 13-task TDD plan to redesign the workflow orchestrator for `pi-superteam`, a TypeScript ESM extension for the `pi` coding agent CLI.

## Project

- **Source:** `~/superteam/`
- **Installed copy:** `/home/pi/.npm-global/lib/node_modules/pi-superteam/` (symlinked — edits to `~/superteam/` are live)
- **Tests:** `npx vitest run` (213 passing, 4 failing in `plan.test.ts` — that file is being deleted in Task 8)
- **No build step.** Pi loads TypeScript directly via jiti.
- **All `src/` imports use `.js` extensions** (ESM convention). Tests may import `.ts`.

## Your Instructions

Read the implementation plan, then execute it task by task using strict TDD (RED → GREEN → REFACTOR):

**Plan file:** `docs/plans/2026-02-07-workflow-redesign-plan-merged.md`

**Design spec (the "why" behind every task):** `docs/plans/2026-02-07-workflow-redesign-design.md`

For each task:

1. **Read the task** in the plan. It has exact file paths, test code, and implementation instructions.
2. **Write the failing test first** (RED). Copy the test code from the plan — it's provided inline for most tasks.
3. **Run the test to verify it fails**: `npx vitest run <test-file>`
4. **Implement the minimum code to pass** (GREEN). Follow the plan's implementation instructions.
5. **Run the test to verify it passes**: `npx vitest run <test-file>`
6. **Run the full suite** to check for regressions: `npx vitest run`
7. **Commit** with the message from the plan.
8. **Move to the next task.**

## Critical Rules

- **Never skip RED.** Every test must fail before you write implementation code.
- **Never guess structured output formats.** Read the plan's type definitions and test expectations exactly.
- **`vi.mock()` paths must use `.js` extensions** to match ESM import specifiers in source files.
- **No subprocess spawning in tests.** Mock `dispatchAgent`, `child_process.spawn`, etc.
- **After each task, run `npx vitest run` (full suite).** Fix any regressions before moving on.
- **When the plan says "delete" a file, `git rm` it.** Don't leave dead code.
- **Sync the installed copy after all tasks:** `cp -r ~/superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/src/ && cp -r ~/superteam/agents/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/`

## Context Files (read as needed, not upfront)

The plan tells you which files to read for each task. Don't front-load reading — read only what the current task requires. Key references:

- `src/review-parser.ts` — pattern to follow for `brainstorm-parser.ts` (Task 3)
- `src/dispatch.ts` — where to add `onStreamEvent` (Task 2)
- `src/workflow/orchestrator-state.ts` — state types to extend (Task 6)
- `src/workflow/phases/execute.ts` — existing execute phase to update (Task 11)
- `src/workflow/prompt-builder.ts` — where all prompt templates live (Tasks 7, 8, 9)

## Task Dependency Order

```
Tasks 1-5:  Independent foundation — do in order listed
Task 6:     Depends on Task 4 (progress file integration)
Task 7:     Depends on 1, 3, 5, 6
Task 8:     Depends on 1, 6
Task 9:     Depends on 6
Task 10:    Depends on 6
Task 11:    Depends on 2, 5, 6
Task 12:    Depends on 7-11 (integration)
Task 13:    Depends on 12 (docs)
```

Execute tasks 1 through 13 in order. Start now with Task 1.
