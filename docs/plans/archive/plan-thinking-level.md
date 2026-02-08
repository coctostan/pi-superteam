# Plan: Per-Agent Thinking Level Support

## Goal
Add the ability to configure thinking level (off|minimal|low|medium|high|xhigh) per agent, both via `.superteam.json` config overrides and agent `.md` frontmatter. Mirrors the existing `modelOverrides` pattern.

## Constraints
- pi CLI supports `--thinking <level>` flag
- No breaking changes to existing config or agent profiles
- Resolution priority: config `thinkingOverrides` > agent frontmatter `thinking:` > omit (inherit pi default)
- Valid levels: off, minimal, low, medium, high, xhigh

## Context
- Config types and defaults: `src/config.ts`
- Agent discovery, profile parsing, subprocess dispatch: `src/dispatch.ts`
- `/team` command display: `src/index.ts`
- Agent profiles: `agents/*.md`
- Docs: `README.md`, `docs/guides/configuration.md`, `docs/guides/agents.md`

```superteam-tasks
- title: Add ThinkingLevel type and thinkingOverrides to config with validation
  description: |
    In src/config.ts:
    1. Export a ThinkingLevel type: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
    2. Export a VALID_THINKING_LEVELS array for runtime validation
    3. Add thinkingOverrides: Record<string, ThinkingLevel> to AgentConfig interface
    4. Add thinkingOverrides: {} to DEFAULT_CONFIG.agents
    5. Add validation in getConfig() after parsing — iterate thinkingOverrides entries, warn and drop any with invalid values
  files: [src/config.ts]
- title: Add thinking to AgentProfile and extract resolution helpers
  description: |
    In src/dispatch.ts:
    1. Import ThinkingLevel and VALID_THINKING_LEVELS from config.ts
    2. Add thinking?: ThinkingLevel to AgentProfile interface
    3. In loadAgentsFromDir(), parse thinking: from frontmatter with validation (check against VALID_THINKING_LEVELS, ignore if invalid)
    4. Extract and export resolveAgentModel(agent, config): returns effective model string using existing priority chain (config.agents.modelOverrides[name] > agent.model > scoutModel/defaultModel)
    5. Extract and export resolveAgentThinking(agent, config): returns ThinkingLevel | undefined using priority chain (config.agents.thinkingOverrides[name] > agent.thinking > undefined)
    6. Refactor buildSubprocessArgs to use resolveAgentModel() and resolveAgentThinking()
    7. If thinking is resolved, push "--thinking", thinking to args array
  files: [src/dispatch.ts]
- title: Fix /team display to use resolution helpers for model and thinking
  description: |
    In src/index.ts:
    1. Import resolveAgentModel and resolveAgentThinking from dispatch.ts
    2. In the /team command handler, replace inline model resolution with resolveAgentModel(a, config)
    3. Determine model source annotation: (override) if from config.agents.modelOverrides, (config default) if from config defaults, blank if from agent frontmatter
    4. Call resolveAgentThinking(a, config) and display thinking level with (override) annotation if from config.agents.thinkingOverrides
    5. This fixes the existing bug where /team wasn't showing config modelOverrides
  files: [src/index.ts]
- title: Update all docs and config examples
  description: |
    1. README.md: Add thinkingOverrides example to the config JSON block
    2. docs/guides/configuration.md: Add thinkingOverrides to the full reference JSON, add row to agents settings table, document validation behavior
    3. docs/guides/agents.md: Document the thinking: frontmatter field for custom agents
    4. Keep examples realistic (e.g. architect: xhigh, scout: low, implementer: high)
  files: [README.md, docs/guides/configuration.md, docs/guides/agents.md]
```
