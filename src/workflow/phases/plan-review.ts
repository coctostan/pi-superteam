/**
 * Plan review phase — dispatch reviewers, use ctx.ui for approval,
 * planner agent for revision.
 */

import * as fs from "node:fs";
import type { OrchestratorState } from "../orchestrator-state.js";
import { saveState } from "../orchestrator-state.js";
import { buildPlanReviewPrompt, buildPlanRevisionPromptFromFindings } from "../prompt-builder.js";
import { discoverAgents, dispatchAgent, getFinalOutput, type OnStreamEvent } from "../../dispatch.js";
import { parseReviewOutput, formatFindings } from "../../review-parser.js";
import { parseTaskBlock, parseTaskHeadings } from "../state.js";
import { formatToolAction, createActivityBuffer } from "../ui.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentProfile, DispatchResult } from "../../dispatch.js";
import type { ParseResult } from "../../review-parser.js";

type Ctx = ExtensionContext | { cwd: string; hasUI?: boolean; ui?: any };

export async function runPlanReviewPhase(
	state: OrchestratorState,
	ctx: Ctx,
	signal?: AbortSignal,
	onStreamEvent?: OnStreamEvent,
): Promise<OrchestratorState> {
	const ui = (ctx as any).ui;
	const { agents } = discoverAgents(ctx.cwd, true);
	const architect = agents.find((a) => a.name === "architect");
	const specReviewer = agents.find((a) => a.name === "spec-reviewer");
	const planner = agents.find((a) => a.name === "planner");

	const availableReviewers: { agent: AgentProfile; reviewType: "architect" | "spec" }[] = [];
	if (architect) availableReviewers.push({ agent: architect, reviewType: "architect" });
	if (specReviewer) availableReviewers.push({ agent: specReviewer, reviewType: "spec" });

	const reviewMode = state.config.reviewMode ?? "single-pass";
	const maxCycles = state.config.maxPlanReviewCycles ?? 3;
	const designContent = state.designContent || "";

	// Activity buffer for streaming
	const activityBuffer = createActivityBuffer(10);
	const makeOnStreamEvent = (): OnStreamEvent => {
		return (event) => {
			if (event.type === "tool_execution_start") {
				const action = formatToolAction(event);
				activityBuffer.push(action);
				ui?.setStatus?.("workflow", action);
				ui?.setWidget?.("workflow-activity", activityBuffer.lines());
			}
			onStreamEvent?.(event);
		};
	};

	// Review loop
	if (availableReviewers.length > 0) {
		while (true) {
			ui?.setStatus?.("workflow", "⚡ Workflow: plan-review");

			const reviewResults = await dispatchReviewers(
				availableReviewers, state.planContent!, designContent, ctx.cwd, signal, makeOnStreamEvent(),
			);

			const parsed: ParseResult[] = reviewResults.map((r) =>
				parseReviewOutput(getFinalOutput(r.messages)),
			);

			const allPassed = parsed.every((p) => p.status === "pass");

			if (allPassed) break;

			// Some reviews failed
			const findings = collectFindings(parsed);
			const canIterate = reviewMode === "iterative" && state.planReviewCycles < maxCycles && planner != null;

			if (canIterate) {
				// Dispatch planner to revise
				const revisionPrompt = buildPlanRevisionPromptFromFindings(state.planContent!, designContent, findings);
				await dispatchAgent(planner!, revisionPrompt, ctx.cwd, signal, undefined, makeOnStreamEvent());

				// Re-read plan from disk
				try {
					const updatedContent = fs.readFileSync(state.planPath!, "utf-8");
					state.planContent = updatedContent;

					const parsedTasks = parseTaskBlock(updatedContent) || parseTaskHeadings(updatedContent);
					if (parsedTasks && parsedTasks.length > 0) {
						state.tasks = parsedTasks.map((t, i) => ({
							id: t.id || i + 1,
							title: t.title,
							description: t.description,
							files: t.files,
							status: "pending" as const,
							reviewsPassed: [],
							reviewsFailed: [],
							fixAttempts: 0,
						}));
					}
				} catch {
					// Plan file not readable — continue with existing
				}

				state.planReviewCycles++;
				continue;
			}

			// Can't iterate further — show findings as warning and break to approval
			ui?.notify?.(`Review findings:\n${findings}`, "warning");
			break;
		}
	}

	// Ask user for approval via ctx.ui.select
	const choice = await ui?.select?.("Plan Approval", ["Approve", "Revise", "Abort"]);

	if (choice === "Approve") {
		state.phase = "configure";
		saveState(state, ctx.cwd);
		return state;
	}

	if (choice === "Revise") {
		// Get feedback via editor
		const feedback = await ui?.editor?.("Enter revision feedback");
		if (feedback && planner) {
			const revisionPrompt = buildPlanRevisionPromptFromFindings(state.planContent!, designContent, feedback);
			await dispatchAgent(planner, revisionPrompt, ctx.cwd, signal, undefined, makeOnStreamEvent());

			// Re-read plan
			try {
				const updatedContent = fs.readFileSync(state.planPath!, "utf-8");
				state.planContent = updatedContent;

				const parsedTasks = parseTaskBlock(updatedContent) || parseTaskHeadings(updatedContent);
				if (parsedTasks && parsedTasks.length > 0) {
					state.tasks = parsedTasks.map((t, i) => ({
						id: t.id || i + 1,
						title: t.title,
						description: t.description,
						files: t.files,
						status: "pending" as const,
						reviewsPassed: [],
						reviewsFailed: [],
						fixAttempts: 0,
					}));
				}
			} catch { /* ignore */ }
		}

		// Re-run reviews (recursive)
		return runPlanReviewPhase(state, ctx, signal, onStreamEvent);
	}

	// Abort or cancel
	state.error = "Workflow aborted by user at plan review";
	saveState(state, ctx.cwd);
	return state;
}

async function dispatchReviewers(
	reviewers: { agent: AgentProfile; reviewType: "architect" | "spec" }[],
	planContent: string,
	designContent: string,
	cwd: string,
	signal?: AbortSignal,
	onStreamEvent?: OnStreamEvent,
): Promise<DispatchResult[]> {
	const promises = reviewers.map((r) => {
		const prompt = buildPlanReviewPrompt(planContent, r.reviewType, designContent);
		return dispatchAgent(r.agent, prompt, cwd, signal, undefined, onStreamEvent);
	});
	return Promise.all(promises);
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
