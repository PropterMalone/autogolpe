# Autogolpe — Coup on Bluesky

Bluffing card game bot for AT Protocol. Players claim roles, challenge each other, and bluff their way to victory.

## Tech Stack
- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js
- **Testing**: Vitest
- **Linting + Formatting**: Biome (tabs, single quotes, 100 width)
- **Package Manager**: npm (monorepo with workspaces)
- **Database**: SQLite via better-sqlite3 (JSON blob game state)
- **Deploy target**: Malone (Docker Compose + Tailscale Funnel)
- **Bluesky SDK**: @atproto/api

## Commands
- `npm run validate` — biome check + tsc --noEmit + vitest run
- `npm run test` — vitest (watch mode)
- `npm run build` — tsc -b across all packages

## Project Structure
```
packages/
  shared/   — Pure game logic, types, deck operations. Zero I/O.
  engine/   — Bot, DM handling, DB, polling loop. All I/O here.
  feed/     — Feed generator + FAQ page (serves https://malone.taildf301e.ts.net:4443/faq)
```

## Architecture
- **FCIS**: All game logic is pure functions in shared. Engine handles I/O.
- **State machine**: Flat `TurnPhase` enum, not nested states. `GameState` carries `pendingAction`, `pendingBlock`, `pendingChallenge` as context.
- **Turn flow**: `awaiting_action → challenge_window → block_window → challenge_block_window → execute`. Each window has a timer; all passes or timeout advances to next phase.
- **Tests as spec**: game-logic.test.ts is the source of truth for Coup rules.

## Key Patterns
- `noShuffle` for deterministic tests (deck dealt in creation order)
- `GameResult = { ok, error?, state }` — explicit error returns, no throwing
- `ShuffleFn` injected for testability
- `influenceLossReason` tracks why influence was lost to determine post-loss flow

## Biome
- `noNonNullAssertion` is OFF (noUncheckedIndexedAccess + game state makes assertions necessary)
- `useLiteralKeys` is OFF (bracket access needed for index signatures)

## FAQ Page
- **Location**: `packages/feed/src/faq.ts` (static HTML string)
- **URL**: https://malone.taildf301e.ts.net:4443/faq
- **Keep updated**: When adding/changing commands, actions, DM features, or game mechanics, update the FAQ to match. The FAQ is the primary user-facing documentation.

## Test Accounts
- bobbyquine, jackautomatic, rikkiwildside (shared across all bot projects)
- Never use proptermalone for bot testing
