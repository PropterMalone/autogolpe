/**
 * Autogulp feed generator + FAQ server.
 * Serves /faq and basic health check. Feed skeleton endpoints are placeholders.
 */
import { createServer } from 'node:http';
import { FAQ_HTML } from './faq.js';

const PORT = Number(process.env['FEED_PORT']) || 3001;
const HOSTNAME = process.env['FEED_HOSTNAME'] ?? 'localhost';

const server = createServer((req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

	if (url.pathname === '/faq') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(FAQ_HTML);
		return;
	}

	if (url.pathname === '/.well-known/did.json') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				'@context': ['https://www.w3.org/ns/did/v1'],
				id: `did:web:${HOSTNAME}`,
				service: [
					{
						id: '#bsky_fg',
						type: 'BskyFeedGenerator',
						serviceEndpoint: `https://${HOSTNAME}`,
					},
				],
			}),
		);
		return;
	}

	if (url.pathname === '/') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('autogulp feed generator');
		return;
	}

	res.writeHead(404);
	res.end('not found');
});

server.listen(PORT, () => {
	console.log(`Autogulp feed generator listening on port ${PORT}`);
});
