# Agent Guide

Superteam dispatches specialized agents as isolated pi subprocesses. Each agent gets its own context window, model, thinking level, tools, and system prompt — completely independent from your main session.

## Built-in Agents

### scout

**Purpose:** Fast codebase reconnaissance. Finds relevant files, understands structure, returns compressed context for handoff to other agents.

| Property | Value |
|----------|-------|
| Default Model | `claude-haiku-4-5` (via `scoutModel`) |
| Tools | `read, grep, find, ls, bash` |
| Thinking | None by default |
| Best for | Exploring unfamiliar code, finding entry points, mapping dependencies |

**Example:**
```
Dispatch scout to find all files related to authentication and describe the auth flow
```

### implementer

**Purpose:** TDD implementation. Writes tests first, then implements, then refactors. Runs with the TDD guard extension loaded — enforcement is mechanical, not optional.

| Property | Value |
|----------|-------|
| Default Model | `claude-sonnet-4-5` (via `defaultModel`) |
| Tools | All tools (`read, bash, edit, write, grep, find, ls`) |
| Thinking | None by default |
| Extras | TDD guard extension, TDD skill |
| Best for | Implementing features, fixing bugs, refactoring with tests |

The implementer subprocess loads:
- `-e <packageDir>/src/index.ts` — TDD guard enforces test-first
- `--skill <packageDir>/skills/test-driven-development/SKILL.md` — teaches RED→GREEN→REFACTOR

### brainstormer

**Purpose:** Generate structured brainstorm outputs — clarifying questions, implementation approaches, and design sections. Read-only agent that returns structured JSON in `superteam-brainstorm` blocks.

| Property | Value |
|----------|-------|
| Default Model | `claude-sonnet-4-5` (via `defaultModel`) |
| Tools | `read, find, grep, ls` (read-only — no write, edit, or bash) |
| Thinking | None by default |
| Output | Structured `superteam-brainstorm` JSON |
| Best for | Interactive design refinement in the brainstorm phase |

The brainstormer supports three response types:
- **questions** — 3-7 clarifying questions (choice or open-ended)
- **approaches** — 2-3 implementation approaches with trade-offs and recommendation
- **design** — Detailed design sections (architecture, data flow, error handling, etc.)

### planner

**Purpose:** Write detailed TDD implementation plans. Can read and write files but has no bash or edit access — focused purely on planning.

| Property | Value |
|----------|-------|
| Default Model | `claude-sonnet-4-5` (via `defaultModel`) |
| Tools | `read, write, find, grep, ls` (no bash or edit) |
| Thinking | None by default |
| Output | Plan file with `superteam-tasks` YAML block |
| Best for | Writing implementation plans from approved designs |

The planner writes plans to a specified file path and includes a `superteam-tasks` block for machine parsing. Each task includes title, description, files, and TDD instructions.

### spec-reviewer

**Purpose:** Verify implementation matches specification. Reads the actual code (never trusts self-reports). Compares line-by-line against requirements.

| Property | Value |
|----------|-------|
| Default Model | `claude-sonnet-4-5` (via `defaultModel`) |
| Tools | `read, grep, find, ls` (read-only) |
| Thinking | None by default |
| Output | Structured `ReviewFindings` JSON |

### quality-reviewer

**Purpose:** Code quality and test quality review. Checks naming, DRY, error handling, complexity, test coverage, edge cases.

| Property | Value |
|----------|-------|
| Default Model | `claude-sonnet-4-5` (via `defaultModel`) |
| Tools | `read, grep, find, ls` (read-only) |
| Thinking | None by default |
| Output | Structured `ReviewFindings` JSON |

Also used in the workflow orchestrator's **finalize phase** for the final cross-task review.

### security-reviewer

**Purpose:** Security-focused review. Checks OWASP Top 10, injection vulnerabilities, auth flaws, secrets exposure, cryptographic misuse.

| Property | Value |
|----------|-------|
| Default Model | `claude-sonnet-4-5` (via `defaultModel`) |
| Tools | `read, grep, find, ls` (read-only) |
| Thinking | None by default |
| Output | Structured `ReviewFindings` JSON |

Optional review — runs in parallel with performance-reviewer during workflow execution. Only critical findings trigger escalation.

### performance-reviewer

**Purpose:** Performance analysis. Identifies bottlenecks, memory issues, N+1 queries, unnecessary allocations, scalability concerns.

| Property | Value |
|----------|-------|
| Default Model | `claude-sonnet-4-5` (via `defaultModel`) |
| Tools | `read, grep, find, ls` (read-only) |
| Thinking | None by default |
| Output | Structured `ReviewFindings` JSON |

Optional review — runs in parallel with security-reviewer during workflow execution. Only critical findings trigger escalation.

### architect

**Purpose:** Architecture review. Evaluates module boundaries, dependency direction, API design, separation of concerns, extensibility.

| Property | Value |
|----------|-------|
| Default Model | `claude-sonnet-4-5` (via `defaultModel`) |
| Tools | `read, grep, find, ls` (read-only) |
| Thinking | None by default |
| Output | Structured `ReviewFindings` JSON |

Used in the workflow orchestrator's **plan-review phase** alongside spec-reviewer.

## Creating Custom Agents

Custom agents are markdown files with YAML frontmatter. Place them in:

