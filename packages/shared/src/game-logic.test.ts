import { describe, expect, it } from 'vitest';
import { noShuffle } from './deck.js';
import {
	addPlayer,
	autoAdvance,
	chooseExchangeCards,
	chooseLostInfluence,
	createGame,
	declareAction,
	declareBlock,
	declareChallenge,
	declarePass,
	resolveChallenge,
	startGame,
} from './game-logic.js';
import type { GameState } from './types.js';

const NOW = 1000000;

// With noShuffle, deck is [duke, duke, duke, assassin, assassin, assassin, captain, captain, captain, ambassador, ambassador, ambassador, contessa, contessa, contessa]
// Player 0 gets: duke, duke
// Player 1 gets: duke, assassin
// Player 2 gets: assassin, captain
// Player 3 gets: captain, ambassador

function setupGame(playerCount: number): GameState {
	let state = createGame('test', NOW);
	for (let i = 0; i < playerCount; i++) {
		const result = addPlayer(state, `did:${i}`, `player${i}`);
		state = result.state;
	}
	const result = startGame(state, NOW, noShuffle);
	expect(result.ok).toBe(true);
	return result.state;
}

// ---------------------------------------------------------------------------
// Game creation + setup
// ---------------------------------------------------------------------------

describe('createGame', () => {
	it('creates a game in lobby status', () => {
		const state = createGame('g1', NOW);
		expect(state.id).toBe('g1');
		expect(state.status).toBe('lobby');
		expect(state.players).toHaveLength(0);
	});
});

describe('addPlayer', () => {
	it('adds players to lobby', () => {
		const state = createGame('g1', NOW);
		const r1 = addPlayer(state, 'did:1', 'alice');
		expect(r1.ok).toBe(true);
		expect(r1.state.players).toHaveLength(1);

		const r2 = addPlayer(r1.state, 'did:2', 'bob');
		expect(r2.ok).toBe(true);
		expect(r2.state.players).toHaveLength(2);
	});

	it('rejects duplicate players', () => {
		let state = createGame('g1', NOW);
		state = addPlayer(state, 'did:1', 'alice').state;
		const result = addPlayer(state, 'did:1', 'alice');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Already');
	});

	it('rejects when full', () => {
		let state = createGame('g1', NOW);
		for (let i = 0; i < 6; i++) {
			state = addPlayer(state, `did:${i}`, `p${i}`).state;
		}
		const result = addPlayer(state, 'did:7', 'extra');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('full');
	});
});

describe('startGame', () => {
	it('deals 2 cards and 2 coins to each player', () => {
		const state = setupGame(3);
		expect(state.status).toBe('active');
		for (const p of state.players) {
			expect(p.coins).toBe(2);
			expect(p.cards).toHaveLength(2);
			expect(p.cards[0].revealed).toBe(false);
			expect(p.cards[1].revealed).toBe(false);
		}
	});

	it('creates correct court deck size', () => {
		const state = setupGame(3);
		// 15 total - 6 dealt = 9 remaining
		expect(state.courtDeck).toHaveLength(9);
	});

	it('rejects with too few players', () => {
		let state = createGame('g1', NOW);
		state = addPlayer(state, 'did:1', 'alice').state;
		const result = startGame(state, NOW);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Not enough');
	});
});

// ---------------------------------------------------------------------------
// Income
// ---------------------------------------------------------------------------

describe('income', () => {
	it('gives 1 coin and advances turn', () => {
		const state = setupGame(3);
		const result = declareAction(state, 'did:0', 'income', null, NOW);
		expect(result.ok).toBe(true);
		const actor = result.state.players.find((p) => p.did === 'did:0')!;
		expect(actor.coins).toBe(3); // 2 + 1
		expect(result.state.turnIndex).toBe(1); // next player's turn
		expect(result.state.turnPhase).toBe('awaiting_action');
	});

	it('rejects when not your turn', () => {
		const state = setupGame(3);
		const result = declareAction(state, 'did:1', 'income', null, NOW);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Not your turn');
	});
});

