// pattern: Imperative Shell
// Re-exports from propter-bsky-kit — all Bluesky I/O now lives in the shared package.

export { createAgent, resolveHandle } from 'propter-bsky-kit';
export { postMessage, replyToPost } from 'propter-bsky-kit';
export { pollAllMentions } from 'propter-bsky-kit';
export type { PostRef } from 'propter-bsky-kit';

// DM re-exports (previously from ./dm.js, now from PBK)
export {
	createChatAgent,
	createBlueskyDmSender,
	createConsoleDmSender,
	pollInboundDms,
} from 'propter-bsky-kit';
export type { DmSender } from 'propter-bsky-kit';
