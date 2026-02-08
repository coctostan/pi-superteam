/**
 * Workflow state — plan tracking, TDD mode, review cycles, session persistence.
 *
 * Branch-aware: all state derived from session entries via getBranch().
 * No global mutable state — state is reconstructed on resume.
 * All types use plain objects (Record, arrays) for JSON serialization.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// --- Types ---

export type TddMode = "off" | "tdd" | "atdd";

export type TaskStatus = "pending" | "implementing" | "reviewing" | "fixing" | "complete" | "skipped";

export interface PlanTask {
	id: number;
	title: string;
	description: string;
	files: string[];
	status: TaskStatus;
	reviewsPassed: string[];
	reviewsFailed: string[];
	fixAttempts: number;
}

export interface ReviewCycle {
	taskId: number;
	reviewType: string;
	agent: string;
	status: "pending" | "passed" | "failed" | "inconclusive";
	findings?: Record<string, unknown>;
	fixedBy?: string;
	timestamp: number;
}

export interface WorkflowState {
	tddMode: TddMode;
	planFile?: string;
	tasks: PlanTask[];
	currentTaskIndex: number;
	reviewCycles: ReviewCycle[];
	cumulativeCostUsd: number;
}

// --- Custom entry types ---

const ENTRY_TYPE = "superteam-state";

interface StateEntry {
	version: 1;
	state: WorkflowState;
}

// --- Default state ---

function defaultState(): WorkflowState {
	return {
		tddMode: "off",
		planFile: undefined,
		tasks: [],
		currentTaskIndex: -1,
		reviewCycles: [],
		cumulativeCostUsd: 0,
	};
}

// --- Plan parsing (delegated to plan-parser.ts) ---

import {
	parseTaskBlock as _parseTaskBlock,
	parseTaskHeadings as _parseTaskHeadings,
	loadPlan as _loadPlan,
	type ParsedTask,
} from "./plan-parser.js";

/**
 * Parse tasks from a ```superteam-tasks fenced block.
 * @deprecated Import from './plan-parser.js' instead.
 */
export function parseTaskBlock(content: string): PlanTask[] | null {
	const parsed = _parseTaskBlock(content);
	if (!parsed) return null;
	return parsed.map(t => toPlanTask(t));
}

/**
 * Parse tasks from ### Task N: headings.
 * @deprecated Import from './plan-parser.js' instead.
 */
export function parseTaskHeadings(content: string): PlanTask[] {
	return _parseTaskHeadings(content).map(t => toPlanTask(t));
}

/**
 * Load and parse a plan file.
 * @deprecated Import from './plan-parser.js' instead.
 */
export function loadPlan(filePath: string): { tasks: PlanTask[]; source: "fenced" | "headings" | "empty" } {
	const result = _loadPlan(filePath);
	return { ...result, tasks: result.tasks.map(t => toPlanTask(t)) };
}

/** Convert ParsedTask (no status fields) to PlanTask (with status fields). */
function toPlanTask(t: ParsedTask): PlanTask {
	return {
		id: t.id,
		title: t.title,
		description: t.description,
		files: t.files,
		status: "pending",
		reviewsPassed: [],
		reviewsFailed: [],
		fixAttempts: 0,
	};
}

// --- State management ---

/** In-memory state cache (reconstructed from session on resume) */
let currentState: WorkflowState = defaultState();
let piRef: ExtensionAPI | null = null;

export function initState(pi: ExtensionAPI): void {
	piRef = pi;
	currentState = defaultState();
}

export function getState(): WorkflowState {
	return currentState;
}

/**
 * Update state and persist to session.
 */
export function updateState(updater: (state: WorkflowState) => void): void {
	updater(currentState);
	persist();
}

function persist(): void {
	if (!piRef) return;
	const entry: StateEntry = { version: 1, state: { ...currentState } };
	piRef.appendEntry(ENTRY_TYPE, entry);
}

/**
 * Reconstruct state from session branch entries.
 * Called on session_start to restore from persisted state.
 */
export function restoreFromBranch(ctx: ExtensionContext): void {
	const entries = ctx.sessionManager.getBranch();
	let lastState: WorkflowState | null = null;

	for (const entry of entries) {
		if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE) {
			const data = (entry as any).data as StateEntry | undefined;
			if (data?.version === 1 && data.state) {
				lastState = data.state;
			}
		}
	}

	if (lastState) {
		currentState = lastState;
	} else {
		currentState = defaultState();
	}
}

