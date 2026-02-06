# Superteam Implementation Plan

> **Goal:** A single pi package that provides TDD/ATDD workflow enforcement, specialized agent dispatch with per-agent model configuration, iterative review cycles, LSP-powered feedback, and TTSR-like context rules — all working as a unified system. Every piece is independently useful and can be toggled off without affecting the others.

**Architecture:** Extension-skill hybrid. Skills teach methodology (soft guidance the agent reads on-demand). Extension code enforces methodology (hard blocks via `tool_call` interception), dispatches specialized subagents (via `pi -p --mode json` subprocesses), and injects context rules. LSP integration is delegated to the existing `lsp-pi` npm package (optional dependency — everything works without it).

**Tech Stack:** TypeScript extension for pi-coding-agent, markdown skills/agents/rules, `lsp-pi` for LSP (optional).

---

## Design Constraints

1. **Every piece is independently useful.** TDD guard works without SDD. Agent dispatch works without TDD. Skills work without the extension. SDD is opt-in via `/sdd`, never automatic.

2. **The `team` tool is a first-class standalone tool, not SDD plumbing.** A user must be able to say "dispatch security-reviewer and performance-reviewer in parallel on src/auth/" without ever touching SDD. SDD uses `team` internally, but `team`'s API is designed for direct human use first.

3. **`src/index.ts` is a thin composition root.** It wires subsystems together but contains no business logic. Orchestration, guard, rules, dispatch, config, and state each live in their own module.

4. **Graceful degradation.** Missing `lsp-pi` → reviewers work without LSP tool. SDD flaky → disable it, keep everything else. Agent model unavailable → fall back to default model.

5. **Branch-aware state.** All persisted workflow state is event-sourced from the session branch (`ctx.sessionManager.getBranch()`), not global. Branching mid-workflow produces correct independent state per branch.

6. **Deterministic subprocesses.** Subagent pi processes are spawned with `--no-extensions --no-skills --no-themes` (or equivalent isolation flags), then only the explicitly needed extensions/skills are added back. No implicit inheritance of environment extensions. This eliminates security risk from repo-controlled extensions and makes behavior reproducible across environments.

