# Implementation Plan: v0.3 Batch 1 (Foundations)

## Overview

This plan implements the 6 deliverables from `docs/v0.3-spec.md` Batch 1 (Foundations), focusing on prerequisite fixes, streaming feedback, role separation, reviewer write-guards, targeted plan revision, and new config keys.

Total: **10 implementation tasks**, each 2–5 minutes.

---

## Batch 1 — Foundations

### Task 1: Fix AT-7 (Brainstorm acceptance test)

**Modify** `src/workflow/phases/brainstorm.acceptance.test.ts` to add the missing mock for `ui.select` handling the "Start brainstorm" / "Skip brainstorm" prompt. This unblocks the acceptance test suite.

**Files:** `src/workflow/phases/brainstorm.acceptance.test.ts`

**Implementation:**
In the test setup or specific test case, ensure `ui.select` is mocked to return a valid choice for the initial prompt.

**Verification:** `npx vitest run src/workflow/phases/brainstorm.acceptance.test.ts`

---

### Task 2: Add v0.3 config keys

**Write test first**, then add the new keys to `SuperteamConfig`.

**Files:** `src/config.ts`, `src/config.test.ts`

**Test code (`src/config.test.ts`):**
```typescript
import { getConfig } from "./config.js";

describe("v0.3 config keys", () => {
  it("supports new keys in SuperteamConfig", () => {
    const config = getConfig("/nonexistent", true);
    // Defaults
    expect(config.testCommand).toBeUndefined();
    expect(config.validationCadence).toBeUndefined();
    expect(config.validationInterval).toBeUndefined();
    expect(config.budgetCheckpointUsd).toBeUndefined();
    expect(config.gitIgnorePatterns).toBeUndefined();
  });
});
```

**Implementation:** Add `testCommand?: string`, `validationCadence?: "every" | "every-N" | "on-demand"`, `validationInterval?: number`, `budgetCheckpointUsd?: number`, `gitIgnorePatterns?: string[]` to `SuperteamConfig` interface in `src/config.ts`.

**Verification:** `npx vitest run src/config.test.ts`

---

### Task 3: Streaming feedback (Brainstorm)

**Write test first** verifying `onStreamEvent` is passed to `dispatchAgent`.

**Files:** `src/workflow/phases/brainstorm.ts`, `src/workflow/phases/brainstorm.test.ts`

**Test code (add to `src/workflow/phases/brainstorm.test.ts`):**
```typescript
it("forwards onStreamEvent callback to dispatchAgent", async () => {
  const { runBrainstormPhase } = await import("./brainstorm.js");
  const ctx = makeCtx(tmpDir);
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  mockGetFinalOutput.mockReturnValue("scout output");
  const onStreamEvent = vi.fn();
  
  // Trigger scout dispatch
  await runBrainstormPhase(makeState(), ctx, undefined, onStreamEvent);

  // Check dispatchAgent call (6th arg)
  const dispatchCall = mockDispatchAgent.mock.calls[0];
  expect(dispatchCall[5]).toBeDefined();
});
```

**Implementation:** Add `onStreamEvent` parameter to `runBrainstormPhase`. Pass it to `dispatchAgent`.

**Verification:** `npx vitest run src/workflow/phases/brainstorm.test.ts`

---

### Task 4: Streaming feedback (Plan-Write)

**Write test first** verifying `onStreamEvent` is passed to planner dispatch.

**Files:** `src/workflow/phases/plan-write.ts`, `src/workflow/phases/plan-write.test.ts`

**Test code (add to `src/workflow/phases/plan-write.test.ts`):**
```typescript
it("forwards onStreamEvent callback to dispatchAgent", async () => {
  const { runPlanWritePhase } = await import("./plan-write.js");
  const ctx = makeCtx(tmpDir);
  mockDispatchAgent.mockResolvedValue(makeDispatchResult());
  const onStreamEvent = vi.fn();

  await runPlanWritePhase(makeState(), ctx, undefined, onStreamEvent);

  const dispatchCall = mockDispatchAgent.mock.calls[0];
  expect(dispatchCall[5]).toBeDefined();
});
```

**Implementation:** Add `onStreamEvent` parameter to `runPlanWritePhase`. Pass it to `dispatchAgent`.

**Verification:** `npx vitest run src/workflow/phases/plan-write.test.ts`

---

### Task 5: Streaming feedback (Plan-Review)

**Write test first** verifying `onStreamEvent` wiring in review phase.

**Files:** `src/workflow/phases/plan-review.ts`, `src/workflow/phases/plan-review.test.ts`

