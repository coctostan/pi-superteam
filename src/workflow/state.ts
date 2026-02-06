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

// --- Plan parsing ---

/**
 * Parse tasks from a ```superteam-tasks fenced block (YAML-like format).
 *
 * Expected format:
 * ```superteam-tasks
 * - title: Setup models
 *   description: Create data models for the application
 *   files: [src/models.ts, src/types.ts]
 * - title: Add validation
 *   description: Input validation layer
 *   files: [src/validation.ts]
 * ```
 */
export function parseTaskBlock(content: string): PlanTask[] | null {
	const fenceRegex = /```superteam-tasks\s*\n([\s\S]*?)```/;
	const match = content.match(fenceRegex);
	if (!match) return null;

	const block = match[1];
	return parseYamlLikeTasks(block);
}

/**
 * Heuristic fallback: parse tasks from ### Task N: headings.
 */
export function parseTaskHeadings(content: string): PlanTask[] {
	const tasks: PlanTask[] = [];
	const headingRegex = /^###\s+Task\s+(\d+):\s*(.+)$/gm;

	let match: RegExpExecArray | null;
	const headingPositions: { id: number; title: string; start: number }[] = [];

	while ((match = headingRegex.exec(content)) !== null) {
		headingPositions.push({
			id: parseInt(match[1], 10),
			title: match[2].trim(),
			start: match.index + match[0].length,
		});
	}

	for (let i = 0; i < headingPositions.length; i++) {
		const h = headingPositions[i];
		const end = i + 1 < headingPositions.length
			? headingPositions[i + 1].start - headingPositions[i + 1].title.length - 15 // approximate heading start
			: content.length;
		const body = content.slice(h.start, end).trim();

		// Extract file references from the body
		const files = extractFileRefs(body);

		tasks.push({
			id: h.id,
			title: h.title,
			description: body.split("\n").slice(0, 3).join("\n").trim(),
			files,
			status: "pending",
			reviewsPassed: [],
			reviewsFailed: [],
			fixAttempts: 0,
		});
	}

	return tasks;
}

/**
 * Load and parse a plan file. Tries fenced block first, falls back to headings.
 */
export function loadPlan(filePath: string): { tasks: PlanTask[]; source: "fenced" | "headings" | "empty" } {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return { tasks: [], source: "empty" };
	}

	const fenced = parseTaskBlock(content);
	if (fenced && fenced.length > 0) {
		return { tasks: fenced, source: "fenced" };
	}

	const headings = parseTaskHeadings(content);
	if (headings.length > 0) {
		return { tasks: headings, source: "headings" };
	}

	return { tasks: [], source: "empty" };
}

// --- YAML-like parser (minimal, no dependency) ---

function parseYamlLikeTasks(block: string): PlanTask[] {
	const tasks: PlanTask[] = [];
	const lines = block.split("\n");
	let current: Partial<PlanTask> | null = null;
	let id = 1;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// New task item
		if (trimmed.startsWith("- title:")) {
			if (current?.title) {
				tasks.push(finalizePlanTask(current, id++));
			}
			current = { title: trimmed.slice("- title:".length).trim() };
			continue;
		}

		if (!current) continue;

		if (trimmed.startsWith("description:")) {
			current.description = trimmed.slice("description:".length).trim();
		} else if (trimmed.startsWith("files:")) {
			const filesStr = trimmed.slice("files:".length).trim();
			current.files = parseInlineArray(filesStr);
		}
	}

	if (current?.title) {
		tasks.push(finalizePlanTask(current, id));
	}

	return tasks;
}

function finalizePlanTask(partial: Partial<PlanTask>, id: number): PlanTask {
	return {
		id,
		title: partial.title || `Task ${id}`,
		description: partial.description || "",
		files: partial.files || [],
		status: "pending",
		reviewsPassed: [],
		reviewsFailed: [],
		fixAttempts: 0,
	};
}

function parseInlineArray(str: string): string[] {
	// [a, b, c] or a, b, c
	const cleaned = str.replace(/^\[/, "").replace(/\]$/, "");
	return cleaned
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function extractFileRefs(body: string): string[] {
	const files: string[] = [];
	// Match backtick-wrapped file paths
	const backtickRegex = /`([^`]+\.[a-zA-Z]+)`/g;
	let match: RegExpExecArray | null;
	while ((match = backtickRegex.exec(body)) !== null) {
		const candidate = match[1];
		// Simple heuristic: looks like a file path
		if (candidate.includes("/") || candidate.includes(".")) {
			files.push(candidate);
		}
	}
	return [...new Set(files)];
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