- **User-level:** `~/.pi/agent/agents/*.md` — always loaded, available in all projects
- **Project-level:** `.pi/agents/*.md` — requires `includeProjectAgents: true` in tool params, confirmed interactively

### Format

```markdown
---
name: my-agent
description: One-line description shown in agent list
tools: read,grep,find,ls
model: claude-sonnet-4-5
thinking: high
---

System prompt goes here. This is the full instruction set for the agent.

Be specific about:
- What the agent should focus on
- How it should format output
- What tools it should use and how
```

### Frontmatter Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | string | Unique agent identifier |
| `description` | Yes | string | One-line description shown in `/team` list |
| `tools` | No | string | Comma-separated tool list. Omit for all tools. |
| `model` | No | string | Model override. Falls back to config defaults. |
| `thinking` | No | string | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Overridden by config `thinkingOverrides`. Invalid values are silently ignored. |

### Override Priority

Both model and thinking level follow the same priority chain — **config overrides beat frontmatter, frontmatter beats defaults**:

**Model resolution** (implemented by `resolveAgentModel()` in `src/dispatch.ts`):
1. `config.agents.modelOverrides[agentName]` — highest priority
2. Agent frontmatter `model` field
3. `config.agents.scoutModel` (for scout agent only)
4. `config.agents.defaultModel` — lowest priority

**Thinking resolution** (implemented by `resolveAgentThinking()` in `src/dispatch.ts`):
1. `config.agents.thinkingOverrides[agentName]` — highest priority
2. Agent frontmatter `thinking` field
3. `undefined` — no `--thinking` flag passed to subprocess

This means you can override any agent's model or thinking level in `.superteam.json` without modifying agent files:

```json
{
  "agents": {
    "modelOverrides": {
      "implementer": "claude-opus-4-6",
      "security-reviewer": "claude-opus-4-6"
    },
    "thinkingOverrides": {
      "implementer": "high",
      "architect": "xhigh",
      "scout": "low"
    }
  }
}
```

### Custom Reviewer Template

If your custom agent is a reviewer, include the structured output contract:

```markdown
---
name: accessibility-reviewer
description: Review for WCAG 2.1 AA compliance
tools: read,grep,find,ls
---

You are an accessibility reviewer. Check all UI components for WCAG 2.1 AA compliance.

## What to Check
- Keyboard navigation
- Screen reader compatibility
- Color contrast ratios
- Focus management
- ARIA attributes

## Output Format

End your response with:

\`\`\`superteam-json
{
  "passed": true,
  "findings": [],
  "mustFix": [],
  "summary": "All components meet WCAG 2.1 AA standards"
}
\`\`\`
```

The structured JSON format (`ReviewFindings`) is:

```typescript
{
  passed: boolean;          // Did the review pass?
  findings: [{
    severity: "critical" | "high" | "medium" | "low";
    file: string;           // File path
    line?: number;          // Optional line number
    issue: string;          // What's wrong
    suggestion?: string;    // How to fix it
  }];
  mustFix: string[];        // File references that must be fixed
  summary: string;          // One-line summary
}
```

## Agent Resolution Order

When multiple agents have the same name, later sources override earlier ones:

1. **Package agents** (`agents/` in superteam) — lowest priority
2. **User agents** (`~/.pi/agent/agents/`) — override package agents
3. **Project agents** (`.pi/agents/`) — override all (when enabled)

This lets you customize any built-in agent by placing your version in `~/.pi/agent/agents/`.

## How `/team` Displays Effective Settings

The `/team` command shows each agent's effective configuration with source annotations:

```
scout [package] — Fast codebase reconnaissance
  model: claude-haiku-4-5 (config default), thinking: low (override), tools: read, grep, find, ls, bash

implementer [package] — TDD implementation
  model: claude-opus-4-6 (override), thinking: high (override), tools: read, bash, edit, write, grep, find, ls

architect [package] — Architecture review
  model: claude-sonnet-4-5, thinking: xhigh (override), tools: read, grep, find, ls
```

Annotations:
- **`(override)`** — value comes from `modelOverrides` or `thinkingOverrides` in `.superteam.json`
- **`(config default)`** — value comes from `defaultModel` or `scoutModel` config (agent has no frontmatter model)
- **No annotation** — value comes from agent frontmatter

Thinking level is only shown if one is set (via config override or frontmatter). If no thinking level is configured, it's omitted from the display.

This formatting is implemented by `formatAgentLine()` in `src/team-display.ts`.

## Subprocess Isolation

Every agent runs in a fully isolated subprocess:

```
pi --mode json -p --no-session \
   --no-extensions --no-skills --no-prompt-templates --no-themes \
   --model <model> \
   --thinking <thinking> \
   --tools <tools> \
   --append-system-prompt <temp-file> \
   "Task: <task>"
```

This means:
- **No inherited context** — the agent starts fresh
- **No other extensions** — only explicitly added ones load (e.g., implementer gets TDD guard)
- **No cross-contamination** — agents can't interfere with each other
- **Deterministic behavior** — same input → same behavior
- **Model + thinking per agent** — each subprocess gets its own `--model` and `--thinking` flags

The `--thinking` flag is only included when `resolveAgentThinking()` returns a non-undefined value.

The implementer is special: it additionally gets `-e <packageDir>/src/index.ts` (TDD guard) and `--skill <packageDir>/skills/test-driven-development/SKILL.md`.
