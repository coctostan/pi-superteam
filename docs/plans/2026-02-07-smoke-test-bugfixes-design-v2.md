# Design v2: Smoke Test Bug Fixes

Revised design addressing findings from `2026-02-07-smoke-test-bugfixes-plan-review.md`.

## References

- `docs/plans/2026-02-07-smoke-test-bugfixes-design.md` — original design (superseded)
- `docs/plans/2026-02-07-smoke-test-bugfixes-plan-review.md` — review findings
- `docs/plans/2026-02-07-smoke-test-results.md` — full smoke test report
- `/home/pi/test-workflow-smoke/docs/plans/2026-02-07-add-a-get-health-endpoint-that-returns-s-plan.md` — reproduction case for Bug 1 (to be vendored as fixture)

---

## Bug 1: 🔴 CRITICAL — superteam-tasks YAML parser drops tasks

### Affected code

`src/workflow/state.ts` — `parseTaskBlock()` and `parseYamlLikeTasks()`

### Root cause

Two compounding issues (unchanged from v1, both confirmed correct):

**Issue A — Fence regex truncation.** `parseTaskBlock()` uses:
```typescript
const fenceRegex = /```superteam-tasks\s*\n([\s\S]*?)```/;
```
The non-greedy `[\s\S]*?` stops at the **first** triple-backtick anywhere in the content. When a task's description contains embedded code fences (e.g. `` ```typescript ``), the regex terminates early. In the smoke test, Task 3 was never seen by the parser.

**Issue B — No multi-line description support.** `parseYamlLikeTasks()` only handles single-line `description:` values. YAML `description: |` block scalar syntax stores the literal character `"|"` and ignores all continuation lines.

### Fix approach

1. **Replace the fence regex with a line-walking extractor.** Find the opening `` ```superteam-tasks `` marker, then scan forward for a closing fence. The closing fence must:
   - Be on its own line
   - Have 0–3 leading spaces (per CommonMark spec — valid Markdown closing fences can be indented up to 3 spaces)
   - Consist of `` ``` `` followed only by optional whitespace
   - **Not** match fences indented 4+ spaces (these are inside YAML block scalars)

   Pattern for closing fence line: `/^ {0,3}```\s*$/`

2. **Extend `parseYamlLikeTasks()` for `description: |` block scalars.** When `description: |` is encountered, accumulate subsequent indented lines into the description until hitting the next task-level key (`- title:`, `files:`) or end-of-block.

### Files to change

- `src/workflow/state.ts` — `parseTaskBlock()`, `parseYamlLikeTasks()`

---

## Bug 2: 🟡 HIGH — Brainstorm JSON parse failures (60% rate)

### Affected code

- `src/workflow/brainstorm-parser.ts` — `extractFencedBlock()`, `parseAndValidate()`, `parseBrainstormOutput()`
- `agents/brainstormer.md` — agent system prompt
- `src/workflow/prompt-builder.ts` — brainstorm prompt functions

### Root cause

**Two distinct failure modes** (v1 only identified one):

**Mode A — Literal newlines in JSON strings.** The brainstormer produces JSON with literal `0x0a` newline characters inside string values (particularly long `content` fields). `JSON.parse()` throws "unterminated string" errors. This was the directly observed symptom (3 of 5 dispatches failed).

**Mode B — Fence regex truncation (same bug class as Bug 1).** `extractFencedBlock()` uses the identical non-greedy regex pattern:
```typescript
const regex = /```superteam-brainstorm\s*\n([\s\S]*?)```/;
```
If a brainstorm JSON string value contains `` ``` `` (common when design `content` sections include Markdown code examples), this regex truncates the JSON at the first inner fence, producing partial/invalid JSON. The "unterminated string" error from the smoke test is consistent with **both** failure modes — so Mode B may have been a contributing cause, not just Mode A.

### Fix approach — three layers

**Layer 1 — Robust fence extraction (fixes Mode B).** Replace the non-greedy regex in `extractFencedBlock()` with a line-walking approach identical to Bug 1's fix. Find the opening `` ```superteam-brainstorm `` marker, scan forward for a closing fence matching `/^ {0,3}```\s*$/` (0–3 leading spaces, nothing else). Inner fences in JSON string values won't match because they are embedded in longer lines (not on a line by themselves).

**Layer 2 — JSON newline sanitization (fixes Mode A).** In `parseAndValidate()`, before calling `JSON.parse()`, sanitize the JSON string by replacing literal newlines inside string values with `\\n` escape sequences. Implementation: character-by-character scan tracking `"` boundaries with backslash-escape awareness, replacing `\n` characters found inside strings.

