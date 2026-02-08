# Implementation Plan: Next Batch (15 Items)

## Overview

This plan implements 15 improvement items from `docs/plans/next-batch.md`, organized into 4 batches:

- **Batch A** (Tasks 1–5): Parser extraction & prompt cleanup
- **Batch B** (Tasks 6–9): Dispatch & context injection
- **Batch C** (Tasks 10–15): Execution pipeline enhancements
- **Batch D** (Tasks 16–18): Workflow UX improvements

Batches A and B are independent and can run in parallel. Batch C depends on Batch A. Batch D is independent of other batches.

Total: **18 implementation tasks**, each 2–5 minutes.

---

## Batch A — Parser & Prompt Cleanup

### Task 1: Create `src/parse-utils.ts` with `extractFencedBlock` (generalized)

**Write tests first** in `src/parse-utils.test.ts`, then extract the generalized `extractFencedBlock(text, language)` function from `brainstorm-parser.ts` into a new shared module.

**Files:** `src/parse-utils.ts`, `src/parse-utils.test.ts`

**Test code (`src/parse-utils.test.ts`):**
```typescript
import { describe, it, expect } from "vitest";
import { extractFencedBlock } from "./parse-utils.js";

describe("extractFencedBlock", () => {
  it("extracts content from a superteam-brainstorm fenced block", () => {
    const text = 'Preamble\n```superteam-brainstorm\n{"type":"questions"}\n```\nAfter';
    expect(extractFencedBlock(text, "superteam-brainstorm")).toBe('{"type":"questions"}');
  });

  it("extracts content from a superteam-json fenced block", () => {
    const text = 'Review:\n```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}\n```';
    expect(extractFencedBlock(text, "superteam-json")).toBe('{"passed":true,"findings":[],"mustFix":[],"summary":"ok"}');
  });

  it("returns null when no matching fence found", () => {
    expect(extractFencedBlock("no fences here", "superteam-json")).toBeNull();
  });

  it("returns null when fence language doesn't match", () => {
    const text = '```superteam-brainstorm\n{"type":"questions"}\n```';
    expect(extractFencedBlock(text, "superteam-json")).toBeNull();
  });

  it("handles triple-backtick inside JSON string values (quote-aware)", () => {
    const json = JSON.stringify({ type: "design", sections: [{ id: "s1", title: "G", content: "Use ```code``` blocks." }] });
    const text = "```superteam-brainstorm\n" + json + "\n```";
    const result = extractFencedBlock(text, "superteam-brainstorm");
    expect(result).toBe(json);
  });

  it("handles literal newlines inside JSON string values", () => {
    const text = '```superteam-json\n{"passed":true,"summary":"line1\nline2","findings":[],"mustFix":[]}\n```';
    const result = extractFencedBlock(text, "superteam-json");
    expect(result).toContain("line1\nline2");
  });

  it("handles opening fence with leading whitespace (up to 3 spaces)", () => {
    const text = '   ```superteam-json\n{"passed":true}\n```';
    expect(extractFencedBlock(text, "superteam-json")).toBe('{"passed":true}');
  });

  it("returns null when closing fence is missing", () => {
    const text = '```superteam-json\n{"passed":true}';
    expect(extractFencedBlock(text, "superteam-json")).toBeNull();
  });

  it("returns empty string for empty fenced block", () => {
    const text = '```superteam-json\n\n```';
    expect(extractFencedBlock(text, "superteam-json")).toBe("");
  });
});
```

**Implementation (`src/parse-utils.ts`):** Export `extractFencedBlock(text: string, language: string): string | null` using the quote-aware scanning algorithm from `brainstorm-parser.ts`, generalized to accept a `language` parameter. Build the `openPattern` regex dynamically: `` new RegExp(`^\\s{0,3}\`\`\`${language}\\s*$`) ``.

**Verification:** `npx vitest run src/parse-utils.test.ts`

---

### Task 2: Add `extractLastBraceBlock` and `sanitizeJsonNewlines` to `src/parse-utils.ts`

**Add tests** for `extractLastBraceBlock` and `sanitizeJsonNewlines` to `src/parse-utils.test.ts`, then move those functions from `brainstorm-parser.ts`.

**Files:** `src/parse-utils.ts`, `src/parse-utils.test.ts`

**Test code (append to `src/parse-utils.test.ts`):**
```typescript
import { extractLastBraceBlock, sanitizeJsonNewlines } from "./parse-utils.js";

describe("extractLastBraceBlock", () => {
  it("extracts the last top-level JSON object", () => {
    const text = 'text {"a":1} more text {"b":2}';
    expect(extractLastBraceBlock(text)).toBe('{"b":2}');
  });

  it("returns null when no braces found", () => {
    expect(extractLastBraceBlock("no json here")).toBeNull();
  });

  it("handles nested braces", () => {
    const text = '{"outer":{"inner":1}}';
    expect(extractLastBraceBlock(text)).toBe('{"outer":{"inner":1}}');
  });

  it("handles braces inside string values", () => {
    const text = '{"text":"has {braces} inside"}';
    expect(extractLastBraceBlock(text)).toBe('{"text":"has {braces} inside"}');
  });

  it("handles escaped quotes inside strings", () => {
    const text = '{"text":"say \\"hi\\""}';
    expect(extractLastBraceBlock(text)).toBe('{"text":"say \\"hi\\""}');
  });

  it("returns null for unbalanced braces", () => {
    expect(extractLastBraceBlock("{unclosed")).toBeNull();
  });
});

describe("sanitizeJsonNewlines", () => {
  it("returns unchanged string when no literal newlines in JSON strings", () => {
    expect(sanitizeJsonNewlines('{"a":"hello"}')).toBe('{"a":"hello"}');
  });

  it("replaces literal newline inside a JSON string with escaped \\n", () => {
    expect(sanitizeJsonNewlines('{"a":"x\ny"}')).toBe('{"a":"x\\ny"}');
  });

  it("does not replace newlines outside of JSON strings", () => {
    const input = '{\n"a": "hello"\n}';
    expect(sanitizeJsonNewlines(input)).toBe(input);
  });

  it("handles escaped quotes correctly", () => {
    const input = '{"text":"say \\"hi\\"\\nbye"}';
    expect(sanitizeJsonNewlines(input)).toBe(input);
  });

  it("handles multiple literal newlines in multiple strings", () => {
    expect(sanitizeJsonNewlines('{"a":"x\ny","b":"p\nq"}')).toBe('{"a":"x\\ny","b":"p\\nq"}');
  });
});
```

**Implementation:** Move `extractLastBraceBlock` and `sanitizeJsonNewlines` from `brainstorm-parser.ts` to `parse-utils.ts`. Export them.

**Verification:** `npx vitest run src/parse-utils.test.ts`

---

### Task 3: Wire `brainstorm-parser.ts` to use `parse-utils.ts`

**Modify** `brainstorm-parser.ts` to import `extractFencedBlock`, `extractLastBraceBlock`, and `sanitizeJsonNewlines` from `../parse-utils.js`. Delete the local copies of all three functions. The brainstorm parser passes `'superteam-brainstorm'` as the language parameter to `extractFencedBlock`.

