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
   ```

## Project Structure

```
src/
  index.ts              ← Extension entry point (thin — delegates everything)
  config.ts             ← Config discovery and defaults
  dispatch.ts           ← Agent subprocess management
  review-parser.ts      ← Structured JSON extraction
  rules/engine.ts       ← Context-aware rule injection
  workflow/state.ts     ← Plan tracking and persistence
  workflow/tdd-guard.ts ← TDD enforcement
  workflow/sdd.ts       ← SDD orchestration loop

agents/   ← Agent profiles (markdown)
skills/   ← Methodology skills (markdown)
rules/    ← Context rules (markdown)
prompts/  ← Prompt templates (markdown)
```

## Design Principles

1. **`src/index.ts` is a thin composition root** — no business logic, only wiring
2. **Graceful degradation** — missing models, unavailable tools, flaky SDD all degrade gracefully
3. **JSON-serializable state** — no Maps, Sets, or classes in persisted state
4. **Deterministic subprocesses** — agents run in full isolation with explicit add-backs
5. **Every piece is independently useful** — TDD guard, team tool, rules engine, SDD all work alone

## Adding an Agent

1. Create `agents/your-agent.md` with frontmatter
2. Test: `pi -e ./src/index.ts -p "Use team to dispatch your-agent to do something"`
3. If it's a reviewer, include the `ReviewFindings` JSON contract in the system prompt

## Adding a Rule

1. Create `rules/your-rule.md` with trigger regex
2. Test: start pi with the extension, trigger the pattern, verify rule fires

## Adding a Skill

1. Create `skills/your-skill/SKILL.md`
2. Follow pi's [skill format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)

## Pull Requests

- Keep changes focused — one feature or fix per PR
- Test manually via pi (automated tests coming)
- Update relevant docs if behavior changes
- Follow existing code style

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
