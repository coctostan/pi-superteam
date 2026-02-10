/**
 * Brainstorm phase — interactive design refinement.
 *
 * Sub-steps: scout → questions → approaches → design sections → save design doc.
 * Uses ctx.ui for interaction, dispatchAgent for creative work,
 * parseBrainstormOutput for structured parsing.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OrchestratorState, BrainstormQuestion, BrainstormApproach, DesignSection, BrainstormStep } from "../orchestrator-state.js";
import { discoverAgents, dispatchAgent, getFinalOutput, type AgentProfile, type OnStreamEvent } from "../../dispatch.js";
import { parseBrainstormOutput } from "../brainstorm-parser.js";
import {
	buildScoutPrompt,
	buildBrainstormQuestionsPrompt,
	buildBrainstormApproachesPrompt,
	buildBrainstormDesignPrompt,
	buildBrainstormSectionRevisionPrompt,
	buildBrainstormTriagePrompt,
	buildBrainstormConversationalPrompt,
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
		state.brainstorm.step = "triage";
		state.brainstorm.conversationLog = [];
	}

	// Sub-step: triage
	if (state.brainstorm.step === "triage") {
		ui?.setStatus?.("workflow", formatStatus(state));
		const scoutOutput = state.brainstorm.scoutOutput || "";

		const triageResult = await dispatchBrainstormerWithRetry(
			brainstormerAgent,
			buildBrainstormTriagePrompt(scoutOutput, state.userDescription),
			ctx.cwd, state, signal, ui, makeOnStreamEvent,
		);
		if (!triageResult) return state;

		if (triageResult.data.type !== "triage") {
			state.error = "Brainstormer returned wrong type for triage step";
			return state;
		}

		let currentTriage = triageResult.data;
		appendLog(state, "brainstormer", "triage", currentTriage.reasoning);

		// Present triage to user — loop for discussion
		while (true) {
			const levelLabel = currentTriage.level;
			const options = buildTriageOptions(levelLabel);

			const triageMessage = formatTriageMessage(currentTriage);
			ui?.notify?.(triageMessage, "info");

			const choice = await ui?.select?.("Brainstormer assessment", options);
			if (choice === undefined) return state;

			if (choice.startsWith("Agree")) {
				state.brainstorm.complexityLevel = currentTriage.level;
				break;
			}

			if (choice === "Skip to planning") {
				state.brainstorm.complexityLevel = currentTriage.level;
				state.brainstorm.step = "done";
				state.phase = "plan-write";
				return state;
			}

			if (choice === "Discuss") {
				const comment = await ui?.input?.("Your thoughts on this assessment:");
				if (comment === undefined) return state;
				appendLog(state, "user", "triage", comment);

				const revisedResult = await dispatchBrainstormerWithRetry(
					brainstormerAgent,
					buildBrainstormConversationalPrompt(
						{
							scoutOutput,
							userDescription: state.userDescription,
							step: "triage",
							conversationLog: state.brainstorm.conversationLog,
						},
						comment,
					),
					ctx.cwd, state, signal, ui, makeOnStreamEvent,
				);
				if (!revisedResult) return state;

				if (revisedResult.data.type === "triage") {
					currentTriage = revisedResult.data;
					appendLog(state, "brainstormer", "triage", currentTriage.reasoning);
				}
				continue;
			}

			// Override options
			if (choice.includes("straightforward")) {
				state.brainstorm.complexityLevel = "straightforward";
				break;
			}
			if (choice.includes("exploration")) {
				state.brainstorm.complexityLevel = "exploration";
				break;
			}
			if (choice.includes("complex")) {
				state.brainstorm.complexityLevel = "complex";
				break;
			}
		}

		// Determine next step based on complexity
		const level = state.brainstorm.complexityLevel!;
		const skips = currentTriage.suggestedSkips || [];

		if (level === "straightforward" && skips.includes("questions") && skips.includes("approaches")) {
			state.brainstorm.step = "design";
		} else if (level === "straightforward" && skips.includes("questions")) {
			state.brainstorm.step = "approaches";
		} else {
			state.brainstorm.step = "questions";
		}
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

		let currentQuestions = questionsResult.data.questions || [];
		state.brainstorm.questions = currentQuestions;
		appendLog(state, "brainstormer", "questions", currentQuestions.map((q) => q.text).join("; "));

		// Question-answer-discuss loop
		while (true) {
			// Present each question to user
			for (let i = 0; i < currentQuestions.length; i++) {
				const q = currentQuestions[i];
				let answer: string | undefined;

				if (q.type === "choice" && q.options && q.options.length > 0) {
					answer = await ui?.select?.(q.text, q.options);
				} else {
					answer = await ui?.input?.(q.text);
				}

				if (answer === undefined) {
					return state;
				}

				currentQuestions[i].answer = answer;
			}

			// Offer discuss/proceed
			const choice = await ui?.select?.("Questions answered", ["Proceed", "Discuss"]);
			if (choice === undefined) return state;

			if (choice === "Proceed") break;

			if (choice === "Discuss") {
				const comment = await ui?.input?.("Your thoughts on these questions:");
				if (comment === undefined) return state;
				appendLog(state, "user", "questions", comment);

				const revisedResult = await dispatchBrainstormerWithRetry(
					brainstormerAgent,
					buildBrainstormConversationalPrompt(
						{
							scoutOutput: state.brainstorm.scoutOutput || "",
							userDescription: state.userDescription,
							step: "questions",
							conversationLog: state.brainstorm.conversationLog,
						},
						comment,
					),
					ctx.cwd, state, signal, ui, makeOnStreamEvent,
				);
				if (!revisedResult) return state;

				if (revisedResult.data.type === "questions") {
					currentQuestions = revisedResult.data.questions || [];
					state.brainstorm.questions = currentQuestions;
					appendLog(state, "brainstormer", "questions", currentQuestions.map((q) => q.text).join("; "));
				}
				continue;
			}

			break;
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

		// For straightforward path without approach selection, use a synthetic approach
		const effectiveApproach = chosenApproach || {
			id: "direct",
			title: "Direct implementation",
			summary: state.userDescription,
			tradeoffs: "None — straightforward change",
			taskEstimate: 1,
		};

		// Dispatch brainstormer for design
		const designResult = await dispatchBrainstormerWithRetry(
			brainstormerAgent,
			buildBrainstormDesignPrompt(scoutOutput, state.userDescription, qa, effectiveApproach),
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

function appendLog(state: OrchestratorState, role: "brainstormer" | "user", step: BrainstormStep, content: string): void {
	if (!state.brainstorm.conversationLog) state.brainstorm.conversationLog = [];
	state.brainstorm.conversationLog.push({ role, step, content });
}

function buildTriageOptions(level: string): string[] {
	const options = [`Agree — ${level}`, "Discuss", "Skip to planning"];
	if (level !== "straightforward") options.splice(2, 0, "Override — straightforward");
	if (level !== "exploration") options.splice(options.length - 1, 0, "Override — exploration");
	if (level !== "complex") options.splice(options.length - 1, 0, "Override — complex");
	return options;
}

function formatTriageMessage(triage: any): string {
	const lines = [`Complexity: ${triage.level}`, triage.reasoning];
	if (triage.batches?.length > 0) {
		lines.push("", "Suggested batches:");
		for (const b of triage.batches) {
			lines.push(`  • ${b.title}: ${b.description}`);
		}
	}
	if (triage.splits?.length > 0) {
		lines.push("", "Suggested splits:");
		for (const s of triage.splits) {
			lines.push(`  • ${s.title}: ${s.description}`);
		}
	}
	return lines.join("\n");
}

function assembleDesignDoc(title: string, sections: DesignSection[]): string {
	const lines: string[] = [`# Design: ${title}`, ""];
	for (const section of sections) {
		lines.push(`## ${section.title}`, "", section.content, "");
	}
	return lines.join("\n");
}
