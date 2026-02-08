# Workflow: superteam/docs/plans/next-batch.md

**Phase:** Execute | **Cost:** $7.05

## Brainstorm

- [x] Scout codebase
- [x] Requirements
- [x] Approaches
- [x] Design sections
- [x] Design approved

## Tasks

- [x] 1. Create extractFencedBlock in parse-utils.ts
- [x] 2. Add extractLastBraceBlock and sanitizeJsonNewlines to parse-utils.ts
- [ ] 3. Wire brainstorm-parser.ts to use parse-utils.ts *(implementing)*
- [ ] 4. Wire review-parser.ts to use parse-utils.ts
- [ ] 5. Delete REVIEW_OUTPUT_FORMAT from prompt-builder.ts
- [ ] 6. Inject .pi/context.md into subagent prompts
- [ ] 7. Add test-file instruction to buildSpecReviewPrompt
- [ ] 8. Add bash to security-reviewer tools
- [ ] 9. Narrow scout prompt
- [ ] 10. Add validationCommand to SuperteamConfig
- [ ] 11. Add resetToSha and squashCommitsSince to git-utils.ts
- [ ] 12. Add summary field to TaskExecState
- [ ] 13. Add previousTaskSummary to buildImplPrompt
- [ ] 14. Add rollback option to escalate in execute.ts
- [ ] 15. Add validation gate before reviews in execute.ts
- [ ] 16. Add onStreamEvent wiring to brainstorm phase
- [ ] 17. Add onStreamEvent wiring to plan-write phase
- [ ] 18. Add onStreamEvent wiring to plan-review phase
- [ ] 19. Add brainstorm skip option
- [ ] 20. Add plan file path fallback in plan-write.ts

## Configuration

- **tddMode:** tdd
- **maxPlanReviewCycles:** 3
- **maxTaskReviewCycles:** 3
- **executionMode:** auto
- **batchSize:** 3
- **reviewMode:** single-pass
