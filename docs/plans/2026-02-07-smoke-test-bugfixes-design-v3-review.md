# Review: Smoke Test Bugfixes Design v3

Date: 2026-02-07

Reviewed:
- Design v3: `docs/plans/2026-02-07-smoke-test-bugfixes-design-v3.md`
- v2 review: `docs/plans/2026-02-07-smoke-test-bugfixes-design-v2-review.md`
- Current source:
  - `src/workflow/brainstorm-parser.ts`
  - `src/workflow/state.ts`
  - `src/workflow/phases/brainstorm.ts`
  - `src/workflow/ui.ts`
  - `src/workflow/prompt-builder.ts`
  - `agents/brainstormer.md`
- pi UI API types:
  - `/home/pi/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`

Scope: verify that v3 resolves the v2-review must-fix items, that the quote-aware extractor algorithm is correct for the combined Mode A+B edge case, that AT-3b’s fixture actually exercises the claimed edge case, and that v3 introduces no regressions in Bugs 1/3/4.

---

## (1) v2 review must-fix items — resolved?

### Must-fix #1 (v2): Harden Bug 2 fenced extractor so inner code fences can’t close the outer block
**PASS (in v3 design).**

- v2 review required making brainstorm fenced extraction robust against inner standalone ``` lines when the JSON is already in the “literal newline inside strings” failure mode.
- v3 explicitly replaces the naive regex/naive line-walker approach with a **quote-aware line-walker** (track `inString`/`escape`, only accept closing fence when `!inString`).

### Must-fix #2 (v2): Add combined-case test coverage (Mode A + Mode B)
**PASS (in v3 design).**

- v3 adds **AT-3b** specifically described as “combined Mode A + Mode B: literal newlines AND inner code fences on standalone lines”.

---

## (2) Quote-aware line-walker correctness for combined Mode A+B
**PASS (algorithm is correct for the intended edge case).**

### Why the combined case breaks naive extractors
In the combined Mode A+B scenario, the model emits **invalid JSON** where a JSON string contains literal newline characters. That makes the string span multiple physical lines in the transcript. If the string’s content includes Markdown code fences, then the inner fence lines (including a standalone closing line like ```` ``` ````) appear in the transcript exactly like a potential outer closing fence.

A naive scanner that stops at the first line matching `^ {0,3}```\s*$` will therefore truncate the fenced region early.

### Why v3’s approach works
The v3 extractor only accepts a closing fence line when **not currently inside a JSON string**:
- When a literal newline occurs inside a string (Mode A), `inString` remains `true` across line boundaries.
- Therefore, inner standalone ``` lines that are part of the string’s content are ignored.
- Once the parser encounters the terminating `"` of that JSON string, `inString` flips to `false`.
- The true outer closing fence (after the JSON object ends) is then detected correctly.

### Notes / non-goals (not required by the v2 must-fix, but worth tracking)
- **CRLF:** If raw output uses `\r\n`, then the character-walker should ensure `\r` inside strings is handled (JSON also forbids literal `\r`). v3 mentions newline sanitization for `\n` but doesn’t mention `\r`. Likely fine in practice (LLM outputs are typically `\n`), but consider adding a test later.
- **Other invalid JSON:** If the content contains unescaped `"` inside a string, neither quote-awareness nor newline sanitization can reliably recover. That’s outside Bug 2’s defined scope.

---

## (3) AT-3b fixture exercises the claimed combined edge case?
**PASS (the fixture as specified actually hits the edge case).**

AT-3b’s raw output example contains:
- An outer fenced block ` ```superteam-brainstorm ... ``` `.
- A JSON `content` field whose string literal includes **literal newline characters** (Mode A).
- Inside that multi-line string, it includes an inner Markdown code block with standalone fence lines:
  - ` ```typescript `
  - and crucially a standalone closing line ` ``` `

That standalone closing ``` line appears at ≤3 leading spaces in the fixture example, so it will match the naive closing-fence regex and would truncate the fenced extraction.

The AT-3b assertions (“contains `function hello()`” and contains text after the inner fence like “wire it up”) correctly detect the truncation bug.

**One practical detail to preserve in the real test implementation:** do not indent the inner fence lines by 4+ spaces, otherwise a `/^ {0,3}```/` matcher would not match and the test would fail to reproduce the bug.

---

## (4) No regressions in Bugs 1/3/4
**PASS (v3 changes are localized to Bug 2; Bug 1/3/4 analysis remains consistent with source + API types).**

### Bug 1 (task parsing) — unchanged in v3 design
- Current source still uses a non-greedy fence regex in `src/workflow/state.ts` (`parseTaskBlock()`), and `parseYamlLikeTasks()` still treats `description:` as single-line (so `description: |` becomes literal `|`).
- v3’s Bug 1 section remains the same as v2 and continues to match current source; no new risk introduced by v3’s Bug 2 refinements.

### Bug 3 (status bar stuck on scouting) — unchanged in v3 design
- Current `src/workflow/phases/brainstorm.ts` still only calls `ui.setStatus()` once (hardcoded “scouting…”), consistent with the v2/v3 root cause.
- v3’s planned fix (call `formatStatus(state)` after updating `state.brainstorm.step`) remains correct and consistent with `src/workflow/ui.ts`.

### Bug 4 ("undefined" in confirm dialog) — unchanged in v3 design
- Current code calls `ui.confirm()` with **one** argument at both design-section call sites.
- pi UI signature (types file) is `confirm(title: string, message: string, opts?): Promise<boolean>`.
- v3’s fix to pass `(title, body)` is consistent with the API and does not introduce new issues.

---

## Conclusion
v3 fully addresses the two must-fix items from the v2 review, proposes a correct quote-aware extraction approach for the combined Mode A+B edge case, and adds an AT-3b combined-case fixture that (as specified) genuinely exercises the problematic scenario. No regressions were introduced for Bugs 1/3/4.
