# Critical review of `docs/ROADMAP.md`

## Cross-cutting problems (will cause ambiguity or rework)

- **Config without a config system**: v0.3 already needs configurable cadence (validation every N tasks), checkpoint modes, budget thresholds, and project-specific validation commands. But config is only mentioned later (“custom review profiles” / `.superteam.json`). You’ll either hardcode policy decisions or invent ad-hoc flags, then unwind them.

- **“Collaborative with the user” vs unattended automation**: checkpoints propose an “auto mode” that proceeds without the user except on failures/budget. That’s an implicit policy engine. You need explicit user opt-in semantics (what decisions can be made automatically, under what limits) or you’ll violate your own constraint.

- **Baseline test reality is ignored**: “run full test suite after every task” assumes green + deterministic tests and a runnable environment. Without a strategy for known failures + flakes + missing env/secrets, v0.3 will deadlock immediately in many real repos.

- **Failure handling is underspecified**: you repeatedly say “stop and surface failure” but not what happens next:
  - who diagnoses (implementer vs dedicated triage agent),
  - whether you create a regression-fix task automatically,
  - rollback/default actions.

- **“Reviewer never edits” is not enforceable as written**: it’s a convention, not an implementation. Without tool-level restrictions per role, reviewers will eventually mutate files (accidentally or via prompt drift).

- **Milestones explicitly avoid priority ordering**: but the work is dependency-driven. Without a priority within each milestone, implementation order will be arbitrary and you’ll keep discovering that “supporting item” X was actually prerequisite Y.

- **Roadmap looks stale/internally inconsistent with other docs**: several “prerequisite fixes”/“supporting items” appear already complete elsewhere (streaming wiring, validation gate, rollback). If this file isn’t authoritative, it won’t prevent rework.

## v0.3 — Continuous Validation & Course Correction

- **“Full test suite after every task” is a scalability trap**:
  - test command discovery/override is undefined,
  - timeouts/parallelism policy is undefined,
  - *flake policy* is undefined.
  If suites are slow, the workflow becomes unusable; if you fall back to “every N tasks,” you weaken the quality claim and reintroduce silent regressions.

- **No explicit “task must leave repo green” requirement**: cross-task validation implies *each task* ends with global pass. That constraint must be enforced at planning time (task decomposition), but the roadmap doesn’t call it out.

- **Cost accounting assumptions may not hold**:
  - not all providers/models return reliable cost metadata,
  - parallel reviews (v0.4) breaks naive accounting,
  - “estimated cost to finish” is undefined and likely misleading early.

- **Checkpoint UX implies capabilities you don’t have**:
  - “Adjust plan” at a checkpoint isn’t actionable without `/workflow revise` (parked in Later).
  - If the real behavior is “abort and restart,” say so; otherwise you’ll build UI for a feature you can’t support.

- **Orchestrator-controlled commits need safety rules**:
  - dirty repo at start (user local changes),
  - branch policy (commit to `main`?),
  - generated/untracked files,
  - commit messages using “task N” (unstable if tasks are inserted/reordered/skipped).
  Without preflight checks + stable task IDs, this will bite you.

- **Validation failure path is missing**: after cross-task tests fail, do you auto-rollback + retry? dispatch an implementer “fix regression” loop? require immediate user decision? Right now it’s just “stop.”

- **“Post-task context forwarding” can’t be deterministic as described**: “key decisions” requires interpretation (LLM). If you keep it deterministic, you’ll forward only file lists/SHAs, which may not prevent contradictions.

## v0.4 — Brainstorm Triage & Scope Management

- **Triage labels aren’t operational**: “straightforward / needs exploration / complex” is a label unless you define concrete behavior changes (skip phases? limit questions? fewer plan-review cycles?). Without explicit knobs, v0.4 risks becoming conversation with no process right-sizing.

- **Chunking depends on mid-workflow replanning**: “plan-execute-reassess cycle per batch” is basically incremental plan updates + looping the state machine. But `/workflow revise` is explicitly Later. Dependency miss.

- **Chunking vs workflow splitting is redundant/unclear**: both divide scope; one is intra-run, one is multi-run. Without a crisp rule + state model, you’ll implement two overlapping systems that drift.

- **Parallel reviews create instruction-level conflicts**: if spec/quality disagree, who resolves? do you synthesize/dedupe/prioritize findings? Concurrency also complicates streaming, cancellation, and cost accounting. This is real orchestration work, not a “supporting item.”

- **“Go-back” brainstorm capability is underspecified**: you can’t actually rewind an LLM; you need a concrete mechanism (state snapshots + regeneration + user-edited context) or you’ll end up with inconsistent transcripts.

## v0.5 — Workflow Close-Out

- **Finalize report vs squash is contradictory**: you want per-task commit SHAs, then you offer to squash them. After squashing, the SHAs are meaningless (or not on the mainline). You need an ordering + mapping, or drop SHAs from the user-facing report.

- **Archival strategy will pollute repos**: committing `docs/plans/archive/...` bloats repos and creates merge conflicts; not committing makes “history” local and fragile. You need an explicit policy (repo-tracked vs local-only) and `.gitignore` guidance.

- **`.superteam-history.json` privacy/location is unresolved**: costs + run metadata are often unacceptable to commit. If it’s local-only, don’t put it at repo root.

- **Docs update skill blurs collaboration + verification**: “applies updates directly” creates an unreviewed change path inside finalize unless you re-run the full review/validation loop (which explodes scope/time). Needs a crisp boundary.

- **Summarizer agent output will be untrusted without grounding**: prose summaries need strict grounding (commit/file inputs + “only summarize these diffs”), or they’ll hallucinate/omit.

## Ordering / missing dependencies to surface explicitly

- Move **`/workflow revise` (or equivalent)** earlier, or remove “adjust plan” and chunking claims.
- Introduce a **minimal config story** earlier (validation commands, cadence, budgets).
- Define **baseline test + flake policy** before “continuous validation.”
- Add a **review-finding synthesis step** before parallel reviews.
- Define **git safety model** (clean-tree preflight, branch policy) before orchestrator commits/squash.
