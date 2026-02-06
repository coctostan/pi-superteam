---
name: no-impl-before-spec
trigger: "let me just implement|I'll write the code first|start with the implementation|code first.* test|implement.*then test|build it first"
priority: high
frequency: per-turn
---
STOP: Do not implement before specifying.

The correct order is:
1. Understand the requirement
2. Write a test that specifies the expected behavior
3. Run the test — confirm it fails
4. Write the minimal implementation
5. Run the test — confirm it passes
6. Refactor if needed

You were about to skip steps 2-3. Go back and write the test first.