**Files:** `src/workflow/brainstorm-parser.ts`

**Test (no new tests — existing tests must pass):**
The existing `brainstorm-parser.test.ts` and `brainstorm-parser.acceptance.test.ts` must continue to pass, verifying the extraction is purely structural.

**Verification:** `npx vitest run src/workflow/brainstorm-parser.test.ts src/workflow/brainstorm-parser.acceptance.test.ts`

---

### Task 4: Wire `review-parser.ts` to use `parse-utils.ts`

**Modify** `review-parser.ts` to import `extractFencedBlock`, `extractLastBraceBlock`, and `sanitizeJsonNewlines` from `./parse-utils.js`. Replace the naive regex `extractFencedBlock` and the local `extractLastBraceBlock` with imports. Add `sanitizeJsonNewlines(jsonStr)` as a pre-parse step before `JSON.parse` in `parseAndValidate`. Delete the local copies.

**Files:** `src/review-parser.ts`, `src/review-parser.test.ts`

**Test code (create `src/review-parser.test.ts` — does not exist yet):**
```typescript
import { describe, it, expect } from "vitest";
import { parseReviewOutput } from "./review-parser.js";

describe("parseReviewOutput with sanitizeJsonNewlines (hardened)", () => {
  it("handles literal newlines inside JSON string values in superteam-json block", () => {
    const raw = '```superteam-json\n{"passed":true,"findings":[],"mustFix":[],"summary":"line1\nline2"}\n```';
    const result = parseReviewOutput(raw);
    expect(result.status).toBe("pass");
    if (result.status === "pass") {
      expect(result.findings.summary).toBe("line1\nline2");
    }
  });

  it("handles triple-backtick inside JSON string values (quote-aware fence)", () => {
    const json = JSON.stringify({
      passed: false,
      findings: [{ severity: "medium", file: "a.ts", issue: "Use ```code``` formatting" }],
      mustFix: [],
      summary: "Minor",
    });
    const raw = "```superteam-json\n" + json + "\n```";
    const result = parseReviewOutput(raw);
    expect(result.status).toBe("fail");
  });

  it("previously inconclusive output now parses correctly", () => {
    const raw = '```superteam-json\n{"passed":false,"findings":[{"severity":"high","file":"src/a.ts","issue":"Missing\nerror handling"}],"mustFix":["src/a.ts"],"summary":"Needs\nfixes"}\n```';
    const result = parseReviewOutput(raw);
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.findings.findings[0].issue).toContain("Missing");
      expect(result.findings.findings[0].issue).toContain("error handling");
    }
  });
});
```

**Implementation:** Replace the local `extractFencedBlock` (regex-based) and `extractLastBraceBlock` with imports from `./parse-utils.js`. In `parseAndValidate`, wrap `jsonStr` with `sanitizeJsonNewlines` before `JSON.parse`:
```typescript
const sanitized = sanitizeJsonNewlines(jsonStr);
parsed = JSON.parse(sanitized);
```

**Verification:** `npx vitest run src/review-parser.test.ts`

---

### Task 5: Delete `REVIEW_OUTPUT_FORMAT` from `prompt-builder.ts`

**Write test first** asserting the format block is NOT duplicated in review prompts (since all 5 reviewer agent `.md` files already contain it), then delete the constant and its references.

**Files:** `src/workflow/prompt-builder.ts`, `src/workflow/prompt-builder.test.ts`

**Test code (add to `src/workflow/prompt-builder.test.ts`):**

Note: This project uses ESM (`"type": "module"`) with `engines: ">=20.0.0"`. `import.meta.dirname` is only available in Node ≥ 21.2. Use `path.dirname(new URL(import.meta.url).pathname)` for ESM-safe path resolution (matching the existing pattern in `src/config.ts`). Do NOT use `__dirname` or `require()`.

```typescript
import * as fs from "node:fs";
import * as path from "node:path";

describe("REVIEW_OUTPUT_FORMAT removal", () => {
  it("buildPlanReviewPrompt does not contain the duplicated IMPORTANT format instruction", () => {
    const result = buildPlanReviewPrompt("plan content", "architect");
    expect(result).not.toContain("IMPORTANT: You MUST end your response with");
  });

  it("buildSpecReviewPrompt does not contain the duplicated IMPORTANT format instruction", () => {
    const task = makeTask();
    const result = buildSpecReviewPrompt(task, ["src/a.ts"]);
    expect(result).not.toContain("IMPORTANT: You MUST end your response with");
  });

  it("buildQualityReviewPrompt does not contain the duplicated IMPORTANT format instruction", () => {
    const task = makeTask();
    const result = buildQualityReviewPrompt(task, ["src/a.ts"]);
    expect(result).not.toContain("IMPORTANT: You MUST end your response with");
  });

  it("buildFinalReviewPrompt does not contain the duplicated IMPORTANT format instruction", () => {
    const result = buildFinalReviewPrompt([makeTask()], ["src/a.ts"]);
    expect(result).not.toContain("IMPORTANT: You MUST end your response with");
  });

  it("all 5 reviewer agents contain superteam-json format in their .md", () => {
    const agentFiles = ["architect", "spec-reviewer", "quality-reviewer", "security-reviewer", "performance-reviewer"];
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    const agentsDir = path.resolve(thisDir, "../../agents");
    for (const name of agentFiles) {
      const content = fs.readFileSync(path.join(agentsDir, name + ".md"), "utf-8");
      expect(content).toContain("```superteam-json");
    }
  });
});
```

**Implementation:** Delete the `REVIEW_OUTPUT_FORMAT` constant from `prompt-builder.ts`. Remove the `REVIEW_OUTPUT_FORMAT` reference from `buildPlanReviewPrompt`, `buildSpecReviewPrompt`, `buildQualityReviewPrompt`, and `buildFinalReviewPrompt`. Delete the following existing tests that will break:
- `buildPlanReviewPrompt` → `"mandates superteam-json output"` — delete this test
- `buildPlanReviewPrompt` → `"mentions passed/findings/mustFix/summary fields"` — delete this test
- `buildSpecReviewPrompt` → `"mandates superteam-json output"` — delete this test
- `buildQualityReviewPrompt` → `"mandates superteam-json output"` — delete this test
- `buildFinalReviewPrompt` → `"mandates superteam-json output"` — delete this test

**Verification:** `npx vitest run src/workflow/prompt-builder.test.ts`

---

## Batch B — Dispatch & Context Injection

### Task 6: Inject `.pi/context.md` into subagent prompts in `dispatch.ts`

**Export `buildSubprocessArgs` for testing**, write tests with real tmpDir assertions, then implement.

**Files:** `src/dispatch.ts`, `src/dispatch.test.ts`

**Test code (add to `src/dispatch.test.ts`):**

Note: `dispatch.test.ts` already imports `fs`, `path`, `os` and has a `makeAgent(overrides)` helper at the top. Use `path.dirname(new URL(import.meta.url).pathname)` for ESM-safe path resolution (not `__dirname`). The `buildSubprocessArgs` function does NOT add `--append-system-prompt` for the agent's own system prompt (that's done later in `runAgent`), so any `--append-system-prompt` in the returned args comes solely from context.md injection.

```typescript
import { buildSubprocessArgs } from "./dispatch.ts";

