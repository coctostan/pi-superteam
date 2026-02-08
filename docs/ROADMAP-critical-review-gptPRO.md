# Critical review of `docs/ROADMAP.md` (problems only)

## Missing “definition of done”
- No acceptance criteria per milestone (“v0.3 ships when…” is undefined), inviting scope creep.
- No success metrics for “quality first” (bug rate, rerun pass rate, human edits needed, time-to-approve, etc.).
- Versioning is cosmetic: big bundles with no clear gates encourages half-shipping + still bumping versions.

## Ordering & dependency contradictions
- Roadmap promises “Adjust plan” at checkpoints (v0.3) but true plan revision is “Later” → checkpoints become “Continue/Abort theater.”
- “Later” items (parallel execution) depend on a dependency graph you haven’t committed to encoding now (plan format + parser + UI).
- Chunking/splitting (v0.4) requires workflow composition primitives (spawn/chain, state transfer, artifact linking) that aren’t specified.

## Continuous validation (v0.3) is underspecified where it matters
- “Run full test suite after every task” will be slow/flaky in real repos; without flake policy you’ll halt constantly and train users to ignore failures.
- No planned-red/green story: refactors often intentionally break tests mid-flight; your stop-on-fail model blocks legitimate sequences.
- Execution environment ambiguous (local/CI/sandbox), leading to irreproducible failures (versions, env vars, secrets, OS differences).
- “Estimated cost to finish” is promised but not defined; cost estimation is also deferred to Later, creating an internal inconsistency.

## Plan review loop will still spiral
- “Reviewer never alters artifacts” needs enforcement (permissions/tooling), not intent.
- Banning line-level correctness from reviewers is unrealistic; bugs manifest at lines. Without a structured findings schema, output becomes either vague prose or over-prescriptive diffs.
- “Targeted patches, not rewrites” is unenforceable without diff tooling or patch-size constraints.
- N=2 review-fix limit is arbitrary; no mode-specific escalation logic (parse failures vs design gaps vs reviewer disagreement).

## Git/commit mechanics risk
- Orchestrator-controlled commits assume clean/deterministic working tree; ignores generated files, formatter churn, lockfile noise, pre-commit hooks, signing requirements, branch protections.
- Rollback depends on per-task commits; v0.5 squashing deletes that granularity unless you define a coherent policy (when allowed, what metadata is preserved).
- No conflict strategy for overlapping edits across tasks (within a single branch you can still get “merge-like” conflicts).

## “Collaborative with the user” is asserted, not designed
- Defaults automate key decisions (commits, checkpoints, stopping) without specifying when the user is asked vs merely informed.
- UI primitives are named but lack contracts (event ordering, persistence, resume behavior, failure states).
- Human override semantics are missing: Skip/Abort/Retry/Adjust are not defined as state transitions with clear persistence/rollback behavior.

## Artifact management will break docs
- Archival/moving artifacts will break intra-doc links unless you define stable permalinks or an index that never moves.
- Final prose summary is prone to hallucination unless strictly constrained to authoritative inputs (diffs/commits/file lists) with explicit formatting rules.

## Missing security / adversarial model
- No prompt-injection threat model (untrusted repo text influencing agents).
- No sandboxing/permissions story for running commands and handling secrets; tests/scripts can do arbitrary things.
- Tool safety and exfiltration risks are not addressed (especially with multi-agent autonomy).

## Error handling is mostly absent
- No failure taxonomy (parse errors, tool failures, timeouts, flaky tests, reviewer disagreement, conflicts) → recovery becomes ad-hoc.
- No idempotency guarantees: retries can duplicate work or mutate state unless phases are explicitly safe to re-run.

## Most likely near-term failure modes
- Constant halts from slow/flaky validation without a flake and staging policy.
- Checkpoints that can’t actually adjust anything (no real revise mechanism), forcing abort/restart cycles that undermine “collaboration.”
