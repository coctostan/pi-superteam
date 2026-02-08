# Post-Run 1 Assessment

First end-to-end workflow run on pi-superteam itself. 2026-02-08.

## Run stats

- **20 tasks**, 20 complete, 0 skipped, 0 escalated, 1 fix cycle total
- **$59.45** total ($2.85 brainstorm, ~$8 planning/review, ~$48 execution)
- **32 files changed**, 3933 insertions, 451 deletions
- **Duration**: ~6 hours (mostly unattended overnight)
- **1 test regression**: AT-7 brainstorm acceptance test broken by brainstorm skip feature

## What worked

- **Execute phase**: 20/20 tasks, fresh implementer per task, reviews caught real issues, 1 fix cycle across all tasks. This is the strongest part of the system.
- **Brainstorm quality**: Questions were relevant, approaches were distinct, design sections were thorough with specific file paths and function names.
- **Review quality during execution**: Spec and quality reviewers caught actual issues. Security and performance reviewers passed cleanly where appropriate.
- **Task isolation**: Fresh context per implementer prevented compaction. Each task got full attention.

## What broke

### Plan-review loop doesn't converge

4 revision cycles, same 2 issues persisted (arg index off-by-one in proposed test code, claim that existing file doesn't exist). Planner rewrites entire 20-task plan each cycle. By round 4, had dropped 3 of 15 spec items. Approved a degraded plan because continuing was counterproductive.

**Root cause**: Plan review validates at the wrong level. Checking argument indices in proposed test code is code-level validation of code that doesn't exist yet. The implementer reads the actual signature and gets it right. Plan review should check decomposition, dependencies, completeness, granularity — not inline test code correctness.

**Secondary cause**: Full-plan rewrites. The planner can't surgically fix line 847 of a 1300-line plan. It rewrites everything and introduces new gaps. Needs targeted patches or a much stricter "only change what the findings reference" instruction.

### One-size-fits-all process

Adding `bash` to a security-reviewer markdown file (a one-line change) went through: scout → 7 questions → 3 approaches → 6 design sections → 20-task plan → 4 plan reviews → implementation → 4 reviewer agents → final review. The ceremony was wildly disproportionate to the change.

### Silent phases

Brainstorm, plan-write, and plan-review phases dispatch agents with no streaming feedback. The UI appeared frozen for 10-60+ seconds at a time. Users cannot distinguish "working" from "crashed." Execute phase has streaming — the other phases don't.

### No cost visibility

User asked "how much have we spent?" multiple times. Cost is only in the state file. No real-time display, no estimation before execution, no per-phase breakdown visible during the run.

### Context doesn't flow forward

Each implementer starts fresh with only its task description and plan context. Doesn't know what tasks 1-N changed. Plan said "plan-review.test.ts doesn't exist" but earlier tasks may have modified it. Static context (`.pi/context.md`) is now injected (task 6 of this run), but dynamic context (what changed in this workflow run so far) is missing.

### No intermediate validation

Per-task tests only. No cross-task regression check. Task 15 could silently break task 3's work. Only discovered at finalize or never. The AT-7 regression was exactly this — task 19 (brainstorm skip) broke an existing acceptance test that wasn't re-run.

### Finalize is perfunctory

Bare stats dump. No per-task cost breakdown, no timeline, no commit SHAs, no prose summary. No documentation update prompt. No artifact cleanup. No CHANGELOG entry. The user is left with a pile of files in `docs/plans/` and a "workflow complete" message.

## Comparison with best practices

| Practice | Current state | Gap |
|---|---|---|
| Small batch sizes | Plans everything upfront, executes linearly | No plan-execute-reassess cycle |
| Fast feedback loops | Execute phase only | All other phases silent |
| Right-sized process | Full ceremony for every change | No lightweight path |
| Continuous validation | Per-task tests only | No cross-task regression |
| Cost transparency | Buried in state file | No estimation, no real-time display |
| Error recovery | Rollback exists (untested), retry/skip work | No plan adjustment mid-execution |
| Context continuity | Each agent isolated | No shared understanding across tasks |
| Documentation | None | No docs update, no changelog, no cleanup |
| Effective reviews | Code reviews work, plan reviews don't | Plan reviews validate wrong level |
| Progressive disclosure | Flat task list | No drill-down, no agent visibility |

## Three structural changes needed

### A. Tiered workflow modes

Not every change needs the full ceremony.

- **Quick**: Skip brainstorm, single-pass review, no optional reviewers. For small/focused changes (1-3 files, clear spec). User can invoke with `/workflow --quick` or system auto-detects based on scope.
- **Standard**: Current flow with brainstorm, iterative review, full reviewer set. For medium refactors (4-15 tasks).
- **Deep**: Full brainstorm with discussion, multi-model review, mandatory security review, cross-task validation after every task. For large features or security-critical work.

The mode affects: which phases run, how many review cycles, which reviewers are mandatory, whether intermediate validation happens.

### B. Continuous validation and course correction

After every task (or configurable N tasks):
1. Run full test suite (not just the task's tests)
2. Show progress summary: tasks done, cost so far, estimated remaining
3. Optionally pause for user review: "5/20 tasks done, $15 spent, ~$33 remaining. Continue / Adjust plan / Abort?"
4. If tests fail, stop and surface the failure before proceeding

This catches regressions early, gives cost visibility throughout, and allows the user to course-correct mid-execution rather than discovering problems at finalize.

### C. Workflow close-out

Finalize becomes a proper phase:
1. **Rich summary**: Per-task cost, commit SHAs, timeline, fix cycles, prose summary via summarizer agent
2. **Documentation prompt**: "Update docs?" → dispatch agent to identify and update README, CHANGELOG, .pi/context.md, API docs
3. **Artifact archival**: Move design/plan/progress files to `docs/plans/archive/YYYY-MM-DD-<slug>/`
4. **Optional commit squash**: Offer to squash per-task commits into a single merge commit
5. **Retrospective data**: Save run metrics for future cost estimation and process improvement

The workflow isn't done until the project is clean, documented, and shippable.

## Additional improvements (not structural)

These are important but don't require architectural changes:

- **Plan review scope**: Restrict to structure/completeness/dependencies. Explicitly instruct reviewers NOT to validate inline test code.
- **Plan revision strategy**: Targeted patches instead of full rewrites. Or: cap at 2 cycles and accept.
- **Brainstorm interaction**: Multi-turn discussion, skip/defer, go back, recap before proceeding.
- **Status bar**: Always show phase + current agent + cost. Never blank.
- **Task widget**: Color-coded status, current agent name + model, expandable detail.
- **Documentation update skill**: Reusable outside workflows for manual changes.

## Items from run 1 still pending

These were identified during the run and are in `docs/plans/next-batch.md`:

1. Streaming feedback for all phases (UX #1 priority)
2. Richer brainstorm interaction (discuss, skip, go back)
3. Brainstorm skip option *(implemented in run 1 — but broke AT-7)*
4. Fix AT-7 regression
5. Execute phase agent visibility
6. Richer finalize report
7. Post-workflow documentation update
8. Workflow artifact cleanup

Items completed in run 1 (20 tasks):
- Parser hardening (shared parse-utils, review parser defense)
- `.pi/context.md` injection into subagents
- Prompt-builder cleanup (removed duplicate review format)
- Security-reviewer bash tools
- Scout prompt narrowing
- Validation gate before reviews
- Test-file-only review check
- Rollback option on escalation
- Git utils (resetToSha, squashCommitsSince)
- Post-task summary fields
- onStreamEvent wiring for brainstorm/plan-write/plan-review
- Plan file path fallback
