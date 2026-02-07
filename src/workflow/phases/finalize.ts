import type { OrchestratorState, TaskExecState } from "../orchestrator-state.js";
import { clearState } from "../orchestrator-state.js";
import { buildFinalReviewPrompt } from "../prompt-builder.js";
import { computeChangedFiles } from "../git-utils.js";
import { discoverAgents, dispatchAgent, getFinalOutput } from "../../dispatch.js";
import { parseReviewOutput } from "../../review-parser.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_EMOJI: Record<string, string> = {
	complete: "✅",
	skipped: "⏭️",
	escalated: "⚠️",
	pending: "⏸️",
	implementing: "⏸️",
	reviewing: "⏸️",
	fixing: "⏸️",
};

export async function runFinalizePhase(
	state: OrchestratorState,
	ctx: ExtensionContext | { cwd: string },
	signal?: AbortSignal,
): Promise<{ state: OrchestratorState; report: string }> {
	const completedTasks = state.tasks.filter((t) => t.status === "complete");
	const skippedTasks = state.tasks.filter((t) => t.status === "skipped");
	const escalatedTasks = state.tasks.filter((t) => t.status === "escalated");

	let changedFiles: string[] = [];
	let reviewSummary: string | null = null;

	if (completedTasks.length > 0) {
		// Find earliest gitShaBeforeImpl among completed tasks
		const earliestSha = completedTasks.find((t) => t.gitShaBeforeImpl)?.gitShaBeforeImpl;
		changedFiles = await computeChangedFiles(ctx.cwd, earliestSha);

		// Try to find quality-reviewer agent
		const { agents } = discoverAgents(ctx.cwd, true);
		const reviewer = agents.find((a) => a.name === "quality-reviewer");

		if (reviewer) {
			const prompt = buildFinalReviewPrompt(completedTasks, changedFiles);
			const result = await dispatchAgent(reviewer, prompt, ctx.cwd, signal);
			state.totalCostUsd += result.usage.cost;

			const rawOutput = getFinalOutput(result.messages);
			const parsed = parseReviewOutput(rawOutput);

			if (parsed.status === "inconclusive") {
				reviewSummary = `Inconclusive — could not parse reviewer output`;
			} else {
				reviewSummary = parsed.findings.summary;
			}
		} else {
			reviewSummary = "Skipped — no quality-reviewer agent available";
		}
	}

	// Build report
	const lines: string[] = [];
	lines.push("# Workflow Complete");
	lines.push("");
	lines.push("## Tasks");
	for (const task of state.tasks) {
		const emoji = STATUS_EMOJI[task.status] ?? "❓";
		lines.push(`${emoji} ${task.title}`);
	}

	lines.push("");
	lines.push("## Stats");
	lines.push(`- ${completedTasks.length} completed`);
	lines.push(`- ${skippedTasks.length} skipped`);
	lines.push(`- ${escalatedTasks.length} escalated`);
	lines.push(`- Total cost: $${state.totalCostUsd.toFixed(2)}`);

	lines.push("");
	lines.push("## Final Review");
	lines.push(reviewSummary ?? "Skipped — no completed tasks");

	lines.push("");
	lines.push("## Changed Files");
	if (changedFiles.length > 0) {
		for (const f of changedFiles) {
			lines.push(`- ${f}`);
		}
	} else {
		lines.push("None");
	}

	const report = lines.join("\n");

	state.phase = "done";
	clearState(ctx.cwd);

	return { state, report };
}
