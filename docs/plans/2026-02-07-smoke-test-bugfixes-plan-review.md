# Plan Review: Smoke Test Bug Fixes

## Scope
Review of the proposed implementation plan/design for fixing 4 bugs found in the 2026-02-07 `/workflow` smoke test.

## Overall assessment
The plan is well-structured (bugs → root cause → fix → acceptance tests → execution order) and mostly aligns with the current source.

However, there are a couple of high-risk mismatches where the proposed fix/acceptance test may not address the actual failure mode seen in the smoke test.

---

## Bug-by-bug review

### Bug 1 (task parser drops tasks)

- **Root cause analysis:** Correct for the current `src/workflow/state.ts`.
  - The non-greedy fence regex *will* terminate early on embedded triple-backticks inside task descriptions.
  - `parseYamlLikeTasks()` does not support `description: |` and will store the literal string `"|"` as the description.

- **Fix approach:** Directionally correct, but tighten the spec:
  - Requiring the closing fence at **column 0** avoids matching indented inner fences, but is potentially **too strict** for Markdown (closing fences may be indented up to 3 spaces).
  - Recommendation: treat a closing fence as something like `^ {0,3}```\s*$` so you still ignore inner fences (typically indented 4+ spaces in YAML block scalars), while supporting valid Markdown indentation.

---

### Bug 2 (brainstorm JSON parse failures)

- **Root cause analysis:** Plausible, and consistent with `docs/FUTURE.md` + the observed “unterminated string” errors.

- **Major missing risk:** `extractFencedBlock()` uses the same non-greedy regex pattern as Bug 1:
  - `src/workflow/brainstorm-parser.ts` has: `/```superteam-brainstorm\s*\n([\s\S]*?)```/`
  - If a brainstorm “design” section includes Markdown code fences (```), this regex can truncate the JSON, producing the same “unterminated string” symptom.

- **Plan gap:** The plan fixes JSON-newline invalidity, but does **not** address fence-truncation nor does it attempt brace-match fallback **after** a fenced parse failure (it only falls back when no fenced block exists).

- **Recommendation:** Update the plan to include at least one of:
  1. line-scanning fence extraction (like Bug 1), and/or
  2. if fenced parse fails, attempt `extractLastBraceBlock(rawOutput)` as a recovery path.

---

### Bug 3 (status bar stuck on scouting)

- **Root cause analysis:** Correct.
  - `runWorkflowLoop()` sets status only once per loop iteration.
  - `runBrainstormPhase()` can execute multiple sub-steps in a single call, so explicit status updates inside the phase are needed during long-running dispatches.

- **Fix approach:** Good. Minor suggestion: prefer calling `formatStatus(state)` after updating `state.brainstorm.step` (to keep formatting consistent), but the plan’s strings are acceptable.

---

### Bug 4 (`undefined` displayed in design section display)

- **Root cause analysis is likely incorrect for the current code.**
  - `validateDesign()` already forces `title` and `content` to `""` if missing/undefined, so template interpolation should produce `""`, not `"undefined"`.

- **Most likely actual cause (based on symptom “undefined at the end of design section content”):**
  - `ui.confirm` may take `(title, body)` (or multiple args), and the call site is providing only one argument, leading the UI layer to render an `undefined` second field.

- **Acceptance test AT-6 is currently not reliable:**
  - It asserts the *string argument* passed to `ui.confirm()` doesn’t contain `"undefined"`, but if the UI is rendering `"undefined"` from a missing second parameter, the string won’t contain it and the test will still pass while the UI bug remains.

- **Recommendation:** The plan must first confirm the `ctx.ui.confirm` signature/behavior and then test for correct argument structure (e.g., called with both title and body and body is non-undefined), rather than only substring-matching.

---

## Acceptance test coverage issues

1. **AT-1 uses an external absolute path** (`/home/pi/test-workflow-smoke/...`). That will fail for other devs/CI. The reproduction plan should be vendored into the repo as a fixture (or embedded as a literal string in the test).

