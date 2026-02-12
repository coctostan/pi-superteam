/**
 * Brainstorm output parser — extract and validate structured brainstormer JSON output.
 *
 * Supports three response types: questions, approaches, design.
 * Parsing failures return errors, never throw. Never guess.
 */

import {
	extractFencedBlock as extractFencedBlockGeneric,
	extractLastBraceBlock,
	sanitizeJsonNewlines,
} from "../parse-utils.js";

// Re-export sanitizeJsonNewlines for backward compatibility
export { sanitizeJsonNewlines } from "../parse-utils.js";

// --- Types ---

export interface BrainstormQuestion {
	id: string;
	text: string;
	type: "choice" | "input";
	options?: string[];
	answer?: string;
}

export interface BrainstormApproach {
	id: string;
	title: string;
	summary: string;
	tradeoffs: string;
	taskEstimate: number;
}

export interface DesignSection {
	id: string;
	title: string;
	content: string;
}

export interface QuestionsPayload {
	type: "questions";
	questions: BrainstormQuestion[];
}

export interface ApproachesPayload {
	type: "approaches";
	approaches: BrainstormApproach[];
	recommendation?: string;
	reasoning?: string;
}

export interface DesignPayload {
	type: "design";
	sections: DesignSection[];
}

export interface TriageBatch {
	title: string;
	description: string;
}

export interface TriageSplit {
	title: string;
	description: string;
}

export interface TriagePayload {
	type: "triage";
	level: "straightforward" | "exploration" | "complex";
	reasoning: string;
	suggestedSkips?: string[];
	batches?: TriageBatch[];
	splits?: TriageSplit[];
}

export type BrainstormPayload = QuestionsPayload | ApproachesPayload | DesignPayload | TriagePayload;

export type BrainstormParseResult =
	| { status: "ok"; data: BrainstormPayload }
	| { status: "error"; rawOutput: string; parseError: string };

// --- Extraction ---

/**
 * Extract structured brainstorm JSON from brainstormer output text.
 *
 * Strategy:
 * 1. Look for ```superteam-brainstorm fenced block (preferred)
 * 2. Fallback: last {...} brace-matched block
 * 3. If neither: error
 */
export function parseBrainstormOutput(rawOutput: string): BrainstormParseResult {
	let lastError: BrainstormParseResult | null = null;

	// Try fenced block first
	const fenced = extractFencedBlockGeneric(rawOutput, "superteam-brainstorm");
	if (fenced) {
		const sanitized = sanitizeJsonNewlines(fenced);
		const result = parseAndValidate(sanitized, rawOutput);
		if (result.status === "ok") return result;
		lastError = result;

		// Fallback: brace-match on the fenced region
		const braceFromFenced = extractLastBraceBlock(fenced);
		if (braceFromFenced) {
			const sanitized2 = sanitizeJsonNewlines(braceFromFenced);
			const result2 = parseAndValidate(sanitized2, rawOutput);
			if (result2.status === "ok") return result2;
			lastError = result2;
		}
	}

	// Fallback: brace-match on full output (strip fenced block if present to avoid unmatched braces)
	const textForBraceMatch = fenced
		? rawOutput.replace(/```superteam-brainstorm[\s\S]*?\n```/, "")
		: rawOutput;
	const braceFromFull = extractLastBraceBlock(textForBraceMatch);
	if (braceFromFull) {
		const sanitized3 = sanitizeJsonNewlines(braceFromFull);
		const result3 = parseAndValidate(sanitized3, rawOutput);
		if (result3.status === "ok") return result3;
		lastError = result3;
	}

	return lastError ?? {
		status: "error",
		rawOutput,
		parseError: "No ```superteam-brainstorm block or JSON object found in brainstormer output",
	};
}

const VALID_TYPES = ["triage", "questions", "approaches", "design"];

