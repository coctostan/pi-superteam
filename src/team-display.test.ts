/**
 * Tests for /team display formatting — formatAgentLine helper
 */

import { describe, it, expect } from "vitest";
import type { SuperteamConfig } from "./config.ts";
import type { AgentProfile } from "./dispatch.ts";
import { formatAgentLine } from "./team-display.ts";

function makeConfig(overrides: Partial<SuperteamConfig> = {}): SuperteamConfig {
	return {
		configVersion: 1,
		tddMode: "off",
		testFilePatterns: [],
		acceptanceTestPatterns: [],
		testCommands: [],
		exemptPaths: [],
		testFileMapping: { strategies: [], overrides: {} },
		review: {
			maxIterations: 3,
			required: [],
			optional: [],
			parallelOptional: true,
			escalateOnMaxIterations: true,
		},
		agents: {
			defaultModel: "claude-sonnet-4-5",
			scoutModel: "claude-haiku-4-5",
			modelOverrides: {},
			thinkingOverrides: {},
		},
		costs: { warnAtUsd: 5.0, hardLimitUsd: 20.0 },
		...overrides,
	};
}

function makeAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		name: "test-agent",
		description: "A test agent",
		systemPrompt: "You are a test agent.",
		source: "package",
		filePath: "/fake/path.md",
		...overrides,
	};
}

describe("formatAgentLine", () => {
	it("shows agent name, source, description, and model from frontmatter", () => {
		const agent = makeAgent({ name: "myagent", description: "Does things", model: "custom-model", source: "package" });
		const config = makeConfig();
		const line = formatAgentLine(agent, config);
		expect(line).toBe("myagent [package] — Does things\n  model: custom-model, tools: (all)");
	});

	it("shows (override) annotation when model comes from config modelOverrides", () => {
		const agent = makeAgent({ name: "myagent", model: "agent-model" });
		const config = makeConfig({
			agents: {
				defaultModel: "default-model",
				scoutModel: "scout-model",
				modelOverrides: { myagent: "override-model" },
				thinkingOverrides: {},
			},
		});
		const line = formatAgentLine(agent, config);
		expect(line).toContain("model: override-model (override)");
	});

	it("shows (config default) annotation when falling back to config defaults", () => {
		const agent = makeAgent({ name: "implementer" });
		const config = makeConfig();
		const line = formatAgentLine(agent, config);
		expect(line).toContain("model: claude-sonnet-4-5 (config default)");
	});

	it("shows (config default) for scout using scoutModel", () => {
		const agent = makeAgent({ name: "scout" });
		const config = makeConfig();
		const line = formatAgentLine(agent, config);
		expect(line).toContain("model: claude-haiku-4-5 (config default)");
	});

	it("shows no annotation when model comes from agent frontmatter", () => {
		const agent = makeAgent({ name: "myagent", model: "agent-model" });
		const config = makeConfig();
		const line = formatAgentLine(agent, config);
		expect(line).toContain("model: agent-model,");
		expect(line).not.toContain("(override)");
		expect(line).not.toContain("(config default)");
	});

	it("shows tools list", () => {
		const agent = makeAgent({ tools: ["read", "write", "bash"] });
		const config = makeConfig();
		const line = formatAgentLine(agent, config);
		expect(line).toContain("tools: read, write, bash");
	});

	it("shows (all) when no tools specified", () => {
		const agent = makeAgent({});
		const config = makeConfig();
		const line = formatAgentLine(agent, config);
		expect(line).toContain("tools: (all)");
	});

	it("shows thinking level when resolved from agent frontmatter", () => {
		const agent = makeAgent({ name: "thinker", thinking: "high", model: "some-model" });
		const config = makeConfig();
		const line = formatAgentLine(agent, config);
		expect(line).toContain("thinking: high");
		expect(line).not.toContain("thinking: high (override)");
	});

	it("shows thinking with (override) when from config thinkingOverrides", () => {
		const agent = makeAgent({ name: "thinker", model: "some-model" });
		const config = makeConfig({
			agents: {
				defaultModel: "m",
				scoutModel: "s",
				modelOverrides: {},
				thinkingOverrides: { thinker: "xhigh" },
			},
		});
		const line = formatAgentLine(agent, config);
		expect(line).toContain("thinking: xhigh (override)");
	});

	it("does not show thinking when not resolved", () => {
		const agent = makeAgent({ name: "plain" });
		const config = makeConfig();
		const line = formatAgentLine(agent, config);
		expect(line).not.toContain("thinking");
	});

	it("formats full line with model override and thinking override", () => {
		const agent = makeAgent({ name: "architect", description: "Plans things", source: "project", tools: ["read", "grep"] });
		const config = makeConfig({
			agents: {
				defaultModel: "default",
				scoutModel: "scout",
				modelOverrides: { architect: "claude-opus" },
				thinkingOverrides: { architect: "xhigh" },
			},
		});
		const line = formatAgentLine(agent, config);
		expect(line).toBe(
			"architect [project] — Plans things\n  model: claude-opus (override), thinking: xhigh (override), tools: read, grep"
		);
	});
});
