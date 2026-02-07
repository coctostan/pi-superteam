# Changelog

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
