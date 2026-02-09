import type { OrchestratorState, TaskExecState } from "../orchestrator-state.js";
import { saveState } from "../orchestrator-state.js";
import { buildImplPrompt, buildFixPrompt, buildSpecReviewPrompt, buildQualityReviewPrompt, extractPlanContext } from "../prompt-builder.js";
import { getCurrentSha, computeChangedFiles, resetToSha, squashTaskCommits } from "../git-utils.js";
import { discoverAgents, dispatchAgent, dispatchParallel, getFinalOutput, checkCostBudget, hasWriteToolCalls, type AgentProfile, type OnStreamEvent } from "../../dispatch.js";
import { parseReviewOutput, formatFindings, hasCriticalFindings, type ReviewFindings, type ParseResult } from "../../review-parser.js";
import { formatToolAction, formatTaskProgress, createActivityBuffer } from "../ui.js";
import { computeProgressSummary, formatProgressSummary } from "../progress.js";
import { getConfig } from "../../config.js";
import { runCrossTaskValidation, shouldRunValidation } from "../cross-task-validation.js";
import { captureBaseline } from "../test-baseline.js";
import { resolveFailureAction } from "../failure-taxonomy.js";
import { evaluateCheckpointTriggers, presentCheckpoint, presentPlanRevision, applyPlanAdjustment } from "../checkpoint.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFileCb);

type AgentMap = Map<string, AgentProfile>;
type Ctx = ExtensionContext | { cwd: string; hasUI?: boolean; ui?: any };

/** Run a validation command. Returns { success, error? }. Exported for testing. */
export async function runValidation(command: string, cwd: string): Promise<{ success: boolean; error?: string }> {
	if (!command) return { success: true };
	try {
		await execFileAsync("bash", ["-c", command], { cwd, timeout: 60_000 });
		return { success: true };
	} catch (err: any) {
		const stderr = err.stderr || err.message || "unknown error";
		return { success: false, error: String(stderr).slice(0, 500) };
	}
}

