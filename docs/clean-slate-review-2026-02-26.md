# Clean Slate Review - Autogolpe

Date: 2026-02-26
Milestone: Beta ready for testers

## Current State

3,425 lines of source across 13 files, 1,587 lines of tests across 4 files (79 tests). Three packages: shared (pure game logic), engine (Bluesky I/O + orchestration), feed (FAQ server). SQLite persistence, Docker Compose deploy on Malone behind Tailscale Funnel.

**What works:** Full Coup game loop — create/join/queue, all 7 actions, challenges, blocks, influence loss, exchange, win detection, timer auto-advance, DM-based private info, multi-post splitting, rate limiting, session refresh, search-based mention backup.

**What's partially implemented:** Feed generator (serves FAQ + DID doc but no actual feed skeleton endpoints).

**Tech debt:** Zero TODOs/FIXMEs. Some dead exports (`truncateToLimit`, `loadGame`, `executeAction`, `advanceAfterAllPass`, `getCurrentPlayerDid`). `PostKind` type doesn't include `'timeout'` but it's used as a kind value in the DB. `bot.ts` is Mixed FCIS (pure text utils + I/O in same file). `_agent` unused parameter in `handleMention`.

## Future Direction

- Custom game configs (different timer lengths, player counts)
- Coup expansions (Reformation, Inquisitor, etc.) if requested
- Leaderboard (win/loss tracking)
- Multi-game support (already works — Map<string, GameState>)
- Scale: handful of concurrent games, not hundreds

## Ideal Architecture

Knowing what I know now, I'd build essentially the same thing with minor adjustments:

**Package structure:** Same three packages. The shared/engine split is the right call — pure game logic is trivially testable and the FCIS boundary is clean.

**What I'd change:**

1. **Extract text utilities from bot.ts** into their own file (`text-splitting.ts` or similar). `splitForPost`, `truncateToLimit`, `graphemeLength`, `splitParagraph`, `splitLine`, `tokenize` are pure functions that happen to live in an I/O file. This blocks testing them without mocking the entire bot module.

2. **Split game-manager.ts** (~870 lines) into two concerns:
   - `game-manager.ts` — game lifecycle, command routing, state management
   - `announcements.ts` — all the `announce*`, `dm*`, `prompt*`, `nextTurnText` methods that format and send messages

   The announcement layer is ~300 lines and will grow with expansions (new actions = new announcement text). The game orchestration is stable.

3. **Split index.ts** (~424 lines) — extract `handleMention` and `handleDm` into a `command-router.ts`. The main loop (`poll`, auth refresh, backoff) is generic infrastructure; the command routing is game-specific and will grow with new commands (leaderboard, custom game config).

4. **Leaderboard as a new DB table + shared type.** Wins/losses/games played per DID. Expose via a mention command (`status @player`) and optionally a web page on the feed server.

5. **Expansion support:** `GameConfig` already exists and is injectable. New roles would mean extending `CardRole`, `ACTION_CLAIMS`, `BLOCK_RULES`, and adding new action handlers in game-logic.ts. The architecture supports this without structural changes.

**What I'd keep exactly the same:**
- Tech stack (TypeScript, SQLite, better-sqlite3, @atproto/api)
- FCIS split (shared = pure, engine = I/O)
- `GameResult = { ok, error?, state }` pattern
- `ShuffleFn` injection for testability
- JSON blob game state in SQLite (right choice for this scale)
- Timer-based auto-advance via tick()
- Rate limiter in bot.ts
- Docker Compose deploy

## Gap Analysis

| Aspect | Current | Ideal | Gap |
|--------|---------|-------|-----|
| Package structure | shared/engine/feed | Same | None |
| FCIS compliance | Clean except bot.ts (Mixed) | All files classified | Extract pure text utils from bot.ts |
| game-manager.ts | 870 lines, growing | Split at ~500 lines | Extract announcements (~300 lines) |
| index.ts | 424 lines, command routing mixed with polling | Split routing from infra | Extract command router (~150 lines) |
| Test coverage | 79 tests, good business logic coverage | Add splitForPost/truncateToLimit tests | ~30 min work |
| Dead code | 5-6 unused exports | Clean exports | Minor cleanup pass |
| Type safety | PostKind missing 'timeout' | Complete union | 1-line fix |
| Leaderboard | Not started | DB table + command + web page | New feature work |
| Expansions | Architecture supports it | Same | No structural gap |
| Multi-game | Works (Map-based) | Same | No gap |
| Custom configs | GameConfig exists, not exposed | Mention command to set config | Minor feature |

## Rebuild Assessment

| Option | Effort | Risk | Outcome |
|--------|--------|------|---------|
| Keep polishing | Low (2-3 hours) | None | Clean up dead code, add missing tests, fix types |
| Refactor | Medium (4-6 hours) | Low | Extract 3 files, better FCIS, easier to extend |
| Rebuild | High (2-3 days) | Moderate | Same architecture with cleaner files from the start |

## Recommendation

**Path:** Refactor (light)

**Why:** The architecture is fundamentally correct. The FCIS split works, the game logic is solid and well-tested, and the planned features (expansions, leaderboard, custom games) fit the existing structure. The only real issue is file size — game-manager.ts and index.ts are accumulating concerns that should be separated before adding more features. A rebuild would produce nearly identical code.

**Next Steps:**
1. Extract `splitForPost`/`truncateToLimit`/helpers from `bot.ts` → `post-splitting.ts`, add tests
2. Extract announcement/DM methods from `game-manager.ts` → `announcements.ts`
3. Extract `handleMention`/`handleDm` from `index.ts` → `command-router.ts`
4. Clean up dead exports (`truncateToLimit` caller, `loadGame`, unused shared exports)
5. Fix `PostKind` to include `'timeout'`
6. Remove `_agent` param from `handleMention`

**Timeline:** 4-6 hours across 1-2 sessions. None of this blocks launch — do it after testers are playing.
