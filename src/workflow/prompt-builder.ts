/**
 * Prompt builder — deterministic prompt construction for all workflow agents.
 *
 * All prompts are concise, include metadata inline, and instruct agents
 * to read source files by path (not inlined).
 */

import type { TaskExecState } from "./orchestrator-state.js";
import type { ReviewFindings } from "../review-parser.js";
import { formatFindings } from "../review-parser.js";


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

export function buildPlanReviewPrompt(planContent: string, reviewType: "architect" | "spec", designContent?: string): string {
	const instructions = reviewType === "architect"
		? `Check design, modularity, and task ordering. Are dependencies correct? Is the architecture sound?`
		: `Check completeness, task independence, and file coverage. Can each task be done standalone? Are all files covered?`;

	const parts = [
		`Review this implementation plan (${reviewType} review).`,
		``,
		`<plan>`,
		planContent,
		`</plan>`,
		``,
	];

	if (designContent) {
		parts.push(`<design>`, designContent, `</design>`, ``);
		parts.push(`Validate the plan against the approved design above.`, ``);
	}

	parts.push(instructions);
	return parts.join("\n");
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
		`Only review files listed below — do not review test files unless the task description explicitly targets test code.`,
		`Read these files. Compare implementation against spec.`,
		`Do NOT trust the implementer's self-report — verify independently.`,
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
		].join("\n");
}

// --- Brainstorm ---

import type { BrainstormQuestion, BrainstormApproach, DesignSection } from "./orchestrator-state.js";

export function buildBrainstormQuestionsPrompt(scoutOutput: string, userDescription: string): string {
	return [
		`## Task: Generate clarifying questions`,
		``,
		`The user wants: ${userDescription}`,
		``,
		`## Project context (from scout)`,
		scoutOutput,
		``,
		`## Instructions`,
		`Generate 3-7 focused questions to clarify requirements, constraints, and preferences.`,
		`Use "choice" type with options for questions where common choices exist.`,
		`Use "input" type for open-ended questions.`,
		``,
		`Return a \`\`\`superteam-brainstorm block with type "questions".`,
		``,
		`IMPORTANT: In your JSON output, never use literal newlines inside string values. Use \\n escape sequences instead.`,
	].join("\n");
}

export function buildBrainstormApproachesPrompt(
	scoutOutput: string,
	userDescription: string,
	questionsAndAnswers: BrainstormQuestion[],
): string {
	const qaLines = questionsAndAnswers.map((q) => `- **${q.text}** → ${q.answer || "(no answer)"}`).join("\n");
	return [
		`## Task: Propose implementation approaches`,
		``,
		`The user wants: ${userDescription}`,
		``,
		`## Requirements (from Q&A)`,
		qaLines,
		``,
		`## Project context (from scout)`,
		scoutOutput,
		``,
		`## Instructions`,
		`Propose 2-3 distinct implementation approaches.`,
		`For each: title, summary, tradeoffs, estimated task count.`,
		`Provide a recommendation with reasoning.`,
		``,
		`Return a \`\`\`superteam-brainstorm block with type "approaches".`,
		``,
		`IMPORTANT: In your JSON output, never use literal newlines inside string values. Use \\n escape sequences instead.`,
	].join("\n");
}

export function buildBrainstormDesignPrompt(
	scoutOutput: string,
	userDescription: string,
	questionsAndAnswers: BrainstormQuestion[],
	chosenApproach: BrainstormApproach,
): string {
	const qaLines = questionsAndAnswers.map((q) => `- **${q.text}** → ${q.answer || "(no answer)"}`).join("\n");
	return [
		`## Task: Write detailed design sections`,
		``,
		`The user wants: ${userDescription}`,
		`Chosen approach: **${chosenApproach.title}** — ${chosenApproach.summary}`,
		``,
		`## Requirements (from Q&A)`,
		qaLines,
		``,
		`## Project context (from scout)`,
		scoutOutput,
		``,
		`## Instructions`,
		`Write 3-6 design sections covering: architecture, components, data flow, error handling, testing approach.`,
		`Each section: 200-300 words, specific file paths and function names.`,
		``,
		`Return a \`\`\`superteam-brainstorm block with type "design".`,
		``,
		`IMPORTANT: In your JSON output, never use literal newlines inside string values. Use \\n escape sequences instead.`,
	].join("\n");
}

export function buildBrainstormSectionRevisionPrompt(
	section: DesignSection,
	feedback: string,
	context: string,
): string {
	return [
		`## Task: Revise design section`,
		``,
		`## Current section: ${section.title}`,
		section.content,
		``,
		`## User feedback`,
		feedback,
		``,
		`## Context`,
		context,
		``,
		`## Instructions`,
		`Revise this section based on the feedback. Keep the same id and title.`,
		`Return a \`\`\`superteam-brainstorm block with type "design" containing the revised section.`,
		``,
		`IMPORTANT: In your JSON output, never use literal newlines inside string values. Use \\n escape sequences instead.`,
	].join("\n");
}

// --- Plan-write ---

export function buildPlannerPromptFromDesign(
	designContent: string,
	scoutOutput: string,
	userDescription: string,
	planFilePath: string,
): string {
	return [
		`Write a detailed TDD implementation plan to ${planFilePath}.`,
		``,
		`## User request`,
		userDescription,
		``,
		`## Approved design`,
		designContent,
		``,
		`## Project context (from scout)`,
		scoutOutput,
		``,
		`## Instructions`,
		`The plan must contain a \`\`\`superteam-tasks block with YAML task list.`,
		`Each task needs: title, description, files.`,
		`Keep tasks small: 1-3 files, 2-5 min each.`,
		`Use TDD — each task should mention writing tests first.`,
		`Include complete test code inline in task descriptions.`,
		`Include exact file paths and verification commands.`,
	].join("\n");
}

// --- Plan revision from findings ---

export function buildPlanRevisionPromptFromFindings(
	planContent: string,
	designContent: string,
	findingsText: string,
): string {
	return [
		`Revise this plan based on review findings. Write the updated plan to the same file.`,
		`Keep the \`\`\`superteam-tasks block.`,
		``,
		`## Current plan`,
		planContent,
		``,
		`## Approved design`,
		designContent,
		``,
		`## Review findings`,
		findingsText,
	].join("\n");
}

// --- Utilities ---

export function extractPlanContext(planContent: string): string {
	const marker = "```superteam-tasks";
	const idx = planContent.indexOf(marker);
	if (idx === -1) return planContent;
	return planContent.slice(0, idx).trim();
}
