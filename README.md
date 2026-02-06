# pi-superteam

A [pi](https://github.com/badlogic/pi) extension package that combines multi-agent orchestration, TDD/ATDD enforcement, iterative review cycles, and context-aware rules into a unified development workflow.

## Features

### 🤖 Multi-Agent Dispatch
Dispatch specialized agents with isolated context windows:
- **Single mode** — one agent, one task
- **Parallel mode** — multiple agents simultaneously (up to 8, 4 concurrent)
- **Chain mode** — sequential agents with `{previous}` context passing

### 🧪 TDD/ATDD Guard
Hard enforcement of test-driven development via `tool_call` interception:
- Blocks writes to implementation files without a test file
- Blocks writes without tests having been run
- Bash heuristic catches shell-based file mutations
- ATDD mode warns when unit tests lack an acceptance test
- Three-layer defense: guard (mechanical) + rules (proactive) + skills (teaching)

### 🔄 SDD Orchestration
Subagent-Driven Development — automated implement → review → fix loops:
- Dispatches implementer agent per task (with TDD enforcement)
- Required reviews: spec compliance, code quality
- Optional reviews: security, performance (in parallel)
- Fix loops with structured findings passed back to implementer
- Escalation to human on max iterations or inconclusive output

### 📏 Context-Aware Rules
TTSR-like rule injection when anti-patterns detected:
- Scans recent assistant output for trigger patterns
- Injects corrective guidance as user messages
- Built-in rules: test-first, YAGNI, no-impl-before-spec
- Custom rules via markdown files with frontmatter

### 💰 Cost Tracking
Session-level cost tracking with configurable limits:
- Warning at configurable threshold (default $5)
- Hard limit with mid-stream abort (default $20)
- Per-dispatch and cumulative cost display

## Installation

```bash
pi install npm:pi-superteam
```

Or for development:
```bash
pi -e /path/to/superteam/src/index.ts
```

## Quick Start

### Direct Agent Dispatch
```
# Scout the codebase
Use the team tool to dispatch scout to find all authentication-related code

# Parallel reviews
Use team in parallel mode: security-reviewer on src/auth/, quality-reviewer on src/auth/

# Chain: explore then implement
Use team in chain mode: scout finds the relevant code, then implementer adds input validation
```

### SDD Workflow
```
/sdd load plan.md     # Load a plan with tasks
/sdd run              # Run SDD for current task
/sdd status           # Check progress
/sdd next             # Advance to next task
```

### TDD Control
```
/tdd                  # Toggle: off → tdd → atdd → off
/tdd tdd              # Enable TDD mode
/tdd atdd             # Enable ATDD mode
/tdd off              # Disable
/tdd allow-bash-write once "generating config"  # One-time escape hatch
```

### Prompt Templates
```
/sdd plan.md          # Start SDD for a plan
/review-parallel src/ # Parallel review of a directory
/scout auth module    # Scout a specific area
/implement pagination # Chain: scout → implementer
```

## Available Agents

| Agent | Role | Tools |
|-------|------|-------|
| `scout` | Fast codebase reconnaissance | read, grep, find, ls, bash |
| `implementer` | TDD implementation (with guard) | all tools |
| `spec-reviewer` | Verify spec compliance | read, grep, find, ls |
| `quality-reviewer` | Code + test quality | read, grep, find, ls |
| `security-reviewer` | Vulnerability scanning | read, grep, find, ls |
| `performance-reviewer` | Performance analysis | read, grep, find, ls |
| `architect` | Design + structure review | read, grep, find, ls |

## Configuration

Create `.superteam.json` in your project root:

```json
{
  "configVersion": 1,
  "tddMode": "off",
  "testFilePatterns": ["*.test.ts", "*.spec.ts", "__tests__/*.ts"],
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
    "parallelOptional": true
  },
  "agents": {
    "defaultModel": "claude-sonnet-4-5",
    "scoutModel": "claude-haiku-4-5",
    "modelOverrides": {}
  },
  "costs": {
    "warnAtUsd": 5.0,
    "hardLimitUsd": 20.0
  }
}
```

## Custom Agents

Add custom agents as markdown files with YAML frontmatter:

**User agents** (`~/.pi/agent/agents/*.md`):
```markdown
---
name: my-reviewer
description: Custom domain-specific reviewer
tools: read,grep,find,ls
model: claude-sonnet-4-5
---
You are a reviewer focused on [domain]. Check for [specific concerns].

End with a ```superteam-json block with ReviewFindings JSON.
```

**Project agents** (`.pi/agents/*.md`) — require `includeProjectAgents: true`.

## Architecture

```
src/
  index.ts              — Extension entry point (thin composition root)
  config.ts             — Config discovery, defaults, packageDir resolution
  dispatch.ts           — Agent loading, subprocess spawning, cost tracking
  review-parser.ts      — Structured reviewer JSON extraction + validation
  rules/
    engine.ts           — TTSR-like context-aware rule injection
  workflow/
    state.ts            — Plan tracking, persistence, widget rendering
    tdd-guard.ts        — TDD/ATDD enforcement via tool_call interception
    sdd.ts              — SDD orchestration loop

agents/                 — Agent profiles (markdown with frontmatter)
skills/                 — Methodology skills (TDD, ATDD, SDD, planning)
rules/                  — Context rules (test-first, YAGNI, no-impl-before-spec)
prompts/                — Prompt templates for common workflows
```

## Credits

- TDD/SDD methodology adapted from [obra/superpowers](https://github.com/obra/superpowers) (MIT)
- TTSR concept inspired by [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT)
- Agent dispatch pattern from pi's built-in [subagent example](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent)
- LSP integration via [lsp-pi](https://www.npmjs.com/package/lsp-pi) (MIT, optional)

## License

MIT
