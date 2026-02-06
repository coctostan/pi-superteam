/**
 * SDD Orchestrator — Subagent-Driven Development loop.
 *
 * For each task in a plan:
 *   1. Dispatch implementer
 *   2. Compute changed files via git diff
 *   3. Run required reviews (spec, quality) sequentially
 *   4. Run optional reviews (security, performance) in parallel
 *   5. On failure: dispatch implementer to fix, re-review
 *   6. On max iterations or inconclusive: escalate to human
 */

import { execSync } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getConfig } from "../config.js";
import {
	type AgentProfile,
	type DispatchResult,
	aggregateUsage,
	checkCostBudget,
	discoverAgents,
	dispatchAgent,
	dispatchParallel,
	formatUsage,
	getFinalOutput,
} from "../dispatch.js";
import {
	type ParseResult,
	type ReviewFindings,
	formatFindings,
	hasCriticalFindings,
	parseReviewOutput,
} from "../review-parser.js";
import {
	type PlanTask,
	addCostToState,
	addReviewCycle,
	getCurrentTask,
	getState,
	incrementFixAttempts,
	updateTaskStatus,
	updateWidget,
} from "./state.js";

// --- Types ---

export interface SddResult {
	taskId: number;
	taskTitle: string;
	status: "complete" | "escalated" | "aborted";
	reviewResults: ReviewResult[];
	totalUsage: ReturnType<typeof aggregateUsage>;
	escalationReason?: string;
}

interface ReviewResult {
	reviewType: string;
	agent: string;
	parseResult: ParseResult;
	iteration: number;
}

// --- Orchestrator ---

/**
 * Run the SDD loop for the current task.
 * Returns result for the task.
 */
