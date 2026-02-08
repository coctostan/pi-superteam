/**
 * Brainstorm phase — interactive design refinement.
 *
 * Sub-steps: scout → questions → approaches → design sections → save design doc.
 * Uses ctx.ui for interaction, dispatchAgent for creative work,
 * parseBrainstormOutput for structured parsing.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OrchestratorState, BrainstormQuestion, BrainstormApproach, DesignSection } from "../orchestrator-state.js";
import { discoverAgents, dispatchAgent, getFinalOutput, type AgentProfile, type OnStreamEvent } from "../../dispatch.js";
import { parseBrainstormOutput } from "../brainstorm-parser.js";
import {
	buildScoutPrompt,
	buildBrainstormQuestionsPrompt,
	buildBrainstormApproachesPrompt,
	buildBrainstormDesignPrompt,
	buildBrainstormSectionRevisionPrompt,
} from "../prompt-builder.js";
import { formatStatus, formatToolAction, createActivityBuffer } from "../ui.js";

type Ctx = ExtensionContext | { cwd: string; hasUI?: boolean; ui?: any };

export async function runBrainstormPhase(
	state: OrchestratorState,
	ctx: Ctx,
	signal?: AbortSignal,
	onStreamEvent?: OnStreamEvent,
): Promise<OrchestratorState> {
	// Discover agents
	const { agents } = discoverAgents(ctx.cwd, true);
	const scoutAgent = agents.find((a) => a.name === "scout");
	const brainstormerAgent = agents.find((a) => a.name === "brainstormer");

	if (!scoutAgent || !brainstormerAgent) {
		state.error = `Required agents not found: ${!scoutAgent ? "scout" : ""} ${!brainstormerAgent ? "brainstormer" : ""}`.trim();
		return state;
	}

	const ui = (ctx as any).ui;

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

	// Sub-step: scout
	if (state.brainstorm.step === "scout") {
		ui?.setStatus?.("workflow", formatStatus(state));
		const result = await dispatchAgent(scoutAgent, buildScoutPrompt(ctx.cwd), ctx.cwd, signal, undefined, makeOnStreamEvent());
		state.totalCostUsd += result.usage.cost;
		state.brainstorm.scoutOutput = getFinalOutput(result.messages);
		state.brainstorm.step = "questions";
	}

	// Sub-step: questions
	if (state.brainstorm.step === "questions") {
		ui?.setStatus?.("workflow", formatStatus(state));
		const scoutOutput = state.brainstorm.scoutOutput || "";

		// Dispatch brainstormer for questions
		const questionsResult = await dispatchBrainstormerWithRetry(
			brainstormerAgent, 
			buildBrainstormQuestionsPrompt(scoutOutput, state.userDescription),
			ctx.cwd, state, signal, ui, makeOnStreamEvent,
		);
		if (!questionsResult) return state; // retry exhausted or aborted

		if (questionsResult.data.type !== "questions") {
			state.error = "Brainstormer returned wrong type for questions step";
			return state;
		}

		const questions = questionsResult.data.questions || [];
		state.brainstorm.questions = questions;

		// Present each question to user
		for (let i = 0; i < questions.length; i++) {
			const q = questions[i];
			let answer: string | undefined;

			if (q.type === "choice" && q.options && q.options.length > 0) {
				answer = await ui?.select?.(q.text, q.options);
			} else {
				answer = await ui?.input?.(q.text);
			}

			if (answer === undefined) {
				// User cancelled
				return state;
			}

			questions[i].answer = answer;
		}

		state.brainstorm.step = "approaches";
	}

	// Sub-step: approaches
	if (state.brainstorm.step === "approaches") {
		ui?.setStatus?.("workflow", formatStatus(state));
		const scoutOutput = state.brainstorm.scoutOutput || "";
		const qa = state.brainstorm.questions || [];

		const approachResult = await dispatchBrainstormerWithRetry(
			brainstormerAgent,
			buildBrainstormApproachesPrompt(scoutOutput, state.userDescription, qa),
			ctx.cwd, state, signal, ui, makeOnStreamEvent,
		);
		if (!approachResult) return state;

		if (approachResult.data.type !== "approaches") {
			state.error = "Brainstormer returned wrong type for approaches step";
			return state;
		}

		const approaches = approachResult.data.approaches || [];
		state.brainstorm.approaches = approaches;
		state.brainstorm.recommendation = approachResult.data.recommendation;

		// Present approaches to user
		const approachTitles = approaches.map((a) => a.title);
		const chosen = await ui?.select?.("Choose an approach", approachTitles);

		if (chosen === undefined) {
			return state; // cancelled
		}

		const chosenApproach = approaches.find((a) => a.title === chosen);
		state.brainstorm.chosenApproach = chosenApproach?.id || approaches[0]?.id;
		state.brainstorm.step = "design";
	}

	// Sub-step: design
	if (state.brainstorm.step === "design") {
		ui?.setStatus?.("workflow", formatStatus(state));
		const scoutOutput = state.brainstorm.scoutOutput || "";
		const qa = state.brainstorm.questions || [];
		const approaches = state.brainstorm.approaches || [];
		const chosenId = state.brainstorm.chosenApproach;
		const chosenApproach = approaches.find((a) => a.id === chosenId) || approaches[0];

		if (!chosenApproach) {
			state.error = "No approach selected for design step";
			return state;
		}

		// Dispatch brainstormer for design
		const designResult = await dispatchBrainstormerWithRetry(
			brainstormerAgent,
			buildBrainstormDesignPrompt(scoutOutput, state.userDescription, qa, chosenApproach),
			ctx.cwd, state, signal, ui, makeOnStreamEvent,
		);
		if (!designResult) return state;

		if (designResult.data.type !== "design") {
			state.error = "Brainstormer returned wrong type for design step";
			return state;
		}

		let sections = designResult.data.sections || [];

		// Present each section for approval
		for (let i = 0; i < sections.length; i++) {
			const section = sections[i];
			const title = section.title || "(untitled)";
			const message = section.content || "(no content)";
			const approved = await ui?.confirm?.(title, message);

			if (approved === undefined) {
				return state; // cancelled
			}

			if (!approved) {
				// Get feedback and dispatch revision
				const feedback = await ui?.input?.("What would you like changed?");
				if (feedback === undefined) return state;

				const revisionResult = await dispatchBrainstormerWithRetry(
					brainstormerAgent,
					buildBrainstormSectionRevisionPrompt(section, feedback, state.userDescription),
					ctx.cwd, state, signal, ui, makeOnStreamEvent,
				);
				if (!revisionResult) return state;

				if (revisionResult.data.type === "design" && revisionResult.data.sections?.length > 0) {
					sections[i] = revisionResult.data.sections[0];
				}

				// Re-confirm revised section
				const revisedTitle = sections[i].title || "(untitled)";
				const revisedMessage = sections[i].content || "(no content)";
				const revisedApproved = await ui?.confirm?.(revisedTitle, revisedMessage);
				if (!revisedApproved) {
					// Accept anyway — we move forward after one revision
				}
			}
		}

		// All sections approved — assemble design document
		state.brainstorm.designSections = sections;
		state.brainstorm.step = "done";

		const designContent = assembleDesignDoc(state.userDescription, sections);
		const slug = state.userDescription
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40);
		const date = new Date().toISOString().slice(0, 10);
		const designPath = `docs/plans/${date}-${slug}-design.md`;

		state.designPath = designPath;
		state.designContent = designContent;
		state.phase = "plan-write";
	}

	return state;
}

async function dispatchBrainstormerWithRetry(
	agent: AgentProfile,
	prompt: string,
	cwd: string,
	state: OrchestratorState,
	signal: AbortSignal | undefined,
	ui: any,
	makeOnStreamEvent: () => OnStreamEvent,
): Promise<{ data: any } | null> {
	const MAX_RETRIES = 2;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const taskPrompt = attempt > 0
			? prompt + "\n\nIMPORTANT: You MUST include a ```superteam-brainstorm JSON block in your response."
			: prompt;

		const result = await dispatchAgent(agent, taskPrompt, cwd, signal, undefined, makeOnStreamEvent());
		state.totalCostUsd += result.usage.cost;

		const output = getFinalOutput(result.messages);
		const parsed = parseBrainstormOutput(output);

		if (parsed.status === "ok") {
			return parsed;
		}

		// Parse failed — retry
		ui?.notify?.(`Parse failed (attempt ${attempt + 1}): ${parsed.parseError}`, "warning");
	}

	// All retries failed
	const choice = await ui?.select?.("Brainstorm output couldn't be parsed", ["Retry", "Abort"]);
	if (choice === "Abort" || choice === undefined) {
		state.error = "Brainstorm output parsing failed after retries";
	}
	return null;
}

function assembleDesignDoc(title: string, sections: DesignSection[]): string {
	const lines: string[] = [`# Design: ${title}`, ""];
	for (const section of sections) {
		lines.push(`## ${section.title}`, "", section.content, "");
	}
	return lines.join("\n");
}
