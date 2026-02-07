# Changelog

## 0.2.0 (2026-02-07)

### Features

- **Workflow Orchestrator** — deterministic state machine replacing prompt-driven SDD flow
  - `/workflow <description>` starts an end-to-end orchestrated workflow
  - Five phases: plan-draft → plan-review → configure → execute → finalize
  - Scout explores codebase, planner drafts tasks, reviewers validate the plan
  - Structured user interaction: plan approval, execution mode selection, escalation handling
  - Three execution modes: auto (continuous), checkpoint (pause per task), batch (pause per N tasks)
  - Full state persistence to `.superteam-workflow.json` — resume with `/workflow`
  - `/workflow status` shows current phase, task progress, and cumulative cost
  - `/workflow abort` clears state and stops the workflow
  - Cost budget checked before every agent dispatch
  - Final cross-task quality review and summary report

- **New modules:**
  - `src/workflow/orchestrator.ts` — top-level orchestrator entry point
  - `src/workflow/orchestrator-state.ts` — typed state, persistence, phase transitions
  - `src/workflow/prompt-builder.ts` — deterministic prompt construction for all agents
  - `src/workflow/interaction.ts` — structured user interaction helpers
  - `src/workflow/git-utils.ts` — async git utilities (tracked files, changed files, SHA)
  - `src/workflow/phases/` — plan-draft, plan-review, configure, execute, finalize

### Documentation

- New [Workflow Guide](docs/guides/workflow.md) covering all phases, interaction points, and execution modes
- Updated README with `/workflow` command reference and orchestrator feature section
- Updated [Configuration Guide](docs/guides/configuration.md) with orchestrator defaults

## 0.1.0 (2026-02-06)

Initial release.

### Features

- **Multi-Agent Dispatch** — `team` tool with single, parallel, and chain modes
  - 7 built-in agents: scout, implementer, spec-reviewer, quality-reviewer, security-reviewer, performance-reviewer, architect
  - Custom agent support via markdown profiles
  - Deterministic subprocess isolation

- **TDD/ATDD Guard** — mechanical enforcement of test-driven development
  - Blocks impl writes without test file + test run
  - Bash heuristic catches shell file mutations
  - ATDD mode with acceptance test awareness
  - Configurable file mapping strategies

- **SDD Orchestration** — automated implement → review → fix loops
  - Plan parsing from `superteam-tasks` fenced blocks or headings
  - Structured reviewer output parsing (`ReviewFindings` JSON)
  - Fix loops with specific findings passed to implementer
  - Escalation to human on failure

- **Context-Aware Rules** — TTSR-like rule injection
  - 3 built-in rules: test-first, YAGNI, no-impl-before-spec
  - Custom rules with regex triggers and frequency control

- **Cost Tracking** — session-level budget management
  - Warning threshold and hard limit
  - Mid-stream abort on hard limit
  - Per-dispatch and cumulative tracking

- **5 Skills** — TDD, ATDD, SDD, writing-plans, brainstorming
- **4 Prompt Templates** — /sdd, /review-parallel, /scout, /implement
- **Branch-aware persistence** — workflow state tracked per session branch
