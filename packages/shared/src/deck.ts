import type { CardRole } from './types.js';
import { ALL_ROLES, CARDS_PER_ROLE } from './types.js';

export type ShuffleFn = <T>(arr: T[]) => T[];

/** Fisher-Yates shuffle (in-place, returns same array) */
export function fisherYatesShuffle<T>(arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j]!, arr[i]!];
	}
	return arr;
}

/** No-op shuffle for deterministic tests */
export function noShuffle<T>(arr: T[]): T[] {
	return arr;
}

/** Create a full 15-card court deck */
export function createDeck(): CardRole[] {
	const deck: CardRole[] = [];
	for (const role of ALL_ROLES) {
		for (let i = 0; i < CARDS_PER_ROLE; i++) {
			deck.push(role);
		}
	}
	return deck;
}

/** Deal cards from the front of the deck */
export function dealCards(
	deck: CardRole[],
	count: number,
): { dealt: CardRole[]; remaining: CardRole[] } {
	return {
		dealt: deck.slice(0, count),
		remaining: deck.slice(count),
	};
}

/** Return cards to the deck and shuffle */
export function returnAndShuffle(
	deck: CardRole[],
	cards: CardRole[],
	shuffle: ShuffleFn = fisherYatesShuffle,
): CardRole[] {
	return shuffle([...deck, ...cards]);
}
