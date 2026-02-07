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
	let lastError: BrainstormParseResult | null = null;

	// Try fenced block first
	const fenced = extractFencedBlock(rawOutput);
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

function extractFencedBlock(text: string): string | null {
	const lines = text.split("\n");
	const openPattern = /^\s{0,3}```superteam-brainstorm\s*$/;
	const closePattern = /^\s{0,3}```\s*$/;

	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (openPattern.test(lines[i])) {
			startIdx = i;
			break;
		}
	}
	if (startIdx === -1) return null;

	// Walk forward from the line after the opening fence, tracking quote state
	let inString = false;
	let escape = false;

	for (let i = startIdx + 1; i < lines.length; i++) {
		// Check for closing fence only when not inside a JSON string
		if (!inString && closePattern.test(lines[i])) {
			const content = lines.slice(startIdx + 1, i).join("\n");
			return content.trim();
		}

		// Scan characters on this line to update inString/escape state
		for (let j = 0; j < lines[i].length; j++) {
			const ch = lines[i][j];
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
			}
		}

		// The newline between this line and the next is a character in the stream.
		// If inString is true, the newline is inside a JSON string — treat it as content.
		// The escape flag should be cleared at line boundary (a backslash before a real newline
		// doesn't escape the newline in the same way). But we leave inString as-is.
		escape = false;
	}

	return null;
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

/**
 * Replace literal newline characters (0x0a) inside JSON string values
 * with the two-character escape sequence \\n so JSON.parse succeeds.
 */
export function sanitizeJsonNewlines(jsonStr: string): string {
	let result = "";
	let inString = false;
	let escape = false;

	for (let i = 0; i < jsonStr.length; i++) {
		const ch = jsonStr[i];

		if (escape) {
			escape = false;
			result += ch;
			continue;
		}

		if (ch === "\\") {
			escape = true;
			result += ch;
			continue;
		}

		if (ch === '"') {
			inString = !inString;
			result += ch;
			continue;
		}

		if (ch === "\n" && inString) {
			result += "\\n";
			continue;
		}

		result += ch;
	}

	return result;
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
