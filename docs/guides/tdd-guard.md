# TDD Guard

The TDD guard enforces test-driven development at the tool level. When active, it intercepts `write`, `edit`, and `bash` tool calls and blocks those that violate TDD discipline.

## How It Works

### Three-Layer Defense

Superteam uses three complementary layers to enforce TDD:

| Layer | Mechanism | Strength |
|-------|-----------|----------|
| **Guard** | Blocks tool calls | Mechanical — can't be argued with |
| **Rules** | Injects context messages | Proactive — catches rationalizations before they reach the guard |
| **Skills** | Teaches methodology | Educational — builds understanding of RED→GREEN→REFACTOR |

### What the Guard Checks

When you write to an **implementation file** (anything that's not a test or exempt):

```
1. Is TDD enabled?
   ├─ No → ALLOW
   └─ Yes
      ├─ Is the file exempt? (*.d.ts, *.config.*, etc.)
      │  └─ Yes → ALLOW
      ├─ Does a test file exist for this module?
      │  ├─ No → BLOCK: "Create a test file first. Expected: src/foo.test.ts"
      │  └─ Yes
      │     ├─ Has any test been run?
      │     │  ├─ No → BLOCK: "Run your tests first."
      │     │  └─ Yes → ALLOW
```

When you write to a **test file**: always ALLOW (this IS the test-first step).

When you use **bash with file mutations** (>, >>, sed -i, tee, mv, cp targeting impl files): BLOCK, unless a one-time allowance is active.

### What the Guard Does NOT Check

The guard enforces the **mechanical minimum**: tests exist and have been run. It does **not** require:
- Tests to be failing (that would block REFACTOR)
- Tests to be passing (that would block RED→GREEN)
- Specific test content or quality (that's the reviewer's job)

This is by design. A strict "must have failing test" guard blocks legitimate workflows (like refactoring with passing tests or adding coverage to existing code). The skills and rules teach the full RED→GREEN→REFACTOR discipline.

## Modes

### Off (default)
No enforcement. All writes unrestricted.

### TDD
Full test-first enforcement:
- Implementation files require test file + test run
- Test files always writable
- Bash mutations to impl files blocked

### ATDD
Everything in TDD mode, plus:
- Warns when writing unit tests without an acceptance test
- Acceptance tests identified by pattern: `*.acceptance.test.ts`, `*.e2e.test.ts`
- ATDD warnings are non-blocking (soft enforcement)

## Commands

```
/tdd            # Toggle: off → tdd → atdd → off
/tdd tdd        # Enable TDD mode
/tdd atdd       # Enable ATDD mode  
/tdd off        # Disable enforcement

# Bash escape hatch (one-time, auditable)
/tdd allow-bash-write once "generating config file"
```

## File Mapping

The guard needs to know which test file corresponds to which implementation file. This is configured in `.superteam.json`:

```json
{
  "testFileMapping": {
    "strategies": [
      { "type": "suffix", "implSuffix": ".ts", "testSuffix": ".test.ts" },
      { "type": "suffix", "implSuffix": ".ts", "testSuffix": ".spec.ts" },
      { "type": "directory", "testDir": "__tests__" }
    ],
    "overrides": {
      "src/special.ts": "tests/special-case.test.ts"
    }
  }
}
```

### Mapping Strategies

| Strategy | Example |
|----------|---------|
| `suffix` | `src/foo.ts` → `src/foo.test.ts` |
| `suffix` | `src/foo.ts` → `src/foo.spec.ts` |
| `directory` | `src/foo.ts` → `src/__tests__/foo.test.ts` |
| `mirror` | `src/lib/foo.ts` → `tests/lib/foo.test.ts` |

Strategies are applied in order; first match wins. Explicit `overrides` take priority over all strategies.

### Unmapped Files

If no mapping is found for a file, the write is **allowed** (the guard doesn't block on mapping uncertainty). A warning is logged suggesting you configure the mapping.

## Exempt Paths

Files matching exempt patterns bypass the guard entirely:

```json
{
  "exemptPaths": ["*.d.ts", "*.config.*", "migrations/*"]
}
```

Default exemptions: TypeScript declarations, config files, database migrations.

## Test Detection

The guard recognizes test executions by matching against configured test commands:

```json
{
  "testCommands": ["npm test", "bun test", "npx jest", "npx vitest"]
}
```

When a test command runs via `bash` tool and returns a result, the guard tracks:
- Which tests ran
- Whether they passed or failed
- Timestamp of last run

When a test command runs via user bash (`!npm test`), the guard marks tests as "run attempted" but can't determine pass/fail (it's a pre-execution hook).

## Guard in Subagents

The TDD guard also runs inside implementer subagents. When SDD dispatches an implementer, it loads the guard extension in the subprocess. The guard boots fresh with no inherited state and enforces TDD from scratch as the implementer works.

This means the three-layer defense applies both in your direct session and in automated SDD workflows.
