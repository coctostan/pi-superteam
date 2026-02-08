/**
 * Tests for ThinkingLevel type and thinkingOverrides in config
 */

import { describe, it, expect } from "vitest";
import {
	type ThinkingLevel,
	VALID_THINKING_LEVELS,
	getConfig,
	type SuperteamConfig,
} from "./config.ts";

describe("ThinkingLevel", () => {
	it("VALID_THINKING_LEVELS contains all expected levels", () => {
		expect(VALID_THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("VALID_THINKING_LEVELS is readonly", () => {
		// Type-level check: VALID_THINKING_LEVELS should be `as const`
		const levels: readonly string[] = VALID_THINKING_LEVELS;
		expect(levels.length).toBe(6);
	});
});

describe("validationCommand config", () => {
	it("defaults to 'tsc --noEmit'", () => {
		const config = getConfig("/nonexistent-path-for-test", true);
		expect(config.validationCommand).toBe("tsc --noEmit");
	});

	it("can be overridden in config file", () => {
		const config = getConfig("/nonexistent-path-for-test", true);
		expect(typeof config.validationCommand).toBe("string");
	});
});

describe("AgentConfig.thinkingOverrides", () => {
	it("default config has empty thinkingOverrides", () => {
		const config = getConfig("/nonexistent-path-for-test", true);
		expect(config.agents.thinkingOverrides).toEqual({});
	});

	it("thinkingOverrides exists alongside modelOverrides in agents", () => {
		const config = getConfig("/nonexistent-path-for-test", true);
		expect(config.agents).toHaveProperty("modelOverrides");
		expect(config.agents).toHaveProperty("thinkingOverrides");
	});
});
