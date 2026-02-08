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

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
