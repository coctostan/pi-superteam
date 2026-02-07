# Review: Smoke Test Bugfixes Implementation Plan

Date: 2026-02-07

Reviewed:
- Implementation plan: `docs/plans/2026-02-07-smoke-test-bugfixes-implementation-plan.md`
- Against Design v3: `docs/plans/2026-02-07-smoke-test-bugfixes-design-v3.md`
- Against Design v3 review: `docs/plans/2026-02-07-smoke-test-bugfixes-design-v3-review.md`

---

## (1) Task structure: ordering, file counts, Bug 2 split, Bugs 3+4 combined

**PASS with one exception (see Issue A below).**

- **Execution order** matches Design v3: Bug 1 (Tasks 1–2) → Bug 2 (Tasks 3–6) → Bugs 3+4 (Tasks 7–8) → integration (Task 9) → deploy (Task 10). ✓
- **File counts** — every task touches 1–2 files, well within the 1–3 limit. ✓
- **Bug 2 split** — cleanly separated into tests (Task 3), Layer 1+2 (Task 4), Layer 3 (Task 5), Layer 4 (Task 6). ✓
- **Bugs 3+4 combined** — single test task (Task 7) and single implementation task (Task 8), both targeting `brainstorm.ts`. ✓

---

## (2) Per-task specification: files/functions, AT numbers, verify commands

**PASS.** Every narrative task specifies:
- Exact files to create or modify. ✓
- Functions to touch (e.g., `parseTaskBlock()`, `extractFencedBlock()`, `sanitizeJsonNewlines()`). ✓
- AT numbers for test tasks, explicit "no new AT" for prompt-hardening Task 6. ✓
- Vitest verify command (`npx vitest run <file> --reporter=verbose`); Task 10 runs the full suite. ✓

All 11 ATs from Design v3 (AT-1, AT-2, AT-3, AT-3b, AT-4, AT-5, AT-6, AT-7, AT-8, AT-9, AT-10) are present and assigned to the correct tasks.

---

## (3) Faithfulness to Design v3 — no invented approaches; constraints + deploy

**PASS.** Cross-checked each task against Design v3:
- Task 2 line-walker + `description: |` logic matches Design v3 Bug 1 fix verbatim. ✓
- Task 4 quote-aware extractor algorithm and `sanitizeJsonNewlines()` match Design v3 Layer 1+2. ✓
- Task 5 fallback chain (fenced → brace-on-fenced → brace-on-full) matches Design v3 Layer 3 step-by-step. ✓
- Task 6 prompt targets (brainstormer.md + 4 prompt-builder functions) match Design v3 Layer 4. ✓
- Task 8 `setStatus`/`confirm` fixes match Design v3 Bugs 3+4. ✓
- **No new approaches invented.** ✓

Constraints section includes: vitest, no new dependencies, vendored fixtures, TDD order, deploy command. ✓

Deploy command matches Design v3 verbatim:
```bash
rm -rf /home/pi/.npm-global/lib/node_modules/pi-superteam/src/ ...
cp -r ~/superteam/src/ ...
```
✓

---

## (4) superteam-tasks block: machine-parseability + narrative match

10 narrative tasks, 10 superteam-tasks entries, titles and file lists match 1:1. ✓
No multiline YAML — all descriptions are single-line, all `files:` are inline arrays. ✓

**However, one critical parsing issue (Issue A) and one minor issue (Issues B, C).**

---

## Issues

### Issue A — 🔴 CRITICAL: superteam-tasks Task 2 description contains literal ` ``` ` that triggers Bug 1 on the plan itself

Task 2's description reads:
> …so embedded ``` fences and multi-line descriptions no longer drop tasks.

The current `parseTaskBlock()` regex is:
```typescript
const fenceRegex = /```superteam-tasks\s*\n([\s\S]*?)```/;
```
The non-greedy `[\s\S]*?` stops at the **first** ` ``` ` it encounters — which is the one inside Task 2's description text on line 228. This truncates the captured block: **Tasks 3–10 are lost.** The plan triggers the very bug it's trying to fix.

This must be fixed before the workflow engine can parse all 10 tasks.

**Fix:** Replace ` ``` ` with prose that avoids literal triple backticks.

```
oldText (in superteam-tasks block, Task 2 description):
  description: Rewrite parseTaskBlock() as a line-walker and extend parseYamlLikeTasks() to support description: | block scalars so embedded ``` fences and multi-line descriptions no longer drop tasks.

newText:
  description: Rewrite parseTaskBlock() as a line-walker and extend parseYamlLikeTasks() to support description-pipe block scalars so embedded code fences and multi-line descriptions no longer drop tasks.
```

### Issue B — 🟡 MINOR: superteam-tasks Task 8 omits the `formatStatus` import

Design v3 Bug 3 section explicitly states: *"add `formatStatus` import from `../ui.js`"*. The narrative Task 8 mentions it (*"Add/verify the correct import of `formatStatus` from `../ui.js`"*). Confirmed `formatStatus` is **not** currently imported in `brainstorm.ts` (`grep` returns nothing).

The superteam-tasks description doesn't mention it:
> Call ui.setStatus("workflow", formatStatus(state)) at each sub-step entry …

An implementer using `formatStatus()` without adding the import will get a build error. Low risk (the error is obvious), but worth adding for completeness since this is the machine-parsed task.

**Fix:**

```
oldText (in superteam-tasks block, Task 8 description):
  description: Call ui.setStatus("workflow", formatStatus(state)) at each sub-step entry (scout/questions/approaches/design) and fix ui.confirm() call sites to pass (section.title||"(untitled)", section.content||"(no content)").

newText:
  description: Add formatStatus import from ../ui.js, call ui.setStatus("workflow", formatStatus(state)) at each sub-step entry (scout/questions/approaches/design), and fix ui.confirm() call sites to pass (section.title||"(untitled)", section.content||"(no content)").
```

### Issue C — 🟡 MINOR: Task 10 `files:` array is a placeholder that doesn't reflect actual work

Task 10 is "run full test suite + deploy." It doesn't edit any source file. The superteam-tasks entry lists:
```
files: [docs/plans/2026-02-07-smoke-test-bugfixes-implementation-plan.md]
```
The plan file itself isn't modified by this task. This is misleading to the workflow engine, which may interpret `files:` as "files this task will edit."

**Fix:** Point at a file the deploy actually overwrites, or use a lightweight sentinel:

```
oldText (in superteam-tasks block, Task 10):
  files: [docs/plans/2026-02-07-smoke-test-bugfixes-implementation-plan.md]

newText:
  files: [src/workflow/state.ts]
```

(`src/workflow/state.ts` is the first file the deploy copies — a reasonable representative.)

---

## Summary

| # | Severity | Issue | Fix |
|---|---|---|---|
| A | 🔴 CRITICAL | Task 2 description has literal ` ``` ` — current buggy parser truncates Tasks 3–10 | Rephrase to "embedded code fences" |
| B | 🟡 MINOR | Task 8 description omits `formatStatus` import from `../ui.js` | Prepend "Add formatStatus import from ../ui.js" |
| C | 🟡 MINOR | Task 10 `files:` is a placeholder (plan file isn't edited) | Point at `src/workflow/state.ts` or another deploy target |
