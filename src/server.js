import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { HttpError, createLimiter } from './util.js';
import { renderReel, validateReel } from './reel.js';
import { renderCarousel, validateCarousel } from './carousel.js';
import { storageEnabled, uploadFile } from './storage.js';

const app = express();
app.use(express.json({ limit: '60mb' }));

const limit = createLimiter(Number(process.env.MAX_CONCURRENT) || 1);

app.get('/health', (_req, res) => res.json({ ok: true, storage: storageEnabled() }));

app.use((req, res, next) => {
  const key = process.env.API_KEY;
  if (!key) return res.status(503).json({ error: 'API_KEY is not configured on the server' });
  const given = Buffer.from(String(req.get('x-api-key') || ''));
  const want = Buffer.from(key);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
});

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smengine-'));
  try {
    return await fn(dir);
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const wantsFile = (req) => req.query.return === 'file' || (!storageEnabled() && req.query.return !== 'base64');

app.post('/render/reel', async (req, res, next) => {
  try {
    validateReel(req.body);
    const result = await limit(() =>
      withTempDir(async (dir) => {
        const r = await renderReel(req.body, dir);
        if (wantsFile(req)) {
          const data = await fs.readFile(r.file);
          return { ...r, data };
        }
        const key = `reels/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`;
        const url = await uploadFile(r.file, key, 'video/mp4');
        return { ...r, url };
      })
    );
    if (result.data) {
      res.set({ 'Content-Type': 'video/mp4', 'X-Duration-Seconds': String(result.durationSeconds), 'X-Music': result.music || '' });
      return res.send(result.data);
    }
    res.json({ url: result.url, durationSeconds: result.durationSeconds, music: result.music });
  } catch (e) {
    next(e);
  }
});

app.post('/render/carousel', async (req, res, next) => {
  try {
    validateCarousel(req.body);
    const out = await limit(() =>
      withTempDir(async (dir) => {
        const files = await renderCarousel(req.body, dir);
        const batch = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const items = [];
        for (const f of files) {
          if (storageEnabled() && req.query.return !== 'base64') {
            items.push({ name: f.name, url: await uploadFile(f.file, `carousels/${batch}/${f.name}`, 'image/jpeg') });
          } else {
            items.push({ name: f.name, base64: (await fs.readFile(f.file)).toString('base64') });
          }
        }
        return items;
      })
    );
    res.json({ slides: out });
  } catch (e) {
    next(e);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Render failed', detail: String(err.message || err).slice(0, 500) });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`SM_engine listening on ${port}`));
