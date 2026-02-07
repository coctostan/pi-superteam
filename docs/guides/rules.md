# Context-Aware Rules

Superteam includes a rule engine inspired by [oh-my-pi's TTSR](https://github.com/can1357/oh-my-pi). Rules watch the AI's output in real-time and inject corrective guidance when anti-patterns are detected.

## How It Works

1. On each context event, the engine scans the last 2000 characters of assistant output
2. Each rule has a trigger regex — if it matches, the rule fires
3. Fired rules are injected as user messages at the end of the context
4. The AI sees the rule content with high recency weight and course-corrects

## Built-in Rules

### test-first
**Trigger:** "simple enough", "don't need tests", "skip testing", "too trivial", etc.  
**Priority:** High | **Frequency:** Once per session

Fires when the AI rationalizes skipping tests. Redirects to write tests first.

### yagni
**Trigger:** "might need later", "future-proof", "just in case", "extensible for", etc.  
**Priority:** Medium | **Frequency:** Cooldown of 3 turns

Fires when the AI over-engineers. Reminds to implement only what's needed now.

### no-impl-before-spec
**Trigger:** "let me just implement", "code first", "start with the implementation", etc.  
**Priority:** High | **Frequency:** Per turn

Fires when the AI tries to implement before writing a test/spec. Stops and redirects.

## Creating Custom Rules

Rules are markdown files with YAML frontmatter. Place them in your project:

```markdown
---
name: no-console-log
trigger: "console\\.log|console\\.debug|console\\.info"
priority: medium
frequency: per-turn
---
Do NOT use console.log for debugging. Use the project's structured logger instead:

import { logger } from './lib/logger';
logger.debug('message', { context });
```

### Frontmatter Fields

| Field | Required | Values | Description |
|-------|----------|--------|-------------|
| `name` | Yes | string | Unique rule identifier |
| `trigger` | Yes | regex | Pattern to match in assistant output (case-insensitive) |
| `priority` | No | `high`, `medium`, `low` | Determines injection order. Default: `medium` |
| `frequency` | No | `once`, `per-turn`, `cooldown:N` | How often the rule can fire. Default: `per-turn` |

### Frequency Options

| Frequency | Behavior |
|-----------|----------|
| `once` | Fires once per session, then never again |
| `per-turn` | Can fire every turn where trigger matches |
| `cooldown:5` | After firing, waits 5 turns before it can fire again |

### Rule Locations

- **Package rules** (`rules/` in superteam) — loaded automatically
- **Project rules** — place in a directory and load via the rule engine

## How Rules Complement the Guard

Rules and the TDD guard work together as a two-layer defense:

```
Agent thinks: "This is simple enough to skip tests"
                │
                ▼
        Rule engine fires: "IMPORTANT: Write tests first!"
                │
                ▼
        Agent ignores rule, tries write anyway
                │
                ▼
        TDD guard blocks: "Create a test file first"
                │
                ▼
        Agent understands, writes test first ✓
```

Rules catch the intent. The guard catches the action. Together, they make TDD the path of least resistance.
