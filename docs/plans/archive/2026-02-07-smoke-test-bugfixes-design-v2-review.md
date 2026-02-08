# Review: Smoke Test Bugfixes Design v2

Date: 2026-02-07

This review validates the **v2 design spec** against the **current repo source** and the **pi extension UI API**. It also assesses fix completeness, acceptance test (AT) quality, and design scope/risks.

**Docs reviewed**

- Design v2: `docs/plans/2026-02-07-smoke-test-bugfixes-design-v2.md`
- Prior review (of v1): `docs/plans/2026-02-07-smoke-test-bugfixes-plan-review.md`
- Original design v1: `docs/plans/2026-02-07-smoke-test-bugfixes-design.md`
- Smoke test results: `docs/plans/2026-02-07-smoke-test-results.md`

**Source validated (key files)**

- `src/workflow/state.ts`
- `src/workflow/brainstorm-parser.ts`
- `src/workflow/phases/brainstorm.ts`
- `src/workflow/ui.ts` and `src/workflow/orchestrator.ts`
- pi UI API types: `/home/pi/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`

---

## Executive summary

- **Bug 1 (task parsing):** v2 root cause matches code; fix approach is directionally correct; ATs are aligned.
- **Bug 2 (brainstorm JSON failures):** v2 correctly expands beyond v1, but the proposed *shared closing-fence rule* has a **high-risk edge case** for brainstorm extraction when design content contains Markdown code fences **and** the JSON is already in the “literal newline inside strings” failure mode.
- **Bug 3 (status bar):** v2 root cause matches code; fix is straightforward.
- **Bug 4 (`undefined` in design dialog):** v2 root cause is **correct** and v1 was wrong; the pi API signature requires `confirm(title, message)` and current code passes **1 arg** at both call sites.

---

## Bug-by-bug verification

### Bug 1 — superteam-tasks YAML parser drops tasks

**Root cause accuracy (PASS)**

Verified in `src/workflow/state.ts`:

- `parseTaskBlock()` uses:
  ```ts
  const fenceRegex = /```superteam-tasks\s*\n([\s\S]*?)```/;
  ```
  The non-greedy capture can terminate at the first ``` anywhere inside the block.

- `parseYamlLikeTasks()` treats `description:` as a single trimmed line:
  ```ts
  if (trimmed.startsWith("description:")) {
    current.description = trimmed.slice("description:".length).trim();
  }
  ```
  So `description: |` becomes the literal `|` and continuation lines are ignored.

**Fix completeness (LIKELY PASS)**

- A line-walking extractor + block-scalar (`description: |`) support addresses the failure mode seen in the smoke-test fixture.

**Acceptance test coverage (PASS)**

- AT-1/AT-2 as described in v2 hit the real parser entrypoints and cover both truncation and multi-line descriptions.

---

### Bug 2 — Brainstorm JSON parse failures

**Root cause accuracy (PASS)**

Verified in `src/workflow/brainstorm-parser.ts`:

- `extractFencedBlock()` uses:
  ```ts
  const regex = /```superteam-brainstorm\s*\n([\s\S]*?)```/;
  ```
  Same truncation class as Bug 1.

- `parseAndValidate()` directly calls `JSON.parse(jsonStr)` with no sanitization. Literal newlines inside string values will throw.

**Fix completeness (PARTIAL: must harden extractor)**

v2 adds four layers:

1. Fence extraction line-walker
2. JSON newline sanitization
3. Fallback chain: brace-block recovery even after fenced parse failure
4. Prompt hardening

This scope is **reasonable** given the smoke test’s 60% failure rate.

However, there is a **high-risk edge case** in the v2 extractor spec:

- v2 proposes treating a closing fence line as:
  ```regex
  /^ {0,3}```\s*$/
  ```
  and claims that inner fences “won’t match because they are embedded in longer lines”.

That claim is **not guaranteed** in realistic brainstorm outputs:

- If the brainstormer emits **literal newlines inside JSON strings** (Mode A), then design content can contain Markdown code fences **on their own lines**:

  ```
  "content": "Here is code:\n```ts\nconsole.log(1)\n```\nMore text"
  ```

  In the broken output, those ` ``` ` lines may appear as standalone lines inside the fenced block text. A naive line-walker that stops at the first `/^ {0,3}```\s*$/` will **terminate at the inner code fence closing line** and truncate the JSON.

**Acceptance test coverage (MOSTLY, but missing a combined-case test)**

