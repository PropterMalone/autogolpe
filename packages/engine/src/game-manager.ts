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
import type { DmSender } from './bot.js';
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

const QUEUE_THRESHOLD = 3; // auto-start when queue reaches this size
const GAME_TIMEOUT_MS = 30 * 60 * 1000; // abandon game after 30min of no activity
const FINISHED_CLEANUP_MS = 5 * 60 * 1000; // remove finished games from memory after 5min

export class GameManager {
	private games = new Map<string, GameState>();
	private finishedAt = new Map<string, number>(); // gameId → timestamp when game ended
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
		const challenge = result.state.pendingChallenge;
		const target = challenge
			? result.state.players.find((p) => p.did === challenge.targetDid)
			: null;

		await this.announceInGame(
			gameId,
			`@${challenger?.handle} challenges @${target?.handle}'s claim of ${challenge?.claimedRole}!`,
			'action',
		);

		// DM the challenged player with reveal instructions
		if (target && challenge) {
			const unrevealed = target.cards
				.map((c, i) => (!c.revealed ? `${i + 1}: ${c.role}` : null))
				.filter(Boolean)
				.join(', ');
			await this.dm.sendDm(
				target.did,
				`You've been challenged on ${challenge.claimedRole}! Your cards: ${unrevealed}\nDM me "reveal 1" or "reveal 2" (or "reveal duke" etc.)`,
			);
		}

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
		await this.announceInGame(gameId, `@${blocker?.handle} blocks with ${role}!`, 'action');

