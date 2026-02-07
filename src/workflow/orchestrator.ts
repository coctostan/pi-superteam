import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type OrchestratorState,
	type PendingInteraction,
	createInitialState,
	saveState,
	loadState,
	clearState,
} from "./orchestrator-state.js";
import { formatInteractionForAgent, parseUserResponse } from "./interaction.js";
import { runPlanDraftPhase } from "./phases/plan.js";
import { runPlanReviewPhase } from "./phases/plan-review.js";
import { runConfigurePhase } from "./phases/configure.js";
import { runExecutePhase } from "./phases/execute.js";
import { runFinalizePhase } from "./phases/finalize.js";

export type OrchestratorResult = {
	status: "running" | "waiting" | "done" | "error";
	message: string;
	state: OrchestratorState;
};

export async function runOrchestrator(
	ctx: ExtensionContext | { cwd: string },
	signal?: AbortSignal,
	userInput?: string,
): Promise<OrchestratorResult> {
	// a. Load state
	let state = loadState(ctx.cwd);

	// b. No state and no userInput
	if (!state && !userInput) {
		return {
			status: "error",
			message: "No active workflow. Use /workflow <description> to start a new one.",
			state: createInitialState(""),
		};
	}

	// c. No state but userInput provided — create initial state
	if (!state && userInput) {
		state = createInitialState(userInput);
		saveState(state, ctx.cwd);
	}

	// d. Pending interaction with userInput — parse the response
	if (state!.pendingInteraction && userInput !== undefined) {
		try {
			parseUserResponse(state!.pendingInteraction, userInput);
		} catch (e: any) {
			return {
				status: "error",
				message: e.message,
				state: state!,
			};
		}
		state!.pendingInteraction = undefined;
	}

	// e. Pending interaction with NO userInput — return waiting
	if (state!.pendingInteraction && userInput === undefined) {
		return {
			status: "waiting",
			message: formatInteractionForAgent(state!.pendingInteraction),
			state: state!,
		};
	}

	// f. Phase dispatch loop
	let previousPhase: string | undefined;
	while (true) {
		const currentPhase = state!.phase;

		switch (currentPhase) {
			case "plan-draft":
				state = await runPlanDraftPhase(state!, ctx as ExtensionContext, signal);
				break;
			case "plan-review":
				state = await runPlanReviewPhase(state!, ctx as ExtensionContext, signal);
				break;
			case "configure":
				state = await runConfigurePhase(state!, ctx, userInput);
				break;
			case "execute":
				state = await runExecutePhase(state!, ctx, signal, userInput);
				break;
			case "finalize": {
				const { state: finalState, report } = await runFinalizePhase(state!, ctx, signal);
				state = finalState;
				saveState(state, ctx.cwd);
				return { status: "done", message: report, state };
			}
			case "done":
				return {
					status: "done",
					message: "Workflow complete.",
					state: state!,
				};
		}

		// g. After phase function returns
		saveState(state!, ctx.cwd);

		// Error check
		if (state!.error) {
			return { status: "error", message: state!.error, state: state! };
		}

		// Pending interaction check
		if (state!.pendingInteraction) {
			return {
				status: "waiting",
				message: formatInteractionForAgent(state!.pendingInteraction),
				state: state!,
			};
		}

		// Phase changed — chain to next phase
		if (state!.phase !== currentPhase) {
			// Clear userInput after first use so subsequent phases don't get it
			userInput = undefined;
			previousPhase = currentPhase;
			continue;
		}

		// Same phase (checkpoint/batch pause)
		const tasksDone = state!.tasks.filter((t) => t.status === "complete").length;
		const total = state!.tasks.length;
		return {
			status: "running",
			message: `Phase: ${state!.phase} | Progress: ${tasksDone}/${total} tasks complete | Cost: $${state!.totalCostUsd.toFixed(2)}`,
			state: state!,
		};
	}
}
