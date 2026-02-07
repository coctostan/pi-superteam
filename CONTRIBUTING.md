# Contributing to pi-superteam

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/coctostan/pi-superteam.git
   cd pi-superteam
   ```

2. Run with pi in development mode:
   ```bash
   pi -e ./src/index.ts
   ```

   No build step needed — pi loads TypeScript directly.

3. Test your changes:
   ```bash
   # Quick smoke test
   pi -e ./src/index.ts -p --mode text "Use the team tool to dispatch scout to count files in src/"
   
   # Test TDD guard
   cd /tmp && mkdir test-project && cd test-project
   echo '{"tddMode":"tdd"}' > .superteam.json
   pi -e /path/to/superteam/src/index.ts
   
   # Test workflow orchestrator
   pi -e ./src/index.ts
   # Then: /workflow Add a simple feature
   ```

## Project Structure

```
src/
├── index.ts                  ← Extension entry point (thin composition root)
│                               Registers: team tool, workflow tool,
│                               /team, /sdd, /workflow, /tdd commands,
│                               TDD guard event handlers, rule engine
├── config.ts                 ← Config discovery, defaults, ThinkingLevel type,
│                               VALID_THINKING_LEVELS, validation
├── dispatch.ts               ← Agent subprocess management, resolveAgentModel(),
│                               resolveAgentThinking(), cost tracking, usage formatting
├── team-display.ts           ← /team display formatting (formatAgentLine)
├── review-parser.ts          ← Structured JSON extraction from reviewer output
├── rules/
│   └── engine.ts             ← Context-aware rule injection (TTSR-like)
└── workflow/
    ├── state.ts              ← SDD plan tracking + persistence (line-walker parser)
    ├── tdd-guard.ts          ← TDD enforcement (tool call interception)
    ├── sdd.ts                ← SDD orchestration loop
    ├── brainstorm-parser.ts  ← Quote-aware JSON extraction with fallback chain
    ├── orchestrator.ts       ← Workflow orchestrator entry point + phase dispatch loop
    ├── orchestrator-state.ts ← OrchestratorState type, saveState/loadState/clearState
    ├── prompt-builder.ts     ← Deterministic prompt construction for all agents
    ├── interaction.ts        ← PendingInteraction type, user response parsing
    ├── ui.ts                 ← Status bar formatting + activity buffer
    ├── progress.ts           ← Progress file rendering + persistence
    ├── git-utils.ts          ← Async git utilities (getTrackedFiles, computeChangedFiles, getCurrentSha)
    └── phases/
        ├── brainstorm.ts     ← Brainstorm phase (scout → questions → approaches → design)
        ├── plan-write.ts     ← Plan write phase (planner agent dispatch)
        ├── plan-review.ts    ← Plan review phase (architect + spec reviewer)
        ├── configure.ts      ← Configure phase (review mode, exec mode, batch size)
        ├── execute.ts        ← Execute phase (implement → review → fix loops)
        └── finalize.ts       ← Finalize phase (cross-task review + report)

agents/   ← Agent profiles (9 built-in, markdown with YAML frontmatter)
skills/   ← Methodology skills (5: TDD, ATDD, SDD, writing-plans, brainstorming)
rules/    ← Context rules (3: test-first, yagni, no-impl-before-spec)
prompts/  ← Prompt templates (4: /sdd, /review-parallel, /scout, /implement)
docs/     ← Guides and reference documentation
```

## Design Principles

1. **`src/index.ts` is a thin composition root** — no business logic, only wiring (tool/command registration, event handler hookup)
2. **Graceful degradation** — missing models, unavailable tools, flaky SDD all degrade gracefully
3. **JSON-serializable state** — no Maps, Sets, or classes in persisted state
4. **Deterministic subprocesses** — agents run in full isolation with explicit add-backs
5. **Every piece is independently useful** — TDD guard, team tool, rules engine, SDD all work alone
6. **Workflow orchestrator is a state machine** — agents do creative work, TypeScript controls flow. No prompt-based flow control.
7. **Thinking level support** — per-agent thinking levels via `thinkingOverrides` in config or `thinking` in frontmatter, with `resolveAgentThinking()` for centralized resolution

## Key Abstractions

- **`AgentProfile`** (dispatch.ts) — discovered agent with name, tools, model, thinking, systemPrompt, source
- **`OrchestratorState`** (orchestrator-state.ts) — full workflow state, persisted to `.superteam-workflow.json`
- **`PendingInteraction`** (interaction.ts) — structured question for user input (choice, confirm, input)
- **`ReviewFindings`** (review-parser.ts) — structured reviewer output with findings, mustFix, summary
- **`ThinkingLevel`** (config.ts) — `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`

## Adding an Agent

1. Create `agents/your-agent.md` with frontmatter (`name`, `description`, `tools`, optionally `model` and `thinking`)
2. Test: `pi -e ./src/index.ts -p "Use team to dispatch your-agent to do something"`
3. If it's a reviewer, include the `ReviewFindings` JSON contract in the system prompt

## Adding a Rule

1. Create `rules/your-rule.md` with trigger regex
2. Test: start pi with the extension, trigger the pattern, verify rule fires

## Adding a Skill

1. Create `skills/your-skill/SKILL.md`
2. Follow pi's [skill format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)

## Adding a Workflow Phase

1. Create `src/workflow/phases/your-phase.ts`
2. Export an async function that takes `OrchestratorState` and returns updated state
3. Add the phase to `OrchestratorPhase` type in `orchestrator-state.ts`
4. Wire it into the phase dispatch switch in `orchestrator.ts`
5. Add prompts to `prompt-builder.ts` if the phase dispatches agents

## Running Tests

```bash
# Full suite (282 tests)
npx vitest run --reporter=verbose

# Specific file
npx vitest run src/workflow/state.acceptance.test.ts --reporter=verbose

# Watch mode
npx vitest
```

## Pull Requests

- Keep changes focused — one feature or fix per PR
- Run `npx vitest run` and ensure all tests pass
- Add acceptance tests for bug fixes (prove the bug exists, then fix it)
- Update relevant docs if behavior changes
- Follow existing code style
- Update CHANGELOG.md with your changes

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
