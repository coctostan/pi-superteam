<p align="center">
  <h1 align="center">🦸 pi-superteam</h1>
  <p align="center">
    Multi-agent orchestration · TDD enforcement · Iterative review cycles · Context-aware rules
    <br/>
    <em>A <a href="https://github.com/badlogic/pi">pi</a> extension package that makes your AI write better code.</em>
  </p>
</p>

<p align="center">
  <a href="#installation">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#agents">Agents</a> ·
  <a href="#configuration">Config</a> ·
  <a href="docs/guides/">Docs</a>
</p>

---

## What is this?

**pi-superteam** turns your pi agent into a development team. Instead of one AI doing everything, you get specialized agents — a scout that explores code, an implementer that writes tests first, reviewers that catch bugs — all coordinated automatically.

It also makes your AI follow TDD whether it wants to or not. Try to write code without a test? **Blocked.** Try to rationalize skipping tests? A rule fires and says "no." The three-layer defense (mechanical guard + context rules + methodology skills) makes test-first the path of least resistance.

## Installation

```bash
pi install npm:pi-superteam
```

**Try without installing:**
```bash
pi -e npm:pi-superteam
```

**Development mode:**
```bash
git clone https://github.com/coctostan/pi-superteam.git
pi -e ./pi-superteam/src/index.ts
```

## Quick Start

### Run an orchestrated workflow

The fastest way to get going — the orchestrator handles everything end-to-end:

```
/workflow Add rate limiting with token bucket algorithm
```

The orchestrator automatically:
1. **Brainstorms** — scouts your codebase, asks clarifying questions, proposes approaches, writes a design doc
2. **Writes a plan** — dedicated planner agent creates a detailed TDD plan from the approved design
3. **Reviews the plan** (architect + spec reviewer, with planner revisions)
4. **Configures** execution mode and review settings via interactive dialogs
5. **Executes each task** through implement → review → fix loops (with TDD enforced and live activity streaming)
6. **Finalizes** with a cross-task review and summary report

State persists to `.superteam-workflow.json` — resume anytime with `/workflow`.

### Dispatch agents directly

Ask pi to use the `team` tool. It'll show up automatically:

```
> Have the scout agent find all authentication-related code in this project

> Use team in parallel mode — send security-reviewer and quality-reviewer
  to analyze src/auth/

> Chain: scout maps the database layer, then architect reviews the structure
```

### Enable TDD enforcement

```
/tdd tdd
```

Now try writing code without a test:
```
> Write src/utils.ts with a helper function

🚫 TDD: Create a test file first. Expected: src/utils.test.ts
   Write a failing test, run it, then implement.
```

The AI learns fast. After one block, it writes tests first on its own.

### Run individual tasks with SDD

For more control, use `/sdd` to run individual tasks through the review pipeline:

```
/sdd load plan.md
/sdd run
```

---

## Features

### 🤖 Multi-Agent Dispatch

The `team` tool dispatches specialized agents in isolated subprocesses. Each gets its own context window, model, thinking level, and tools — no cross-contamination.

**Three dispatch modes:**

| Mode | Usage | Description |
|------|-------|-------------|
| **Single** | `agent` + `task` | One agent, one task |
| **Parallel** | `tasks: [{agent, task}, ...]` | Up to 8 concurrent agents (4 concurrency limit) |
| **Chain** | `chain: [{agent, task}, ...]` | Sequential, `{previous}` passes context |

```
# Single — scout explores
Dispatch scout to find all files that handle payment processing

# Parallel — multiple reviewers at once  
Run security-reviewer and performance-reviewer in parallel on src/api/

# Chain — scout feeds implementer
Chain: scout finds the auth module, then implementer adds rate limiting.
Use {previous} to pass scout's findings.
```

### 🎯 Workflow Orchestrator

A deterministic state machine that drives the full development pipeline — agents do creative work, the orchestrator controls flow.

```
/workflow <description>    Start a new orchestrated workflow
/workflow                  Resume an in-progress workflow
/workflow status           Show current phase, task progress, cost
/workflow abort            Abort and clear state
```