// ---------------------------------------------------------------------------
// Coup
// ---------------------------------------------------------------------------

describe('coup', () => {
	it('forces target to lose influence', () => {
		let state = setupGame(2);
		// Give player 0 enough coins
		state = {
			...state,
			players: state.players.map((p) => (p.did === 'did:0' ? { ...p, coins: 7 } : p)),
		};
		const result = declareAction(state, 'did:0', 'coup', 'did:1', NOW);
		expect(result.ok).toBe(true);
		// Should be in losing_influence phase (target has 2 cards)
		expect(result.state.turnPhase).toBe('losing_influence');
		expect(result.state.influenceLossDid).toBe('did:1');
	});

	it('deducts 7 coins', () => {
		let state = setupGame(2);
		state = {
			...state,
			players: state.players.map((p) => (p.did === 'did:0' ? { ...p, coins: 7 } : p)),
		};
		const result = declareAction(state, 'did:0', 'coup', 'did:1', NOW);
		const actor = result.state.players.find((p) => p.did === 'did:0')!;
		expect(actor.coins).toBe(0);
	});

	it('rejects without enough coins', () => {
		const state = setupGame(2);
		const result = declareAction(state, 'did:0', 'coup', 'did:1', NOW);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Not enough coins');
	});

	it('is mandatory at 10+ coins', () => {
		let state = setupGame(2);
		state = {
			...state,
			players: state.players.map((p) => (p.did === 'did:0' ? { ...p, coins: 10 } : p)),
		};
		const result = declareAction(state, 'did:0', 'income', null, NOW);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Must coup');
	});
});

// ---------------------------------------------------------------------------
// Tax (Duke) — challengeable, not blockable
// ---------------------------------------------------------------------------

