/**
 * Autogolpe engine entry point.
 * Connects to Bluesky, hydrates game state, starts polling loop.
 * Adapted from Skeetwolf — shorter poll interval for Coup's fast timers.
 */
import { createAgent, pollMentions } from './bot.js';
import { parseDm, parseMention } from './command-parser.js';
import { loadBotState, openDatabase, saveBotState } from './db.js';
import {
	createBlueskyDmSender,
	createChatAgent,
	createConsoleDmSender,
	pollInboundDms,
} from './dm.js';
import type { DmSender } from './dm.js';
import { GameManager } from './game-manager.js';

let BOT_HANDLE = 'autogolpe.bsky.social';

// Coup needs faster polling than Werewolf — 10s vs 30s
const POLL_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const POLL_TIMEOUT_MS = 60_000;

function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		fn().then(
			(val) => {
				clearTimeout(timer);
				resolve(val);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

process.on('unhandledRejection', (err) => {
	console.error('Unhandled rejection:', err);
});

async function main() {
	const identifier = process.env['BSKY_IDENTIFIER'];
	const password = process.env['BSKY_PASSWORD'];
	const useLiveDms = process.env['LIVE_DMS'] === '1';

	if (!identifier || !password) {
		console.error('Set BSKY_IDENTIFIER and BSKY_PASSWORD environment variables');
		process.exit(1);
	}

	const db = openDatabase(process.env['DB_PATH'] || 'autogolpe.db');
	const agent = await createAgent({ identifier, password });

	if (agent.session?.handle) {
		BOT_HANDLE = agent.session.handle;
	}

	const dm: DmSender = useLiveDms
		? createBlueskyDmSender(createChatAgent(agent))
		: createConsoleDmSender();
	const chatAgent = useLiveDms ? createChatAgent(agent) : null;

	const manager = new GameManager(db, agent, dm);
	await manager.hydrate();

	// Brief pause after login — Bluesky sometimes closes the socket on
	// the first API call if it comes too soon after auth.
	await new Promise((r) => setTimeout(r, 2000));

	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () => {
			console.log(`${signal} received, shutting down...`);
			db.close();
			process.exit(0);
		});
	}

	console.log(
		`Autogolpe engine started as @${BOT_HANDLE}. DMs: ${useLiveDms ? 'LIVE' : 'console'}. Polling every ${POLL_INTERVAL_MS / 1000}s...`,
	);

	let dmMessageId: string | undefined = loadBotState(db, 'dm_message_id') ?? undefined;
	let mentionCutoff = loadBotState(db, 'mention_cutoff') ?? new Date().toISOString();
	let backoffMs = POLL_INTERVAL_MS;
	const processedMentionUris = new Set<string>();
	let pollCount = 0;

	async function poll() {
		let hadError = false;
		pollCount++;

		// --- Mentions ---
		try {
			const { notifications } = await withTimeout(
				() => pollMentions(agent),
				POLL_TIMEOUT_MS,
				'pollMentions',
			);

			const botDid = agent.session?.did;
			let newestIndexedAt = mentionCutoff;

			for (const mention of notifications) {
				if (botDid && mention.authorDid === botDid) continue;
				// Skip mentions older than our persisted cutoff
				if (mention.indexedAt <= mentionCutoff) continue;
				if (processedMentionUris.has(mention.uri)) continue;
				processedMentionUris.add(mention.uri);

				if (mention.indexedAt > newestIndexedAt) {
					newestIndexedAt = mention.indexedAt;
				}

				await handleMention(
					manager,
					agent,
					mention.uri,
					mention.cid,
					mention.authorDid,
					mention.authorHandle,
					mention.text,
				);
			}

			if (newestIndexedAt > mentionCutoff) {
				mentionCutoff = newestIndexedAt;
				saveBotState(db, 'mention_cutoff', mentionCutoff);
			}

			if (processedMentionUris.size > 1000) {
				const toDelete = [...processedMentionUris].slice(0, 500);
				for (const uri of toDelete) processedMentionUris.delete(uri);
			}
		} catch (err) {
			hadError = true;
			if (isAuthError(err)) {
				console.log('Auth error detected, refreshing session...');
				try {
					await agent.login({ identifier: identifier!, password: password! });
					console.log('Session refreshed');
				} catch (loginErr) {
					console.error('Session refresh failed:', loginErr);
				}
			}
			console.error('Mention poll error:', err);
		}

		// --- DMs ---
		if (chatAgent) {
			try {
				const { messages, latestMessageId } = await withTimeout(
					() => pollInboundDms(chatAgent, dmMessageId),
					POLL_TIMEOUT_MS,
					'pollInboundDms',
				);

				for (const msg of messages) {
					await handleDm(manager, dm, msg.senderDid, msg.text);
				}

				if (latestMessageId) {
					dmMessageId = latestMessageId;
					saveBotState(db, 'dm_message_id', latestMessageId);
				}
			} catch (err) {
				hadError = true;
				console.error('DM poll error:', err);
			}
		}

		// --- Tick ---
		try {
			await manager.tick(Date.now());
		} catch (err) {
			hadError = true;
			console.error('Tick error:', err);
		}

		if (hadError) {
			backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
			console.log(`Backing off: next poll in ${backoffMs / 1000}s`);
		} else {
			backoffMs = POLL_INTERVAL_MS;
		}

		if (pollCount % 30 === 0) {
			const games = manager.activeGameCount();
			console.log(`[heartbeat] poll #${pollCount}, ${games} active game(s)`);
		}

		setTimeout(poll, backoffMs);
	}

	await poll();
}