- AT-3/AT-4/AT-5/AT-6/AT-4 (v2 numbering) cover the major categories.
- What’s missing: a test that combines **Mode A + Mode B** (literal newlines *and* inner ``` fences on standalone lines).

---

### Bug 3 — Status bar sub-step stuck on "scouting"

**Root cause accuracy (PASS)**

Verified in `src/workflow/phases/brainstorm.ts`:

- Only one status call exists today:
  ```ts
  ui?.setStatus?.("workflow", "⚡ Workflow: brainstorm (scouting...)");
  ```
  and nothing updates it in the later sub-steps.

Also verified that the overall loop calls `formatStatus(state)` once per outer loop iteration (`src/workflow/orchestrator.ts`), which won’t help if `runBrainstormPhase()` runs multiple sub-steps in a single call.

**Fix completeness (PASS)**

- Adding `ui.setStatus("workflow", formatStatus(state))` at the entry of each sub-step (after updating `state.brainstorm.step`) will address the symptom.

**Acceptance test coverage (PASS)**

- AT-7 (v2) that asserts `ui.setStatus` gets called with substrings for each step is aligned to the fix.

---

### Bug 4 — `undefined` in design section display

**Root cause accuracy (PASS; v2 corrects v1)**

Two things verified:

1. v1’s hypothesis (“template literal renders undefined fields”) is inconsistent with current validation.

   In `src/workflow/brainstorm-parser.ts`, `validateDesign()` forces non-strings to empty strings:
   ```ts
   title: typeof s.title === "string" ? s.title : "",
   content: typeof s.content === "string" ? s.content : "",
   ```

2. v2’s revised hypothesis (“confirm arity mismatch”) matches both code and API.

   In `src/workflow/phases/brainstorm.ts`, `ui.confirm` is called with **one** argument at both sites:
   - line ~156:
     ```ts
     await ui?.confirm?.(`## ${section.title}\n\n${section.content}`);
     ```
   - line ~179:
     ```ts
     await ui?.confirm?.(`## ${sections[i].title}\n\n${sections[i].content}`);
     ```

   The pi API signature is:
   ```ts
   confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
   ```
   Source: `/home/pi/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`.

**Fix completeness (PASS)**

- Splitting into `confirm(title, message)` with sensible fallbacks addresses the root cause.

**Acceptance test coverage (PASS; v2 improves it)**

- AT-8/AT-9 in v2 are correctly aimed at call arity and arguments (not substring matching).

---

## Cross-cutting checks

### Bug 2 “4 layers” scope: over/under-engineered?

**Assessment:** appropriate and not over-engineered.

- Layer 1 (extractor fix) is mandatory.
- Layer 2 (sanitization) directly addresses Mode A.
- Layer 3 (fallback chain) is a pragmatic recovery mechanism, but should be tightened to avoid parsing the wrong brace block.
- Layer 4 (prompt hardening) is helpful but not relied upon.

The only concern is correctness of Layer 1’s closing-fence detection (see Must Fix).

### Shared closing fence regex `/^ {0,3}```\s*$/` for Bug 1 and Bug 2

- **Bug 1:** This is reasonable (CommonMark allows up to 3-space indent on fences; and YAML block scalars in the smoke-test fixture indent inner fences by 4 spaces, so they won’t match).
- **Bug 2:** This is **not sufficient** by itself because inner fences can appear at column 0 inside JSON content if the JSON is already malformed (literal newlines) or if content includes non-indented code blocks.

### Paths, function names, and API signatures

Verified and consistent with current source:

- `parseTaskBlock()` / `parseYamlLikeTasks()` are in `src/workflow/state.ts`.
- `extractFencedBlock()` / `parseBrainstormOutput()` / `parseAndValidate()` are in `src/workflow/brainstorm-parser.ts`.
- `ui.confirm(title, message, opts?)` signature confirmed in pi types file.
- Brainstorm confirm call sites confirmed in `src/workflow/phases/brainstorm.ts`.

---

## Must-fix items (before implementation is considered “ready”)

1. **Bug 2 extractor must be hardened** so it cannot mistake inner code fence closures for the outer `superteam-brainstorm` fence.
2. **Add explicit test coverage** for the combined-case: fenced brainstorm JSON that contains both:
   - literal newlines inside string values **and**
   - Markdown code fences that include a closing ``` on its own line.

---

## Concrete proposal: robust brainstorm fenced-block extraction

You have a few viable designs. The key is: **don’t treat every standalone ``` line as the closing fence**.

### Option A (recommended): “quote-aware line-walker”

Algorithm idea:

- Find the opening line matching `^\s{0,3}```superteam-brainstorm\s*$`.
- Scan forward line-by-line.
- Maintain a simple JSON-string state machine while scanning the fenced region:
  - `inString` toggled by unescaped `"`.
  - `escape` handling for `\\`.
- Only accept a closing fence line (`^\s{0,3}```\s*$`) **when not inString**.

This prevents treating inner Markdown code fences inside JSON strings as the end of the outer fenced block.

### Option B: choose the *last* valid closing fence

Given the prompt contract (“You MUST always end your response with a `superteam-brainstorm` fenced block”), a simpler approach is:

- Locate opening fence.
- Locate the **last** line after it that matches `^\s{0,3}```\s*$`.
- Take everything between.

This can still fail if additional fences appear after, but the contract usually makes this safe.

### Option C: brace-match inside fenced region

- Extract fenced region using a coarse method.
- Then run `extractLastBraceBlock()` **on the fenced region**, not the entire output.

This reduces risk of capturing some other JSON object elsewhere in raw output.

---

## Concrete test plan for Bug 2 extractor correctness

Add at least these tests (unit tests are fine; acceptance tests are also ok):

1. **Combined Mode A + Mode B inside fenced block**

   Raw output contains:

   - A ` ```superteam-brainstorm` fence.
   - JSON with a `content` field that contains literal newlines.
   - Within those literal newlines, include Markdown code fences so there is a standalone line containing ```.

   Expect:

   - `parseBrainstormOutput(raw).status === "ok"`
   - `sections[0].content` contains the full block including the code fence, not truncated.

2. **Fallback correctness when fenced parse fails**

   - Include a malformed fenced JSON block and a later valid JSON object.
   - Ensure fallback selects the intended object.

3. **CRLF handling**

   - Ensure sanitizer/extractor handles `\r\n` without breaking content or producing invalid JSON.

---

## Structured output (machine-checkable)

```superteam-json
{
  "passed": false,
  "bugReviews": [
    {
      "bug": 1,
      "title": "superteam-tasks YAML parser drops tasks",
      "rootCauseAccurate": true,
      "rootCauseEvidence": [
        "src/workflow/state.ts: parseTaskBlock() uses const fenceRegex = /```superteam-tasks\\s*\\n([\\s\\S]*?)```/; (non-greedy, terminates on first ``` anywhere)",
        "src/workflow/state.ts: parseYamlLikeTasks() treats `description:` as a single trimmed line; `description: |` becomes literal '|' and continuation lines are ignored"
      ],
      "fixComplete": "mostly",
      "acceptanceTestsAdequate": true
    },
    {
      "bug": 2,
      "title": "Brainstorm JSON parse failures",
      "rootCauseAccurate": true,
      "rootCauseEvidence": [
        "src/workflow/brainstorm-parser.ts: extractFencedBlock() uses /```superteam-brainstorm\\s*\\n([\\s\\S]*?)```/; (same truncation class as Bug 1)",
        "src/workflow/brainstorm-parser.ts: parseAndValidate() calls JSON.parse(jsonStr) with no sanitization; literal newlines inside JSON strings will throw"
      ],
      "fixComplete": "partially",
      "acceptanceTestsAdequate": "mostly"
    },
    {
      "bug": 3,
      "title": "Status bar sub-step stuck on \"scouting\"",
      "rootCauseAccurate": true,
      "rootCauseEvidence": [
        "src/workflow/phases/brainstorm.ts: only one ui?.setStatus?.(...) call exists during scout; no status updates in questions/approaches/design blocks"
      ],
      "fixComplete": true,
      "acceptanceTestsAdequate": true
    },
    {
      "bug": 4,
      "title": "`undefined` in design section display",
      "rootCauseAccurate": true,
      "rootCauseEvidence": [
        "src/workflow/brainstorm-parser.ts: validateDesign() forces title/content to \"\" if not strings (so template interpolation alone cannot yield literal 'undefined')",
        "src/workflow/phases/brainstorm.ts: ui?.confirm?. is called with ONE argument at the two design-section call sites",
        "pi API signature: /home/pi/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts -> confirm(title: string, message: string, opts?): Promise<boolean>"
      ],
      "fixComplete": true,
      "acceptanceTestsAdequate": true
    }
  ],
  "findings": [
    {
      "severity": "high",
      "area": "Bug 2 fence extraction correctness",
      "issue": "The proposed closing-fence matcher /^ {0,3}```\\s*$/ + naive line-walk can still terminate early on an inner Markdown code-fence closing line inside brainstorm JSON content when the brainstormer emits literal newlines inside strings (Mode A).",
      "recommendation": [
        "Make brainstorm fenced extraction quote-aware (track inString/escape and only accept closing fence when not inString)",
        "Add a combined-case test: literal newlines + inner code fence lines inside the fenced JSON"
      ]
    }
  ],
  "mustFix": [
    "Bug 2: harden brainstorm fenced-block extractor so inner code-fence closers cannot truncate the block",
    "Bug 2: add combined-case tests (Mode A + Mode B) to prevent regressions"
  ]
}
```
