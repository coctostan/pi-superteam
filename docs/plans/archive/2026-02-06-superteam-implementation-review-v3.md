# Review (v3): Superteam Implementation Plan (2026-02-06)

**Reviewed file:** `docs/plans/2026-02-06-superteam-implementation.md` (latest)

## Executive summary

This iteration is a major improvement over v2 on the exact weak spots previously called out:

- **Deterministic subprocesses** are now a first-class design constraint, using `--no-extensions --no-skills --no-prompt-templates` and only adding back explicit extensions/skills. That’s the single biggest portability + security win.
- The plan now includes a real **config subsystem** (`src/config.ts`, `.superteam.json`, TypeBox validation, versioning) and explicitly defines the **impl→test mapping** that the guard needs.
- The TDD guard semantics are now much more *usable*: it enforces the *mechanical minimum* (“tests exist + have been run”), and explicitly avoids blocking the **REFACTOR** phase.
- You added an explicit **escape hatch** for bash file mutation (`/tdd allow-bash-write once <reason>`), which is the right “pragmatic safety valve”.
- Rule engine + review parser design is clearer and more KISS/SOLID (central parser module, bounded regex scanning, clear frequency semantics).

At this point the plan is largely implementable as written.

The remaining **big correctness gap** is that the plan *also* states that with deterministic isolation, **superteam’s guard will not run inside implementer subagents**, while those subagents still have `write/edit/bash` access to the real repo. That creates an enforcement bypass for the SDD loop and undermines the “hard enforcement” claim whenever work is delegated to subagents.

---

## Criteria review

### 1) Veracity & effectiveness

**Strong / accurate**
- CLI flags cited (`--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--tools`, `--append-system-prompt`) align with pi’s CLI.
- JSON mode event names (`message_end`, `tool_execution_end`, etc.) are aligned with pi docs.
- Rule injection semantics are described correctly: injected messages are **user-context** (custom), not true system-role.

**Potentially incorrect / underspecified**
- **Skill loading in isolated subagents:** pi’s CLI `--skill` flag takes a **path** (file/dir), not a “skill name”. In an isolated subagent run with `--no-skills`, you must pass an explicit skill file path (e.g. `<package>/skills/test-driven-development/SKILL.md`).
- **Tracking user `!npm test` runs:** `user_bash` is a *pre-execution* hook; there is no “user_bash_result” event. If you want to update guard state from user-initiated test runs, you must either:
  - override execution in the `user_bash` handler (return `result`), or
  - wrap `operations` to intercept outputs.

### 2) Performance

- Rule scanning is bounded (last N chars) and regexes are compiled once: good.
- Parallel optional reviews are cost-heavy but now properly governed by **warn + hard limit + mid-stream abort**.
- The plan is careful about streaming (`onUpdate`) and structured parsing to reduce “LLM-in-the-loop parsing” overhead.

### 3) Durability

