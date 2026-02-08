# Design: Smoke Test Bug Fixes

Fix 4 bugs discovered during the 2026-02-07 `/workflow` smoke test.

## References

- `docs/FUTURE.md` — "Bugs Found in Smoke Test" section
- `docs/plans/2026-02-07-smoke-test-results.md` — full smoke test report
- `/home/pi/test-workflow-smoke/docs/plans/2026-02-07-add-a-get-health-endpoint-that-returns-s-plan.md` — reproduction case for Bug 1

---

## Bug 1: 🔴 CRITICAL — superteam-tasks YAML parser drops tasks

### Affected code

`src/workflow/state.ts` — `parseTaskBlock()` and `parseYamlLikeTasks()`

### Root cause

Two compounding issues:

**Issue A — Fence regex truncation.** The regex `/```superteam-tasks\s*\n([\s\S]*?)```/` uses non-greedy `[\s\S]*?` which stops at the *first* triple-backtick it finds anywhere in the content. When a task's multi-line description contains embedded code fences (e.g. `` ```typescript ``), the regex matches those instead of the real closing fence. In the smoke test plan file, the captured block ends partway through Task 2's embedded code block — Task 3 is never seen by the parser.

Trace through the smoke test plan:

```
```superteam-tasks            ← regex starts here
- title: Install test deps    ← Task 1 captured
  description: "..."
  files: [package.json]
- title: Extract app module   ← Task 2 starts
  description: |
    Split src/index.ts...
    ```typescript             ← regex stops here (first ```)
    import express from ...   ← everything below is outside the match
    ```
  files: [...]
- title: Add /health route    ← Task 3 never seen
  ...
```                           ← real closing fence, never reached
```

**Issue B — No multi-line description support.** `parseYamlLikeTasks()` processes descriptions as single-line only. When the YAML uses `description: |` (block scalar syntax), the parser stores the literal character `"|"` as the description and ignores all continuation lines. Even if Issue A is fixed, Tasks 2 and 3 would have description `"|"` instead of their actual content.

### Fix approach

1. **Replace the fence regex** with a line-walking approach: find the opening `` ```superteam-tasks `` marker, then scan lines forward looking for a closing `` ``` `` at column 0 (unindented, nothing else on the line). Embedded fences are always indented inside YAML block scalars, so they won't match.

2. **Extend `parseYamlLikeTasks()`** to handle `description: |` block scalars. When `description: |` is seen, accumulate subsequent lines into the description until the next task-level key (`files:`, next `- title:`) or end-of-block is reached.

### Files to change

- `src/workflow/state.ts` — `parseTaskBlock()`, `parseYamlLikeTasks()`

---

## Bug 2: 🟡 HIGH — Brainstorm JSON parse failures (60% rate)

### Affected code

`src/workflow/brainstorm-parser.ts` — `parseAndValidate()`
`src/workflow/prompt-builder.ts` — brainstorm prompt functions
`agents/brainstormer.md` — agent system prompt

### Root cause

The brainstormer agent produces JSON with literal newline characters (`0x0a`) inside string values — particularly in long `content` fields of design sections. The JSON spec forbids unescaped newlines inside strings, so `JSON.parse()` throws "unterminated string" errors. 3 of 5 brainstormer dispatches failed this way during the smoke test.

### Fix approach — two layers

**Layer 1 — Defensive parser (primary fix).** In `parseAndValidate()`, before calling `JSON.parse()`, sanitize the JSON string by replacing literal newlines inside string values with `\\n` escape sequences. Implementation: scan character-by-character tracking `"` boundaries (with backslash-escape awareness) and replace `\n` found inside strings.

**Layer 2 — Prompt hardening (secondary).** Add explicit instruction to the brainstormer agent system prompt (`agents/brainstormer.md`) and to the three brainstorm prompt builders in `prompt-builder.ts`: "IMPORTANT: JSON strings must not contain literal newlines — use \\n escape sequences instead."

Layer 1 is the reliable fix. Layer 2 reduces the frequency but can't be relied upon alone.

### Files to change

- `src/workflow/brainstorm-parser.ts` — new `sanitizeJsonNewlines()` helper, called in `parseAndValidate()`
- `agents/brainstormer.md` — add JSON formatting instruction
- `src/workflow/prompt-builder.ts` — add newline warning to brainstorm prompt functions

---

## Bug 3: 🟡 MEDIUM — Status bar sub-step stuck on "scouting"

### Affected code

`src/workflow/phases/brainstorm.ts` — `runBrainstormPhase()`

### Root cause