export async function runExecutePhase(
	state: OrchestratorState,
	ctx: Ctx,
	signal?: AbortSignal,
	userInput?: string,
): Promise<OrchestratorState> {
	const ui = (ctx as any).ui;

	// 0. Handle legacy pending escalation response (backward compat)
	if (state.pendingInteraction && userInput) {
		const response = userInput.trim().toLowerCase();
		const task = state.tasks[state.currentTaskIndex];

		if (response === "abort") {
			state.phase = "done";
			state.error = "Aborted by user";
			saveState(state, ctx.cwd);
			return state;
		}
		if (response === "skip") {
			task.status = "skipped";
			state.currentTaskIndex++;
			state.pendingInteraction = undefined;
			saveState(state, ctx.cwd);
		}
		if (response === "continue") {
			task.status = "pending";
			state.pendingInteraction = undefined;
		}
	}

	// 1. Discover agents
	const { agents } = discoverAgents(ctx.cwd, true);
	const agentMap: AgentMap = new Map();
	for (const a of agents) agentMap.set(a.name, a);

	const implementer = agentMap.get("implementer");
	const specReviewer = agentMap.get("spec-reviewer");
	const qualityReviewer = agentMap.get("quality-reviewer");

	const optionalReviewerNames = ["security-reviewer", "performance-reviewer"];
	const optionalReviewers = optionalReviewerNames
		.map(name => agentMap.get(name))
		.filter((a): a is AgentProfile => a !== undefined);

	// 2. Extract plan context
	const planContext = extractPlanContext(state.planContent || "");

	// 3. Config
	const maxRetries = state.config.maxTaskReviewCycles || 3;

	// 4. Activity buffer for streaming
	const activityBuffer = createActivityBuffer(10);

	// Stream event handler
	const makeOnStreamEvent = (): OnStreamEvent => {
		return (event) => {
			if (event.type === "tool_execution_start") {
				const action = formatToolAction(event);
				activityBuffer.push(action);
				ui?.setStatus?.("workflow", action);
				ui?.setWidget?.("workflow-activity", activityBuffer.lines());
			}
		};
	};

	// 4b. Capture test baseline if testCommand configured
	{
		const baselineConfig = getConfig(ctx.cwd);
		const testCommand = baselineConfig.testCommand || "";
		if (testCommand && !state.testBaseline) {
			ui?.notify?.("Capturing test baseline...", "info");
			state.testBaseline = await captureBaseline(testCommand, ctx.cwd);
			saveState(state, ctx.cwd);
		}
	}

	// 5. Task loop
	let batchCounter = 0;

	for (let i = state.currentTaskIndex; i < state.tasks.length; i++) {
		const task = state.tasks[i];
		state.currentTaskIndex = i;

		if (task.status === "complete" || task.status === "skipped" || task.status === "escalated") {
			continue;
		}

		// a. COST CHECK
		const costCheck = checkCostBudget(ctx.cwd);
		if (!costCheck.allowed) {
			state.error = `Cost budget exceeded: ${costCheck.warning || "limit reached"}`;
			state.phase = "done";
			saveState(state, ctx.cwd);
			return state;
		}

		// b. IMPLEMENT
		if (!implementer) {
			const escalation = await escalate(task, "No implementer agent found", ui, ctx.cwd);
			if (escalation === "abort") {
				state.error = "Aborted by user";
				saveState(state, ctx.cwd);
				return state;
			}
			if (escalation === "skip") {
				task.status = "skipped";
				saveState(state, ctx.cwd);
				continue;
			}
			// retry — decrement so for-loop re-runs this index
			i--;
			continue;
		}

		task.gitShaBeforeImpl = await getCurrentSha(ctx.cwd);
		task.status = "implementing";
		saveState(state, ctx.cwd);

		// Collect prior task summaries for context forwarding (D6)
		const priorTasks = state.tasks
			.filter(t => t.status === "complete" && t.summary)
			.map(t => t.summary!);

		const implResult = await dispatchAgent(
			implementer, buildImplPrompt(task, planContext, undefined, priorTasks), ctx.cwd, signal, undefined, makeOnStreamEvent(),
		);
		state.totalCostUsd += implResult.usage.cost;

		if (implResult.exitCode !== 0) {
			const reason = implResult.errorMessage || "Implementation failed (non-zero exit)";
			const escalation = await escalate(task, reason, ui, ctx.cwd);
			if (escalation === "abort") {
				state.error = "Aborted by user";
				saveState(state, ctx.cwd);
				return state;
			}
			if (escalation === "skip") {
				task.status = "skipped";
				saveState(state, ctx.cwd);
				continue;
			}
			// retry — decrement so for-loop re-runs this index
			task.status = "pending";
			i--;
			continue;
		}

		// c. VALIDATION GATE (with auto-fix retry)
		{
			const valConfig = getConfig(ctx.cwd);
			const validationCommand = valConfig.validationCommand || "";
			if (validationCommand) {
				const valResult = await runValidation(validationCommand, ctx.cwd);
				if (!valResult.success) {
					// Auto-fix attempt: dispatch implementer with error details
					if (implementer) {
						ui?.notify?.("Validation failed, attempting auto-fix...", "warning");
						const fixPrompt = `Fix these validation errors for task "${task.title}":\n\n${valResult.error}\n\nRun the validation command to verify: ${validationCommand}`;
						const fixResult = await dispatchAgent(
							implementer, fixPrompt, ctx.cwd, signal, undefined, makeOnStreamEvent(),
						);
						state.totalCostUsd += fixResult.usage.cost;

						// Re-run validation after fix (re-read config for testability)
						const revalConfig = getConfig(ctx.cwd);
						const revalCommand = revalConfig.validationCommand || "";
						const revalResult = revalCommand ? await runValidation(revalCommand, ctx.cwd) : { success: true };
						if (!revalResult.success) {
							const valAction = resolveFailureAction("validation-failure");
							if (valAction === "warn-continue") {
								ui?.notify?.(`Validation still failing after auto-fix: ${revalResult.error || "command exited with non-zero"}`, "warning");
							} else if (valAction === "ignore") {
								// Skip escalation
							} else {
								const reason = `Validation still failing after auto-fix: ${revalResult.error || "command exited with non-zero"}`;
								const escalation = await escalate(task, reason, ui, ctx.cwd);
								if (escalation === "abort") {
									state.error = "Aborted by user";
									saveState(state, ctx.cwd);
									return state;
								}
								if (escalation === "skip") {
									task.status = "skipped";
									saveState(state, ctx.cwd);
									continue;
								}
								task.status = "pending";
								i--;
								continue;
							}
						}
					} else {
						const valAction = resolveFailureAction("validation-failure");
						if (valAction === "warn-continue") {
							ui?.notify?.(`Validation failed: ${valResult.error || "command exited with non-zero"}`, "warning");
						} else if (valAction === "ignore") {
							// Skip escalation
						} else {
							const reason = `Validation failed: ${valResult.error || "command exited with non-zero"}`;
							const escalation = await escalate(task, reason, ui, ctx.cwd);
							if (escalation === "abort") {
								state.error = "Aborted by user";
								saveState(state, ctx.cwd);
								return state;
							}
							if (escalation === "skip") {
								task.status = "skipped";
								saveState(state, ctx.cwd);
								continue;
							}
						}
						task.status = "pending";
						i--;
						continue;
					}
				}
			}
		}

		// d. CHANGED FILES
		let changedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);

		// e+f. PARALLEL SPEC + QUALITY REVIEW
		{
			const reviewResult = await runParallelReviewLoop(
				state, task, specReviewer, qualityReviewer, implementer,
				changedFiles, maxRetries, ctx, signal, ui, makeOnStreamEvent,
			);
			if (reviewResult === "escalated") return state;
		}

		// g. OPTIONAL REVIEWS
		if (optionalReviewers.length > 0) {
			changedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);
			const optAgents = optionalReviewers;
			const optTasks = optAgents.map(() => buildQualityReviewPrompt(task, changedFiles));

			const optResults = await dispatchParallel(optAgents, optTasks, ctx.cwd, signal);
			for (const r of optResults) {
				state.totalCostUsd += r.usage.cost;
			}

			for (let j = 0; j < optResults.length; j++) {
				const output = getFinalOutput(optResults[j].messages);
				const parsed = parseReviewOutput(output);
				const reviewName = optAgents[j].name;

				if (parsed.status === "pass") {
					task.reviewsPassed.push(reviewName);
				} else if (parsed.status === "fail") {
					task.reviewsFailed.push(reviewName);
					if (hasCriticalFindings(parsed.findings)) {
						const escalation = await escalate(task, `Critical findings from ${reviewName}`, ui, ctx.cwd);
						if (escalation === "abort") {
							state.error = "Aborted by user";
							saveState(state, ctx.cwd);
							return state;
						}
						if (escalation === "skip") {
							task.status = "skipped";
							break;
						}
					}
				}
			}
			if (task.status === "skipped") {
				saveState(state, ctx.cwd);
				continue;
			}
		}

		// h. COMPLETE
		task.status = "complete";

		// h1. SQUASH COMMITS
		if (task.gitShaBeforeImpl) {
			const squashResult = await squashTaskCommits(ctx.cwd, task.gitShaBeforeImpl, task.id, task.title);
			if (squashResult.success) {
				task.commitSha = squashResult.sha;
			} else {
				ui?.notify?.(`Warning: commit squash failed for task ${task.id}: ${squashResult.error}`, "warning");
			}
		}

		state.currentTaskIndex = i + 1;
		saveState(state, ctx.cwd);

		// h1b. PROGRESS SUMMARY
		{
			const taskChangedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);
			task.summary = {
				title: task.title,
				status: task.status,
				changedFiles: taskChangedFiles,
			};
			const summary = computeProgressSummary(state);
			const formatted = formatProgressSummary(summary);
			ui?.notify?.(formatted, "info");
		}

		// Update progress widget
		ui?.setWidget?.("workflow-progress", formatTaskProgress(state.tasks, i + 1));

		// h1c. CHECKPOINT EVALUATION
		{
			const checkConfig = getConfig(ctx.cwd);
			const costs = (checkConfig as any).costs || { warnAtUsd: 25, hardLimitUsd: 75 };
			const triggers = evaluateCheckpointTriggers(state, costs);

			if (triggers.length > 0 && ui?.select) {
				const completedCount = state.tasks.filter(t => t.status === "complete").length;
				const skippedCount = state.tasks.filter(t => t.status === "skipped").length;
				const remainingCount = state.tasks.length - completedCount - skippedCount;
				const avgCost = completedCount > 0 ? state.totalCostUsd / completedCount : 0;

				const checkpointChoice = await presentCheckpoint(
					triggers,
					{
						tasksCompleted: completedCount,
						tasksTotal: state.tasks.length,
						costUsd: state.totalCostUsd,
						estimatedRemainingUsd: avgCost * remainingCount,
					},
					ui,
				);

				if (checkpointChoice === "abort") {
					state.error = "Aborted at checkpoint";
					saveState(state, ctx.cwd);
					return state;
				}

				if (checkpointChoice === "adjust") {
					const adjustment = await presentPlanRevision(state.tasks, ui);
					if (adjustment) {
						state.tasks = applyPlanAdjustment(state.tasks, adjustment) as TaskExecState[];
						saveState(state, ctx.cwd);
					}
				}
			}
		}

		// h2. CROSS-TASK VALIDATION
		{
			const crossConfig = getConfig(ctx.cwd);
			const testCmd = crossConfig.testCommand || "";
			if (testCmd && state.testBaseline) {
				const valCadence = crossConfig.validationCadence || "every";
				const valInterval = crossConfig.validationInterval || 3;
				const completedCount = state.tasks.filter(t => t.status === "complete").length;

				if (shouldRunValidation(valCadence, valInterval, completedCount)) {
					const valResult = await runCrossTaskValidation(testCmd, state.testBaseline, ctx.cwd);

					// Classify flakes via taxonomy
					if (valResult.flakyTests.length > 0) {
						const flakeAction = resolveFailureAction("test-flake");
						if (flakeAction === "warn-continue") {
							ui?.notify?.(`Detected flaky tests: ${valResult.flakyTests.join(", ")}`, "warning");
						}
					}

					// Classify regressions via taxonomy
					if (!valResult.passed) {
						const regressionAction = resolveFailureAction("test-regression");
						const failNames = valResult.blockingFailures.map(f => f.name).join(", ");

						if (regressionAction === "stop-show-diff" || regressionAction === "escalate") {
							const escalation = await escalate(
								task,
								`Task introduced test regression: ${failNames}`,
								ui,
								ctx.cwd,
							);
							if (escalation === "abort") {
								state.error = "Aborted by user";
								saveState(state, ctx.cwd);
								return state;
							}
							if (escalation === "skip") {
								task.status = "skipped";
								saveState(state, ctx.cwd);
								continue;
							}
							// Reset index so the task is retried
							task.status = "pending";
							state.currentTaskIndex = i;
							i--;
							saveState(state, ctx.cwd);
							continue;
						}
					}
				}
			}
		}

		// h. EXECUTION MODE CHECK
		batchCounter++;
		const execMode = state.config.executionMode || "auto";

		if (execMode === "checkpoint") {
			return state;
		}

		if (execMode === "batch") {
			const batchSize = state.config.batchSize || 3;
			if (batchCounter >= batchSize) {
				return state;
			}
		}
	}

	// 5. All tasks done
	state.phase = "finalize";
	saveState(state, ctx.cwd);
	return state;
}

