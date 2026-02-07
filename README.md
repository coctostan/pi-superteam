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

### Run an automated SDD workflow

Create a plan:
```markdown
# Feature: Rate Limiting

\`\`\`superteam-tasks
- title: Token bucket implementation
  description: Implement token bucket rate limiter with configurable rate and burst
  files: [src/rate-limiter.ts]
- title: Middleware integration
  description: Express middleware that applies rate limiting per IP
  files: [src/middleware/rate-limit.ts]
\`\`\`
```

Then:
```
/sdd load plan.md
/sdd run
```

Superteam dispatches the implementer (with TDD enforcement), runs spec + quality reviews, fixes issues automatically, and advances to the next task.

---

## Features

### 🤖 Multi-Agent Dispatch

The `team` tool dispatches specialized agents in isolated subprocesses. Each gets its own context window, model, and tools — no cross-contamination.

**Three dispatch modes:**

| Mode | Usage | Description |
|------|-------|-------------|
| **Single** | `agent` + `task` | One agent, one task |
| **Parallel** | `tasks: [{agent, task}, ...]` | Up to 8 concurrent agents |
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

Automated implement → review → fix loops:

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

| Agent | Purpose | Tools | Model |
|-------|---------|-------|-------|
| 🔍 `scout` | Fast codebase recon | read, grep, find, ls, bash | haiku |
| 🔨 `implementer` | TDD implementation | all (+ TDD guard) | sonnet |
| 📋 `spec-reviewer` | Spec compliance check | read-only | sonnet |
| ✨ `quality-reviewer` | Code + test quality | read-only | sonnet |
| 🔒 `security-reviewer` | Vulnerability scanning | read-only | sonnet |
| ⚡ `performance-reviewer` | Bottleneck detection | read-only | sonnet |
| 🏗️ `architect` | Design + structure review | read-only | sonnet |

**Custom agents** — drop a `.md` file in `~/.pi/agent/agents/`:

```markdown
---
name: api-reviewer
description: REST API design review
tools: read,grep,find,ls
model: claude-sonnet-4-5
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
| `/team` | List agents and session cost |
| `/tdd [off\|tdd\|atdd]` | Toggle TDD enforcement mode |
| `/tdd allow-bash-write once <reason>` | One-time bash write escape hatch |
| `/sdd load <file>` | Load a plan file |
| `/sdd run` | Run SDD for current task |
| `/sdd status` | Show task progress |
| `/sdd next` | Advance to next task |
| `/sdd reset` | Reset SDD state |

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

See the [Configuration Guide](docs/guides/configuration.md) for the full reference.

---

## Architecture

```
pi-superteam/
│
├── src/                          TypeScript extension source
│   ├── index.ts                  Entry point (thin composition root)
│   ├── config.ts                 Config discovery + defaults
│   ├── dispatch.ts               Agent subprocess management
│   ├── review-parser.ts          Structured JSON extraction
│   ├── rules/engine.ts           Context-aware rule injection
│   └── workflow/
│       ├── state.ts              Plan tracking + persistence
│       ├── tdd-guard.ts          TDD enforcement
│       └── sdd.ts                SDD orchestration loop
│
├── agents/                       Agent profiles (7 built-in)
├── skills/                       Methodology skills (5)
├── rules/                        Context rules (3)
├── prompts/                      Prompt templates (4)
└── docs/guides/                  Documentation
```

**Design principles:**
- `index.ts` is a thin composition root — no business logic
- Every piece works independently (TDD guard without SDD, team tool without TDD, rules without either)
- Graceful degradation — missing models, unavailable tools, broken config all handled
- JSON-serializable state — no Maps or Sets, persistence via `pi.appendEntry()`
- Deterministic subprocesses — full isolation with explicit add-backs

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Agents](docs/guides/agents.md) | Built-in agents, custom agents, model config, subprocess isolation |
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
