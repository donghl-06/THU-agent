# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`. Keep service clients in `src/client/`, agent runtime code in `src/harness/`, and atomic tools in domain folders under `src/skills/`. `src/server/` contains the local web UI and assets. Developer probes belong in `scripts/`; evaluations live in `eval/`. Tests mirror source under `tests/skills/`, `tests/harness/`, `tests/server/`, and `tests/integration/`. API notes belong in `docs/`; changes to `@thu-info/lib` stay in `patches/`.

## Build, Test, and Development Commands

- `pnpm install` installs dependencies and applies the checked-in pnpm patch.
- `pnpm typecheck` runs strict TypeScript checks without emitting files.
- `pnpm test` runs all Vitest tests, including credentialed integration tests.
- `pnpm exec vitest run tests/harness/agentLoop.test.ts` runs one offline test file.
- `pnpm agent` starts the command-line agent; `pnpm web` starts the local HTTP/SSE UI.
- `pnpm eval` runs cases from `eval/cases.json`; `pnpm benchmark` measures agent performance.

Use Node.js 22+ and pnpm 10. Network scripts already set `OPENSSL_CONF` for legacy THU TLS behavior.

## Coding Style & Naming Conventions

The codebase uses ESM and strict TypeScript. Follow four-space indentation, double quotes, semicolons, and compact imports such as `import {describe, it} from "vitest"`. Use `camelCase` for variables/functions, `PascalCase` for classes and types, and factories such as `createGetScheduleSkill`. Skill API names use `snake_case` (for example, `get_schedule`). No formatter or linter is configured; match nearby files and run `pnpm typecheck`.

## Testing Guidelines

Write Vitest files as `*.test.ts` and mirror the relevant module path. Prefer deterministic fake clients/LLMs for unit tests. Files in `tests/integration/` contact real THU systems, may take up to three minutes, and require a populated `.env`; run them deliberately. Changes to skills should cover success, invalid input, and service-error paths. Never let tests perform an unconfirmed booking, cancellation, recharge, or payment.

## Commit & Pull Request Guidelines

Recent history uses either milestone subjects (`Step 20: ...`) or scoped Conventional Commit forms (`feat(booking): ...`, `fix(skills): ...`, `docs: ...`). Keep commits focused and use an imperative, specific subject. Pull requests should summarize behavior, list commands run, call out live-service testing, and link the relevant roadmap step or issue. Include screenshots for `src/server/public/` UI changes and document any patch or environment-variable changes.

## Security & Configuration

Copy `.env.example` to `.env`; never commit THU credentials, fingerprints, API keys, cookies, or captured responses. Preserve `requiresConfirmation: true` on every write skill and require explicit user approval before any real-world action.