export async function runSddTask(
	ctx: ExtensionContext,
	signal?: AbortSignal,
	onStatus?: (msg: string) => void,
): Promise<SddResult> {
	const task = getCurrentTask();
	if (!task) {
		return {
			taskId: -1,
			taskTitle: "(no task)",
			status: "aborted",
			reviewResults: [],
			totalUsage: aggregateUsage([]),
			escalationReason: "No current task. Load a plan with /sdd load <file>.",
		};
	}

	const config = getConfig(ctx.cwd);
	const { agents } = discoverAgents(ctx.cwd, true);
	const allResults: DispatchResult[] = [];
	const reviewResults: ReviewResult[] = [];

	const notify = (msg: string) => {
		onStatus?.(msg);
	};

	const findAgent = (name: string): AgentProfile | undefined =>
		agents.find((a) => a.name === name);

	// --- Step 1: Implement ---
	notify(`Task ${task.id}: "${task.title}" — implementing...`);
	updateTaskStatus(task.id, "implementing");
	updateWidget(ctx);

	const implementer = findAgent("implementer");
	if (!implementer) {
		return escalate(task, allResults, reviewResults, "No implementer agent found.");
	}

	// Cost check
	const costCheck = checkCostBudget(ctx.cwd);
	if (!costCheck.allowed) {
		return escalate(task, allResults, reviewResults, costCheck.warning!);
	}

	// Snapshot files before implementation
	const filesBefore = getTrackedFiles(ctx.cwd);

	const implTask = buildImplTask(task);
	const implResult = await dispatchAgent(implementer, implTask, ctx.cwd, signal);
	allResults.push(implResult);
	addCostToState(implResult.usage.cost);

	if (implResult.exitCode !== 0) {
		return escalate(task, allResults, reviewResults,
			`Implementer failed (exit ${implResult.exitCode}): ${implResult.errorMessage || "unknown error"}`);
	}

	// Compute changed files
	const filesAfter = getTrackedFiles(ctx.cwd);
	const changedFiles = computeChangedFiles(filesBefore, filesAfter, ctx.cwd);
	const changedFilesList = changedFiles.length > 0 ? changedFiles.join(", ") : "(no tracked changes)";

	// --- Step 2: Required reviews ---
	updateTaskStatus(task.id, "reviewing");
	updateWidget(ctx);

	for (const reviewType of config.review.required) {
		const agentName = `${reviewType}-reviewer`;
		const reviewer = findAgent(agentName);
		if (!reviewer) {
			notify(`Warning: ${agentName} not found, skipping.`);
			continue;
		}

		let iteration = 0;
		let passed = false;

		while (iteration < config.review.maxIterations && !passed) {
			iteration++;
			notify(`Task ${task.id}: ${reviewType} review (attempt ${iteration}/${config.review.maxIterations})...`);

			const costCheck = checkCostBudget(ctx.cwd);
			if (!costCheck.allowed) {
				return escalate(task, allResults, reviewResults, costCheck.warning!);
			}

			const reviewTask = buildReviewTask(task, reviewType, changedFilesList);
			const reviewResult = await dispatchAgent(reviewer, reviewTask, ctx.cwd, signal);
			allResults.push(reviewResult);
			addCostToState(reviewResult.usage.cost);

			const output = getFinalOutput(reviewResult.messages);
			const parsed = parseReviewOutput(output);

			reviewResults.push({ reviewType, agent: agentName, parseResult: parsed, iteration });

			addReviewCycle({
				taskId: task.id,
				reviewType,
				agent: agentName,
				status: parsed.status === "pass" ? "passed" : parsed.status === "fail" ? "failed" : "inconclusive",
				findings: parsed.status !== "inconclusive" ? (parsed.findings as any) : undefined,
				timestamp: Date.now(),
			});
			updateWidget(ctx);

			if (parsed.status === "pass") {
				passed = true;
				notify(`Task ${task.id}: ${reviewType} review PASSED`);
				break;
			}

			if (parsed.status === "inconclusive") {
				if (config.review.escalateOnMaxIterations) {
					return escalate(task, allResults, reviewResults,
						`${reviewType} review produced inconclusive output (no valid JSON).`);
				}
				notify(`Task ${task.id}: ${reviewType} review inconclusive, skipping.`);
				break;
			}

			// Failed — try to fix
			if (iteration < config.review.maxIterations) {
				notify(`Task ${task.id}: ${reviewType} review FAILED, dispatching fix (attempt ${iteration + 1})...`);
				updateTaskStatus(task.id, "fixing");
				incrementFixAttempts(task.id);
				updateWidget(ctx);

				const fixTask = buildFixTask(task, reviewType, parsed.findings, changedFilesList);
				const fixResult = await dispatchAgent(implementer, fixTask, ctx.cwd, signal);
				allResults.push(fixResult);
				addCostToState(fixResult.usage.cost);

				if (fixResult.exitCode !== 0) {
					return escalate(task, allResults, reviewResults,
						`Fix attempt failed (exit ${fixResult.exitCode}): ${fixResult.errorMessage || "unknown"}`);
				}

				updateTaskStatus(task.id, "reviewing");
				updateWidget(ctx);
			}
		}

		if (!passed && config.review.escalateOnMaxIterations) {
			const lastReview = reviewResults[reviewResults.length - 1];
			const reason = lastReview?.parseResult.status === "fail"
				? `${reviewType} review failed after ${config.review.maxIterations} attempts.\n${formatFindings(lastReview.parseResult.findings, reviewType)}`
				: `${reviewType} review did not pass after ${config.review.maxIterations} attempts.`;
			return escalate(task, allResults, reviewResults, reason);
		}
	}

	// --- Step 3: Optional parallel reviews ---
	if (config.review.optional.length > 0) {
		const optionalAgents: AgentProfile[] = [];
		const optionalTasks: string[] = [];

		for (const reviewType of config.review.optional) {
			const agentName = `${reviewType}-reviewer`;
			const reviewer = findAgent(agentName);
			if (reviewer) {
				optionalAgents.push(reviewer);
				optionalTasks.push(buildReviewTask(task, reviewType, changedFilesList));
			}
		}

		if (optionalAgents.length > 0) {
			const costCheck = checkCostBudget(ctx.cwd);
			if (costCheck.allowed) {
				notify(`Task ${task.id}: running optional reviews (${config.review.optional.join(", ")})...`);

				if (config.review.parallelOptional && optionalAgents.length > 1) {
					const optResults = await dispatchParallel(optionalAgents, optionalTasks, ctx.cwd, signal);
					allResults.push(...optResults);
					for (const r of optResults) addCostToState(r.usage.cost);

					for (let i = 0; i < optResults.length; i++) {
						const output = getFinalOutput(optResults[i].messages);
						const parsed = parseReviewOutput(output);
						const reviewType = config.review.optional[i];
						reviewResults.push({ reviewType, agent: optionalAgents[i].name, parseResult: parsed, iteration: 1 });

						addReviewCycle({
							taskId: task.id,
							reviewType,
							agent: optionalAgents[i].name,
							status: parsed.status === "pass" ? "passed" : parsed.status === "fail" ? "failed" : "inconclusive",
							findings: parsed.status !== "inconclusive" ? (parsed.findings as any) : undefined,
							timestamp: Date.now(),
						});
					}
				} else {
					for (let i = 0; i < optionalAgents.length; i++) {
						const result = await dispatchAgent(optionalAgents[i], optionalTasks[i], ctx.cwd, signal);
						allResults.push(result);
						addCostToState(result.usage.cost);

						const output = getFinalOutput(result.messages);
						const parsed = parseReviewOutput(output);
						const reviewType = config.review.optional[i];
						reviewResults.push({ reviewType, agent: optionalAgents[i].name, parseResult: parsed, iteration: 1 });

						addReviewCycle({
							taskId: task.id,
							reviewType,
							agent: optionalAgents[i].name,
							status: parsed.status === "pass" ? "passed" : parsed.status === "fail" ? "failed" : "inconclusive",
							findings: parsed.status !== "inconclusive" ? (parsed.findings as any) : undefined,
							timestamp: Date.now(),
						});
					}
				}

				// Check for critical findings in optional reviews
				for (const rr of reviewResults.filter((r) => config.review.optional.includes(r.reviewType))) {
					if (rr.parseResult.status === "fail" && hasCriticalFindings(rr.parseResult.findings)) {
						notify(`Task ${task.id}: critical findings in ${rr.reviewType} review — escalating`);
						return escalate(task, allResults, reviewResults,
							`Critical findings in optional ${rr.reviewType} review:\n${formatFindings(rr.parseResult.findings, rr.reviewType)}`);
					}
				}

				updateWidget(ctx);
			} else {
				notify(`Skipping optional reviews: ${costCheck.warning}`);
			}
		}
	}

	// --- Step 4: Mark complete ---
	updateTaskStatus(task.id, "complete");
	updateWidget(ctx);
	notify(`Task ${task.id}: "${task.title}" — COMPLETE`);

	return {
		taskId: task.id,
		taskTitle: task.title,
		status: "complete",
		reviewResults,
		totalUsage: aggregateUsage(allResults),
	};
}

