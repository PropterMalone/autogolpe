import { describe, expect, it } from 'vitest';
import { parseDm, parseMention } from './command-parser.js';

const BOT = 'autogolpe.bsky.social';

describe('parseMention', () => {
	it('parses new game', () => {
		const result = parseMention('@autogolpe.bsky.social new game', BOT);
		expect(result).toEqual({ kind: 'new_game' });
	});

	it('parses queue commands', () => {
		expect(parseMention('@autogolpe.bsky.social queue', BOT)).toEqual({ kind: 'queue' });
		expect(parseMention('@autogolpe.bsky.social lfg', BOT)).toEqual({ kind: 'queue' });
		expect(parseMention('@autogolpe.bsky.social unqueue', BOT)).toEqual({ kind: 'unqueue' });
		expect(parseMention('@autogolpe.bsky.social queue?', BOT)).toEqual({ kind: 'queue_status' });
	});

	it('parses income', () => {
		const result = parseMention('@autogolpe.bsky.social income', BOT);
		expect(result).toEqual({ kind: 'action', action: 'income', targetHandle: null });
	});

	it('parses foreign aid variants', () => {
		expect(parseMention('@autogolpe.bsky.social foreign aid', BOT)).toEqual({
			kind: 'action',
			action: 'foreign_aid',
			targetHandle: null,
		});
		expect(parseMention('@autogolpe.bsky.social foreign-aid', BOT)).toEqual({
			kind: 'action',
			action: 'foreign_aid',
			targetHandle: null,
		});
		expect(parseMention('@autogolpe.bsky.social foreignaid', BOT)).toEqual({
			kind: 'action',
			action: 'foreign_aid',
			targetHandle: null,
		});
	});

	it('parses tax', () => {
		expect(parseMention('@autogolpe.bsky.social tax', BOT)).toEqual({
			kind: 'action',
			action: 'tax',
			targetHandle: null,
		});
	});

	it('parses exchange', () => {
		expect(parseMention('@autogolpe.bsky.social exchange', BOT)).toEqual({
			kind: 'action',
			action: 'exchange',
			targetHandle: null,
		});
	});

	it('parses coup with target', () => {
		const result = parseMention('@autogolpe.bsky.social coup @alice.bsky.social', BOT);
		expect(result).toEqual({ kind: 'action', action: 'coup', targetHandle: 'alice.bsky.social' });
	});

	it('parses assassinate with target', () => {
		const result = parseMention('@autogolpe.bsky.social assassinate @bob.bsky.social', BOT);
		expect(result).toEqual({
			kind: 'action',
			action: 'assassinate',
			targetHandle: 'bob.bsky.social',
		});
	});

	it('parses steal with target', () => {
		const result = parseMention('@autogolpe.bsky.social steal @carol.bsky.social', BOT);
		expect(result).toEqual({
			kind: 'action',
			action: 'steal',
			targetHandle: 'carol.bsky.social',
		});
	});

	it('parses challenge', () => {
		expect(parseMention('@autogolpe.bsky.social challenge', BOT)).toEqual({ kind: 'challenge' });
	});

	it('parses block with role', () => {
		expect(parseMention('@autogolpe.bsky.social block duke', BOT)).toEqual({
			kind: 'block',
			role: 'duke',
		});
		expect(parseMention('@autogolpe.bsky.social block contessa', BOT)).toEqual({
			kind: 'block',
			role: 'contessa',
		});
	});

	it('parses block without role', () => {
		expect(parseMention('@autogolpe.bsky.social block', BOT)).toEqual({
			kind: 'block',
			role: null,
		});
	});

	it('parses pass', () => {
		expect(parseMention('@autogolpe.bsky.social pass', BOT)).toEqual({ kind: 'pass' });
	});

	it('parses status', () => {
		expect(parseMention('@autogolpe.bsky.social status', BOT)).toEqual({ kind: 'status' });
	});

	it('parses help', () => {
		expect(parseMention('@autogolpe.bsky.social help', BOT)).toEqual({ kind: 'help' });
		expect(parseMention('@autogolpe.bsky.social ?', BOT)).toEqual({ kind: 'help' });
	});

	it('returns unknown for unrecognized text', () => {
		const result = parseMention('@autogolpe.bsky.social something weird', BOT);
		expect(result.kind).toBe('unknown');
	});

	it('handles smart quotes', () => {
		const result = parseMention('\u201C@autogolpe.bsky.social income\u201D', BOT);
		expect(result).toEqual({ kind: 'action', action: 'income', targetHandle: null });
	});
});

describe('parseDm', () => {
	it('parses hand commands', () => {
		expect(parseDm('hand')).toEqual({ kind: 'hand' });
		expect(parseDm('cards')).toEqual({ kind: 'hand' });
		expect(parseDm('my cards')).toEqual({ kind: 'hand' });
	});

	it('parses reveal by index (1-indexed)', () => {
		expect(parseDm('reveal 1')).toEqual({ kind: 'reveal', cardIndex: 0 });
		expect(parseDm('reveal 2')).toEqual({ kind: 'reveal', cardIndex: 1 });
	});

	it('parses reveal by role', () => {
		expect(parseDm('reveal duke')).toEqual({ kind: 'reveal_role', role: 'duke' });
		expect(parseDm('reveal contessa')).toEqual({ kind: 'reveal_role', role: 'contessa' });
	});

	it('parses keep for exchange', () => {
		expect(parseDm('keep duke ambassador')).toEqual({
			kind: 'keep',
			roles: ['duke', 'ambassador'],
		});
		expect(parseDm('keep captain, contessa')).toEqual({
			kind: 'keep',
			roles: ['captain', 'contessa'],
		});
	});

	it('parses queue commands', () => {
		expect(parseDm('queue')).toEqual({ kind: 'queue' });
		expect(parseDm('lfg')).toEqual({ kind: 'queue' });
		expect(parseDm('unqueue')).toEqual({ kind: 'unqueue' });
		expect(parseDm('queue?')).toEqual({ kind: 'queue_status' });
	});

	it('parses help', () => {
		expect(parseDm('help')).toEqual({ kind: 'help' });
		expect(parseDm('?')).toEqual({ kind: 'help' });
	});

	it('returns unknown for unrecognized text', () => {
		const result = parseDm('random stuff');
		expect(result.kind).toBe('unknown');
	});
});
