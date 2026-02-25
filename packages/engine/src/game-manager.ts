/**
 * Game manager — bridges pure game logic with Bluesky I/O and persistence.
 * Handles game lifecycle, command routing, phase announcements, and timers.
 */
import type { AtpAgent } from '@atproto/api';
import {
	type ActionKind,
	BLOCK_RULES,
	type CardRole,
	DEFAULT_CONFIG,
	type Did,
	type GameState,
	addPlayer,
	autoAdvance,
	chooseExchangeCards,
	chooseLostInfluence,
	createGame,
	declareAction,
	declareBlock,
	declareChallenge,
	declarePass,
	getAlivePlayers,
	isEliminated,
	resolveChallenge,
	startGame,
} from '@autogolpe/shared';
import type Database from 'better-sqlite3';
import { type PostRef, postMessage, replyToPost, resolveHandle } from './bot.js';
import {
	type QueueEntry,
	clearQueueEntries,
	loadActiveGames,
	loadPublicQueue,
	recordGamePost,
	removeQueueEntry,
	saveGame,
	saveQueueEntry,
} from './db.js';
import type { DmSender } from './dm.js';

const QUEUE_THRESHOLD = 3; // auto-start when queue reaches this size

export class GameManager {
	private games = new Map<string, GameState>();
	private queue: QueueEntry[] = [];

	constructor(
		private db: Database.Database,
		private agent: AtpAgent,
		private dm: DmSender,
	) {}

	// ---------------------------------------------------------------------------
	// Hydrate from DB
	// ---------------------------------------------------------------------------

	async hydrate(): Promise<void> {
		const activeGames = loadActiveGames(this.db);
		for (const game of activeGames) {
			this.games.set(game.id, game);
		}
		this.queue = loadPublicQueue(this.db);
		console.log(
			`Hydrated: ${this.games.size} active game(s), ${this.queue.length} queued player(s)`,
		);
	}

	// ---------------------------------------------------------------------------
	// Queries
	// ---------------------------------------------------------------------------

	getGame(id: string): GameState | undefined {
		return this.games.get(id);
	}

	findGameForPlayer(did: Did): GameState | undefined {
		for (const game of this.games.values()) {
			if (game.status === 'active' && game.players.some((p) => p.did === did)) {
				return game;
			}
		}
		return undefined;
	}

	activeGameCount(): number {
		let count = 0;
		for (const game of this.games.values()) {
			if (game.status !== 'finished') count++;
		}
		return count;
	}

	/** Resolve a handle to DID using in-game player list (no API call) */
	resolveHandleInGame(gameId: string, handle: string): Did | null {
		const game = this.games.get(gameId);
		if (!game) return null;
		const normalized = handle.toLowerCase();
		const player = game.players.find((p) => p.handle.toLowerCase() === normalized);
		return player?.did ?? null;
	}

	// ---------------------------------------------------------------------------
	// Game lifecycle
	// ---------------------------------------------------------------------------

	async newGame(id: string): Promise<GameState> {
		const now = Date.now();
		const state = createGame(id, now);
		this.games.set(id, state);
		saveGame(this.db, state);
		return state;
	}

	addPlayer(gameId: string, did: Did, handle: string): string | null {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		const result = addPlayer(game, did, handle);
		if (!result.ok) return result.error ?? 'Unknown error';

		this.games.set(gameId, result.state);
		saveGame(this.db, result.state);
		return null;
	}

	async startGameById(gameId: string): Promise<string | null> {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		const now = Date.now();
		const result = startGame(game, now);
		if (!result.ok) return result.error ?? 'Unknown error';

		this.games.set(gameId, result.state);
		saveGame(this.db, result.state);

		// DM each player their cards
		await this.dmAllHands(result.state);

		// Announce game start
		const current = result.state.players[result.state.turnIndex]!;
		const playerList = result.state.players.map((p) => `@${p.handle}`).join(', ');
		await this.announceInGame(
			gameId,
			`Game #${gameId} started with ${result.state.players.length} players: ${playerList}\n\nIt's @${current.handle}'s turn. (${current.coins} coins)`,
			'announcement',
		);

		return null;
	}

	// ---------------------------------------------------------------------------
	// Turn actions (from mentions)
	// ---------------------------------------------------------------------------

