import {
	type ShuffleFn,
	createDeck,
	dealCards,
	fisherYatesShuffle,
	returnAndShuffle,
} from './deck.js';
import {
	ACTION_CLAIMS,
	ACTION_COSTS,
	type ActionKind,
	BLOCK_RULES,
	type CardRole,
	DEFAULT_CONFIG,
	type Did,
	type GameConfig,
	type GameResult,
	type GameState,
	type Player,
	type TurnPhase,
	influenceCount,
	isEliminated,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(state: GameState): GameResult {
	return { ok: true, state };
}

function err(state: GameState, error: string): GameResult {
	return { ok: false, error, state };
}

function getPlayer(state: GameState, did: Did): Player | undefined {
	return state.players.find((p) => p.did === did);
}

function alivePlayers(state: GameState): Player[] {
	return state.players.filter((p) => !isEliminated(p));
}

function currentPlayer(state: GameState): Player {
	return state.players[state.turnIndex]!;
}

/** DIDs of alive players who are eligible to respond in a challenge/block window */
function eligibleResponders(state: GameState, excludeDid: Did): Did[] {
	return alivePlayers(state)
		.filter((p) => p.did !== excludeDid)
		.map((p) => p.did);
}

function allEligibleHavePassed(state: GameState, excludeDid: Did): boolean {
	const eligible = eligibleResponders(state, excludeDid);
	return eligible.every((did) => state.passedDids.includes(did));
}

function setPhase(state: GameState, phase: TurnPhase, now: number): GameState {
	return { ...state, turnPhase: phase, phaseStartedAt: now, passedDids: [] };
}

function nextAliveIndex(state: GameState): number {
	const { players } = state;
	let idx = (state.turnIndex + 1) % players.length;
	// Wrap around to find next alive player
	for (let i = 0; i < players.length; i++) {
		if (!isEliminated(players[idx]!)) return idx;
		idx = (idx + 1) % players.length;
	}
	return state.turnIndex; // shouldn't happen if game isn't over
}

function checkWinner(state: GameState): GameState {
	const alive = alivePlayers(state);
	if (alive.length === 1) {
		return { ...state, status: 'finished', winner: alive[0]!.did };
	}
	return state;
}

function advanceTurn(state: GameState, now: number): GameState {
	const checked = checkWinner(state);
	if (checked.status === 'finished') return checked;
	return {
		...checked,
		turnIndex: nextAliveIndex(checked),
		turnPhase: 'awaiting_action',
		pendingAction: null,
		pendingBlock: null,
		pendingChallenge: null,
		passedDids: [],
		influenceLossDid: null,
		influenceLossReason: null,
		exchangeCards: null,
		phaseStartedAt: now,
	};
}

/** Reveal a player's card at the given index */
function revealCard(state: GameState, did: Did, cardIndex: number): GameState {
	return {
		...state,
		players: state.players.map((p) => {
			if (p.did !== did) return p;
			const newCards = [...p.cards] as [(typeof p.cards)[0], (typeof p.cards)[1]];
			newCards[cardIndex] = { ...newCards[cardIndex]!, revealed: true };
			return { ...p, cards: newCards };
		}),
	};
}

/** Shuffle a revealed card back into the deck and draw a new one */
function shuffleBackAndDraw(
	state: GameState,
	did: Did,
	cardIndex: number,
	shuffle: ShuffleFn = fisherYatesShuffle,
): GameState {
	const player = getPlayer(state, did)!;
	const oldRole = player.cards[cardIndex]!.role;
	const newDeck = returnAndShuffle(state.courtDeck, [oldRole], shuffle);
	const [newRole, ...remaining] = newDeck;
	return {
		...state,
		courtDeck: remaining,
		players: state.players.map((p) => {
			if (p.did !== did) return p;
			const newCards = [...p.cards] as [(typeof p.cards)[0], (typeof p.cards)[1]];
			newCards[cardIndex] = { role: newRole!, revealed: false };
			return { ...p, cards: newCards };
		}),
	};
}

// ---------------------------------------------------------------------------
// Game creation + setup
// ---------------------------------------------------------------------------

export function createGame(
	id: string,
	now: number,
	config: GameConfig = DEFAULT_CONFIG,
): GameState {
	return {
		id,
		config,
		status: 'lobby',
		players: [],
		turnIndex: 0,
		turnPhase: 'awaiting_action',
		pendingAction: null,
		pendingBlock: null,
		pendingChallenge: null,
		passedDids: [],
		influenceLossDid: null,
		influenceLossReason: null,
		exchangeCards: null,
		courtDeck: [],
		phaseStartedAt: now,
		createdAt: now,
		winner: null,
		announcementUri: null,
		announcementCid: null,
	};
}

export function addPlayer(state: GameState, did: Did, handle: Handle): GameResult {
	if (state.status !== 'lobby') return err(state, 'Game is not in lobby');
	if (state.players.length >= state.config.maxPlayers) return err(state, 'Game is full');
	if (state.players.some((p) => p.did === did)) return err(state, 'Already in game');
	const player: Player = {
		did,
		handle,
		coins: 2,
		cards: [
			{ role: 'duke', revealed: true },
			{ role: 'duke', revealed: true },
		], // placeholder, dealt at start
	};
	return ok({ ...state, players: [...state.players, player] });
}

export function startGame(
	state: GameState,
	now: number,
	shuffle: ShuffleFn = fisherYatesShuffle,
): GameResult {
	if (state.status !== 'lobby') return err(state, 'Game is not in lobby');
	if (state.players.length < state.config.minPlayers) return err(state, 'Not enough players');

	let deck = shuffle(createDeck());
	const players: Player[] = state.players.map((p) => {
		const { dealt, remaining } = dealCards(deck, 2);
		deck = remaining;
		return {
			...p,
			coins: 2,
			cards: [
				{ role: dealt[0]!, revealed: false },
				{ role: dealt[1]!, revealed: false },
			],
		};
	});

	return ok({
		...state,
		status: 'active',
		players,
		courtDeck: deck,
		turnIndex: 0,
		turnPhase: 'awaiting_action',
		phaseStartedAt: now,
	});
}

// ---------------------------------------------------------------------------
// Declare an action
// ---------------------------------------------------------------------------

export function declareAction(
	state: GameState,
	actorDid: Did,
	kind: ActionKind,
	targetDid: Did | null,
	now: number,
): GameResult {
	if (state.status !== 'active') return err(state, 'Game is not active');
	if (state.turnPhase !== 'awaiting_action') return err(state, 'Not awaiting action');

	const actor = getPlayer(state, actorDid);
	if (!actor) return err(state, 'Player not in game');
	if (isEliminated(actor)) return err(state, 'Player is eliminated');
	if (currentPlayer(state).did !== actorDid) return err(state, 'Not your turn');

	// Must coup at 10+ coins
	if (actor.coins >= 10 && kind !== 'coup') return err(state, 'Must coup with 10+ coins');

	const cost = ACTION_COSTS[kind];
	if (actor.coins < cost) return err(state, `Not enough coins (need ${cost}, have ${actor.coins})`);

	// Validate target
	const needsTarget = kind === 'coup' || kind === 'assassinate' || kind === 'steal';
	if (needsTarget && !targetDid) return err(state, 'Action requires a target');
	if (!needsTarget && targetDid) return err(state, 'Action does not take a target');
	if (targetDid) {
		const target = getPlayer(state, targetDid);
		if (!target) return err(state, 'Target not in game');
		if (isEliminated(target)) return err(state, 'Target is eliminated');
		if (targetDid === actorDid) return err(state, 'Cannot target yourself');
	}

	// Deduct cost immediately
	const updatedPlayers = state.players.map((p) =>
		p.did === actorDid ? { ...p, coins: p.coins - cost } : p,
	);

	const claimedRole = ACTION_CLAIMS[kind];
	const pendingAction = { kind, actorDid, targetDid, claimedRole };
	const updated: GameState = { ...state, players: updatedPlayers, pendingAction };

	// Income and Coup can't be challenged or blocked — execute immediately
	if (kind === 'income') {
		return executeAction(updated, now);
	}
	if (kind === 'coup') {
		return executeAction(updated, now);
	}

	// Actions with a role claim go to challenge window
	if (claimedRole) {
		return ok(setPhase({ ...updated }, 'challenge_window', now));
	}

	// Foreign aid: no claim but blockable — skip challenge, go to block window
	const blockRoles = BLOCK_RULES[kind];
	if (blockRoles && blockRoles.length > 0) {
		return ok(setPhase({ ...updated }, 'block_window', now));
	}

	// Shouldn't reach here with standard rules
	return executeAction(updated, now);
}

// ---------------------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------------------

export function declareChallenge(state: GameState, challengerDid: Did, now: number): GameResult {
	if (state.turnPhase !== 'challenge_window' && state.turnPhase !== 'challenge_block_window') {
		return err(state, 'No challenge window open');
	}

	const challenger = getPlayer(state, challengerDid);
	if (!challenger || isEliminated(challenger)) return err(state, 'Invalid challenger');

	// Determine who is being challenged and what role they claimed
	let targetDid: Did;
	let claimedRole: CardRole;
	let nextPhase: TurnPhase;

	if (state.turnPhase === 'challenge_window') {
		if (!state.pendingAction?.claimedRole) return err(state, 'Nothing to challenge');
		targetDid = state.pendingAction.actorDid;
		claimedRole = state.pendingAction.claimedRole;
		nextPhase = 'resolving_challenge';
		if (challengerDid === targetDid) return err(state, 'Cannot challenge yourself');
	} else {
		if (!state.pendingBlock) return err(state, 'No block to challenge');
		targetDid = state.pendingBlock.blockerDid;
		claimedRole = state.pendingBlock.claimedRole;
		nextPhase = 'resolving_block_challenge';
		if (challengerDid === targetDid) return err(state, 'Cannot challenge yourself');
	}

	return ok({
		...setPhase(state, nextPhase, now),
		pendingChallenge: { challengerDid, targetDid, claimedRole },
	});
}

// ---------------------------------------------------------------------------
// Resolve challenge — the challenged player reveals a card
// ---------------------------------------------------------------------------

export function resolveChallenge(
	state: GameState,
	revealedCardIndex: number,
	now: number,
	shuffle: ShuffleFn = fisherYatesShuffle,
): GameResult {
	if (
		state.turnPhase !== 'resolving_challenge' &&
		state.turnPhase !== 'resolving_block_challenge'
	) {
		return err(state, 'Not resolving a challenge');
	}

	const challenge = state.pendingChallenge;
	if (!challenge) return err(state, 'No pending challenge');

	const challenged = getPlayer(state, challenge.targetDid);
	if (!challenged) return err(state, 'Challenged player not found');

	const card = challenged.cards[revealedCardIndex];
	if (!card) return err(state, 'Invalid card index');
	if (card.revealed) return err(state, 'Card already revealed');

	const isResolvingAction = state.turnPhase === 'resolving_challenge';
	const hadTheRole = card.role === challenge.claimedRole;

	if (hadTheRole) {
		// Challenge fails — challenger loses influence, challenged shuffles back and draws new
		const updated = shuffleBackAndDraw(state, challenge.targetDid, revealedCardIndex, shuffle);

		// Challenger must lose influence
		return enterInfluenceLoss(
			updated,
			challenge.challengerDid,
			isResolvingAction ? 'challenge_lost' : 'block_challenge_lost',
			now,
		);
	}

	// Challenge succeeds — challenged loses the revealed card
	let updated = revealCard(state, challenge.targetDid, revealedCardIndex);
	updated = checkWinner(updated);
	if (updated.status === 'finished') return ok(updated);

	if (isResolvingAction) {
		// Action claim was false — action fails, advance turn
		return ok(advanceTurn(updated, now));
	}

	// Block claim was false — block fails, execute the original action
	return executeAction({ ...updated, pendingBlock: null, pendingChallenge: null }, now);
}

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------

export function declareBlock(
	state: GameState,
	blockerDid: Did,
	claimedRole: CardRole,
	now: number,
): GameResult {
	if (state.turnPhase !== 'block_window') return err(state, 'No block window open');

	const blocker = getPlayer(state, blockerDid);
	if (!blocker || isEliminated(blocker)) return err(state, 'Invalid blocker');

	if (!state.pendingAction) return err(state, 'No pending action');
	if (blockerDid === state.pendingAction.actorDid)
		return err(state, 'Cannot block your own action');

	const blockRoles = BLOCK_RULES[state.pendingAction.kind];
	if (!blockRoles || !blockRoles.includes(claimedRole)) {
		return err(state, `${claimedRole} cannot block ${state.pendingAction.kind}`);
	}

	// For targeted actions (steal, assassinate), only the target can block
	if (state.pendingAction.targetDid && blockerDid !== state.pendingAction.targetDid) {
		// Foreign aid can be blocked by anyone
		if (state.pendingAction.kind !== 'foreign_aid') {
			return err(state, 'Only the target can block this action');
		}
	}

	return ok({
		...setPhase(state, 'challenge_block_window', now),
		pendingBlock: { blockerDid, claimedRole },
	});
}

// ---------------------------------------------------------------------------
// Pass (challenge/block windows)
// ---------------------------------------------------------------------------

export function declarePass(state: GameState, passerDid: Did, now: number): GameResult {
	const validPhases: TurnPhase[] = ['challenge_window', 'block_window', 'challenge_block_window'];
	if (!validPhases.includes(state.turnPhase)) return err(state, 'No window to pass on');

	const passer = getPlayer(state, passerDid);
	if (!passer || isEliminated(passer)) return err(state, 'Invalid passer');
	if (state.passedDids.includes(passerDid)) return err(state, 'Already passed');

	const updated: GameState = { ...state, passedDids: [...state.passedDids, passerDid] };

	// Determine who we're excluding from the pass check
	let excludeDid: Did;
	if (state.turnPhase === 'challenge_window') {
		excludeDid = state.pendingAction!.actorDid;
	} else if (state.turnPhase === 'block_window') {
		// During block window, the actor already declined to challenge — exclude actor from block check
		// Actually: everyone except the actor's target can block foreign aid, but only target can block steal/assassinate
		// For simplicity, exclude the actor
		excludeDid = state.pendingAction!.actorDid;
	} else {
		// challenge_block_window — the blocker is excluded
		excludeDid = state.pendingBlock!.blockerDid;
	}

	if (passerDid === excludeDid) return err(updated, 'Cannot pass on your own action');

	if (!allEligibleHavePassed(updated, excludeDid)) {
		return ok(updated); // still waiting for others
	}

	// All eligible players passed — advance to next phase
	return advanceAfterAllPass(updated, now);
}

/** Called when all eligible players have passed (or timer expired) */
export function advanceAfterAllPass(state: GameState, now: number): GameResult {
	if (state.turnPhase === 'challenge_window') {
		// No one challenged — check if action is blockable
		const blockRoles = BLOCK_RULES[state.pendingAction!.kind];
		if (blockRoles && blockRoles.length > 0) {
			return ok(setPhase(state, 'block_window', now));
		}
		// Not blockable — execute
		return executeAction(state, now);
	}

	if (state.turnPhase === 'block_window') {
		// No one blocked — execute action
		return executeAction(state, now);
	}

	if (state.turnPhase === 'challenge_block_window') {
		// No one challenged the block — block succeeds, action is cancelled
		// Refund cost for assassinate (3 coins already deducted)
		let updated = state;
		if (state.pendingAction?.kind === 'assassinate') {
			updated = {
				...updated,
				players: updated.players.map((p) =>
					p.did === state.pendingAction!.actorDid ? { ...p, coins: p.coins + 3 } : p,
				),
			};
		}
		return ok(advanceTurn(updated, now));
	}

	return err(state, 'Unexpected phase for advanceAfterAllPass');
}

// ---------------------------------------------------------------------------
// Execute action
// ---------------------------------------------------------------------------

export function executeAction(state: GameState, now: number): GameResult {
	const action = state.pendingAction;
	if (!action) return err(state, 'No pending action');

	let updated = state;

	switch (action.kind) {
		case 'income': {
			updated = {
				...updated,
				players: updated.players.map((p) =>
					p.did === action.actorDid ? { ...p, coins: p.coins + 1 } : p,
				),
			};
			return ok(advanceTurn(updated, now));
		}

		case 'foreign_aid': {
			updated = {
				...updated,
				players: updated.players.map((p) =>
					p.did === action.actorDid ? { ...p, coins: p.coins + 2 } : p,
				),
			};
			return ok(advanceTurn(updated, now));
		}

		case 'tax': {
			updated = {
				...updated,
				players: updated.players.map((p) =>
					p.did === action.actorDid ? { ...p, coins: p.coins + 3 } : p,
				),
			};
			return ok(advanceTurn(updated, now));
		}

		case 'coup': {
			// Target must lose influence
			return enterInfluenceLoss(updated, action.targetDid!, 'coup', now);
		}

		case 'assassinate': {
			// Check if target is still alive (might have lost influence from challenge)
			const target = getPlayer(updated, action.targetDid!);
			if (!target || isEliminated(target)) {
				return ok(advanceTurn(updated, now));
			}
			return enterInfluenceLoss(updated, action.targetDid!, 'assassinate', now);
		}

		case 'steal': {
			const target = getPlayer(updated, action.targetDid!);
			if (!target) return err(updated, 'Steal target not found');
			const stolen = Math.min(2, target.coins);
			updated = {
				...updated,
				players: updated.players.map((p) => {
					if (p.did === action.actorDid) return { ...p, coins: p.coins + stolen };
					if (p.did === action.targetDid) return { ...p, coins: p.coins - stolen };
					return p;
				}),
			};
			return ok(advanceTurn(updated, now));
		}

		case 'exchange': {
			// Draw 2 cards from court deck
			const { dealt, remaining } = dealCards(updated.courtDeck, 2);
			updated = {
				...updated,
				courtDeck: remaining,
				exchangeCards: dealt,
				turnPhase: 'exchanging',
				phaseStartedAt: now,
				passedDids: [],
			};
			return ok(updated);
		}
	}
}

// ---------------------------------------------------------------------------
// Influence loss
// ---------------------------------------------------------------------------

function enterInfluenceLoss(
	state: GameState,
	targetDid: Did,
	reason: NonNullable<GameState['influenceLossReason']>,
	now: number,
): GameResult {
	const target = getPlayer(state, targetDid);
	if (!target || isEliminated(target)) {
		// Target already eliminated — skip
		return resolveAfterInfluenceLoss({ ...state, influenceLossReason: reason }, now);
	}

	// If target has only 1 unrevealed card, auto-reveal it
	if (influenceCount(target) === 1) {
		const autoIndex = target.cards[0]!.revealed ? 1 : 0;
		let updated = revealCard(state, targetDid, autoIndex);
		updated = { ...updated, influenceLossReason: reason };
		return resolveAfterInfluenceLoss(updated, now);
	}

	// Target must choose which card to reveal (via DM)
	return ok({
		...state,
		turnPhase: 'losing_influence',
		phaseStartedAt: now,
		passedDids: [],
		influenceLossDid: targetDid,
		influenceLossReason: reason,
	});
}

export function chooseLostInfluence(
	state: GameState,
	playerDid: Did,
	cardIndex: number,
	now: number,
): GameResult {
	if (state.turnPhase !== 'losing_influence') return err(state, 'Not in influence loss phase');
	if (state.influenceLossDid !== playerDid) return err(state, 'Not your influence to lose');

	const player = getPlayer(state, playerDid);
	if (!player) return err(state, 'Player not found');

	const card = player.cards[cardIndex];
	if (!card) return err(state, 'Invalid card index');
	if (card.revealed) return err(state, 'Card already revealed');

	const updated = revealCard(state, playerDid, cardIndex);
	return resolveAfterInfluenceLoss(updated, now);
}

/** After influence is lost, figure out what happens next */
function resolveAfterInfluenceLoss(state: GameState, now: number): GameResult {
	const updated = checkWinner(state);
	if (updated.status === 'finished') return ok(updated);

	const reason = updated.influenceLossReason;

	switch (reason) {
		case 'coup':
		case 'assassinate':
			// Action resolved, next turn
			return ok(advanceTurn(updated, now));

		// Challenger lost — action claim was true. Now check if action is blockable.
		case 'challenge_lost': {
			const blockRoles = BLOCK_RULES[updated.pendingAction!.kind];
			if (blockRoles && blockRoles.length > 0) {
				return ok(
					setPhase(
						{
							...updated,
							pendingChallenge: null,
							influenceLossDid: null,
							influenceLossReason: null,
						},
						'block_window',
						now,
					),
				);
			}
			return executeAction(
				{ ...updated, pendingChallenge: null, influenceLossDid: null, influenceLossReason: null },
				now,
			);
		}

		case 'challenge_won':
			// Challenged player lost (was bluffing) — action fails, next turn
			return ok(advanceTurn(updated, now));

		// Challenger of the block lost — block stands, action cancelled
		case 'block_challenge_lost': {
			let refunded = updated;
			if (updated.pendingAction?.kind === 'assassinate') {
				refunded = {
					...refunded,
					players: refunded.players.map((p) =>
						p.did === updated.pendingAction!.actorDid ? { ...p, coins: p.coins + 3 } : p,
					),
				};
			}
			return ok(advanceTurn(refunded, now));
		}

		case 'block_challenge_won':
			// Blocker was bluffing — block fails, execute action
			return executeAction(
				{
					...updated,
					pendingBlock: null,
					pendingChallenge: null,
					influenceLossDid: null,
					influenceLossReason: null,
				},
				now,
			);

		default:
			return ok(advanceTurn(updated, now));
	}
}

// ---------------------------------------------------------------------------
// Exchange (Ambassador)
// ---------------------------------------------------------------------------

export function chooseExchangeCards(
	state: GameState,
	playerDid: Did,
	keptRoles: CardRole[],
	now: number,
	shuffle: ShuffleFn = fisherYatesShuffle,
): GameResult {
	if (state.turnPhase !== 'exchanging') return err(state, 'Not in exchange phase');
	if (state.pendingAction?.actorDid !== playerDid) return err(state, 'Not your exchange');
	if (!state.exchangeCards) return err(state, 'No exchange cards');

	const player = getPlayer(state, playerDid);
	if (!player) return err(state, 'Player not found');

	const aliveCount = influenceCount(player);
	if (keptRoles.length !== aliveCount) {
		return err(state, `Must keep exactly ${aliveCount} cards`);
	}

	// Build pool of available roles (unrevealed hand + exchange cards)
	const pool = [
		...player.cards.filter((c) => !c.revealed).map((c) => c.role),
		...state.exchangeCards,
	];

	// Validate that keptRoles are all available in pool
	const poolCopy = [...pool];
	for (const role of keptRoles) {
		const idx = poolCopy.indexOf(role);
		if (idx === -1) return err(state, `Cannot keep ${role} — not in available cards`);
		poolCopy.splice(idx, 1);
	}

	// poolCopy now contains the returned cards
	const returnedCards = poolCopy;

	// Update player's cards
	let keptIdx = 0;
	const newCards = player.cards.map((card) => {
		if (card.revealed) return card;
		return { role: keptRoles[keptIdx++]!, revealed: false };
	}) as [(typeof player.cards)[0], (typeof player.cards)[1]];

	const updated: GameState = {
		...state,
		players: state.players.map((p) => (p.did === playerDid ? { ...p, cards: newCards } : p)),
		courtDeck: returnAndShuffle(state.courtDeck, returnedCards, shuffle),
		exchangeCards: null,
	};

	return ok(advanceTurn(updated, now));
}

// ---------------------------------------------------------------------------
// Timer-based auto-advance
// ---------------------------------------------------------------------------

export function getWindowDuration(state: GameState): number {
	switch (state.turnPhase) {
		case 'challenge_window':
			return state.config.challengeWindowMs;
		case 'block_window':
			return state.config.blockWindowMs;
		case 'challenge_block_window':
			return state.config.blockWindowMs;
		case 'losing_influence':
			return state.config.influenceChoiceMs;
		case 'exchanging':
			return state.config.exchangeChoiceMs;
		default:
			return 0;
	}
}

export function isWindowExpired(state: GameState, now: number): boolean {
	const duration = getWindowDuration(state);
	if (duration === 0) return false;
	return now >= state.phaseStartedAt + duration;
}

/** Auto-advance when timer expires. Called by engine tick(). */
export function autoAdvance(
	state: GameState,
	now: number,
	shuffle: ShuffleFn = fisherYatesShuffle,
): GameResult {
	if (!isWindowExpired(state, now)) return ok(state);

	switch (state.turnPhase) {
		case 'challenge_window':
		case 'block_window':
		case 'challenge_block_window':
			return advanceAfterAllPass(state, now);

		case 'losing_influence': {
			// Auto-reveal first unrevealed card (penalty for timeout)
			const player = getPlayer(state, state.influenceLossDid!);
			if (!player) return ok(advanceTurn(state, now));
			const autoIndex = player.cards[0]!.revealed ? 1 : 0;
			const updated = revealCard(state, state.influenceLossDid!, autoIndex);
			return resolveAfterInfluenceLoss(updated, now);
		}

		case 'exchanging': {
			// Keep original cards, return exchange cards to deck
			const updated: GameState = {
				...state,
				courtDeck: returnAndShuffle(state.courtDeck, state.exchangeCards ?? [], shuffle),
				exchangeCards: null,
			};
			return ok(advanceTurn(updated, now));
		}

		default:
			return ok(state);
	}
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function getCurrentPlayerDid(state: GameState): Did {
	return currentPlayer(state).did;
}

export function getAlivePlayers(state: GameState): Player[] {
	return alivePlayers(state);
}

type Handle = string;