describe("buildSubprocessArgs — context.md injection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ctx-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends --append-system-prompt when .pi/context.md exists", () => {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "context.md"), "# Project Context\nTypeScript ESM project");

    const agent = makeAgent({ name: "scout" });
    const args = buildSubprocessArgs(agent, tmpDir);

    expect(args).toContain("--append-system-prompt");
    const flagIdx = args.indexOf("--append-system-prompt");
    expect(args[flagIdx + 1]).toBe(path.resolve(tmpDir, ".pi", "context.md"));
  });

  it("does not append --append-system-prompt when .pi/context.md does not exist", () => {
    const agent = makeAgent({ name: "scout" });
    const args = buildSubprocessArgs(agent, tmpDir);

    expect(args).not.toContain("--append-system-prompt");
  });

  it("appends --append-system-prompt for non-implementer agents too", () => {
    const piDir = path.join(tmpDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "context.md"), "context");

    const agent = makeAgent({ name: "spec-reviewer" });
    const args = buildSubprocessArgs(agent, tmpDir);

    expect(args).toContain("--append-system-prompt");
  });
});
```

**Implementation:**
1. Change `function buildSubprocessArgs` to `export function buildSubprocessArgs` (add `/** @internal — exported for testing */` JSDoc).
2. After the existing implementer-specific block (the `if (agent.name === "implementer")` block), add:
```typescript
// Inject project context if available
const contextPath = path.join(cwd, ".pi", "context.md");
if (fs.existsSync(contextPath)) {
  args.push("--append-system-prompt", path.resolve(contextPath));
}
```

**Verification:** `npx vitest run src/dispatch.test.ts`

---

### Task 7: Add `buildSpecReviewPrompt` test-file instruction (item 13)

**Write test first**, then add a single instruction line to `buildSpecReviewPrompt()`.

**Files:** `src/workflow/prompt-builder.ts`, `src/workflow/prompt-builder.test.ts`

**Test code (add to `buildSpecReviewPrompt` describe block in `src/workflow/prompt-builder.test.ts`):**
```typescript
it("includes instruction to only review listed files, not test files unless targeted", () => {
  const task = makeTask();
  const result = buildSpecReviewPrompt(task, ["src/widget.ts"]);
  expect(result).toContain("do not review test files unless the task description explicitly targets test code");
});
```

**Implementation:** In `buildSpecReviewPrompt`, add between the `"Read these files. Compare implementation against spec."` line and the `"Do NOT trust the implementer's self-report"` line:
```
'Only review files listed below — do not review test files unless the task description explicitly targets test code.',
```

**Verification:** `npx vitest run src/workflow/prompt-builder.test.ts`

---

### Task 8: Add `bash` to `security-reviewer.md` tools (item 15)

**Verify via grep-based assertion**, then modify the agent file.

**Files:** `agents/security-reviewer.md`, `src/dispatch.test.ts`

**Test code (add to `src/dispatch.test.ts`):**

Note: Use `path.dirname(new URL(import.meta.url).pathname)` for ESM-safe path resolution (matching `src/config.ts` pattern). Do NOT use `__dirname` or `require()`.

```typescript
describe("security-reviewer agent profile", () => {
  it("includes bash in tools frontmatter", () => {
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    const agentsDir = path.resolve(thisDir, "../agents");
    const content = fs.readFileSync(path.join(agentsDir, "security-reviewer.md"), "utf-8");
    expect(content).toMatch(/^tools:.*bash/m);
  });
});
```

**Implementation:** Change `tools: read,grep,find,ls` to `tools: read,grep,find,ls,bash` in `agents/security-reviewer.md` (line 4 of the frontmatter).

**Verification:** `npx vitest run src/dispatch.test.ts`

---

### Task 9: Narrow scout prompt (item 11)

**Write test first** for the narrowed scout prompt, then update `buildScoutPrompt`.

**Files:** `src/workflow/prompt-builder.ts`, `src/workflow/prompt-builder.test.ts`

**Test code (replace the existing `buildScoutPrompt` describe block in `src/workflow/prompt-builder.test.ts`):**

The existing tests assert `"key files"`, `"directory structure"`, and `"structured summary"` — these will no longer match the narrowed prompt. Replace the entire `buildScoutPrompt` describe block:

```typescript
describe("buildScoutPrompt", () => {
  it("includes cwd path", () => {
    const result = buildScoutPrompt("/my/project");
    expect(result).toContain("/my/project");
  });

  it("instructs to read .pi/context.md if present", () => {
    const result = buildScoutPrompt("/proj");
    expect(result).toContain("context.md");
  });

  it("asks for tech stack, directory layout, key entry points, test conventions", () => {
    const result = buildScoutPrompt("/proj");
    expect(result).toMatch(/tech stack/i);
    expect(result).toMatch(/directory/i);
    expect(result).toMatch(/entry point/i);
    expect(result).toMatch(/test convention/i);
  });

  it("limits output to 500 words", () => {
    const result = buildScoutPrompt("/proj");
    expect(result).toContain("500 words");
  });
});
```

**Implementation:** Replace `buildScoutPrompt` body with:
```typescript
return [
  `Read .pi/context.md if present in ${cwd}.`,
  `Summarize: tech stack, directory layout (3 levels), key entry points, test conventions.`,
  `Max 500 words.`,
].join("\n");
```

**Verification:** `npx vitest run src/workflow/prompt-builder.test.ts`

---

## Batch C — Execution Pipeline

### Task 10: Add `validationCommand` to `SuperteamConfig`

**Write test first**, then add the field.

**Files:** `src/config.ts`, `src/config.test.ts`

**Test code (add to `src/config.test.ts`):**
```typescript
describe("validationCommand config", () => {
  it("defaults to 'tsc --noEmit'", () => {
    const config = getConfig("/nonexistent-path-for-test", true);
    expect(config.validationCommand).toBe("tsc --noEmit");
  });

  it("can be overridden in config file", () => {
    const config = getConfig("/nonexistent-path-for-test", true);
    expect(typeof config.validationCommand).toBe("string");
  });
});
```

**Implementation:** Add `validationCommand?: string` to `SuperteamConfig` interface. Add `validationCommand: "tsc --noEmit"` to `DEFAULT_CONFIG`.

**Verification:** `npx vitest run src/config.test.ts`

---

### Task 11: Add `resetToSha` and `squashCommitsSince` to `git-utils.ts`

**Write tests first** using temp git repos (matching the existing `makeTempRepo`/`makeTempDir` pattern and dynamic imports of `child_process` already in `git-utils.test.ts`), then implement.

**Files:** `src/workflow/git-utils.ts`, `src/workflow/git-utils.test.ts`

**Test code (add to `src/workflow/git-utils.test.ts`):**

Reuse the existing `makeTempRepo()`, `makeTempDir()` helpers already defined at the top of the file. Import new functions alongside existing `getCurrentSha`. The test file already uses `await import("node:child_process")` for git setup commands — follow the same pattern:

```typescript
import { resetToSha, squashCommitsSince } from "./git-utils.ts";

