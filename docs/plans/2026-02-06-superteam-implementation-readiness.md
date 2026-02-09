# Superteam plan readiness (2026-02-06)

**Plan:** `docs/plans/2026-02-06-superteam-implementation.md`

## Verdict

**Ready to start implementation.**

Estimated readiness: **~93–95%**.

This means the plan is specific enough to execute without major architectural decisions remaining, assuming Task 1 confirms the few pi CLI/event details called out below.

## What was blocking before (now resolved in the plan)

1. **Hard enforcement during SDD delegation**
   - Resolved by explicitly running the TDD guard **inside implementer subagents** via:
     - `-e <packageDir>/src/index.ts`
   - This closes the enforcement bypass where implementers could write without the guard.

2. **Portable skill loading for isolated subagents**
   - Resolved by specifying `--skill` as a **file path** (not a skill name), e.g.:
     - `--skill <packageDir>/skills/superteam-test-driven-development/SKILL.md`

3. **User-initiated test runs (`!npm test`) tracking**
   - Resolved by documenting the actual constraint:
     - `user_bash` is a **pre-execution** hook with no result.
   - Chosen behavior is explicit:
     - mark `hasEverRun = true` optimistically on detected test commands,
     - use `tool_result(bash)` for real exit-code-based pass/fail when tests are run via the agent.

## Remaining validation items (do early; not design blockers)

These are the main ways execution could diverge from the plan.

1. **Verify isolation CLI flags exist and behave as assumed**
   - The plan uses: `--no-extensions --no-skills --no-themes --no-prompt-templates`.
   - Task 1 should confirm:
     - flags exist,
     - they prevent auto-discovery,
     - explicitly provided `-e …` and `--skill …` still load.

2. **Verify subprocess JSON event names and fields**
   - Confirm events produced by `pi -p --mode json` match what dispatch parsing expects.
   - Ensure `usage/cost` accumulation is present for your provider(s).

3. **Make `packageDir` resolution robust in packaged installs**
   - The dispatcher needs a reliable way to compute the on-disk path for:
     - `-e <packageDir>/src/index.ts`
     - `--skill <packageDir>/skills/.../SKILL.md`
   - Validate this works for:
     - local dev (`pi -e ./src/index.ts`),
     - installed package (`pi install …` then load via settings / package manifest).

## Go/No-Go checklist

**Go** if:
- [ ] the isolation flags are verified (or substituted with a verified equivalent),
- [ ] JSON stream parsing is verified against real output,
- [ ] `packageDir` resolution works in the intended installation mode.

**No-Go** only if:
- you cannot reliably isolate subagents, *and*
- you cannot reliably load the superteam guard/skills explicitly in subagents.

(If isolation flags differ, that’s typically an edit to Task 1 + spawn command strings, not a redesign.)

## Next action

Proceed with **Task 1** from the plan as the first implementation step, with a bias toward building a minimal “dispatch one subagent and parse one result” spike to validate the CLI + JSON assumptions.
