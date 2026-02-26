import type { ActionKind, CardRole } from '@autogolpe/shared';

// ---------------------------------------------------------------------------
// Mention commands (public, in-thread)
// ---------------------------------------------------------------------------

export type MentionCommand =
	| { kind: 'new_game' }
	| { kind: 'queue' }
	| { kind: 'unqueue' }
	| { kind: 'queue_status' }
	| { kind: 'join'; gameId: string }
	| { kind: 'start'; gameId: string }
	| { kind: 'action'; action: ActionKind; targetHandle: string | null }
	| { kind: 'challenge' }
	| { kind: 'block'; role: CardRole | null }
	| { kind: 'pass' }
	| { kind: 'status' }
	| { kind: 'help' }
	| { kind: 'unknown'; text: string };

const HANDLE_PATTERN = /@[\w.-]+/;

/** Strip bot mention, smart quotes, and normalize */
function stripBot(text: string, botHandle: string): string {
	// Remove smart quotes and normalize dashes
	const cleaned = text
		.replace(/[\u201C\u201D]/g, '')
		.replace(/[\u2018\u2019]/g, '')
		.replace(/[\u2013\u2014]/g, '-');
	// Strip bot handle (case-insensitive)
	return cleaned.replace(new RegExp(`@${botHandle}`, 'gi'), '').trim();
}

function extractHandle(text: string): string | null {
	const match = text.match(HANDLE_PATTERN);
	return match ? match[0]!.slice(1) : null; // strip leading @
}

function extractGameId(text: string): string | null {
	const match = text.match(/#([\w-]+)/);
	return match ? match[1]! : null;
}

export function parseMention(text: string, botHandle: string): MentionCommand {
	const stripped = stripBot(text, botHandle);
	const norm = stripped.toLowerCase();

	// Game management
	if (/^new\s+game/.test(norm)) return { kind: 'new_game' };
	if (/^(queue|lfg)$/.test(norm)) return { kind: 'queue' };
	if (/^unqueue$/.test(norm)) return { kind: 'unqueue' };
	if (/^queue\?$/.test(norm)) return { kind: 'queue_status' };

	const gameId = extractGameId(norm);
	if (/^join/.test(norm) && gameId) return { kind: 'join', gameId };
	if (/^start/.test(norm) && gameId) return { kind: 'start', gameId };

	// Actions
	if (/^income/.test(norm)) return { kind: 'action', action: 'income', targetHandle: null };
	if (/^foreign[\s_-]?aid/.test(norm))
		return { kind: 'action', action: 'foreign_aid', targetHandle: null };
	if (/^tax/.test(norm)) return { kind: 'action', action: 'tax', targetHandle: null };
	if (/^exchange/.test(norm)) return { kind: 'action', action: 'exchange', targetHandle: null };

	if (/^coup/.test(norm)) {
		const target = extractHandle(stripped);
		return { kind: 'action', action: 'coup', targetHandle: target };
	}
	if (/^assassinate/.test(norm)) {
		const target = extractHandle(stripped);
		return { kind: 'action', action: 'assassinate', targetHandle: target };
	}
	if (/^steal/.test(norm)) {
		const target = extractHandle(stripped);
		return { kind: 'action', action: 'steal', targetHandle: target };
	}

	// Responses
	if (/^challenge/.test(norm)) return { kind: 'challenge' };
	if (/^block/.test(norm)) {
		// Try to extract a role from the block command
		const roleMatch = norm.match(/block\s+(duke|captain|ambassador|contessa)/);
		const role = roleMatch ? (roleMatch[1] as CardRole) : null;
		return { kind: 'block', role };
	}
	if (/^pass/.test(norm)) return { kind: 'pass' };

	// Queries
	if (/^status/.test(norm)) return { kind: 'status' };
	if (/^(help|\?)/.test(norm)) return { kind: 'help' };

	return { kind: 'unknown', text: norm };
}

// ---------------------------------------------------------------------------
// DM commands (private)
// ---------------------------------------------------------------------------

export type DmCommand =
	| { kind: 'hand' }
	| { kind: 'reveal'; cardIndex: number }
	| { kind: 'reveal_role'; role: CardRole }
	| { kind: 'keep'; roles: CardRole[] }
	| { kind: 'queue' }
	| { kind: 'unqueue' }
	| { kind: 'queue_status' }
	| { kind: 'help' }
	| { kind: 'unknown'; text: string };

const VALID_ROLES: CardRole[] = ['duke', 'assassin', 'captain', 'ambassador', 'contessa'];

export function parseDm(text: string): DmCommand {
	const norm = text.trim().toLowerCase();

	if (/^(hand|cards|my\s+cards)$/.test(norm)) return { kind: 'hand' };
	if (/^(queue|lfg)$/.test(norm)) return { kind: 'queue' };
	if (/^unqueue$/.test(norm)) return { kind: 'unqueue' };
	if (/^queue\?$/.test(norm)) return { kind: 'queue_status' };
	if (/^(help|\?)$/.test(norm)) return { kind: 'help' };

	// "reveal 1" or "reveal 2" (1-indexed for humans)
	const revealIdx = norm.match(/^reveal\s+([12])$/);
	if (revealIdx) return { kind: 'reveal', cardIndex: Number.parseInt(revealIdx[1]!) - 1 };

	// "reveal duke" etc
	const revealRole = norm.match(/^reveal\s+(\w+)$/);
	if (revealRole && VALID_ROLES.includes(revealRole[1] as CardRole)) {
		return { kind: 'reveal_role', role: revealRole[1] as CardRole };
	}

	// "keep duke ambassador" — for exchange
	const keepMatch = norm.match(/^keep\s+(.+)$/);
	if (keepMatch) {
		const roles = keepMatch[1]!
			.split(/[\s,]+/)
			.filter((r): r is CardRole => VALID_ROLES.includes(r as CardRole));
		if (roles.length > 0) return { kind: 'keep', roles };
	}

	return { kind: 'unknown', text: norm };
}