describe("resetToSha", () => {
  it("resets to a previous commit SHA", async () => {
    const dir = await makeTempRepo();
    const baseSha = await getCurrentSha(dir);

    const { execFile: execCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execCb);

    fs.writeFileSync(path.join(dir, "file2.txt"), "new");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "second"], { cwd: dir });

    const headBefore = await getCurrentSha(dir);
    expect(headBefore).not.toBe(baseSha);

    const success = await resetToSha(dir, baseSha);
    expect(success).toBe(true);

    const headAfter = await getCurrentSha(dir);
    expect(headAfter).toBe(baseSha);
    expect(fs.existsSync(path.join(dir, "file2.txt"))).toBe(false);
  });

  it("returns false for empty SHA", async () => {
    const dir = await makeTempRepo();
    const result = await resetToSha(dir, "");
    expect(result).toBe(false);
  });

  it("returns false for invalid SHA", async () => {
    const dir = await makeTempRepo();
    const result = await resetToSha(dir, "0000000000000000000000000000000000000000");
    expect(result).toBe(false);
  });

  it("returns false for non-repo directory", async () => {
    const dir = makeTempDir();
    const result = await resetToSha(dir, "abc123");
    expect(result).toBe(false);
  });
});

describe("squashCommitsSince", () => {
  it("squashes multiple commits into one", async () => {
    const dir = await makeTempRepo();
    const baseSha = await getCurrentSha(dir);

    const { execFile: execCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execCb);

    fs.writeFileSync(path.join(dir, "file2.txt"), "new");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "second"], { cwd: dir });

    fs.writeFileSync(path.join(dir, "file3.txt"), "another");
    await run("git", ["add", "."], { cwd: dir });
    await run("git", ["commit", "-m", "third"], { cwd: dir });

    const success = await squashCommitsSince(dir, baseSha, "feat: squashed");
    expect(success).toBe(true);

    const { stdout } = await run("git", ["log", "--oneline"], { cwd: dir });
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("feat: squashed");

    expect(fs.existsSync(path.join(dir, "file2.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "file3.txt"))).toBe(true);
  });

  it("is a no-op when baseSha equals HEAD (no new commits)", async () => {
    const dir = await makeTempRepo();
    const sha = await getCurrentSha(dir);

    const success = await squashCommitsSince(dir, sha, "feat: nothing");
    expect(success).toBe(true);

    const headAfter = await getCurrentSha(dir);
    expect(headAfter).toBe(sha);
  });

  it("returns false for non-repo directory", async () => {
    const dir = makeTempDir();
    const result = await squashCommitsSince(dir, "abc123", "msg");
    expect(result).toBe(false);
  });
});
```

**Implementation:** Add to `git-utils.ts` (using the existing promisified `execFile` already at the top of the file):
- `resetToSha(cwd: string, sha: string): Promise<boolean>` — validates sha is non-empty, runs `git reset --hard <sha>`. Returns `false` on any failure (catch block).
- `squashCommitsSince(cwd: string, baseSha: string, message: string): Promise<boolean>` — checks if `baseSha` equals HEAD (via `getCurrentSha`, no-op → return true). Otherwise runs `git reset --soft <baseSha>` then `git commit -m <message>`. Returns `false` on failure.

**Verification:** `npx vitest run src/workflow/git-utils.test.ts`

---

### Task 12: Add `summary` field to `TaskExecState` (item 9)

**Write test first**, then add the field.

**Files:** `src/workflow/orchestrator-state.ts`, `src/workflow/orchestrator-state.test.ts`

**Test code (add to `src/workflow/orchestrator-state.test.ts`):**
```typescript
describe("TaskExecState summary field", () => {
  it("TaskExecState accepts optional summary with title, status, changedFiles", () => {
    const task: TaskExecState = {
      id: 1,
      title: "Task 1",
      description: "Do something",
      files: ["src/a.ts"],
      status: "complete",
      reviewsPassed: ["spec"],
      reviewsFailed: [],
      fixAttempts: 0,
      summary: {
        title: "Task 1",
        status: "complete",
        changedFiles: ["src/a.ts", "src/a.test.ts"],
      },
    };
    expect(task.summary).toBeDefined();
    expect(task.summary!.changedFiles).toHaveLength(2);
  });

  it("summary is optional — existing tasks without it still work", () => {
    const task: TaskExecState = {
      id: 1, title: "T", description: "D", files: ["a.ts"],
      status: "pending", reviewsPassed: [], reviewsFailed: [], fixAttempts: 0,
    };
    expect(task.summary).toBeUndefined();
  });
});
```

**Implementation:** Add to `TaskExecState` type in `orchestrator-state.ts`:
```typescript
summary?: { title: string; status: string; changedFiles: string[] };
```

**Verification:** `npx vitest run src/workflow/orchestrator-state.test.ts`

---

### Task 13: Add `previousTaskSummary` to `buildImplPrompt`

**Write test first** for `buildImplPrompt` accepting an optional `previousTaskSummary`, then implement.

**Files:** `src/workflow/prompt-builder.ts`, `src/workflow/prompt-builder.test.ts`

**Test code (add to `buildImplPrompt` describe block in `src/workflow/prompt-builder.test.ts`):**
```typescript
it("includes previous task section when previousTaskSummary is provided", () => {
  const task = makeTask();
  const summary = { title: "Previous Task", status: "complete", changedFiles: ["src/prev.ts"] };
  const result = buildImplPrompt(task, "ctx", summary);
  expect(result).toContain("## Previous task");
  expect(result).toContain("Previous Task");
  expect(result).toContain("complete");
  expect(result).toContain("src/prev.ts");
});

it("does not include previous task section when no summary provided", () => {
  const task = makeTask();
  const result = buildImplPrompt(task, "ctx");
  expect(result).not.toContain("## Previous task");
});
```

**Implementation:** Update `buildImplPrompt` signature to accept optional third parameter `previousTaskSummary?: { title: string; status: string; changedFiles: string[] }`. If provided, prepend a `## Previous task` section before the main task content:
```typescript
const parts: string[] = [];
if (previousTaskSummary) {
  parts.push(
    `## Previous task`,
    `Title: ${previousTaskSummary.title}`,
    `Status: ${previousTaskSummary.status}`,
    `Changed files: ${previousTaskSummary.changedFiles.join(", ")}`,
    ``,
  );
}
// ... existing content follows
```

Existing callers pass only 2 args, so backward compatible.

**Verification:** `npx vitest run src/workflow/prompt-builder.test.ts`

---

### Task 14: Add `'rollback'` option to `escalate()` in `execute.ts` (item 7)

**Write test first**, then modify `escalate()`.

**Files:** `src/workflow/phases/execute.ts`, `src/workflow/phases/execute.test.ts`

The existing `execute.test.ts` mocks `git-utils.js` at the top with `getCurrentSha` and `computeChangedFiles`. We need to add `resetToSha` to that mock.

**Test code (modify and add to `src/workflow/phases/execute.test.ts`):**

First, update the existing `vi.mock("../git-utils.js")` block to include `resetToSha`:
```typescript
vi.mock("../git-utils.js", () => ({
  getCurrentSha: vi.fn(),
  computeChangedFiles: vi.fn(),
  resetToSha: vi.fn(),
}));
```

Then add import and mock ref alongside the existing ones:
```typescript
import { getCurrentSha, computeChangedFiles, resetToSha } from "../git-utils.ts";
const mockResetToSha = vi.mocked(resetToSha);
```

Then add the tests:
```typescript
describe("escalate with rollback option", () => {
  it("offers Rollback when gitShaBeforeImpl is set and calls resetToSha", async () => {
    const state = makeState();
    state.tasks[0].gitShaBeforeImpl = "abc123sha";
    const ctx = makeCtx();

    setupDefaultMocks();
    mockDispatchAgent.mockResolvedValue(makeResult({ exitCode: 1, errorMessage: "Failed" }));
    mockResetToSha.mockResolvedValue(true);

    // User selects Rollback → triggers resetToSha, then on retry impl fails again → Skip
    ctx.ui.select
      .mockResolvedValueOnce("Rollback")
      .mockResolvedValueOnce("Skip");

    const result = await runExecutePhase(state, ctx);

    // Verify Rollback was offered in the select options
    const selectCalls = ctx.ui.select.mock.calls;
    expect(selectCalls[0][1]).toContain("Rollback");

    // Verify resetToSha was called with the saved SHA
    expect(mockResetToSha).toHaveBeenCalledWith(ctx.cwd, "abc123sha");
  });

  it("does not offer Rollback when gitShaBeforeImpl is not set", async () => {
    const state = makeState();
    // Do not set gitShaBeforeImpl
    const ctx = makeCtx();

    setupDefaultMocks();
    mockDispatchAgent.mockResolvedValue(makeResult({ exitCode: 1, errorMessage: "Failed" }));

    ctx.ui.select.mockResolvedValue("Skip");

    await runExecutePhase(state, ctx);

    const selectCalls = ctx.ui.select.mock.calls;
    if (selectCalls.length > 0) {
      expect(selectCalls[0][1]).not.toContain("Rollback");
    }
  });
});
```

**Implementation:**
1. Import `resetToSha` from `../git-utils.js`.
2. Modify `escalate()` signature to accept `cwd` and an optional `gitSha`: `escalate(task, reason, ui, cwd, gitSha?)`.
3. Build options array dynamically: `const options = ["Retry", ...(gitSha ? ["Rollback"] : []), "Skip", "Abort"];`
4. When `"Rollback"` is selected, call `await resetToSha(cwd, gitSha!)` then return `"retry"`.
5. Update all call sites of `escalate` within `execute.ts`:
   - "No implementer" escalation: `escalate(task, reason, ui, ctx.cwd)` (no gitSha → no Rollback offered)
   - Post-impl failure: `escalate(task, reason, ui, ctx.cwd, task.gitShaBeforeImpl)`
   - Review escalations: `escalate(task, reason, ui, ctx.cwd, task.gitShaBeforeImpl)`

**Verification:** `npx vitest run src/workflow/phases/execute.test.ts`

---

### Task 15: Add validation gate before reviews in `execute.ts` (item 12)

**Write test first**, then implement the validation command execution via a testable wrapper.

**Files:** `src/workflow/phases/execute.ts`, `src/workflow/phases/execute.test.ts`

**Test code (add to `src/workflow/phases/execute.test.ts`):**

To make validation testable without mocking `node:child_process` globally, extract a `runValidation(command: string, cwd: string): Promise<{ok: boolean; error?: string}>` function and export it for testing.

```typescript
import { runValidation } from "./execute.ts";