**Seven phases (brainstorm pipeline):**

| Phase | What happens |
|-------|-------------|
| **brainstorm** | Scout explores codebase → brainstormer generates questions → you answer → approaches proposed → design sections written and approved |
| **plan-write** | Planner agent writes a detailed TDD plan from the approved design |
| **plan-review** | Architect + spec reviewer validate the plan against the design (planner revises if needed) |
| **configure** | Interactive dialogs for execution mode, review mode, and batch size |
| **execute** | Implement → spec review → quality review → optional reviews per task, with fix loops and live activity streaming |
| **finalize** | Final cross-task quality review + summary report |

The workflow persists to `.superteam-workflow.json` and resumes from where it left off. See the [Workflow Guide](docs/guides/workflow.md) for details.

### 🧪 TDD Guard

Hard enforcement at the tool level. The guard intercepts every `write`, `edit`, and `bash` call:

```
write(src/foo.ts)  →  Test file exists?  →  Tests run?  →  ✅ ALLOW
                          ↓ No                 ↓ No
                    🚫 "Create test first"  🚫 "Run tests first"
```

**Three-layer defense:**

| Layer | What | When |
|-------|------|------|
| **Rules** | Injects "write tests first" into context | Agent *thinks* about skipping tests |
| **Guard** | Blocks the `write`/`edit` tool call | Agent *tries* to skip tests |
| **Skills** | Teaches RED→GREEN→REFACTOR | Agent *doesn't know* the methodology |

**ATDD mode** adds acceptance test awareness — warns when writing unit tests without an acceptance test to frame the feature.

### 🔄 SDD Orchestration

Automated implement → review → fix loops for individual tasks:

```
/sdd load plan.md     Load tasks from a plan file
/sdd run              Execute current task through the pipeline
/sdd status           View progress across all tasks
/sdd next             Advance to next task
/sdd reset            Start over
```

**Pipeline per task:**
1. 🔨 **Implement** — dispatches implementer with TDD enforcement
2. 📋 **Spec review** — verifies implementation matches requirements
3. ✨ **Quality review** — checks code quality and test quality
4. 🔒 **Security review** — scans for vulnerabilities (optional, parallel)
5. ⚡ **Performance review** — identifies bottlenecks (optional, parallel)
6. 🔧 **Fix loop** — on failure, re-dispatches implementer with specific findings
7. 🚨 **Escalation** — after max retries, asks you for help

Reviews return structured JSON — no LLM needed to interpret results:
````
```superteam-json
{
  "passed": false,
  "findings": [{ "severity": "high", "file": "src/auth.ts", "line": 42, "issue": "..." }],
  "mustFix": ["src/auth.ts:42"],
  "summary": "Missing input validation on login endpoint"
}
```
````

### 📏 Context-Aware Rules

TTSR-inspired rule injection. When the AI's output matches a trigger pattern, corrective guidance is injected into the next turn's context.

**Built-in rules:**

| Rule | Triggers on | Action |
|------|------------|--------|
| `test-first` | "simple enough to skip tests" | Fires once: "Write tests first. No exceptions." |
| `yagni` | "might need later", "future-proof" | Cooldown: "Implement only what's needed now." |
| `no-impl-before-spec` | "let me just implement" | Per-turn: "Stop. Write the test first." |

**Create your own:**
```markdown
---
name: no-any
trigger: ": any\\b|as any\\b"
priority: medium
frequency: per-turn
---
Do NOT use `any` type. Use proper TypeScript types, generics, or `unknown`.
```

### 💰 Cost Tracking

Session-level budget with mid-stream enforcement:

```
/team                            # Shows cumulative session cost
```

```json
{
  "costs": {
    "warnAtUsd": 5.0,       // Notification at $5
    "hardLimitUsd": 20.0     // Hard block + subprocess kill at $20
  }
}
```

---

## Agents