	async handleAction(
		gameId: string,
		actorDid: Did,
		action: ActionKind,
		targetHandle: string | null,
		_postUri: string,
		_postCid: string,
	): Promise<string | null> {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		// Resolve target handle → DID
		let targetDid: Did | null = null;
		if (targetHandle) {
			targetDid = this.resolveHandleInGame(gameId, targetHandle);
			if (!targetDid) {
				targetDid = await resolveHandle(this.agent, targetHandle);
			}
			if (!targetDid) return `Could not resolve @${targetHandle}`;
		}

		const now = Date.now();
		const result = declareAction(game, actorDid, action, targetDid, now);
		if (!result.ok) return result.error ?? 'Unknown error';

		this.updateAndSave(gameId, result.state);
		await this.announcePhaseTransition(result.state, action, actorDid, targetHandle);
		await this.handleAutoResolution(gameId);

		return null;
	}

	async handleChallenge(gameId: string, challengerDid: Did): Promise<string | null> {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		const now = Date.now();
		const result = declareChallenge(game, challengerDid, now);
		if (!result.ok) return result.error ?? 'Unknown error';

		this.updateAndSave(gameId, result.state);

		const challenger = result.state.players.find((p) => p.did === challengerDid);
		const target = result.state.pendingChallenge
			? result.state.players.find((p) => p.did === result.state.pendingChallenge!.targetDid)
			: null;

		await this.announceInGame(
			gameId,
			`@${challenger?.handle} challenges @${target?.handle}'s claim of ${result.state.pendingChallenge?.claimedRole}!\n\n@${target?.handle}, reveal a card to prove or disprove your claim. DM me "reveal 1" or "reveal 2".`,
			'action',
		);

		return null;
	}

	async handleBlock(
		gameId: string,
		blockerDid: Did,
		claimedRole: CardRole | null,
	): Promise<string | null> {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		// Infer role if not specified and unambiguous
		const action = game.pendingAction;
		if (!action) return 'No action to block';

		let role = claimedRole;
		if (!role) {
			const blockRoles = BLOCK_RULES[action.kind];
			if (!blockRoles) return 'This action cannot be blocked';
			if (blockRoles.length === 1) {
				role = blockRoles[0]!;
			} else {
				return `Specify which role you claim: ${blockRoles.join(' or ')}`;
			}
		}

		const now = Date.now();
		const result = declareBlock(game, blockerDid, role, now);
		if (!result.ok) return result.error ?? 'Unknown error';

		this.updateAndSave(gameId, result.state);

		const blocker = result.state.players.find((p) => p.did === blockerDid);
		await this.announceInGame(
			gameId,
			`@${blocker?.handle} blocks, claiming ${role}! Challenge or pass. (${this.formatTimeRemaining(result.state)})`,
			'action',
		);

		return null;
	}

	async handlePass(gameId: string, passerDid: Did): Promise<string | null> {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		const now = Date.now();
		const result = declarePass(game, passerDid, now);
		if (!result.ok) return result.error ?? 'Unknown error';

		this.updateAndSave(gameId, result.state);
		await this.announceStateChange(gameId, result.state, game);

		return null;
	}

	// ---------------------------------------------------------------------------
	// DM commands (influence loss, exchange)
	// ---------------------------------------------------------------------------

	async handleReveal(gameId: string, playerDid: Did, cardIndex: number): Promise<string | null> {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		// If we're in resolving_challenge or resolving_block_challenge
		if (
			game.turnPhase === 'resolving_challenge' ||
			game.turnPhase === 'resolving_block_challenge'
		) {
			if (game.pendingChallenge?.targetDid !== playerDid) return 'Not your challenge to resolve';

			const now = Date.now();
			const result = resolveChallenge(game, cardIndex, now);
			if (!result.ok) return result.error ?? 'Unknown error';

			this.updateAndSave(gameId, result.state);
			await this.announceChallengeResult(gameId, result.state, game);
			await this.handleAutoResolution(gameId);
			return null;
		}

		// If we're in losing_influence
		if (game.turnPhase === 'losing_influence') {
			if (game.influenceLossDid !== playerDid) return 'Not your influence to lose';

			const now = Date.now();
			const result = chooseLostInfluence(game, playerDid, cardIndex, now);
			if (!result.ok) return result.error ?? 'Unknown error';

			this.updateAndSave(gameId, result.state);
			await this.announceInfluenceLoss(gameId, result.state, playerDid, cardIndex, game);
			await this.handleAutoResolution(gameId);
			return null;
		}

		return 'No reveal needed right now';
	}