describe("runValidation", () => {
  it("returns ok:true for a command that succeeds", async () => {
    const result = await runValidation("true", "/tmp");
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with error for a command that fails", async () => {
    const result = await runValidation("false", "/tmp");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns ok:true for empty command (skips validation)", async () => {
    const result = await runValidation("", "/tmp");
    expect(result.ok).toBe(true);
  });
});

describe("validation gate integration", () => {
  it("completes task normally when validation command succeeds (default behavior)", async () => {
    setupDefaultMocks();
    const state = makeState();
    const result = await runExecutePhase(state, fakeCtx);
    expect(result.tasks[0].status).toBe("complete");
  });
});
```

**Implementation:**
1. Add import at top of `execute.ts`: `import { execFile as execFileCb } from "node:child_process"` and `import { promisify } from "node:util"`.
2. Export `runValidation(command: string, cwd: string): Promise<{ok: boolean; error?: string}>` with `/** @internal — exported for testing */` JSDoc:
   - If `command` is empty string, return `{ok: true}` immediately.
   - Otherwise, split `command` on whitespace: `const [cmd, ...args] = command.split(/\s+/)`.
   - Run via `promisify(execFileCb)(cmd, args, {cwd, timeout: 60_000})`.
   - On success: return `{ok: true}`.
   - On error: return `{ok: false, error: stderr or error message}`.
3. In the task loop, after implementation succeeds (exitCode === 0) and before the spec review dispatch:
   ```typescript
   const validationCmd = getConfig(ctx.cwd).validationCommand ?? "";
   const validation = await runValidation(validationCmd, ctx.cwd);
   if (!validation.ok) {
     const escalation = await escalate(task, `Validation failed: ${validation.error}`, ui, ctx.cwd, task.gitShaBeforeImpl);
     if (escalation === "abort") { state.error = "Aborted by user"; saveState(state, ctx.cwd); return state; }
     if (escalation === "skip") { task.status = "skipped"; saveState(state, ctx.cwd); continue; }
     task.status = "pending"; continue; // retry
   }
   ```
4. Import `getConfig` from `../../config.js`.

**Verification:** `npx vitest run src/workflow/phases/execute.test.ts`

---

## Batch D — Workflow UX

### Task 16: Add `onStreamEvent` wiring to brainstorm, plan-write, plan-review phases

**Write tests first** verifying `onStreamEvent` callback is forwarded to `dispatchAgent`, then modify the phase signatures. This is a single task because all three phases follow the identical pattern.

**Files:** `src/workflow/phases/brainstorm.ts`, `src/workflow/phases/plan-write.ts`, `src/workflow/phases/plan-review.ts`, `src/workflow/phases/brainstorm.test.ts`, `src/workflow/phases/plan-write.test.ts`, `src/workflow/phases/plan-review.test.ts`

**Test code (add to `src/workflow/phases/brainstorm.test.ts`):**
```typescript
it("forwards onStreamEvent callback to dispatchAgent", async () => {
  const { runBrainstormPhase } = await import("./brainstorm.js");
  const ctx = makeCtx(tmpDir);
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue("scout output");
  mockParseBrainstorm.mockReturnValue({
    status: "ok",
    data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
  } as any);
  ctx.ui.input.mockResolvedValue(undefined);

  const onStreamEvent = vi.fn();
  const state = makeState();
  await runBrainstormPhase(state, ctx, undefined, onStreamEvent);

  // dispatchAgent signature: (agent, task, cwd, signal?, onUpdate?, onStreamEvent?)
  // Verify the 6th arg (index 5) is defined for the scout dispatch
  const firstDispatchCall = mockDispatchAgent.mock.calls[0];
  expect(firstDispatchCall.length).toBeGreaterThanOrEqual(6);
  expect(firstDispatchCall[5]).toBeDefined();
});
```

**Test code (add to `src/workflow/phases/plan-write.test.ts`):**
```typescript
it("forwards onStreamEvent callback to dispatchAgent", async () => {
  const { runPlanWritePhase } = await import("./plan-write.js");
  const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

  mockDispatchAgent.mockImplementation(async () => {
    const planDir = path.join(tmpDir, "docs/plans");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, "2026-02-07-add-auth-plan.md"),
      "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```"
    );
    return makeDispatchResult();
  });

  const onStreamEvent = vi.fn();
  const state = makeState();
  await runPlanWritePhase(state, ctx, undefined, onStreamEvent);

  // dispatchAgent signature: (agent, task, cwd, signal?, onUpdate?, onStreamEvent?)
  const dispatchCall = mockDispatchAgent.mock.calls[0];
  expect(dispatchCall.length).toBeGreaterThanOrEqual(6);
  expect(dispatchCall[5]).toBeDefined();
});
```

**Test code (add to the existing `describe("runPlanReviewPhase")` block in `src/workflow/phases/plan-review.test.ts`):**
```typescript
it("forwards onStreamEvent callback to dispatchAgent", async () => {
  mockDiscoverAgents.mockReturnValue({
    agents: [makeAgent("architect"), makeAgent("planner")],
    projectAgentsDir: null,
  });
  mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
  mockGetFinalOutput.mockReturnValue(passReviewJson());

  const ctx = makeCtx();
  ctx.ui.select.mockResolvedValue("Approve");

  const onStreamEvent = vi.fn();
  const state = makeStateWithPlan();
  await runPlanReviewPhase(state, ctx, undefined, onStreamEvent);

  // With only one reviewer (architect), dispatchAgent is used (not dispatchParallel)
  // dispatchAgent signature: (agent, task, cwd, signal?, onUpdate?, onStreamEvent?)
  const dispatchCall = mockDispatchAgent.mock.calls[0];
  expect(dispatchCall.length).toBeGreaterThanOrEqual(6);
  expect(dispatchCall[5]).toBeDefined();
});
```

**Implementation for all three phases:**
- Add `onStreamEvent?: OnStreamEvent` parameter as 4th param after `signal` to `runBrainstormPhase`, `runPlanWritePhase`, `runPlanReviewPhase`.
- Import `OnStreamEvent` type from `../../dispatch.js`.
- Import `createActivityBuffer`, `formatToolAction` from `../ui.js`.
- Create activity buffer and `makeOnStream` handler (same pattern as `execute.ts`):
  ```typescript
  const activityBuffer = createActivityBuffer(10);
  const makeOnStream = (): OnStreamEvent => (event) => {
    if (event.type === "tool_execution_start") {
      const action = formatToolAction(event);
      activityBuffer.push(action);
      ui?.setStatus?.("workflow", action);
      ui?.setWidget?.("workflow-activity", activityBuffer.lines());
    }
  };
  ```
- Pass `undefined` as 5th arg (onUpdate) and `makeOnStream()` as 6th arg to every `dispatchAgent` call.
- For `dispatchParallel` calls (multi-reviewer case in plan-review): `dispatchParallel` doesn't support per-agent `onStreamEvent` — known limitation, no change needed there.

**Verification:** `npx vitest run src/workflow/phases/brainstorm.test.ts src/workflow/phases/plan-write.test.ts src/workflow/phases/plan-review.test.ts`

---

### Task 17: Add brainstorm skip option (item 3)

**Write test first** for the skip flow, then implement.

**Files:** `src/workflow/phases/brainstorm.ts`, `src/workflow/phases/brainstorm.test.ts`

**Test code (add to `src/workflow/phases/brainstorm.test.ts`):**
```typescript
it("offers skip option after scout completes and skips to plan-write", async () => {
  const { runBrainstormPhase } = await import("./brainstorm.js");
  const ctx = makeCtx(tmpDir);
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue("scout summary");

  // After scout, user selects "Skip to plan"
  ctx.ui.select.mockResolvedValueOnce("Skip to plan");

  const state = makeState({ brainstorm: { step: "scout" } });
  const result = await runBrainstormPhase(state, ctx);

  expect(result.brainstorm.step).toBe("done");
  expect(result.phase).toBe("plan-write");
  expect(result.brainstorm.scoutOutput).toBe("scout summary");
});