// --- Helpers ---

function escalate(
	task: PlanTask,
	allResults: DispatchResult[],
	reviewResults: ReviewResult[],
	reason: string,
): SddResult {
	updateTaskStatus(task.id, "fixing");
	return {
		taskId: task.id,
		taskTitle: task.title,
		status: "escalated",
		reviewResults,
		totalUsage: aggregateUsage(allResults),
		escalationReason: reason,
	};
}

function buildImplTask(task: PlanTask): string {
	const files = task.files.length > 0 ? `\nFiles: ${task.files.join(", ")}` : "";
	return `Implement: ${task.title}\n\nDescription: ${task.description}${files}\n\nFollow TDD strictly. Write failing tests first, then implement, then refactor.`;
}

function buildReviewTask(task: PlanTask, reviewType: string, changedFiles: string): string {
	return `Review (${reviewType}) for task: ${task.title}\n\nDescription: ${task.description}\n\nChanged files: ${changedFiles}\n\nRead the actual code. Do NOT trust any self-report. End with a \`\`\`superteam-json block.`;
}

function buildFixTask(task: PlanTask, reviewType: string, findings: ReviewFindings, changedFiles: string): string {
	const findingsStr = formatFindings(findings, reviewType);
	return `Fix ${reviewType} review findings for task: ${task.title}\n\nChanged files: ${changedFiles}\n\n${findingsStr}\n\nFix ALL mustFix items. Follow TDD — update tests if needed.`;
}

function getTrackedFiles(cwd: string): string[] {
	try {
		const output = execSync("git diff --name-only HEAD 2>/dev/null || git ls-files 2>/dev/null", {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
		});
		return output
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function computeChangedFiles(before: string[], after: string[], cwd: string): string[] {
	try {
		const output = execSync("git diff --name-only 2>/dev/null", {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
		});
		const changed = output
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);
		return changed.length > 0 ? changed : [];
	} catch {
		// Fallback: files in after but not in before
		const beforeSet = new Set(before);
		return after.filter((f) => !beforeSet.has(f));
	}
}
