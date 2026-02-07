# Implementation Plan: Smoke Test Bug Fixes (Design v3)

## Goal
Fix the 4 smoke test bugs (task YAML parser, brainstorm JSON parsing, brainstorm status bar updates, and brainstorm confirm dialog rendering).

## Constraints
- Use **vitest** for all tests.
- **No new dependencies**.
- Test fixtures must be **vendored into the repo** (e.g., under `src/workflow/__fixtures__/`).
- Follow **TDD**: write acceptance tests first, then implement.
- Deploy by copying updated `src/` and `agents/` into the installed module path:
  ```bash
  rm -rf /home/pi/.npm-global/lib/node_modules/pi-superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/
  cp -r ~/superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/src/
  cp -r ~/superteam/agents/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/
  ```

## Tasks (implementation details + verification)

### Task 1 — Bug 1 tests + fixture: task parser must not drop tasks
**What to do**
- Vendor the real smoke test plan content into `src/workflow/__fixtures__/smoke-test-plan.md` (copy from `/home/pi/test-workflow-smoke/docs/plans/2026-02-07-add-a-get-health-endpoint-that-returns-s-plan.md`).
- Add acceptance tests in `src/workflow/state.acceptance.test.ts`.

**Acceptance tests to write first**
- **AT-1**: `parseTaskBlock(fixtureContent)` returns exactly 3 tasks with expected title/description/files signals.
- **AT-2**: A synthetic ` ```superteam-tasks ` block containing **embedded code fences** inside `description: |` block scalars still yields all tasks and preserves code text.

**Key details to encode in tests**
- Ensure AT-2 includes inner fences like ```` ```typescript ```` inside descriptions so the old non-greedy regex would truncate.
- Assert that descriptions are real multi-line content (not the literal string `"|"`).

**Verify**
- `npx vitest run src/workflow/state.acceptance.test.ts --reporter=verbose`

---

### Task 2 — Bug 1 implementation: fix `parseTaskBlock()` + support `description: |`
**What to do**
- Update `src/workflow/state.ts`:
  - Rewrite **`parseTaskBlock()`** to use a **line-walking extractor** (no non-greedy fence regex).
  - Extend **`parseYamlLikeTasks()`** to support YAML-like `description: |` block scalar parsing.

**Implementation requirements (from Design v3)**
1. **Fence extraction via line-walker (Bug 1 safe variant)**
   - Find the opening fence line matching: `^\s{0,3}```superteam-tasks\s*$`.
   - Starting on the next line, scan forward line-by-line until a closing fence line matching: `^ {0,3}```\s*$`.
   - Return the lines between open/close as the block content.
   - Rationale: in task blocks, embedded fences in block scalars are indented (4+ spaces) and will not match the closing-fence pattern.

2. **`description: |` support in `parseYamlLikeTasks()`**
   - When encountering `description: |` at the task key indent:
     - Accumulate subsequent lines with indentation **greater than** the task key indent as part of the description.
     - Stop when reaching the next task-level key (e.g., `- title:`, `files:`) or end-of-block.
     - Join accumulated lines with `\n` and trim only the trailing newline (preserve internal newlines).

**Verify**
- `npx vitest run src/workflow/state.acceptance.test.ts --reporter=verbose`

---

### Task 3 — Bug 2 tests: brainstorm output parsing must tolerate newlines + inner fences
**What to do**
- Add acceptance tests in `src/workflow/brainstorm-parser.acceptance.test.ts` for the brainstorm parser.

