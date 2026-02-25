/**
 * Bluesky bot interactions — posting, mention polling, handle resolution.
 * Adapted from Skeetwolf's bot.ts. All ATProto I/O lives here.
 */
import { AtpAgent, RichText } from '@atproto/api';

const BLUESKY_MAX_GRAPHEMES = 300;

export function truncateToLimit(text: string, limit = BLUESKY_MAX_GRAPHEMES): string {
	const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
	const segments = [...segmenter.segment(text)];
	if (segments.length <= limit) return text;
	return `${segments
		.slice(0, limit - 1)
		.map((s) => s.segment)
		.join('')}…`;
}

function graphemeLength(text: string): number {
	const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
	let count = 0;
	for (const _ of segmenter.segment(text)) count++;
	return count;
}

/**
 * Split text into chunks that fit Bluesky's grapheme limit.
 * Never splits inside an @mention.
 */
export function splitForPost(text: string, limit = BLUESKY_MAX_GRAPHEMES): [string, ...string[]] {
	if (graphemeLength(text) <= limit) return [text];

	const paragraphs = text.split('\n\n');
	const chunks: string[] = [];
	let current = '';

	for (const para of paragraphs) {
		const candidate = current ? `${current}\n\n${para}` : para;
		if (graphemeLength(candidate) <= limit) {
			current = candidate;
		} else if (!current) {
			for (const piece of splitParagraph(para, limit)) {
				chunks.push(piece);
			}
		} else {
			chunks.push(current);
			if (graphemeLength(para) <= limit) {
				current = para;
			} else {
				current = '';
				for (const piece of splitParagraph(para, limit)) {
					chunks.push(piece);
				}
			}
		}
	}
	if (current) chunks.push(current);
	return chunks as [string, ...string[]];
}

