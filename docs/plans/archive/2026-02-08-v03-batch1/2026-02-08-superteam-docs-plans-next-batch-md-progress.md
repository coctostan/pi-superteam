# Workflow: superteam/docs/plans/next-batch.md

**Phase:** Done | **Cost:** $59.45

## Brainstorm

- [x] Scout codebase
- [x] Requirements
- [x] Approaches
- [x] Design sections
- [x] Design approved

## Tasks

- [x] 1. Create extractFencedBlock in parse-utils.ts
- [x] 2. Add extractLastBraceBlock and sanitizeJsonNewlines to parse-utils.ts
- [x] 3. Wire brainstorm-parser.ts to use parse-utils.ts
- [x] 4. Wire review-parser.ts to use parse-utils.ts
- [x] 5. Delete REVIEW_OUTPUT_FORMAT from prompt-builder.ts
- [x] 6. Inject .pi/context.md into subagent prompts
- [x] 7. Add test-file instruction to buildSpecReviewPrompt
- [x] 8. Add bash to security-reviewer tools
- [x] 9. Narrow scout prompt
- [x] 10. Add validationCommand to SuperteamConfig
- [x] 11. Add resetToSha and squashCommitsSince to git-utils.ts
- [x] 12. Add summary field to TaskExecState
- [x] 13. Add previousTaskSummary to buildImplPrompt
- [x] 14. Add rollback option to escalate in execute.ts
- [x] 15. Add validation gate before reviews in execute.ts
- [x] 16. Add onStreamEvent wiring to brainstorm phase
- [x] 17. Add onStreamEvent wiring to plan-write phase
- [x] 18. Add onStreamEvent wiring to plan-review phase
- [x] 19. Add brainstorm skip option
- [x] 20. Add plan file path fallback in plan-write.ts

## Configuration

- **tddMode:** tdd
- **maxPlanReviewCycles:** 3
- **maxTaskReviewCycles:** 3
- **executionMode:** auto
- **batchSize:** 3
- **reviewMode:** single-pass
