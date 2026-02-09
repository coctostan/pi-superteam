# Changelog

## 0.3.0 (2026-02-09)

### Breaking Changes

- Renamed bundled skills to avoid name conflicts with `pi-superpowers`:
  - `brainstorming` → `superteam-brainstorming`
  - `writing-plans` → `superteam-writing-plans`
  - `subagent-driven-development` → `superteam-subagent-driven-development`
  - `test-driven-development` → `superteam-test-driven-development`
- Updated implementer subprocess to load `skills/superteam-test-driven-development/SKILL.md`.

### Migration

- Update any references to the old skill folders/skill names to the new `superteam-*` names.

## 0.2.1 (2026-02-07)

### Bug Fixes

- **🔴 CRITICAL: Task parser no longer drops tasks** — `parseTaskBlock()` rewritten from regex to line-walking extractor. The old non-greedy regex (`/[\s\S]*?```/`) stopped at the first triple-backtick inside a task description, silently dropping all subsequent tasks. Plans with embedded code fences in `description: |` block scalars now parse correctly. ([state.ts](src/workflow/state.ts))

- **🟡 Brainstorm JSON parsing hardened against literal newlines** — `extractFencedBlock()` replaced with a quote-aware line-walker that tracks `inString`/`escape` state, so inner triple-backtick sequences inside JSON strings don't truncate extraction. New `sanitizeJsonNewlines()` replaces literal `\n` (0x0a) inside JSON strings with `\\n` before `JSON.parse()`. Full fallback chain: fenced → brace-on-fenced → brace-on-full output. ([brainstorm-parser.ts](src/workflow/brainstorm-parser.ts))

- **🟡 Status bar now updates per brainstorm sub-step** — `ui.setStatus()` is called with `formatStatus(state)` at the entry of each sub-step (scout, questions, approaches, design) instead of showing "scouting..." for the entire phase. ([brainstorm.ts](src/workflow/phases/brainstorm.ts))

- **🟢 Confirm dialogs no longer show "undefined"** — Design section approval calls now pass two arguments `(title, message)` with `|| "(untitled)"` / `|| "(no content)"` fallbacks instead of a single concatenated string. ([brainstorm.ts](src/workflow/phases/brainstorm.ts))

### Improvements

- **`description: |` block scalar support** in `parseYamlLikeTasks()` — YAML-like task blocks now support multi-line descriptions with the pipe syntax, including automatic dedenting and embedded code fences. ([state.ts](src/workflow/state.ts))

- **Brainstorm prompt hardening** — All brainstorm prompts (`buildBrainstormQuestionsPrompt`, `buildBrainstormApproachesPrompt`, `buildBrainstormDesignPrompt`, `buildBrainstormSectionRevisionPrompt`) and the brainstormer agent profile now include explicit instructions to use `\n` escape sequences instead of literal newlines in JSON strings. ([prompt-builder.ts](src/workflow/prompt-builder.ts), [brainstormer.md](agents/brainstormer.md))

### Tests

- 32 new tests (250 → 282 total) across 4 new test files:
  - `state.acceptance.test.ts` — 11 tests for task parser with real smoke-test fixture
  - `brainstorm-parser.acceptance.test.ts` — 5 tests for JSON parsing edge cases
  - `brainstorm.acceptance.test.ts` — 3 tests for status bar + confirm dialog
  - `plan-write.acceptance.test.ts` — 1 integration test for end-to-end plan parsing
- Test fixture vendored at `src/workflow/__fixtures__/smoke-test-plan.md`

## 0.2.0 (2026-02-07)

### Features

- **Workflow Orchestrator** — deterministic state machine replacing prompt-driven SDD flow
  - `/workflow <description>` starts an end-to-end orchestrated workflow
  - Five phases: plan-draft → plan-review → configure → execute → finalize
  - Scout explores codebase, implementer (as planner) drafts tasks, reviewers validate the plan
  - Structured user interaction: plan approval, review mode, execution mode, batch size, escalation handling
  - Three execution modes: auto (continuous), checkpoint (pause per task), batch (pause per N tasks)
  - Two review modes: single-pass (findings as warnings) and iterative (review-fix loop until pass)
  - Full state persistence to `.superteam-workflow.json` — resume with `/workflow`
  - `/workflow status` shows current phase, task progress, and cumulative cost
  - `/workflow abort` clears state and stops the workflow
  - Cost budget checked before every agent dispatch
  - Final cross-task quality review and summary report

- **New modules:**
  - `src/workflow/orchestrator.ts` — top-level orchestrator entry point and phase dispatch loop
  - `src/workflow/orchestrator-state.ts` — typed state (`OrchestratorState`), persistence (`saveState`/`loadState`/`clearState`), phase transitions
  - `src/workflow/prompt-builder.ts` — deterministic prompt construction for scout, planner, reviewers, implementer, and fix prompts
  - `src/workflow/interaction.ts` — structured user interaction helpers (`PendingInteraction`, `parseUserResponse`, `formatInteractionForAgent`)
  - `src/workflow/git-utils.ts` — async git utilities (`getTrackedFiles`, `computeChangedFiles`, `getCurrentSha`)
  - `src/workflow/phases/plan.ts` — plan draft phase (scout + planner dispatch)
  - `src/workflow/phases/plan-review.ts` — plan review phase (architect + spec reviewer, iterative revision)
  - `src/workflow/phases/configure.ts` — configure phase (review mode, execution mode, batch size)
  - `src/workflow/phases/execute.ts` — execute phase (implement → review → fix loops, escalation)
  - `src/workflow/phases/finalize.ts` — finalize phase (cross-task review + report generation)

- **`workflow` tool** — registered alongside `team` tool, allows AI to invoke the orchestrator directly

- **Thinking level support (`thinkingOverrides`)**
  - New `ThinkingLevel` type: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `VALID_THINKING_LEVELS` constant for validation
  - `config.agents.thinkingOverrides` — per-agent thinking level overrides in `.superteam.json`
  - `resolveAgentThinking()` helper — resolves effective thinking level: config override → frontmatter → undefined
  - Agent frontmatter `thinking` field parsed and validated during discovery
  - Invalid thinking levels in config are warned and dropped during loading
  - `--thinking` flag passed to subprocess when thinking level is resolved

- **`resolveAgentModel()` helper** — centralized model resolution: config override → frontmatter → scoutModel/defaultModel

- **`/team` display fix (`formatAgentLine`)** — `/team` command now shows:
  - Effective model with source annotation (`(override)`, `(config default)`, or no annotation for frontmatter)
  - Effective thinking level with source annotation (`(override)` for config, no annotation for frontmatter)
  - Tools list
  - Extracted to `src/team-display.ts` for testability

### Bug Fixes

- **Falsy thinking level fix** — `resolveAgentThinking` uses nullish coalescing (`??`) instead of logical OR (`||`) to correctly handle `"off"` as a valid thinking level (falsy string)
- **ESM import fix** — all internal imports use `.js` extensions for proper ESM module resolution
- **Git utils async extraction** — git operations (`getTrackedFiles`, `computeChangedFiles`, `getCurrentSha`) extracted from inline `execSync` calls to proper async `execFile` with timeout and error handling

### Documentation

- New [Workflow Guide](docs/guides/workflow.md) covering all phases, interaction points, and execution modes
- Updated README with `/workflow` command reference, orchestrator feature section, and updated architecture diagram
- Updated [Configuration Guide](docs/guides/configuration.md) with `thinkingOverrides` and orchestrator defaults
- Updated [Agent Guide](docs/guides/agents.md) with thinking level support and override priority
- Updated [Contributing Guide](CONTRIBUTING.md) with new project structure

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
