# Review (v2): Superteam Implementation Plan (2026-02-06)

**Reviewed file:** `docs/plans/2026-02-06-superteam-implementation.md` (updated)

## Executive summary

This revision is materially stronger than the original. It directly addresses many of the earlier high-risk gaps:

- Adds explicit **design constraints** (thin `index.ts`, standalone-first `team`, graceful degradation, branch-aware state).
- Makes the TDD guard far more realistic by covering **`write` + `edit` + `user_bash`** and adding a **bash file-mutation heuristic**.
- Fixes veracity around rule injection: rules are injected as **`custom` user-context**, not “system-role”.
- Introduces deterministic orchestration via **structured reviewer JSON output**.
- Introduces a durable plan contract via a **machine-parseable YAML task block**.
- Drops the misleading “read-only bash for reviewers”.
- Treats **subagent enforcement** as an explicit unknown, with a verification task and a contingency (“proposal-only mode”).

Remaining risks are now narrower and mostly around: (1) **subprocess determinism/security** (what extensions/skills load inside subagents), (2) the **TDD enforcement semantics** (refactor phase / avoiding false blocks), and (3) a couple of minor veracity/implementation details.

---

## Criteria review

### 1) General veracity & effectiveness

**Improved / correct in this revision**
- **Branch-aware state**: explicitly event-sourced from `ctx.sessionManager.getBranch()`.
- **Rule engine injection**: correctly describes `custom` message injection late in context.
- **JSON parsing**: now acknowledges actual JSON event names and explicitly verifies during Task 1.
- **Review loops**: structured findings contract is a major effectiveness win.

**Still questionable / needs clarification**
- **Subagent extension loading**: The plan correctly treats this as uncertain and schedules verification. Good.
- **LSP availability check wording**: the plan mentions `ctx.tools?.has("lsp")`. In pi’s extension API, `ExtensionContext` does **not** expose a `tools` set. Tool availability is usually controlled by:
  - built-in tools via `--tools` (built-ins only), and
  - extension tools by whether the extension that registers them is loaded.

  Practically: don’t design around `ctx.tools` existing; design around explicit subprocess flags.

### 2) Performance

- **Cost controls** are now first-class (`warnAtUsd`, `hardLimitUsd`). That’s necessary, not optional.
- Parallel review fan-out is still potentially expensive; structured JSON parsing reduces orchestration overhead and rework.
- Regex triggers for rules: safe if you limit scanning to the last N assistant messages/characters and compile regexes once.

### 3) Durability

- Event-sourced state + JSON-serializable types (`Record` instead of `Map`) is the right approach.
- YAML task block reduces fragility of plan parsing.
- Still missing: explicit handling notes for `session_tree` / `session_switch` beyond “branch-aware design” prose. (Likely fine in implementation, but worth calling out as an explicit requirement.)

### 4) Portability

- `.superteam.json` is a portable, explicit configuration mechanism. Good.
- Hotkey remains a portability footgun; you already position it as convenience-only.
- Model fallback strategy helps portability across environments with different providers.

### 5) Security

**Improved**
- Project agent discovery requires **trust confirmation**.
- Reviewers are read-only (no bash), reducing accidental mutation.

**Still a concern (subprocess determinism)**
- A spawned `pi` subprocess, by default, will discover and run:
  - global extensions (`~/.pi/agent/extensions`)
  - project extensions (`.pi/extensions`)
  - packages from settings

  This is both a **security** and a **correctness** risk: subagents may run with unexpected extensions active (including potentially repo-controlled ones) and with different toolsets than you intended.

  This is not theoretical; it directly impacts your “does superteam load in subagents?” question and can cause flakiness.

---

## Principles (YAGNI / DRY / SOLID / KISS)

### KISS
- Strong improvement: explicit “thin composition root” constraint.
- Orchestration extracted into `src/workflow/sdd.ts` is good modularity.

Main KISS risk remaining: TDD enforcement semantics can become complex if you try to perfectly model RED/GREEN/REFACTOR from tool events.

### SOLID
- Modules are now clearly delineated: dispatch / guard / rules / state / orchestration.
- Add one more “boundary”: a small `config.ts` module to resolve `.superteam.json` (project root discovery, schema validation, defaults) so config concerns don’t leak into every module.

### DRY
- Structured reviewer output is DRY-friendly (shared schema, shared parsing).
- Consider centralizing the reviewer JSON schema + parser in one module; don’t re-implement per reviewer type.

### YAGNI
- Worktrees are correctly deferred.
- Proposal-only mode is gated behind a verified need. Good.
- LSP integration is optional. Good.

---

## Findings triage

### High severity

#### H1) Subagent process determinism: you must control which extensions load
**What changed:** The plan now recognizes uncertainty about extension loading. Good.

**What’s still missing:** A deterministic stance.

If you spawn `pi --mode json -p --no-session` *without* `--no-extensions`, you’re implicitly allowing:
- global extensions,
- project extensions,
- package-provided extensions (including `lsp-pi`),

