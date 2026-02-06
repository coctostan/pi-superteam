/**
 * Superteam — pi extension entry point.
 *
 * Thin composition root: registers tools, commands, shortcuts, events.
 * All business logic lives in dispatch, config, guard, rules, state modules.
 *
 * Task 1: team tool (single mode), /team command, agent discovery.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getConfig, getPackageDir } from "./config.js";
import {
	type AgentProfile,
	type DispatchDetails,
	type DispatchResult,
	discoverAgents,
	dispatchAgent,
	formatTokens,
	formatUsage,
	getFinalOutput,
} from "./dispatch.js";

export default function superteam(pi: ExtensionAPI) {
	// --- team tool ---

	const TeamParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to dispatch" })),
		task: Type.Optional(Type.String({ description: "Task description for the agent" })),
		// Parallel and chain modes added in Task 2
		includeProjectAgents: Type.Optional(
			Type.Boolean({
				description: "Include project-local agents from .pi/agents/. Default: false.",
				default: false,
			}),
		),
	});

	pi.registerTool({
		name: "team",
		label: "Team",
		description: [
			"Dispatch specialized agents with isolated context windows.",
			"Each agent runs in its own pi subprocess with specific model, tools, and system prompt.",
			"Available agents include: scout (fast reconnaissance), implementer (TDD implementation),",
			"and any user-defined agents in ~/.pi/agent/agents/.",
			"Use includeProjectAgents: true to also load agents from .pi/agents/ (requires trust).",
		].join(" "),
		parameters: TeamParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const includeProject = params.includeProjectAgents ?? false;
			const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, includeProject);

			const makeDetails = (results: DispatchResult[]): DispatchDetails => ({
				mode: "single",
				results,
			});

			// Validate: need agent + task
			if (!params.agent || !params.task) {
				const available =
					agents.map((a) => `  ${a.name} (${a.source}): ${a.description}`).join("\n") || "  (none found)";
				return {
					content: [
						{
							type: "text",
							text: `Provide agent and task.\n\nAvailable agents:\n${available}`,
						},
					],
					details: makeDetails([]),
				};
			}

			// Find the agent
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available =
					agents.map((a) => `  ${a.name} (${a.source}): ${a.description}`).join("\n") || "  (none found)";
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent: "${params.agent}"\n\nAvailable agents:\n${available}`,
						},
					],
					details: makeDetails([]),
					isError: true,
				};
			}

			// Trust confirmation for project agents
			if (agent.source === "project" && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Run project-local agent?",
					`Agent: ${agent.name}\nSource: ${agent.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "Cancelled: project agent not approved." }],
						details: makeDetails([]),
					};
				}
			}

			// No project agents in headless mode
			if (agent.source === "project" && !ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `Project agent "${agent.name}" not available in non-interactive mode.`,
						},
					],
					details: makeDetails([]),
					isError: true,
				};
			}

			// Dispatch
			const result = await dispatchAgent(
				agent,
				params.task,
				ctx.cwd,
				signal,
				onUpdate
					? (partial) => {
							onUpdate(partial);
						}
					: undefined,
			);

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			const output = getFinalOutput(result.messages);

			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || output || "(no output)";
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: makeDetails([result]),
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: output || "(no output)" }],
				details: makeDetails([result]),
			};
		},

		renderCall(args, theme) {
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text = theme.fg("toolTitle", theme.bold("team ")) + theme.fg("accent", agentName);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as DispatchDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const r = details.results[0];
			const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
			const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const output = getFinalOutput(r.messages);
			const usageStr = formatUsage(r.usage, r.model);

			let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
			if (isError && r.errorMessage) {
				text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
			} else if (output) {
				const preview = expanded ? output : output.split("\n").slice(0, 10).join("\n");
				text += `\n${theme.fg("toolOutput", preview)}`;
				if (!expanded && output.split("\n").length > 10) {
					text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
			} else {
				text += `\n${theme.fg("muted", "(no output)")}`;
			}
			if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
			return new Text(text, 0, 0);
		},
	});

	// --- /team command ---

	pi.registerCommand("team", {
		description: "List available agents and their status",
		async handler(args, ctx) {
			const includeProject = args.trim() === "--project" || args.trim() === "-p";
			const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, includeProject);

			if (agents.length === 0) {
				ctx.ui.notify("No agents found. Place .md files in ~/.pi/agent/agents/ or install a package with agents.", "info");
				return;
			}

			const lines = agents.map((a) => {
				const model = a.model || "(default)";
				const tools = a.tools?.join(", ") || "(all)";
				return `${a.name} [${a.source}] — ${a.description}\n  model: ${model}, tools: ${tools}`;
			});

			const header = `Available agents (${agents.length}):`;
			const projectNote = projectAgentsDir
				? `\nProject agents dir: ${projectAgentsDir}${!includeProject ? " (use --project to include)" : ""}`
				: "";

			ctx.ui.notify(`${header}\n\n${lines.join("\n\n")}${projectNote}`, "info");
		},
	});

	// --- Session start: log config ---

	pi.on("session_start", (_event, ctx) => {
		const config = getConfig(ctx.cwd);
		const packageDir = getPackageDir();
		// Log is informational only — no user-facing output needed for Task 1
	});
}
