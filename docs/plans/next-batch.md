# Next Batch — ATDD

15 items. Full ATDD: acceptance tests first, then unit tests, then implementation.

Items ordered by priority. #1 is the most impactful — every workflow phase feels broken without it.

## 1. Streaming activity feedback for all workflow phases
The execute phase has `createActivityBuffer()` + `makeOnStreamEvent()` to show live tool calls during agent dispatch. Brainstorm, plan-write, and plan-review phases don't — they call `dispatchAgent()` without an `onStreamEvent` callback. The UI appears frozen for 10-30+ seconds during scout/brainstormer/planner/reviewer dispatch with no indication anything is happening. Users have to guess whether the workflow is alive. Add activity streaming to all phases that dispatch agents. This is the single biggest UX problem.

## 2. Richer brainstorm question interaction
Currently each question is a single-shot `ui.select()` or `ui.input()` — answer and move on. Replace with `ctx.ui.custom()` using the pattern from pi's `examples/extensions/question.ts`: options list + inline editor for free-text. Each question should offer: predefined choices + "Discuss further" + "Skip / Not sure" + free-text input. "Discuss" opens a multi-turn loop: dispatch brainstormer with user's comment, show response, re-ask until user picks a final answer. Add ability to go back to previous questions, and show a recap of all answers before proceeding to approaches. Unanswered questions get passed as "user deferred — use your best judgment." Same pattern applies to approach selection — user should be able to discuss tradeoffs before committing.

## 3. Brainstorm skip option
Add `/workflow --skip-brainstorm "description"` and a "Skip to planning" choice after scout completes in brainstorm phase. High UX value — most tasks don't need full brainstorm.

## 4. Inject `.pi/context.md` into subagent prompts
In `buildSubprocessArgs()` (`dispatch.ts`), read `.pi/context.md` and append to agent system prompt. ~15 lines. Every subagent gets static project context.

## 5. Harden review parser (`superteam-json`)
`review-parser.ts` still uses simple regex extraction. Apply the same defense as brainstorm parser: quote-aware fence extraction, newline sanitization, fallback chain.

## 6. Plan file path fallback
`plan-write.ts` expects the planner to write to an exact path. Add fallback: search `docs/plans/` for recently written `.md` files, or parse agent output for actual path used.

## 7. Rollback on failure
`gitShaBeforeImpl` is already tracked in `TaskExecState`. On max-retry escalation, offer "Rollback" alongside Retry/Skip/Abort. Implementation: `git reset --hard <sha>` + confirmation.

## 8. Parallelize spec + quality reviews
In `execute.ts`, spec and quality reviews run sequentially but are independent. Use `dispatchParallel` to run them concurrently. Small change, saves wall-clock time per task.

## 9. Post-task deterministic summaries
After each task completes, generate a summary from dispatch result: changed files, cost, status. No LLM needed. Show via `ui.notify`, pass as lightweight context to next implementer, append to progress file.

## 10. Orchestrator-controlled git commits
Don't rely on the implementer to commit. After a task passes all reviews, the orchestrator commits with a standardized message. Consistent history, enables clean rollback.

## 11. Scout prompt refinement
Once `.pi/context.md` is injected (item 4), the scout no longer needs to rediscover project basics. Narrow the scout prompt to focus on dynamic context: current code state, areas relevant to the specific task.

## 12. Pre-review file validation gate
After implementation, before dispatching reviewers, run `tsc --noEmit` (or equivalent). Catches syntax errors before wasting a review cycle.

## 13. Test-file-only review check
Add explicit instruction to `buildSpecReviewPrompt()`: verify that implementation files were modified, not just test files. ~2 lines.

## 14. Remove duplicate review output format from prompt-builder
`REVIEW_OUTPUT_FORMAT` in `prompt-builder.ts` duplicates the `superteam-json` format instructions already in each reviewer's agent markdown (system prompt). Remove from prompt-builder — agent markdown is authoritative and always present, even for direct `team` dispatch. Saves ~150 tokens per review call.

## 15. Add bash to security-reviewer tools
`security-reviewer.md` currently has `read,grep,find,ls`. Add `bash` so it can run `npm audit`, check file permissions, inspect git history for leaked secrets. Other reviewers stay read-only.
