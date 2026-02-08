# Configuration

Superteam is configured via `.superteam.json` in your project root. All settings have sensible defaults — you only need to configure what you want to change.

## Quick Setup

```bash
# Create a default config (optional — superteam works without one)
cat > .superteam.json << 'EOF'
{
  "configVersion": 1,
  "tddMode": "tdd"
}
EOF
```

## Full Reference

```json
{
  "configVersion": 1,

  "tddMode": "off",

  "testFilePatterns": [
    "*.test.ts",
    "*.spec.ts",
    "__tests__/*.ts"
  ],

  "acceptanceTestPatterns": [
    "*.acceptance.test.ts",
    "*.e2e.test.ts"
  ],

  "testCommands": [
    "npm test",
    "bun test",
    "npx jest",
    "npx vitest"
  ],

  "exemptPaths": [
    "*.d.ts",
    "*.config.*",
    "migrations/*"
  ],

  "testFileMapping": {
    "strategies": [
      { "type": "suffix", "implSuffix": ".ts", "testSuffix": ".test.ts" },
      { "type": "suffix", "implSuffix": ".ts", "testSuffix": ".spec.ts" },
      { "type": "directory", "testDir": "__tests__" }
    ],
    "overrides": {}
  },

  "review": {
    "maxIterations": 3,
    "required": ["spec", "quality"],
    "optional": ["security", "performance"],
    "parallelOptional": true,
    "escalateOnMaxIterations": true
  },

  "agents": {
    "defaultModel": "claude-sonnet-4-5",
    "scoutModel": "claude-haiku-4-5",
    "modelOverrides": {},
    "thinkingOverrides": {}
  },

  "costs": {
    "warnAtUsd": 5.0,
    "hardLimitUsd": 20.0
  }
}
```

## Settings Reference

### `configVersion`
Schema version. Currently `1`. Used for future migration support.

### `tddMode`
TDD enforcement level. Set via config or `/tdd` command.

| Value | Behavior |
|-------|----------|
| `"off"` | No enforcement (default) |
| `"tdd"` | Block impl writes without tests |
| `"atdd"` | TDD + acceptance test warnings |

### `testFilePatterns`
Glob patterns that identify test files. Matched against basename or relative path.

### `acceptanceTestPatterns`
Patterns for acceptance/e2e tests (ATDD mode only).

### `testCommands`
Commands recognized as test executions. Used by the guard to track test runs.

### `exemptPaths`
Files matching these patterns bypass TDD enforcement entirely.

### `testFileMapping`

#### `strategies`
Ordered list of mapping strategies. First match wins.

| Type | Fields | Example |
|------|--------|---------|
| `suffix` | `implSuffix`, `testSuffix` | `foo.ts` → `foo.test.ts` |
| `directory` | `testDir` | `foo.ts` → `__tests__/foo.test.ts` |
| `mirror` | `srcRoot`, `testRoot` | `src/lib/foo.ts` → `tests/lib/foo.test.ts` |

#### `overrides`
Explicit mapping from impl file to test file. Takes priority over strategies.

```json
{
  "overrides": {
    "src/special-case.ts": "tests/integration/special.test.ts"
  }
}
```

### `review`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxIterations` | number | `3` | Fix→re-review cycles per review |
| `required` | string[] | `["spec", "quality"]` | Must-pass reviews |
| `optional` | string[] | `["security", "performance"]` | Nice-to-have reviews |
| `parallelOptional` | boolean | `true` | Run optional reviews concurrently |
| `escalateOnMaxIterations` | boolean | `true` | Ask human when stuck |

### `validationCommand`

Command run after implementation, before code reviews. Catches build errors early.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `validationCommand` | string | `"tsc --noEmit"` | Shell command for pre-review validation |

If the command fails, the orchestrator dispatches the implementer for an auto-fix attempt, then re-validates. If still failing, it escalates via the failure taxonomy (default action: `retry-then-escalate`).

### `testCommand`

Command for cross-task test suite validation. When configured, the orchestrator captures a baseline before execution begins and runs the full suite after task completion to detect regressions.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `testCommand` | string | `""` | Shell command for cross-task validation (empty = disabled) |

### `validationCadence`

Controls how often cross-task validation runs.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `validationCadence` | string | `"every"` | When to run cross-task validation |
| `validationInterval` | number | `3` | Interval for `every-N` cadence |

| Cadence | Behavior |
|---------|----------|
| `"every"` | Run after every completed task |
| `"every-N"` | Run every N completed tasks (set N via `validationInterval`) |
| `"on-demand"` | Never run automatically |

