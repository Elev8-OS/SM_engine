import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { renderReel, validateReel } from '../src/reel.js';
import { renderCarousel, validateCarousel } from '../src/carousel.js';

async function fakePhoto(w, h, c1, c2) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${c1}"/><rect y="${h * 0.55}" width="${w}" height="${h * 0.45}" fill="${c2}"/><circle cx="${w * 0.7}" cy="${h * 0.3}" r="${h * 0.1}" fill="#fff"/></svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg().toBuffer();
  return { base64: buf.toString('base64') };
}

const photos = [
  { ...(await fakePhoto(3000, 2000, '#86B3E6', '#6FA33A')) },
  { ...(await fakePhoto(3840, 2160, '#86B3E6', '#5E9A2E')), line: 'Pool. Rice fields. Nothing in between.' },
  { ...(await fakePhoto(2400, 1600, '#2A2A2A', '#A8703F')), line: '3 en-suite bedrooms. Plus an office with sofa bed.', sub: '240 m² · up to 8 guests' },
  { ...(await fakePhoto(1200, 1800, '#E4DDD0', '#CFC6B4')), line: 'Your own bathroom. Skylight included.' }
];
const job = { photos, hook: 'Wake up to rice fields.', subhook: 'Villa Patuha · Pererenan, Bali', endCard: { title: 'Book direct. Best rate guaranteed.', subtitle: 'Skip the middleman.', cta: 'Link in bio' } };
validateReel(job);
const out = path.resolve('out');
await fs.mkdir(out, { recursive: true });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smtest-'));
console.time('reel');
const r = await renderReel(job, dir);
console.timeEnd('reel');
await fs.copyFile(r.file, path.join(out, 'test-reel.mp4'));
console.log('reel', r);

const cjob = { slides: [
  { photo: photos[0], headline: 'Wake up to rice fields.', sub: 'Villa Patuha · Pererenan, Bali' },
  { photo: photos[2], headline: '3 en-suite bedrooms. Plus an office with sofa bed.', sub: '240 m² · up to 8 guests', focus: 'left' },
  { photo: photos[0], headline: 'Pick your dates. We\'ll hold the villa.', cta: 'Link in bio', darken: true }
] };
validateCarousel(cjob);
const files = await renderCarousel(cjob, out);
console.log('carousel', files.map((f) => f.name));