function isAuthError(err: unknown): boolean {
	if (err instanceof Error) {
		if (err.message.includes('ExpiredToken')) return true;
	}
	if (typeof err === 'object' && err !== null && 'status' in err) {
		return (err as { status: number }).status === 401;
	}
	return false;
}

async function handleMention(
	manager: GameManager,
	_agent: import('@atproto/api').AtpAgent,
	postUri: string,
	postCid: string,
	authorDid: string,
	authorHandle: string,
	text: string,
): Promise<void> {
	const cmd = parseMention(text, BOT_HANDLE);

	switch (cmd.kind) {
		case 'new_game': {
			const id = Date.now().toString(36);
			await manager.newGame(id);
			console.log(`New game created: ${id}`);
			await manager.replyGeneral(
				`Game #${id} created! Reply "@${BOT_HANDLE} join #${id}" to play.`,
				postUri,
				postCid,
			);
			break;
		}
		case 'join': {
			const error = manager.addPlayer(cmd.gameId, authorDid, authorHandle);
			if (error) {
				await manager.replyGeneral(error, postUri, postCid);
			} else {
				const game = manager.getGame(cmd.gameId);
				const count = game?.players.length ?? 0;
				await manager.replyGeneral(
					`@${authorHandle} joined game #${cmd.gameId} (${count}/${game?.config.maxPlayers ?? 6})`,
					postUri,
					postCid,
				);
			}
			break;
		}
		case 'start': {
			const error = await manager.startGameById(cmd.gameId);
			if (error) {
				await manager.replyGeneral(error, postUri, postCid);
			}
			break;
		}
		case 'action': {
			// Find which game the player is in
			const game = manager.findGameForPlayer(authorDid);
			if (!game) {
				await manager.replyGeneral('You are not in any active game.', postUri, postCid);
				break;
			}
			const error = await manager.handleAction(
				game.id,
				authorDid,
				cmd.action,
				cmd.targetHandle,
				postUri,
				postCid,
			);
			if (error) {
				await manager.reply(game.id, error, postUri, postCid);
			}
			break;
		}
		case 'challenge': {
			const game = manager.findGameForPlayer(authorDid);
			if (!game) {
				await manager.replyGeneral('You are not in any active game.', postUri, postCid);
				break;
			}
			const error = await manager.handleChallenge(game.id, authorDid);
			if (error) {
				await manager.reply(game.id, error, postUri, postCid);
			}
			break;
		}
		case 'block': {
			const game = manager.findGameForPlayer(authorDid);
			if (!game) {
				await manager.replyGeneral('You are not in any active game.', postUri, postCid);
				break;
			}
			const error = await manager.handleBlock(game.id, authorDid, cmd.role);
			if (error) {
				await manager.reply(game.id, error, postUri, postCid);
			}
			break;
		}
		case 'pass': {
			const game = manager.findGameForPlayer(authorDid);
			if (!game) {
				await manager.replyGeneral('You are not in any active game.', postUri, postCid);
				break;
			}
			const error = await manager.handlePass(game.id, authorDid);
			if (error) {
				await manager.reply(game.id, error, postUri, postCid);
			}
			break;
		}
		case 'queue': {
			await manager.addToQueue(authorDid, authorHandle, postUri, postCid);
			break;
		}
		case 'unqueue': {
			await manager.removeFromQueue(authorDid, postUri, postCid);
			break;
		}
		case 'queue_status': {
			await manager.queueStatus(postUri, postCid);
			break;
		}
		case 'status': {
			const game = manager.findGameForPlayer(authorDid);
			if (!game) {
				await manager.replyGeneral('You are not in any active game.', postUri, postCid);
			} else {
				const current = game.players[game.turnIndex]!;
				const alive = game.players.filter((p) => !(p.cards[0].revealed && p.cards[1].revealed));
				const coins = alive.map((p) => `@${p.handle}: ${p.coins}`).join(', ');
				await manager.reply(
					game.id,
					`Game #${game.id} — ${game.turnPhase}\nTurn: @${current.handle}\nAlive (${alive.length}): ${coins}`,
					postUri,
					postCid,
				);
			}
			break;
		}
		case 'help': {
			await manager.replyGeneral(
				'Autogolpe — Coup on Bluesky\n\nActions: income, foreign aid, tax, steal @player, assassinate @player, coup @player, exchange\nResponses: challenge, block [role], pass\nDMs: hand, reveal 1/2, keep [roles]\nQueue: queue, unqueue, queue?',
				postUri,
				postCid,
			);
			break;
		}
		case 'unknown':
			break;
	}
}

