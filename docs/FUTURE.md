# Future Plans

Living document. Items triaged 2026-02-08.

Versioned milestones (v0.3–v0.5) are in [ROADMAP.md](ROADMAP.md). This file tracks items that don't fit a near-term milestone.

---

## Later

### Finalize phase: workflow completion report
Deterministic summary from state (task table, file inventory, cost breakdown, timeline) + optional LLM prose summary. Output to `docs/plans/YYYY-MM-DD-<slug>-summary.md`. Do after the core execute loop is solid.

### Resume UX
When resuming `/workflow` mid-brainstorm, show recap of prior answers before continuing. "You've answered 3/5 questions. Continuing from question 4..."

### Parallel task execution
Use dependency graph from plan to identify parallelizable batches. Dispatch multiple implementers via `dispatchParallel`. Blocked by merge conflict risk — needs git worktree integration first.

### Git worktree integration
Isolate parallel agents in worktrees. Orchestrator merges after completion. Prerequisite for parallel task execution. Requires `git-utils.ts` additions.

### Cost estimation before execution
After plan approval, estimate total cost from task count × historical average. Needs workflow history data first.

### Custom review profiles
Project-specific review config in `.superteam.json`. Security-focused projects get mandatory security review; prototypes get none. Wait for real user demand.

### Model rotation / fallback
On model failure (rate limit, outage), try alternative. Config: `modelFallbacks: { "model-a": ["model-b"] }`. Useful but complex; current failure rates don't justify it yet.

### Incremental plan updates
`/workflow revise` → edit plan → re-parse tasks → continue. Edge case; restart is fine for now.

### Plan diff on revision
Show diff of plan changes rather than re-presenting entire plan. Nice UX, standard diff tools work in the meantime.

### Workflow history
Track completed workflows in `.superteam-history.json`. Foundation for cost estimation and learning features.

### Agent evaluation harness
Test harness for comparing agent configs (model, thinking, prompt) against the same task. Do when seriously comparing models.

### Cost optimization experiments
Data-driven model selection using evaluation harness. Depends on harness above.

### No abort signal for running agents
`pi --mode json` doesn't handle SIGTERM gracefully in all cases. Current mitigation: commit before each task so `git reset` works. Clean abort is a pi-level concern.

---

## Use Cases to Explore

Test matrix for smoke-testing the full workflow against different task shapes.

- **Greenfield bootstrap** — empty project, scaffold from scratch. Challenge: scout has nothing to scan.
- **Large refactoring** — cross-cutting changes, complex task dependencies, cascading edits.
- **Bug investigation + fix** — diagnostic questions, investigation-first approach, not feature dev.
- **Documentation overhaul** — no code changes. Tests non-code task handling.
- **Monorepo multi-package** — cross-package dependencies, package-aware task ordering.
- **Security audit** — investigation-heavy, may not produce code. Needs non-TDD plan format.
- **Performance optimization** — benchmarking steps, non-test success criteria.

---

## Dropped (for posterity)

Items evaluated and intentionally not pursued. Kept here so we don't re-litigate.

### Session cost dashboard
The data is already in workflow state. A formatted `/workflow status` covers the need. Dedicated dashboard is over-engineering.

### Template workflows
Premature abstraction — we don't know the common patterns yet. Brainstorm phase handles variability.

### Multi-model brainstorming
Dispatch multiple models for approaches. Cool idea, marginal value. One good model beats three mediocre ones. Cost triples for minimal insight gain.

### Plan quality feedback loop
A 1-5 rating stored in JSON won't change behavior. You know when plans are bad.

### Extension marketplace
Not in our control. If pi gets one, adapt then.

### Brainstorm question quality varies by model
Observation, not actionable. Model choice is already configurable in `.superteam.json`.

### No learning from past workflows
Too speculative. Would need to define what "learning" means concretely before it's actionable.

---

## Resolved

Moved from active tracking. Either fixed or superseded.

- **v0.2.1 bug fixes** — YAML parser, brainstorm JSON parse failures, status bar, undefined display. All fixed. See CHANGELOG.md.
- **One task per agent dispatch** — already implemented in execute phase. Each task gets a fresh implementer subprocess.
- **Context window pressure on large plans** — solved by per-task dispatch architecture.
- **Long plans cause context death** — same as above. Architectural constraint, not a bug to fix.
- **Planner prompt refinement** — ongoing tuning, not a discrete item. Observations belong in `planner.md`.