…to run inside your subagent process. That makes subagent behavior environment-dependent and can be a security hazard.

**Recommendation:** Make subprocess invocation explicit and deterministic:
- Default to `--no-extensions --no-skills --no-prompt-templates --no-themes` in subprocesses.
- Then add back exactly what you want via explicit flags:
  - `-e` superteam (if you want enforcement in subagents)
  - `--skill` only for implementer (as you already decided)
  - optionally `-e npm:lsp-pi` if you truly want LSP inside subagents

This single choice improves: security, portability, reproducibility, and makes the “does extension load?” question moot.

#### H2) TDD guard semantics likely block legitimate REFACTOR phase (usability risk)
Current policy: “block impl writes unless a failing test has been recorded.”

That enforces **RED → GREEN** but not **REFACTOR** (which happens after tests pass). In real TDD, refactoring is allowed with tests green.

**Why this matters:** If refactoring is blocked, users/agents will toggle TDD off (defeating the feature).

**Recommendation:** Define an explicit “refactor allowance” that is still enforceable:
- Allow impl `write/edit` if either:
  1) last relevant test run **failed** (RED), or
  2) last relevant test run **passed** and the change is labeled “refactor” (via a lightweight command `/tdd refactor on|off` that times out after N minutes/turns, and forces a test run at the end).

Even a simple “refactor window” will dramatically improve adoption.

#### H3) Bash mutation heuristic is helpful but can create false negatives/positives
You correctly call it “not airtight”. Still, it will be the main bypass surface.

**Risks:**
- False negatives: `python -c` writing files, `perl -pi`, `apply_patch`, generated code tools, etc.
- False positives: commands that include `>` in strings or examples.

**Recommendation:**
- Keep the heuristic, but also provide a **user-visible escape hatch** that is auditable, e.g. `/tdd allow-bash-write once <reason>`.
- Consider a stronger default stance: in TDD mode, implementer subagents should ideally prefer `write/edit` over bash redirections; use guard messaging to steer.

#### H4) LSP tool availability check is currently not implementable as written
The plan’s “`ctx.tools?.has('lsp')`” check is not an API pi exposes.

**Recommendation:**
- Treat LSP tool availability as “whether the `lsp-pi` extension is loaded in this process.”
- For the main session, you can decide to *not care*; the tool will appear if installed.
- For subprocesses, if you want determinism, explicitly add `-e npm:lsp-pi` (or don’t attempt to use LSP in subagents at all).

---

### Medium severity

#### M1) Implementation detail missing: mapping impl files → test files
The guard logic depends on “corresponding test file exists for this module,” but there is no defined mapping algorithm.

**Recommendation:** Document and implement a conservative mapping strategy:
- same directory: `foo.ts` → `foo.test.ts` / `foo.spec.ts`
- sibling `__tests__`: `src/x/foo.ts` → `src/x/__tests__/foo.test.ts`
- configurable overrides per project via `.superteam.json`

Without an explicit mapping, you’ll get frequent false blocks.

#### M2) YAML task block contract needs clear delimiters
The plan says “machine-parseable YAML block at end of plan”. In practice you need deterministic extraction.

**Recommendation:** Require a fenced block, e.g.
```markdown
```superteam-tasks
- id: 1
  title: ...
```
```
so extraction is robust and doesn’t accidentally parse other YAML.

#### M3) Cost hard limit enforcement must happen before dispatch and during streaming
You added cost settings, but enforcement behavior is not specified.

**Recommendation:**
- Before dispatch: if projected cost budget exceeded → confirm/deny.
- During dispatch streaming: if hard limit hit → abort subprocess and mark as cancelled.

#### M4) Proposal-only mode is the right contingency, but define the artifact format now
If you implement proposal-only, define the output contract early:
- unified diff
- list of files affected
- commands to run

Otherwise you’ll burn time on prompt tuning later.

---

### Low severity

- Hotkey portability: fine since it’s optional.
- `team` tool as standalone-first is great; just ensure the schema stays stable.
- Consider versioning `.superteam.json` (`configVersion`) for future migrations.

---

## “This would be really cool to add”

1. **Constrained `run-tests` tool**: reviewers remain no-bash, but the orchestrator can still validate with a safe allowlist.
2. **Patch-based implementer by default** (even if extensions load in subagents): reduces risk and keeps the guard authoritative.
3. **Workflow dashboard widget**: current task, review status, last test run, cost-to-date.
4. **Git checkpoints**: optional “commit after green” automation to make review cycles safer.

---

## Net assessment

This revision is a big step forward on veracity, durability, and KISS/SOLID. The remaining major decision is whether you want subagent subprocesses to be **deterministic and explicitly configured** (recommended) or to inherit whatever extensions happen to be installed (fragile).

If you lock down subprocess extension loading (H1) and add a minimal refactor allowance to the TDD guard (H2), the plan becomes both implementable and likely to be used rather than toggled off.
