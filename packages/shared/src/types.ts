export type Did = string;
export type Handle = string;
export type GameId = string;

// -- Cards --

export const ALL_ROLES = ['duke', 'assassin', 'captain', 'ambassador', 'contessa'] as const;
export type CardRole = (typeof ALL_ROLES)[number];
export const CARDS_PER_ROLE = 3;

export interface Card {
	role: CardRole;
	revealed: boolean;
}

// -- Players --

export interface Player {
	did: Did;
	handle: Handle;
	coins: number;
	cards: [Card, Card];
}

export function isEliminated(player: Player): boolean {
	return player.cards[0].revealed && player.cards[1].revealed;
}

export function influenceCount(player: Player): number {
	return player.cards.filter((c) => !c.revealed).length;
}

// -- Actions --

export type ActionKind =
	| 'income'
	| 'foreign_aid'
	| 'coup'
	| 'tax'
	| 'assassinate'
	| 'steal'
	| 'exchange';

/** Which role is claimed by each action (null = no claim, can't be challenged) */
export const ACTION_CLAIMS: Record<ActionKind, CardRole | null> = {
	income: null,
	foreign_aid: null,
	coup: null,
	tax: 'duke',
	assassinate: 'assassin',
	steal: 'captain',
	exchange: 'ambassador',
};

/** Cost in coins to perform each action */
export const ACTION_COSTS: Record<ActionKind, number> = {
	income: 0,
	foreign_aid: 0,
	coup: 7,
	tax: 0,
	assassinate: 3,
	steal: 0,
	exchange: 0,
};

/** Which roles can block which actions */
export const BLOCK_RULES: Partial<Record<ActionKind, readonly CardRole[]>> = {
	foreign_aid: ['duke'],
	assassinate: ['contessa'],
	steal: ['captain', 'ambassador'],
};

export interface PendingAction {
	kind: ActionKind;
	actorDid: Did;
	targetDid: Did | null;
	claimedRole: CardRole | null;
}

export interface PendingBlock {
	blockerDid: Did;
	claimedRole: CardRole;
}

export interface PendingChallenge {
	challengerDid: Did;
	targetDid: Did;
	claimedRole: CardRole;
}

// -- Turn Phase --

export type TurnPhase =
	| 'awaiting_action'
	| 'challenge_window'
	| 'block_window'
	| 'challenge_block_window'
	| 'resolving_challenge'
	| 'resolving_block_challenge'
	| 'losing_influence'
	| 'exchanging';

// -- Game Config --

export interface GameConfig {
	minPlayers: number;
	maxPlayers: number;
	challengeWindowMs: number;
	blockWindowMs: number;
	influenceChoiceMs: number;
	exchangeChoiceMs: number;
}

export const DEFAULT_CONFIG: GameConfig = {
	minPlayers: 2,
	maxPlayers: 6,
	challengeWindowMs: 90_000,
	blockWindowMs: 60_000,
	influenceChoiceMs: 60_000,
	exchangeChoiceMs: 60_000,
};

// -- Game Status --

export type GameStatus = 'lobby' | 'active' | 'finished';

// -- Game State --

export interface GameState {
	id: GameId;
	config: GameConfig;
	status: GameStatus;
	players: Player[];
	/** Index into players array for whose turn it is */
	turnIndex: number;
	turnPhase: TurnPhase;
	pendingAction: PendingAction | null;
	pendingBlock: PendingBlock | null;
	pendingChallenge: PendingChallenge | null;
	/** DIDs of players who passed in the current window */
	passedDids: Did[];
	/** Who must choose a card to lose */
	influenceLossDid: Did | null;
	/** Reason the influence loss was triggered — drives what happens after */
	influenceLossReason:
		| 'coup'
		| 'assassinate'
		| 'challenge_lost'
		| 'challenge_won'
		| 'block_challenge_lost'
		| 'block_challenge_won'
		| null;
	/** Extra cards drawn for ambassador exchange */
	exchangeCards: CardRole[] | null;
	/** Court deck (remaining cards not dealt) */
	courtDeck: CardRole[];
	/** Timestamp when current phase started */
	phaseStartedAt: number;
	createdAt: number;
	winner: Did | null;
	/** Bluesky announcement post ref (set by engine, not by pure logic) */
	announcementUri: string | null;
	announcementCid: string | null;
}

// -- Result type for game logic functions --

export interface GameResult {
	ok: boolean;
	error?: string;
	state: GameState;
}
