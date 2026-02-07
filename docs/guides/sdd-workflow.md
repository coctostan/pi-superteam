# SDD Workflow

Subagent-Driven Development (SDD) automates the implement → review → fix cycle. You write a plan, superteam executes each task through a pipeline of specialized agents.

## Overview

```
Plan                    Per-Task Pipeline
┌──────────────┐       ┌─────────────────────────────────────────────────┐
│ Task 1       │──────▶│ Implementer → Spec Review → Quality Review     │
│ Task 2       │       │     │              │              │             │
│ Task 3       │       │     │         fail │         fail │             │
│ ...          │       │     │     ┌────────┘     ┌────────┘             │
│              │       │     │     ▼              ▼                      │
│              │       │     │   Fix → Re-review  Fix → Re-review       │
│              │       │     │                                          │
│              │       │     └──▶ Optional: Security + Performance ──┐  │
│              │       │                                              │  │
│              │       │         Critical findings? → Fix + Re-review │  │
│              │       │                                              │  │
│              │       │         ✓ Complete ◀──────────────────────────┘  │
└──────────────┘       └─────────────────────────────────────────────────┘
```

## Step by Step

### 1. Write a Plan

Create a markdown file with a `superteam-tasks` block:

```markdown
# Feature: User Registration

## Overview
Add user registration with email validation and password hashing.

## Tasks

\`\`\`superteam-tasks
- title: Create user model
  description: Define User type with email and password fields, add validation
  files: [src/models/user.ts, src/models/user.test.ts]
- title: Add password hashing
  description: Bcrypt-based password hashing service
  files: [src/services/hash.ts, src/services/hash.test.ts]
- title: Registration endpoint
  description: POST /register with input validation and duplicate check
  files: [src/routes/register.ts, src/routes/register.test.ts]
\`\`\`
```

Alternatively, use `### Task N:` headings — the parser supports both formats.

### 2. Load the Plan

```
/sdd load plan.md
```

Output: `Loaded 3 tasks from plan.md (fenced parser)`

### 3. Run SDD

```
/sdd run
```

This triggers the full pipeline for the current task:

1. **Implement** — dispatches implementer with task description + TDD enforcement
2. **File tracking** — computes changed files via `git diff --name-only`
3. **Spec review** — dispatches spec-reviewer, parses structured JSON output
4. **Quality review** — dispatches quality-reviewer, parses structured JSON output
5. **Optional reviews** — security + performance reviewers in parallel (if configured)

### 4. Review Results

If all reviews pass → task is marked complete, auto-advances to next task.

If a review fails → implementer is re-dispatched with specific findings:
```
Fix spec review findings for task: Create user model
Changed files: src/models/user.ts, src/models/user.test.ts

Must fix:
  - src/models/user.ts:15

Findings:
  [HIGH] src/models/user.ts:15: Missing email format validation
    → Add regex validation matching RFC 5322
```

The fix → re-review loop continues up to `maxIterations` (default: 3).

### 5. Escalation

If the loop exceeds max iterations, produces inconclusive output, or hits cost limits, SDD escalates to you:

```
⚠ Task 1: "Create user model" — escalated

spec review failed after 3 attempts.
Summary: Email validation still missing after 3 fix attempts.

Options: fix manually, then /sdd run to retry, or /sdd next to skip.
```

### 6. Continue

```
/sdd run     # Run next task (or retry current after manual fix)
/sdd next    # Skip current task
/sdd status  # Check progress
/sdd reset   # Start over
```

## Structured Reviewer Output

All reviewers output JSON in a fenced block:

````
```superteam-json
{
  "passed": false,
  "findings": [
    {
      "severity": "high",
      "file": "src/models/user.ts",
      "line": 15,
      "issue": "Missing email format validation",
      "suggestion": "Add regex validation matching RFC 5322"
    }
  ],
  "mustFix": ["src/models/user.ts:15"],
  "summary": "1 of 3 requirements not implemented"
}
```
````

The review parser handles:
- **Fenced block** (primary) — `\`\`\`superteam-json ... \`\`\``
- **Brace fallback** — last `{...}` block in output
- **Inconclusive** — if neither found, escalates to human

## Configuration

```json
{
  "review": {
    "maxIterations": 3,
    "required": ["spec", "quality"],
    "optional": ["security", "performance"],
    "parallelOptional": true,
    "escalateOnMaxIterations": true
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `maxIterations` | 3 | Max fix→re-review cycles per review type |
| `required` | `["spec", "quality"]` | Reviews that must pass |
| `optional` | `["security", "performance"]` | Extra reviews (skip on cost limit) |
| `parallelOptional` | `true` | Run optional reviews in parallel |
| `escalateOnMaxIterations` | `true` | Ask human vs. silently continue |

## Cost Awareness

SDD checks the cost budget before every dispatch:
- Pre-dispatch check against `costs.hardLimitUsd`
- Mid-stream abort if hard limit reached during agent execution
- Optional reviews skipped if approaching limit
- `/team` command shows cumulative session cost
