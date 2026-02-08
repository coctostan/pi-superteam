# pi-superteam

**Mission: S-tier output quality.** Every process decision — every phase, agent, review, and prompt — must answer one question: does this produce higher-quality results? We don't skip steps to save time; we skip steps that don't improve the work. Quality first, then cost, then speed.

Pi extension package: multi-agent orchestration, TDD enforcement, review cycles.

## Structure

- `src/index.ts` — extension entry point (tools, commands, rules)
- `src/dispatch.ts` — `team` tool: single/parallel/chain agent dispatch
- `src/config.ts` — `.superteam.json` loader/validator
- `src/team-display.ts` — TUI for agent activity
- `src/review-parser.ts` — structured review output parser
- `src/rules/engine.ts` — rule evaluation (TDD, YAGNI)
- `src/workflow/` — `/workflow` command: brainstorm → plan → review → configure → execute → finalize
  - `orchestrator.ts` — state machine; `state.ts` — types/serialization (plan parsing delegated to plan-parser.ts)
  - `plan-parser.ts` — pure plan parsing logic (extracted from state.ts)
  - `phases/` — one file per phase
  - `prompt-builder.ts`, `interaction.ts`, `progress.ts`, `git-utils.ts`, `ui.ts`
- `agents/` — markdown agent personas (scout, implementer, architect, planner, brainstormer, reviewers)
- `skills/` — methodology instructions (TDD, ATDD, subagent-driven-dev, brainstorming, writing-plans)
- `rules/` — auto-firing rules (test-first, no-impl-before-spec, yagni)

## Config

- `.superteam.json` — TDD mode, test patterns, review settings, agent models, cost limits
- `.superteam-workflow.json` — persisted workflow state (auto-managed)

## Conventions

TypeScript ESM. Tests co-located as `*.test.ts`, acceptance tests as `*.acceptance.test.ts`. TDD by default.
