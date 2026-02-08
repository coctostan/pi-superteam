# Review: Superteam Implementation Plan (2026-02-06)

**Reviewed file:** `docs/plans/2026-02-06-superteam-implementation.md`

## Executive summary

The plan is directionally strong and largely feasible in pi: it correctly leverages **extensions** for enforcement/UI and **skills/prompts** for “soft” methodology, and it uses **JSON-mode subprocesses** for subagents (consistent with pi examples).

However, several parts of the plan overstate capabilities or leave enforcement gaps that undermine the headline goal (“workflow enforcement … as a unified system”). The biggest issues are:

- **TDD hard enforcement does not apply to subagents** under the current design (prompt-only ≠ enforcement).
- The **TDD guard is bypassable** unless it covers *all* mutation paths (`edit`, and file-mutating `bash` patterns) and accounts for `user_bash`.
- The **rule engine injection model** is described as “system-level”, but in pi the `context` hook modifies message lists; extension-injected messages are effectively user-context.
- The **JSON event parsing** described doesn’t match pi’s documented JSON event names and should be aligned with `message_end` / `tool_execution_*`.

If the above are addressed early, the rest of the architecture is a solid foundation.

---

## Criteria-based review

### 1) General veracity & effectiveness

**What’s accurate / good**
- “Extension-skill hybrid” is the right mental model for pi.
- Tool-call interception for enforcement is a real mechanism (`tool_call` can block).
- Subprocess subagents via `pi --mode json -p --no-session` is consistent with pi’s own subagent example.
- Persisting state via `pi.appendEntry()` and reconstructing from the session branch is aligned with pi’s session model.

**Veracity gaps**
- **Rule injection as “system-level message”**: pi’s `context` event lets you modify `messages`; it does not let you add true system-role messages into the message list. “Custom” messages injected by extensions are converted into **user** messages for LLM context.
- **“read-only bash”**: pi’s built-in `bash` tool is not read-only. If you grant `bash`, you are granting mutation capability unless you wrap/override/gate it.
- **JSON event names**: docs show `tool_execution_start|update|end` events, and messages arrive via `message_end`. The plan’s `tool_result_end` name appears in the example but is not in the JSON docs; relying on undocumented event names is risky.

**Effectiveness gaps**
- The current design explicitly removes hard enforcement from subagents, which materially reduces overall workflow correctness.

### 2) Performance

- Parallel reviewer dispatch can create significant **token/cost fan-out**. The plan acknowledges cost controls but doesn’t schedule them as a first-class milestone.
- Rule engine trigger scanning “recent assistant messages” is cheap, but must be implemented carefully to avoid regex backtracking and to avoid injecting too many rule blocks.
- LSP diagnostics can be expensive/noisy; delegating to `lsp-pi` is fine, but you need graceful fallback when it is missing.

### 3) Durability (correctness over time / session tree / compaction)

- Pi sessions are trees; users can `/tree` and branch. Any persisted workflow state must be **branch-derived** (event sourced from `ctx.sessionManager.getBranch()`), not “global session state”.
- Maps in state interfaces (`Map<string, …>`) are not JSON-serializable without conversion.
- Auto-compaction may remove older rationale from context; your enforcement relies more on tool interception than on long context, which is good.

### 4) Portability

- Hotkeys like `Ctrl+Alt+T` can be unreliable across terminals/OS.
- Model IDs in agent profiles are aspirational; actual installed providers differ. Portability improves if agent profiles specify a *role* and allow model fallback.
- Depending on a separately installed package (`lsp-pi`) reduces out-of-the-box portability unless handled gracefully.

### 5) Security

- Allowing `.pi/agents/` discovery creates a repo-controlled prompt execution surface. A compromised repo can modify agent definitions.
- Subagents run as full local processes with your permissions. Project-local agent prompts should be treated like running repo code.

---

## Engineering principles (YAGNI / DRY / SOLID / KISS)

### KISS
- The plan is mostly KISS-friendly: it sequences work reasonably and keeps core modules small.
- Risk: `src/index.ts` is positioned as a “do everything” module. It may become a god object unless it remains a thin composition root.

### SOLID
- Good separation between dispatch, guard, rules, and state.
- Danger: workflow state + orchestration logic + UI rendering can collapse into one module; keep orchestration separate from persistence and separate from rendering.

### DRY
- Reviewer prompts will likely repeat checklists; consider a shared template and parameterize by reviewer type.

### YAGNI
- Some items (worktrees, full TUI renderers, rich widgets) can be deferred.
- Cost controls, however, are not YAGNI—they’re essential once you enable multi-agent review loops.

---

## Triage of findings

### High severity (address before/early in implementation)

#### H1) Hard TDD enforcement does not apply to subagents
**Issue:** Subagents run in separate `pi -p` processes and (per plan) do not load the extension, so enforcement is prompt-only.

**Why it matters:** This contradicts the goal of “workflow enforcement” and will produce non-deterministic compliance.

