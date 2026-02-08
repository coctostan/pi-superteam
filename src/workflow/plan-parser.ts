/**
 * Plan parser — extract tasks from plan files.
 *
 * Supports two formats:
 *   1. Fenced ```superteam-tasks YAML blocks (preferred)
 *   2. ### Task N: heading-based fallback
 *
 * Extracted from state.ts (Option B) — pure logic, no state dependencies.
 */

import * as fs from "node:fs";

// --- Types ---

export interface ParsedTask {
	id: number;
	title: string;
	description: string;
	files: string[];
}

// --- Fenced block parser ---

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
export function parseTaskBlock(content: string): ParsedTask[] | null {
	const lines = content.split("\n");
	const openRe = /^\s{0,3}```superteam-tasks\s*$/;
	const closeRe = /^\s{0,3}```\s*$/;

	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (openRe.test(lines[i])) {
			startIdx = i + 1;
			break;
		}
	}
	if (startIdx === -1) return null;

	let endIdx = -1;
	for (let i = startIdx; i < lines.length; i++) {
		if (closeRe.test(lines[i])) {
			endIdx = i;
			break;
		}
	}
	if (endIdx === -1) return null;

	const block = lines.slice(startIdx, endIdx).join("\n");
	return parseYamlLikeTasks(block);
}

// --- Heading-based parser ---

/**
 * Heuristic fallback: parse tasks from ### Task N: headings.
 */
export function parseTaskHeadings(content: string): ParsedTask[] {
	const tasks: ParsedTask[] = [];
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
		});
	}

	return tasks;
}

// --- File loader ---

/**
 * Load and parse a plan file. Tries fenced block first, falls back to headings.
 */
export function loadPlan(filePath: string): { tasks: ParsedTask[]; source: "fenced" | "headings" | "empty" } {
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

function parseYamlLikeTasks(block: string): ParsedTask[] {
	const tasks: ParsedTask[] = [];
	const lines = block.split("\n");
	let current: Partial<ParsedTask> | null = null;
	let id = 1;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		// New task item
		if (trimmed.startsWith("- title:")) {
			if (current?.title) {
				tasks.push(finalizeParsedTask(current, id++));
			}
			current = { title: trimmed.slice("- title:".length).trim() };
			i++;
			continue;
		}

		if (!current) {
			i++;
			continue;
		}

		if (trimmed.startsWith("description:")) {
			const rawValue = trimmed.slice("description:".length).trim();
			if (rawValue === "|") {
				// Block scalar mode
				const keyIndent = line.length - line.trimStart().length;
				const accumLines: string[] = [];
				i++;
				while (i < lines.length) {
					const nextLine = lines[i];
					const nextTrimmed = nextLine.trim();
					if (nextTrimmed.startsWith("- title:")) break;
					const nextIndent = nextLine.length - nextLine.trimStart().length;
					if (nextTrimmed.length > 0 && nextIndent <= keyIndent && nextTrimmed.startsWith("files:")) break;
					if (nextTrimmed.length > 0 && nextIndent <= keyIndent && /^[a-zA-Z_-]+:/.test(nextTrimmed)) break;
					accumLines.push(nextLine);
					i++;
				}
				const nonEmptyLines = accumLines.filter(l => l.trim().length > 0);
				let commonIndent = Infinity;
				for (const l of nonEmptyLines) {
					const indent = l.length - l.trimStart().length;
					if (indent < commonIndent) commonIndent = indent;
				}
				if (!isFinite(commonIndent)) commonIndent = 0;
				const dedented = accumLines.map(l => {
					if (l.trim().length === 0) return "";
					return l.slice(commonIndent);
				});
				while (dedented.length > 0 && dedented[dedented.length - 1].trim() === "") {
					dedented.pop();
				}
				current.description = dedented.join("\n");
			} else {
				current.description = rawValue;
				i++;
			}
			continue;
		}

		if (trimmed.startsWith("files:")) {
			const filesStr = trimmed.slice("files:".length).trim();
			current.files = parseInlineArray(filesStr);
			i++;
			continue;
		}

		i++;
	}

	if (current?.title) {
		tasks.push(finalizeParsedTask(current, id));
	}

	return tasks;
}

function finalizeParsedTask(partial: Partial<ParsedTask>, id: number): ParsedTask {
	return {
		id,
		title: partial.title || `Task ${id}`,
		description: partial.description || "",
		files: partial.files || [],
	};
}

function parseInlineArray(str: string): string[] {
	const cleaned = str.replace(/^\[/, "").replace(/\]$/, "");
	return cleaned
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function extractFileRefs(body: string): string[] {
	const files: string[] = [];
	const backtickRegex = /`([^`]+\.[a-zA-Z]+)`/g;
	let match: RegExpExecArray | null;
	while ((match = backtickRegex.exec(body)) !== null) {
		const candidate = match[1];
		if (candidate.includes("/") || candidate.includes(".")) {
			files.push(candidate);
		}
	}
	return [...new Set(files)];
}
