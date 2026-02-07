/**
 * Plan-write phase — dispatch planner agent to write a plan from the approved design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OrchestratorState, TaskExecState } from "../orchestrator-state.js";
import { discoverAgents, dispatchAgent, getFinalOutput } from "../../dispatch.js";
import { buildPlannerPromptFromDesign } from "../prompt-builder.js";
import { parseTaskBlock, parseTaskHeadings } from "../state.js";

type Ctx = ExtensionContext | { cwd: string; hasUI?: boolean; ui?: any };

export async function runPlanWritePhase(
	state: OrchestratorState,
	ctx: Ctx,
	signal?: AbortSignal,
): Promise<OrchestratorState> {
	const ui = (ctx as any).ui;

	// Discover agents
	const { agents } = discoverAgents(ctx.cwd, true);
	const plannerAgent = agents.find((a) => a.name === "planner");

	if (!plannerAgent) {
		state.error = "Required agent not found: planner";
		return state;
	}

	const scoutOutput = state.brainstorm?.scoutOutput || "";
	const designContent = state.designContent || "";

	// Derive plan path from design path
	const planPath = state.designPath
		? state.designPath.replace(/-design\.md$/, "-plan.md")
		: `docs/plans/${new Date().toISOString().slice(0, 10)}-plan.md`;

	const MAX_RETRIES = 2;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		ui?.setStatus?.("workflow", `⚡ Workflow: plan-write${attempt > 0 ? " (retry)" : ""}`);

		const prompt = attempt > 0
			? buildPlannerPromptFromDesign(designContent, scoutOutput, state.userDescription, planPath)
				+ "\n\nIMPORTANT: The plan file MUST contain a ```superteam-tasks YAML block with at least one task."
			: buildPlannerPromptFromDesign(designContent, scoutOutput, state.userDescription, planPath);

		const result = await dispatchAgent(plannerAgent, prompt, ctx.cwd, signal);
		state.totalCostUsd += result.usage.cost;

		// Read plan file from disk
		const fullPlanPath = path.join(ctx.cwd, planPath);
		let planContent: string;
		try {
			planContent = fs.readFileSync(fullPlanPath, "utf-8");
		} catch {
			ui?.notify?.(`Plan file not written at ${planPath}`, "warning");
			continue;
		}

		// Parse tasks
		const parsedTasks = parseTaskBlock(planContent) || parseTaskHeadings(planContent);

		if (!parsedTasks || parsedTasks.length === 0) {
			ui?.notify?.(`No tasks found in plan (attempt ${attempt + 1})`, "warning");
			continue;
		}

		// Convert to TaskExecState
		const tasks: TaskExecState[] = parsedTasks.map((t, i) => ({
			id: i + 1,
			title: t.title,
			description: t.description,
			files: t.files,
			status: "pending" as const,
			reviewsPassed: [],
			reviewsFailed: [],
			fixAttempts: 0,
		}));

		state.tasks = tasks;
		state.planPath = planPath;
		state.planContent = planContent;
		state.phase = "plan-review";

		ui?.notify?.(`Plan written with ${tasks.length} tasks`, "info");
		return state;
	}

	// All retries exhausted
	state.error = `Plan-write failed: no parseable tasks after ${MAX_RETRIES} attempts`;
	return state;
}