function splitParagraph(para: string, limit: number): string[] {
	const lines = para.split('\n');
	const chunks: string[] = [];
	let current = '';

	for (const line of lines) {
		const candidate = current ? `${current}\n${line}` : line;
		if (graphemeLength(candidate) <= limit) {
			current = candidate;
		} else if (!current) {
			for (const piece of splitLine(line, limit)) {
				chunks.push(piece);
			}
		} else {
			chunks.push(current);
			if (graphemeLength(line) <= limit) {
				current = line;
			} else {
				current = '';
				for (const piece of splitLine(line, limit)) {
					chunks.push(piece);
				}
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function splitLine(line: string, limit: number): string[] {
	const tokens = tokenize(line);
	const chunks: string[] = [];
	let current = '';

	for (const token of tokens) {
		const candidate = current ? `${current} ${token}` : token;
		if (graphemeLength(candidate) <= limit) {
			current = candidate;
		} else {
			if (current) chunks.push(current);
			if (graphemeLength(token) > limit) {
				const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
				let buf = '';
				for (const { segment } of segmenter.segment(token)) {
					if (graphemeLength(buf + segment) > limit) {
						chunks.push(buf);
						buf = segment;
					} else {
						buf += segment;
					}
				}
				current = buf;
			} else {
				current = token;
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function tokenize(text: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	let current = '';

	while (i < text.length) {
		if (text[i] === '@') {
			let mention = '@';
			i++;
			while (i < text.length && !/\s/.test(text[i] ?? '')) {
				mention += text[i];
				i++;
			}
			current += mention;
		} else if (text[i] === ' ') {
			if (current) tokens.push(current);
			current = '';
			i++;
		} else {
			current += text[i];
			i++;
		}
	}
	if (current) tokens.push(current);
	return tokens;
}

export interface BotConfig {
	identifier: string;
	password: string;
	service?: string;
}

export async function createAgent(config: BotConfig): Promise<AtpAgent> {
	const agent = new AtpAgent({
		service: config.service ?? 'https://bsky.social',
	});
	await agent.login({
		identifier: config.identifier,
		password: config.password,
	});
	return agent;
}

async function buildFacets(
	agent: AtpAgent,
	text: string,
): Promise<{ text: string; facets: RichText['facets'] }> {
	const rt = new RichText({ text });
	await rt.detectFacets(agent);
	return { text: rt.text, facets: rt.facets };
}

export type PostRef = { uri: string; cid: string };

export async function postMessage(agent: AtpAgent, text: string): Promise<PostRef> {
	const [first] = await postMessageChain(agent, text);
	return first;
}

export async function postMessageChain(
	agent: AtpAgent,
	text: string,
): Promise<[PostRef, ...PostRef[]]> {
	const [firstChunk, ...restChunks] = splitForPost(text);
	const { facets: firstFacets } = await buildFacets(agent, firstChunk);
	const firstRecord: Record<string, unknown> = { text: firstChunk };
	if (firstFacets?.length) firstRecord['facets'] = firstFacets;
	const firstResponse = await agent.post(firstRecord);
	const first: PostRef = { uri: firstResponse.uri, cid: firstResponse.cid };
	const refs: [PostRef, ...PostRef[]] = [first];

	let prev = first;
	for (const chunk of restChunks) {
		const { facets } = await buildFacets(agent, chunk);
		const record: Record<string, unknown> = {
			text: chunk,
			reply: {
				parent: { uri: prev.uri, cid: prev.cid },
				root: { uri: first.uri, cid: first.cid },
			},
		};
		if (facets?.length) record['facets'] = facets;
		const response = await agent.post(record);
		prev = { uri: response.uri, cid: response.cid };
		refs.push(prev);
	}

	return refs;
}

export async function replyToPost(
	agent: AtpAgent,
	text: string,
	parentUri: string,
	parentCid: string,
	rootUri: string,
	rootCid: string,
): Promise<PostRef> {
	const [first] = await replyToPostChain(agent, text, parentUri, parentCid, rootUri, rootCid);
	return first;
}

export async function replyToPostChain(
	agent: AtpAgent,
	text: string,
	parentUri: string,
	parentCid: string,
	rootUri: string,
	rootCid: string,
): Promise<[PostRef, ...PostRef[]]> {
	const [firstChunk, ...restChunks] = splitForPost(text);
	const { facets: firstFacets } = await buildFacets(agent, firstChunk);
	const firstRecord: Record<string, unknown> = {
		text: firstChunk,
		reply: {
			parent: { uri: parentUri, cid: parentCid },
			root: { uri: rootUri, cid: rootCid },
		},
	};
	if (firstFacets?.length) firstRecord['facets'] = firstFacets;
	const firstResponse = await agent.post(firstRecord);
	const first: PostRef = { uri: firstResponse.uri, cid: firstResponse.cid };
	const refs: [PostRef, ...PostRef[]] = [first];

	let prev = first;
	for (const chunk of restChunks) {
		const { facets } = await buildFacets(agent, chunk);
		const record: Record<string, unknown> = {
			text: chunk,
			reply: {
				parent: { uri: prev.uri, cid: prev.cid },
				root: { uri: rootUri, cid: rootCid },
			},
		};
		if (facets?.length) record['facets'] = facets;
		const response = await agent.post(record);
		prev = { uri: response.uri, cid: response.cid };
		refs.push(prev);
	}

	return refs;
}

export async function pollMentions(
	agent: AtpAgent,
): Promise<{ notifications: MentionNotification[] }> {
	const allMentions: MentionNotification[] = [];
	let pageCursor: string | undefined;

	for (let page = 0; page < 5; page++) {
		const response = await agent.listNotifications({ cursor: pageCursor, limit: 50 });
		const notifs = response.data.notifications;
		if (notifs.length === 0) break;

		const mentions = notifs
			.filter((n) => (n.reason === 'mention' || n.reason === 'reply') && !n.isRead)
			.map((n) => ({
				uri: n.uri,
				cid: n.cid,
				authorDid: n.author.did,
				authorHandle: n.author.handle,
				text: (n.record as { text?: string }).text ?? '',
				indexedAt: n.indexedAt,
			}));

		allMentions.push(...mentions);
		if (notifs.some((n) => n.isRead)) break;

		pageCursor = response.data.cursor;
		if (!pageCursor) break;
	}

	if (allMentions.length > 0) {
		await agent.updateSeenNotifications();
	}

	return { notifications: allMentions };
}

export interface MentionNotification {
	uri: string;
	cid: string;
	authorDid: string;
	authorHandle: string;
	text: string;
	indexedAt: string;
}

export async function resolveHandle(agent: AtpAgent, handle: string): Promise<string | null> {
	try {
		const response = await agent.resolveHandle({ handle });
		return response.data.did;
	} catch {
		return null;
	}
}

export type { DmSender, InboundDm } from './dm.js';
export {
	createBlueskyDmSender,
	createConsoleDmSender,
	createChatAgent,
	pollInboundDms,
} from './dm.js';
