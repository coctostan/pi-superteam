# Prompt: Generate Implementation Plan

You are writing an implementation plan for a coding agent (pi-superteam). The plan must be concrete enough that a TDD-focused agent can execute each task independently.

## Context

Below are two documents:
1. **Design v3** — the approved design spec with root causes, fix approaches, algorithms, and acceptance tests for 4 bugs
2. **Design v3 Review** — confirms the design is ready for implementation

Read both fully before writing the plan.

---

<design-v3>
# Design v3: Smoke Test Bug Fixes

Addresses must-fix items from `2026-02-07-smoke-test-bugfixes-design-v2-review.md`.

## References

- `docs/plans/2026-02-07-smoke-test-bugfixes-design-v2.md` — previous design (superseded)
- `docs/plans/2026-02-07-smoke-test-bugfixes-design-v2-review.md` — review that drove this revision
- `docs/plans/2026-02-07-smoke-test-results.md` — smoke test report

---

## Changes from v2

| Area | v2 | v3 | Reason |
|---|---|---|---|
| Bug 2 fence extraction | Naive line-walker: stop at first `/^ {0,3}```\s*$/` | **Quote-aware line-walker**: track JSON string context, only accept closing fence when `!inString` | Review found inner ```` ``` ```` lines inside JSON strings (from Mode A literal newlines) can appear on standalone lines, tricking the naive matcher |
| Bug 2 extractor fallback | If quote-aware walker fails or finds no close, let fallback chain handle it | Same as v2, but Layer 3 fallback now runs `extractLastBraceBlock()` **on the fenced region** (not full output) first, then full output | Reduces risk of grabbing wrong JSON object from elsewhere in output |
| Bug 2 acceptance tests | AT-3 through AT-6 | **+AT-3b** (combined Mode A + Mode B: literal newlines AND inner code fences on standalone lines) | Review's must-fix item — the combined case was untested |
| Bugs 1, 3, 4 | (unchanged) | (unchanged) | Review passed these |

---

## Bug 1: 🔴 CRITICAL — superteam-tasks YAML parser drops tasks

**Unchanged from v2.** Review confirmed root cause, fix approach, and ATs are all correct.

### Affected code

`src/workflow/state.ts` — `parseTaskBlock()` and `parseYamlLikeTasks()`

### Root cause

Two compounding issues:

**Issue A — Fence regex truncation.** `parseTaskBlock()` uses:
```typescript
const fenceRegex = /```superteam-tasks\s*\n([\s\S]*?)```/;
```
The non-greedy `[\s\S]*?` stops at the first triple-backtick inside content (e.g., embedded ```` ```typescript ```` in a description). In the smoke test, Task 3 was never seen by the parser.

**Issue B — No multi-line description support.** `parseYamlLikeTasks()` only handles single-line `description:` values. YAML `description: |` block scalar syntax stores the literal character `"|"` and ignores continuation lines.

### Fix approach

1. **Replace fence regex with a line-walking extractor.** Find the opening ```` ```superteam-tasks ```` marker, then scan forward line-by-line for a closing fence matching `/^ {0,3}```\s*$/` (0–3 leading spaces, nothing else on the line). This is safe for Bug 1 because YAML block scalars indent inner fences by 4+ spaces, so they won't match the closing pattern.

2. **Extend `parseYamlLikeTasks()` for `description: |` block scalars.** When `description: |` is encountered, accumulate subsequent indented lines (leading whitespace > task-level indent) into the description until hitting the next task-level key (`- title:`, `files:`) or end-of-block.

### Files to change

- `src/workflow/state.ts` — `parseTaskBlock()`, `parseYamlLikeTasks()`

---

## Bug 2: 🟡 HIGH — Brainstorm JSON parse failures (60% rate)

### Affected code

- `src/workflow/brainstorm-parser.ts` — `extractFencedBlock()`, `parseAndValidate()`, `parseBrainstormOutput()`
- `agents/brainstormer.md` — agent system prompt
- `src/workflow/prompt-builder.ts` — brainstorm prompt functions

### Root cause

Two distinct failure modes:

**Mode A — Literal newlines in JSON strings.** The brainstormer produces JSON with literal `0x0a` newline characters inside string values (particularly long `content` fields). `JSON.parse()` throws "unterminated string" errors.

**Mode B — Fence regex truncation.** `extractFencedBlock()` uses the same non-greedy regex as Bug 1:
```typescript
const regex = /```superteam-brainstorm\s*\n([\s\S]*?)```/;
```
If a JSON string value contains ```` ``` ```` (code examples in design content), the regex truncates at the first inner fence.

**Combined Mode A+B.** When Mode A is active (literal newlines leak into the text stream), inner Markdown code fences that were originally *inside* JSON strings can appear as **standalone lines**:
```
```superteam-brainstorm
{
  "type": "design",
  "sections": [{
    "id": "s1",
    "title": "Architecture",
    "content": "Here is code:
```ts
console.log(1)
```
More text"
  }]
}
```

In this example, the ```` ``` ```` on its own line between `console.log(1)` and `More text"` looks exactly like a closing fence to a naive line-walker. A **quote-aware** extractor is required for Bug 2 (unlike Bug 1, where YAML indentation naturally protects inner fences).

### Fix approach — four layers

**Layer 1 — Quote-aware fenced block extraction (fixes Mode B + combined A+B).**

Replace `extractFencedBlock()` with a line-walking extractor that tracks JSON string context. Algorithm:

```
function extractFencedBlock(text):
  lines = text.split("\n")
  
  1. Find opening line matching /^\s{0,3}```superteam-brainstorm\s*$/
     Record startIndex = line after opening.
  
  2. Initialize state:
     inString = false
     escape = false
  
  3. For each line from startIndex onward:
     a. If !inString AND line matches /^ {0,3}```\s*$/:
        → This is the closing fence. Return lines[startIndex..here) joined.
     
     b. Process each character in the line to update inString/escape:
        - If escape: clear escape, continue
        - If char == '\\': set escape, continue
        - If char == '"': toggle inString
     
     c. After processing the line's characters, process the implicit newline:
        - If inString: the newline is a literal newline inside a JSON string
          (this is Mode A — the character is part of the string content)
          → inString remains true, escape remains false
        - If !inString: normal line boundary, no state change
  
  4. If no closing fence found: return null (let fallback handle it).
```

Key insight: the quote-aware walker treats each line's characters as a stream, and the inter-line boundary as a newline character in that stream. When `inString` is true at a potential closing fence line, that line is **inside a JSON string value** (from Mode A literal newlines) and must not be treated as the fence closer.

**Layer 2 — JSON newline sanitization (fixes Mode A).**

New `sanitizeJsonNewlines()` function in `brainstorm-parser.ts`. Called on the extracted content before `JSON.parse()`:

```
function sanitizeJsonNewlines(jsonStr):
  Walk character-by-character:
    Track inString (toggled by unescaped '"') and escape (set by '\\')
    When a literal '\n' (0x0a) is found while inString:
      Replace with the two-character sequence '\\n'
  Return sanitized string.
```

This is the same state-machine logic as the line-walker (Layer 1), but operating on the already-extracted block, replacing literal newlines with escape sequences so `JSON.parse()` succeeds.

**Layer 3 — Fallback chain in `parseBrainstormOutput()` (defense in depth).**

Current code only falls back to brace-matching when `extractFencedBlock()` returns `null`. The fix extends the fallback to handle the case where a fenced block is found but parse fails:

```
1. fenced = extractFencedBlock(rawOutput)
2. If fenced:
   a. sanitized = sanitizeJsonNewlines(fenced)
   b. result = parseAndValidate(sanitized, rawOutput)
   c. If result.status === "ok": return result
   d. // Fenced block found but parse failed — try brace-match on the fenced content
   e. braceFromFenced = extractLastBraceBlock(fenced)
   f. If braceFromFenced:
      sanitized2 = sanitizeJsonNewlines(braceFromFenced)
      result2 = parseAndValidate(sanitized2, rawOutput)
      if result2.status === "ok": return result2

3. // No fenced block, or all fenced attempts failed — try full output
4. braceFromFull = extractLastBraceBlock(rawOutput)
5. If braceFromFull:
   sanitized3 = sanitizeJsonNewlines(braceFromFull)
   result3 = parseAndValidate(sanitized3, rawOutput)
   if result3.status === "ok": return result3

6. Return error (no parse succeeded)
```

Note: step 2e tries `extractLastBraceBlock` on the *fenced region* first, before falling back to the full output in step 4. This reduces risk of accidentally grabbing a different JSON object from elsewhere in the brainstormer's prose output.

**Layer 4 — Prompt hardening (secondary).**

Add explicit instruction to `agents/brainstormer.md` and the brainstorm prompt functions in `prompt-builder.ts`:

> JSON strings must not contain literal newlines — use `\n` escape sequences. Ensure all code examples inside `content` fields use `\n` for line breaks, not actual newline characters.

This goes in:
- `agents/brainstormer.md` — under "## Response Format", add a "## JSON formatting rules" section
- `src/workflow/prompt-builder.ts` — append to `buildBrainstormQuestionsPrompt()`, `buildBrainstormApproachesPrompt()`, `buildBrainstormDesignPrompt()`, and `buildBrainstormSectionRevisionPrompt()`

### Files to change

- `src/workflow/brainstorm-parser.ts` — rewrite `extractFencedBlock()` (quote-aware line-walker), new `sanitizeJsonNewlines()`, updated `parseBrainstormOutput()` fallback chain
- `agents/brainstormer.md` — add JSON formatting instruction
- `src/workflow/prompt-builder.ts` — add newline warning to brainstorm prompt functions

---

## Bug 3: 🟡 MEDIUM — Status bar sub-step stuck on "scouting"

**Unchanged from v2.** Review confirmed root cause, fix approach, and ATs are correct.

### Affected code

`src/workflow/phases/brainstorm.ts` — `runBrainstormPhase()`

### Root cause

The brainstorm phase only calls `ui.setStatus()` once, at the start of the scout sub-step:
```typescript
ui?.setStatus?.("workflow", "⚡ Workflow: brainstorm (scouting...)");
```
No further `setStatus()` calls are made during questions, approaches, or design sub-steps.

### Fix approach

Add `ui.setStatus("workflow", formatStatus(state))` at the entry of each sub-step block in `runBrainstormPhase()`, **after** `state.brainstorm.step` is updated so `formatStatus()` renders the correct label.

Call sites (4 total — 1 updated, 3 new):
- Scout sub-step (update existing): `ui?.setStatus?.("workflow", formatStatus(state));`
- Questions sub-step (new): `ui?.setStatus?.("workflow", formatStatus(state));`
- Approaches sub-step (new): `ui?.setStatus?.("workflow", formatStatus(state));`
- Design sub-step (new): `ui?.setStatus?.("workflow", formatStatus(state));`

### Files to change

- `src/workflow/phases/brainstorm.ts` — add 3 `setStatus` calls, update 1 existing call, add `formatStatus` import from `../ui.js`

---

## Bug 4: 🟢 LOW — `undefined` in design section display

**Unchanged from v2.** Review confirmed v2's revised root cause is correct.

### Affected code

`src/workflow/phases/brainstorm.ts` — design section confirmation dialogs (lines ~156, ~179)

### Root cause

The pi extension API signature is `confirm(title: string, message: string, opts?)` but the code calls it with a **single** combined argument:
```typescript
await ui?.confirm?.(`## ${section.title}\n\n${section.content}`);
```
This passes the formatted string as `title` and leaves `message` as `undefined`, which the UI renders as the literal string `"undefined"`.

### Fix approach

Split into proper two-argument calls at both call sites:
```typescript
await ui?.confirm?.(
  section.title || "(untitled)",
  section.content || "(no content)",
);
```

### Files to change

- `src/workflow/phases/brainstorm.ts` — 2 `ui.confirm()` call sites

---

## Acceptance Tests

All tests use vitest. Fixtures are vendored into the repo. Test files follow existing conventions.

### AT-1: Full plan file parses all tasks (Bug 1)

**Scenario:** The actual smoke test plan file is fed to `parseTaskBlock()`.

**Setup:** Vendor the reproduction plan content from `/home/pi/test-workflow-smoke/docs/plans/2026-02-07-add-a-get-health-endpoint-that-returns-s-plan.md` into `src/workflow/__fixtures__/smoke-test-plan.md`.

**Given** the fixture plan file content
**When** `parseTaskBlock(fixtureContent)` is called
**Then** it returns exactly 3 tasks:
  - Task 1: title contains "test dependencies", files includes `package.json`
  - Task 2: title contains "Extract app module" or "TDD red", description contains "Split src/index.ts" or code content (not `"|"`), files includes `src/app.ts`
  - Task 3: title contains "/health" or "TDD green", description contains "GET /health", files includes `src/app.ts`

**Test file:** `src/workflow/state.acceptance.test.ts`

### AT-2: Embedded code fences don't break task extraction (Bug 1)

**Scenario:** A synthetic plan with tasks whose descriptions contain ```` ```typescript ```` code blocks inside `description: |` block scalars.

**Given** a `superteam-tasks` block with 2 tasks, both containing embedded ```` ```typescript ```` fences indented inside their descriptions
**When** `parseTaskBlock(content)` is called
**Then** it returns exactly 2 tasks
**And** each task's `description` contains the code from inside the embedded fences
**And** each task's `files` array is populated correctly

**Test file:** `src/workflow/state.acceptance.test.ts`

### AT-3: Brainstormer JSON with literal newlines parses successfully (Bug 2, Mode A)

**Scenario:** A brainstormer returns a `superteam-brainstorm` block where the JSON has literal `\n` characters inside string values.

**Given** raw brainstormer output containing a `superteam-brainstorm` fenced block with literal newlines (`0x0a`) inside JSON string values
**When** `parseBrainstormOutput(raw)` is called
**Then** result.status is `"ok"`
**And** result.data.type is `"design"`
**And** result.data.sections[0].content contains all the line content (not truncated)

**Test file:** `src/workflow/brainstorm-parser.acceptance.test.ts`

### AT-3b: Brainstormer JSON with literal newlines AND inner code fences on standalone lines (Bug 2, combined Mode A+B)

**Scenario:** The brainstormer returns a `superteam-brainstorm` block where literal newlines inside a JSON `content` string cause inner Markdown code fences to appear on their own lines — lines that look exactly like closing fences.

**Given** raw output shaped like:
```
Here is some brainstorm prose.

```superteam-brainstorm
{
  "type": "design",
  "sections": [{
    "id": "s1",
    "title": "Code Example",
    "content": "Here is how to do it:
```typescript
function hello() {
  return 'world';
}
```
And then you wire it up."
  }]
}
```
```
(Where `\n` after "do it:", between the inner code lines, and after the inner closing ```` ``` ```` are all literal `0x0a` characters inside the JSON string value — NOT properly escaped `\\n`.)