it("continues normal Q&A flow when user selects 'Continue Q&A'", async () => {
  const { runBrainstormPhase } = await import("./brainstorm.js");
  const ctx = makeCtx(tmpDir);
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue("scout summary");

  mockParseBrainstorm.mockReturnValue({
    status: "ok",
    data: { type: "questions", questions: [{ id: "q1", text: "Q?", type: "input" }] },
  } as any);

  // After scout, user selects "Continue Q&A", then cancels at first question
  ctx.ui.select.mockResolvedValueOnce("Continue Q&A");
  ctx.ui.input.mockResolvedValue(undefined);

  const state = makeState({ brainstorm: { step: "scout" } });
  const result = await runBrainstormPhase(state, ctx);

  expect(result.brainstorm.scoutOutput).toBe("scout summary");
  expect(mockParseBrainstorm).toHaveBeenCalled();
});
```

**Implementation:** In `runBrainstormPhase`, after scout dispatch completes and `state.brainstorm.scoutOutput` is set (currently the code immediately sets `state.brainstorm.step = "questions"`), insert a `ui.select` check before that assignment:

```typescript
// After setting scoutOutput
state.brainstorm.scoutOutput = getFinalOutput(result.messages);

// Offer skip option
const skipChoice = await ui?.select?.("Continue brainstorm or skip to planning?", ["Continue Q&A", "Skip to plan"]);
if (skipChoice === "Skip to plan") {
  state.brainstorm.step = "done";
  state.phase = "plan-write";
  saveState(state, ctx.cwd);
  return state;
}