	async handleRevealByRole(gameId: string, playerDid: Did, role: CardRole): Promise<string | null> {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		const player = game.players.find((p) => p.did === playerDid);
		if (!player) return 'Player not found';

		const cardIndex = player.cards.findIndex((c) => !c.revealed && c.role === role);
		if (cardIndex === -1) return `You don't have an unrevealed ${role}`;

		return this.handleReveal(gameId, playerDid, cardIndex);
	}

	async handleExchangeKeep(
		gameId: string,
		playerDid: Did,
		keptRoles: CardRole[],
	): Promise<string | null> {
		const game = this.games.get(gameId);
		if (!game) return 'Game not found';

		const now = Date.now();
		const result = chooseExchangeCards(game, playerDid, keptRoles, now);
		if (!result.ok) return result.error ?? 'Unknown error';

		this.updateAndSave(gameId, result.state);

		await this.dm.sendDm(playerDid, 'Exchange complete. Your cards are now set.');
		await this.dmHand(result.state, playerDid);
		await this.announceNextTurn(gameId, result.state);

		return null;
	}

	async handleHandRequest(playerDid: Did): Promise<string | null> {
		const game = this.findGameForPlayer(playerDid);
		if (!game) return 'You are not in any active game';

		await this.dmHand(game, playerDid);
		return null;
	}

	// ---------------------------------------------------------------------------
	// Queue
	// ---------------------------------------------------------------------------

	async addToQueue(did: Did, handle: string, postUri: string, postCid: string): Promise<void> {
		// Check if already in an active game
		if (this.findGameForPlayer(did)) {
			await this.replyGeneral('You are already in an active game.', postUri, postCid);
			return;
		}

		if (this.queue.some((q) => q.did === did)) {
			await this.replyGeneral('You are already in the queue.', postUri, postCid);
			return;
		}

		const entry: QueueEntry = { did, handle, joinedAt: Date.now() };
		this.queue.push(entry);
		saveQueueEntry(this.db, entry);

		await this.replyGeneral(
			`You're in the queue (${this.queue.length}/${QUEUE_THRESHOLD}). Game starts when ${QUEUE_THRESHOLD} players are queued.`,
			postUri,
			postCid,
		);

		if (this.queue.length >= QUEUE_THRESHOLD) {
			await this.popAndStartGame();
		}
	}

	async removeFromQueue(did: Did, postUri: string, postCid: string): Promise<void> {
		const idx = this.queue.findIndex((q) => q.did === did);
		if (idx === -1) {
			await this.replyGeneral('You are not in the queue.', postUri, postCid);
			return;
		}
		this.queue.splice(idx, 1);
		removeQueueEntry(this.db, did);
		await this.replyGeneral('You left the queue.', postUri, postCid);
	}

	async queueStatus(postUri: string, postCid: string): Promise<void> {
		if (this.queue.length === 0) {
			await this.replyGeneral('Queue is empty. Mention me with "queue" to join.', postUri, postCid);
		} else {
			const handles = this.queue.map((q) => `@${q.handle}`).join(', ');
			await this.replyGeneral(
				`Queue (${this.queue.length}/${QUEUE_THRESHOLD}): ${handles}`,
				postUri,
				postCid,
			);
		}
	}

	private async popAndStartGame(): Promise<void> {
		const players = this.queue.splice(0, DEFAULT_CONFIG.maxPlayers);
		const dids = players.map((p) => p.did);
		clearQueueEntries(this.db, dids);

		const id = Date.now().toString(36);
		const now = Date.now();
		let state = createGame(id, now);

		for (const p of players) {
			const result = addPlayer(state, p.did, p.handle);
			if (result.ok) state = result.state;
		}

		const startResult = startGame(state, now);
		if (!startResult.ok) {
			console.error(`Queue auto-start failed: ${startResult.error}`);
			return;
		}

		this.games.set(id, startResult.state);
		saveGame(this.db, startResult.state);

		await this.dmAllHands(startResult.state);

		const current = startResult.state.players[startResult.state.turnIndex]!;
		const playerList = startResult.state.players.map((p) => `@${p.handle}`).join(', ');
		await this.announceInGame(
			id,
			`Game #${id} started from queue! Players: ${playerList}\n\nIt's @${current.handle}'s turn. (${current.coins} coins)`,
			'announcement',
		);
	}

