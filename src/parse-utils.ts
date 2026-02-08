/**
 * Shared parsing utilities for extracting structured content from LLM output.
 */

/**
 * Extract content from a fenced code block with the given language tag.
 * Uses quote-aware scanning to handle triple-backticks inside JSON string values.
 */
export function extractFencedBlock(text: string, language: string): string | null {
	const lines = text.split("\n");
	const openPattern = new RegExp(`^\\s{0,3}\`\`\`${escapeRegExp(language)}\\s*$`);
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

		// Clear escape flag at line boundary
		escape = false;
	}

	return null;
}

/**
 * Extract the last top-level brace-delimited block from text.
 * Quote-aware: braces inside JSON string values are ignored.
 */
export function extractLastBraceBlock(text: string): string | null {
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

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