// --- Task operations ---

export function setTddMode(mode: TddMode): void {
	updateState((s) => { s.tddMode = mode; });
}

export function loadPlanIntoState(filePath: string): { count: number; source: string } {
	const { tasks, source } = loadPlan(filePath);
	updateState((s) => {
		s.planFile = filePath;
		s.tasks = tasks;
		s.currentTaskIndex = tasks.length > 0 ? 0 : -1;
	});
	return { count: tasks.length, source };
}

export function getCurrentTask(): PlanTask | null {
	if (currentState.currentTaskIndex < 0 || currentState.currentTaskIndex >= currentState.tasks.length) {
		return null;
	}
	return currentState.tasks[currentState.currentTaskIndex];
}

export function advanceTask(): PlanTask | null {
	const next = currentState.currentTaskIndex + 1;
	if (next >= currentState.tasks.length) return null;
	updateState((s) => { s.currentTaskIndex = next; });
	return currentState.tasks[next];
}

export function updateTaskStatus(taskId: number, status: TaskStatus): void {
	updateState((s) => {
		const task = s.tasks.find((t) => t.id === taskId);
		if (task) task.status = status;
	});
}

export function addReviewCycle(cycle: ReviewCycle): void {
	updateState((s) => {
		s.reviewCycles.push(cycle);
		const task = s.tasks.find((t) => t.id === cycle.taskId);
		if (task) {
			if (cycle.status === "passed") {
				if (!task.reviewsPassed.includes(cycle.reviewType)) {
					task.reviewsPassed.push(cycle.reviewType);
				}
				// Remove from failed if previously failed
				task.reviewsFailed = task.reviewsFailed.filter((r) => r !== cycle.reviewType);
			} else if (cycle.status === "failed") {
				if (!task.reviewsFailed.includes(cycle.reviewType)) {
					task.reviewsFailed.push(cycle.reviewType);
				}
			}
		}
	});
}

export function incrementFixAttempts(taskId: number): void {
	updateState((s) => {
		const task = s.tasks.find((t) => t.id === taskId);
		if (task) task.fixAttempts++;
	});
}

export function addCostToState(cost: number): void {
	updateState((s) => { s.cumulativeCostUsd += cost; });
}

// --- Widget rendering ---

/**
 * Build status widget lines for display.
 */
export function buildStatusLines(theme?: any): string[] {
	const state = currentState;
	if (state.tddMode === "off" && state.tasks.length === 0) return [];

	const lines: string[] = [];

	// TDD mode indicator
	if (state.tddMode !== "off") {
		const modeLabel = state.tddMode.toUpperCase();
		lines.push(`[${modeLabel}]`);
	}

	// Plan progress
	if (state.tasks.length > 0) {
		const current = getCurrentTask();
		const completedCount = state.tasks.filter((t) => t.status === "complete").length;

		if (current) {
			const taskNum = state.currentTaskIndex + 1;
			const total = state.tasks.length;
			const title = current.title.length > 40
				? `${current.title.slice(0, 37)}...`
				: current.title;

			// Build review status
			let reviewStr = "";
			if (current.reviewsPassed.length > 0 || current.reviewsFailed.length > 0) {
				const parts = [
					...current.reviewsPassed.map((r) => `${r} ✓`),
					...current.reviewsFailed.map((r) => `${r} ✗`),
				];
				reviewStr = ` (${parts.join(" ")})`;
			}

			const costStr = state.cumulativeCostUsd > 0
				? ` | $${state.cumulativeCostUsd.toFixed(2)}`
				: "";

			const prefix = state.tddMode !== "off" ? `[${state.tddMode.toUpperCase()}] ` : "";
			lines[0] = `${prefix}Task ${taskNum}/${total}: "${title}" — ${current.status}${reviewStr}${costStr}`;
		} else {
			lines[0] = `Plan: ${completedCount}/${state.tasks.length} complete`;
		}
	}

	return lines;
}

/**
 * Update the status widget in the TUI.
 */
export function updateWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	const lines = buildStatusLines(ctx.ui.theme);
	if (lines.length > 0) {
		ctx.ui.setWidget("superteam-status", lines);
	} else {
		ctx.ui.setWidget("superteam-status", undefined);
	}
}
