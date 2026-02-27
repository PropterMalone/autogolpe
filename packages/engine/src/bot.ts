// pattern: Imperative Shell
// Re-exports from propter-bsky-kit — all Bluesky I/O now lives in the shared package.

export { createAgent, buildFacets, resolveHandle } from 'propter-bsky-kit';
export { postMessage, postMessageChain, replyToPost, replyToPostChain } from 'propter-bsky-kit';
export { splitForPost } from 'propter-bsky-kit';
export { graphemeLength, truncateToLimit } from 'propter-bsky-kit';
export { retryFetch } from 'propter-bsky-kit';
export { createRateLimiter } from 'propter-bsky-kit';
export { pollMentions, searchMentions, pollAllMentions } from 'propter-bsky-kit';
export type {
	BotConfig,
	PostRef,
	MentionNotification,
	DmResult,
	PostingOptions,
	PollMentionsOptions,
	SearchMentionsOptions,
	PollAllMentionsOptions,
} from 'propter-bsky-kit';

// DM re-exports (previously from ./dm.js, now from PBK)
export {
	createChatAgent,
	createBlueskyDmSender,
	createConsoleDmSender,
	pollInboundDms,
} from 'propter-bsky-kit';
export type { DmSender, InboundDm } from 'propter-bsky-kit';
