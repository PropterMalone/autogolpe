# Autogolpe

[Coup](https://boardgamegeek.com/boardgame/131357/coup) on Bluesky. Bluff, challenge, and betray — entirely through posts and DMs.

**Bot**: [@autogulp.bsky.social](https://bsky.app/profile/autogulp.bsky.social)
**FAQ**: [malone.taildf301e.ts.net/autogolpe/faq](https://malone.taildf301e.ts.net/autogolpe/faq)

## How it works

Mention the bot to join the queue. Games auto-start at 3 players.

All standard Coup actions are supported: income, foreign aid, coup, tax (Duke), assassinate (Assassin), steal (Captain), and exchange (Ambassador). Challenge and block mechanics work exactly like the card game.

Timers keep things moving: 90 seconds for challenges, 60 seconds for blocks and choices, 30-minute game timeout.

## Monorepo structure

```
packages/
  shared/   Pure game logic, types, deck operations. Zero I/O.
  engine/   Bot, DM handling, database, polling loop.
  feed/     FAQ page server.
```

Game logic is a pure functional core (`shared`) with all I/O isolated in the imperative shell (`engine`). Built on [propter-bsky-kit](https://github.com/PropterMalone/propter-bsky-kit).

## Tech stack

TypeScript, Node.js, SQLite (better-sqlite3), Vitest, Biome. Deployed with Docker.

## License

[MIT](LICENSE)
