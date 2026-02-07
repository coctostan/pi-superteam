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
    "modelOverrides": {}
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

### `agents`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultModel` | string | `"claude-sonnet-4-5"` | Default model for non-scout agents |
| `scoutModel` | string | `"claude-haiku-4-5"` | Model for scout (fast/cheap) |
| `modelOverrides` | object | `{}` | Per-agent model overrides |

### `costs`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `warnAtUsd` | number | `5.00` | Warning notification threshold |
| `hardLimitUsd` | number | `20.00` | Hard limit — blocks new dispatches |

## Config Discovery

Superteam walks up from `cwd` looking for `.superteam.json`. If not found, uses built-in defaults. The config is cached after first load within a session.

## Per-Project Config

Add `.superteam.json` to your project root and commit it to version control. This ensures consistent TDD enforcement and review settings across your team.

Consider adding to `.gitignore` if you want personal overrides:
```
# Uncomment to keep superteam config personal
# .superteam.json
```
