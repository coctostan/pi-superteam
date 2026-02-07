/**
 * Tests for dispatch.ts: AgentProfile thinking field, resolution helpers,
 * and frontmatter parsing with thinking validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SuperteamConfig } from "./config.ts";
import type { ThinkingLevel } from "./config.ts";

// We'll import the functions under test
import {
	resolveAgentModel,
	resolveAgentThinking,
	discoverAgents,
	type AgentProfile,
} from "./dispatch.ts";

// Helper to create a minimal config for testing
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

// --- resolveAgentModel ---

describe("resolveAgentModel", () => {
	it("returns config modelOverride when present", () => {
		const agent = makeAgent({ name: "myagent", model: "agent-model" });
		const config = makeConfig({
			agents: {
				defaultModel: "default-model",
				scoutModel: "scout-model",
				modelOverrides: { myagent: "override-model" },
				thinkingOverrides: {},
			},
		});
		expect(resolveAgentModel(agent, config)).toBe("override-model");
	});

	it("returns agent.model when no config override", () => {
		const agent = makeAgent({ name: "myagent", model: "agent-model" });
		const config = makeConfig();
		expect(resolveAgentModel(agent, config)).toBe("agent-model");
	});

	it("returns scoutModel for scout agent when no override or agent model", () => {
		const agent = makeAgent({ name: "scout" });
		const config = makeConfig();
		expect(resolveAgentModel(agent, config)).toBe("claude-haiku-4-5");
	});

	it("returns defaultModel for non-scout agent when no override or agent model", () => {
		const agent = makeAgent({ name: "implementer" });
		const config = makeConfig();
		expect(resolveAgentModel(agent, config)).toBe("claude-sonnet-4-5");
	});

	it("prefers config override over agent model for scout", () => {
		const agent = makeAgent({ name: "scout", model: "agent-model" });
		const config = makeConfig({
			agents: {
				defaultModel: "default-model",
				scoutModel: "scout-model",
				modelOverrides: { scout: "override-model" },
				thinkingOverrides: {},
			},
		});
		expect(resolveAgentModel(agent, config)).toBe("override-model");
	});
});

// --- resolveAgentThinking ---

describe("resolveAgentThinking", () => {
	it("returns config thinkingOverride when present", () => {
		const agent = makeAgent({ name: "myagent", thinking: "low" });
		const config = makeConfig({
			agents: {
				defaultModel: "m",
				scoutModel: "s",
				modelOverrides: {},
				thinkingOverrides: { myagent: "high" },
			},
		});
		expect(resolveAgentThinking(agent, config)).toBe("high");
	});

	it("returns agent.thinking when no config override", () => {
		const agent = makeAgent({ name: "myagent", thinking: "medium" });
		const config = makeConfig();
		expect(resolveAgentThinking(agent, config)).toBe("medium");
	});

	it("returns undefined when no override and no agent thinking", () => {
		const agent = makeAgent({ name: "myagent" });
		const config = makeConfig();
		expect(resolveAgentThinking(agent, config)).toBeUndefined();
	});

	it("prefers config override over agent thinking", () => {
		const agent = makeAgent({ name: "myagent", thinking: "low" });
		const config = makeConfig({
			agents: {
				defaultModel: "m",
				scoutModel: "s",
				modelOverrides: {},
				thinkingOverrides: { myagent: "xhigh" },
			},
		});
		expect(resolveAgentThinking(agent, config)).toBe("xhigh");
	});
});

// --- AgentProfile thinking field in frontmatter parsing ---

describe("loadAgentsFromDir thinking parsing", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "superteam-test-agents-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeAgentFile(name: string, frontmatter: Record<string, string>, body = "System prompt.") {
		const fm = Object.entries(frontmatter)
			.map(([k, v]) => `${k}: ${v}`)
			.join("\n");
		const content = `---\n${fm}\n---\n${body}`;
		fs.writeFileSync(path.join(tmpDir, `${name}.md`), content);
	}

	it("parses valid thinking level from frontmatter", () => {
		writeAgentFile("thinker", { name: "thinker", description: "A thinker", thinking: "high" });
		// Use discoverAgents indirectly — we need to test loadAgentsFromDir
		// Since loadAgentsFromDir is not exported, we test through discoverAgents
		// by creating agents in a project dir structure
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "superteam-test-project-"));
		const piAgentsDir = path.join(projectDir, ".pi", "agents");
		fs.mkdirSync(piAgentsDir, { recursive: true });
		writeAgentFileAt(piAgentsDir, "thinker", { name: "thinker", description: "A thinker", thinking: "high" });

		const { agents } = discoverAgents(projectDir, true);
		const thinker = agents.find((a) => a.name === "thinker");
		expect(thinker).toBeDefined();
		expect(thinker!.thinking).toBe("high");

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it("ignores invalid thinking level from frontmatter", () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "superteam-test-project-"));
		const piAgentsDir = path.join(projectDir, ".pi", "agents");
		fs.mkdirSync(piAgentsDir, { recursive: true });
		writeAgentFileAt(piAgentsDir, "badthinker", { name: "badthinker", description: "Bad thinker", thinking: "invalid-level" });

		const { agents } = discoverAgents(projectDir, true);
		const agent = agents.find((a) => a.name === "badthinker");
		expect(agent).toBeDefined();
		expect(agent!.thinking).toBeUndefined();

		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	it("handles missing thinking field gracefully", () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "superteam-test-project-"));
		const piAgentsDir = path.join(projectDir, ".pi", "agents");
		fs.mkdirSync(piAgentsDir, { recursive: true });
		writeAgentFileAt(piAgentsDir, "nothinker", { name: "nothinker", description: "No thinking" });

		const { agents } = discoverAgents(projectDir, true);
		const agent = agents.find((a) => a.name === "nothinker");
		expect(agent).toBeDefined();
		expect(agent!.thinking).toBeUndefined();

		fs.rmSync(projectDir, { recursive: true, force: true });
	});
});

function writeAgentFileAt(dir: string, name: string, frontmatter: Record<string, string>, body = "System prompt.") {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	const content = `---\n${fm}\n---\n${body}`;
	fs.writeFileSync(path.join(dir, `${name}.md`), content);
}