**Test code (add to `src/workflow/phases/plan-review.test.ts`):**
```typescript
it("forwards onStreamEvent callback to dispatchAgent", async () => {
  mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
  const ctx = makeCtx();
  ctx.ui.select.mockResolvedValue("Approve");
  const onStreamEvent = vi.fn();

  await runPlanReviewPhase(makeStateWithPlan(), ctx, undefined, onStreamEvent);

  const dispatchCall = mockDispatchAgent.mock.calls[0];
  expect(dispatchCall[5]).toBeDefined();
});
```

**Implementation:** Add `onStreamEvent` parameter to `runPlanReviewPhase`. Pass it to `dispatchAgent` (for planner/single reviewer) and ensure `dispatchReviewers` handles parallel dispatch correctly (note: `dispatchParallel` might not support per-agent streams yet, but we ensure the *interface* is correct).

**Verification:** `npx vitest run src/workflow/phases/plan-review.test.ts`

---

### Task 6: Reviewer write-guard: `hasWriteToolCalls`

**Write tests first**, then implement the utility.

**Files:** `src/dispatch.ts`, `src/dispatch.test.ts`

**Test code (add to `src/dispatch.test.ts`):**
```typescript
import { hasWriteToolCalls } from "./dispatch.js";

describe("hasWriteToolCalls", () => {
  it("returns true for write_file tool call", () => {
    const msgs = [{ role: "assistant", toolCalls: [{ function: { name: "write_file" } }] }];
    expect(hasWriteToolCalls(msgs as any)).toBe(true);
  });

  it("returns true for bash command with write op", () => {
    const msgs = [{ role: "assistant", toolCalls: [{ function: { name: "bash", arguments: '{"command":"echo x > y"}' } }] }];
    expect(hasWriteToolCalls(msgs as any)).toBe(true);
  });

  it("returns false for read-only tools", () => {
    const msgs = [{ role: "assistant", toolCalls: [{ function: { name: "read_file" } }] }];
    expect(hasWriteToolCalls(msgs as any)).toBe(false);
  });
});
```

**Implementation:** Export `hasWriteToolCalls(messages: Message[]): boolean`. Check for `write_file`, `replace_in_file`. For `bash`, check regex for write ops (`>`, `sed -i`, `mv`, `cp`, `rm`).

**Verification:** `npx vitest run src/dispatch.test.ts`

---

### Task 7: Reviewer write-guard: Integration

**Write test first**, then integrate check into review loop.

**Files:** `src/workflow/phases/plan-review.ts`, `src/workflow/phases/plan-review.test.ts`

**Test code (add to `src/workflow/phases/plan-review.test.ts`):**
```typescript
it("re-dispatches if reviewer attempts to write", async () => {
  mockDispatchAgent
    .mockResolvedValueOnce(makeDispatchResult("architect", { toolCalls: [{ function: { name: "write_file" } }] })) // First attempt writes
    .mockResolvedValueOnce(makeDispatchResult("architect", { toolCalls: [] })); // Retry behaves

  const ctx = makeCtx();
  ctx.ui.select.mockResolvedValue("Approve");
  
  await runPlanReviewPhase(makeStateWithPlan(), ctx);
  
  // Should have called dispatch twice
  expect(mockDispatchAgent).toHaveBeenCalledTimes(2);
});
```

**Implementation:** In `runPlanReviewPhase` loop, check `hasWriteToolCalls(result.messages)`. If true, `ui.notify` warning, discard result, retry (once).

**Verification:** `npx vitest run src/workflow/phases/plan-review.test.ts`

---

### Task 8: Role separation prompts

**Verify via grep/test**, then update prompts.

**Files:** `agents/spec-reviewer.md`, `agents/architect.md`, `agents/planner.md`

**Test (grep check):**
```bash
grep "You MUST NOT modify any files" agents/spec-reviewer.md
grep "Apply targeted patches" agents/planner.md
```

**Implementation:**
- Update `agents/spec-reviewer.md`, `agents/architect.md`: Explicitly forbid code modifications.
- Update `agents/planner.md`: Instruct to apply targeted patches based on findings, preserving task IDs.

**Verification:** Manual verification.

---

### Task 9: Targeted plan revision prompt

**Write test first**, then implement builder.

**Files:** `src/workflow/prompt-builder.ts`, `src/workflow/prompt-builder.test.ts`

**Test code (add to `src/workflow/prompt-builder.test.ts`):**
```typescript
import { buildTargetedPlanRevisionPrompt } from "./prompt-builder.js";

describe("buildTargetedPlanRevisionPrompt", () => {
  it("instructs to edit only mentioned tasks", () => {
    const prompt = buildTargetedPlanRevisionPrompt("plan", "findings", "design");
    expect(prompt).toContain("edit only the tasks mentioned");
    expect(prompt).toContain("findings");
  });
});
```

**Implementation:** Export `buildTargetedPlanRevisionPrompt`. Include instructions: "Edit only the tasks mentioned in findings. Do not rewrite other tasks. Preserve task IDs."