2. **Missing acceptance test for Bug 2 fence truncation:** If you don’t add a test where JSON string fields contain ``` sequences, you can “fix” newlines and still keep a major real-world failure mode.

---

## Task list / file path correctness

The task block references new test files like `src/workflow/task-parser.test.ts`, but the parser lives in `src/workflow/state.ts` and there is no existing `task-parser.ts` module. Not fatal, but it’s a spec accuracy issue that will cause churn during implementation.

---

## Structured review output

```superteam-json
{
  "passed": false,
  "findings": [
    {
      "severity": "high",
      "file": "src/workflow/phases/brainstorm.ts",
      "issue": "Bug 4 root cause/fix is likely wrong: validateDesign() already defaults title/content to empty strings, so template interpolation should not produce 'undefined'. The smoke-test symptom ('undefined' shown at end) is more consistent with ui.confirm having a multi-argument signature where an omitted second arg is rendered as 'undefined'. AT-6 as written would not catch that.",
      "suggestion": "Confirm ctx.ui.confirm signature/behavior and update the fix to pass the correct arguments (e.g., separate title/body, ensure body is never undefined). Update AT-6 to assert the correct call signature/args, not just absence of the substring 'undefined' in a single string."
    },
    {
      "severity": "high",
      "file": "src/workflow/brainstorm-parser.ts",
      "issue": "Bug 2 plan ignores a likely failure mode: extractFencedBlock() uses a non-greedy ```superteam-brainstorm regex that can truncate when JSON strings include ``` (common if design content includes code fences). Also, parseBrainstormOutput does not attempt brace-block fallback when fenced extraction exists but JSON parsing fails.",
      "suggestion": "Add a robust fenced-block extractor (line-scan, indentation-aware) and/or attempt brace-match fallback on fenced parse failures. Add an acceptance test where JSON string values contain ``` to ensure no truncation."
    },
    {
      "severity": "medium",
      "file": "src/workflow/state.ts",
      "issue": "Bug 1 fix approach (line-walking to find closing fence at column 0) may be too strict for Markdown where fences can be indented up to 3 spaces; relaxing too much risks matching indented inner code fences.",
      "suggestion": "Specify fence detection using indentation-aware rules (e.g., allow 0–3 leading spaces for the outer fence, require the closing fence line to be exactly ``` with only whitespace otherwise) so inner fences in YAML block scalars (typically indented 4+ spaces) do not terminate the block."
    },
    {
      "severity": "medium",
      "file": "src/workflow/task-parser.acceptance.test.ts",
      "issue": "AT-1 references an absolute external reproduction file path (/home/pi/test-workflow-smoke/...) which is not portable and will fail in CI/other environments.",
      "suggestion": "Vendor the reproduction plan content as a fixture inside this repo (or embed the relevant markdown as a test string) so tests are deterministic and self-contained."
    },
    {
      "severity": "low",
      "file": "docs/plans/2026-02-07-smoke-test-bugfixes-design.md",
      "issue": "Task list references planned test file names (e.g., task-parser.test.ts) that don’t correspond to the current module layout (parser is in src/workflow/state.ts).",
      "suggestion": "Update the plan to use test file paths that match project conventions (e.g., src/workflow/state.task-parser.test.ts or src/workflow/state.test.ts)."
    }
  ],
  "mustFix": [
    "Bug 4: verify actual cause of 'undefined' rendering and update fix + AT-6 accordingly",
    "Bug 2: address fenced-block truncation risk in extractFencedBlock and add acceptance coverage (``` inside JSON strings)",
    "AT-1: remove dependency on external absolute path by adding an in-repo fixture or embedded reproduction content"
  ],
  "summary": "Good overall structure and correct Bug 1/Bug 3 analyses, but the plan has two high-risk mismatches: (1) Bug 4’s stated root cause and acceptance test likely don’t match the observed symptom, and (2) Bug 2 likely also involves fenced-block truncation (``` inside JSON strings), which is currently unaddressed. Acceptance tests also need portability fixes (AT-1 fixture)."
}
```
