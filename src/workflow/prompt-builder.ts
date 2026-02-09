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
		`Read .pi/context.md if present in ${cwd}.`,
		`Summarize: tech stack, directory layout (3 levels), key entry points, test conventions.`,
		`Max 500 words.`,
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

export function buildImplPrompt(
	task: TaskExecState,
	planContext: string,
	previousTaskSummary?: { title: string; status: string; changedFiles: string[] },
	priorTasks?: Array<{ title: string; status: string; changedFiles: string[] }>,
): string {
	const parts = [
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
	];

	// New: array of prior tasks (capped at 5)
	if (priorTasks && priorTasks.length > 0) {
		const capped = priorTasks.slice(-5);
		parts.push(`## Prior tasks`);
		for (const pt of capped) {
			parts.push(`**${pt.title}** — ${pt.status}`);
			if (pt.changedFiles.length > 0) {
				parts.push(`Changed: ${pt.changedFiles.join(", ")}`);
			}
		}
		parts.push(``);
	} else if (previousTaskSummary) {
		// Legacy: single previous task
		parts.push(
			`## Previous task`,
			`**${previousTaskSummary.title}** — ${previousTaskSummary.status}`,
			`Changed files:`,
			previousTaskSummary.changedFiles.map((f) => `- ${f}`).join("\n"),
			``,
		);
	}

	parts.push(
		`## Process`,
		`Use strict TDD: write a failing test first, implement minimally, refactor.`,
		`Commit after each green cycle.`,
		`Self-review your changes before reporting done.`,
	);

	return parts.join("\n");
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
		``,
		`Verify that implementation files were modified, not only test files. If only test files changed, flag as a critical finding.`,
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

import type { BrainstormQuestion, BrainstormApproach, DesignSection, ConversationEntry, BrainstormStep } from "./orchestrator-state.js";

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

// --- Targeted plan revision ---

export function buildTargetedPlanRevisionPrompt(
	planContent: string,
	findings: string,
	designContent: string,
): string {
	return [
		`Revise this plan based on review findings. Write the updated plan to the same file.`,
		``,
		`## IMPORTANT: Targeted edits only`,
		`- Edit ONLY the tasks mentioned or referenced in the findings below.`,
		`- Do NOT rewrite other tasks — leave them exactly as they are.`,
		`- Preserve existing task IDs and ordering unless findings specifically require changes.`,
		`- Keep the \`\`\`superteam-tasks block intact with all tasks.`,
		``,
		`## Current plan`,
		planContent,
		``,
		`## Approved design`,
		designContent,
		``,
		`## Review findings`,
		findings,
	].join("\n");
}

// --- Brainstorm conversational ---

const CONVERSATION_WORD_CAP = 3000;

export function buildBrainstormConversationalPrompt(
	state: {
		scoutOutput?: string;
		userDescription: string;
		step: BrainstormStep;
		conversationLog?: ConversationEntry[];
		questions?: BrainstormQuestion[];
		approaches?: BrainstormApproach[];
		chosenApproach?: string;
	},
	userComment: string,
): string {
	const parts: string[] = [
		`## Task: Revise ${state.step} based on discussion`,
		``,
		`The user wants: ${state.userDescription}`,
		``,
	];

	if (state.scoutOutput) {
		parts.push(`## Project context (from scout)`, state.scoutOutput, ``);
	}

	// Current answers if in approaches or design step
	if (state.questions && state.questions.length > 0) {
		const qaLines = state.questions
			.filter((q) => q.answer)
			.map((q) => `- **${q.text}** → ${q.answer}`);
		if (qaLines.length > 0) {
			parts.push(`## Current answers`, ...qaLines, ``);
		}
	}

	if (state.chosenApproach && state.approaches) {
		const chosen = state.approaches.find((a) => a.id === state.chosenApproach);
		if (chosen) {
			parts.push(`## Chosen approach`, `**${chosen.title}** — ${chosen.summary}`, ``);
		}
	}

	// Conversation history — filtered to current step, capped
	const log = (state.conversationLog || []).filter((e) => e.step === state.step);
	if (log.length > 0) {
		parts.push(`## Conversation`);
		let wordCount = 0;
		for (const entry of log) {
			const entryWords = entry.content.split(/\s+/).length;
			if (wordCount + entryWords > CONVERSATION_WORD_CAP) {
				parts.push(`(earlier conversation truncated)`);
				break;
			}
			const label = entry.role === "brainstormer" ? "Brainstormer" : "User";
			parts.push(`**${label}:** ${entry.content}`);
			wordCount += entryWords;
		}
		parts.push(``);
	}

	parts.push(
		`## User's latest comment`,
		userComment,
		``,
		`## Instructions`,
		`Revise your ${state.step} output based on the conversation above and the user's latest comment.`,
		`Return a \`\`\`superteam-brainstorm block with the appropriate type.`,
		``,
		`IMPORTANT: In your JSON output, never use literal newlines inside string values. Use \\n escape sequences instead.`,
	);

	return parts.join("\n");
}

// --- Utilities ---

export function extractPlanContext(planContent: string): string {
	const marker = "```superteam-tasks";
	const idx = planContent.indexOf(marker);
	if (idx === -1) return planContent;
	return planContent.slice(0, idx).trim();
}