**Verification:** `npx vitest run src/workflow/prompt-builder.test.ts`

---

### Task 10: Targeted revision integration

**Write test first**, then integrate into plan-review.

**Files:** `src/workflow/phases/plan-review.ts`, `src/workflow/phases/plan-review.test.ts`

**Test code (add to `src/workflow/phases/plan-review.test.ts`):**
```typescript
it("uses targeted revision prompt when findings exist", async () => {
  // Setup reviewer rejection
  mockDispatchAgent.mockResolvedValue(makeDispatchResult("architect"));
  mockGetFinalOutput.mockReturnValue(failReviewJson());
  
  // Setup planner revision
  mockDispatchAgent.mockResolvedValue(makeDispatchResult("planner"));
  
  const ctx = makeCtx();
  ctx.ui.select.mockResolvedValue("Approve"); // Approve after revision
  
  await runPlanReviewPhase(makeStateWithPlan(), ctx);
  
  // Verify planner dispatch used targeted prompt (inspect call args if possible, or mocked builder)
});
```

**Implementation:** Replace usage of `buildPlanRevisionPromptFromFindings` with `buildTargetedPlanRevisionPrompt`. Implement convergence logic: if findings persist after N cycles, escalate.

**Verification:** `npx vitest run src/workflow/phases/plan-review.test.ts`

---

```superteam-tasks
- title: Fix AT-7 regression (Brainstorm acceptance test)
  description: >
    Add missing mock for ui.select handling "Start brainstorm" / "Skip brainstorm" in
    src/workflow/phases/brainstorm.acceptance.test.ts. This unblocks the acceptance test suite.
  files: [src/workflow/phases/brainstorm.acceptance.test.ts]

- title: Add v0.3 config keys
  description: >
    Add testCommand, validationCadence, validationInterval, budgetCheckpointUsd, gitIgnorePatterns
    to SuperteamConfig in src/config.ts. No schema validation, just fields. Test via src/config.test.ts.
  files: [src/config.ts, src/config.test.ts]

- title: Streaming feedback (Brainstorm)
  description: >
    Verify and ensure onStreamEvent is passed to every dispatchAgent call in
    src/workflow/phases/brainstorm.ts. Add test ensuring callback is wired.
  files: [src/workflow/phases/brainstorm.ts, src/workflow/phases/brainstorm.test.ts]

- title: Streaming feedback (Plan-Write)
  description: >
    Wire onStreamEvent into the planner dispatch in src/workflow/phases/plan-write.ts.
    Test via src/workflow/phases/plan-write.test.ts.
  files: [src/workflow/phases/plan-write.ts, src/workflow/phases/plan-write.test.ts]

- title: Streaming feedback (Plan-Review)
  description: >
    Wire onStreamEvent into reviewer and planner revision dispatches in src/workflow/phases/plan-review.ts.
    Verify parallel dispatch handling works correctly. Test via src/workflow/phases/plan-review.test.ts.
  files: [src/workflow/phases/plan-review.ts, src/workflow/phases/plan-review.test.ts]

- title: Reviewer write-guard (hasWriteToolCalls)
  description: >
    Implement hasWriteToolCalls(messages: Message[]): boolean in src/dispatch.ts. Scans messages
    for tool calls to write, edit, or bash with write operations. Test with mock messages.
  files: [src/dispatch.ts, src/dispatch.test.ts]

- title: Reviewer write-guard integration
  description: >
    In src/workflow/phases/plan-review.ts, check hasWriteToolCalls after dispatch. If true,
    log warning and re-dispatch (once). If repeated, escalate. Test with mock reviewer.
  files: [src/workflow/phases/plan-review.ts, src/workflow/phases/plan-review.test.ts]

- title: Role separation prompts
  description: >
    Update agents/spec-reviewer.md and agents/architect.md to scope feedback to structure/completeness
    (NO inline code fixes). Update agents/planner.md to use targeted patches. Verify via grep test.
  files: [agents/spec-reviewer.md, agents/architect.md, agents/planner.md]

- title: Targeted plan revision prompt
  description: >
    Implement buildTargetedPlanRevisionPrompt(planContent, findings, designContent) in
    src/workflow/prompt-builder.ts. Instructs planner to edit only tasks mentioned in findings.
  files: [src/workflow/prompt-builder.ts, src/workflow/prompt-builder.test.ts]

- title: Targeted revision integration
  description: >
    In src/workflow/phases/plan-review.ts, replace buildPlanRevisionPromptFromFindings calls
    with buildTargetedPlanRevisionPrompt. Add convergence check (escalate after N cycles).
  files: [src/workflow/phases/plan-review.ts, src/workflow/phases/plan-review.test.ts]
```