		// DM eligible challengers about the block
		await this.dmBlockChallengers(result.state);

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
		const reply = (msg: string) => this.replyGeneral(msg, postUri, postCid);
		await this.addToQueueCore(did, handle, reply);
	}

	async addToQueueViaDm(did: Did): Promise<void> {
		const handle = await this.resolveDidToHandle(did);
		if (!handle) {
			await this.dm.sendDm(did, 'Could not resolve your handle. Try queuing via a public mention.');
			return;
		}
		const reply = (msg: string) => this.dm.sendDm(did, msg).then(() => {});
		await this.addToQueueCore(did, handle, reply);
	}

	private async addToQueueCore(
		did: Did,
		handle: string,
		reply: (msg: string) => Promise<void>,
	): Promise<void> {
		if (this.findGameForPlayer(did)) {
			await reply('You are already in an active game.');
			return;
		}

		if (this.queue.some((q) => q.did === did)) {
			await reply('You are already in the queue.');
			return;
		}

		const entry: QueueEntry = { did, handle, joinedAt: Date.now() };
		this.queue.push(entry);
		saveQueueEntry(this.db, entry);

		await reply(
			`You're in the queue (${this.queue.length}/${QUEUE_THRESHOLD}). Game starts when ${QUEUE_THRESHOLD} players are queued.`,
		);

		if (this.queue.length >= QUEUE_THRESHOLD) {
			await this.popAndStartGame();
		}
	}

	async removeFromQueue(did: Did, postUri: string, postCid: string): Promise<void> {
		const reply = (msg: string) => this.replyGeneral(msg, postUri, postCid);
		await this.removeFromQueueCore(did, reply);
	}

	async removeFromQueueViaDm(did: Did): Promise<void> {
		const reply = (msg: string) => this.dm.sendDm(did, msg).then(() => {});
		await this.removeFromQueueCore(did, reply);
	}

	private async removeFromQueueCore(
		did: Did,
		reply: (msg: string) => Promise<void>,
	): Promise<void> {
		const idx = this.queue.findIndex((q) => q.did === did);
		if (idx === -1) {
			await reply('You are not in the queue.');
			return;
		}
		this.queue.splice(idx, 1);
		removeQueueEntry(this.db, did);
		await reply('You left the queue.');
	}

	async queueStatus(postUri: string, postCid: string): Promise<void> {
		const reply = (msg: string) => this.replyGeneral(msg, postUri, postCid);
		await this.queueStatusCore(reply);
	}

	async queueStatusViaDm(did: Did): Promise<void> {
		const reply = (msg: string) => this.dm.sendDm(did, msg).then(() => {});
		await this.queueStatusCore(reply);
	}

	private async queueStatusCore(reply: (msg: string) => Promise<void>): Promise<void> {
		if (this.queue.length === 0) {
			await reply('Queue is empty. Send "queue" to join.');
		} else {
			const handles = this.queue.map((q) => `@${q.handle}`).join(', ');
			await reply(`Queue (${this.queue.length}/${QUEUE_THRESHOLD}): ${handles}`);
		}
	}

	private async resolveDidToHandle(did: Did): Promise<string | null> {
		try {
			const response = await this.agent.getProfile({ actor: did });
			return response.data.handle;
		} catch {
			return null;
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

			// Abandon game if no activity for 30 minutes
			if (now - game.phaseStartedAt > GAME_TIMEOUT_MS) {
				console.log(`Game ${gameId} timed out (no activity for 30min)`);
				const finished = { ...game, status: 'finished' as const, winner: null };
				this.updateAndSave(gameId, finished, now);
				await this.announceInGame(
					gameId,
					`Game #${gameId} abandoned (no activity for 30 minutes).`,
					'timeout',
				);
				continue;
			}

			const result = autoAdvance(game, now);
			if (result.state !== game) {
				// State changed — auto-advanced
				this.updateAndSave(gameId, result.state, now);
				await this.announceStateChange(gameId, result.state, game);
			}
		}

		// Clean up finished games from memory (DB retains them)
		for (const [gameId, endedAt] of this.finishedAt) {
			if (now - endedAt > FINISHED_CLEANUP_MS) {
				this.games.delete(gameId);
				this.finishedAt.delete(gameId);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Posting helpers
	// ---------------------------------------------------------------------------

	async reply(gameId: string, text: string, parentUri: string, parentCid: string): Promise<void> {
		const game = this.games.get(gameId);
		const parent = { uri: parentUri, cid: parentCid };
		const root =
			game?.announcementUri && game.announcementCid
				? { uri: game.announcementUri, cid: game.announcementCid }
				: parent;
		try {
			await replyToPost(this.agent, text, parent, root);
		} catch (err) {
			console.error(`Reply failed for game ${gameId}:`, err);
		}
	}

	async replyGeneral(text: string, parentUri: string, parentCid: string): Promise<void> {
		const parent = { uri: parentUri, cid: parentCid };
		try {
			await replyToPost(this.agent, text, parent, parent);
		} catch (err) {
			console.error('Reply failed:', err);
		}
	}

	private async announceInGame(gameId: string, text: string, kind: string): Promise<void> {
		const game = this.games.get(gameId);
		try {
			let ref: PostRef;
			if (game?.announcementUri && game.announcementCid) {
				const root = { uri: game.announcementUri, cid: game.announcementCid };
				ref = await replyToPost(this.agent, text, root, root);
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
				text = `${actorName} claims foreign aid.`;
				break;
			case 'coup':
				text = `${actorName} launches a coup against @${targetHandle}! (-7 coins)`;
				break;
			case 'tax':
				text = `${actorName} claims Duke — tax.`;
				break;
			case 'assassinate':
				text = `${actorName} claims Assassin — targets @${targetHandle}! (-3 coins)`;
				break;
			case 'steal':
				text = `${actorName} claims Captain — steal from @${targetHandle}.`;
				break;
			case 'exchange':
				text = `${actorName} claims Ambassador — exchange.`;
				break;
		}

		// For income/coup, the action already resolved — also announce next turn
		if (action === 'income') {
			text += `\n\n${this.nextTurnText(state)}`;
		}

		await this.announceInGame(state.id, text, 'action');

		// DM eligible players about their response options
		if (state.turnPhase === 'challenge_window') {
			await this.dmChallengers(state);
		} else if (state.turnPhase === 'block_window') {
			await this.dmBlockers(state);
		}

		// For coup: prompt target or announce next turn if auto-resolved (1-card target)
		if (action === 'coup') {
			if (state.turnPhase === 'losing_influence') {
				await this.promptInfluenceLoss(state);
			} else if (state.status === 'finished') {
				await this.announceWinner(state.id, state);
			} else if (state.turnPhase === 'awaiting_action') {
				await this.announceNextTurn(state.id, state);
			}
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
			let text = `@${target?.handle} reveals ${challenge.claimedRole} — they had it! @${challenger?.handle} loses influence.`;
			// If challenger only has 1 card, auto-loss is immediate — batch the result
			if (isEliminated(newState.players.find((p) => p.did === challenge.challengerDid)!)) {
				text += ` @${challenger?.handle} is eliminated!`;
			}
			await this.announceInGame(gameId, text, 'action');
			if (newState.turnPhase === 'losing_influence') {
				await this.promptInfluenceLoss(newState);
			} else if (newState.turnPhase === 'awaiting_action') {
				await this.announceNextTurn(gameId, newState);
			}
		} else if (newState.status === 'finished') {
			await this.announceWinner(gameId, newState);
		} else {
			// Challenge succeeded — target was bluffing
			let text = `@${target?.handle} didn't have ${challenge.claimedRole} — caught bluffing!`;
			if (isEliminated(newState.players.find((p) => p.did === challenge.targetDid)!)) {
				text += ` @${target?.handle} is eliminated!`;
			}
			// Batch next turn if action is over
			if (newState.turnPhase === 'awaiting_action') {
				text += `\n\n${this.nextTurnText(newState)}`;
			}
			await this.announceInGame(gameId, text, 'action');
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
		const eliminated = isEliminated(newState.players.find((p) => p.did === playerDid)!);

		let text = `@${player?.handle} reveals ${role}.${eliminated ? ' Eliminated!' : ''}`;

		// Batch next turn with this announcement
		if (newState.turnPhase === 'awaiting_action') {
			text += `\n\n${this.nextTurnText(newState)}`;
		}

		await this.announceInGame(gameId, text, 'action');

		if (newState.status === 'finished') {
			await this.announceWinner(gameId, newState);
		} else if (newState.turnPhase === 'losing_influence') {
			// Someone else now needs to lose influence
			await this.promptInfluenceLoss(newState);
		} else if (newState.turnPhase === 'block_window') {
			// DM eligible blockers instead of public post
			await this.dmBlockers(newState);
		}
		// awaiting_action already handled in batched text above
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
				// Don't post publicly — DM eligible blockers instead
				await this.dmBlockers(newState);
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

	/** DM all eligible challengers about a role claim */
	private async dmChallengers(state: GameState): Promise<void> {
		const action = state.pendingAction;
		if (!action?.claimedRole) return;
		const actor = state.players.find((p) => p.did === action.actorDid);
		for (const player of getAlivePlayers(state)) {
			if (player.did === action.actorDid) continue;
			await this.dm.sendDm(
				player.did,
				`@${actor?.handle} claims ${action.claimedRole}. Challenge? Reply "challenge" or "pass" to the game post.`,
			);
		}
	}

	/** DM eligible blockers when challenge window passes */
	private async dmBlockers(state: GameState): Promise<void> {
		const action = state.pendingAction;
		if (!action) return;
		const blockRoles = BLOCK_RULES[action.kind];
		if (!blockRoles) return;
		const actor = state.players.find((p) => p.did === action.actorDid);
		for (const player of getAlivePlayers(state)) {
			if (player.did === action.actorDid) continue;
			// For targeted actions (steal, assassinate), only the target can block
			if (action.targetDid && player.did !== action.targetDid) continue;
			await this.dm.sendDm(
				player.did,
				`@${actor?.handle}'s ${action.kind} — block with ${blockRoles.join('/')}? Reply "block ${blockRoles[0]}" or "pass".`,
			);
		}
	}

	/** DM eligible challengers about a block claim */
	private async dmBlockChallengers(state: GameState): Promise<void> {
		const block = state.pendingBlock;
		if (!block) return;
		const blocker = state.players.find((p) => p.did === block.blockerDid);
		for (const player of getAlivePlayers(state)) {
			if (player.did === block.blockerDid) continue;
			await this.dm.sendDm(
				player.did,
				`@${blocker?.handle} blocks with ${block.claimedRole}. Challenge the block? Reply "challenge" or "pass".`,
			);
		}
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
		if (!game || game.status === 'finished') return;

		// If we ended up in exchanging phase after a resolve, prompt
		if (game.turnPhase === 'exchanging') {
			await this.promptExchange(game);
		}
	}

	// ---------------------------------------------------------------------------
	// Internal
	// ---------------------------------------------------------------------------

	private updateAndSave(gameId: string, state: GameState, now?: number): void {
		this.games.set(gameId, state);
		saveGame(this.db, state);
		if (state.status === 'finished' && !this.finishedAt.has(gameId)) {
			this.finishedAt.set(gameId, now ?? Date.now());
		}
	}
}
