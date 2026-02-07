/**
 * Plan review phase — dispatch reviewers, handle iterative revision cycles.
 */

import type { OrchestratorState } from "../orchestrator-state.js";
import { saveState } from "../orchestrator-state.js";
import { buildPlanReviewPrompt, buildPlanRevisionPrompt } from "../prompt-builder.js";
import { confirmPlanApproval } from "../interaction.js";
import { discoverAgents, dispatchAgent, dispatchParallel, getFinalOutput } from "../../dispatch.js";
import { parseReviewOutput, formatFindings } from "../../review-parser.js";
import { parseTaskBlock } from "../state.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentProfile, DispatchResult } from "../../dispatch.js";
import type { ParseResult } from "../../review-parser.js";
import * as fs from "node:fs";

export async function runPlanReviewPhase(
	state: OrchestratorState,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<OrchestratorState> {
	const { agents } = discoverAgents(ctx.cwd, true);
	const architect = agents.find((a) => a.name === "architect");
	const specReviewer = agents.find((a) => a.name === "spec-reviewer");
	const implementer = agents.find((a) => a.name === "implementer");

	const availableReviewers: { agent: AgentProfile; reviewType: "architect" | "spec" }[] = [];
	if (architect) availableReviewers.push({ agent: architect, reviewType: "architect" });
	if (specReviewer) availableReviewers.push({ agent: specReviewer, reviewType: "spec" });

	if (availableReviewers.length === 0) {
		// No reviewers — go straight to approval
		const taskTitles = state.tasks.map((t) => t.title);
		state.pendingInteraction = confirmPlanApproval(state.tasks.length, taskTitles);
		saveState(state, ctx.cwd);
		return state;
	}

	const reviewMode = state.config.reviewMode ?? "single-pass";
	const maxCycles = state.config.maxPlanReviewCycles ?? 3;

	// Review loop (iterative mode may loop; single-pass runs once)
	while (true) {
		// Build prompts and dispatch reviewers
		const reviewResults = await dispatchReviewers(
			availableReviewers,
			state.planContent!,
			ctx.cwd,
			signal,
		);

		// Parse review outputs
		const parsed: ParseResult[] = reviewResults.map((r) =>
			parseReviewOutput(getFinalOutput(r.messages)),
		);

		const allPassed = parsed.every((p) => p.status === "pass");

		if (allPassed) {
			const taskTitles = state.tasks.map((t) => t.title);
			state.pendingInteraction = confirmPlanApproval(state.tasks.length, taskTitles);
			saveState(state, ctx.cwd);
			return state;
		}

		// Some reviews failed
		const canIterate =
			reviewMode === "iterative" &&
			state.planReviewCycles < maxCycles &&
			implementer != null;

		if (canIterate) {
			// Collect findings from failed reviews
			const findings = collectFindings(parsed);

			// Dispatch implementer to revise
			const revisionPrompt = buildPlanRevisionPrompt(state.planContent!, findings);
			await dispatchAgent(implementer!, revisionPrompt, ctx.cwd, signal);

			// Re-read plan from disk
			const updatedContent = fs.readFileSync(state.planPath!, "utf-8");
			state.planContent = updatedContent;

			// Re-parse tasks
			const parsedTasks = parseTaskBlock(updatedContent);
			if (parsedTasks && parsedTasks.length > 0) {
				state.tasks = parsedTasks.map((t) => ({
					id: t.id,
					title: t.title,
					description: t.description,
					files: t.files,
					status: "pending" as const,
					reviewsPassed: [],
					reviewsFailed: [],
					fixAttempts: 0,
				}));
			}

			state.planReviewCycles++;
			// Loop back for another review round
			continue;
		}

		// Can't iterate (single-pass, max cycles reached, or no implementer)
		const findings = collectFindings(parsed);
		state.error = findings;
		const taskTitles = state.tasks.map((t) => t.title);
		state.pendingInteraction = confirmPlanApproval(state.tasks.length, taskTitles);
		saveState(state, ctx.cwd);
		return state;
	}
}

async function dispatchReviewers(
	reviewers: { agent: AgentProfile; reviewType: "architect" | "spec" }[],
	planContent: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<DispatchResult[]> {
	if (reviewers.length === 1) {
		const { agent, reviewType } = reviewers[0];
		const prompt = buildPlanReviewPrompt(planContent, reviewType);
		const result = await dispatchAgent(agent, prompt, cwd, signal);
		return [result];
	}

	// Multiple reviewers — dispatch in parallel
	const agents = reviewers.map((r) => r.agent);
	const tasks = reviewers.map((r) => buildPlanReviewPrompt(planContent, r.reviewType));
	return dispatchParallel(agents, tasks, cwd, signal);
}

function collectFindings(parsed: ParseResult[]): string {
	const parts: string[] = [];
	for (const p of parsed) {
		if (p.status === "fail") {
			parts.push(formatFindings(p.findings, "plan-review"));
		} else if (p.status === "inconclusive") {
			parts.push(`Inconclusive review: ${p.parseError}`);
		}
	}
	return parts.join("\n\n");
}
