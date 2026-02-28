/**
 * One-shot script: sets display name, bio, and profile images on the bot's Bluesky profile.
 * Run with: npx tsx scripts/set-profile.ts [avatar-path] [banner-path]
 * Images are optional — omit to set text fields only.
 * Requires BSKY_IDENTIFIER and BSKY_PASSWORD env vars.
 */
import { AtpAgent } from '@atproto/api';
import sharp from 'sharp';

const MAX_AVATAR_SIZE = 800;
const MAX_BANNER_WIDTH = 1500;
const MAX_BLOB_BYTES = 950_000;

const DISPLAY_NAME = 'Autogulp';
const DESCRIPTION = `Coup on Bluesky — bluffing card game of political intrigue.

Claim roles, steal coins, assassinate rivals, bluff your way to power.

"queue" to play, "help" for commands. 3-6 players, ~10 min.

FAQ: https://malone.taildf301e.ts.net/autogolpe/faq`;

async function resizeForUpload(
	filePath: string,
	maxWidth: number,
	maxHeight?: number,
): Promise<Buffer> {
	let buf = await sharp(filePath)
		.resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
		.png()
		.toBuffer();

	if (buf.length > MAX_BLOB_BYTES) {
		buf = await sharp(filePath)
			.resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
			.jpeg({ quality: 85 })
			.toBuffer();
	}

	if (buf.length > MAX_BLOB_BYTES) {
		buf = await sharp(filePath)
			.resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
			.jpeg({ quality: 60 })
			.toBuffer();
	}

	return buf;
}

async function main() {
	const [avatarPath, bannerPath] = process.argv.slice(2);

	const identifier = process.env.BSKY_IDENTIFIER;
	const password = process.env.BSKY_PASSWORD;
	if (!identifier || !password) {
		console.error('Set BSKY_IDENTIFIER and BSKY_PASSWORD');
		process.exit(1);
	}

	const agent = new AtpAgent({ service: 'https://bsky.social' });
	await agent.login({ identifier, password });
	console.log(`Logged in as ${agent.session?.handle}`);

	let avatarBlob: Awaited<ReturnType<typeof agent.uploadBlob>> | undefined;
	let bannerBlob: Awaited<ReturnType<typeof agent.uploadBlob>> | undefined;

	if (avatarPath) {
		const buf = await resizeForUpload(avatarPath, MAX_AVATAR_SIZE, MAX_AVATAR_SIZE);
		const encoding = buf[0] === 0xff ? 'image/jpeg' : 'image/png';
		console.log(`Uploading avatar (${(buf.length / 1024).toFixed(0)} KB, ${encoding})...`);
		avatarBlob = await agent.uploadBlob(buf, { encoding });
	}

	if (bannerPath) {
		const buf = await resizeForUpload(bannerPath, MAX_BANNER_WIDTH, 500);
		const encoding = buf[0] === 0xff ? 'image/jpeg' : 'image/png';
		console.log(`Uploading banner (${(buf.length / 1024).toFixed(0)} KB, ${encoding})...`);
		bannerBlob = await agent.uploadBlob(buf, { encoding });
	}

	await agent.upsertProfile((existing) => ({
		...existing,
		displayName: DISPLAY_NAME,
		description: DESCRIPTION,
		...(avatarBlob ? { avatar: avatarBlob.data.blob } : {}),
		...(bannerBlob ? { banner: bannerBlob.data.blob } : {}),
	}));

	console.log('Profile updated!');
	if (!avatarPath || !bannerPath) {
		console.log('Run again with image paths to set avatar/banner:');
		console.log('  npx tsx scripts/set-profile.ts <avatar.png> <banner.png>');
	}
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
