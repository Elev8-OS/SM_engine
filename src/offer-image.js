import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { q } from './db.js';
import { putFile } from './storage.js';
import { mediaUrl } from './media.js';

// The main photo of a catalog product with a red "SPECIAL OFFER" badge, for products with a running promotion.
// Tested on 7 November: Meta accepts it, WhatsApp keeps the additional photos, and the badge is readable once it sits inside the middle
// square (WhatsApp shows the main photo as a square cut from the middle). The badge photo is made once per original photo and kept
// (one public address per product), so a normal sync sends it only when a promotion starts and sends the original when it ends.

const RED = '#D7261E';
const WORDS = 'SPECIAL OFFER';
const MAX_AGE_MS = 200 * 86400000; // the public address is valid for a year; it is renewed long before

/**
 * The photo with the badge (JPEG buffer). Pure image work, no network.
 * WhatsApp shows the main photo as a SQUARE cut from the middle (a landscape photo loses its left and right edge, a portrait photo its
 * top and bottom), so the badge sits inside that middle square, at its top left, and is sized by the square, not by the photo.
 */
export async function badgeImage(buf, text = WORDS) {
  const base = await sharp(buf, { failOn: 'none' }).rotate().resize({ width: 1200 }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  const W = base.info.width;
  const H = base.info.height;
  const S = Math.min(W, H);
  const ox = Math.round((W - S) / 2);
  const oy = Math.round((H - S) / 2);
  const fs = Math.round(S * 0.058);
  const padX = Math.round(fs * 0.75);
  const padY = Math.round(fs * 0.5);
  const bw = Math.round(text.length * fs * 0.68) + padX * 2;
  const bh = fs + padY * 2;
  const m = Math.round(S * 0.05);
  const x = ox + m;
  const y = oy + m;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${Math.round(bh * 0.2)}" fill="${RED}"/><text x="${x + bw / 2}" y="${Math.round(y + bh / 2 + fs * 0.35)}" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="${fs}" font-weight="700" fill="#FFFFFF" text-anchor="middle" letter-spacing="1">${text}</text></svg>`;
  return sharp(base.data).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

/** Makes the badge photo and stores it; returns its public address. */
export async function makeOfferImage(retailerId, original) {
  const res = await fetch(original, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`the main photo could not be read (${res.status})`);
  const out = await badgeImage(Buffer.from(await res.arrayBuffer()));
  const name = `${retailerId}-offer-${Date.now()}.jpg`;
  const tmp = path.join(os.tmpdir(), name);
  await fs.writeFile(tmp, out);
  try {
    await putFile(tmp, `posts/9000/${name}`, 'image/jpeg');
  } finally {
    fs.rm(tmp, { force: true }).catch(() => {});
  }
  const url = mediaUrl(`posts/9000/${name}`);
  if (!url) throw new Error('no public address for the photo (PUBLIC_BASE_URL or RAILWAY_PUBLIC_DOMAIN, MEDIA_SECRET)');
  return url;
}

/**
 * The address of the badge photo of a product: the kept one while the original photo is the same, else a new one is made and kept.
 * Keeping the address matters: the same address means no change at Meta.
 */
export async function offerImageUrl(retailerId, original) {
  const k = `offerimg:${retailerId}`;
  const [row] = await q('select v from wa_catalog_state where k = $1', [k]);
  const v = row?.v;
  if (v?.url && v.original === original && Date.now() - Date.parse(v.at) < MAX_AGE_MS) return v.url;
  const url = await makeOfferImage(retailerId, original);
  await q(`insert into wa_catalog_state (k, v) values ($1, $2::jsonb) on conflict (k) do update set v = excluded.v, updated_at = now()`, [k, JSON.stringify({ original, url, at: new Date().toISOString() })]);
  return url;
}