- Session persistence via `pi.appendEntry(customType, data)` is the right mechanism for extension state.
- JSON-serializable state shapes avoid common persistence footguns.
- The plan adds clear parse contracts for plans (` ```superteam-tasks` fenced YAML) + a heuristic fallback.

### 4) Portability

- `.superteam.json` is cross-platform, repo-local, and versionable.
- Deterministic subprocesses reduce “it works on my machine” extension/skill leakage.
- LSP is truly optional and only enabled explicitly in subagents.

### 5) Security

- Deterministic subprocesses are a **huge** security improvement (no implicit global/project extension execution).
- Reviewer toolsets are genuinely read-only (`read/grep/find/ls`).

Primary remaining security concern: giving an implementer subagent `bash` in the *real repo* means prompt-injection in repo text can potentially cause destructive shell actions. Your design reduces the attack surface by isolating extensions, but it does **not** remove the inherent “LLM with bash” risk.

---

## Principles check (YAGNI / DRY / SOLID / KISS)

### KISS
- Clear win: explicit boundaries (`dispatch`, `config`, `guard`, `rules`, `state`, `parser`, `sdd`), plus a thin `index.ts`.
- Guard semantics are simplified to “tests exist + have been run”, pushing nuanced discipline into skills/rules.

### SOLID
- `src/config.ts` owning config concerns is a good SRP move.
- `review-parser.ts` as a single module prevents schema drift across reviewers.

### DRY
- Structured reviewer JSON avoids re-parsing prose.
- Central parser + schema prevents N slightly-different parsers.

### YAGNI
- Worktrees are deferred: good.
- Optional LSP integration is kept optional and isolated: good.
- Some features (widgets + custom renderers + hotkey) are correctly scheduled late.

---

## Findings triage

### High severity

#### H1) SDD implementer subagent bypasses “hard” TDD enforcement
**What the plan says:** deterministic isolation means superteam guard does **not** run inside subagents, and that this is “the correct design”.

**Why this is a problem:** your SDD loop dispatches an implementer subagent that (per agent profile) has `write/edit/bash` and runs in the real project directory. Without the extension running in that subprocess, **nothing prevents it from writing implementation before tests** (or doing any other workflow-violating edit). The review cycle may catch issues later, but that is *not enforcement*.

**Recommendation (pick one, but pick explicitly):**
1. **Guarded subagents:** spawn implementer subagents with `-e <path-to-superteam>` so the same tool-call guard runs in their process too. (Still deterministic, because you explicitly load only superteam.)
2. **Proposal-only implementer (recommended):** make implementer subagents read-only and require them to output a patch/unified diff + commands; then the **main guarded session** applies edits via `write/edit` under the TDD guard.
3. **Sandbox repo:** run implementers in a temporary clone/worktree and apply via patch after review.

If you do not address this, the central claim “extension enforces methodology (hard blocks)” is only true for the main session, not for the feature that most needs it (SDD delegation).

#### H2) `--skill test-driven-development` is not a valid portable invocation
In isolated mode (`--no-skills`), `--skill` needs a file or directory path. Treating skills as “named resources” will break portability.

**Recommendation:** store absolute (or package-relative) skill paths in dispatch config, e.g. `--skill ${packageDir}/skills/test-driven-development/SKILL.md`.

### Medium severity

#### M1) User-initiated test runs (`!npm test`) require explicit capture strategy
The plan’s guard wants to observe `user_bash` results. That likely requires wrapping `BashOperations` via the `user_bash` hook.

**Recommendation:** document the chosen approach and add an explicit implementation task note (because it’s non-obvious and easy to miss).

#### M2) “Files changed” should not be trusted to subagent self-report
The orchestration loop describes implementer returning changed files. That’s useful but not reliable.

**Recommendation:** have the main extension compute file changes itself (e.g. `git diff --name-only` before/after dispatch, or snapshot-based comparison if git absent) and pass the computed list to reviewers.

#### M3) Alternative isolation strategies mention flags that may not exist
The fallback “`--config-dir /tmp/...`” is not a documented pi CLI flag.

**Recommendation:** either remove it, or replace with real alternatives (e.g. env-based agent dir overrides if available) once you verify what pi supports.

### Low severity

- Plan parsing fallback (headings) is a reasonable convenience but should remain “best effort” only.
- Hotkey is fine as a convenience since slash commands are primary.
- Consider adding `--no-themes` for full subprocess determinism (minor, but consistent).

---

## This would be really cool to add

1. **Default proposal-only SDD**: implementer outputs patch + test commands; main session applies under guard. This would make “hard enforcement” actually hold under delegation.
2. **Safe test runner tool**: keep reviewers no-bash, but allow an orchestrator-controlled `run-tests` tool with an allowlist from `.superteam.json`.
3. **Repo safety rails for bash**: optional “dangerous command” confirmation (e.g. block `rm -rf`, `curl | sh`, writing outside repo root) when TDD mode is on.
4. **Diff-based reviewer scoping**: automatically focus reviewers on touched files + relevant tests.

---

## Net assessment

This plan is now coherent, portable, and very close to buildable in pi’s actual extension model.

To make the “hard enforcement” story true end-to-end, you need one explicit decision: either load the guard extension in implementer subagents, or switch implementers to proposal-only/sandbox mode. Everything else is now mostly implementation detail and verification.
