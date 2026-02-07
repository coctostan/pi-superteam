/**
 * Brainstorm output parser — extract and validate structured brainstormer JSON output.
 *
 * Supports three response types: questions, approaches, design.
 * Parsing failures return errors, never throw. Never guess.
 */

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

export type BrainstormPayload = QuestionsPayload | ApproachesPayload | DesignPayload;

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
	// Try fenced block first
	const fenced = extractFencedBlock(rawOutput);
	if (fenced) {
		return parseAndValidate(fenced, rawOutput);
	}

	// Fallback: last brace-matched block
	const braceMatch = extractLastBraceBlock(rawOutput);
	if (braceMatch) {
		return parseAndValidate(braceMatch, rawOutput);
	}

	return {
		status: "error",
		rawOutput,
		parseError: "No ```superteam-brainstorm block or JSON object found in brainstormer output",
	};
}

function extractFencedBlock(text: string): string | null {
	const regex = /```superteam-brainstorm\s*\n([\s\S]*?)```/;
	const match = text.match(regex);
	return match ? match[1].trim() : null;
}

function extractLastBraceBlock(text: string): string | null {
	let depth = 0;
	let lastStart = -1;
	let lastEnd = -1;
	let inString = false;
	let escape = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;

		if (ch === "{") {
			if (depth === 0) lastStart = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && lastStart >= 0) {
				lastEnd = i;
			}
		}
	}

	if (lastStart >= 0 && lastEnd > lastStart) {
		return text.slice(lastStart, lastEnd + 1);
	}
	return null;
}

const VALID_TYPES = ["questions", "approaches", "design"];

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