**Acceptance tests to write first**
- **AT-3**: Fenced JSON where string values contain **literal newline characters** (0x0a) parses successfully.
- **AT-3b**: Combined case: literal newlines inside JSON strings cause inner Markdown fences to appear as standalone lines (must not truncate at inner ``` lines).
- **AT-4**: Properly escaped JSON strings containing ``` sequences do not truncate extraction.
- **AT-5**: If fenced JSON parse fails, parser falls back to brace-matching and recovers from a later valid JSON object.
- **AT-6**: No fenced block present: bare JSON with literal newlines inside strings still parses via brace-matching + sanitization.

**Key fixture detail (critical for AT-3b)**
- Do **not** indent the inner fence lines by 4+ spaces; keep them at ≤3 leading spaces so a naive `^ {0,3}```\s*$` matcher would incorrectly treat them as a closing fence.

**Verify**
- `npx vitest run src/workflow/brainstorm-parser.acceptance.test.ts --reporter=verbose`

---

### Task 4 — Bug 2 implementation (Layer 1+2): quote-aware fenced extraction + newline sanitization
**What to do**
- Update `src/workflow/brainstorm-parser.ts`:
  - Replace **`extractFencedBlock()`** with a **quote-aware line-walking extractor**.
  - Add **`sanitizeJsonNewlines()`** and run it on extracted content before calling `JSON.parse()`.

**Implementation requirements (from Design v3)**
1. **Quote-aware fenced extractor**
   - Split text into lines.
   - Find opening line: `^\s{0,3}```superteam-brainstorm\s*$`.
   - Walk forward line-by-line, maintaining `inString` and `escape` state while scanning characters.
   - Only accept a closing fence line `^ {0,3}```\s*$` when `inString === false`.
   - Update `inString/escape` by scanning each character:
     - if `escape` is true: clear it and continue
     - if char is `\\`: set `escape = true`
     - if char is `"`: toggle `inString`
   - Treat the inter-line boundary as a newline in the character stream; if `inString` is true across line boundaries, the newline is a literal newline inside a JSON string (the Mode A failure mode).

2. **Sanitize literal newlines inside JSON strings**
   - Implement `sanitizeJsonNewlines(jsonStr: string): string` that walks character-by-character with the same `inString/escape` logic.
   - When encountering a literal `\n` character while `inString === true`, replace it with the two-character sequence `\\n`.
   - Return the sanitized string for `JSON.parse()`.

**Verify**
- `npx vitest run src/workflow/brainstorm-parser.acceptance.test.ts --reporter=verbose`

---

### Task 5 — Bug 2 implementation (Layer 3): fallback chain when fenced parse fails
**What to do**
- Update `src/workflow/brainstorm-parser.ts` **only** (keep scope tight):
  - Extend **`parseBrainstormOutput()`** so it falls back not just when no fenced block is found, but also when a fenced block is found and parsing still fails.

**Implementation requirements (from Design v3)**
Implement the fallback chain exactly:
1. `fenced = extractFencedBlock(rawOutput)`
2. If `fenced`:
   - `sanitized = sanitizeJsonNewlines(fenced)`
   - `result = parseAndValidate(sanitized, rawOutput)`
   - If ok → return
   - Else try brace-match **on the fenced region first**:
     - `braceFromFenced = extractLastBraceBlock(fenced)`
     - If found: sanitize + `parseAndValidate` and return if ok
3. If still not ok: try brace-match on full output:
   - `braceFromFull = extractLastBraceBlock(rawOutput)`
   - If found: sanitize + `parseAndValidate` and return if ok
4. Otherwise return the error result.

**Verify**
- `npx vitest run src/workflow/brainstorm-parser.acceptance.test.ts --reporter=verbose`

---

### Task 6 — Bug 2 prompt hardening (Layer 4): forbid literal newlines in JSON strings
**What to do**
- Update prompts to reduce the chance of Mode A outputs:
  1. `agents/brainstormer.md`: under response format, add a **JSON formatting rules** section that explicitly requires using `\n` escapes instead of literal newlines inside JSON strings.
  2. `src/workflow/prompt-builder.ts`: append the same instruction to:
     - `buildBrainstormQuestionsPrompt()`
     - `buildBrainstormApproachesPrompt()`
     - `buildBrainstormDesignPrompt()`
     - `buildBrainstormSectionRevisionPrompt()`

**Acceptance coverage**
- No new AT required (behavior is prompt-level), but keep existing Bug 2 ATs as regression guards.

**Verify**
- `npx vitest run src/workflow/brainstorm-parser.acceptance.test.ts --reporter=verbose`

---

### Task 7 — Bugs 3 & 4 tests: status bar updates + confirm() arity
**What to do**
- Add acceptance tests in `src/workflow/phases/brainstorm.acceptance.test.ts`.

**Acceptance tests to write first**
- **AT-7**: `runBrainstormPhase()` calls `ui.setStatus()` with strings that include each sub-step name: scout → questions → approaches → design.
- **AT-8**: In the design step, `ui.confirm(title, body, ...)` is called with a non-empty title and a non-`undefined` body (at least 2 args).
- **AT-9**: When sections have empty strings for title/content, confirm receives fallbacks `"(untitled)"` and `"(no content)"`, and neither argument contains the literal string `"undefined"`.

**Verify**
- `npx vitest run src/workflow/phases/brainstorm.acceptance.test.ts --reporter=verbose`

---

### Task 8 — Bugs 3 & 4 implementation: status updates per step + fix confirm signature
**What to do**
- Update `src/workflow/phases/brainstorm.ts`:

**Bug 3: status bar updates**
- Ensure `ui?.setStatus?.("workflow", formatStatus(state))` is called at the entry of each sub-step **after** `state.brainstorm.step` is set:
  - scout (replace existing hardcoded scouting string)
  - questions (new)
  - approaches (new)
  - design (new)
- Add/verify the correct import of `formatStatus` from `../ui.js`.

**Bug 4: confirm dialog "undefined"**
- Fix both design-section confirmation call sites to pass 2 arguments:
  - `title = section.title || "(untitled)"`
  - `message = section.content || "(no content)"`
  - `await ui?.confirm?.(title, message)` (opts allowed as a third arg if already used)

**Verify**
- `npx vitest run src/workflow/phases/brainstorm.acceptance.test.ts --reporter=verbose`

---

### Task 9 — Integration: plan-write phase parses complex plans end-to-end (Bugs 1+2)
**What to do**
- Add acceptance test **AT-10** in `src/workflow/phases/plan-write.acceptance.test.ts`.

**Acceptance test to write first**
- **AT-10**: Run `runPlanWritePhase()` with a planner output that includes a complex plan format (multi-line descriptions and embedded code fences) and assert:
  - `state.tasks.length === 3`
  - `state.phase === "plan-review"`
  - `ui.notify` called with message containing `"3 tasks"`

**Verify**
- `npx vitest run src/workflow/phases/plan-write.acceptance.test.ts --reporter=verbose`

---

### Task 10 — Full verification + deploy to installed module
**What to do**
- Run the full test suite (or at minimum all acceptance tests added/modified).
- Deploy the updated `src/` and `agents/` directories to the installed `pi-superteam` module path.

**Verify**
- `npx vitest run --reporter=verbose`

**Deploy**
```bash
rm -rf /home/pi/.npm-global/lib/node_modules/pi-superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/
cp -r ~/superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/src/
cp -r ~/superteam/agents/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/
```

---

## superteam-tasks

```superteam-tasks
- title: Add Bug 1 acceptance tests + fixture for task parsing
  description: Create src/workflow/__fixtures__/smoke-test-plan.md and write AT-1/AT-2 in src/workflow/state.acceptance.test.ts to prove parseTaskBlock() preserves tasks and multi-line descriptions with embedded code fences.
  files: [src/workflow/__fixtures__/smoke-test-plan.md, src/workflow/state.acceptance.test.ts]
- title: Implement Bug 1 fixes in src/workflow/state.ts
  description: Rewrite parseTaskBlock() as a line-walker and extend parseYamlLikeTasks() to support description-pipe block scalars so embedded code fences and multi-line descriptions no longer drop tasks.
  files: [src/workflow/state.ts]
- title: Add Bug 2 acceptance tests for brainstorm parsing
  description: Write AT-3/AT-3b/AT-4/AT-5/AT-6 in src/workflow/brainstorm-parser.acceptance.test.ts covering literal newlines in JSON strings, inner fences, and fallback recovery.
  files: [src/workflow/brainstorm-parser.acceptance.test.ts]
- title: Implement Bug 2 Layer 1+2 in brainstorm-parser.ts
  description: Replace extractFencedBlock() with a quote-aware line-walker and add sanitizeJsonNewlines() to escape literal \n inside JSON strings before JSON.parse().
  files: [src/workflow/brainstorm-parser.ts]
- title: Implement Bug 2 Layer 3 fallback chain in parseBrainstormOutput()
  description: Update parseBrainstormOutput() to retry brace-matching on the fenced region first and then full output when fenced parsing fails, using sanitizeJsonNewlines() before parseAndValidate().
  files: [src/workflow/brainstorm-parser.ts]
- title: Harden brainstorm prompts to avoid literal newlines in JSON
  description: Update agents/brainstormer.md and src/workflow/prompt-builder.ts to instruct the model to use \n escapes inside JSON strings and never emit literal newlines.
  files: [agents/brainstormer.md, src/workflow/prompt-builder.ts]
- title: Add Bugs 3+4 acceptance tests for brainstorm phase UI
  description: Write AT-7/AT-8/AT-9 in src/workflow/phases/brainstorm.acceptance.test.ts to assert status updates per sub-step and confirm(title, body) calls never pass undefined.
  files: [src/workflow/phases/brainstorm.acceptance.test.ts]
- title: Implement Bugs 3+4 fixes in src/workflow/phases/brainstorm.ts
  description: Add formatStatus import from ../ui.js, call ui.setStatus("workflow", formatStatus(state)) at each sub-step entry (scout/questions/approaches/design), and fix ui.confirm() call sites to pass (section.title||"(untitled)", section.content||"(no content)").
  files: [src/workflow/phases/brainstorm.ts]
- title: Add AT-10 integration test for plan-write phase
  description: Create src/workflow/phases/plan-write.acceptance.test.ts to verify runPlanWritePhase() parses 3 tasks from a complex plan and transitions to plan-review with a "3 tasks" notify.
  files: [src/workflow/phases/plan-write.acceptance.test.ts]
- title: Run full test suite and deploy updated src/ and agents/
  description: Run npx vitest run --reporter=verbose, then copy ~/superteam/src and ~/superteam/agents into /home/pi/.npm-global/lib/node_modules/pi-superteam/.
  files: [src/workflow/state.ts]
```