	// ---------------------------------------------------------------------------
	// Tick — timer-based auto-advance
	// ---------------------------------------------------------------------------

	async tick(now: number): Promise<void> {
		for (const [gameId, game] of this.games) {
			if (game.status !== 'active') continue;

			const result = autoAdvance(game, now);
			if (result.state !== game) {
				// State changed — auto-advanced
				this.updateAndSave(gameId, result.state);
				await this.announceStateChange(gameId, result.state, game);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Posting helpers
	// ---------------------------------------------------------------------------

	async reply(gameId: string, text: string, parentUri: string, parentCid: string): Promise<void> {
		const game = this.games.get(gameId);
		const rootUri = game?.announcementUri ?? parentUri;
		const rootCid = game?.announcementCid ?? parentCid;
		try {
			await replyToPost(this.agent, text, parentUri, parentCid, rootUri, rootCid);
		} catch (err) {
			console.error(`Reply failed for game ${gameId}:`, err);
		}
	}

	async replyGeneral(text: string, parentUri: string, parentCid: string): Promise<void> {
		try {
			await replyToPost(this.agent, text, parentUri, parentCid, parentUri, parentCid);
		} catch (err) {
			console.error('Reply failed:', err);
		}
	}

	private async announceInGame(gameId: string, text: string, kind: string): Promise<void> {
		const game = this.games.get(gameId);
		try {
			let ref: PostRef;
			if (game?.announcementUri && game.announcementCid) {
				ref = await replyToPost(
					this.agent,
					text,
					game.announcementUri,
					game.announcementCid,
					game.announcementUri,
					game.announcementCid,
				);
			} else {
				ref = await postMessage(this.agent, text);
				// Store as announcement ref for future replies
				if (game && !game.announcementUri) {
					const updated = { ...game, announcementUri: ref.uri, announcementCid: ref.cid };
					this.games.set(gameId, updated);
					saveGame(this.db, updated);
				}
			}

			const botDid = this.agent.session?.did ?? '';
			recordGamePost(this.db, {
				uri: ref.uri,
				gameId,
				authorDid: botDid,
				kind: kind as 'announcement',
				phase: game?.turnPhase ?? null,
			});
		} catch (err) {
			console.error(`Announce failed for game ${gameId}:`, err);
		}
	}

	// ---------------------------------------------------------------------------
	// Phase transition announcements
	// ---------------------------------------------------------------------------

	private async announcePhaseTransition(
		state: GameState,
		action: ActionKind,
		actorDid: Did,
		targetHandle: string | null,
	): Promise<void> {
		const actor = state.players.find((p) => p.did === actorDid);
		const actorName = actor ? `@${actor.handle}` : 'Someone';

		let text: string;
		switch (action) {
			case 'income':
				text = `${actorName} takes income (+1 coin).`;
				break;
			case 'foreign_aid':
				text = `${actorName} claims foreign aid (+2 coins). Anyone can block (Duke). (${this.formatTimeRemaining(state)})`;
				break;
			case 'coup':
				text = `${actorName} launches a coup against @${targetHandle}! (-7 coins)`;
				break;
			case 'tax':
				text = `${actorName} claims Duke — tax (+3 coins). Challenge? (${this.formatTimeRemaining(state)})`;
				break;
			case 'assassinate':
				text = `${actorName} claims Assassin — assassinate @${targetHandle}! (-3 coins) Challenge? (${this.formatTimeRemaining(state)})`;
				break;
			case 'steal':
				text = `${actorName} claims Captain — steal from @${targetHandle}. Challenge? (${this.formatTimeRemaining(state)})`;
				break;
			case 'exchange':
				text = `${actorName} claims Ambassador — exchange cards. Challenge? (${this.formatTimeRemaining(state)})`;
				break;
		}

		// For income/coup, the action already resolved — also announce next turn
		if (action === 'income') {
			text += `\n\n${this.nextTurnText(state)}`;
		}

		await this.announceInGame(state.id, text, 'action');

		// For coup, we need to prompt the target
		if (action === 'coup' && state.turnPhase === 'losing_influence') {
			await this.promptInfluenceLoss(state);
		}
	}

	private async announceChallengeResult(
		gameId: string,
		newState: GameState,
		oldState: GameState,
	): Promise<void> {
		const challenge = oldState.pendingChallenge;
		if (!challenge) return;

		const challenger = newState.players.find((p) => p.did === challenge.challengerDid);
		const target = newState.players.find((p) => p.did === challenge.targetDid);

		// Did the challenged player have the role?
		// If the new state is in losing_influence with the challenger as target, challenge failed
		if (newState.influenceLossDid === challenge.challengerDid) {
			await this.announceInGame(
				gameId,
				`@${target?.handle} reveals ${challenge.claimedRole} — they had it! @${challenger?.handle} loses influence.`,
				'action',
			);
			await this.promptInfluenceLoss(newState);
		} else if (newState.status === 'finished') {
			await this.announceWinner(gameId, newState);
		} else {
			// Challenge succeeded — target was bluffing
			await this.announceInGame(
				gameId,
				`@${target?.handle} didn't have ${challenge.claimedRole} — caught bluffing! They lose a card.`,
				'action',
			);
			if (newState.turnPhase === 'awaiting_action') {
				await this.announceInGame(gameId, this.nextTurnText(newState), 'phase');
			}
		}
	}

	private async announceInfluenceLoss(
		gameId: string,
		newState: GameState,
		playerDid: Did,
		cardIndex: number,
		oldState: GameState,
	): Promise<void> {
		const player = oldState.players.find((p) => p.did === playerDid);
		const card = player?.cards[cardIndex];
		const role = card?.role ?? 'unknown';

		await this.announceInGame(
			gameId,
			`@${player?.handle} reveals ${role}.${isEliminated(newState.players.find((p) => p.did === playerDid)!) ? ' They are eliminated!' : ''}`,
			'action',
		);

		if (newState.status === 'finished') {
			await this.announceWinner(gameId, newState);
		} else if (newState.turnPhase === 'awaiting_action') {
			await this.announceNextTurn(gameId, newState);
		} else if (newState.turnPhase === 'losing_influence') {
			// Someone else now needs to lose influence
			await this.promptInfluenceLoss(newState);
		} else if (newState.turnPhase === 'block_window') {
			const action = newState.pendingAction;
			if (action) {
				const blockRoles = BLOCK_RULES[action.kind];
				if (blockRoles) {
					const targetPlayer = action.targetDid
						? newState.players.find((p) => p.did === action.targetDid)
						: null;
					const who = targetPlayer ? `@${targetPlayer.handle}` : 'Anyone';
					await this.announceInGame(
						gameId,
						`${who} may block (${blockRoles.join('/')}). (${this.formatTimeRemaining(newState)})`,
						'action',
					);
				}
			}
		}
	}

	private async announceStateChange(
		gameId: string,
		newState: GameState,
		oldState: GameState,
	): Promise<void> {
		if (newState.status === 'finished' && oldState.status !== 'finished') {
			await this.announceWinner(gameId, newState);
			return;
		}

		// Transitioned from a window to a new phase
		if (newState.turnPhase !== oldState.turnPhase) {
			if (newState.turnPhase === 'block_window' && oldState.turnPhase === 'challenge_window') {
				const action = newState.pendingAction;
				if (action) {
					const blockRoles = BLOCK_RULES[action.kind];
					if (blockRoles) {
						const targetPlayer = action.targetDid
							? newState.players.find((p) => p.did === action.targetDid)
							: null;
						const who = targetPlayer ? `@${targetPlayer.handle}` : 'Anyone';
						await this.announceInGame(
							gameId,
							`No challenge. ${who} may block (${blockRoles.join('/')}). (${this.formatTimeRemaining(newState)})`,
							'action',
						);
					}
				}
			} else if (newState.turnPhase === 'awaiting_action') {
				await this.announceNextTurn(gameId, newState);
			} else if (newState.turnPhase === 'losing_influence') {
				await this.promptInfluenceLoss(newState);
			} else if (newState.turnPhase === 'exchanging') {
				await this.promptExchange(newState);
			}
		}
	}

	private async announceWinner(gameId: string, state: GameState): Promise<void> {
		const winner = state.players.find((p) => p.did === state.winner);
		const allCards = state.players
			.map((p) => `@${p.handle}: ${p.cards.map((c) => c.role).join(', ')}`)
			.join('\n');

		await this.announceInGame(
			gameId,
			`Game #${gameId} is over! @${winner?.handle} wins!\n\nFinal cards:\n${allCards}`,
			'game_over',
		);
	}

	private async announceNextTurn(gameId: string, state: GameState): Promise<void> {
		await this.announceInGame(gameId, this.nextTurnText(state), 'phase');
	}

	private nextTurnText(state: GameState): string {
		const current = state.players[state.turnIndex]!;
		const alive = getAlivePlayers(state);
		const coinSummary = alive.map((p) => `@${p.handle}: ${p.coins}`).join(', ');
		const mustCoup = current.coins >= 10 ? ' (MUST COUP)' : '';
		return `It's @${current.handle}'s turn. (${current.coins} coins${mustCoup})\nCoins: ${coinSummary}`;
	}

	// ---------------------------------------------------------------------------
	// DM prompts
	// ---------------------------------------------------------------------------

	private async promptInfluenceLoss(state: GameState): Promise<void> {
		const player = state.players.find((p) => p.did === state.influenceLossDid);
		if (!player) return;

		const unrevealed = player.cards
			.map((c, i) => (!c.revealed ? `${i + 1}: ${c.role}` : null))
			.filter(Boolean)
			.join(', ');

		await this.dm.sendDm(
			player.did,
			`You must reveal a card. Your unrevealed cards: ${unrevealed}\nDM me "reveal 1" or "reveal 2" (or "reveal duke" etc.)`,
		);
	}

	private async promptExchange(state: GameState): Promise<void> {
		const actorDid = state.pendingAction?.actorDid;
		if (!actorDid) return;

		const player = state.players.find((p) => p.did === actorDid);
		if (!player) return;

		const handRoles = player.cards.filter((c) => !c.revealed).map((c) => c.role);
		const exchangeRoles = state.exchangeCards ?? [];
		const allRoles = [...handRoles, ...exchangeRoles];
		const keepCount = handRoles.length;

		await this.dm.sendDm(
			actorDid,
			`Exchange! Your available cards: ${allRoles.join(', ')}\nKeep ${keepCount}. DM me "keep ${allRoles.slice(0, keepCount).join(' ')}" (replace with your choices)`,
		);
	}

	private async dmHand(state: GameState, playerDid: Did): Promise<void> {
		const player = state.players.find((p) => p.did === playerDid);
		if (!player) return;

		const cards = player.cards
			.map((c, i) => `${i + 1}: ${c.role}${c.revealed ? ' (revealed)' : ''}`)
			.join('\n');

		await this.dm.sendDm(
			playerDid,
			`Game #${state.id} — Your cards:\n${cards}\nCoins: ${player.coins}`,
		);
	}

	private async dmAllHands(state: GameState): Promise<void> {
		for (const player of state.players) {
			try {
				await this.dmHand(state, player.did);
			} catch (err) {
				console.error(`Failed to DM hand to ${player.handle}:`, err);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Auto-resolution: after state changes, check if the game needs further processing
	// ---------------------------------------------------------------------------

	private async handleAutoResolution(gameId: string): Promise<void> {
		const game = this.games.get(gameId);
		if (!game || game.status !== 'active') return;

		// If we ended up in exchanging phase after a resolve, prompt
		if (game.turnPhase === 'exchanging') {
			await this.promptExchange(game);
		}

		// If game finished, announce
		if (game.status === 'finished') {
			await this.announceWinner(gameId, game);
		}
	}

	// ---------------------------------------------------------------------------
	// Internal
	// ---------------------------------------------------------------------------

	private updateAndSave(gameId: string, state: GameState): void {
		this.games.set(gameId, state);
		saveGame(this.db, state);
	}

	private formatTimeRemaining(state: GameState): string {
		const duration = this.getWindowDuration(state);
		if (duration === 0) return '';
		const remaining = Math.max(0, state.phaseStartedAt + duration - Date.now());
		const seconds = Math.ceil(remaining / 1000);
		return `${seconds}s remaining`;
	}

	private getWindowDuration(state: GameState): number {
		switch (state.turnPhase) {
			case 'challenge_window':
				return state.config.challengeWindowMs;
			case 'block_window':
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
}
