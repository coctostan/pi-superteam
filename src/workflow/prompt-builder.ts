/**
 * Prompt builder — deterministic prompt construction for all workflow agents.
 *
 * All prompts are concise, include metadata inline, and instruct agents
 * to read source files by path (not inlined).
 */

import type { TaskExecState } from "./orchestrator-state.js";
import type { ReviewFindings } from "../review-parser.js";
import { formatFindings } from "../review-parser.js";

// Shared review output format instruction — used by all review prompts
const REVIEW_OUTPUT_FORMAT = [
	``,
	`IMPORTANT: You MUST end your response with a \`\`\`superteam-json fenced code block exactly like this:`,
	``,
	"```superteam-json",
	`{`,
	`  "passed": true,`,
	`  "findings": [{"severity": "medium", "file": "path", "issue": "description", "suggestion": "fix"}],`,
	`  "mustFix": [],`,
	`  "summary": "Brief summary"`,
	`}`,
	"```",
	``,
	`Set passed to false if there are issues that must be fixed.`,
].join("\n");

// --- Scout ---

export function buildScoutPrompt(cwd: string): string {
	return [
		`Explore the project at ${cwd}.`,
		`List key files, tech stack, directory structure, and conventions.`,
		`Be brief. Output a structured summary.`,
	].join("\n");
}

// --- Planner ---

export function buildPlannerPrompt(scoutOutput: string, userDescription: string, planPath: string): string {
	return [
		`Write a plan file to ${planPath}.`,
		``,
		`## User request`,
		userDescription,
		``,
		`## Project context`,
		scoutOutput,
		``,
		`## Instructions`,
		`The plan must contain a \`\`\`superteam-tasks block with YAML task list.`,
		`Each task needs: title, description, files.`,
		`Keep tasks small: 1-3 files, 2-5 min each.`,
		`Use TDD — each task should mention writing tests first.`,
		`Include a Goal, Architecture, and Tech Stack header before the tasks.`,
	].join("\n");
}

// --- Plan revision ---

export function buildPlanRevisionPrompt(planContent: string, findings: string): string {
	return [
		`Revise this plan based on review findings. Write the updated plan to the same file.`,
		`Keep the \`\`\`superteam-tasks block.`,
		``,
		`## Current plan`,
		planContent,
		``,
		`## Review findings`,
		findings,
	].join("\n");
}

// --- Plan review ---

export function buildPlanReviewPrompt(planContent: string, reviewType: "architect" | "spec"): string {
	const instructions = reviewType === "architect"
		? `Check design, modularity, and task ordering. Are dependencies correct? Is the architecture sound?`
		: `Check completeness, task independence, and file coverage. Can each task be done standalone? Are all files covered?`;

	return [
		`Review this implementation plan (${reviewType} review).`,
		``,
		`<plan>`,
		planContent,
		`</plan>`,
		``,
		instructions,
		REVIEW_OUTPUT_FORMAT,
	].join("\n");
}

// --- Implementation ---

export function buildImplPrompt(task: TaskExecState, planContext: string): string {
	return [
		`## Task: ${task.title}`,
		``,
		task.description,
		``,
		`## Files`,
		task.files.map((f) => `- ${f}`).join("\n"),
		``,
		`## Plan context`,
		planContext,
		``,
		`## Process`,
		`Use strict TDD: write a failing test first, implement minimally, refactor.`,
		`Commit after each green cycle.`,
		`Self-review your changes before reporting done.`,
	].join("\n");
}

// --- Fix ---

export function buildFixPrompt(task: TaskExecState, reviewType: string, findings: ReviewFindings, changedFiles: string[]): string {
	return [
		`Fix these ${reviewType} review findings for task "${task.title}".`,
		``,
		formatFindings(findings, reviewType),
		``,
		`## Changed files`,
		changedFiles.map((f) => `- ${f}`).join("\n"),
		``,
		`Update tests if needed. Use TDD — fix failing tests first if any.`,
	].join("\n");
}

// --- Spec review ---

export function buildSpecReviewPrompt(task: TaskExecState, changedFiles: string[]): string {
	return [
		`## Spec review for: ${task.title}`,
		``,
		`### Task spec`,
		task.description,
		``,
		`### Files to read`,
		changedFiles.map((f) => `- ${f}`).join("\n"),
		``,
		`Read these files. Compare implementation against spec.`,
		`Do NOT trust the implementer's self-report — verify independently.`,
		REVIEW_OUTPUT_FORMAT,
	].join("\n");
}

// --- Quality review ---

export function buildQualityReviewPrompt(task: TaskExecState, changedFiles: string[]): string {
	return [
		`## Quality review for: ${task.title}`,
		``,
		`Review code quality in these files:`,
		changedFiles.map((f) => `- ${f}`).join("\n"),
		``,
		`Check: naming, DRY, error handling, test quality.`,
		REVIEW_OUTPUT_FORMAT,
	].join("\n");
}

// --- Final review ---

export function buildFinalReviewPrompt(completedTasks: TaskExecState[], changedFiles: string[]): string {
	const taskSummary = completedTasks.map((t) => `- ${t.title}: ${t.description.split("\n")[0]}`).join("\n");

	return [
		`## Final review`,
		``,
		`### Completed tasks`,
		taskSummary,
		``,
		`### Changed files`,
		changedFiles.map((f) => `- ${f}`).join("\n"),
		``,
		`Review the full implementation across these files.`,
		`Check cross-task integration, consistency, and completeness.`,
		REVIEW_OUTPUT_FORMAT,
	].join("\n");
}

// --- Utilities ---

export function extractPlanContext(planContent: string): string {
	const marker = "```superteam-tasks";
	const idx = planContent.indexOf(marker);
	if (idx === -1) return planContent;
	return planContent.slice(0, idx).trim();
}
