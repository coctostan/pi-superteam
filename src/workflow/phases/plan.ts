import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type OrchestratorState, type TaskExecState, saveState } from "../orchestrator-state.js";
import { buildScoutPrompt, buildPlannerPrompt } from "../prompt-builder.js";
import { discoverAgents, dispatchAgent, getFinalOutput } from "../../dispatch.js";
import { parseTaskBlock } from "../state.js";

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
}

export async function runPlanDraftPhase(
	state: OrchestratorState,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<OrchestratorState> {
	// a. Discover agents
	const { agents } = discoverAgents(ctx.cwd, true);

	// b. Find scout
	const scoutAgent = agents.find((a) => a.name === "scout");
	if (!scoutAgent) {
		state.error = "No scout agent found";
		return state;
	}

	// c. Dispatch scout
	const scoutResult = await dispatchAgent(scoutAgent, buildScoutPrompt(ctx.cwd), ctx.cwd, signal);
	const scoutOutput = getFinalOutput(scoutResult.messages);

	// d. Generate planPath
	const date = new Date().toISOString().slice(0, 10);
	const slug = slugify(state.userDescription);
	const planPath = `docs/plans/${date}-${slug}.md`;

	// e. Find implementer (used as planner)
	const implementerAgent = agents.find((a) => a.name === "implementer");
	if (!implementerAgent) {
		state.error = "No implementer agent found";
		return state;
	}

	// f. Dispatch implementer with planner prompt
	await dispatchAgent(implementerAgent, buildPlannerPrompt(scoutOutput, state.userDescription, planPath), ctx.cwd, signal);

	// g. Read plan file
	const fullPlanPath = path.join(ctx.cwd, planPath);
	if (!fs.existsSync(fullPlanPath)) {
		state.error = "Plan file not written";
		return state;
	}

	let planContent = fs.readFileSync(fullPlanPath, "utf-8");

	// h. Parse tasks
	let parsed = parseTaskBlock(planContent);

	// i. Retry once if 0 tasks
	if (!parsed || parsed.length === 0) {
		await dispatchAgent(
			implementerAgent,
			`The plan at ${planPath} must contain a \`\`\`superteam-tasks block with at least one task. Read the file, fix it, and save.`,
			ctx.cwd,
			signal,
		);

		if (fs.existsSync(fullPlanPath)) {
			planContent = fs.readFileSync(fullPlanPath, "utf-8");
			parsed = parseTaskBlock(planContent);
		}
	}

	// j. Still no tasks
	if (!parsed || parsed.length === 0) {
		state.error = "Plan has no parseable tasks";
		return state;
	}

	// k. Convert PlanTask[] to TaskExecState[]
	const tasks: TaskExecState[] = parsed.map((t) => ({
		id: t.id,
		title: t.title,
		description: t.description,
		files: t.files,
		status: t.status as TaskExecState["status"],
		reviewsPassed: [],
		reviewsFailed: [],
		fixAttempts: 0,
	}));

	// l. Update state
	state.planPath = planPath;
	state.planContent = planContent;
	state.tasks = tasks;
	state.currentTaskIndex = 0;
	state.phase = "plan-review";

	// m. Save and return
	saveState(state, ctx.cwd);
	return state;
}
