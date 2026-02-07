import type { OrchestratorState, TaskExecState } from "../orchestrator-state.js";
import { saveState } from "../orchestrator-state.js";
import { buildImplPrompt, buildFixPrompt, buildSpecReviewPrompt, buildQualityReviewPrompt, extractPlanContext } from "../prompt-builder.js";
import { confirmTaskEscalation } from "../interaction.js";
import { getCurrentSha, computeChangedFiles } from "../git-utils.js";
import { discoverAgents, dispatchAgent, dispatchParallel, getFinalOutput, checkCostBudget, type AgentProfile } from "../../dispatch.js";
import { parseReviewOutput, formatFindings, hasCriticalFindings, type ReviewFindings, type ParseResult } from "../../review-parser.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type AgentMap = Map<string, AgentProfile>;

export async function runExecutePhase(
	state: OrchestratorState,
	ctx: ExtensionContext | { cwd: string },
	signal?: AbortSignal,
	userInput?: string,
): Promise<OrchestratorState> {
	// 0. Handle pending escalation response
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
			// Fall through to continue loop with next task
		}
		if (response === "continue") {
			task.status = "pending";
			state.pendingInteraction = undefined;
			// Fall through to re-process this task
		}
	}

	// 1. Discover agents
	const { agents } = discoverAgents(ctx.cwd, true);
	const agentMap: AgentMap = new Map();
	for (const a of agents) agentMap.set(a.name, a);

	const implementer = agentMap.get("implementer");
	const specReviewer = agentMap.get("spec-reviewer");
	const qualityReviewer = agentMap.get("quality-reviewer");

	// Optional reviewers
	const optionalReviewerNames = ["security-reviewer", "performance-reviewer"];
	const optionalReviewers = optionalReviewerNames
		.map(name => agentMap.get(name))
		.filter((a): a is AgentProfile => a !== undefined);

	// 2. Extract plan context
	const planContext = extractPlanContext(state.planContent || "");

	// 3. Config
	const maxRetries = state.config.maxTaskReviewCycles || 3;

	// 4. Task loop
	let batchCounter = 0;

	for (let i = state.currentTaskIndex; i < state.tasks.length; i++) {
		const task = state.tasks[i];
		state.currentTaskIndex = i;

		// Skip completed/skipped/escalated tasks
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
			state.pendingInteraction = confirmTaskEscalation(task.title, "No implementer agent found");
			saveState(state, ctx.cwd);
			return state;
		}

		task.gitShaBeforeImpl = await getCurrentSha(ctx.cwd);
		task.status = "implementing";
		saveState(state, ctx.cwd);

		const implResult = await dispatchAgent(implementer, buildImplPrompt(task, planContext), ctx.cwd, signal);
		state.totalCostUsd += implResult.usage.cost;

		if (implResult.exitCode !== 0) {
			const reason = implResult.errorMessage || "Implementation failed (non-zero exit)";
			state.pendingInteraction = confirmTaskEscalation(task.title, reason);
			saveState(state, ctx.cwd);
			return state;
		}

		// c. CHANGED FILES
		let changedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);

		// d. SPEC REVIEW
		const specResult = await runReviewLoop(
			state, task, "spec", specReviewer, implementer, changedFiles, maxRetries, ctx, signal,
			(t, cf) => buildSpecReviewPrompt(t, cf),
		);
		if (specResult === "escalated") return state;
		// Refresh changed files after potential fixes
		changedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);

		// e. QUALITY REVIEW
		const qualResult = await runReviewLoop(
			state, task, "quality", qualityReviewer, implementer, changedFiles, maxRetries, ctx, signal,
			(t, cf) => buildQualityReviewPrompt(t, cf),
		);
		if (qualResult === "escalated") return state;

		// f. OPTIONAL REVIEWS
		if (optionalReviewers.length > 0) {
			changedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);
			const optAgents = optionalReviewers;
			const optTasks = optAgents.map(a => {
				// Use the same review prompt pattern — security/performance use quality-style prompt
				return buildQualityReviewPrompt(task, changedFiles);
			});

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
						state.pendingInteraction = confirmTaskEscalation(
							task.title,
							`Critical findings from ${reviewName}`,
						);
						saveState(state, ctx.cwd);
						return state;
					}
				}
				// inconclusive optional reviews are ignored
			}
		}

		// g. COMPLETE
		task.status = "complete";
		state.currentTaskIndex = i + 1;
		saveState(state, ctx.cwd);

		// h. EXECUTION MODE CHECK
		batchCounter++;
		const execMode = state.config.executionMode || "auto";

		if (execMode === "checkpoint") {
			saveState(state, ctx.cwd);
			return state;
		}

		if (execMode === "batch") {
			const batchSize = state.config.batchSize || 3;
			if (batchCounter >= batchSize) {
				saveState(state, ctx.cwd);
				return state;
			}
		}
		// auto: continue
	}

	// 5. All tasks done
	state.phase = "finalize";
	saveState(state, ctx.cwd);
	return state;
}

// --- Review loop helper ---

async function runReviewLoop(
	state: OrchestratorState,
	task: TaskExecState,
	reviewType: string,
	reviewer: AgentProfile | undefined,
	implementer: AgentProfile,
	changedFiles: string[],
	maxRetries: number,
	ctx: { cwd: string },
	signal: AbortSignal | undefined,
	buildPrompt: (task: TaskExecState, changedFiles: string[]) => string,
): Promise<"passed" | "escalated"> {
	if (!reviewer) {
		// No reviewer available — skip with warning
		task.reviewsPassed.push(reviewType);
		return "passed";
	}

	task.status = "reviewing";
	saveState(state, ctx.cwd);

	let currentChangedFiles = changedFiles;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const reviewResult = await dispatchAgent(reviewer, buildPrompt(task, currentChangedFiles), ctx.cwd, signal);
		state.totalCostUsd += reviewResult.usage.cost;

		const output = getFinalOutput(reviewResult.messages);
		const parsed = parseReviewOutput(output);

		if (parsed.status === "pass") {
			task.reviewsPassed.push(reviewType);
			return "passed";
		}

		if (parsed.status === "inconclusive") {
			state.pendingInteraction = confirmTaskEscalation(
				task.title,
				`${reviewType} review was inconclusive: ${parsed.parseError}`,
			);
			saveState(state, ctx.cwd);
			return "escalated";
		}

		// status === "fail"
		if (attempt < maxRetries - 1) {
			task.status = "fixing";
			task.fixAttempts++;
			saveState(state, ctx.cwd);

			const fixResult = await dispatchAgent(
				implementer,
				buildFixPrompt(task, reviewType, parsed.findings, currentChangedFiles),
				ctx.cwd,
				signal,
			);
			state.totalCostUsd += fixResult.usage.cost;

			currentChangedFiles = await computeChangedFiles(ctx.cwd, task.gitShaBeforeImpl);
			task.status = "reviewing";
			saveState(state, ctx.cwd);
		} else {
			// Max retries exceeded
			state.pendingInteraction = confirmTaskEscalation(
				task.title,
				`${reviewType} review failed after ${maxRetries} attempts`,
			);
			saveState(state, ctx.cwd);
			return "escalated";
		}
	}

	// Shouldn't reach here, but handle gracefully
	return "passed";
}
