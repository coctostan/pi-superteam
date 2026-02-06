# Review (v4): Superteam Implementation Plan (2026-02-06)

**Reviewed file:** `docs/plans/2026-02-06-superteam-implementation.md`

## Readiness verdict (with “90% ready” bar)

**Current readiness: ~88%**.

You are very close. The plan is coherent, mostly verifiably compatible with pi’s APIs/CLI, and has a sane implementation order.

**It becomes “>90% ready” when these are resolved in the plan (not necessarily implemented yet):**
1. **Decide and document how “hard enforcement” applies during SDD implementer work** (guard in implementer subagents vs proposal-only/sandbox).
2. **Fix the skill loading semantics for isolated subagents** (`--skill` must be a path; ensure it still works when `--no-skills` is used).
3. **Clarify how you will record results of `!npm test` / user bash test runs**, since `user_bash` is a pre-execution hook.

If you address those three, the remaining issues are mostly “normal engineering” (parsing edge cases, UX polish, additional heuristics), and I’d call it >90% ready.

---

## What’s excellent / significantly improved

### Deterministic subprocesses (security + portability)
Making subprocesses deterministic (`--no-extensions --no-skills --no-prompt-templates`) is exactly the right call. It:
- prevents environment-dependent behavior,
- reduces repo-controlled extension risk,
- makes debugging reproducible.

### Guard semantics are now adoption-friendly
The TDD guard now enforces the *mechanical minimum* (tests exist + have been run) instead of “must have failing test”, and explicitly avoids blocking REFACTOR. That is likely to be used rather than turned off.

### Config + mapping are real, not hand-wavy
`.superteam.json` + `src/config.ts` + explicit impl→test mapping strategies solve the single most common failure mode of enforcement guards: “I can’t tell what the test is, so everything is blocked.”

### JSON mode parsing aligns with pi docs
Your event naming (`message_end`, `tool_execution_end`) matches pi JSON mode documentation. Good.

### Cost tracking is plausible
Pi’s assistant messages include `usage` including `cost.total` (provider-dependent, but supported in core types), so “cumulative cost” can be computed from `message_end` events in subprocess JSON mode.

---

## High severity findings (blockers for “>90% ready”)

### H1) SDD implementer can bypass the guard (hard-enforcement gap)
Your plan states:
- main session runs the guard,
- subagents are spawned isolated and therefore **do not run the guard**,
- implementer subagent has `write/edit/bash` in the real repo.

That means the SDD path can write implementation without any hard block. Reviews may catch it later, but that is **not enforcement**.

**Why it matters:** This undermines your core claim: “extension code enforces methodology (hard blocks via tool_call interception)” in the very workflow (SDD) that delegates the most writing.

**Make an explicit decision in the plan:**
- **Option A (consistent hard enforcement):** spawn implementers with `-e <superteam>` so the guard runs inside implementer subprocesses too. Keep deterministic isolation by only adding back superteam.
- **Option B (recommended): proposal-only implementer:** implementer subagents become read-only and output:
  - a unified diff (or file-by-file patches),
  - test commands to run,
  - rationale.
  The main guarded session applies changes via `write/edit`.
- **Option C:** sandbox clone/worktree for implementers, then apply patch after review (more complex; you explicitly deferred worktrees).

If you keep the current approach, reword “hard enforcement” claims to “hard enforcement in main session only; SDD relies on review verification.”

### H2) Skill loading is specified in a non-portable way
The plan uses `--skill test-driven-development`.

In pi, `--skill` takes a **path to a skill file or directory** (same pattern as extensions). In an isolated subprocess using `--no-skills`, you should pass an explicit path (likely within your installed package).

**Fix in plan:**
- dispatch computes `packageRoot`, then passes:
  - `--skill ${packageRoot}/skills/test-driven-development/SKILL.md`

Also explicitly verify whether “no-skills disables discovery but still loads explicitly-provided `--skill` paths” (likely yes, but call it out).

### H3) User `!npm test` tracking needs a concrete mechanism
You want to update guard state on `user_bash`.

In the extension API, `user_bash` is fired **before** execution and has no built-in “result event”. To capture output/exit code you must either:
- return a `result` (fully handle execution), or
- return wrapped `operations` (intercept execution and still delegate).

**Fix in plan:** add one paragraph that states which of the two you will implement and how you’ll detect “this command was a test run” (regex match vs config allowlist).

---

## Medium severity findings (should be fixed, but not blocking)

### M1) Reviewer JSON extraction should be made deterministic
“Last `{...}` block” parsing is easy to get wrong with braces in code snippets.

**Recommendation:** require reviewers to end with a fenced block:
```text
```superteam-json
{ ... }
```
```
Then parse by fence marker, not brace matching.

### M2) Don’t trust implementer self-report for “files changed”
Compute changed files in the orchestrator (git diff if available; otherwise snapshot hashes) and pass that list to reviewers.

### M3) Subprocess isolation completeness
Consider adding `--no-themes` for full determinism and to reduce startup work. (Minor, but consistent.)

### M4) Confirm “lsp-pi” loading mechanism under isolation
You propose `-e npm:lsp-pi`. That is valid for pi packages (per packages docs), but it should be listed as a **verified** assumption in Task 1.

---

## Low severity / polish

- `/superteam init` is mentioned in config section but not listed under registered commands. Either add it to “Registers:” or remove the mention.
- Trust confirmation for project-local agents in print mode: when `ctx.hasUI === false`, default to “do not load project agents”. Document this.

---

## “This would be really cool to add” (still)

1. **Proposal-only SDD as the default** (even if you later add guarded implementer subprocesses). It makes enforcement story airtight and reduces risk.
2. **Safe `run-tests` tool** driven by `.superteam.json.testCommands` allowlist so reviewers can remain no-bash.
3. **Dangerous-bash gate** in TDD mode (block `rm -rf`, writing outside repo root, `curl | sh`, etc.) with a confirm dialog.

---

## Summary: what to change to be “>90% ready”

If you update the plan to:
- resolve H1 (guarded implementers or proposal-only),
- fix H2 (`--skill` path semantics),
- and add a concrete H3 mechanism for user bash result capture,

…I’d call this plan **>90% ready**.

Right now it’s about **88%**: strong architecture, strong sequencing, a few last “this must be decided to avoid building the wrong thing” gaps.