**Layer 3 — Fallback chain in `parseBrainstormOutput()`.** Currently, the brace-match fallback only runs when `extractFencedBlock()` returns `null` (no fenced block found). The fix extends the fallback: if a fenced block **is found** but `parseAndValidate()` fails on it, try `extractLastBraceBlock(rawOutput)` as a recovery path before returning an error. Updated flow:

```
1. Try extractFencedBlock() → if found, parseAndValidate()
2. If step 1 parse fails OR no fenced block: try extractLastBraceBlock() → parseAndValidate()
3. If both fail: return error
```

**Layer 4 — Prompt hardening (secondary).** Add explicit instruction to `agents/brainstormer.md` and the brainstorm prompt builders in `prompt-builder.ts`: "JSON strings must not contain literal newlines — use \\n escape sequences instead."

### Files to change

- `src/workflow/brainstorm-parser.ts` — `extractFencedBlock()` (line-walker), new `sanitizeJsonNewlines()`, updated `parseBrainstormOutput()` fallback chain
- `agents/brainstormer.md` — add JSON formatting instruction
- `src/workflow/prompt-builder.ts` — add newline warning to brainstorm prompt functions

---

## Bug 3: 🟡 MEDIUM — Status bar sub-step stuck on "scouting"

### Affected code

`src/workflow/phases/brainstorm.ts` — `runBrainstormPhase()`

### Root cause (unchanged from v1, confirmed correct)

The brainstorm phase only calls `ui.setStatus()` once, at the start of the scout sub-step (line 42):
```typescript
ui?.setStatus?.("workflow", "⚡ Workflow: brainstorm (scouting...)");
```
When the phase advances to `questions`, `approaches`, and `design` sub-steps, no further `setStatus()` calls are made. The `formatStatus()` helper in `ui.ts` works correctly — it reads `state.brainstorm.step` — but nobody calls it during the later sub-steps.

### Fix approach

Add `ui.setStatus()` calls at the entry of each sub-step block in `runBrainstormPhase()`. Use `formatStatus(state)` for consistency with the rest of the workflow (the orchestrator loop at `orchestrator.ts:36` already uses `formatStatus(state)` — the brainstorm phase should too).

Each call should happen **after** `state.brainstorm.step` is updated so `formatStatus()` renders the correct sub-step label. For the scout step, the existing `setStatus` call should also be updated to use `formatStatus(state)`.

Call sites:
- Scout sub-step (existing, update): `ui?.setStatus?.("workflow", formatStatus(state));`
- Questions sub-step (new): `ui?.setStatus?.("workflow", formatStatus(state));`
- Approaches sub-step (new): `ui?.setStatus?.("workflow", formatStatus(state));`
- Design sub-step (new): `ui?.setStatus?.("workflow", formatStatus(state));`

### Files to change

- `src/workflow/phases/brainstorm.ts` — add 3 `setStatus` calls, update 1 existing call, add `formatStatus` import

---

## Bug 4: 🟢 LOW — `undefined` in design section display

### Affected code

`src/workflow/phases/brainstorm.ts` — design section confirmation dialogs (lines 156, 179)

### Root cause (**REVISED from v1 — v1 was incorrect**)

The v1 design attributed this to template literal interpolation of `undefined` fields. However, `validateDesign()` in `brainstorm-parser.ts` already forces `title` and `content` to `""` if they aren't strings:
```typescript
title: typeof s.title === "string" ? s.title : "",
content: typeof s.content === "string" ? s.content : "",
```
So template interpolation would produce `""`, not `"undefined"`.

**The actual cause** is a `ui.confirm()` call signature mismatch. The pi extension API signature is:
```typescript
confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
```
But the code calls it with a **single** combined argument:
```typescript
await ui?.confirm?.(`## ${section.title}\n\n${section.content}`);
```
This passes the entire formatted string as `title` and leaves `message` as `undefined`. The UI layer then renders the `undefined` message parameter as the literal string `"undefined"` at the end of the dialog content.

This explains the smoke test observation: *"`undefined` displayed at the end of design section content"*.

### Fix approach

Split the single-argument `confirm()` calls into proper two-argument calls matching the API signature:
```typescript
await ui?.confirm?.(
  section.title || "(untitled)",
  section.content || "(no content)",
);
```

Apply to both call sites:
1. Line 156 — initial section confirmation
2. Line 179 — post-revision section confirmation

### Files to change

- `src/workflow/phases/brainstorm.ts` — 2 `ui.confirm()` call sites in the design section loop

---

## Acceptance Tests

All tests use vitest. Fixtures are vendored into the repo (no external paths). Test files follow existing project conventions (co-located `.test.ts` files or new `.acceptance.test.ts` files alongside the module).

### AT-1: Full plan file parses all tasks (Bug 1)

**Scenario:** The actual smoke test plan file is fed to `parseTaskBlock()`.

**Setup:** Copy the reproduction plan content from `/home/pi/test-workflow-smoke/docs/plans/2026-02-07-add-a-get-health-endpoint-that-returns-s-plan.md` into an in-repo fixture at `src/workflow/__fixtures__/smoke-test-plan.md`.

**Given** the fixture plan file content
**When** `parseTaskBlock(fixtureContent)` is called
**Then** it returns exactly 3 tasks:
  - Task 1: title contains "test dependencies", files includes `package.json`
  - Task 2: title contains "Extract app module" or "TDD red", description contains "Split src/index.ts" or code content (not `"|"`), files includes `src/app.ts`
  - Task 3: title contains "/health" or "TDD green", description contains "GET /health", files includes `src/app.ts`

**Test file:** `src/workflow/state.acceptance.test.ts`

### AT-2: Embedded code fences don't break task extraction (Bug 1)

**Scenario:** A synthetic plan with tasks whose descriptions contain `` ```typescript `` code blocks inside `description: |` block scalars.