state.brainstorm.step = "questions";
```

The key change: move `state.brainstorm.step = "questions"` to after the skip check, and only set it if user chooses "Continue Q&A".

**Verification:** `npx vitest run src/workflow/phases/brainstorm.test.ts`

---

### Task 18: Add plan file path fallback in `plan-write.ts` (item 6)

**Write test first**, then implement the fallback search.

**Files:** `src/workflow/phases/plan-write.ts`, `src/workflow/phases/plan-write.test.ts`

**Test code (add to `src/workflow/phases/plan-write.test.ts`):**
```typescript
it("falls back to searching docs/plans/ for recent design file when designPath is undefined", async () => {
  const { runPlanWritePhase } = await import("./plan-write.js");
  const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

  // Create a design file in docs/plans/
  const planDir = path.join(tmpDir, "docs/plans");
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "2026-02-07-auth-design.md"), "# Design\nSome design content");

  mockDispatchAgent.mockImplementation(async () => {
    fs.writeFileSync(
      path.join(planDir, "2026-02-07-auth-plan.md"),
      "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```"
    );
    return makeDispatchResult();
  });

  const state = makeState({ designPath: undefined, designContent: undefined });
  const result = await runPlanWritePhase(state, ctx);

  expect(result.tasks).toHaveLength(1);
  expect(result.phase).toBe("plan-review");
});

it("generates a date-based plan path when designPath is undefined and no design file found", async () => {
  const { runPlanWritePhase } = await import("./plan-write.js");
  const ctx = { cwd: tmpDir, hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as any;

  const today = new Date().toISOString().slice(0, 10);

  mockDispatchAgent.mockImplementation(async () => {
    const planDir = path.join(tmpDir, "docs/plans");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, `${today}-plan.md`),
      "```superteam-tasks\n- title: T\n  description: D\n  files: [a.ts]\n```"
    );
    return makeDispatchResult();
  });

  const state = makeState({ designPath: undefined, designContent: undefined });
  const result = await runPlanWritePhase(state, ctx);

  expect(result.planPath).toBeDefined();
  expect(result.planPath).toContain("plan.md");
});
```

**Implementation:** In `runPlanWritePhase`, before the plan path derivation, add fallback logic:

```typescript
// Fallback: if no designPath, search docs/plans/ for most recent *-design.md
if (!state.designPath && !state.designContent) {
  const plansDir = path.join(ctx.cwd, "docs/plans");
  try {
    const files = fs.readdirSync(plansDir)
      .filter(f => f.endsWith("-design.md"))
      .sort()
      .reverse();
    if (files.length > 0) {
      const designFile = files[0];
      state.designPath = `docs/plans/${designFile}`;
      state.designContent = fs.readFileSync(path.join(plansDir, designFile), "utf-8");
    }
  } catch {
    // docs/plans/ doesn't exist — continue with empty design
  }
}
```

This must be placed before the existing plan path derivation line so the discovered `designPath` feeds into plan path generation.

**Verification:** `npx vitest run src/workflow/phases/plan-write.test.ts`

---

## Task Dependency Summary

```
Batch A (sequential):
  Task 1 → Task 2 → Task 3 → Task 4 → Task 5

Batch B (mostly independent, internal order):
  Task 6 (independent)
  Task 7 (independent)
  Task 8 (independent)
  Task 9 (depends on Task 6: scout prompt narrowing assumes context.md injection is live)

Batch C (depends on Batch A completing):
  Task 10 (independent)
  Task 11 (independent)
  Task 12 (independent)
  Task 13 (depends on Task 12)
  Task 14 (depends on Task 11)
  Task 15 (depends on Task 10 and Task 14)

Batch D (independent of other batches):
  Task 16 (independent)
  Task 17 (independent)
  Task 18 (independent)
```

---

```superteam-tasks
- title: Create extractFencedBlock in parse-utils.ts
  description: >
    Write tests for generalized extractFencedBlock(text, language) in src/parse-utils.test.ts,
    then implement in src/parse-utils.ts. Uses the quote-aware scanning algorithm from
    brainstorm-parser.ts, generalized with a dynamic openPattern regex built from the language
    parameter. Tests cover superteam-brainstorm and superteam-json languages, quote-aware fence
    detection, nested fences inside JSON strings, missing closing fence, empty content, leading
    whitespace.
  files: [src/parse-utils.ts, src/parse-utils.test.ts]

- title: Add extractLastBraceBlock and sanitizeJsonNewlines to parse-utils.ts
  description: >
    Add tests for extractLastBraceBlock and sanitizeJsonNewlines to src/parse-utils.test.ts,
    then move those functions from brainstorm-parser.ts to parse-utils.ts. Tests cover nested
    braces, braces in strings, escaped quotes, unbalanced braces, newline sanitization inside
    and outside JSON strings.
  files: [src/parse-utils.ts, src/parse-utils.test.ts]

- title: Wire brainstorm-parser.ts to use parse-utils.ts
  description: >
    Replace local extractFencedBlock, extractLastBraceBlock, sanitizeJsonNewlines in
    brainstorm-parser.ts with imports from ../parse-utils.js. Pass 'superteam-brainstorm'
    as language. Delete local copies of all three functions. Verify existing
    brainstorm-parser.test.ts and brainstorm-parser.acceptance.test.ts still pass — purely
    structural extraction.
  files: [src/workflow/brainstorm-parser.ts]

- title: Wire review-parser.ts to use parse-utils.ts
  description: >
    Replace naive regex extractFencedBlock and local extractLastBraceBlock in review-parser.ts
    with imports from ./parse-utils.js. Add sanitizeJsonNewlines as a pre-parse step before
    JSON.parse in parseAndValidate (wrap jsonStr with sanitizeJsonNewlines). Create
    src/review-parser.test.ts (does not exist yet) with tests for literal newlines in JSON
    strings, triple-backtick inside JSON, and previously inconclusive outputs that now parse
    correctly.
  files: [src/review-parser.ts, src/review-parser.test.ts]

- title: Delete REVIEW_OUTPUT_FORMAT from prompt-builder.ts
  description: >
    Write tests asserting review prompts do NOT contain the duplicated IMPORTANT format
    instruction. Use path.dirname(new URL(import.meta.url).pathname) for ESM-safe path
    resolution (matching the pattern in src/config.ts — do NOT use __dirname, import.meta.dirname,
    or require()). Verify all 5 reviewer agent .md files contain the superteam-json format.
    Delete the REVIEW_OUTPUT_FORMAT constant and remove references from buildPlanReviewPrompt,
    buildSpecReviewPrompt, buildQualityReviewPrompt, buildFinalReviewPrompt. Delete these
    existing tests that will break: "mandates superteam-json output" tests in
    buildPlanReviewPrompt, buildSpecReviewPrompt, buildQualityReviewPrompt, buildFinalReviewPrompt
    describe blocks, and "mentions passed/findings/mustFix/summary fields" in buildPlanReviewPrompt.
  files: [src/workflow/prompt-builder.ts, src/workflow/prompt-builder.test.ts]

- title: Inject .pi/context.md into subagent prompts
  description: >
    Export buildSubprocessArgs with @internal JSDoc. Write tests in dispatch.test.ts using
    real tmpDirs (not mocked fs). buildSubprocessArgs does NOT add --append-system-prompt for
    the agent's own system prompt (that's done later in runAgent), so any --append-system-prompt
    in the returned args comes solely from context.md injection. Test with .pi/context.md
    present (verify arg and resolved path), absent (verify no --append-system-prompt), and for
    non-implementer agents. Implement by checking fs.existsSync for .pi/context.md after the
    implementer-specific block and appending to args.
  files: [src/dispatch.ts, src/dispatch.test.ts]