The brainstorm phase only calls `ui.setStatus()` once, at the start of the scout sub-step, with the hardcoded string `"⚡ Workflow: brainstorm (scouting...)"`. When the phase advances to `questions`, `approaches`, and `design` sub-steps, there are no corresponding `setStatus()` calls. The `formatStatus()` helper in `ui.ts` works correctly — it reads `state.brainstorm.step` — but nobody calls it during the later sub-steps.

### Fix approach

Add `ui.setStatus()` calls at the entry of each sub-step block in `runBrainstormPhase()`, using the same pattern as the scout step. Each call should reflect the current sub-step:

- Before questions dispatch: `"⚡ Workflow: brainstorm (questions...)"`
- Before approaches dispatch: `"⚡ Workflow: brainstorm (approaches...)"`
- Before design dispatch: `"⚡ Workflow: brainstorm (design...)"`

### Files to change

- `src/workflow/phases/brainstorm.ts` — add 3 `setStatus` calls

---

## Bug 4: 🟢 LOW — `undefined` in design section display

### Affected code

`src/workflow/phases/brainstorm.ts` — design section confirmation dialogs

### Root cause

In the design sub-step, section content is displayed via:

```typescript
await ui?.confirm?.(`## ${section.title}\n\n${section.content}`);
```

If `section.title` or `section.content` is `undefined` (e.g. brainstormer omits a field and validation defaults it to `""`), JavaScript template literal interpolation produces the literal string `"undefined"`. The same pattern appears in the post-revision confirmation.

### Fix approach

Add null-coalescing fallbacks in both confirmation dialog template strings:

```typescript
`## ${section.title || "(untitled)"}\n\n${section.content || ""}`
```

### Files to change

- `src/workflow/phases/brainstorm.ts` — 2 `ui.confirm` call sites in the design section loop

---

## Acceptance Tests

These describe the user-visible outcomes that must be true after all fixes are applied. Each maps to a vitest test case that exercises the real code path without mocks where possible.

### AT-1: Full plan file parses all tasks (Bug 1)

**Scenario:** The actual smoke test plan file (the reproduction case) is fed to `parseTaskBlock()`.

**Given** the plan file at `/home/pi/test-workflow-smoke/docs/plans/2026-02-07-add-a-get-health-endpoint-that-returns-s-plan.md`
**When** `parseTaskBlock(planContent)` is called
**Then** it returns exactly 3 tasks:
  - Task 1: title = "Install test dependencies", files includes `package.json`
  - Task 2: title = "Extract app module and write tests (TDD red)", description contains "Split src/index.ts", files includes `src/app.ts`, `src/index.ts`, `src/app.test.ts`
  - Task 3: title = "Add the /health route (TDD green)", description contains "GET /health", files includes `src/app.ts`

**Test file:** `src/workflow/task-parser.acceptance.test.ts`

### AT-2: Embedded code fences don't break task extraction (Bug 1)

**Scenario:** A plan with tasks whose descriptions contain `` ```typescript `` code blocks inside `description: |` block scalars is parsed.