**Given** a `superteam-tasks` block with 2 tasks, both containing embedded `` ```typescript `` fences indented inside their descriptions
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

### AT-4: Brainstormer JSON with embedded code fences parses successfully (Bug 2, Mode B)

**Scenario:** A brainstormer returns a `superteam-brainstorm` block where a JSON string value contains `` ``` `` sequences (code fence markers inside design content).

**Given** raw brainstormer output containing a `superteam-brainstorm` fenced block where `sections[0].content` includes `` ```typescript\nconsole.log('hello')\n``` `` as part of the string value
**When** `parseBrainstormOutput(raw)` is called
**Then** result.status is `"ok"`
**And** result.data.sections has the correct number of sections
**And** section content is not truncated at the inner `` ``` ``

**Test file:** `src/workflow/brainstorm-parser.acceptance.test.ts`

### AT-5: Fallback to brace-matching when fenced parse fails (Bug 2, fallback chain)

**Scenario:** A fenced block is found but its JSON is malformed in a way sanitization can't fix. The parser falls back to brace-matching on the full output.

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

**Scenario:** The brainstormer returns design sections. The confirmation dialog must call `ui.confirm(title, body)` with two arguments — never passing `undefined` for either.

**Given** a brainstorm phase in the `"design"` step
**And** the brainstormer returns sections with valid title and content
**When** `runBrainstormPhase()` presents them via `ui.confirm()`
**Then** `ui.confirm` is called with exactly 2 arguments (or 2+ if opts is passed)
**And** the first argument (title) is a non-empty string (section title or fallback)
**And** the second argument (body) is a string (never `undefined`)

**Test file:** `src/workflow/phases/brainstorm.acceptance.test.ts`

### AT-9: Design sections with missing fields don't show "undefined" (Bug 4)

**Scenario:** The brainstormer returns design sections where `title` or `content` are empty strings (as defaulted by `validateDesign()`).

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
2. **Bug 2** (HIGH) — brainstorm parser fence extraction + JSON sanitization + fallback chain + prompt hardening
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

## Change summary from v1

| Area | v1 | v2 | Reason |
|---|---|---|---|
| Bug 1 fence detection | Column 0 only | 0–3 leading spaces | CommonMark allows up to 3-space indent on closing fences |
| Bug 2 scope | JSON newline sanitization only | + fence extraction fix + fallback chain | `extractFencedBlock()` has the same non-greedy regex bug as Bug 1; fallback chain needed when fenced parse fails |
| Bug 2 acceptance tests | AT-3, AT-4 only | + AT-4 (fence truncation), AT-5 (fallback chain) | Missing coverage for the `` ``` ``-inside-JSON failure mode |
| Bug 3 status strings | Hardcoded strings | `formatStatus(state)` | Consistent with orchestrator loop pattern |
| Bug 4 root cause | Template interpolation of undefined fields | `ui.confirm()` called with 1 arg instead of 2 | `validateDesign()` already defaults to `""`. Actual API: `confirm(title, message)` — missing `message` arg renders as `"undefined"` |
| Bug 4 fix | Null-coalescing in template literal | Split into `confirm(title, body)` with fallbacks | Must match the actual 2-argument API signature |
| Bug 4 acceptance test | Substring check for "undefined" | Assert correct argument count and structure | Substring check wouldn't catch the missing-second-arg bug |
| AT-1 fixture | External absolute path | Vendored in-repo at `src/workflow/__fixtures__/` | Portability — absolute path fails in CI/other environments |
| Test file paths | `task-parser.acceptance.test.ts` (non-existent module) | `state.acceptance.test.ts` (matches source module) | Parser lives in `state.ts`, not `task-parser.ts` |