function parseAndValidate(jsonStr: string, rawOutput: string): BrainstormParseResult {
	let parsed: any;
	try {
		parsed = JSON.parse(jsonStr);
	} catch (e: any) {
		return {
			status: "error",
			rawOutput,
			parseError: `JSON parse error: ${e.message}`,
		};
	}

	if (typeof parsed !== "object" || parsed === null) {
		return {
			status: "error",
			rawOutput,
			parseError: "Parsed JSON is not an object",
		};
	}

	if (!parsed.type || !VALID_TYPES.includes(parsed.type)) {
		return {
			status: "error",
			rawOutput,
			parseError: `Missing or invalid 'type' field. Expected one of: ${VALID_TYPES.join(", ")}`,
		};
	}

	switch (parsed.type) {
		case "triage":
			return validateTriage(parsed, rawOutput);
		case "questions":
			return validateQuestions(parsed, rawOutput);
		case "approaches":
			return validateApproaches(parsed, rawOutput);
		case "design":
			return validateDesign(parsed, rawOutput);
		default:
			return { status: "error", rawOutput, parseError: `Unknown type: ${parsed.type}` };
	}
}

const VALID_TRIAGE_LEVELS = ["straightforward", "exploration", "complex"];

function validateTriage(parsed: any, rawOutput: string): BrainstormParseResult {
	const level = VALID_TRIAGE_LEVELS.includes(parsed.level) ? parsed.level : "exploration";
	const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";

	const suggestedSkips = Array.isArray(parsed.suggestedSkips)
		? parsed.suggestedSkips.filter((s: unknown) => typeof s === "string")
		: undefined;

	const batches = Array.isArray(parsed.batches)
		? parsed.batches.map((b: any) => ({
				title: typeof b.title === "string" ? b.title : "",
				description: typeof b.description === "string" ? b.description : "",
			}))
		: undefined;

	const splits = Array.isArray(parsed.splits)
		? parsed.splits.map((s: any) => ({
				title: typeof s.title === "string" ? s.title : "",
				description: typeof s.description === "string" ? s.description : "",
			}))
		: undefined;

	return {
		status: "ok",
		data: { type: "triage", level, reasoning, suggestedSkips, batches, splits },
	};
}

function validateQuestions(parsed: any, rawOutput: string): BrainstormParseResult {
	if (!Array.isArray(parsed.questions)) {
		parsed.questions = [];
	}

	const questions: BrainstormQuestion[] = parsed.questions.map((q: any, i: number) => ({
		id: typeof q.id === "string" ? q.id : `q${i + 1}`,
		text: typeof q.text === "string" ? q.text : "",
		type: q.type === "choice" ? "choice" : "input",
		options: Array.isArray(q.options) ? q.options.filter((o: unknown) => typeof o === "string") : undefined,
		answer: typeof q.answer === "string" ? q.answer : undefined,
	}));

	return { status: "ok", data: { type: "questions", questions } };
}

function validateApproaches(parsed: any, rawOutput: string): BrainstormParseResult {
	if (!Array.isArray(parsed.approaches)) {
		parsed.approaches = [];
	}

	const approaches: BrainstormApproach[] = parsed.approaches.map((a: any, i: number) => ({
		id: typeof a.id === "string" ? a.id : `a${i + 1}`,
		title: typeof a.title === "string" ? a.title : "",
		summary: typeof a.summary === "string" ? a.summary : "",
		tradeoffs: typeof a.tradeoffs === "string" ? a.tradeoffs : "",
		taskEstimate: typeof a.taskEstimate === "number" ? a.taskEstimate : 0,
	}));

	return {
		status: "ok",
		data: {
			type: "approaches",
			approaches,
			recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : undefined,
			reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
		},
	};
}

function validateDesign(parsed: any, rawOutput: string): BrainstormParseResult {
	if (!Array.isArray(parsed.sections)) {
		parsed.sections = [];
	}

	const sections: DesignSection[] = parsed.sections.map((s: any, i: number) => ({
		id: typeof s.id === "string" ? s.id : `s${i + 1}`,
		title: typeof s.title === "string" ? s.title : "",
		content: typeof s.content === "string" ? s.content : "",
	}));

	return { status: "ok", data: { type: "design", sections } };
}
