import type { AtpAgent } from '@atproto/api';
import type { GameState } from '@autogolpe/shared';
import type Database from 'better-sqlite3';
/**
 * End-to-end game manager test with mocked Bluesky and DB.
 * Exercises: queue → start → income/tax/steal/assassinate/coup →
 *            challenge → block → DM flows → win condition.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock bot.ts functions so we never call real Bluesky APIs
let postCount = 0;
const allPosts: Array<{ text: string; reply?: unknown }> = [];

vi.mock('./bot.js', () => ({
	postMessage: vi.fn(async (_agent: unknown, text: string) => {
		postCount++;
		allPosts.push({ text });
		return { uri: `at://mock/post/${postCount}`, cid: `cid-mock-${postCount}` };
	}),
	postMessageChain: vi.fn(async (_agent: unknown, text: string) => {
		postCount++;
		allPosts.push({ text });
		const ref = { uri: `at://mock/post/${postCount}`, cid: `cid-mock-${postCount}` };
		return [ref];
	}),
	replyToPost: vi.fn(async (_agent: unknown, text: string) => {
		postCount++;
		allPosts.push({ text });
		return { uri: `at://mock/post/${postCount}`, cid: `cid-mock-${postCount}` };
	}),
	replyToPostChain: vi.fn(async (_agent: unknown, text: string) => {
		postCount++;
		allPosts.push({ text });
		const ref = { uri: `at://mock/post/${postCount}`, cid: `cid-mock-${postCount}` };
		return [ref];
	}),
	resolveHandle: vi.fn(
		async (_agent: unknown, handle: string) => `did:plc:${handle.split('.')[0]}`,
	),
}));

// Import after mock
import { GameManager } from './game-manager.js';

// --- Mock DB ---
function createMockDb() {
	const games = new Map<string, string>();
	const botState = new Map<string, string>();
	const queue: Array<{ did: string; handle: string; joinedAt: number }> = [];
	const gamePosts: Array<{ gameId: string; postUri: string; kind: string }> = [];

	return {
		prepare: vi.fn((sql: string) => {
			// Route based on SQL content
			if (sql.includes('INSERT') && sql.includes('games')) {
				return {
					run: vi.fn((...args: unknown[]) => games.set(args[0] as string, args[1] as string)),
				};
			}
			if (sql.includes('SELECT') && sql.includes('games') && sql.includes('active')) {
				return {
					all: vi.fn(() =>
						[...games.entries()]
							.map(([id, state]) => ({ id, state }))
							.filter((g) => {
								const s = JSON.parse(g.state) as GameState;
								return s.status === 'active';
							}),
					),
				};
			}
			if (sql.includes('INSERT') && sql.includes('bot_state')) {
				return {
					run: vi.fn((...args: unknown[]) => botState.set(args[0] as string, args[1] as string)),
				};
			}
			if (sql.includes('SELECT') && sql.includes('bot_state')) {
				return {
					get: vi.fn((...args: unknown[]) => {
						const val = botState.get(args[0] as string);
						return val ? { value: val } : undefined;
					}),
				};
			}
			if (sql.includes('INSERT') && sql.includes('public_queue')) {
				return {
					run: vi.fn((...args: unknown[]) =>
						queue.push({
							did: args[0] as string,
							handle: args[1] as string,
							joinedAt: args[2] as number,
						}),
					),
				};
			}
			if (sql.includes('SELECT') && sql.includes('public_queue')) {
				return {
					all: vi.fn(() =>
						queue.map((q) => ({ did: q.did, handle: q.handle, joined_at: q.joinedAt })),
					),
				};
			}
			if (sql.includes('DELETE') && sql.includes('public_queue') && !sql.includes('1=1')) {
				return {
					run: vi.fn((...args: unknown[]) => {
						const idx = queue.findIndex((q) => q.did === args[0]);
						if (idx >= 0) queue.splice(idx, 1);
					}),
				};
			}
			if (sql.includes('DELETE') && sql.includes('public_queue') && sql.includes('1=1')) {
				return { run: vi.fn(() => queue.splice(0)) };
			}
			if (sql.includes('INSERT') && sql.includes('game_posts')) {
				return {
					run: vi.fn((...args: unknown[]) =>
						gamePosts.push({
							gameId: args[0] as string,
							postUri: args[1] as string,
							kind: args[2] as string,
						}),
					),
				};
			}
			if (sql.includes('CREATE TABLE')) {
				return { run: vi.fn() };
			}
			// Default
			return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
		}),
		close: vi.fn(),
		_games: games,
		_queue: queue,
	};
}

// --- Mock Agent ---
function createMockAgent() {
	return {
		session: { did: 'did:plc:bot', handle: 'testbot.bsky.social' },
	};
}

// --- Mock DM sender ---
function createMockDm() {
	const dms: Array<{ did: string; text: string }> = [];
	return {
		sendDm: vi.fn(async (did: string, text: string) => {
			dms.push({ did, text });
			return 'sent' as const;
		}),
		_dms: dms,
	};
}

// Player DIDs
const BOBBY = 'did:plc:bobby';
const RIKKI = 'did:plc:rikki';
const JACK = 'did:plc:jack';

describe('GameManager E2E', () => {
	let db: ReturnType<typeof createMockDb>;
	let agent: ReturnType<typeof createMockAgent>;
	let dm: ReturnType<typeof createMockDm>;
	let mgr: GameManager;

	beforeEach(() => {
		db = createMockDb();
		agent = createMockAgent();
		dm = createMockDm();
		mgr = new GameManager(db as unknown as Database.Database, agent as unknown as AtpAgent, dm);
		allPosts.length = 0;
		postCount = 0;
	});

	it('plays a full game from queue to winner', async () => {
		// --- Queue up 3 players ---
		await mgr.addToQueue(BOBBY, 'bobbyquine.bsky.social', 'at://b/post/1', 'cid-1');
		expect(allPosts.length).toBe(1);
		expect(allPosts[0]!.text).toContain('queue (1/3)');

		await mgr.addToQueue(RIKKI, 'rikkiwildside.bsky.social', 'at://r/post/1', 'cid-2');
		expect(allPosts[1]!.text).toContain('queue (2/3)');

		await mgr.addToQueue(JACK, 'jackautomatic.bsky.social', 'at://j/post/1', 'cid-3');
		// 3rd player triggers auto-start — queue reply + game start announcement + DMs
		expect(allPosts[2]!.text).toContain('queue (3/3)');

		// Game should have started (posts: 3 queue replies + 1 start announcement = 4)
		const game = mgr.findGameForPlayer(BOBBY);
		expect(game).toBeDefined();
		expect(game!.status).toBe('active');
		expect(game!.players).toHaveLength(3);

		// Each player should have gotten a DM with their hand
		const handDms = dm._dms.filter((d) => d.text.includes('Your cards'));
		expect(handDms).toHaveLength(3);

		const gameId = game!.id;

		// --- Turn 1: Bobby takes income ---
		const p = game!.players;
		const currentPlayer = p[game!.turnIndex]!;
		expect(currentPlayer.did).toBe(BOBBY);

		let err = await mgr.handleAction(gameId, BOBBY, 'income', null, 'at://b/post/2', 'cid-4');
		expect(err).toBeNull();

		let updated = mgr.getGame(gameId)!;
		const bobby = updated.players.find((p) => p.did === BOBBY)!;
		expect(bobby.coins).toBe(3); // started with 2, +1 income

		// --- Turn 2: Rikki claims tax (duke) ---
		err = await mgr.handleAction(gameId, RIKKI, 'tax', null, 'at://r/post/2', 'cid-5');
		expect(err).toBeNull();

		updated = mgr.getGame(gameId)!;
		expect(updated.turnPhase).toBe('challenge_window');

		// Bobby and Jack pass
		err = await mgr.handlePass(gameId, BOBBY);
		expect(err).toBeNull();
		err = await mgr.handlePass(gameId, JACK);
		expect(err).toBeNull();

		// Tax should have resolved — rikki gets +3
		updated = mgr.getGame(gameId)!;
		const rikki = updated.players.find((p) => p.did === RIKKI)!;
		expect(rikki.coins).toBe(5); // 2 + 3

		// --- Turn 3: Jack takes income ---
		err = await mgr.handleAction(gameId, JACK, 'income', null, 'at://j/post/2', 'cid-6');
		expect(err).toBeNull();

		// --- Turn 4: Bobby takes income (4 coins) ---
		err = await mgr.handleAction(gameId, BOBBY, 'income', null, 'at://b/post/3', 'cid-7');
		expect(err).toBeNull();

		// --- Turn 5: Rikki takes tax again (8 coins) ---
		err = await mgr.handleAction(gameId, RIKKI, 'tax', null, 'at://r/post/3', 'cid-8');
		expect(err).toBeNull();
		await mgr.handlePass(gameId, BOBBY);
		await mgr.handlePass(gameId, JACK);

		updated = mgr.getGame(gameId)!;
		expect(updated.players.find((p) => p.did === RIKKI)!.coins).toBe(8);

		// --- Turn 6: Jack takes income (4 coins) ---
		err = await mgr.handleAction(gameId, JACK, 'income', null, 'at://j/post/3', 'cid-9');
		expect(err).toBeNull();

		// --- Turn 7: Bobby claims foreign aid ---
		err = await mgr.handleAction(gameId, BOBBY, 'foreign_aid', null, 'at://b/post/4', 'cid-10');
		expect(err).toBeNull();
		updated = mgr.getGame(gameId)!;
		// Should be in challenge window (no role claimed), then block window
		// Actually foreign_aid has no claim, so it goes straight to block_window
		expect(updated.turnPhase).toBe('block_window');

		// Jack blocks claiming duke
		err = await mgr.handleBlock(gameId, JACK, 'duke');
		expect(err).toBeNull();
		updated = mgr.getGame(gameId)!;
		expect(updated.turnPhase).toBe('challenge_block_window');

		// Bobby and Rikki pass the block challenge
		await mgr.handlePass(gameId, BOBBY);
		await mgr.handlePass(gameId, RIKKI);

		// Block stands — Bobby doesn't get the 2 coins
		updated = mgr.getGame(gameId)!;
		expect(updated.players.find((p) => p.did === BOBBY)!.coins).toBe(4); // still 4

		// --- Turn 8: Rikki coups Bobby ---
		err = await mgr.handleAction(
			gameId,
			RIKKI,
			'coup',
			'bobbyquine.bsky.social',
			'at://r/post/4',
			'cid-11',
		);
		expect(err).toBeNull();

		updated = mgr.getGame(gameId)!;
		expect(updated.turnPhase).toBe('losing_influence');
		expect(updated.influenceLossDid).toBe(BOBBY);

		// Bobby reveals card via the manager
		err = await mgr.handleReveal(gameId, BOBBY, 0);
		expect(err).toBeNull();

		updated = mgr.getGame(gameId)!;
		expect(updated.players.find((p) => p.did === BOBBY)!.cards[0]!.revealed).toBe(true);

		// --- Continue: build coins and eliminate players ---
		// Jack's turn — income (5 coins)
		err = await mgr.handleAction(gameId, JACK, 'income', null, 'at://j/post/4', 'cid-12');
		expect(err).toBeNull();

		// Bobby's turn — income (5 coins)
		err = await mgr.handleAction(gameId, BOBBY, 'income', null, 'at://b/post/5', 'cid-13');
		expect(err).toBeNull();

		// Rikki's turn — coup Jack (rikki has 1 coin after the coup, needs 7 for another coup)
		// Actually rikki had 8 - 7 = 1 coin after the first coup
		// So rikki takes income
		err = await mgr.handleAction(gameId, RIKKI, 'income', null, 'at://r/post/5', 'cid-14');
		expect(err).toBeNull();

		// Jack — income (6)
		err = await mgr.handleAction(gameId, JACK, 'income', null, 'at://j/post/5', 'cid-15');
		expect(err).toBeNull();

		// Bobby — income (6)
		err = await mgr.handleAction(gameId, BOBBY, 'income', null, 'at://b/post/6', 'cid-16');
		expect(err).toBeNull();

		// Rikki — income (3)
		err = await mgr.handleAction(gameId, RIKKI, 'income', null, 'at://r/post/6', 'cid-17');
		expect(err).toBeNull();

		// Jack — income (7)
		err = await mgr.handleAction(gameId, JACK, 'income', null, 'at://j/post/6', 'cid-18');
		expect(err).toBeNull();

		// Bobby — coup Jack (bobby has 6, not enough... need 7)
		// Bobby — income (7)
		err = await mgr.handleAction(gameId, BOBBY, 'income', null, 'at://b/post/7', 'cid-19');
		expect(err).toBeNull();

		// Rikki — income (4)
		err = await mgr.handleAction(gameId, RIKKI, 'income', null, 'at://r/post/7', 'cid-20');
		expect(err).toBeNull();

		// Jack — coup Bobby (jack has 7)
		err = await mgr.handleAction(
			gameId,
			JACK,
			'coup',
			'bobbyquine.bsky.social',
			'at://j/post/7',
			'cid-21',
		);
		expect(err).toBeNull();

		updated = mgr.getGame(gameId)!;
		// Bobby only has 1 card left, auto-revealed
		const bobbyNow = updated.players.find((p) => p.did === BOBBY)!;
		expect(bobbyNow.cards[0]!.revealed && bobbyNow.cards[1]!.revealed).toBe(true);

		// Bobby is eliminated — game continues with Rikki vs Jack
		// Bobby's turn is skipped since eliminated

		// Rikki's turn — income (5)
		err = await mgr.handleAction(gameId, RIKKI, 'income', null, 'at://r/post/8', 'cid-22');
		expect(err).toBeNull();

		// Jack's turn — he has 0 coins after coup, income (1)
		err = await mgr.handleAction(gameId, JACK, 'income', null, 'at://j/post/8', 'cid-23');
		expect(err).toBeNull();

		// Build up to another coup... let's speed this up
		// Rikki income (6)
		await mgr.handleAction(gameId, RIKKI, 'income', null, 'u', 'c');
		// Jack income (2)
		await mgr.handleAction(gameId, JACK, 'income', null, 'u', 'c');
		// Rikki income (7)
		await mgr.handleAction(gameId, RIKKI, 'income', null, 'u', 'c');
		// Jack income (3)
		await mgr.handleAction(gameId, JACK, 'income', null, 'u', 'c');

		// Rikki coups Jack
		err = await mgr.handleAction(
			gameId,
			RIKKI,
			'coup',
			'jackautomatic.bsky.social',
			'at://r/post/9',
			'cid-24',
		);
		expect(err).toBeNull();

		updated = mgr.getGame(gameId)!;
		// Jack needs to reveal a card
		if (updated.turnPhase === 'losing_influence') {
			err = await mgr.handleReveal(gameId, JACK, 0);
			expect(err).toBeNull();
		}

		// Play out remaining turns until game ends.
		// Generic loop: current player takes income or coups if able.
		for (let i = 0; i < 30 && mgr.getGame(gameId)!.status === 'active'; i++) {
			const g = mgr.getGame(gameId)!;
			if (g.turnPhase !== 'awaiting_action') break; // stuck in a phase

			const current = g.players[g.turnIndex]!;
			const target = g.players.find(
				(p) => p.did !== current.did && !(p.cards[0]!.revealed && p.cards[1]!.revealed),
			);

			if (current.coins >= 7 && target) {
				const e = await mgr.handleAction(gameId, current.did, 'coup', target.handle, 'u', 'c');
				if (!e) {
					const gg = mgr.getGame(gameId)!;
					if (gg.turnPhase === 'losing_influence' && gg.influenceLossDid) {
						await mgr.handleReveal(gameId, gg.influenceLossDid, 0);
					}
				}
			} else {
				await mgr.handleAction(gameId, current.did, 'income', null, 'u', 'c');
			}
		}

		// Game should be finished
		updated = mgr.getGame(gameId)!;
		expect(updated.status).toBe('finished');
		expect(updated.winner).toBeTruthy();

		// Winner announcement should have been posted.
		// The coup that ends the game auto-reveals the last card, triggers
		// announceInfluenceLoss → announceWinner. Check both possible texts.
		const winPost = allPosts.find((p) => p.text.includes('wins') || p.text.includes('over'));
		expect(
			winPost,
			`No winner post found. All posts:\n${allPosts.map((p) => p.text).join('\n---\n')}`,
		).toBeDefined();
	});

	it('handles challenge flow', async () => {
		await mgr.newGame('test-challenge');
		mgr.addPlayer('test-challenge', BOBBY, 'bobbyquine.bsky.social');
		mgr.addPlayer('test-challenge', RIKKI, 'rikkiwildside.bsky.social');
		await mgr.startGameById('test-challenge');

		const game = mgr.getGame('test-challenge')!;
		const bobbyCards = game.players.find((p) => p.did === BOBBY)!.cards;
		const hasDuke = bobbyCards.some((c) => c.role === 'duke');

		// Bobby claims tax (duke)
		const err = await mgr.handleAction('test-challenge', BOBBY, 'tax', null, 'u', 'c');
		expect(err).toBeNull();

		let updated = mgr.getGame('test-challenge')!;
		expect(updated.turnPhase).toBe('challenge_window');

		// Rikki challenges → goes to resolving_challenge
		const challengeErr = await mgr.handleChallenge('test-challenge', RIKKI);
		expect(challengeErr).toBeNull();

		updated = mgr.getGame('test-challenge')!;
		expect(updated.turnPhase).toBe('resolving_challenge');

		// Bobby must reveal a card to prove/disprove duke claim
		// Find a card index to reveal — if bobby has duke, reveal it to prove; else reveal any
		const dukeIdx = bobbyCards.findIndex((c) => c.role === 'duke');
		const revealIdx = dukeIdx >= 0 ? dukeIdx : 0;

		const revealErr = await mgr.handleReveal('test-challenge', BOBBY, revealIdx);
		expect(revealErr).toBeNull();

		updated = mgr.getGame('test-challenge')!;

		if (hasDuke) {
			// Bobby proved it — Rikki loses influence
			// Could be in losing_influence (rikki chooses) or already resolved (auto-reveal)
			const rikkiCards = updated.players.find((p) => p.did === RIKKI)!.cards;
			const rikkiAlive = rikkiCards.filter((c) => !c.revealed).length;
			if (rikkiAlive === 1) {
				// Auto-revealed, may have moved on
				expect(updated.turnPhase).not.toBe('resolving_challenge');
			}
		} else {
			// Bobby was bluffing — Bobby loses influence (already revealed the non-duke card)
			// Turn should advance to rikki
			if (updated.turnPhase === 'losing_influence') {
				await mgr.handleReveal('test-challenge', BOBBY, 0);
				updated = mgr.getGame('test-challenge')!;
			}
			expect(updated.players[updated.turnIndex]!.did).toBe(RIKKI);
		}
	});

	it('handles assassinate with block by contessa', async () => {
		await mgr.newGame('test-block');
		mgr.addPlayer('test-block', BOBBY, 'bobbyquine.bsky.social');
		mgr.addPlayer('test-block', RIKKI, 'rikkiwildside.bsky.social');
		await mgr.startGameById('test-block');

		// Build up Bobby's coins for assassinate (needs 3)
		await mgr.handleAction('test-block', BOBBY, 'income', null, 'u', 'c');

		// Rikki's turn — income
		await mgr.handleAction('test-block', RIKKI, 'income', null, 'u', 'c');

		// Bobby's turn — income again (4 coins now)
		await mgr.handleAction('test-block', BOBBY, 'income', null, 'u', 'c');

		// Rikki's turn — income
		await mgr.handleAction('test-block', RIKKI, 'income', null, 'u', 'c');

		// Bobby assassinates Rikki (claims assassin)
		const err = await mgr.handleAction(
			'test-block',
			BOBBY,
			'assassinate',
			'rikkiwildside.bsky.social',
			'u',
			'c',
		);
		expect(err).toBeNull();

		let updated = mgr.getGame('test-block')!;
		// Bobby should have paid 3 coins
		expect(updated.players.find((p) => p.did === BOBBY)!.coins).toBe(1);
		// Assassinate claims assassin → challenge_window first
		expect(updated.turnPhase).toBe('challenge_window');

		// Rikki passes challenge (doesn't challenge the assassin claim)
		await mgr.handlePass('test-block', RIKKI);

		// Now in block_window
		updated = mgr.getGame('test-block')!;
		expect(updated.turnPhase).toBe('block_window');

		// Rikki blocks with contessa
		const blockErr = await mgr.handleBlock('test-block', RIKKI, 'contessa');
		expect(blockErr).toBeNull();

		updated = mgr.getGame('test-block')!;
		expect(updated.turnPhase).toBe('challenge_block_window');

		// Bobby passes (doesn't challenge the block)
		await mgr.handlePass('test-block', BOBBY);

		// Block stands — rikki survives, bobby's 3 coins are refunded
		updated = mgr.getGame('test-block')!;
		expect(updated.players.find((p) => p.did === BOBBY)!.coins).toBe(4); // refunded
		expect(updated.players.find((p) => p.did === RIKKI)!.cards.every((c) => !c.revealed)).toBe(
			true,
		);
	});

	it('handles exchange via DM', async () => {
		await mgr.newGame('test-exchange');
		mgr.addPlayer('test-exchange', BOBBY, 'bobbyquine.bsky.social');
		mgr.addPlayer('test-exchange', RIKKI, 'rikkiwildside.bsky.social');
		await mgr.startGameById('test-exchange');

		// Bobby claims exchange (ambassador)
		const err = await mgr.handleAction('test-exchange', BOBBY, 'exchange', null, 'u', 'c');
		expect(err).toBeNull();

		let updated = mgr.getGame('test-exchange')!;
		expect(updated.turnPhase).toBe('challenge_window');

		// Rikki passes
		await mgr.handlePass('test-exchange', RIKKI);

		// Exchange should be executing — Bobby gets extra cards
		updated = mgr.getGame('test-exchange')!;
		expect(updated.turnPhase).toBe('exchanging');
		expect(updated.exchangeCards).toHaveLength(2);

		// Bobby should have been DM'd with exchange options
		const exchangeDm = dm._dms.find((d) => d.did === BOBBY && d.text.includes('exchange'));
		expect(exchangeDm).toBeDefined();

		// Bobby keeps 2 roles (he has 2 alive cards)
		const bobbyCards = updated.players.find((p) => p.did === BOBBY)!.cards;
		const availableRoles = [
			...bobbyCards.filter((c) => !c.revealed).map((c) => c.role),
			...updated.exchangeCards!,
		];

		const keepErr = await mgr.handleExchangeKeep('test-exchange', BOBBY, [
			availableRoles[0]!,
			availableRoles[1]!,
		]);
		expect(keepErr).toBeNull();

		updated = mgr.getGame('test-exchange')!;
		expect(updated.turnPhase).toBe('awaiting_action');
		expect(updated.exchangeCards).toBeNull();
	});

	it('handles hand request via DM', async () => {
		await mgr.newGame('test-hand');
		mgr.addPlayer('test-hand', BOBBY, 'bobbyquine.bsky.social');
		mgr.addPlayer('test-hand', RIKKI, 'rikkiwildside.bsky.social');
		await mgr.startGameById('test-hand');

		dm._dms.length = 0; // clear startup DMs

		const err = await mgr.handleHandRequest(BOBBY);
		expect(err).toBeNull();

		expect(dm._dms).toHaveLength(1);
		expect(dm._dms[0]!.did).toBe(BOBBY);
		expect(dm._dms[0]!.text).toContain('Your cards');
	});

	it('auto-advances on timeout', async () => {
		await mgr.newGame('test-timeout');
		mgr.addPlayer('test-timeout', BOBBY, 'bobbyquine.bsky.social');
		mgr.addPlayer('test-timeout', RIKKI, 'rikkiwildside.bsky.social');
		await mgr.startGameById('test-timeout');

		// Bobby claims tax
		await mgr.handleAction('test-timeout', BOBBY, 'tax', null, 'u', 'c');
		let updated = mgr.getGame('test-timeout')!;
		expect(updated.turnPhase).toBe('challenge_window');

		// Simulate time passing beyond the challenge window
		const futureTime = Date.now() + 100_000; // 100s > 90s challenge window
		await mgr.tick(futureTime);

		updated = mgr.getGame('test-timeout')!;
		// Should have auto-advanced past challenge window
		expect(updated.turnPhase).not.toBe('challenge_window');
	});

	it('abandons game after 30 minutes of inactivity', async () => {
		await mgr.newGame('test-abandon');
		mgr.addPlayer('test-abandon', BOBBY, 'bobbyquine.bsky.social');
		mgr.addPlayer('test-abandon', RIKKI, 'rikkiwildside.bsky.social');
		await mgr.startGameById('test-abandon');

		const futureTime = Date.now() + 31 * 60 * 1000; // 31 minutes
		await mgr.tick(futureTime);

		const updated = mgr.getGame('test-abandon')!;
		expect(updated.status).toBe('finished');
		expect(updated.winner).toBeNull(); // no winner on timeout

		const abandonPost = allPosts.find((p) => p.text.includes('abandoned'));
		expect(abandonPost).toBeDefined();
	});

	it('rejects duplicate queue entry', async () => {
		await mgr.addToQueue(BOBBY, 'bobbyquine.bsky.social', 'u', 'c');
		await mgr.addToQueue(BOBBY, 'bobbyquine.bsky.social', 'u', 'c');

		const dupePost = allPosts.find((p) => p.text.includes('already in the queue'));
		expect(dupePost).toBeDefined();
	});

	it('rejects action from wrong player', async () => {
		await mgr.newGame('test-wrong');
		mgr.addPlayer('test-wrong', BOBBY, 'bobbyquine.bsky.social');
		mgr.addPlayer('test-wrong', RIKKI, 'rikkiwildside.bsky.social');
		await mgr.startGameById('test-wrong');

		// It's Bobby's turn — Rikki tries to act
		const err = await mgr.handleAction('test-wrong', RIKKI, 'income', null, 'u', 'c');
		expect(err).toContain('Not your turn');
	});
});
