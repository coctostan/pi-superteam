# Agent Guide

Superteam dispatches specialized agents as isolated pi subprocesses. Each agent gets its own context window, model, tools, and system prompt — completely independent from your main session.

## Built-in Agents

### scout

**Purpose:** Fast codebase reconnaissance. Finds relevant files, understands structure, returns compressed context for handoff to other agents.

| Property | Value |
|----------|-------|
| Model | `claude-haiku-4-5` (configurable) |
| Tools | `read, grep, find, ls, bash` |
| Best for | Exploring unfamiliar code, finding entry points, mapping dependencies |

**Example:**
```
Dispatch scout to find all files related to authentication and describe the auth flow
```

### implementer

**Purpose:** TDD implementation. Writes tests first, then implements, then refactors. Runs with the TDD guard extension loaded — enforcement is mechanical, not optional.

| Property | Value |
|----------|-------|
| Model | `claude-sonnet-4-5` (configurable) |
| Tools | All tools |
| Extras | TDD guard extension, TDD skill |
| Best for | Implementing features, fixing bugs, refactoring with tests |

The implementer subprocess loads:
- `-e <packageDir>/src/index.ts` — TDD guard enforces test-first
- `--skill <packageDir>/skills/test-driven-development/SKILL.md` — teaches RED→GREEN→REFACTOR

### spec-reviewer

**Purpose:** Verify implementation matches specification. Reads the actual code (never trusts self-reports). Compares line-by-line against requirements.

| Property | Value |
|----------|-------|
| Model | `claude-sonnet-4-5` (configurable) |
| Tools | `read, grep, find, ls` (read-only) |
| Output | Structured `ReviewFindings` JSON |

### quality-reviewer

**Purpose:** Code quality and test quality review. Checks naming, DRY, error handling, complexity, test coverage, edge cases.

| Property | Value |
|----------|-------|
| Model | `claude-sonnet-4-5` (configurable) |
| Tools | `read, grep, find, ls` (read-only) |
| Output | Structured `ReviewFindings` JSON |

### security-reviewer

**Purpose:** Security-focused review. Checks OWASP Top 10, injection vulnerabilities, auth flaws, secrets exposure, cryptographic misuse.

| Property | Value |
|----------|-------|
| Model | `claude-sonnet-4-5` (configurable) |
| Tools | `read, grep, find, ls` (read-only) |
| Output | Structured `ReviewFindings` JSON |

### performance-reviewer

**Purpose:** Performance analysis. Identifies bottlenecks, memory issues, N+1 queries, unnecessary allocations, scalability concerns.

| Property | Value |
|----------|-------|
| Model | `claude-sonnet-4-5` (configurable) |
| Tools | `read, grep, find, ls` (read-only) |
| Output | Structured `ReviewFindings` JSON |

### architect

**Purpose:** Architecture review. Evaluates module boundaries, dependency direction, API design, separation of concerns, extensibility.

| Property | Value |
|----------|-------|
| Model | `claude-sonnet-4-5` (configurable) |
| Tools | `read, grep, find, ls` (read-only) |
| Output | Structured `ReviewFindings` JSON |

## Creating Custom Agents

Custom agents are markdown files with YAML frontmatter. Place them in:

- **User-level:** `~/.pi/agent/agents/*.md` — always loaded, available in all projects
- **Project-level:** `.pi/agents/*.md` — requires `includeProjectAgents: true`, confirmed interactively

### Format

```markdown
---
name: my-agent
description: One-line description shown in agent list
tools: read,grep,find,ls
model: claude-sonnet-4-5
---

System prompt goes here. This is the full instruction set for the agent.

Be specific about:
- What the agent should focus on
- How it should format output
- What tools it should use and how
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique agent identifier |
| `description` | Yes | One-line description |
| `tools` | No | Comma-separated tool list. Omit for all tools. |
| `model` | No | Model override. Falls back to config defaults. |

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

## Agent Resolution Order

When multiple agents have the same name, later sources override earlier ones:

1. **Package agents** (`agents/` in superteam) — lowest priority
2. **User agents** (`~/.pi/agent/agents/`) — override package agents
3. **Project agents** (`.pi/agents/`) — override all (when enabled)

This lets you customize any built-in agent by placing your version in `~/.pi/agent/agents/`.

## Model Configuration

Agent models can be overridden in `.superteam.json` without modifying agent files:

```json
{
  "agents": {
    "defaultModel": "claude-sonnet-4-5",
    "scoutModel": "claude-haiku-4-5",
    "modelOverrides": {
      "implementer": "claude-opus-4-6",
      "security-reviewer": "claude-opus-4-6"
    }
  }
}
```

Resolution order: `modelOverrides[name]` → agent frontmatter `model` → `scoutModel` (for scout) → `defaultModel`

## Subprocess Isolation

Every agent runs in a fully isolated subprocess:

```
pi --mode json -p --no-session \
   --no-extensions --no-skills --no-prompt-templates --no-themes \
   --model <model> --tools <tools> \
   --append-system-prompt <temp-file> \
   "Task: <task>"
```

This means:
- **No inherited context** — the agent starts fresh
- **No other extensions** — only explicitly added ones load
- **No cross-contamination** — agents can't interfere with each other
- **Deterministic behavior** — same input → same behavior
