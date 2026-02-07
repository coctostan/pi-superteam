/**
 * Superteam — pi extension entry point.
 *
 * Thin composition root: registers tools, commands, shortcuts, events.
 * All business logic lives in dispatch, config, guard, rules, state modules.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getConfig, getPackageDir } from "./config.js";
import { formatAgentLine } from "./team-display.js";
import {
	type AgentProfile,
	type DispatchDetails,
	type DispatchResult,
	aggregateUsage,
	checkCostBudget,
	discoverAgents,
	dispatchAgent,
	dispatchChain,
	dispatchParallel,
	formatTokens,
	formatUsage,
	getFinalOutput,
	getSessionCost,
	resetSessionCost,
} from "./dispatch.js";
import {
	type TddMode,
	buildStatusLines,
	getState,
	initState,
	loadPlanIntoState,
	restoreFromBranch,
	setTddMode,
	updateWidget,
} from "./workflow/state.js";
import {
	handleContext as handleRuleContext,
	loadRules,
	resetRuleStates,
} from "./rules/engine.js";
import {
	consumeAtddWarning,
	grantBashWriteAllowance,
	handleToolCall,
	handleToolResult,
	handleUserBash,
	resetTddState,
	restoreTddState,
	serializeTddState,
} from "./workflow/tdd-guard.js";
import { runOrchestrator, runWorkflowLoop } from "./workflow/orchestrator.js";
import { loadState as loadWorkflowState, clearState as clearWorkflowState, createInitialState, saveState as saveWorkflowState } from "./workflow/orchestrator-state.js";

export default function superteam(pi: ExtensionAPI) {
	// --- team tool ---

	const TaskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
	});

	const ChainItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	});

	const TeamParams = Type.Object({
		// Single mode
		agent: Type.Optional(Type.String({ description: "Name of the agent to dispatch (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task description (single mode)" })),
		// Parallel mode
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
		// Chain mode
		chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution. Use {previous} in task to reference prior output." })),
		// Options
		includeProjectAgents: Type.Optional(
			Type.Boolean({
				description: "Include project-local agents from .pi/agents/. Default: false.",
				default: false,
			}),
		),
		overrideCostLimit: Type.Optional(
			Type.Boolean({
				description: "Override hard cost limit for this dispatch. Default: false.",
				default: false,
			}),
		),
	});

	pi.registerTool({
		name: "team",
		label: "Team",
		description: [
			"Dispatch specialized agents with isolated context windows.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Each agent runs in its own pi subprocess with specific model, tools, and system prompt.",
			"Available agents include: scout (fast recon), implementer (TDD implementation),",
			"and any user-defined agents in ~/.pi/agent/agents/.",
		].join(" "),
		parameters: TeamParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const includeProject = params.includeProjectAgents ?? false;
			const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, includeProject);

			// Determine mode
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				const available =
					agents.map((a) => `  ${a.name} (${a.source}): ${a.description}`).join("\n") || "  (none found)";
				return {
					content: [{
						type: "text",
						text: `Provide exactly one mode: single (agent+task), parallel (tasks), or chain.\n\nAvailable agents:\n${available}`,
					}],
					details: { mode: "single", results: [] } as DispatchDetails,
				};
			}

			// Cost check (unless overridden)
			if (!params.overrideCostLimit) {
				const costCheck = checkCostBudget(ctx.cwd);
				if (!costCheck.allowed) {
					return {
						content: [{ type: "text", text: costCheck.warning! }],
						details: { mode: "single", results: [] } as DispatchDetails,
						isError: true,
					};
				}
				if (costCheck.warning && ctx.hasUI) {
					ctx.ui.notify(costCheck.warning, "warning");
				}
			}

			// Resolve agent by name, with error handling
			const resolveAgent = (name: string): AgentProfile | string => {
				const agent = agents.find((a) => a.name === name);
				if (!agent) {
					const available = agents.map((a) => a.name).join(", ") || "none";
					return `Unknown agent: "${name}". Available: ${available}`;
				}
				if (agent.source === "project" && !ctx.hasUI) {
					return `Project agent "${name}" not available in non-interactive mode.`;
				}
				return agent;
			};

			// Trust confirmation for project agents
			const confirmProjectAgents = async (agentNames: string[]): Promise<string | null> => {
				if (!ctx.hasUI) return null;
				const projectNames = agentNames
					.map((n) => agents.find((a) => a.name === n))
					.filter((a): a is AgentProfile => a?.source === "project")
					.map((a) => a.name);
				if (projectNames.length === 0) return null;

				const ok = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${projectNames.join(", ")}\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				return ok ? null : "Cancelled: project agents not approved.";
			};

			// --- CHAIN MODE ---
			if (params.chain && params.chain.length > 0) {
				const chainAgents: AgentProfile[] = [];
				const chainTasks: string[] = [];

				for (const step of params.chain) {
					const resolved = resolveAgent(step.agent);
					if (typeof resolved === "string") {
						return {
							content: [{ type: "text", text: resolved }],
							details: { mode: "chain", results: [] } as DispatchDetails,
							isError: true,
						};
					}
					chainAgents.push(resolved);
					chainTasks.push(step.task);
				}

				const cancelMsg = await confirmProjectAgents(params.chain.map((s) => s.agent));
				if (cancelMsg) {
					return {
						content: [{ type: "text", text: cancelMsg }],
						details: { mode: "chain", results: [] } as DispatchDetails,
					};
				}

				const results = await dispatchChain(chainAgents, chainTasks, ctx.cwd, signal, onUpdate);
				const lastResult = results[results.length - 1];
				const output = lastResult ? getFinalOutput(lastResult.messages) : "(no output)";
				const successCount = results.filter((r) => r.exitCode === 0).length;
				const totalUsage = aggregateUsage(results);

				const isError = successCount < results.length;
				const summary = isError
					? `Chain stopped at step ${results.length}/${params.chain.length}: ${lastResult?.errorMessage || "error"}`
					: output;

				return {
					content: [{ type: "text", text: summary || "(no output)" }],
					details: { mode: "chain", results } as DispatchDetails,
					isError,
				};
			}

			// --- PARALLEL MODE ---
			if (params.tasks && params.tasks.length > 0) {
				const parallelAgents: AgentProfile[] = [];
				const parallelTasks: string[] = [];

				for (const t of params.tasks) {
					const resolved = resolveAgent(t.agent);
					if (typeof resolved === "string") {
						return {
							content: [{ type: "text", text: resolved }],
							details: { mode: "parallel", results: [] } as DispatchDetails,
							isError: true,
						};
					}
					parallelAgents.push(resolved);
					parallelTasks.push(t.task);
				}

				const cancelMsg = await confirmProjectAgents(params.tasks.map((t) => t.agent));
				if (cancelMsg) {
					return {
						content: [{ type: "text", text: cancelMsg }],
						details: { mode: "parallel", results: [] } as DispatchDetails,
					};
				}

				try {
					const results = await dispatchParallel(parallelAgents, parallelTasks, ctx.cwd, signal, onUpdate);
					const successCount = results.filter((r) => r.exitCode === 0).length;
					const totalUsage = aggregateUsage(results);

					const summaries = results.map((r) => {
						const output = getFinalOutput(r.messages);
						const preview = output.slice(0, 200) + (output.length > 200 ? "..." : "");
						return `[${r.agent}] ${r.exitCode === 0 ? "✓" : "✗"}: ${preview || "(no output)"}`;
					});

					return {
						content: [{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						}],
						details: { mode: "parallel", results } as DispatchDetails,
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `Parallel dispatch error: ${e.message}` }],
						details: { mode: "parallel", results: [] } as DispatchDetails,
						isError: true,
					};
				}
			}

			// --- SINGLE MODE ---
			if (params.agent && params.task) {
				const resolved = resolveAgent(params.agent);
				if (typeof resolved === "string") {
					return {
						content: [{ type: "text", text: resolved }],
						details: { mode: "single", results: [] } as DispatchDetails,
						isError: true,
					};
				}

				if (resolved.source === "project" && ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Run project-local agent?",
						`Agent: ${resolved.name}\nSource: ${resolved.filePath}\nProject agents are repo-controlled.`,
					);
					if (!ok) {
						return {
							content: [{ type: "text", text: "Cancelled: project agent not approved." }],
							details: { mode: "single", results: [] } as DispatchDetails,
						};
					}
				}

				const result = await dispatchAgent(resolved, params.task, ctx.cwd, signal,
					onUpdate ? (partial) => onUpdate(partial) : undefined,
				);

				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				const output = getFinalOutput(result.messages);

				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || output || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: { mode: "single", results: [result] } as DispatchDetails,
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: output || "(no output)" }],
					details: { mode: "single", results: [result] } as DispatchDetails,
				};
			}

			// Should not reach here
			return {
				content: [{ type: "text", text: "Invalid parameters." }],
				details: { mode: "single", results: [] } as DispatchDetails,
			};
		},

		renderCall(args, theme) {
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("team ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("team ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

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

			// --- Single mode ---
			if (details.mode === "single" && details.results.length === 1) {
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
					if (!expanded && output.split("\n").length > 10) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				} else {
					text += `\n${theme.fg("muted", "(no output)")}`;
				}
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			// --- Chain mode ---
			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`,
						0, 0,
					));

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const output = getFinalOutput(r.messages);
						container.addChild(new Spacer(1));
						container.addChild(new Text(
							`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`,
							0, 0,
						));
						if (output) {
							container.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
						}
						const stepUsage = formatUsage(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const totalUsage = formatUsage(aggregateUsage(details.results));
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				// Collapsed chain
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`;
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const output = getFinalOutput(r.messages);
					const preview = output ? output.split("\n").slice(0, 3).join("\n") : "(no output)";
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					text += `\n${theme.fg("toolOutput", preview)}`;
				}
				const totalUsage = formatUsage(aggregateUsage(details.results));
				if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// --- Parallel mode ---
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
						0, 0,
					));

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const output = getFinalOutput(r.messages);
						container.addChild(new Spacer(1));
						container.addChild(new Text(
							`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`,
							0, 0,
						));
						if (output) container.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
						const taskUsage = formatUsage(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const totalUsage = formatUsage(aggregateUsage(details.results));
					if (totalUsage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
					}
					return container;
				}

				// Collapsed parallel
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = r.exitCode === -1
						? theme.fg("warning", "⏳")
						: r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const output = getFinalOutput(r.messages);
					const preview = r.exitCode === -1
						? "(running...)"
						: output ? output.split("\n").slice(0, 3).join("\n") : "(no output)";
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					text += `\n${theme.fg("toolOutput", preview)}`;
				}
				if (!isRunning) {
					const totalUsage = formatUsage(aggregateUsage(details.results));
					if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// --- /team command ---

	pi.registerCommand("team", {
		description: "List available agents, show session cost",
		async handler(args, ctx) {
			const includeProject = args.trim() === "--project" || args.trim() === "-p";
			const { agents, projectAgentsDir } = discoverAgents(ctx.cwd, includeProject);

			if (agents.length === 0) {
				ctx.ui.notify("No agents found. Place .md files in ~/.pi/agent/agents/ or install a package with agents.", "info");
				return;
			}

			const config = getConfig(ctx.cwd);
			const lines = agents.map((a) => formatAgentLine(a, config));

			const cost = getSessionCost();
			const costLine = `\nSession cost: $${cost.toFixed(4)} / $${config.costs.hardLimitUsd.toFixed(2)} limit`;

			ctx.ui.notify(`Available agents (${agents.length}):\n\n${lines.join("\n\n")}${costLine}`, "info");
		},
	});

	// --- /sdd command (plan management) ---

	pi.registerCommand("sdd", {
		description: "SDD workflow. Usage: /sdd load <file> | /sdd run | /sdd status | /sdd next | /sdd reset",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "status";

			switch (sub) {
				case "load": {
					const filePath = parts.slice(1).join(" ").trim();
					if (!filePath) {
						ctx.ui.notify("Usage: /sdd load <plan-file.md>", "warning");
						return;
					}
					const { count, source } = loadPlanIntoState(filePath);
					if (count === 0) {
						ctx.ui.notify(`No tasks found in ${filePath}. Use \`\`\`superteam-tasks block or ### Task N: headings.`, "warning");
					} else {
						ctx.ui.notify(`Loaded ${count} tasks from ${filePath} (${source} parser)`, "info");
					}
					updateWidget(ctx);
					return;
				}

				case "status": {
					const state = getState();
					const lines = buildStatusLines();
					if (lines.length === 0) {
						ctx.ui.notify("No active workflow. Use /sdd load <file> to load a plan.", "info");
						return;
					}
					const taskLines = state.tasks.map((t, i) => {
						const marker = i === state.currentTaskIndex ? "→" : t.status === "complete" ? "✓" : " ";
						return `${marker} ${t.id}. ${t.title} [${t.status}]`;
					});
					const cost = state.cumulativeCostUsd > 0 ? `\nCost: $${state.cumulativeCostUsd.toFixed(2)}` : "";
					ctx.ui.notify(`SDD Status:\n${taskLines.join("\n")}${cost}`, "info");
					return;
				}

				case "next": {
					const { advanceTask, getCurrentTask } = await import("./workflow/state.js");
					const current = getCurrentTask();
					if (!current) {
						ctx.ui.notify("No tasks loaded or all tasks complete.", "info");
						return;
					}
					const next = advanceTask();
					if (next) {
						ctx.ui.notify(`Advanced to Task ${next.id}: ${next.title}`, "info");
					} else {
						ctx.ui.notify("All tasks complete!", "info");
					}
					updateWidget(ctx);
					return;
				}

				case "run": {
					const { runSddTask } = await import("./workflow/sdd.js");
					const task = getCurrentTask();
					if (!task) {
						ctx.ui.notify("No current task. Use /sdd load <file> first.", "warning");
						return;
					}

					ctx.ui.notify(`Starting SDD for Task ${task.id}: ${task.title}`, "info");
					const result = await runSddTask(ctx, undefined, (msg) => {
						// Status updates during SDD run
						if (ctx.hasUI) ctx.ui.notify(msg, "info");
					});

					if (result.status === "complete") {
						const { formatUsage, aggregateUsage } = await import("./dispatch.js");
						ctx.ui.notify(
							`✓ Task ${result.taskId}: "${result.taskTitle}" completed!\n` +
							`Reviews: ${result.reviewResults.length} total\n` +
							`Usage: ${formatUsage(result.totalUsage)}`,
							"info",
						);

						// Auto-advance to next task
						const { advanceTask } = await import("./workflow/state.js");
						const next = advanceTask();
						if (next) {
							ctx.ui.notify(`Next: Task ${next.id}: ${next.title}. Run /sdd run to continue.`, "info");
						} else {
							ctx.ui.notify("All tasks complete! 🎉", "info");
						}
					} else if (result.status === "escalated") {
						ctx.ui.notify(
							`⚠ Task ${result.taskId}: "${result.taskTitle}" — escalated\n\n` +
							`${result.escalationReason}\n\n` +
							`Options: fix manually, then /sdd run to retry, or /sdd next to skip.`,
							"warning",
						);
					} else {
						ctx.ui.notify(`Task ${result.taskId}: aborted — ${result.escalationReason}`, "warning");
					}
					updateWidget(ctx);
					return;
				}

				case "reset": {
					const { updateState } = await import("./workflow/state.js");
					updateState((s) => {
						s.tasks = [];
						s.currentTaskIndex = -1;
						s.reviewCycles = [];
						s.cumulativeCostUsd = 0;
						s.planFile = undefined;
					});
					ctx.ui.notify("SDD state reset.", "info");
					updateWidget(ctx);
					return;
				}

				default:
					ctx.ui.notify("Unknown subcommand. Usage: /sdd load|run|status|next|reset", "warning");
			}
		},
	});

	// --- /workflow command ---

	pi.registerCommand("workflow", {
		description: "Orchestrated workflow. /workflow <description> to start, /workflow to resume, /workflow status, /workflow abort",
		async handler(args, ctx) {
			const trimmed = args.trim();

			// /workflow status
			if (trimmed === "status") {
				const state = loadWorkflowState(ctx.cwd);
				if (!state) {
					ctx.ui.notify("No active workflow.", "info");
					return;
				}
				const tasksDone = state.tasks.filter((t) => t.status === "complete").length;
				ctx.ui.notify(
					`Phase: ${state.phase} | Tasks: ${tasksDone}/${state.tasks.length} | Cost: $${state.totalCostUsd.toFixed(2)}`,
					"info",
				);
				return;
			}

			// /workflow abort
			if (trimmed === "abort") {
				clearWorkflowState(ctx.cwd);
				ctx.ui.notify("Workflow aborted and state cleared.", "info");
				return;
			}

			// /workflow (no args) — resume or prompt to start
			if (!trimmed) {
				const existingState = loadWorkflowState(ctx.cwd);
				if (existingState) {
					// Resume
					await runWorkflowLoop(existingState, ctx);
					return;
				}
				// No state — prompt for description
				const description = await ctx.ui.input("Start Workflow", "Describe what you want to build");
				if (!description) return;
				const state = createInitialState(description);
				saveWorkflowState(state, ctx.cwd);
				await runWorkflowLoop(state, ctx);
				return;
			}

			// /workflow <description> — start new
			const existingState = loadWorkflowState(ctx.cwd);
			if (existingState) {
				const replace = await ctx.ui.confirm("A workflow already exists. Replace it?");
				if (!replace) {
					// Resume existing
					await runWorkflowLoop(existingState, ctx);
					return;
				}
				clearWorkflowState(ctx.cwd);
			}

			const state = createInitialState(trimmed);
			saveWorkflowState(state, ctx.cwd);
			await runWorkflowLoop(state, ctx);
		},
	});

	// --- workflow tool ---

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: [
			"Run the orchestrated workflow engine.",
			"Provide a description to start a new workflow, or call without input to resume.",
			"The workflow goes through plan → review → configure → execute → finalize phases automatically.",
		].join(" "),
		parameters: Type.Object({
			input: Type.Optional(
				Type.String({ description: "Description to start a new workflow, or answer to resume a pending question" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runOrchestrator(ctx, signal, params.input);
			return {
				content: [{ type: "text", text: result.message }],
				isError: result.status === "error",
			};
		},

		renderCall(args, theme) {
			const preview = args.input
				? (args.input.length > 60 ? `${args.input.slice(0, 60)}...` : args.input)
				: "(resume)";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("workflow "))}${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			const content = text?.type === "text" ? text.text : "(no output)";
			const color = result.isError ? "error" : "toolOutput";
			return new Text(theme.fg(color, content), 0, 0);
		},
	});

	// --- /tdd command (toggle TDD mode + escape hatch) ---

	pi.registerCommand("tdd", {
		description: "TDD mode control. Usage: /tdd [off|tdd|atdd] | /tdd allow-bash-write once <reason>",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "";

			// Toggle or set mode
			if (!sub || ["off", "tdd", "atdd"].includes(sub)) {
				if (sub && ["off", "tdd", "atdd"].includes(sub)) {
					const mode = sub as TddMode;
					setTddMode(mode);
					ctx.ui.notify(`TDD mode: ${mode.toUpperCase()}`, "info");
				} else {
					const current = getState().tddMode;
					const next: TddMode = current === "off" ? "tdd" : current === "tdd" ? "atdd" : "off";
					setTddMode(next);
					ctx.ui.notify(`TDD mode: ${next.toUpperCase()}`, "info");
				}
				updateWidget(ctx);
				return;
			}

			// Bash write allowance escape hatch
			if (sub === "allow-bash-write" && parts[1]?.toLowerCase() === "once") {
				const reason = parts.slice(2).join(" ").trim();
				if (!reason) {
					ctx.ui.notify("Usage: /tdd allow-bash-write once <reason>", "warning");
					return;
				}
				grantBashWriteAllowance(reason);
				ctx.ui.notify(`Bash write allowed once: ${reason}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /tdd [off|tdd|atdd] | /tdd allow-bash-write once <reason>", "warning");
		},
	});

	// --- TDD Guard event handlers ---

	pi.on("tool_call", (event, ctx) => {
		return handleToolCall(event, ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		return handleToolResult(event, ctx);
	});

	pi.on("user_bash", (event, ctx) => {
		return handleUserBash(event, ctx);
	});

	// --- Rule engine (TTSR-like context injection) ---

	pi.on("context", (event, _ctx) => {
		return handleRuleContext(event);
	});

	// --- Session lifecycle ---

	initState(pi);
	loadRules(); // Initial load (session_start reloads)

	pi.on("session_start", (_event, ctx) => {
		resetSessionCost();
		resetTddState();
		resetRuleStates();
		loadRules(); // Load rules from package rules/ dir
		restoreFromBranch(ctx);
		updateWidget(ctx);
	});
}
