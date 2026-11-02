import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { renderReel } from '../src/reel.js';

async function fakePhoto(w, h, c1, c2) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${c1}"/><rect y="${h * 0.55}" width="${w}" height="${h * 0.45}" fill="${c2}"/></svg>`;
  return { base64: (await sharp(Buffer.from(svg)).jpeg().toBuffer()).toString('base64') };
}

// Local test: uses a file path instead of a SharePoint URL (the API layer only accepts URLs).
// Create a sample first: ffmpeg -f lavfi -i testsrc2=size=3840x2160:rate=30 -t 10 -pix_fmt yuv420p /tmp/test4k.mp4
const file = process.argv[2] || '/tmp/test4k.mp4';
const job = {
  hook: 'Walk through Villa Samalas.',
  photos: [
    { video: { path: file, start: 1, focus: 0.5 } },
    { video: { path: file, start: 4, focus: 0.2 }, line: 'Open living, pool and garden.' },
    { ...(await fakePhoto(3000, 2000, '#86B3E6', '#6FA33A')), line: 'Rice field views.' },
    { video: { path: file, start: 7, focus: 0.8 }, line: '4 bedrooms.', sub: 'Up to 8 guests' }
  ],
  endCard: { title: 'Book direct. Best rate guaranteed.', cta: 'Link in bio' }
};
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smvid-'));
console.time('reel');
const r = await renderReel(job, dir);
console.timeEnd('reel');
await fs.mkdir('out', { recursive: true });
await fs.copyFile(r.file, 'out/video-reel.mp4');
console.log(r);