| Agent | Purpose | Tools | Default Model |
|-------|---------|-------|---------------|
| 🔍 `scout` | Fast codebase recon | read, grep, find, ls, bash | haiku |
| 🔨 `implementer` | TDD implementation | all (+ TDD guard + TDD skill) | sonnet |
| 📋 `spec-reviewer` | Spec compliance check | read, grep, find, ls | sonnet |
| ✨ `quality-reviewer` | Code + test quality | read, grep, find, ls | sonnet |
| 🔒 `security-reviewer` | Vulnerability scanning | read, grep, find, ls | sonnet |
| ⚡ `performance-reviewer` | Bottleneck detection | read, grep, find, ls | sonnet |
| 🏗️ `architect` | Design + structure review | read, grep, find, ls | sonnet |

All models and thinking levels are configurable per agent via `modelOverrides` and `thinkingOverrides` in `.superteam.json`. The `/team` command shows the effective model and thinking level for each agent, with annotations showing whether values come from config overrides, frontmatter, or defaults.

**Custom agents** — drop a `.md` file in `~/.pi/agent/agents/`:

```markdown
---
name: api-reviewer
description: REST API design review
tools: read,grep,find,ls
model: claude-sonnet-4-5
thinking: high
---
Review REST API design for consistency, proper HTTP methods, status codes,
pagination, error format, and versioning strategy.

End with a ```superteam-json block.
```

See the [Agent Guide](docs/guides/agents.md) for details.

---

## Commands

| Command | Description |
|---------|-------------|
| `/team` | List agents with effective models/thinking levels and session cost |
| `/team --project` | Include project-local agents from `.pi/agents/` |
| `/tdd [off\|tdd\|atdd]` | Toggle/set TDD enforcement mode |
| `/tdd allow-bash-write once <reason>` | One-time bash write escape hatch |
| `/workflow <description>` | Start a new orchestrated workflow |
| `/workflow` | Resume an in-progress workflow |
| `/workflow status` | Show phase, task progress, and cost |
| `/workflow abort` | Abort workflow and clear state |
| `/sdd load <file>` | Load a plan file (lower-level) |
| `/sdd run` | Run SDD for current task |
| `/sdd status` | Show task progress |
| `/sdd next` | Advance to next task |
| `/sdd reset` | Reset SDD state |

### Tools

| Tool | Description |
|------|-------------|
| `team` | Dispatch agents (single, parallel, chain modes) — available to the AI |
| `workflow` | Run the orchestrator — available to the AI |

## Prompt Templates

| Template | Description |
|----------|-------------|
| `/sdd <plan.md>` | Start SDD for a plan |
| `/review-parallel <target>` | Parallel spec + quality review |
| `/scout <area>` | Scout a codebase area |
| `/implement <feature>` | Chain: scout → implementer |

---

## Configuration

Create `.superteam.json` in your project root. All settings are optional — defaults are sensible.

```json
{
  "configVersion": 1,
  "tddMode": "tdd",
  "testFilePatterns": ["*.test.ts", "*.spec.ts"],
  "testCommands": ["npm test", "npx vitest"],
  "exemptPaths": ["*.d.ts", "*.config.*"],
  "agents": {
    "defaultModel": "claude-sonnet-4-5",
    "scoutModel": "claude-haiku-4-5",
    "modelOverrides": {
      "implementer": "claude-opus-4-6"
    },
    "thinkingOverrides": {
      "implementer": "high",
      "architect": "xhigh",
      "scout": "low"
    }
  },
  "costs": {
    "warnAtUsd": 10.0,
    "hardLimitUsd": 50.0
  }
}
```

**Model override priority:** `config.agents.modelOverrides[name]` → agent frontmatter `model` → `scoutModel` (for scout) → `defaultModel`

**Thinking override priority:** `config.agents.thinkingOverrides[name]` → agent frontmatter `thinking` → undefined (no thinking)

**Valid thinking levels:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh` — invalid values are warned and dropped during config loading.

See the [Configuration Guide](docs/guides/configuration.md) for the full reference.

---

## Architecture

