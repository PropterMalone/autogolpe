/**
 * SQLite persistence for Autogolpe game state.
 * JSON blob per game — same pattern as Skeetwolf/YSA.
 */
import type { GameState } from '@autogolpe/shared';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_posts (
  uri TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  author_did TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_posts_game_id ON game_posts(game_id, indexed_at);

CREATE TABLE IF NOT EXISTS public_queue (
  did TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  joined_at INTEGER NOT NULL
);
`;

export function openDatabase(path: string): Database.Database {
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.exec(SCHEMA);
	return db;
}

export function saveGame(db: Database.Database, state: GameState): void {
	const now = Date.now();
	const json = JSON.stringify(state);
	db.prepare(
		`INSERT INTO games (id, state, created_at, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET state = ?, updated_at = ?`,
	).run(state.id, json, state.createdAt, now, json, now);
}

export function loadGame(db: Database.Database, id: string): GameState | null {
	const row = db.prepare('SELECT state FROM games WHERE id = ?').get(id) as
		| { state: string }
		| undefined;
	if (!row) return null;
	return JSON.parse(row.state) as GameState;
}

export function loadActiveGames(db: Database.Database): GameState[] {
	const rows = db
		.prepare("SELECT state FROM games WHERE json_extract(state, '$.status') != 'finished'")
		.all() as { state: string }[];
	return rows.map((r) => JSON.parse(r.state) as GameState);
}

export type PostKind = 'announcement' | 'action' | 'phase' | 'game_over' | 'player' | 'reply';

export interface GamePost {
	uri: string;
	gameId: string;
	authorDid: string;
	kind: PostKind;
	phase: string | null;
	indexedAt: number;
}

export function recordGamePost(db: Database.Database, post: Omit<GamePost, 'indexedAt'>): void {
	db.prepare(
		'INSERT OR IGNORE INTO game_posts (uri, game_id, author_did, kind, phase, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
	).run(post.uri, post.gameId, post.authorDid, post.kind, post.phase, Date.now());
}

export function saveBotState(db: Database.Database, key: string, value: string): void {
	db.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)').run(key, value);
}

export function loadBotState(db: Database.Database, key: string): string | null {
	const row = db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as
		| { value: string }
		| undefined;
	return row?.value ?? null;
}

// -- Public Queue --

export interface QueueEntry {
	did: string;
	handle: string;
	joinedAt: number;
}

export function loadPublicQueue(db: Database.Database): QueueEntry[] {
	const rows = db
		.prepare('SELECT did, handle, joined_at FROM public_queue ORDER BY joined_at ASC')
		.all() as { did: string; handle: string; joined_at: number }[];
	return rows.map((r) => ({ did: r.did, handle: r.handle, joinedAt: r.joined_at }));
}

export function saveQueueEntry(db: Database.Database, entry: QueueEntry): void {
	db.prepare('INSERT OR IGNORE INTO public_queue (did, handle, joined_at) VALUES (?, ?, ?)').run(
		entry.did,
		entry.handle,
		entry.joinedAt,
	);
}

export function removeQueueEntry(db: Database.Database, did: string): void {
	db.prepare('DELETE FROM public_queue WHERE did = ?').run(did);
}

export function clearQueueEntries(db: Database.Database, dids: string[]): void {
	if (dids.length === 0) return;
	const placeholders = dids.map(() => '?').join(',');
	db.prepare(`DELETE FROM public_queue WHERE did IN (${placeholders})`).run(...dids);
}
