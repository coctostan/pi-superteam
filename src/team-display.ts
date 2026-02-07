/**
 * Formatting helpers for /team command display.
 */

import type { AgentProfile } from "./dispatch.ts";
import type { SuperteamConfig } from "./config.ts";
import { resolveAgentModel, resolveAgentThinking } from "./dispatch.ts";

/**
 * Format a single agent line for /team display.
 * Shows model with source annotation and optional thinking level.
 */
export function formatAgentLine(agent: AgentProfile, config: SuperteamConfig): string {
	const model = resolveAgentModel(agent, config);
	const thinking = resolveAgentThinking(agent, config);
	const tools = agent.tools?.join(", ") || "(all)";

	// Determine model annotation
	let modelAnnotation = "";
	if (config.agents.modelOverrides[agent.name]) {
		modelAnnotation = " (override)";
	} else if (!agent.model) {
		modelAnnotation = " (config default)";
	}

	// Build the details line
	let details = `model: ${model}${modelAnnotation}`;

	if (thinking !== undefined) {
		const thinkingAnnotation = config.agents.thinkingOverrides[agent.name] ? " (override)" : "";
		details += `, thinking: ${thinking}${thinkingAnnotation}`;
	}

	details += `, tools: ${tools}`;

	return `${agent.name} [${agent.source}] — ${agent.description}\n  ${details}`;
}
