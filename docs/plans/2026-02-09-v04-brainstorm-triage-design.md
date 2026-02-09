# Design: v0.4 — Brainstorm Triage & Scope Management

**Branch:** TBD (create from main)
**Depends on:** v0.3.0 (merged to main)
**Milestone:** v0.4 per [ROADMAP.md](../ROADMAP.md)

---

## Motivation

The brainstorm phase is a form, not a conversation. Users can't push back on questions, discuss tradeoffs for approaches, or go back to revisit earlier answers. Every spec — trivial or complex — goes through the same ceremony. Broad specs produce monolithic 20-task plans that should have been chunked or split.

v0.4 makes brainstorm the intelligence layer: it determines how much process a change needs, whether scope should be chunked, and whether independent pieces should split into separate workflows. All decisions are collaborative with the user.

**Priority ordering:** interaction depth (biggest pain) → triage → scope management.

---

## Core Interaction Model

### Conversation Loop

Replace the linear form (generate questions → answer each → pick approach → approve sections) with a **present → react** cycle at every step:

1. Brainstormer presents its output (questions, approaches, or design section)
2. User picks from a menu: **answer/choose**, **discuss this**, **go back**, **skip/done**
3. **"Discuss"** dispatches the brainstormer with the full conversation history + the user's comment, gets a response, re-presents the updated output
4. **"Go back"** returns to the previous step with answers preserved

### Conversation History Replay (not persistent sessions)

Each "discuss" round dispatches a new brainstormer subprocess with the accumulated conversation history replayed in the prompt. This avoids needing a persistent subprocess with piped stdin — the current dispatch infrastructure is unchanged.

**Why not a persistent subprocess:** The dispatch infrastructure would need a new mode (piped stdin, keep-alive, message framing). That's a cross-cutting change affecting all agents. Conversation history replay gets us conversational brainstorming now with minimal architectural risk. For typical brainstorm sessions (3-5 discussion rounds), replay overhead is negligible.

---

## Conversation History & State

### Data Model

```typescript
type ConversationEntry = {
  role: "brainstormer" | "user";
  step: BrainstormStep;       // which step this happened in
  content: string;            // what was said
};

// Added to BrainstormState:
conversationLog?: ConversationEntry[];
complexityLevel?: "straightforward" | "exploration" | "complex";
```

Every brainstormer dispatch and every user comment appends to the `conversationLog`. When the brainstormer is dispatched for a discussion round, the prompt includes the relevant conversation history — filtered to the current step plus any prior steps the user navigated back from.

### Prompt Construction

A new `buildBrainstormConversationalPrompt(state, userComment?)` handles discussion rounds. It assembles:

1. Scout output (always)
2. User description (always)
3. Current step instruction ("generate revised questions" / "revise approaches" / etc.)
4. Conversation log (filtered, capped at ~3000 words)
5. Current answers/selections so far
6. User's latest comment if this is a "discuss" round

The existing per-step prompt builders (`buildBrainstormQuestionsPrompt`, etc.) still handle the *initial* generation for each step. The conversational prompt handles *revisions* triggered by discussion.

### Cost

Brainstorm conversations are short — typically 2-4 discussion rounds per step, a few sentences each. Even a deep session adds ~2-3k tokens of history. Scout output is already the largest chunk in every prompt.

### Persistence

The conversation log is part of `BrainstormState`, persisted to `.superteam-workflow.json`. Resuming mid-brainstorm restores full conversation context.

---

## Triage — Adjusting Process Depth

### New Sub-Step

After the scout completes, the brainstormer proposes a complexity level:

- **Straightforward** — focused change, clear path. Skips questions and approaches, generates a lightweight 1-2 section design outline, user confirms, moves to planning.
- **Needs exploration** — meaningful design choices. Normal flow: questions → approaches → design.
- **Complex** — multiple systems, competing tradeoffs. More questions (5-7 vs 3-5), deeper design sections.

### User Interaction

Replaces the current binary "Start brainstorm / Skip brainstorm":

```
Brainstormer assessment: Straightforward
"This is a focused change — add ANSI stripping to the review parser.
 Clear path, no design choices needed."

> Agree — quick design outline / Override — needs exploration /
  Override — complex / Discuss / Skip to planning
```

**"Discuss"** works like every other step — user comments, brainstormer revises its assessment.

### Implementation

- New `BrainstormStep` value: `"triage"` (between `"scout"` and `"questions"`)
- Brainstormer returns `type: "triage"` response: `{level, reasoning, suggestedSkips}`
- `complexityLevel` on `BrainstormState` determines:
  - How many questions to request
  - Whether approaches step runs or brainstormer picks one
  - Design section depth (brief vs detailed)

---

## Interaction UI Per Step

### Questions

Present all questions at once as a numbered list:

```
Questions from brainstormer:
  1. [unanswered] What persistence layer do you want?
  2. [unanswered] Should this support real-time updates?
  3. [answered: PostgreSQL] What's the auth model?

> Answer question 1 / Answer question 2 / ... / Discuss / Done
```

- Picking a question shows its options (choice-type) or opens text input
- **"Discuss"** — user types a comment ("question 2 doesn't make sense, we don't need real-time"), brainstormer returns revised question set. Already-answered questions keep their answers unless brainstormer explicitly replaces them.
- **"Done"** moves forward. Unanswered questions become "user deferred — use your best judgment."

