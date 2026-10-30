import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const publicDir = path.join(root, 'public');

await fs.mkdir(publicDir, { recursive: true });
await Promise.all([
	sharp(path.join(publicDir, 'og-image.svg'))
		.png({ compressionLevel: 9, quality: 92 })
		.toFile(path.join(publicDir, 'og-image.png')),
	sharp(path.join(publicDir, 'favicon.svg'))
		.resize(180, 180)
		.png()
		.toFile(path.join(publicDir, 'apple-touch-icon.png')),
	sharp(path.join(publicDir, 'favicon.svg'))
		.resize(192, 192)
		.png()
		.toFile(path.join(publicDir, 'icon-192.png')),
	sharp(path.join(publicDir, 'favicon.svg'))
		.resize(512, 512)
		.png()
		.toFile(path.join(publicDir, 'icon-512.png')),
]);

console.log('Brand assets generated.');