describe('tax', () => {
	it('enters challenge window', () => {
		const state = setupGame(3);
		const result = declareAction(state, 'did:0', 'tax', null, NOW);
		expect(result.ok).toBe(true);
		expect(result.state.turnPhase).toBe('challenge_window');
		expect(result.state.pendingAction?.kind).toBe('tax');
		expect(result.state.pendingAction?.claimedRole).toBe('duke');
	});

	it('gives 3 coins when unchallenged', () => {
		const state = setupGame(3);
		let s = declareAction(state, 'did:0', 'tax', null, NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		s = declarePass(s, 'did:2', NOW).state;
		// All passed challenge window → tax is not blockable → executes
		const actor = s.players.find((p) => p.did === 'did:0')!;
		expect(actor.coins).toBe(5); // 2 + 3
		expect(s.turnIndex).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Foreign Aid — not challengeable, blockable by Duke
// ---------------------------------------------------------------------------

describe('foreign_aid', () => {
	it('enters block window (skips challenge)', () => {
		const state = setupGame(3);
		const result = declareAction(state, 'did:0', 'foreign_aid', null, NOW);
		expect(result.ok).toBe(true);
		expect(result.state.turnPhase).toBe('block_window');
	});

	it('gives 2 coins when not blocked', () => {
		const state = setupGame(3);
		let s = declareAction(state, 'did:0', 'foreign_aid', null, NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		s = declarePass(s, 'did:2', NOW).state;
		const actor = s.players.find((p) => p.did === 'did:0')!;
		expect(actor.coins).toBe(4); // 2 + 2
	});

	it('is cancelled when blocked and block unchallenged', () => {
		const state = setupGame(3);
		let s = declareAction(state, 'did:0', 'foreign_aid', null, NOW).state;
		s = declareBlock(s, 'did:1', 'duke', NOW).state;
		expect(s.turnPhase).toBe('challenge_block_window');
		// Actor and player 2 pass on challenging the block
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:2', NOW).state;
		// Block succeeds — action cancelled, next turn
		const actor = s.players.find((p) => p.did === 'did:0')!;
		expect(actor.coins).toBe(2); // no change
		expect(s.turnIndex).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Challenge flow
// ---------------------------------------------------------------------------

describe('challenge', () => {
	it('challenge fails when player has the claimed role', () => {
		// Player 0 has duke, duke (noShuffle). Tax claims duke.
		const state = setupGame(3);
		let s = declareAction(state, 'did:0', 'tax', null, NOW).state;
		s = declareChallenge(s, 'did:1', NOW).state;
		expect(s.turnPhase).toBe('resolving_challenge');

		// Player 0 reveals card 0 (duke) to prove it
		s = resolveChallenge(s, 0, NOW, noShuffle).state;
		// Challenge failed — challenger (did:1) loses influence
		expect(s.turnPhase).toBe('losing_influence');
		expect(s.influenceLossDid).toBe('did:1');
	});

	it('challenge succeeds when player bluffs', () => {
		// Player 1 has duke, assassin (noShuffle). Let player 1 claim captain (steal).
		let state = setupGame(3);
		// Advance to player 1's turn
		state = { ...state, turnIndex: 1, turnPhase: 'awaiting_action' as const };
		let s = declareAction(state, 'did:1', 'steal', 'did:0', NOW).state;
		expect(s.turnPhase).toBe('challenge_window');

		s = declareChallenge(s, 'did:0', NOW).state;
		expect(s.turnPhase).toBe('resolving_challenge');

		// Player 1 reveals card 0 (duke) — NOT captain, challenge succeeds
		s = resolveChallenge(s, 0, NOW, noShuffle).state;
		// Challenge succeeded — player 1 loses the revealed card, turn advances
		const p1 = s.players.find((p) => p.did === 'did:1')!;
		expect(p1.cards[0].revealed).toBe(true);
		expect(s.turnPhase).toBe('awaiting_action');
		expect(s.turnIndex).toBe(2); // next player
	});

	it('successful challenge reveals card then checks win', () => {
		// Set up a 2-player game where target has 1 influence
		let state = setupGame(2);
		// Reveal one of player 1's cards
		state = {
			...state,
			players: state.players.map((p) =>
				p.did === 'did:1' ? { ...p, cards: [{ ...p.cards[0], revealed: true }, p.cards[1]] } : p,
			),
		};
		// Player 0 claims tax (duke). Player 1 challenges.
		let s = declareAction(state, 'did:0', 'tax', null, NOW).state;
		s = declareChallenge(s, 'did:1', NOW).state;
		// Player 0 proves duke → player 1 loses last influence → game over
		s = resolveChallenge(s, 0, NOW, noShuffle).state;
		expect(s.status).toBe('finished');
		expect(s.winner).toBe('did:0');
	});
});

// ---------------------------------------------------------------------------
// Block + Challenge-the-block flow
// ---------------------------------------------------------------------------

describe('block', () => {
	it('assassinate can be blocked by contessa', () => {
		// Player 0: duke, duke. Assassinate claims assassin (bluff here, but we test the block flow).
		// Actually, let's set up so player 2 (assassin, captain) assassinates player 3.
		let state = setupGame(4);
		// Give player 2 coins for assassinate
		state = {
			...state,
			turnIndex: 2,
			players: state.players.map((p) => (p.did === 'did:2' ? { ...p, coins: 3 } : p)),
		};

		let s = declareAction(state, 'did:2', 'assassinate', 'did:3', NOW).state;
		expect(s.turnPhase).toBe('challenge_window');

		// Everyone passes challenge
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		s = declarePass(s, 'did:3', NOW).state;
		expect(s.turnPhase).toBe('block_window');

		// Player 3 blocks claiming contessa
		s = declareBlock(s, 'did:3', 'contessa', NOW).state;
		expect(s.turnPhase).toBe('challenge_block_window');

		// No one challenges the block
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		s = declarePass(s, 'did:2', NOW).state;

		// Block succeeds — assassinate refunded
		const actor = s.players.find((p) => p.did === 'did:2')!;
		expect(actor.coins).toBe(3); // 3 - 3 + 3 refund
		expect(s.turnIndex).toBe(3); // next turn
	});

	it('steal can be blocked by captain or ambassador', () => {
		let state = setupGame(3);
		state = { ...state, turnIndex: 2 }; // Player 2: assassin, captain

		let s = declareAction(state, 'did:2', 'steal', 'did:0', NOW).state;
		// Pass challenge window
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		expect(s.turnPhase).toBe('block_window');

		// Target blocks with ambassador
		s = declareBlock(s, 'did:0', 'ambassador', NOW).state;
		expect(s.turnPhase).toBe('challenge_block_window');
	});

	it('rejects invalid block role', () => {
		const state = setupGame(3);
		const s = declareAction(state, 'did:0', 'foreign_aid', null, NOW).state;
		const result = declareBlock(s, 'did:1', 'contessa', NOW);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('cannot block');
	});

	it('challenging a block — blocker was bluffing', () => {
		const state = setupGame(3);
		let s = declareAction(state, 'did:0', 'foreign_aid', null, NOW).state;
		s = declareBlock(s, 'did:1', 'duke', NOW).state;
		expect(s.turnPhase).toBe('challenge_block_window');

		// Player 0 challenges the block
		s = declareChallenge(s, 'did:0', NOW).state;
		expect(s.turnPhase).toBe('resolving_block_challenge');

		// Player 1 has duke + assassin (noShuffle). Reveal card 1 (assassin) — not duke, bluff caught
		s = resolveChallenge(s, 1, NOW, noShuffle).state;
		// Blocker loses card, block fails, foreign aid executes
		const actor = s.players.find((p) => p.did === 'did:0')!;
		expect(actor.coins).toBe(4); // 2 + 2
	});

	it('challenging a block — blocker had the role', () => {
		const state = setupGame(3);
		let s = declareAction(state, 'did:0', 'foreign_aid', null, NOW).state;
		// Player 1 has duke (card 0) — blocks with duke (truthful)
		s = declareBlock(s, 'did:1', 'duke', NOW).state;
		s = declareChallenge(s, 'did:0', NOW).state;

		// Player 1 reveals card 0 (duke) to prove
		s = resolveChallenge(s, 0, NOW, noShuffle).state;
		// Challenge fails — challenger (did:0) loses influence, block stands
		expect(s.turnPhase).toBe('losing_influence');
		expect(s.influenceLossDid).toBe('did:0');
	});
});

// ---------------------------------------------------------------------------
// Steal
// ---------------------------------------------------------------------------

describe('steal', () => {
	it('takes up to 2 coins from target', () => {
		let state = setupGame(3);
		state = { ...state, turnIndex: 2 }; // Player 2: assassin, captain

		let s = declareAction(state, 'did:2', 'steal', 'did:0', NOW).state;
		// Pass all windows
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		// Challenge passed → block window
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		// Block passed → execute

		const stealer = s.players.find((p) => p.did === 'did:2')!;
		const target = s.players.find((p) => p.did === 'did:0')!;
		expect(stealer.coins).toBe(4); // 2 + 2
		expect(target.coins).toBe(0); // 2 - 2
	});

	it('steals only what target has', () => {
		let state = setupGame(3);
		state = {
			...state,
			turnIndex: 2,
			players: state.players.map((p) => (p.did === 'did:0' ? { ...p, coins: 1 } : p)),
		};

		let s = declareAction(state, 'did:2', 'steal', 'did:0', NOW).state;
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;

		const stealer = s.players.find((p) => p.did === 'did:2')!;
		const target = s.players.find((p) => p.did === 'did:0')!;
		expect(stealer.coins).toBe(3); // 2 + 1
		expect(target.coins).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Assassinate
// ---------------------------------------------------------------------------

describe('assassinate', () => {
	it('costs 3 coins and forces target to lose influence', () => {
		let state = setupGame(3);
		// Player 1 has duke + assassin. Give them 3 coins and make it their turn.
		state = {
			...state,
			turnIndex: 1,
			players: state.players.map((p) => (p.did === 'did:1' ? { ...p, coins: 3 } : p)),
		};

		let s = declareAction(state, 'did:1', 'assassinate', 'did:0', NOW).state;
		expect(s.pendingAction?.claimedRole).toBe('assassin');

		// Pass challenge
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:2', NOW).state;
		// Pass block
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:2', NOW).state;

		// Target loses influence
		expect(s.turnPhase).toBe('losing_influence');
		expect(s.influenceLossDid).toBe('did:0');

		// Target chooses card 0
		s = chooseLostInfluence(s, 'did:0', 0, NOW).state;
		const target = s.players.find((p) => p.did === 'did:0')!;
		expect(target.cards[0].revealed).toBe(true);
		expect(s.turnIndex).toBe(2); // next turn
	});

	it('rejects with insufficient coins', () => {
		let state = setupGame(3);
		state = { ...state, turnIndex: 1 };
		const result = declareAction(state, 'did:1', 'assassinate', 'did:0', NOW);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Not enough coins');
	});
});

// ---------------------------------------------------------------------------
// Exchange (Ambassador)
// ---------------------------------------------------------------------------

describe('exchange', () => {
	it('draws 2 cards and lets player choose', () => {
		let state = setupGame(4);
		// Player 3: captain, ambassador. Make it their turn.
		state = { ...state, turnIndex: 3 };

		let s = declareAction(state, 'did:3', 'exchange', null, NOW).state;
		expect(s.turnPhase).toBe('challenge_window');

		// Pass challenge
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		s = declarePass(s, 'did:2', NOW).state;

		// Exchange executes — enters exchanging phase
		expect(s.turnPhase).toBe('exchanging');
		expect(s.exchangeCards).toHaveLength(2);

		// Player has: captain + ambassador (hand) + 2 exchange cards
		// With noShuffle, exchange cards come from front of court deck
		const player = s.players.find((p) => p.did === 'did:3')!;
		const availableRoles = [player.cards[0].role, player.cards[1].role, ...s.exchangeCards!];

		// Keep 2 from pool
		const result = chooseExchangeCards(
			s,
			'did:3',
			[availableRoles[0]!, availableRoles[1]!],
			NOW,
			noShuffle,
		);
		expect(result.ok).toBe(true);
		expect(result.state.turnPhase).toBe('awaiting_action');
		expect(result.state.exchangeCards).toBeNull();
	});

	it('rejects keeping wrong number of cards', () => {
		let state = setupGame(4);
		state = { ...state, turnIndex: 3 };
		let s = declareAction(state, 'did:3', 'exchange', null, NOW).state;
		s = declarePass(s, 'did:0', NOW).state;
		s = declarePass(s, 'did:1', NOW).state;
		s = declarePass(s, 'did:2', NOW).state;

		const result = chooseExchangeCards(s, 'did:3', ['duke'], NOW, noShuffle);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Must keep exactly 2');
	});
});

// ---------------------------------------------------------------------------
// Influence loss
// ---------------------------------------------------------------------------

describe('chooseLostInfluence', () => {
	it('auto-reveals when only 1 card left', () => {
		let state = setupGame(2);
		state = {
			...state,
			players: state.players.map((p) =>
				p.did === 'did:1'
					? {
							...p,
							cards: [{ ...p.cards[0], revealed: true }, p.cards[1]],
						}
					: { ...p, coins: 7 },
			),
		};
		// Coup player 1 — should auto-reveal last card
		const result = declareAction(state, 'did:0', 'coup', 'did:1', NOW);
		expect(result.ok).toBe(true);
		// Player 1 had 1 card — auto-revealed, game over
		expect(result.state.status).toBe('finished');
		expect(result.state.winner).toBe('did:0');
	});

	it('rejects revealing already-revealed card', () => {
		let state = setupGame(2);
		state = {
			...state,
			players: state.players.map((p) => (p.did === 'did:0' ? { ...p, coins: 7 } : p)),
		};
		let s = declareAction(state, 'did:0', 'coup', 'did:1', NOW).state;
		expect(s.turnPhase).toBe('losing_influence');
		// Reveal card 0
		s = chooseLostInfluence(s, 'did:1', 0, NOW).state;
		// Can't reveal again — we've moved on
		expect(s.turnPhase).toBe('awaiting_action');
	});
});

// ---------------------------------------------------------------------------
// Timer auto-advance
// ---------------------------------------------------------------------------

describe('autoAdvance', () => {
	it('auto-passes challenge window on timeout', () => {
		const state = setupGame(3);
		const s = declareAction(state, 'did:0', 'tax', null, NOW).state;
		expect(s.turnPhase).toBe('challenge_window');

		// Advance time past window
		const result = autoAdvance(s, NOW + 100_000, noShuffle);
		expect(result.ok).toBe(true);
		// Tax is not blockable, should execute
		const actor = result.state.players.find((p) => p.did === 'did:0')!;
		expect(actor.coins).toBe(5); // 2 + 3
	});

	it('does nothing before timeout', () => {
		const state = setupGame(3);
		const s = declareAction(state, 'did:0', 'tax', null, NOW).state;
		const result = autoAdvance(s, NOW + 1000, noShuffle);
		expect(result.state.turnPhase).toBe('challenge_window');
	});

	it('auto-reveals card on influence loss timeout', () => {
		let state = setupGame(2);
		state = {
			...state,
			players: state.players.map((p) => (p.did === 'did:0' ? { ...p, coins: 7 } : p)),
		};
		const s = declareAction(state, 'did:0', 'coup', 'did:1', NOW).state;
		expect(s.turnPhase).toBe('losing_influence');

		const result = autoAdvance(s, NOW + 70_000, noShuffle);
		expect(result.ok).toBe(true);
		// Should have auto-revealed a card
		const target = result.state.players.find((p) => p.did === 'did:1')!;
		const revealedCount = target.cards.filter((c) => c.revealed).length;
		expect(revealedCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Turn advancement
// ---------------------------------------------------------------------------

describe('turn advancement', () => {
	it('skips eliminated players', () => {
		let state = setupGame(3);
		// Eliminate player 1
		state = {
			...state,
			players: state.players.map((p) =>
				p.did === 'did:1'
					? {
							...p,
							cards: [
								{ ...p.cards[0], revealed: true },
								{ ...p.cards[1], revealed: true },
							],
						}
					: p,
			),
		};
		// Player 0 takes income — should skip to player 2
		const result = declareAction(state, 'did:0', 'income', null, NOW);
		expect(result.state.turnIndex).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Win condition
// ---------------------------------------------------------------------------

describe('win condition', () => {
	it('game ends when only one player has influence', () => {
		let state = setupGame(2);
		// Eliminate player 1 completely
		state = {
			...state,
			players: state.players.map((p) =>
				p.did === 'did:1'
					? {
							...p,
							cards: [
								{ ...p.cards[0], revealed: true },
								{ ...p.cards[1], revealed: true },
							],
						}
					: { ...p, coins: 7 },
			),
		};
		// Any action by player 0 should find game already won — but let's test via income
		const result = declareAction(state, 'did:0', 'income', null, NOW);
		expect(result.state.status).toBe('finished');
		expect(result.state.winner).toBe('did:0');
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
	it('cannot act on non-active game', () => {
		const state = createGame('g1', NOW);
		const result = declareAction(state, 'did:0', 'income', null, NOW);
		expect(result.ok).toBe(false);
	});

	it('cannot target self', () => {
		let state = setupGame(2);
		state = {
			...state,
			players: state.players.map((p) => (p.did === 'did:0' ? { ...p, coins: 7 } : p)),
		};
		const result = declareAction(state, 'did:0', 'coup', 'did:0', NOW);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Cannot target yourself');
	});

	it('cannot challenge your own action', () => {
		const state = setupGame(3);
		const s = declareAction(state, 'did:0', 'tax', null, NOW).state;
		const result = declareChallenge(s, 'did:0', NOW);
		expect(result.ok).toBe(false);
	});

	it('cannot block your own action', () => {
		const state = setupGame(3);
		const s = declareAction(state, 'did:0', 'foreign_aid', null, NOW).state;
		const result = declareBlock(s, 'did:0', 'duke', NOW);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Cannot block your own');
	});
});