// --- Parallel review loop (D4) ---

async function runParallelReviewLoop(
	state: OrchestratorState,
	task: TaskExecState,
	specReviewer: AgentProfile | undefined,
	qualityReviewer: AgentProfile | undefined,
	implementer: AgentProfile,
	changedFiles: string[],
	maxRetries: number,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	ui: any,
	makeOnStreamEvent: () => OnStreamEvent,
): Promise<"passed" | "escalated"> {
	// Build list of available reviewers
	const reviewers: AgentProfile[] = [];
	const reviewNames: string[] = [];
	if (specReviewer) { reviewers.push(specReviewer); reviewNames.push("spec"); }
	if (qualityReviewer) { reviewers.push(qualityReviewer); reviewNames.push("quality"); }

	if (reviewers.length === 0) {
		task.reviewsPassed.push("spec", "quality");
		return "passed";
	}

	task.status = "reviewing";
	saveState(state, ctx.cwd);

	let currentChangedFiles = changedFiles;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		// Build prompts for each reviewer
		const prompts = reviewers.map((_, i) => {
			if (reviewNames[i] === "spec") return buildSpecReviewPrompt(task, currentChangedFiles);
			return buildQualityReviewPrompt(task, currentChangedFiles);
		});

		// Dispatch in parallel
		const results = await dispatchParallel(reviewers, prompts, ctx.cwd, signal);
		for (const r of results) {
			state.totalCostUsd += r.usage.cost;
		}

		// Write-guard check on parallel results
		for (let j = 0; j < results.length; j++) {
			if (hasWriteToolCalls(results[j].messages)) {
				ui?.notify?.(`Reviewer ${reviewNames[j]} attempted write operations — results may be tainted`, "warning");
			}
		}

		// Parse results
		const parsed: ParseResult[] = results.map(r => {
			const output = getFinalOutput(r.messages);
			return parseReviewOutput(output);
		});

		// Check if all passed
		const allPassed = parsed.every(p => p.status === "pass");
		if (allPassed) {
			for (const name of reviewNames) {
				if (!task.reviewsPassed.includes(name)) task.reviewsPassed.push(name);
			}
			return "passed";
		}

		// Check for inconclusive
		const inconclusiveIdx = parsed.findIndex(p => p.status === "inconclusive");
		if (inconclusiveIdx >= 0) {
			const p = parsed[inconclusiveIdx] as { status: "inconclusive"; parseError: string };
			const escalation = await escalate(task, `${reviewNames[inconclusiveIdx]} review inconclusive: ${p.parseError}`, ui, ctx.cwd);
			if (escalation === "abort") { state.error = "Aborted by user"; saveState(state, ctx.cwd); return "escalated"; }
			if (escalation === "skip") { task.status = "skipped"; saveState(state, ctx.cwd); return "escalated"; }
			continue;
		}

		// At least one failed — fix and retry
		if (attempt < maxRetries - 1) {
			task.status = "fixing";
			task.fixAttempts++;
			saveState(state, ctx.cwd);

			// Merge findings from ALL failed reviews into a single fix prompt
			const allFindings: string[] = [];
			for (let j = 0; j < parsed.length; j++) {
				if (parsed[j].status === "fail") {
					const failParsed = parsed[j] as { status: "fail"; findings: ReviewFindings };
					allFindings.push(formatFindings(failParsed.findings, reviewNames[j]));
				}
			}
			const mergedFixPrompt = [
				`Fix these review findings for task "${task.title}".`,
				``,
				allFindings.join("\n\n"),
				``,
				`## Changed files`,
				currentChangedFiles.map((f) => `- ${f}`).join("\n"),
				``,
				`Update tests if needed. Use TDD — fix failing tests first if any.`,
			].join("\n");

			const fixResult = await dispatchAgent(
				implementer,
				mergedFixPrompt,
				ctx.cwd, signal, undefined, makeOnStreamEvent(),
			);
			state.totalCostUsd += fixResult.usage.cost;

			currentChangedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);
			task.status = "reviewing";
			saveState(state, ctx.cwd);
		} else {
			const escalation = await escalate(task, `Reviews failed after ${maxRetries} attempts`, ui, ctx.cwd);
			if (escalation === "abort") { state.error = "Aborted by user"; saveState(state, ctx.cwd); return "escalated"; }
			if (escalation === "skip") { task.status = "skipped"; saveState(state, ctx.cwd); return "escalated"; }
		}
	}

	return "passed";
}

// --- Escalation via ctx.ui.select ---

async function escalate(
	task: TaskExecState,
	reason: string,
	ui: any,
	cwd: string,
): Promise<"retry" | "skip" | "abort"> {
	if (!ui?.select) {
		// No UI — default to skip
		return "skip";
	}

	const choice = await ui.select(
		`Task "${task.title}" needs attention: ${reason}`,
		["Retry", "Rollback", "Skip", "Abort"],
	);

	if (choice === "Abort") return "abort";
	if (choice === "Skip") return "skip";
	if (choice === "Rollback") {
		if (task.gitShaBeforeImpl) {
			const files = await computeChangedFiles(cwd, task.gitShaBeforeImpl);
			ui?.notify?.(
				`Rolling back task "${task.title}": reverting ${files.length} files to ${task.gitShaBeforeImpl.slice(0, 7)}`,
				"info",
			);
			await resetToSha(cwd, task.gitShaBeforeImpl);
			// Reset task state for clean retry
			task.reviewsPassed = [];
			task.reviewsFailed = [];
			task.fixAttempts = 0;
		}
		return "retry";
	}
	return "retry";
}


