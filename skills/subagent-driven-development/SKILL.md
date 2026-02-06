---
name: Subagent-Driven Development
description: Break work into tasks, dispatch specialized agents, review iteratively
globs: "**/*"
---

# Subagent-Driven Development (SDD)

## Overview

SDD uses specialized agents to implement and review code. Instead of doing everything yourself, you:
1. Plan the work (break into tasks)
2. Dispatch an implementer agent per task
3. Review with specialized reviewers
4. Fix and re-review until quality passes

## Workflow

### 1. Create a Plan

Write a plan with clear, independent tasks. Use the `superteam-tasks` format:

````markdown
```superteam-tasks
- title: Create user model
  description: Define User type with validation
  files: [src/models/user.ts, src/models/user.test.ts]
- title: Add authentication
  description: JWT-based auth with login/logout
  files: [src/auth.ts, src/auth.test.ts]
```
````

Each task should be:
- **Independent** — can be implemented without other tasks
- **Testable** — has clear success criteria
- **Small** — completable in one agent session

### 2. Load and Run

```
/sdd load plan.md     — Load the plan
/sdd run              — Run SDD for current task
/sdd status           — Check progress
/sdd next             — Skip to next task
```

### 3. Review Cycle

For each task, the SDD orchestrator:
1. Dispatches **implementer** (with TDD enforcement)
2. Runs **spec review** (does code match spec?)
3. Runs **quality review** (is code well-written?)
4. Optionally runs **security** and **performance** reviews in parallel
5. On failure: re-dispatches implementer with specific findings
6. On max retries: escalates to you

### 4. Available Agents

| Agent | Role | Tools |
|-------|------|-------|
| scout | Fast recon, find relevant code | read, grep, find, ls, bash |
| implementer | TDD implementation | all tools |
| spec-reviewer | Verify spec compliance | read, grep, find, ls |
| quality-reviewer | Code + test quality | read, grep, find, ls |
| security-reviewer | Vulnerability scanning | read, grep, find, ls |
| performance-reviewer | Performance analysis | read, grep, find, ls |
| architect | Design + structure review | read, grep, find, ls |

### 5. Direct Team Use

You can also use the `team` tool directly without SDD:

```
"Dispatch scout to find all database access patterns"
"Run security-reviewer and performance-reviewer in parallel on src/auth/"
"Chain: scout finds the code, then architect reviews the structure"
```

## Best Practices

- **Small tasks** — each task should touch 1-3 files
- **Clear specs** — reviewers need to know what to check against
- **Don't skip reviews** — they catch real bugs
- **Fix, don't argue** — when a reviewer finds an issue, fix it
- **Monitor costs** — use `/team` to check session cost