**Recommendations (pick one):**
1. **Run subagents with the extension enabled** (spawn with `--extension` / package resources) so `tool_call` blocks apply in subagent sessions too.
2. Make subagents **read-only / proposal-only**, returning diffs/patches; apply changes in the main session where enforcement runs.
3. If you keep prompt-only, change the product claim to “guidance” for subagents.

#### H2) TDD guard bypasses: `edit`, file-mutating `bash`, and `user_bash`
**Issue:** The guard design focuses on `write` and parsing `tool_result(bash)` test runs.

**Problems:**
- `edit` can mutate implementation files (must be guarded).
- `bash` can mutate files (redirects, heredocs, `sed -i`, etc.). If the agent has `bash`, enforcement is bypassable.
- User-run `!` / `!!` commands emit `user_bash` events, not tool results, so test-state tracking will be incomplete.

**Recommendations:**
- Guard **both** `write` and `edit` tool calls.
- Decide a stance on `bash`:
  - Either accept that `bash` can mutate and implement additional `tool_call` blocking heuristics for dangerous patterns, or
  - Provide a “test-runner” tool and disable `bash` for the implementer in enforced mode.
- Track test executions from both `tool_result` and `user_bash`.

#### H3) Rule engine injection model is described inaccurately
**Issue:** Plan says rules inject “system-level message” on next turn.

**Reality:** In pi, `context` handlers return modified message lists; extension-injected `custom` messages become user-context for the LLM.

**Recommendations:**
- Implement rule injection as a **`custom` message** (or synthetic user message) appended late in context for recency.
- Update plan language to avoid promising system-role injection.

#### H4) Dispatcher JSON parsing should align to documented events
**Issue:** Plan relies on `message_end` and `tool_result_end`.

**Recommendations:**
- Treat `message_end` as the canonical stream for conversation capture.
- Use `tool_execution_end` if you need tool summaries.
- Ignore the initial `session` header line.

#### H5) “Read-only bash” is not a supported capability as stated
**Issue:** Reviewer agents are described as having “read-only bash”.

**Recommendations:**
- Remove bash from reviewer profiles by default, or
- Add a gated bash wrapper that enforces an allowlist and blocks redirections and file mutations.

---

### Medium severity (important; can iterate but should be planned)

#### M1) Configuration strategy is underspecified
The plan proposes storing config under a `superteam` namespace in pi settings, but extension `ctx` does not provide a settings accessor.

**Recommendations:**
- Choose a clear config mechanism:
  - dedicated `.pi/superteam.json`, or
  - instantiate `SettingsManager` inside the extension, or
  - store config in session entries + expose via `/superteam-settings`.

#### M2) Orchestration robustness requires structured reviewer outputs
Freeform reviewer prose will make fix loops brittle and expensive.

**Recommendations:**
- Require reviewers to output a strict JSON/YAML block: `passed`, `findings[]`, `mustFix`, `summary`.
- Validate/sanitize outputs before deciding next step.

#### M3) Plan parsing from “free-form markdown” will be fragile
Parsing “### Task N” sections and numbered lists is easy to break.

**Recommendations:**
- Either define a minimal structured format, or
- make the “writing-plans” skill produce a machine-parseable task list block.

#### M4) Session tree semantics must be handled explicitly
State reconstruction should use `ctx.sessionManager.getBranch()` and handle `session_tree` events.

#### M5) Optional dependency (`lsp-pi`) needs graceful fallback
If `lsp` tool isn’t available, security/perf reviewers should still work.

---

### Low severity (polish / future hardening)

- Hotkey portability: keep slash commands primary.
- Use state versioning (`stateVersion`) for migrations.
- Keep `src/index.ts` a composition root; avoid a large monolith.
- Normalize “ATDD warns vs blocks” behavior and document consistent semantics.

---

## “This would be really cool to add” (optional, high leverage)

1. **Proposal-only subagents (patch/diff output):** subagents return a patch + commands; main session applies under guard.
2. **Git checkpoints/branches per task:** improves rollback, auditability, and trust.
3. **Workflow dashboard widget:** task status + reviews + last test result + cost usage.
4. **CI-mode / pre-merge verification:** run a configured suite before marking tasks complete.
5. **Rule bundles (“profiles”):** enable different rule sets per project type.

---

## Suggested plan adjustments (concrete)

If you want the smallest set of changes that makes the plan true to its goals:

1. **Change the enforcement story for subagents** (enable extension for subagents or make them proposal-only).
2. **Expand TDD guard coverage** to include `edit`, handle `user_bash`, and decide how to treat `bash`-based file mutation.
3. **Align rule engine to pi’s message model** (custom/user-context injection, not system-role).
4. **Align dispatcher parsing** to JSON mode docs (`message_end`, `tool_execution_*`).
5. **Remove/replace “read-only bash”** claims unless you implement it.

These changes increase correctness, security, and durability without substantially increasing complexity.
