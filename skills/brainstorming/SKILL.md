---
name: Brainstorming
description: Explore design options before committing to an approach
globs: "**/*"
---

# Brainstorming

## When to Brainstorm

Before starting implementation, when:
- The problem has multiple viable solutions
- Requirements are ambiguous or underspecified
- The technical approach isn't obvious
- The scope is large enough to warrant planning

## Process

### 1. Understand the Problem
- What are we trying to achieve?
- Who are the users/consumers?
- What are the constraints?
- What already exists that we can build on?

### 2. Explore Options
- List at least 2-3 different approaches
- For each, identify:
  - **Pros**: What makes this approach good?
  - **Cons**: What are the downsides?
  - **Complexity**: How hard is this to implement?
  - **Risk**: What could go wrong?

### 3. Decide
- Choose the simplest approach that meets requirements
- Document WHY you chose it (not just what)
- Identify assumptions that could be wrong
- Plan how to validate the approach early

### 4. Transition to Planning
- Once the approach is decided, write a plan
- Break into tasks using the writing-plans skill
- Include a `superteam-tasks` block for automation

## Anti-Patterns

- ❌ Analysis paralysis — don't evaluate forever, pick and move
- ❌ Premature optimization — choose simple first, optimize later
- ❌ Gold plating — solve the problem at hand, not hypothetical future problems
- ❌ Skipping brainstorming — "obvious" solutions often aren't
