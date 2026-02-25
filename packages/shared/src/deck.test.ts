import { describe, expect, it } from 'vitest';
import { createDeck, dealCards, noShuffle, returnAndShuffle } from './deck.js';

describe('createDeck', () => {
	it('creates 15 cards with 3 of each role', () => {
		const deck = createDeck();
		expect(deck).toHaveLength(15);

		const counts = new Map<string, number>();
		for (const role of deck) {
			counts.set(role, (counts.get(role) ?? 0) + 1);
		}
		expect(counts.get('duke')).toBe(3);
		expect(counts.get('assassin')).toBe(3);
		expect(counts.get('captain')).toBe(3);
		expect(counts.get('ambassador')).toBe(3);
		expect(counts.get('contessa')).toBe(3);
	});
});

describe('dealCards', () => {
	it('deals from the front and returns remaining', () => {
		const deck = createDeck();
		const { dealt, remaining } = dealCards(deck, 2);
		expect(dealt).toHaveLength(2);
		expect(remaining).toHaveLength(13);
		expect(dealt[0]).toBe(deck[0]);
		expect(dealt[1]).toBe(deck[1]);
	});

	it('deals nothing with count 0', () => {
		const deck = createDeck();
		const { dealt, remaining } = dealCards(deck, 0);
		expect(dealt).toHaveLength(0);
		expect(remaining).toHaveLength(15);
	});
});

describe('returnAndShuffle', () => {
	it('returns cards to deck and applies shuffle', () => {
		const deck = ['duke', 'duke'] as const;
		const returned = ['captain'] as const;
		const result = returnAndShuffle([...deck], [...returned], noShuffle);
		expect(result).toHaveLength(3);
		expect(result).toContain('duke');
		expect(result).toContain('captain');
	});
});