### `agents`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultModel` | string | `"claude-sonnet-4-5"` | Default model for non-scout agents |
| `scoutModel` | string | `"claude-haiku-4-5"` | Model for scout (fast/cheap) |
| `modelOverrides` | object | `{}` | Per-agent model overrides |
| `thinkingOverrides` | object | `{}` | Per-agent thinking level overrides |

#### `modelOverrides`

Override the model for any agent by name. Takes highest priority in the model resolution chain.

```json
{
  "agents": {
    "modelOverrides": {
      "implementer": "claude-opus-4-6",
      "security-reviewer": "claude-opus-4-6"
    }
  }
}
```

**Model resolution order:**
1. `config.agents.modelOverrides[agentName]` — highest priority
2. Agent frontmatter `model` field
3. `config.agents.scoutModel` (for scout agent only)
4. `config.agents.defaultModel` — lowest priority

This is implemented by `resolveAgentModel()` in `src/dispatch.ts`.

#### `thinkingOverrides`

Override the thinking level for any agent by name. Thinking level controls how much "thinking" budget the model gets for reasoning.

```json
{
  "agents": {
    "thinkingOverrides": {
      "implementer": "high",
      "architect": "xhigh",
      "scout": "low",
      "quality-reviewer": "medium"
    }
  }
}
```

**Valid thinking levels:**

| Level | Description |
|-------|-------------|
| `"off"` | No extended thinking |
| `"minimal"` | Minimal thinking budget |
| `"low"` | Low thinking budget |
| `"medium"` | Medium thinking budget |
| `"high"` | High thinking budget |
| `"xhigh"` | Maximum thinking budget |

**Validation:** Invalid values are logged as warnings during config loading and silently dropped. Only the six values above are accepted. The validation uses the `VALID_THINKING_LEVELS` constant from `src/config.ts`.

**Thinking resolution order:**
1. `config.agents.thinkingOverrides[agentName]` — highest priority
2. Agent frontmatter `thinking` field
3. `undefined` (no thinking flag passed to subprocess)

This is implemented by `resolveAgentThinking()` in `src/dispatch.ts`.

> **Note on falsy values:** The resolution uses nullish coalescing (`??`) rather than logical OR (`||`), so `"off"` is correctly treated as a valid value rather than being skipped as falsy.

### `costs`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `warnAtUsd` | number | `5.00` | Warning notification threshold |
| `hardLimitUsd` | number | `20.00` | Hard limit — blocks new dispatches, kills running subprocesses |

Cost tracking is session-level. Use `/team` to see current session cost. The workflow orchestrator checks the budget before every agent dispatch and aborts if the hard limit is reached.

## Workflow Orchestrator Defaults

The `/workflow` orchestrator uses the following internal defaults. These are **not configurable** via `.superteam.json` — they are set during the workflow's configure phase or use built-in defaults.

| Setting | Default | Description |
|---------|---------|-------------|
| `maxPlanReviewCycles` | `3` | Maximum plan review → revision cycles before escalating |
| `maxTaskReviewCycles` | `3` | Maximum fix → re-review cycles per task review |
| `reviewMode` | chosen at runtime | `single-pass` (findings as warnings) or `iterative` (review-fix loop) — selected during configure phase |
| `executionMode` | chosen at runtime | `auto`, `checkpoint`, or `batch` — selected during configure phase |
| `batchSize` | `3` | Tasks per batch in batch execution mode (configurable during configure phase) |
| `tddMode` | `"tdd"` | Always enforced during workflow execution |

The orchestrator also respects the `review` and `costs` settings from `.superteam.json` (see above). See the [Workflow Guide](workflow.md) for details on phases and execution modes.

## Config Discovery

Superteam walks up from `cwd` looking for `.superteam.json`. If not found, uses built-in defaults. The config is cached after first load within a session. Pass `force: true` to `getConfig()` to reload.

If the config file contains invalid JSON or cannot be read, defaults are used silently.

## Per-Project Config

Add `.superteam.json` to your project root and commit it to version control. This ensures consistent TDD enforcement and review settings across your team.

Consider adding to `.gitignore` if you want personal overrides:
```
# Uncomment to keep superteam config personal
# .superteam.json
```

## How `/team` Shows Config

The `/team` command displays effective settings for each agent with source annotations:

```
scout [package] — Fast codebase reconnaissance
  model: claude-haiku-4-5 (config default), thinking: low (override), tools: read, grep, find, ls, bash

implementer [package] — TDD implementation
  model: claude-opus-4-6 (override), thinking: high (override), tools: read, bash, edit, write, grep, find, ls
```

- `(override)` — value comes from `modelOverrides` or `thinkingOverrides` in config
- `(config default)` — value comes from `defaultModel` or `scoutModel`
- No annotation — value comes from agent frontmatter
