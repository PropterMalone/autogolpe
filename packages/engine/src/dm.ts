/**
 * DM handling via chat.bsky.convo.
 * Adapted from Skeetwolf's dm.ts.
 */
import type { AtpAgent } from '@atproto/api';

export interface DmSender {
	sendDm(recipientDid: string, text: string): Promise<boolean>;
}

export interface InboundDm {
	senderDid: string;
	convoId: string;
	messageId: string;
	text: string;
	sentAt: string;
}

export function createChatAgent(agent: AtpAgent): AtpAgent {
	return agent.withProxy('bsky_chat', 'did:web:api.bsky.chat') as AtpAgent;
}

export function createBlueskyDmSender(chatAgent: AtpAgent): DmSender {
	const convoCache = new Map<string, string>();

	async function getOrCreateConvo(recipientDid: string): Promise<string> {
		const cached = convoCache.get(recipientDid);
		if (cached) return cached;

		const response = await chatAgent.chat.bsky.convo.getConvoForMembers({
			members: [recipientDid],
		});
		const convoId = response.data.convo.id;
		convoCache.set(recipientDid, convoId);
		return convoId;
	}

	return {
		async sendDm(recipientDid: string, text: string): Promise<boolean> {
			try {
				const convoId = await getOrCreateConvo(recipientDid);
				await chatAgent.chat.bsky.convo.sendMessage({
					convoId,
					message: { text },
				});
				return true;
			} catch (err) {
				console.error(`DM to ${recipientDid} failed:`, (err as Error).message ?? err);
				return false;
			}
		},
	};
}

export async function pollInboundDms(
	chatAgent: AtpAgent,
	sinceMessageId?: string,
): Promise<{ messages: InboundDm[]; latestMessageId: string | undefined }> {
	const botDid = chatAgent.session?.did;
	if (!botDid) throw new Error('chat agent not authenticated');

	const { data: convoList } = await chatAgent.chat.bsky.convo.listConvos({ limit: 50 });

	const allMessages: InboundDm[] = [];
	let latestId = sinceMessageId;

	for (const convo of convoList.convos) {
		if (convo.unreadCount === 0) continue;

		const { data: msgData } = await chatAgent.chat.bsky.convo.getMessages({
			convoId: convo.id,
			limit: 20,
		});

		for (const msg of msgData.messages) {
			const sender = msg.sender as { did: string };
			const msgId = msg.id as string;

			if (sender.did === botDid) continue;
			if (sinceMessageId && msgId <= sinceMessageId) continue;
			if (msg.$type !== 'chat.bsky.convo.defs#messageView') continue;

			allMessages.push({
				senderDid: sender.did,
				convoId: convo.id,
				messageId: msgId,
				text: (msg as { text?: string }).text ?? '',
				sentAt: msg.sentAt as string,
			});

			if (!latestId || msgId > latestId) {
				latestId = msgId;
			}
		}

		await chatAgent.chat.bsky.convo.updateRead({ convoId: convo.id });
	}

	return { messages: allMessages, latestMessageId: latestId };
}

export function createConsoleDmSender(): DmSender {
	return {
		async sendDm(recipientDid, text) {
			console.log(`[DM → ${recipientDid}] ${text}`);
			return true;
		},
	};
}