async function handleDm(
	manager: GameManager,
	dm: DmSender,
	senderDid: string,
	text: string,
): Promise<void> {
	const cmd = parseDm(text);

	switch (cmd.kind) {
		case 'hand': {
			const error = await manager.handleHandRequest(senderDid);
			if (error) await dm.sendDm(senderDid, error);
			break;
		}
		case 'reveal': {
			const game = manager.findGameForPlayer(senderDid);
			if (!game) {
				await dm.sendDm(senderDid, 'You are not in any active game.');
				break;
			}
			const error = await manager.handleReveal(game.id, senderDid, cmd.cardIndex);
			if (error) await dm.sendDm(senderDid, error);
			break;
		}
		case 'reveal_role': {
			const game = manager.findGameForPlayer(senderDid);
			if (!game) {
				await dm.sendDm(senderDid, 'You are not in any active game.');
				break;
			}
			const error = await manager.handleRevealByRole(game.id, senderDid, cmd.role);
			if (error) await dm.sendDm(senderDid, error);
			break;
		}
		case 'keep': {
			const game = manager.findGameForPlayer(senderDid);
			if (!game) {
				await dm.sendDm(senderDid, 'You are not in any active game.');
				break;
			}
			const error = await manager.handleExchangeKeep(game.id, senderDid, cmd.roles);
			if (error) await dm.sendDm(senderDid, error);
			break;
		}
		case 'help': {
			await dm.sendDm(
				senderDid,
				'DM commands:\n• hand — view your cards\n• reveal 1 or reveal 2 — reveal a card\n• reveal duke — reveal by role name\n• keep duke captain — choose cards for exchange',
			);
			break;
		}
		case 'unknown':
			break;
	}
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
