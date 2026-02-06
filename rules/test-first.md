---
name: test-first
trigger: "simple enough|don't need tests|skip testing|test later|too trivial|obvious enough|doesn't need a test|no test needed|overkill to test"
priority: high
frequency: once
---
IMPORTANT: You MUST write tests first. No implementation code without a failing test.

This applies regardless of how "simple" the code appears. Simple code becomes complex code. Untested code becomes buggy code. The RED→GREEN→REFACTOR cycle is non-negotiable.

Write a failing test FIRST. Then write the minimal implementation to make it pass. Then refactor.
