/**
 * Progress file generator — human-readable markdown tracking workflow progress.
 *
 * Survives crashes, viewable outside pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Use a loose type to avoid circular dependency with orchestrator-state
interface ProgressState {
	phase: string;
	userDescription: string;
	brainstorm?: {
		step: string;
		scoutOutput?: string;
		questions?: Array<{ id: string; text: string; answer?: string }>;
		approaches?: Array<{ id: string; title: string }>;
		chosenApproach?: string;
	};
	config?: Record<string, any>;
	tasks: Array<{ id: number; title: string; status: string }>;
	currentTaskIndex: number;
	totalCostUsd: number;
	startedAt: number;
	planReviewCycles?: number;
	designPath?: string;
	planPath?: string;
}

/**
 * Derive progress file path from design or plan path.
 */
export function getProgressPath(state: ProgressState): string | null {
	if (state.designPath) {
		return state.designPath.replace(/-design\.md$/, "-progress.md");
	}
	if (state.planPath) {
		return state.planPath.replace(/-plan\.md$/, "-progress.md");
	}
	return null;
}

/**
 * Render a progress markdown document from workflow state.
 * Pure function — no side effects.
 */
export function renderProgressMarkdown(state: ProgressState): string {
	const lines: string[] = [];

	// Header
	lines.push(`# Workflow: ${state.userDescription}`);
	lines.push("");
	lines.push(`**Phase:** ${capitalize(state.phase)} | **Cost:** $${state.totalCostUsd.toFixed(2)}`);
	lines.push("");

	// Brainstorm checklist
	if (state.brainstorm) {
		lines.push("## Brainstorm");
		lines.push("");
		const bs = state.brainstorm;
		const steps = [
			{ key: "scout", label: "Scout codebase" },
			{ key: "questions", label: "Requirements" },
			{ key: "approaches", label: "Approaches" },
			{ key: "design", label: "Design sections" },
			{ key: "done", label: "Design approved" },
		];

		let pastCurrent = false;
		for (const step of steps) {
			if (step.key === bs.step) {
				// Current step is in progress unless it's "done"
				if (step.key === "done") {
					lines.push(`- [x] ${step.label}`);
				} else {
					// Check if there's evidence of completion for previous steps
					const isCompleted = isStepCompleted(bs, step.key);
					lines.push(`- [${isCompleted ? "x" : " "}] ${step.label}`);
				}
				pastCurrent = true;
			} else if (pastCurrent) {
				lines.push(`- [ ] ${step.label}`);
			} else {
				// Before current step — completed
				lines.push(`- [x] ${step.label}`);
			}
		}
		lines.push("");
	}

	// Task list
	if (state.tasks.length > 0) {
		lines.push("## Tasks");
		lines.push("");
		for (const task of state.tasks) {
			const done = task.status === "complete";
			const marker = done ? "x" : " ";
			const suffix = task.status !== "pending" && task.status !== "complete" ? ` *(${task.status})*` : "";
			lines.push(`- [${marker}] ${task.id}. ${task.title}${suffix}`);
		}
		lines.push("");
	}

	// Config summary
	if (state.config && Object.keys(state.config).length > 0) {
		lines.push("## Configuration");
		lines.push("");
		for (const [key, value] of Object.entries(state.config)) {
			lines.push(`- **${key}:** ${value}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function isStepCompleted(bs: ProgressState["brainstorm"], step: string): boolean {
	if (!bs) return false;
	switch (step) {
		case "scout": return !!bs.scoutOutput;
		case "questions": return Array.isArray(bs.questions) && bs.questions.length > 0;
		case "approaches": return Array.isArray(bs.approaches) && bs.approaches.length > 0;
		case "design": return !!bs.chosenApproach;
		default: return false;
	}
}

function capitalize(s: string): string {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Write progress file to disk. No-op if path can't be derived.
 */
export function writeProgressFile(state: ProgressState, cwd: string): void {
	const progressPath = getProgressPath(state);
	if (!progressPath) return;

	const fullPath = path.join(cwd, progressPath);
	const dir = path.dirname(fullPath);
	fs.mkdirSync(dir, { recursive: true });

	const content = renderProgressMarkdown(state);
	fs.writeFileSync(fullPath, content, "utf-8");
}
