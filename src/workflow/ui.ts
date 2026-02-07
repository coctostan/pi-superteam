/**
 * Workflow UI helpers — deterministic, reusable, testable formatting.
 */

import type { StreamEvent } from "../dispatch.js";

// Use a loose type for state to avoid circular dependency
interface UIState {
	phase: string;
	brainstorm?: { step: string };
	tasks: Array<{ id?: number; title?: string; status?: string }>;
	currentTaskIndex: number;
	totalCostUsd: number;
}

/**
 * Format a one-line status string for the workflow status bar.
 */
export function formatStatus(state: UIState): string {
	const parts: string[] = [`⚡ Workflow: ${state.phase}`];

	if (state.phase === "brainstorm" && state.brainstorm) {
		parts[0] += ` (${state.brainstorm.step})`;
	}

	if (state.phase === "execute" && state.tasks.length > 0) {
		parts.push(`task ${state.currentTaskIndex + 1}/${state.tasks.length}`);
	}

	parts.push(`$${state.totalCostUsd.toFixed(2)}`);

	return parts.join(" | ");
}

const MAX_ACTION_LENGTH = 120;

/**
 * Format a tool execution event as a human-readable string.
 */
export function formatToolAction(event: StreamEvent): string {
	const tool = event.toolName || "unknown";
	const args = event.args || {};

	switch (tool) {
		case "read":
			return `📖 read ${args.path || ""}`;
		case "write":
			return `✏️ write ${args.path || ""}`;
		case "edit":
			return `✏️ edit ${args.path || ""}`;
		case "bash": {
			const cmd = args.command || "";
			const truncated = cmd.length > MAX_ACTION_LENGTH
				? cmd.slice(0, MAX_ACTION_LENGTH - 3) + "..."
				: cmd;
			return `$ ${truncated}`;
		}
		case "grep":
			return `🔍 grep ${args.pattern || ""} ${args.path || ""}`.trim();
		case "find":
			return `🔍 find ${args.path || args.pattern || ""}`;
		case "ls":
			return `📂 ls ${args.path || ""}`;
		default:
			return `🔧 ${tool}`;
	}
}

interface TaskState {
	id?: number;
	title?: string;
	status?: string;
}

/**
 * Format task progress as widget lines with status markers.
 */
export function formatTaskProgress(tasks: TaskState[], currentIndex: number): string[] {
	return tasks.map((task, i) => {
		let marker: string;
		if (task.status === "complete") {
			marker = "✓";
		} else if (i === currentIndex && task.status === "implementing") {
			marker = "▸";
		} else if (task.status === "implementing") {
			marker = "▸";
		} else if (task.status === "skipped") {
			marker = "⊘";
		} else if (task.status === "failed") {
			marker = "✗";
		} else {
			marker = "○";
		}
		return `${marker} ${task.id ?? i + 1}. ${task.title || "Untitled"}`;
	});
}

/**
 * Create a ring buffer for activity lines.
 */
export function createActivityBuffer(maxLines: number) {
	const buffer: string[] = [];

	return {
		push(line: string) {
			buffer.push(line);
			if (buffer.length > maxLines) {
				buffer.shift();
			}
		},
		lines(): string[] {
			return [...buffer];
		},
		clear() {
			buffer.length = 0;
		},
	};
}
