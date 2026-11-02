import path from 'node:path';
import sharp from 'sharp';
import { loadImage, HttpError } from './util.js';
import { slideOverlay } from './text.js';

const W = 1080;
const H = 1350;

export function validateCarousel(job) {
  if (!job || !Array.isArray(job.slides) || job.slides.length < 2 || job.slides.length > 10) {
    throw new HttpError(400, 'slides must contain 2 to 10 items');
  }
  for (const s of job.slides) {
    if (typeof s.headline !== 'string' || !s.headline.trim()) throw new HttpError(400, 'Each slide needs a headline');
    if (s.headline.length > 90) throw new HttpError(400, 'Headlines must be 90 characters or less');
  }
}

/**
 * Slide fields: photo ({url}|{base64}), headline, sub, cta, darken (bool),
 * focus ("left"|"center"|"right"), a crop hint for wide photos.
 */
export async function renderCarousel(job, dir) {
  const files = [];
  for (let i = 0; i < job.slides.length; i++) {
    const s = job.slides[i];
    const buf = await loadImage(s.photo || {});
    const position = { left: 'left', right: 'right', center: 'centre' }[s.focus] || 'centre';
    const base = await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize({ width: W, height: H, fit: 'cover', position })
      .toBuffer();
    const overlay = await slideOverlay({ width: W, height: H, headline: s.headline, sub: s.sub, cta: s.cta, darken: !!s.darken });
    const name = `${String(i + 1).padStart(2, '0')}.jpg`;
    const out = path.join(dir, name);
    await sharp(base).composite([{ input: overlay }]).jpeg({ quality: 90, mozjpeg: true }).toFile(out);
    files.push({ name, file: out });
  }
  return files;
}