- title: Add test-file instruction to buildSpecReviewPrompt
  description: >
    Write test asserting buildSpecReviewPrompt output contains instruction to not review
    test files unless task explicitly targets test code. Add the instruction line between
    the "Read these files" and "Do NOT trust" lines in the prompt builder function.
  files: [src/workflow/prompt-builder.ts, src/workflow/prompt-builder.test.ts]

- title: Add bash to security-reviewer tools
  description: >
    Add assertion in dispatch.test.ts verifying security-reviewer.md has bash in its tools
    frontmatter. Use path.dirname(new URL(import.meta.url).pathname) for ESM-safe path
    resolution (matching src/config.ts pattern — do NOT use __dirname, import.meta.dirname,
    or require()). Change tools line from 'read,grep,find,ls' to 'read,grep,find,ls,bash'
    in agents/security-reviewer.md (line 4 of frontmatter).
  files: [agents/security-reviewer.md, src/dispatch.test.ts]

- title: Narrow scout prompt
  description: >
    Replace the entire existing buildScoutPrompt describe block in prompt-builder.test.ts
    (old tests assert "key files", "directory structure", "structured summary" which won't
    match the narrowed prompt). New tests verify: includes cwd, instructs to read context.md,
    asks for tech stack/directory/entry points/test conventions, limits to 500 words. Replace
    buildScoutPrompt implementation with the narrowed 3-line version.
  files: [src/workflow/prompt-builder.ts, src/workflow/prompt-builder.test.ts]

- title: Add validationCommand to SuperteamConfig
  description: >
    Write test verifying default validationCommand is 'tsc --noEmit' using
    getConfig("/nonexistent-path-for-test", true) to force cache reload. Add validationCommand
    optional string field to SuperteamConfig interface and DEFAULT_CONFIG.
  files: [src/config.ts, src/config.test.ts]

- title: Add resetToSha and squashCommitsSince to git-utils.ts
  description: >
    Write tests using temp git repos. Reuse existing makeTempRepo/makeTempDir/getCurrentSha
    helpers and import execFile/promisify at module top level (matching existing test patterns).
    Test resetToSha (reset to previous commit, empty SHA, invalid SHA, non-repo) and
    squashCommitsSince (squash multiple commits, no-op when baseSha equals HEAD, non-repo).
    Implement both functions with proper error handling.
  files: [src/workflow/git-utils.ts, src/workflow/git-utils.test.ts]

- title: Add summary field to TaskExecState
  description: >
    Write tests verifying TaskExecState accepts optional summary with title, status,
    changedFiles. Add the summary type to orchestrator-state.ts.
  files: [src/workflow/orchestrator-state.ts, src/workflow/orchestrator-state.test.ts]

- title: Add previousTaskSummary to buildImplPrompt
  description: >
    Write tests for buildImplPrompt with and without previousTaskSummary parameter.
    Add optional third parameter to buildImplPrompt that appends a '## Previous task'
    section with title, status, and changed files. Existing callers pass only 2 args
    so backward compatible.
  files: [src/workflow/prompt-builder.ts, src/workflow/prompt-builder.test.ts]

- title: Add rollback option to escalate in execute.ts
  description: >
    Update the existing vi.mock for git-utils.js to include resetToSha. Add mockResetToSha
    ref. Write test verifying Rollback is offered in escalation select alongside
    Retry/Skip/Abort, and that resetToSha is called with the saved SHA. Import resetToSha
    from git-utils. Update escalate signature to accept cwd. When Rollback selected,
    call resetToSha then return retry. Update all escalate call sites to pass ctx.cwd.
  files: [src/workflow/phases/execute.ts, src/workflow/phases/execute.test.ts]

- title: Add validation gate before reviews in execute.ts
  description: >
    Export a testable runValidation(command, cwd) function with @internal JSDoc that returns
    {ok, error?}. Write direct tests: "true" command succeeds, "false" command fails, empty
    string skips. Write integration test verifying task completes normally (default behavior).
    In the task loop, after implementation succeeds and before spec review, read
    validationCommand from getConfig(ctx.cwd), call runValidation. On failure, enter
    escalation. Import getConfig from ../../config.js, execFile from node:child_process,
    promisify from node:util.
  files: [src/workflow/phases/execute.ts, src/workflow/phases/execute.test.ts]

- title: Add onStreamEvent wiring to brainstorm, plan-write, plan-review
  description: >
    Write tests in brainstorm.test.ts, plan-write.test.ts, and the EXISTING plan-review.test.ts
    (it already has 10+ tests with helpers makeAgent, makeDispatchResult, passReviewJson,
    makeCtx, makeStateWithPlan — add to existing describe block, do NOT recreate file).
    Verify onStreamEvent callback is forwarded to dispatchAgent calls (check 6th positional
    arg at index 5 is defined). Add onStreamEvent parameter as 4th param after signal to
    runBrainstormPhase, runPlanWritePhase, runPlanReviewPhase. Import OnStreamEvent type
    from ../../dispatch.js, createActivityBuffer and formatToolAction from ../ui.js. Create
    activity buffer and makeOnStream handler matching execute.ts pattern. Pass undefined as
    5th arg (onUpdate) and makeOnStream() as 6th arg to all dispatchAgent calls.
  files: [src/workflow/phases/brainstorm.ts, src/workflow/phases/plan-write.ts, src/workflow/phases/plan-review.ts, src/workflow/phases/brainstorm.test.ts, src/workflow/phases/plan-write.test.ts, src/workflow/phases/plan-review.test.ts]

- title: Add brainstorm skip option
  description: >
    Write tests for skip flow: after scout, user selects 'Skip to plan' via ui.select →
    state transitions to plan-write with step='done' and scoutOutput preserved. Also test
    'Continue Q&A' proceeds to normal Q&A flow (mockParseBrainstorm gets called). Implement
    by adding ui.select("Continue brainstorm or skip to planning?", ["Continue Q&A",
    "Skip to plan"]) after scout dispatch completes and scoutOutput is set, before setting
    step to "questions". Move the step="questions" assignment to after the skip check. If
    skip, set step="done" and phase="plan-write", save state and return early.
  files: [src/workflow/phases/brainstorm.ts, src/workflow/phases/brainstorm.test.ts]

- title: Add plan file path fallback in plan-write.ts
  description: >
    Write tests for fallback when designPath is undefined: (1) search docs/plans/ for most
    recent *-design.md by name (sorted descending), read its content, set both designPath
    and designContent on state, verify tasks are parsed and phase transitions to plan-review.
    (2) When no design file found and designPath is undefined, use date-based plan path.
    Implement fallback search logic before the existing planPath derivation line so
    discovered designPath feeds into the existing path generation logic.
  files: [src/workflow/phases/plan-write.ts, src/workflow/phases/plan-write.test.ts]
```