**Given** a `superteam-tasks` block with 2 tasks, both containing embedded `` ```typescript `` fences indented inside their descriptions
**When** `parseTaskBlock(content)` is called
**Then** it returns exactly 2 tasks
**And** each task's `description` contains the code from inside the embedded fences
**And** each task's `files` array is populated correctly

**Test file:** `src/workflow/task-parser.acceptance.test.ts`

### AT-3: Brainstormer JSON with literal newlines parses successfully (Bug 2)

**Scenario:** A brainstormer agent returns a `superteam-brainstorm` block where the JSON has literal `\n` characters inside string values (the exact failure mode from the smoke test).

**Given** raw brainstormer output containing:
```
```superteam-brainstorm
{
  "type": "design",
  "sections": [
    { "id": "s1", "title": "Architecture", "content": "Line one.
Line two.
Line three." }
  ]
}
```
```
(where the line breaks between "Line one.", "Line two.", "Line three." are literal `0x0a` newlines)
**When** `parseBrainstormOutput(raw)` is called
**Then** result.status is `"ok"`
**And** result.data.type is `"design"`
**And** result.data.sections[0].content contains "Line one." and "Line two." and "Line three."

**Test file:** `src/workflow/brainstorm-parser.acceptance.test.ts`

### AT-4: Brainstormer JSON fallback with literal newlines also works (Bug 2)

**Scenario:** Same as AT-3 but the JSON is not in a fenced block — it's raw JSON in the output (fallback brace-matching path).

**Given** raw output with a bare JSON object containing literal newlines inside strings
**When** `parseBrainstormOutput(raw)` is called
**Then** result.status is `"ok"` and sections are correctly extracted

**Test file:** `src/workflow/brainstorm-parser.acceptance.test.ts`

### AT-5: Status bar updates during each brainstorm sub-step (Bug 3)

**Scenario:** A full brainstorm phase runs from scout through questions, approaches, and design. The status bar should reflect each sub-step as it progresses.

**Given** a brainstorm phase starting from step `"scout"`
**When** `runBrainstormPhase()` runs through scout → questions → approaches → design
**Then** `ui.setStatus` is called at least once with a string containing `"scout"` or `"scouting"`
**And** at least once with a string containing `"questions"`
**And** at least once with a string containing `"approaches"`
**And** at least once with a string containing `"design"`

**Test file:** `src/workflow/phases/brainstorm.acceptance.test.ts`

### AT-6: Design sections with missing fields don't show "undefined" (Bug 4)

**Scenario:** The brainstormer returns design sections where `title` or `content` fields are missing/undefined. The confirmation dialog presented to the user should never contain the literal string `"undefined"`.

**Given** a brainstorm phase in the `"design"` step
**When** the brainstormer returns sections with `title: undefined` or `content: undefined`
**And** `runBrainstormPhase()` presents them to the user via `ui.confirm()`
**Then** every string passed to `ui.confirm()` does NOT contain the literal text `"undefined"`

**Test file:** `src/workflow/phases/brainstorm.acceptance.test.ts`

### AT-7: End-to-end plan-write phase gets all tasks from a complex plan (Bugs 1+2 integration)

**Scenario:** The plan-write phase dispatches a planner agent that writes a plan file with multi-line descriptions and embedded code fences. The phase should parse all tasks.

**Given** a plan-write phase where the planner writes a plan with 3 tasks (matching the smoke test plan format)
**When** `runPlanWritePhase()` completes
**Then** `state.tasks` has length 3
**And** `state.phase` is `"plan-review"`
**And** `ui.notify` is called with a message containing `"3 tasks"`

**Test file:** `src/workflow/phases/plan-write.acceptance.test.ts`

---

## Execution Order

1. Bug 1 (CRITICAL) — task parser
2. Bug 2 (HIGH) — brainstorm JSON parsing
3. Bug 3 (MEDIUM) — status bar updates
4. Bug 4 (LOW) — undefined display

Each bug: write acceptance test → write unit tests → implement fix → verify all tests pass → commit.

After all 4: deploy to installed copy with:
```bash
rm -rf /home/pi/.npm-global/lib/node_modules/pi-superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/
cp -r ~/superteam/src/ /home/pi/.npm-global/lib/node_modules/pi-superteam/src/
cp -r ~/superteam/agents/ /home/pi/.npm-global/lib/node_modules/pi-superteam/agents/
```

```superteam-tasks
- title: "Fix task parser: fence regex and multi-line descriptions"
  description: "Fix parseTaskBlock() fence regex to walk lines instead of non-greedy match (handles embedded code fences). Fix parseYamlLikeTasks() to handle description: | block scalars. Acceptance tests AT-1, AT-2. Integration test AT-7."
  files: [src/workflow/state.ts, src/workflow/task-parser.acceptance.test.ts, src/workflow/task-parser.test.ts, src/workflow/phases/plan-write.acceptance.test.ts]
- title: "Fix brainstorm JSON parser: handle literal newlines in strings"
  description: "Add sanitizeJsonNewlines() to brainstorm-parser.ts that replaces literal newlines inside JSON string values with \\n escapes. Call before JSON.parse(). Harden brainstormer prompt. Acceptance tests AT-3, AT-4."
  files: [src/workflow/brainstorm-parser.ts, src/workflow/brainstorm-parser.test.ts, src/workflow/brainstorm-parser.acceptance.test.ts, agents/brainstormer.md, src/workflow/prompt-builder.ts]
- title: "Fix brainstorm status bar: add setStatus calls for each sub-step"
  description: "Add ui.setStatus() calls at the start of questions, approaches, and design sub-steps in runBrainstormPhase(). Acceptance test AT-5."
  files: [src/workflow/phases/brainstorm.ts, src/workflow/phases/brainstorm.test.ts, src/workflow/phases/brainstorm.acceptance.test.ts]
- title: "Fix undefined in design section display"
  description: "Add null-coalescing guards to the 2 ui.confirm() calls in the design section loop. Acceptance test AT-6."
  files: [src/workflow/phases/brainstorm.ts, src/workflow/phases/brainstorm.acceptance.test.ts]
```