7. **End-to-end TDD enforcement.** The TDD guard runs in both the main session AND implementer subagents. Implementer subagents are spawned with `-e <path-to-superteam-extension>` so the guard boots fresh in their process and enforces test-first discipline mechanically. This makes the "hard enforcement" claim true under delegation, not just in the main session. Reviewer/scout subagents don't need the guard (they can't write files).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    User Session (pi)                     │
│                                                         │
│  Skills (markdown, loaded on-demand by agent)           │
│  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐  │
│  │   TDD   │ │   ATDD   │ │ Plans  │ │     SDD      │  │
│  └─────────┘ └──────────┘ └────────┘ └──────────────┘  │
│                                                         │
│  Extension (TypeScript, always active)                  │
│  ┌──────────────────┬──────────────────────────────┐    │
│  │  TDD Guard       │  Rule Engine                 │    │
│  │  (tool_call)     │  (context injection)         │    │
│  ├──────────────────┼──────────────────────────────┤    │
│  │  Agent Dispatcher │  Workflow State              │    │
│  │  (spawn pi -p)   │  (plan tracking, widgets)    │    │
│  ├──────────────────┼──────────────────────────────┤    │
│  │  Config          │  Review Parser               │    │
│  │  (.superteam.json│  (structured JSON extraction) │    │
│  └──────────────────┴──────────────────────────────┘    │
│          │                                              │
│          │ spawns (deterministic, isolated)              │
│          ▼                                              │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Subagent Instances (isolated pi -p processes)  │    │
│  │  --no-extensions --no-skills --no-themes          │    │
│  │  + explicit add-back per agent type               │    │
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────┐ │    │
│  │  │Implementer │ │Spec Reviewer │ │Quality Rev│ │    │
│  │  │(+guard ext)│ │(read-only)   │ │(read-only)│ │    │
│  │  │(+TDD skill)│ │              │ │           │ │    │
│  │  └────────────┘ └──────────────┘ └───────────┘ │    │
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────┐ │    │
│  │  │Security Rev│ │ Perf Reviewer│ │  Scout    │ │    │
│  │  │(read-only) │ │ (read-only)  │ │(fast,bash)│ │    │
│  │  └────────────┘ └──────────────┘ └───────────┘ │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  External (optional): lsp-pi — installed separately     │
│  via `pi install npm:lsp-pi`. Composes via pi's event   │
│  system with zero code coupling.                        │
└─────────────────────────────────────────────────────────┘
```

---

## Component Inventory

### 1. Extension Core (`src/index.ts`)

**Purpose:** Thin composition root. Wires all subsystems together, registers tools/commands/shortcuts, subscribes to events. Contains no business logic — delegates to dispatch, guard, rules, config, review parser, and state modules.

**Registers:**
- `team` tool — dispatch agents (single, parallel, chain modes). Standalone-first design.
- `/tdd` command — toggle TDD enforcement on/off. Subcommands: `/tdd on`, `/tdd off`, `/tdd status`, `/tdd allow-bash-write once <reason>`
- `/atdd` command — toggle ATDD mode (acceptance tests before unit tests)
- `/sdd` command — start subagent-driven-development for a plan file
- `/team` command — show agent status, list available agents
- `/superteam init` command — create `.superteam.json` with defaults in project root
- `Ctrl+Alt+T` shortcut — toggle TDD enforcement (slash commands are primary; hotkey is convenience)
- Status widget — TDD mode indicator, plan progress
- Event subscriptions — `tool_call`, `tool_result`, `context`, `before_agent_start`, `session_start`, `turn_end`, `agent_end`, `session_shutdown`

**Dependencies:** All other src/ modules. Imports and wires them; does not contain their logic.

### 2. Config (`src/config.ts`)

**Purpose:** Resolve, validate, and provide access to `.superteam.json` configuration. Single module that owns all config concerns so they don't leak into other modules.

**Responsibilities:**
- Discover `.superteam.json` in project root (walk up from cwd)
- Merge with defaults for missing fields
- Validate schema (TypeBox)
- Provide typed accessor: `getConfig()` → `SuperteamConfig`
- Handle `configVersion` for future migrations

**Config schema:**
```typescript
interface SuperteamConfig {
  configVersion: 1;
  tddMode: "off" | "tdd" | "atdd";

  // File mapping
  testFilePatterns: string[];         // ["*.test.ts", "*.spec.ts", "__tests__/*.ts"]
  acceptanceTestPatterns: string[];   // ["*.acceptance.test.ts", "*.e2e.test.ts"]
  testCommands: string[];             // ["npm test", "bun test", "npx jest", "npx vitest"]
  exemptPaths: string[];              // ["*.d.ts", "*.config.*", "migrations/*"]

  // Impl → test file mapping overrides
  testFileMapping: {
    // Mapping strategies applied in order; first match wins
    strategies: Array<
      | { type: "suffix"; implSuffix: string; testSuffix: string }     // foo.ts → foo.test.ts
      | { type: "directory"; testDir: string }                          // src/x/foo.ts → src/x/__tests__/foo.test.ts
      | { type: "mirror"; srcRoot: string; testRoot: string }           // src/x/foo.ts → tests/x/foo.test.ts
    >;
    // Explicit overrides: impl path → test path
    overrides: Record<string, string>;
  };

  // Review
  review: {
    maxIterations: number;            // 3
    required: string[];               // ["spec", "quality"]
    optional: string[];               // ["security", "performance"]
    parallelOptional: boolean;        // true
    escalateOnMaxIterations: boolean; // true
  };

  // Agents
  agents: {
    defaultModel: string;             // "claude-sonnet-4-5"
    scoutModel: string;               // "claude-haiku-4-5"
    modelOverrides: Record<string, string>;  // agent name → model
  };

  // Cost controls
  costs: {
    warnAtUsd: number;                // 5.00
    hardLimitUsd: number;             // 20.00
  };
}
```

### 3. Agent Dispatcher (`src/dispatch.ts`)

**Purpose:** Spawn pi subprocesses with specific model/tools/system-prompt configurations. Collect structured results. **Designed for direct human use via the `team` tool**, not just as SDD infrastructure.

**Subprocess isolation:** All subagents are spawned with explicit isolation:
```bash
# Base isolation (all agents)
pi --mode json -p --no-session \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  --model <model> \
  --tools <tools> \
  --append-system-prompt <prompt-file>

# Implementer adds: TDD guard extension + TDD skill
  -e <packageDir>/src/index.ts \
  --skill <packageDir>/skills/test-driven-development/SKILL.md

# Security/performance reviewers add: lsp-pi (if installed)
  -e npm:lsp-pi
```

**`--skill` takes a file path**, not a skill name. In isolated mode (`--no-skills`), pi doesn't resolve skills by name. The dispatcher must use the absolute path to the skill file within the package directory.

**Implementer gets the guard extension** (`-e <packageDir>/src/index.ts`). The guard boots fresh in the subprocess — no inherited state from the main session. It tracks the implementer's test writes and runs independently, enforcing TDD from scratch. This is what makes "hard enforcement" true under SDD delegation.

**Note on isolation flags:** The exact flags (`--no-extensions`, `--no-skills`, `--no-themes`, `--no-prompt-templates`) must be verified against pi's actual CLI during Task 1. If pi doesn't support these flags, alternatives:
1. Use environment variables to disable extension/skill loading if supported
2. Accept implicit loading but document the behavior gap

This is a Task 1 verification item.

**`packageDir` resolution:** The dispatcher needs the on-disk path to the superteam package for `-e` and `--skill` flags. Resolution strategy:
- Use `import.meta.dirname` (or `__dirname`) to get the extension source directory
- Walk up to find `package.json` → that's `packageDir`
- Must work in both local dev (`pi -e ./src/index.ts`) and installed package (`pi install ...`) modes
- Verified during Task 1

**Key functions:**
- `discoverAgents(searchPaths)` → `Agent[]` — load agent `.md` files, parse frontmatter
- `dispatchAgent(config, task, options)` → `Promise<AgentResult>`
- `dispatchParallel(configs[], tasks[], options)` → `Promise<AgentResult[]>`
- `dispatchChain(steps[], options)` → `Promise<AgentResult>`

**Agent discovery:** Load `.md` files from:
1. Package's own `agents/` directory (bundled agents)
2. User's `~/.pi/agent/agents/` (user-level)
3. Project `.pi/agents/` (project-level, with trust confirmation)

Frontmatter defines name, description, model, tools. Body is the system prompt.

**Trust policy for project agents:** Project-level agents (`.pi/agents/`) require trust confirmation before loading. When `ctx.hasUI === false` (print mode, subagent processes), project agents are **not loaded** by default — only package-bundled and user-level agents are available. This prevents untrusted repo content from influencing subagent behavior.

**Model fallback:** If a specified model isn't available, fall back to the configured `defaultModel` in `.superteam.json` and warn.

**Streaming updates:** Uses `onUpdate` callback to stream partial results to the `team` tool's renderer.

**JSON event parsing:** Align to actual event names from pi's JSON mode stdout. Verify during Task 1 — likely `message_end`, `tool_execution_end`. Follow the existing subagent example's parsing code as reference.

**Cost tracking and enforcement:**
- Track cumulative cost across all dispatches in the session
- Before each dispatch: check projected cost against `costs.warnAtUsd` → warn user if exceeded
- Before each dispatch: check against `costs.hardLimitUsd` → block dispatch and require user override
- During streaming: if hard limit hit mid-stream → abort subprocess (SIGTERM), mark as cancelled, report partial results

### 4. TDD Guard (`src/workflow/tdd-guard.ts`)

**Purpose:** Enforce test-driven development via hard tool_call interception.

**Modes:**
- **Off** — no enforcement (default)
- **TDD** — block writes to implementation files that have no test file or whose tests have never been run
- **ATDD** — like TDD, but also requires acceptance test before unit tests for each feature

#### Guard Semantics (revised)

The guard enforces the **mechanical minimum**: tests must exist and must have been executed. The RED→GREEN→REFACTOR ideal is taught by skills and rules, not enforced by the guard.

**Why:** A strict "must have failing test" guard blocks the REFACTOR phase (which happens with tests passing) and blocks adding test coverage to existing code. This creates false positives that make users toggle TDD off — defeating the feature. Three-layer defense is better:
- **Guard** ensures: test file exists, tests have been run
- **Skills** teach: RED→GREEN→REFACTOR discipline
- **Rules** catch: rationalizations for skipping tests

```
tool_call(write OR edit) for impl file
  → Is TDD enabled?
    → Is file in exemptPaths? → ALLOW
    → Does a test file exist for this module? (use mapping algorithm)
      → Has any test been run for this module? (pass or fail)
        → ALLOW (agent is in GREEN or REFACTOR phase)
      → No test has been run
        → BLOCK: "TDD: Run your tests first. Test file exists ({testFile})
                  but has never been executed. Run tests to verify your
                  RED→GREEN cycle."
    → No test file exists
      → BLOCK: "TDD: Create a test file first. Expected: {expectedTestFile}
                Write a failing test, run it, then implement."

tool_call(write OR edit) for test file
  → Always ALLOW (this IS the test-first step)

tool_call(bash) for file-mutating commands
  → Heuristic check for: >, >>, sed -i, tee, mv, cp (with dest),
    echo/printf ... > file, cat ... > file, heredoc redirects
  → If target matches impl file patterns AND TDD enabled:
    → Is there a one-time bash-write allowance? (from /tdd allow-bash-write)
      → ALLOW, consume the allowance, log the reason
    → Otherwise:
      → BLOCK: "TDD: Use write/edit tool instead of bash file mutation.
                This ensures TDD enforcement can track your changes."
  → If no file-mutation pattern detected: ALLOW
  → Note: heuristic, not airtight. Catches ~95% of accidental bypasses.
    Agent is lazy, not adversarial. Rule engine catches rationalizations.

tool_result(bash) for test commands
  → Parse exit code and output to determine pass/fail
  → Update test state: { file, passed: bool, timestamp }

user_bash events (pre-execution hook — no result available)
  → Detect if command matches test commands from config
  → If match: mark test as "run attempted" (set hasEverRun = true)
  → Cannot determine pass/fail (user_bash fires before execution)
  → Limitation: guard permits impl writes after user test run without
    knowing if tests actually passed. Acceptable tradeoff — the guard's
    job is "tests exist + have been run", not "tests are green".
  → If precise result tracking needed: agent should re-run tests via
    tool_call(bash), which provides full result via tool_result
```

#### Impl → Test File Mapping

The guard must know which test file corresponds to which implementation file. Mapping uses the strategies defined in `.superteam.json`, applied in order:

**Default strategies (applied in order, first match wins):**
1. **Suffix** — `foo.ts` → `foo.test.ts` (same directory)
2. **Suffix** — `foo.ts` → `foo.spec.ts` (same directory)
3. **Directory** — `src/x/foo.ts` → `src/x/__tests__/foo.test.ts`

**Explicit overrides** (from config) take priority over strategies.

**Reverse mapping:** Given a test file, derive the impl file (for tracking which impl files have test coverage).

**When no mapping found:** Allow the write (don't block on mapping uncertainty). Log a warning suggesting the user configure `testFileMapping` in `.superteam.json`.

#### ATDD Extension

When ATDD mode is active, track an additional layer:
- Before unit tests can be written for a feature, an acceptance test must exist
- Acceptance tests identified by patterns in config (`acceptanceTestPatterns`)
- The guard tracks which acceptance tests exist and whether they've been run
- ATDD layer **warns** rather than **blocks** (acceptance test identification is fuzzy)

#### State Tracking

```typescript
// JSON-serializable — no Maps, Sets, or non-serializable types
interface TddState {
  mode: "off" | "tdd" | "atdd";
  testFiles: Record<string, {
    exists: boolean;
    lastRun?: number;       // timestamp
    lastPassed?: boolean;   // result of last run
    hasEverRun: boolean;    // sticky — true once any run recorded
  }>;
  implFiles: Record<string, {
    mappedTestFile: string | null;  // resolved via mapping algorithm
    lastWrite?: number;
  }>;
  acceptanceTests: Record<string, {
    exists: boolean;
    lastRun?: number;
    lastPassed?: boolean;
    hasEverRun: boolean;
  }>;
  bashWriteAllowance?: {
    reason: string;
    grantedAt: number;
    consumed: boolean;
  };
}
```

State persisted via `pi.appendEntry()` as typed session entries. Reconstructed from branch entries on resume via `ctx.sessionManager.getBranch()`.

**Exports:** `createTddGuard(config)` → object with event handlers for `tool_call`, `tool_result`, and `user_bash`.

### 5. Rule Engine (`src/rules/engine.ts`)

**Purpose:** TTSR-like context-aware rule injection. Load markdown rules with trigger patterns. When the agent's recent output matches a trigger, inject the rule content into the next turn's context.

**Rule format** (markdown with frontmatter):
```markdown
---
name: test-first
trigger: "simple enough|don't need tests|skip testing|test later|too trivial"
priority: high
frequency: once
---
IMPORTANT: You MUST write tests first. No implementation code without a failing test.
This applies regardless of how "simple" the code appears.
```

**Mechanism:**
- On `context` event: scan last N characters (configurable, default 2000) of recent assistant messages for trigger regex matches
- Regexes compiled once on rule load, not per-scan
- If matched: append rule content as a **`custom` role message late in the context array** for high recency weight. This is user-context, not system-role — pi's `context` event modifies the message list but does not support injecting true system-role messages.
- Frequency control: `once` (per session), `per-turn` (every matching turn), `cooldown:N` (at most every N turns)

**Integration with TDD guard:** Complementary. Guard = enforcement. Rules = proactive guidance. Together:
1. Agent plans to skip tests → Rule fires, redirects thinking
2. Agent tries to write impl anyway → Guard blocks the write
3. Agent understands why (skill + rule content)

### 6. Review Parser (`src/review-parser.ts`)

**Purpose:** Centralized extraction and validation of structured reviewer JSON output. Single module — not reimplemented per reviewer type.

**Input:** Raw text output from a reviewer subagent.

**Extraction:** Find the fenced `superteam-json` block in the output:
1. Search for ` ```superteam-json` ... ` ``` ` fence markers
2. Extract content between markers
3. `JSON.parse()` the content
4. Validate against `ReviewFindings` schema
5. Fallback: if no fence found, try last `{...}` brace-match (handles reviewers that forget the fence)

**Why fenced blocks:** Brace-matching is fragile when reviewer output contains code snippets with braces. The fence marker ` ```superteam-json` is unambiguous and trivial to extract via regex.

**Schema:**
```typescript
interface ReviewFindings {
  passed: boolean;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    file: string;
    line?: number;
    issue: string;
    suggestion?: string;
  }>;
  mustFix: string[];   // file:line references
  summary: string;
}
```

**Return type:**
```typescript
type ParseResult =
  | { status: "pass"; findings: ReviewFindings }
  | { status: "fail"; findings: ReviewFindings }
  | { status: "inconclusive"; rawOutput: string; parseError: string };
```

**Inconclusive handling:** If JSON extraction or validation fails, return `inconclusive` with the raw output and error. The orchestrator escalates to human. Never crash, never guess.

### 7. Workflow State (`src/workflow/state.ts`)

**Purpose:** Track plan execution progress, TDD mode, review cycles. Persist to session via `pi.appendEntry()`. Display via widgets.

**Branch-aware design:** All state is derived from session branch entries via `ctx.sessionManager.getBranch()`. When the user branches (via `/tree`), each branch gets independent workflow state. No global mutable state.

**State shape:**
```typescript
interface WorkflowState {
  tddMode: "off" | "tdd" | "atdd";
  planFile?: string;
  tasks: PlanTask[];
  currentTaskIndex: number;
  reviewCycles: ReviewCycle[];
  testState: TddState;
  cumulativeCostUsd: number;
}

interface PlanTask {
  id: number;
  title: string;
  description: string;
  files: string[];
  status: "pending" | "implementing" | "reviewing" | "fixing" | "complete";
  reviewsPassed: string[];
  reviewsFailed: string[];
  fixAttempts: number;
}

interface ReviewCycle {
  taskId: number;
  reviewType: "spec" | "quality" | "security" | "performance";
  agent: string;
  status: "pending" | "passed" | "failed" | "inconclusive";
  findings?: ReviewFindings;
  fixedBy?: string;
}

// All state types use plain objects (Record, arrays) — no Maps, Sets, or
// other non-JSON-serializable types.
```

**Widget rendering:** Shows in status bar:
```
[ATDD] Task 3/7: "Add input validation" — reviewing (spec ✓ quality ⏳) | $2.34
```

### 8. SDD Orchestrator (`src/workflow/sdd.ts`)

**Purpose:** Implement the full subagent-driven-development loop. Dispatches agents, tracks review cycles, handles escalation. Uses `dispatch.ts` for agent execution, `review-parser.ts` for output parsing, `state.ts` for persistence.

**Separated from `index.ts`** to keep the composition root thin. SDD is one consumer of dispatch/state/parser — not the only one.

### 9. Agent Profiles (`agents/*.md`)

Each agent is a markdown file with YAML frontmatter defining model, tools, and system prompt.

**Reviewer output contract:** All reviewer agents include in their system prompt:
1. Instructions to end their response with a ` ```superteam-json` fenced block
2. The exact `ReviewFindings` schema they must follow
3. An example output showing the fence markers

This is duplicated across reviewer prompts intentionally (each agent file is self-contained for subprocess isolation). The `review-parser.ts` module is the single source of truth for parsing/validation.

#### `agents/implementer.md`
- **Model:** configurable (default from `agents.defaultModel`)
- **Tools:** all (read, write, edit, bash, grep, find, ls)
- **Subprocess flags:**
  - `-e ${packageDir}/src/index.ts` — loads TDD guard in subprocess (enforces test-first mechanically)
  - `--skill ${packageDir}/skills/test-driven-development/SKILL.md` — teaches TDD methodology
- **Prompt:** You are implementing a specific task. Follow TDD strictly. Write failing test first, verify it fails, write minimal implementation, verify it passes, refactor, commit. Self-review before reporting back.

#### `agents/spec-reviewer.md`
- **Model:** configurable (default from `agents.defaultModel`)
- **Tools:** read, grep, find, ls (no bash, no write, no edit)
- **Subprocess flags:** (none beyond isolation)
- **Prompt:** You are verifying implementation matches specification. Do NOT trust the implementer's report — read the actual code. Compare line-by-line against requirements. Report missing requirements, extra features, and misunderstandings. Be skeptical. End with the structured findings JSON.

#### `agents/quality-reviewer.md`
- **Model:** configurable (default from `agents.defaultModel`)
- **Tools:** read, grep, find, ls (no bash, no write, no edit)
- **Subprocess flags:** (none beyond isolation)
- **Prompt:** Code quality review. Check for: naming clarity, DRY violations, unnecessary complexity, error handling gaps, test quality (real behavior vs mock behavior), missing edge cases. Categorize findings by severity. End with the structured findings JSON.

#### `agents/security-reviewer.md`
- **Model:** configurable (default from `agents.defaultModel`)
- **Tools:** read, grep, find, ls (no bash). Plus `lsp` if explicitly enabled via `-e npm:lsp-pi` in subprocess flags.
- **Subprocess flags:** `-e npm:lsp-pi` (if lsp-pi is installed on the host — checked at dispatch time)
- **Prompt:** Security-focused review. Check for: input validation, injection vulnerabilities, auth/authz flaws, secrets exposure, cryptographic misuse, race conditions, path traversal, dependency issues. Categorize as Critical/High/Medium. Include exploit scenarios for Critical findings. End with the structured findings JSON.

#### `agents/performance-reviewer.md`
- **Model:** configurable (default from `agents.defaultModel`)
- **Tools:** read, grep, find, ls (no bash). Plus `lsp` if explicitly enabled.
- **Subprocess flags:** `-e npm:lsp-pi` (if installed)
- **Prompt:** Performance-focused review. Check for: O(n²) algorithms, unbounded allocations, missing pagination, N+1 queries, blocking operations, unnecessary computation, cache opportunities, memory leaks. Include benchmarking suggestions for critical findings. End with the structured findings JSON.

#### `agents/architect.md`
- **Model:** configurable (default from `agents.defaultModel`)
- **Tools:** read, grep, find, ls (no bash, no write, no edit)
- **Subprocess flags:** (none beyond isolation)
- **Prompt:** Architecture review. Evaluate design decisions, module boundaries, dependency directions, abstraction levels, extensibility, testability. Focus on structural issues that are expensive to fix later. Flag violations of project conventions. End with the structured findings JSON.

#### `agents/scout.md`
- **Model:** configurable (default from `agents.scoutModel`)
- **Tools:** read, grep, find, ls, bash
- **Subprocess flags:** (none beyond isolation)
- **Prompt:** Fast codebase reconnaissance. Quickly locate relevant code, trace dependencies, identify key types/interfaces. Return structured findings that another agent can use without re-reading files. Optimize for speed over completeness.

### 10. Skills (`skills/*/SKILL.md`)

#### `skills/test-driven-development/SKILL.md`
Adapted from superpowers. Core methodology:
- RED → GREEN → REFACTOR cycle
- Iron law: no production code without a failing test
- The guard ensures tests exist and have been run; the skill teaches the full discipline
- Common rationalizations and rebuttals
- Verification checklist

#### `skills/acceptance-test-driven-development/SKILL.md`
Extension of TDD for feature-level work:
- Define acceptance criteria from spec/user story
- Write acceptance test (high-level, e2e/integration) FIRST
- Verify acceptance test fails
- Then TDD cycle for each component
- After all components, verify acceptance test passes
- When to use ATDD vs pure TDD (user-facing features → ATDD, internal refactors → TDD)

#### `skills/brainstorming/SKILL.md`
Adapted from superpowers. Socratic design refinement:
- Ask clarifying questions before proposing solutions
- Explore alternatives
- Present design in digestible sections for validation
- Save design document to `docs/designs/`

#### `skills/writing-plans/SKILL.md`
Adapted from superpowers. Bite-sized implementation planning:
- Each task is one action (2-5 minutes)
- Exact file paths, complete code, exact commands with expected output
- TDD-oriented task structure: write test → verify fail → write impl → verify pass → commit
- Plan saved to `docs/plans/YYYY-MM-DD-<name>.md`
- Execution handoff: offer SDD or manual execution
- **Machine-parseable task block** at end of plan using fenced block:

````markdown
```superteam-tasks
- id: 1
  title: "Add input validation to POST /users"
  files: ["src/validators/user.ts", "src/validators/user.test.ts"]
  acceptance_test: "tests/e2e/user-creation.e2e.test.ts"
- id: 2
  title: "Wire validation middleware"
  files: ["src/routes/users.ts", "src/routes/users.test.ts"]
```
````

Human-readable plan stays as prose above. The ` ```superteam-tasks` fenced block is the machine-parseable contract between planning and SDD execution. Delimiters make extraction robust — no accidental parsing of other YAML in the document. SDD parser extracts this block; falls back to heuristic heading parsing (`### Task N:`) if absent.

#### `skills/subagent-driven-development/SKILL.md`
Orchestrated execution with review cycles:
- Per-task loop: dispatch implementer → spec-review → quality-review
- Optional parallel reviews: security + performance
- Review fix loops (iterative: reviewer finds issues → implementer fixes → re-review)
- Configurable max review iterations (default 3)
- Prompt templates for each agent type
- Final code review of entire implementation

**Sub-files:**
- `implementer-prompt.md` — template for implementer dispatch
- `spec-reviewer-prompt.md` — template for spec compliance review
- `quality-reviewer-prompt.md` — template for quality review

#### `skills/systematic-debugging/SKILL.md`
Adapted from superpowers. Root-cause debugging:
- Reproduce → Hypothesize → Test → Fix → Verify
- Write failing test that reproduces the bug FIRST
- Never fix without a test
- Defense in depth

### 11. Context Rules (`rules/*.md`)

#### `rules/test-first.md`
- **Trigger:** `simple enough|don't need tests|skip testing|test later|too trivial|just this once`
- **Content:** Reminder that all code needs tests first. Rebuts the specific rationalization.

#### `rules/yagni.md`
- **Trigger:** `might need later|just in case|while we're at it|nice to have|future-proof`
- **Content:** YAGNI reminder. Build only what's specified. Over-building triggers spec review failures.

#### `rules/no-impl-before-spec.md`
- **Trigger:** `start coding|jump into implementation|skip the plan|just build it`
- **Content:** Reminder to finish planning/design before implementation.

### 12. Prompt Templates (`prompts/*.md`)

#### `prompts/sdd.md`
```
Start subagent-driven-development for the plan. Use /skill:subagent-driven-development.
Execute task by task with review cycles. $@
```

#### `prompts/review-parallel.md`
```
Dispatch parallel review agents for the current implementation:
- security-reviewer: focus on vulnerabilities
- performance-reviewer: focus on bottlenecks
Synthesize findings. $@
```

---

## Integration Points

### TDD Guard ↔ LSP (`lsp-pi`)

LSP is a separate, optional package (`pi install npm:lsp-pi`). No code dependency between superteam and lsp-pi. They compose naturally via pi's event system in the main session:
1. Agent writes code → superteam's TDD guard allows/blocks based on test state
2. If allowed → `lsp-pi`'s `tool_result` hook appends diagnostics
3. Agent sees both: TDD enforcement + LSP feedback

If `lsp-pi` is not installed, everything works. Reviewer subagents get `lsp` only if explicitly enabled via `-e npm:lsp-pi` in their subprocess flags (checked at dispatch time by attempting to resolve the package).

### TDD Guard ↔ Skills

The skill teaches the full RED→GREEN→REFACTOR discipline. The guard enforces the mechanical minimum (tests exist, tests have been run). When the guard blocks a write, the error message references the TDD methodology so the agent understands the reason.

### Rule Engine ↔ TDD Guard

Rules fire BEFORE the guard triggers. A rule catches "I'll skip the test for this simple function" and redirects the agent's thinking. If the agent ignores the rule and tries to write anyway, the guard blocks it. Two-layer defense.

### Agent Dispatch ↔ Workflow State

When SDD orchestration dispatches an implementer, the workflow state tracks which task is being implemented. When a reviewer returns structured findings (parsed by `review-parser.ts`), the state records the review result and determines next action deterministically.

### Agent Dispatch ↔ TDD Guard (Subagent Enforcement)

The TDD guard runs in **both** the main session and implementer subagents:

**Main session:** Guard enforces TDD for direct human-agent interaction. State is persistent across the session, branch-aware, and tracks all test runs.

**Implementer subagent:** Guard is loaded via `-e <packageDir>/src/index.ts`. It boots fresh with no inherited state. As the implementer works (writes tests, runs them, writes impl), the guard tracks state from scratch and enforces:
- Can't write `src/foo.ts` until `src/foo.test.ts` exists and has been run
- Test files are always allowed
- Bash mutations are blocked (implementer should use write/edit)

**Reviewer/scout subagents:** No guard needed. They have read-only tools (`read, grep, find, ls`) and can't write files.

**Three-layer defense for SDD:**
1. **Guard** (mechanical) — blocks non-TDD writes in implementer subprocess
2. **Skill + prompt** (guidance) — teaches RED→GREEN→REFACTOR discipline
3. **Spec reviewer** (verification) — catches any violations that slip through

### `team` Tool — Standalone Use

The `team` tool is designed for direct human use, independent of SDD:

```
"Dispatch security-reviewer and performance-reviewer in parallel on src/auth/"
"Have scout find all database access patterns"  
"Chain: scout finds the auth code, then architect reviews the module structure"
```

SDD uses `team` internally for its orchestration loop, but `team` never assumes SDD context. It works with any agent (including user-defined ones in `~/.pi/agent/agents/`) and any task description.

---

## Iterative Review/Fix Cycles

### Per-Task Review Flow

```
implement(task)
  │
  ├─ cost check: projected cost within budget? warn/block if not
  │
  ├─ snapshot: `git diff --name-only` (before)
  │
  ├─ dispatch implementer agent
  │   └─ returns: self-report (test results, summary)
  │
  ├─ compute actual changes: `git diff --name-only` (after) minus (before)
  │   └─ pass computed file list (not self-report) to reviewers
  │
  ├─ spec compliance review
  │   ├─ dispatch spec-reviewer agent
  │   ├─ parse structured findings via review-parser.ts
  │   ├─ if PASS → continue to quality review
  │   ├─ if FAIL →
  │   │   ├─ dispatch implementer to fix specific issues (findings passed as context)
  │   │   ├─ re-dispatch spec-reviewer (up to MAX_REVIEW_ITERATIONS)
  │   │   └─ if still failing after max → escalate to human
  │   └─ if INCONCLUSIVE (no valid JSON) → escalate to human
  │
  ├─ quality review
  │   ├─ dispatch quality-reviewer agent
  │   ├─ parse structured findings via review-parser.ts
  │   ├─ if PASS → continue to optional reviews
  │   ├─ if FAIL →
  │   │   ├─ dispatch implementer to fix quality issues
  │   │   ├─ re-dispatch quality-reviewer (up to MAX_REVIEW_ITERATIONS)
  │   │   └─ if still failing after max → escalate to human
  │   └─ if INCONCLUSIVE → escalate to human
  │
  ├─ optional parallel reviews (configurable)
  │   ├─ cost check before dispatch
  │   ├─ dispatch security-reviewer + performance-reviewer in parallel
  │   ├─ parse structured findings from both via review-parser.ts
  │   ├─ if critical findings →
  │   │   ├─ dispatch implementer to fix
  │   │   └─ re-review (up to MAX_REVIEW_ITERATIONS)
  │   └─ if non-critical → note findings, continue
  │
  └─ mark task complete
```

### Structured Reviewer Output

All reviewers must end their response with a fenced JSON block:

````
```superteam-json
{
  "passed": false,
  "findings": [...],
  "mustFix": [...],
  "summary": "..."
}
```
````

**Parsing strategy:** Centralized in `review-parser.ts`. Extract ` ```superteam-json` fenced block from output. Validate against `ReviewFindings` schema. Falls back to last `{...}` brace-match if no fence found. Return typed `ParseResult` (pass/fail/inconclusive). Never crash, never guess.

**Why structured output matters:** Freeform reviewer prose makes fix loops brittle and expensive. With structured output, the orchestrator deterministically decides: pass → next review, fail → dispatch fix, inconclusive → ask human. No LLM needed to interpret reviewer results.

### Configuration

```typescript
interface ReviewConfig {
  maxIterations: number;           // default: 3
  required: string[];              // default: ["spec", "quality"]
  optional: string[];              // default: ["security", "performance"]
  parallelOptional: boolean;       // default: true
  escalateOnMaxIterations: boolean;// default: true (ask human)
}
```

### Escalation

When a review cycle exceeds `maxIterations`, produces inconclusive output, or hits cost limits:
1. Present findings summary to the human
2. Offer choices: "Fix manually", "Skip this review", "Adjust plan", "Abort task"
3. If human fixes → re-run review
4. If human skips → continue with warning logged

---

## ATDD Workflow Detail

### When ATDD Mode is Active

```
feature request
  │
  ├─ 1. Define acceptance criteria
  │     └─ brainstorming skill extracts testable criteria
  │
  ├─ 2. Write acceptance test
  │     └─ High-level test: end-to-end or integration
  │     └─ File: tests/acceptance/<feature>.acceptance.test.ts
  │     └─ Tests the feature from the user's perspective
  │
  ├─ 3. Run acceptance test → must FAIL
  │     └─ Guard tracks: acceptance test exists and has been run
  │
  ├─ 4. Plan components needed to make acceptance test pass
  │     └─ writing-plans skill creates bite-sized tasks
  │
  ├─ 5. For each component (inner TDD loop):
  │     ├─ Write unit test → verify fail
  │     ├─ Write implementation → verify pass
  │     ├─ Refactor
  │     └─ Commit
  │
  ├─ 6. Run acceptance test → should PASS
  │     └─ If fails: identify which component needs work, loop back to 5
  │
  └─ 7. Feature complete
```

### ATDD Guard Enforcement

In addition to TDD guard rules:
- Before writing unit tests for a new feature, check if an acceptance test exists
- The acceptance test doesn't need to be comprehensive — it just needs to exist and fail
- Once the acceptance test passes, the feature is considered complete
- The guard **warns** rather than **blocks** for ATDD (acceptance test identification is fuzzy)

---

## Proposal-Only Mode (Contingency / Future Enhancement)

If deterministic subprocess isolation proves insufficient for TDD enforcement, or as a future enhancement for higher-trust workflows:

**Concept:** Subagent implementers return proposed changes instead of applying them directly. The main session applies changes under the guard.

**Artifact format:**
```json
{
  "proposedChanges": [
    {
      "action": "write",
      "path": "src/validators/user.ts",
      "content": "..."
    },
    {
      "action": "edit",
      "path": "src/routes/users.ts",
      "oldText": "...",
      "newText": "..."
    },
    {
      "action": "bash",
      "command": "npm test",
      "expectedExitCode": 0
    }
  ],
  "testResults": {
    "command": "npm test",
    "exitCode": 0,
    "output": "..."
  },
  "summary": "Implemented input validation with TDD..."
}
```

**Implementation:** Add `proposalOnly: true` to implementer agent config. Modify system prompt to return JSON artifact instead of executing. Dispatcher collects artifact. Orchestrator applies changes in main session via `write`/`edit` tool calls (which pass through the TDD guard).

**Scope:** ~200 lines in `dispatch.ts` + prompt modifications. Not in initial build — defined here so the contract is stable if needed later.

---

## File Inventory

### Package Root
| File | Purpose |
|------|---------|
| `package.json` | Pi package manifest, declares extensions + skills + prompts |
| `README.md` | Installation, usage, configuration docs |
| `.superteam.json` | Default config (copied to project root on init) |

### Extension Source (`src/`)
| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/index.ts` | Thin composition root: register tools, commands, events | ~200 |
| `src/config.ts` | Config resolution, validation, defaults | ~120 |
| `src/dispatch.ts` | Agent dispatch: spawn pi, parse JSON events, collect results, cost tracking | ~350 |
| `src/review-parser.ts` | Structured reviewer JSON extraction and validation | ~80 |
| `src/workflow/tdd-guard.ts` | TDD/ATDD enforcement: write+edit+bash blocking, test state, file mapping | ~350 |
| `src/workflow/state.ts` | Plan/review state management, widget rendering, persistence | ~200 |
| `src/workflow/sdd.ts` | SDD orchestration loop: implement→review→fix cycles | ~250 |
| `src/rules/engine.ts` | Context rule loading, trigger matching, injection | ~150 |

**Total extension code: ~1700 lines**

### Agent Profiles (`agents/`)
| File | Model | Tools | Subprocess Flags |
|------|-------|-------|-----------------|
| `agents/implementer.md` | defaultModel | all | `-e ${packageDir}/src/index.ts`, `--skill ${packageDir}/skills/.../SKILL.md` |
| `agents/spec-reviewer.md` | defaultModel | read, grep, find, ls | (isolation only) |
| `agents/quality-reviewer.md` | defaultModel | read, grep, find, ls | (isolation only) |
| `agents/security-reviewer.md` | defaultModel | read, grep, find, ls | `-e npm:lsp-pi` (if installed) |
| `agents/performance-reviewer.md` | defaultModel | read, grep, find, ls | `-e npm:lsp-pi` (if installed) |
| `agents/architect.md` | defaultModel | read, grep, find, ls | (isolation only) |
| `agents/scout.md` | scoutModel | read, grep, find, ls, bash | (isolation only) |

### Skills (`skills/`)
| File | Trigger | From |
|------|---------|------|
| `skills/test-driven-development/SKILL.md` | Feature/bugfix implementation | Superpowers (adapted) |
| `skills/acceptance-test-driven-development/SKILL.md` | User-facing feature work | New |
| `skills/brainstorming/SKILL.md` | New feature design | Superpowers (adapted) |
| `skills/writing-plans/SKILL.md` | Multi-step implementation | Superpowers (adapted) |
| `skills/subagent-driven-development/SKILL.md` | Plan execution | Superpowers (adapted) |
| `skills/subagent-driven-development/implementer-prompt.md` | — | Superpowers (adapted) |
| `skills/subagent-driven-development/spec-reviewer-prompt.md` | — | Superpowers (adapted) |
| `skills/subagent-driven-development/quality-reviewer-prompt.md` | — | New |
| `skills/systematic-debugging/SKILL.md` | Bug investigation | Superpowers (adapted) |

### Rules (`rules/`)
| File | Trigger Pattern |
|------|----------------|
| `rules/test-first.md` | Rationalizations for skipping tests |
| `rules/yagni.md` | Over-building impulses |
| `rules/no-impl-before-spec.md` | Skipping planning |

### Prompts (`prompts/`)
| File | Workflow |
|------|---------|
| `prompts/sdd.md` | Start SDD for a plan |
| `prompts/review-parallel.md` | Parallel security + performance review |

---

## Implementation Order

Tasks are ordered by dependency. Each task is independently testable.

### Task 1: Package scaffold, agent discovery, single dispatch, verification

**Files:**
- Create: `package.json`, `.superteam.json` (default config)
- Create: `src/config.ts` (config resolution + validation)
- Create: `src/dispatch.ts` (agent loading + single dispatch only)
- Create: `src/index.ts` (minimal: register `team` tool with single mode)
- Create: `agents/scout.md`, `agents/implementer.md`

**Verify:**
1. `pi -e ./src/index.ts` → ask it to use the `team` tool to dispatch scout → get structured result back.
2. **Subprocess isolation flags test:** verify which flags pi supports for isolation (`--no-extensions`, `--no-skills`, `--no-themes`, `--no-prompt-templates`). Document actual available flags. If missing, determine alternative isolation strategy.
3. **JSON event parsing test:** capture raw stdout from subprocess, verify event names match what we parse. Align to actual events.
4. **Guard-in-subprocess test:** spawn implementer with `-e ./src/index.ts` → verify the TDD guard's `session_start` handler fires in the subprocess. This confirms end-to-end enforcement works.
5. **`--skill` path test:** verify `--skill <absolute-path-to-SKILL.md>` works in isolated mode. Confirm skill content appears in agent context.
6. **`-e npm:lsp-pi` loading test:** verify that `-e npm:lsp-pi` works under isolation flags (if lsp-pi is installed). Confirm the `lsp` tool appears in the subagent's tool list. If lsp-pi is not installed, verify graceful skip (no crash).
7. Verify `team` tool works standalone: "dispatch scout to find all test files" → result.

**Why first:** Everything else builds on the ability to dispatch agents. Get this working and verify assumptions before adding workflow logic.

### Task 2: Full dispatch modes (parallel + chain) + cost tracking

**Files:**
- Modify: `src/dispatch.ts` — add parallel (concurrency-limited) and chain modes, cost tracking
- Modify: `src/index.ts` — expose parallel/chain in `team` tool schema

**Verify:**
1. Dispatch scout and implementer in parallel → both return results.
2. Chain: scout → implementer (pass context via `{previous}`) → result uses scout's findings.
3. Cost tracking: cumulative cost displayed after dispatch. Warning fires at threshold.
4. Hard cost limit: dispatch blocked when limit reached, requires user override.

### Task 3: Workflow state and plan tracking

**Files:**
- Create: `src/workflow/state.ts`
- Modify: `src/index.ts` — add `/sdd` command, plan progress widget, session persistence

**Verify:**
1. Load a plan file with ` ```superteam-tasks` block → state parses tasks correctly.
2. Load a plan file without task block → heuristic parser finds tasks from `### Task N:` headings.
3. Widget shows progress: `[TDD] Task 1/3: "Setup models" — pending | $0.00`
4. State survives branch: create branch, verify independent state per branch.

### Task 4: TDD Guard

**Files:**
- Create: `src/workflow/tdd-guard.ts`
- Modify: `src/index.ts` — wire `tool_call`/`tool_result`/`user_bash` handlers, add `/tdd` command + shortcut

**Verify:**
1. Enable TDD → `write` to `src/foo.ts` (no test file) → BLOCKED, message says "Create a test file first. Expected: src/foo.test.ts"
2. Enable TDD → `edit` to `src/foo.ts` (no test file) → BLOCKED
3. `write` to `src/foo.test.ts` → ALLOWED (test file always allowed)
4. Enable TDD → `write` to `src/foo.ts` (test exists, never run) → BLOCKED, message says "Run your tests first"
5. Run tests via `bash` (fail) → `write` to `src/foo.ts` → ALLOWED
6. Run tests via `bash` (pass) → `write` to `src/foo.ts` → ALLOWED (REFACTOR phase)
7. Enable TDD → `bash` with `echo "x" > src/foo.ts` → BLOCKED (heuristic)
8. `/tdd allow-bash-write once "generating config"` → bash write → ALLOWED, allowance consumed
9. Run tests via user `!npm test` → guard marks `hasEverRun = true` (pre-execution hook, no pass/fail)
10. Toggle off → all writes unrestricted
11. Exempt paths (`*.d.ts`, config files) → always allowed
12. Unmapped file (no matching test file pattern) → ALLOWED with warning

### Task 5: ATDD extension

**Files:**
- Modify: `src/workflow/tdd-guard.ts` — add ATDD layer (acceptance test tracking)
- Modify: `src/index.ts` — add `/atdd` command
- Create: `skills/acceptance-test-driven-development/SKILL.md`

**Verify:**
1. Enable ATDD → write unit test for new feature → warned (no acceptance test)
2. Write acceptance test → run it (fail) → unit tests now allowed
3. Complete implementation → run acceptance test (pass) → feature marked complete

### Task 6: Rule engine

**Files:**
- Create: `src/rules/engine.ts`
- Create: `rules/test-first.md`, `rules/yagni.md`, `rules/no-impl-before-spec.md`
- Modify: `src/index.ts` — wire `context` event handler

**Verify:** Start session → agent says "this is simple enough to skip tests" → rule injects as custom message on next context event → agent corrects course.

### Task 7: SDD orchestration loop + review parser

**Files:**
- Create: `src/review-parser.ts` — structured JSON extraction and validation
- Create: `src/workflow/sdd.ts` — orchestration logic
- Modify: `src/index.ts` — wire `/sdd` command to orchestrator
- Modify: `src/workflow/state.ts` — review cycle tracking
- Create: remaining agent profiles (spec-reviewer, quality-reviewer, security-reviewer, performance-reviewer, architect)

**Verify:**
1. Review parser: given reviewer output with JSON block → extracts and validates correctly.
2. Review parser: given reviewer output without JSON → returns `inconclusive`.
3. SDD: create a small plan (2 tasks) → run `/sdd` → implementer dispatched per task → spec review (structured JSON output parsed) → quality review → all tasks complete.
4. SDD: force a spec review failure → verify fix loop: implementer re-dispatched with findings → re-review → pass.
5. SDD: force max iterations → verify escalation to human.
6. SDD: inconclusive reviewer output (no JSON) → verify escalation.
7. SDD: cost tracking — total tokens/cost displayed per SDD run.

### Task 8: Skills (all)

**Files:**
- Create: all `skills/*/SKILL.md` files
- Create: prompt templates in `skills/subagent-driven-development/`

**Verify:** Start fresh session → describe a feature → agent picks up brainstorming skill → produces design → picks up writing-plans skill → produces plan with ` ```superteam-tasks` block → offers SDD execution.

### Task 9: Custom rendering, prompts, docs

**Files:**
- Modify: `src/index.ts` — add `renderCall`/`renderResult` for `team` tool
- Create: `prompts/sdd.md`, `prompts/review-parallel.md`
- Create: `README.md`

**Verify:** `team` tool calls render nicely in TUI. Prompt templates trigger via `/sdd`, `/review-parallel`.

---

## Configuration & Defaults

Stored in `.superteam.json` in the project root. Created with defaults on first run or via `/superteam init`.

```json
{
  "configVersion": 1,
  "tddMode": "off",
  "testFilePatterns": ["*.test.ts", "*.spec.ts", "__tests__/*.ts"],
  "acceptanceTestPatterns": ["*.acceptance.test.ts", "*.e2e.test.ts"],
  "testCommands": ["npm test", "bun test", "npx jest", "npx vitest"],
  "exemptPaths": ["*.d.ts", "*.config.*", "migrations/*"],
  "testFileMapping": {
    "strategies": [
      { "type": "suffix", "implSuffix": ".ts", "testSuffix": ".test.ts" },
      { "type": "suffix", "implSuffix": ".ts", "testSuffix": ".spec.ts" },
      { "type": "directory", "testDir": "__tests__" }
    ],
    "overrides": {}
  },
  "review": {
    "maxIterations": 3,
    "required": ["spec", "quality"],
    "optional": ["security", "performance"],
    "parallelOptional": true,
    "escalateOnMaxIterations": true
  },
  "agents": {
    "defaultModel": "claude-sonnet-4-5",
    "scoutModel": "claude-haiku-4-5",
    "modelOverrides": {}
  },
  "costs": {
    "warnAtUsd": 5.00,
    "hardLimitUsd": 20.00
  }
}
```

---

## Resolved Questions

1. **Subagent skill loading:** Yes for implementer (`--skill ${packageDir}/skills/.../SKILL.md` — file path, not name), no for reviewers (system prompt is sufficient).

2. **Git worktrees:** Deferred. Start simple — no worktrees. Add later if needed.

3. **Plan file format:** Hybrid. Human-readable prose + ` ```superteam-tasks` fenced YAML block. Heuristic fallback parsing for plans without the block.

4. **Cost controls:** First-class. Pre-dispatch check + mid-stream abort at hard limit. Budget tracked cumulatively per session.

5. **"Read-only bash" for reviewers:** Dropped. Reviewers get `read, grep, find, ls` — no bash.

6. **Subagent TDD enforcement:** Guard **runs in implementer subagents** via `-e <packageDir>/src/index.ts`. Boots fresh, enforces test-first from scratch. Three-layer defense: guard (mechanical) + skill/prompt (guidance) + spec reviewer (verification). Reviewer/scout subagents don't need the guard (read-only tools).

7. **Subprocess determinism:** Subagents spawned with `--no-extensions --no-skills --no-themes --no-prompt-templates`. Only explicitly needed extensions/skills added back (guard + TDD skill for implementer, lsp-pi for select reviewers). Exact flags verified during Task 1.

8. **TDD guard semantics:** Guard enforces "test exists + has been run" (mechanical minimum). RED→GREEN→REFACTOR discipline taught by skills/rules. REFACTOR phase is never blocked.

9. **Impl→test file mapping:** Configurable strategies in `.superteam.json`. Defaults: suffix-based (`.test.ts`, `.spec.ts`) + `__tests__/` directory. Unmapped files allowed with warning.

10. **LSP in subagents:** Explicitly added via `-e npm:lsp-pi` for security/performance reviewers only, and only if the package is installed. Checked at dispatch time.

11. **Config storage:** `.superteam.json` in project root. `configVersion` for future migrations. Schema validated via TypeBox.

12. **Reviewer output parsing:** Centralized in `review-parser.ts`. Single schema, single parser. Inconclusive → escalate, never crash.

13. **User-initiated test runs:** `user_bash` is a pre-execution hook — no result available. Guard marks `hasEverRun = true` optimistically when test command detected. Cannot determine pass/fail. For precise tracking, agent re-runs tests via `tool_call(bash)`.

14. **File change detection for reviewers:** Computed via `git diff --name-only` before/after implementer dispatch. Reviewers receive the computed list, not the implementer's self-report. Falls back to implementer self-report if git unavailable.

---

## Credits

- TDD/SDD methodology and skill content adapted from [obra/superpowers](https://github.com/obra/superpowers) (MIT)
- LSP integration via [lsp-pi](https://www.npmjs.com/package/lsp-pi) (MIT, optional)
- Agent dispatch pattern from pi's built-in [subagent example](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent)
- TTSR concept inspired by [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT)