```
pi-superteam/
│
├── src/                              TypeScript extension source
│   ├── index.ts                      Entry point (thin composition root)
│   ├── config.ts                     Config discovery, defaults, ThinkingLevel type
│   ├── dispatch.ts                   Agent subprocess management, resolveAgentModel/Thinking
│   ├── team-display.ts               /team command formatting (formatAgentLine)
│   ├── review-parser.ts              Structured JSON extraction from reviewer output
│   ├── rules/engine.ts               Context-aware rule injection (TTSR)
│   └── workflow/
│       ├── state.ts                  SDD plan tracking + persistence
│       ├── tdd-guard.ts              TDD enforcement (tool call interception)
│       ├── sdd.ts                    SDD orchestration loop
│       ├── orchestrator.ts           Workflow orchestrator entry point + phase dispatch
│       ├── orchestrator-state.ts     Typed state, persistence, phase transitions
│       ├── prompt-builder.ts         Deterministic prompt construction for all agents
│       ├── interaction.ts            Structured user interaction helpers
│       ├── git-utils.ts              Async git utilities (tracked files, changed files, SHA)
│       └── phases/
│           ├── plan.ts               Plan draft phase (scout + planner)
│           ├── plan-review.ts        Plan review phase (architect + spec reviewer)
│           ├── configure.ts          Configure phase (review mode, exec mode, batch size)
│           ├── execute.ts            Execute phase (implement → review → fix loops)
│           └── finalize.ts           Finalize phase (cross-task review + report)
│
├── agents/                           Agent profiles (7 built-in)
│   ├── scout.md
│   ├── implementer.md
│   ├── spec-reviewer.md
│   ├── quality-reviewer.md
│   ├── security-reviewer.md
│   ├── performance-reviewer.md
│   └── architect.md
│
├── skills/                           Methodology skills (5)
│   ├── test-driven-development/
│   ├── acceptance-test-driven-development/
│   ├── subagent-driven-development/
│   ├── writing-plans/
│   └── brainstorming/
│
├── rules/                            Context rules (3)
│   ├── test-first.md
│   ├── yagni.md
│   └── no-impl-before-spec.md
│
├── prompts/                          Prompt templates (4)
│   ├── sdd.md
│   ├── review-parallel.md
│   ├── scout.md
│   └── implement.md
│
└── docs/guides/                      Documentation
```

**Design principles:**
- `index.ts` is a thin composition root — no business logic
- Every piece works independently (TDD guard without SDD, team tool without TDD, rules without either)
- Graceful degradation — missing models, unavailable tools, broken config all handled
- JSON-serializable state — no Maps or Sets, persistence via file or `pi.appendEntry()`
- Deterministic subprocesses — full isolation with explicit add-backs
- Workflow orchestrator is a pure state machine — agents do creative work, TypeScript controls flow

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Workflow](docs/guides/workflow.md) | Orchestrator phases, interaction points, execution modes, resuming |
| [Agents](docs/guides/agents.md) | Built-in agents, custom agents, model/thinking config, subprocess isolation |
| [TDD Guard](docs/guides/tdd-guard.md) | Enforcement mechanics, file mapping, modes, escape hatches |
| [SDD Workflow](docs/guides/sdd-workflow.md) | Plan format, review pipeline, fix loops, escalation |
| [Configuration](docs/guides/configuration.md) | Full `.superteam.json` reference |
| [Rules](docs/guides/rules.md) | How rules work, built-in rules, creating custom rules |
| [Contributing](CONTRIBUTING.md) | Development setup, project structure, PR guidelines |
| [Changelog](CHANGELOG.md) | Release notes |

---

## Credits

- TDD/SDD methodology adapted from [obra/superpowers](https://github.com/obra/superpowers) (MIT)
- TTSR concept inspired by [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT)
- Agent dispatch patterns from pi's built-in [subagent example](https://github.com/badlogic/pi-mono)
- LSP integration via [lsp-pi](https://www.npmjs.com/package/lsp-pi) (MIT, optional)

## License

MIT — see [LICENSE](LICENSE)