**When** `parseBrainstormOutput(raw)` is called
**Then** result.status is `"ok"`
**And** result.data.type is `"design"`
**And** result.data.sections has length 1
**And** result.data.sections[0].content contains the text "function hello()" (not truncated at the inner fence)
**And** result.data.sections[0].content contains the text "wire it up" (content after the inner fence is preserved)

**Test file:** `src/workflow/brainstorm-parser.acceptance.test.ts`

### AT-4: Brainstormer JSON with embedded code fences in properly escaped strings (Bug 2, Mode B only)

**Scenario:** A brainstormer returns properly escaped JSON, but string values contain ```` ``` ```` sequences. The old regex would truncate; the new extractor should not.

**Given** raw output with a `superteam-brainstorm` fenced block where sections[0].content includes ```` ```typescript\nconsole.log('hello')\n``` ```` as a properly escaped JSON string (using `\\n`)
**When** `parseBrainstormOutput(raw)` is called
**Then** result.status is `"ok"`
**And** result.data.sections has the correct number of sections
**And** section content includes the code example text (not truncated)

**Test file:** `src/workflow/brainstorm-parser.acceptance.test.ts`

### AT-5: Fallback to brace-matching when fenced parse fails (Bug 2, fallback chain)

**Scenario:** A fenced block is found but its JSON is malformed in a way sanitization can't fix. The parser falls back to brace-matching.

**Given** raw output with a corrupted `superteam-brainstorm` fenced block AND a valid bare JSON object later in the output
**When** `parseBrainstormOutput(raw)` is called
**Then** result.status is `"ok"` (recovered via brace-match fallback)

**Test file:** `src/workflow/brainstorm-parser.acceptance.test.ts`

### AT-6: Bare JSON fallback with literal newlines also works (Bug 2)

**Scenario:** No fenced block present — raw JSON in the output with literal newlines inside strings.

**Given** raw output with a bare JSON object containing literal newlines inside strings (no fenced block)
**When** `parseBrainstormOutput(raw)` is called
**Then** result.status is `"ok"` and sections are correctly extracted

**Test file:** `src/workflow/brainstorm-parser.acceptance.test.ts`

### AT-7: Status bar updates during each brainstorm sub-step (Bug 3)

**Scenario:** A full brainstorm phase runs through all sub-steps. The status bar should reflect each one.

**Given** a brainstorm phase starting from step `"scout"`
**When** `runBrainstormPhase()` runs through scout → questions → approaches → design
**Then** `ui.setStatus` is called with a string containing `"scout"` (during the scout sub-step)
**And** called with a string containing `"questions"` (during the questions sub-step)
**And** called with a string containing `"approaches"` (during the approaches sub-step)
**And** called with a string containing `"design"` (during the design sub-step)

**Test file:** `src/workflow/phases/brainstorm.acceptance.test.ts`

### AT-8: Design section confirm() passes correct (title, body) arguments (Bug 4)

**Scenario:** The brainstormer returns design sections. The confirmation dialog must call `ui.confirm(title, body)` with two arguments.

**Given** a brainstorm phase in the `"design"` step
**And** the brainstormer returns sections with valid title and content
**When** `runBrainstormPhase()` presents them via `ui.confirm()`
**Then** `ui.confirm` is called with exactly 2 arguments (or 2+ if opts is passed)
**And** the first argument (title) is a non-empty string (section title or fallback)
**And** the second argument (body) is a string (never `undefined`)

**Test file:** `src/workflow/phases/brainstorm.acceptance.test.ts`

### AT-9: Design sections with missing fields don't show "undefined" (Bug 4)

**Scenario:** The brainstormer returns design sections where `title` or `content` are empty strings.

**Given** a brainstorm phase in the `"design"` step
**When** the brainstormer returns sections where title and content are `""`
**And** `runBrainstormPhase()` presents them via `ui.confirm()`
**Then** the first argument to `ui.confirm()` is `"(untitled)"` (fallback)
**And** the second argument is `"(no content)"` (fallback)
**And** neither argument contains the literal text `"undefined"`

**Test file:** `src/workflow/phases/brainstorm.acceptance.test.ts`

### AT-10: End-to-end plan-write phase gets all tasks from a complex plan (Bugs 1+2 integration)

**Scenario:** The plan-write phase dispatches a planner that writes a plan with multi-line descriptions and embedded code fences. The phase parses all tasks.

**Given** a plan-write phase where the planner writes a plan with 3 tasks (matching the smoke test plan format)
**When** `runPlanWritePhase()` completes
**Then** `state.tasks` has length 3
**And** `state.phase` is `"plan-review"`
**And** `ui.notify` is called with a message containing `"3 tasks"`

**Test file:** `src/workflow/phases/plan-write.acceptance.test.ts`

---

## Execution Order

1. **Bug 1** (CRITICAL) — task parser fence extraction + multi-line descriptions
2. **Bug 2** (HIGH) — brainstorm parser: quote-aware extraction + sanitization + fallback chain + prompt hardening
3. **Bug 3** (MEDIUM) — brainstorm status bar updates
4. **Bug 4** (LOW) — confirm() call signature fix

Each bug: write acceptance tests → implement fix → verify all tests pass.

After all 4: deploy to installed copy with:
```bash
rm -rf /home/pi/.npm-global/lib/node_modules/pi-superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/
cp -r ~/superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/src/
cp -r ~/superteam/agents/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/
```

---

## Summary of all changes (files)

| File | Bug(s) | What changes |
|---|---|---|
| `src/workflow/state.ts` | 1 | Rewrite `parseTaskBlock()` as line-walker; extend `parseYamlLikeTasks()` for `description: \|` block scalars |
| `src/workflow/brainstorm-parser.ts` | 2 | Rewrite `extractFencedBlock()` as quote-aware line-walker; new `sanitizeJsonNewlines()`; updated `parseBrainstormOutput()` fallback chain |
| `src/workflow/phases/brainstorm.ts` | 3, 4 | Add 3 `setStatus` calls + update 1; fix 2 `ui.confirm()` call sites to pass `(title, body)` |
| `agents/brainstormer.md` | 2 | Add JSON formatting rule (no literal newlines in strings) |
| `src/workflow/prompt-builder.ts` | 2 | Append newline escape warning to 4 brainstorm prompt functions |
| `src/workflow/__fixtures__/smoke-test-plan.md` | 1 (test) | Vendored smoke test plan fixture |
| `src/workflow/state.acceptance.test.ts` | 1 (test) | AT-1, AT-2 |
| `src/workflow/brainstorm-parser.acceptance.test.ts` | 2 (test) | AT-3, AT-3b, AT-4, AT-5, AT-6 |
| `src/workflow/phases/brainstorm.acceptance.test.ts` | 3, 4 (test) | AT-7, AT-8, AT-9 |
| `src/workflow/phases/plan-write.acceptance.test.ts` | 1+2 (test) | AT-10 |
</design-v3>

<design-v3-review>
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
</design-v3-review>

---

## Your Task

Write an implementation plan with a `superteam-tasks` block. Follow these rules:

### Plan structure
1. **Goal** — one sentence: fix the 4 smoke test bugs
2. **Constraints** — list: vitest for tests, no new dependencies, fixtures vendored in-repo, deploy via copy to installed path
3. **Per-task sections** — for each task: what to do, which acceptance tests to write, key implementation details, verification command
4. **`superteam-tasks` block** — machine-parseable task list at the end

### Task ordering (from the design's execution order)
1. Bug 1 fixes (state.ts parser)
2. Bug 2 fixes (brainstorm-parser.ts — quote-aware extractor, sanitizer, fallback chain, prompt hardening)
3. Bug 3 fix (brainstorm.ts status calls)
4. Bug 4 fix (brainstorm.ts confirm arity)
5. Final integration verification

### Task sizing
- Each task should touch 1-3 files max
- Bug 2 is the largest — split it into 2-3 subtasks (extraction/sanitization, fallback chain, prompt hardening)
- Bugs 3+4 can be combined into one task (same file, simple changes)
- Include a final task that runs all acceptance tests and deploys

### What to include in each task description
- The exact function names and file paths being changed
- The algorithm or logic to implement (from the design — don't just say "implement the fix")
- Which acceptance tests (AT-N) to write first (TDD: tests before implementation)
- The vitest command to verify: `npx vitest run <test-file> --reporter=verbose`

### What NOT to do
- Don't repeat the full design spec — reference it, extract the key details
- Don't invent new approaches — use exactly what the design specifies
- Don't skip the `superteam-tasks` block — it's required for automation
- Don't use `description: |` with multi-line YAML (ironic given Bug 1 — keep descriptions as single lines or short paragraphs)

Write the plan now.