### Approaches

Same pattern. Show all approaches with recommendation:

- **Pick one** — select and advance
- **Discuss** — "what if we combined A and B?" or "approach 2 won't work because X"
- **Go back to questions** — returns to question list with answers preserved

### Design Sections

Presented one at a time (current behavior works well). Menu per section:

- **Approve** — move to next section
- **Revise** — give specific feedback, brainstormer revises (current behavior)
- **Discuss** — multi-turn before committing to revision direction
- **Go back to previous section**
- **Go back to approaches**

---

## Scope Management

### Where It Happens

Triage is the natural place. The brainstormer already has scout output and user description. If it detects breadth, the triage response includes scope recommendations alongside complexity.

### Chunking (Sequential Batches)

When the spec is broad but cohesive, brainstormer proposes batch boundaries:

```
This is broad. I'd suggest 2 batches:
  Batch 1: Test baseline + failure taxonomy (infrastructure)
  Batch 2: Cross-task validation + wiring into execute (depends on batch 1)
```

Each batch gets its own plan → review → execute → reassess cycle. After batch 1 completes, the orchestrator pauses:

```
Batch 1 complete. Continue to batch 2 / Adjust scope / Stop here
```

The brainstormer re-scouts before batch 2 to account for what changed.

**State changes:**
- `OrchestratorState` gets `batches?: Array<{title, description, status}>` and `currentBatchIndex?: number`
- Orchestrator loops plan-write → execute per batch with reassess checkpoint between

### Splitting (Independent Workflows)

When the spec contains genuinely unrelated pieces, brainstormer proposes a split:

```
These are independent. I'd run them as separate workflows:
  Workflow A: New API endpoint
  Workflow B: CLI help refactor
```

User confirms. Orchestrator saves current workflow, queues the second, runs them sequentially (parallel workflows are out of scope).

**State changes:**
- Queue file `.superteam-workflow-queue.json` lists pending workflows
- Each gets its own full `OrchestratorState`
- Orchestrator processes queue in order

Both chunking and splitting are discussable — "I think batch 1 and 2 should be combined" triggers a brainstormer re-assessment.

---

## Deliverables — Ordered by Dependency

### D1. Conversation History Infrastructure
`ConversationEntry` type, `conversationLog` on `BrainstormState`, `buildBrainstormConversationalPrompt`. No UI changes yet — data model and prompt builder only.

**Files:** `orchestrator-state.ts`, `prompt-builder.ts`

### D2. Triage Step
New `"triage"` brainstorm step, `type: "triage"` brainstormer response format, `complexityLevel` on state. Replaces the current binary skip/start select. Wired into `brainstorm.ts` between scout and questions.

**Files:** `orchestrator-state.ts`, `brainstorm.ts`, `brainstorm-parser.ts`, `prompt-builder.ts`

### D3. Conversational Questions
Replace one-at-a-time question flow with "present all, pick one, discuss, done" menu. Discussion dispatches brainstormer with conversation history, gets revised questions. Go-back from approaches returns here.

**Files:** `brainstorm.ts`, `prompt-builder.ts`

### D4. Conversational Approaches
Same pattern: show all, pick, discuss, go back to questions.

**Files:** `brainstorm.ts` (additive)

### D5. Conversational Design
Add "discuss" option alongside approve/revise. Go-back to approaches or previous section.

**Files:** `brainstorm.ts` (additive)

### D6. Chunking
Triage proposes batches, `batches` + `currentBatchIndex` on state, orchestrator loops per batch with reassess checkpoint.

**Files:** `orchestrator-state.ts`, `orchestrator.ts`, `brainstorm.ts`

### D7. Splitting
Triage proposes split, queue file, orchestrator processes sequentially.

**Files:** `orchestrator.ts`, new `workflow-queue.ts`

---

## Testing

- **Unit tests** for conversational prompt builder (assembles correct context, caps history, filters by step)
- **Unit tests** for triage parsing (brainstormer returns triage JSON, parser extracts level + scope)
- **Unit tests** for state transitions (go-back preserves answers, complexity level affects step flow, batch index advances correctly)
- **Acceptance tests** for full brainstorm flow: mock brainstormer responses + mock UI interactions, verify conversation log accumulates and correct prompts are built
- **Acceptance test** for chunking: mock triage response proposing 2 batches, verify orchestrator runs plan-write → execute twice with reassess between

---

## What's NOT Changing

- Dispatch infrastructure — no persistent subprocesses, no new spawn mode
- Execute phase — untouched
- Review system — untouched
- Agent markdown files — `brainstormer.md` gets a new `type: "triage"` format section, otherwise unchanged

---

## Design Principle: Reviews Always Run

Per the roadmap: all reviewers always run on every task, full set. Small changes make for small reviews — they pass quickly. The quality bar doesn't drop for small changes; the process scales down in brainstorm and planning, not in verification.

---

## Ships When

- Brainstorm triage proposes complexity level; user confirms or overrides; process depth adjusts accordingly
- User can discuss questions, approaches, and design sections with multi-turn back-and-forth
- User can go back to any previous brainstorm step with answers preserved
- A broad spec is chunked into batches with per-batch plan-execute-reassess cycles
- Independent pieces can split into separate workflow runs
