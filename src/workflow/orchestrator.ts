/**
 * Workflow orchestrator — deterministic loop driving all phases.
 */

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
import { formatStatus } from "./ui.js";
import { writeProgressFile } from "./progress.js";
import { runGitPreflight } from "./git-preflight.js";
import { runBrainstormPhase } from "./phases/brainstorm.js";
import { runPlanWritePhase } from "./phases/plan-write.js";
import { runPlanReviewPhase } from "./phases/plan-review.js";
import { runConfigurePhase } from "./phases/configure.js";
import { runExecutePhase } from "./phases/execute.js";
import { runFinalizePhase } from "./phases/finalize.js";

type Ctx = ExtensionContext | { cwd: string; hasUI?: boolean; ui?: any };

// --- New: runWorkflowLoop ---

export async function runWorkflowLoop(
	state: OrchestratorState,
	ctx: Ctx,
	signal?: AbortSignal,
): Promise<OrchestratorState> {
	const ui = (ctx as any).ui;

	// Git preflight — only on first run (not resume)
	if (!state.gitStartingSha) {
		try {
			const preflight = await runGitPreflight(ctx.cwd);

			// Dirty repo check
			if (!preflight.clean && ui?.select) {
				const dirtyChoice = await ui.select(
					`Working tree has uncommitted changes: ${preflight.uncommittedFiles.join(", ")}`,
					["Stash changes", "Continue anyway", "Abort"],
				);
				if (dirtyChoice === "Abort") {
					state.phase = "done";
					state.error = "Aborted: dirty working tree";
					saveState(state, ctx.cwd);
					return state;
				}
				if (dirtyChoice === "Stash changes") {
					const { execFile: execFileCb } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const exec = promisify(execFileCb);
					await exec("git", ["stash", "push", "-m", "superteam-workflow-preflight"], { cwd: ctx.cwd });
				}
			}

			// Main branch check
			if (preflight.isMainBranch && ui?.select) {
				const branchChoice = await ui.select(
					`On ${preflight.branch} branch. Create a workflow branch?`,
					["Create workflow branch", "Continue on main", "Abort"],
				);
				if (branchChoice === "Abort") {
					state.phase = "done";
					state.error = "Aborted: on main branch";
					saveState(state, ctx.cwd);
					return state;
				}
				if (branchChoice === "Create workflow branch") {
					const slug = state.userDescription
						.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
					const branchName = `workflow/${slug}`;
					const { execFile: execFileCb } = await import("node:child_process");
					const { promisify } = await import("node:util");
					const exec = promisify(execFileCb);
					await exec("git", ["checkout", "-b", branchName], { cwd: ctx.cwd });
					state.gitBranch = branchName;
					ui?.notify?.(`Created branch: ${branchName}`, "info");
				}
			}

			state.gitStartingSha = preflight.sha;
			if (!state.gitBranch) state.gitBranch = preflight.branch;
			saveState(state, ctx.cwd);
		} catch (err: any) {
			// Non-fatal — not a git repo or git not available
			ui?.notify?.(`Git preflight skipped: ${err.message}`, "info");
		}
	}

	while (state.phase !== "done") {
		ui?.setStatus?.("workflow", formatStatus(state));

		switch (state.phase) {
			case "brainstorm":
				state = await runBrainstormPhase(state, ctx, signal);
				break;
			case "plan-write":
				state = await runPlanWritePhase(state, ctx, signal);
				break;
			case "plan-review":
				state = await runPlanReviewPhase(state, ctx, signal);
				break;
			case "configure":
				state = await runConfigurePhase(state, ctx);
				break;
			case "execute":
				state = await runExecutePhase(state, ctx, signal);
				break;
			case "finalize": {
				// Check for remaining batches before finalizing
				if (state.batches && state.currentBatchIndex !== undefined) {
					const nextBatch = state.currentBatchIndex + 1;
					if (nextBatch < state.batches.length) {
						state.batches[state.currentBatchIndex].status = "complete";

						const batchChoice = await ui?.select?.(
							`Batch ${state.currentBatchIndex + 1} complete. Continue to batch ${nextBatch + 1}: "${state.batches[nextBatch].title}"?`,
							["Continue to next batch", "Stop here"],
						);

						if (batchChoice === "Continue to next batch") {
							state.currentBatchIndex = nextBatch;
							state.batches[nextBatch].status = "active";
							state.tasks = [];
							state.currentTaskIndex = 0;
							state.planContent = undefined;
							state.planPath = undefined;
							state.phase = "plan-write";
							break;
						}
					}
				}

				const { state: finalState, report } = await runFinalizePhase(state, ctx, signal);
				state = finalState;
				state.phase = "done";
				ui?.notify?.(report, "info");
				break;
			}
			default:
				// Unknown phase — break to avoid infinite loop
				state.phase = "done";
				break;
		}

		// Persist after each phase
		saveState(state, ctx.cwd);
		writeProgressFile(state, ctx.cwd);

		// Check for error
		if (state.error) {
			ui?.notify?.(state.error, "warning");
			ui?.notify?.("Use /workflow to resume.", "info");
			break;
		}
	}

	// Clean up UI
	ui?.setStatus?.("workflow", undefined);
	ui?.setWidget?.("workflow-progress", undefined);
	ui?.setWidget?.("workflow-activity", undefined);

	return state;
}

// --- Legacy: runOrchestrator (secondary tool path) ---

export type OrchestratorResult = {
	status: "running" | "waiting" | "done" | "error";
	message: string;
	state: OrchestratorState;
};

export async function runOrchestrator(
	ctx: Ctx,
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

	// f. Phase dispatch loop (legacy: single step)
	let previousPhase: string | undefined;
	while (true) {
		const currentPhase = state!.phase;

		switch (currentPhase) {
			case "brainstorm":
				state!.phase = "plan-write";
				break;
			case "plan-write":
				state = await runPlanWritePhase(state!, ctx, signal);
				break;
			case "plan-draft":
				state = await runPlanWritePhase(state!, ctx, signal);
				break;
			case "plan-review":
				state = await runPlanReviewPhase(state!, ctx, signal);
				break;
			case "configure":
				state = await runConfigurePhase(state!, ctx);
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
