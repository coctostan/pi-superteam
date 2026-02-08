/**
 * Plan-write phase — dispatch planner agent to write a plan from the approved design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OrchestratorState, TaskExecState } from "../orchestrator-state.js";
import { discoverAgents, dispatchAgent, getFinalOutput, type OnStreamEvent } from "../../dispatch.js";
import { buildPlannerPromptFromDesign } from "../prompt-builder.js";
import { parseTaskBlock, parseTaskHeadings } from "../plan-parser.js";
import { formatToolAction, createActivityBuffer } from "../ui.js";

type Ctx = ExtensionContext | { cwd: string; hasUI?: boolean; ui?: any };

export async function runPlanWritePhase(
	state: OrchestratorState,
	ctx: Ctx,
	signal?: AbortSignal,
	onStreamEvent?: OnStreamEvent,
): Promise<OrchestratorState> {
	const ui = (ctx as any).ui;

	// Discover agents
	const { agents } = discoverAgents(ctx.cwd, true);
	const plannerAgent = agents.find((a) => a.name === "planner");

	if (!plannerAgent) {
		state.error = "Required agent not found: planner";
		return state;
	}

	// Fallback: if no designPath, search docs/plans/ for most recent *-design.md
	if (!state.designPath && !state.designContent) {
		const plansDir = path.join(ctx.cwd, "docs/plans");
		try {
			const files = fs.readdirSync(plansDir)
				.filter((f: string) => f.endsWith("-design.md"))
				.sort()
				.reverse();
			if (files.length > 0) {
				const designFile = files[0];
				state.designPath = `docs/plans/${designFile}`;
				state.designContent = fs.readFileSync(path.join(plansDir, designFile), "utf-8");
			}
		} catch {
			// docs/plans/ doesn't exist — continue with empty design
		}
	}

	const scoutOutput = state.brainstorm?.scoutOutput || "";
	const designContent = state.designContent || "";

	// Derive plan path from design path
	const planPath = state.designPath
		? state.designPath.replace(/-design\.md$/, "-plan.md")
		: `docs/plans/${new Date().toISOString().slice(0, 10)}-plan.md`;

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

	const MAX_RETRIES = 2;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		ui?.setStatus?.("workflow", `⚡ Workflow: plan-write${attempt > 0 ? " (retry)" : ""}`);

		const prompt = attempt > 0
			? buildPlannerPromptFromDesign(designContent, scoutOutput, state.userDescription, planPath)
				+ "\n\nIMPORTANT: The plan file MUST contain a ```superteam-tasks YAML block with at least one task."
			: buildPlannerPromptFromDesign(designContent, scoutOutput, state.userDescription, planPath);

		const result = await dispatchAgent(plannerAgent, prompt, ctx.cwd, signal, undefined, makeOnStreamEvent());
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
