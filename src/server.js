import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { HttpError, createLimiter } from './util.js';
import { renderReel, validateReel } from './reel.js';
import { renderCarousel, validateCarousel } from './carousel.js';
import { storageEnabled, uploadFile, openObject } from './storage.js';
import { verifyMedia } from './media.js';
import { dbEnabled, migrate, q } from './db.js';
import { seedProperties } from './seed.js';
import { planNext } from './planner.js';
import { renderPost, listPosts, postView, draftToGhl, setStatus } from './posts.js';
import { ghlConfigured, listAccounts, listUsers, getStatistics } from './ghl.js';
import { goHandler, clickStats } from './links.js';
import { agentPublic, agentPrivate } from './agent/routes.js';
import { insightsRoutes } from './insights.js';

const app = express();
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: false, limit: '5mb' }));

const limit = createLimiter(Number(process.env.MAX_CONCURRENT) || 1);

app.get('/health', (_req, res) => res.json({ ok: true, storage: storageEnabled(), database: dbEnabled(), ghl: ghlConfigured() }));

// Signed public media links (no API key): the signature in the link is the access control.
app.get('/m/:id/:name', async (req, res, next) => {
  try {
    const { id, name } = req.params;
    if (!/^\d+$/.test(id) || !/^[\w.-]+$/.test(name) || !verifyMedia(id, name, req.query.exp, req.query.sig)) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }
    const o = await openObject(`posts/${id}/${name}`, req.get('range'));
    res.status(o.status);
    res.set({ 'Content-Type': o.contentType || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
    if (o.contentLength != null) res.set('Content-Length', String(o.contentLength));
    if (o.contentRange) res.set('Content-Range', o.contentRange);
    o.stream.on('error', next);
    o.stream.pipe(res);
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    next(e);
  }
});

// Public tracked link for the bio and ads: records the click, then redirects with UTM parameters.
app.get('/go/:id', (req, res, next) => goHandler(req, res).catch(next));

agentPublic(app);

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


const needDb = (_req, _res, next) => (dbEnabled() ? next() : next(new HttpError(503, 'DATABASE_URL is not configured')));
const ah = (fn) => (req, res, next) => fn(req, res).catch(next);

// Plan the post for a day (default: today in Bali). Safe to call twice, it returns the same plan.
// Optional propertyKey plans it for that villa instead of the next one in the rotation.
app.post('/plan/next', needDb, ah(async (req, res) => {
  const base = req.body?.date ? new Date(`${req.body.date}T00:00:00Z`) : new Date(Date.now() + 8 * 3600 * 1000);
  if (Number.isNaN(base.getTime())) throw new HttpError(400, 'date must be YYYY-MM-DD');
  const day = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const propertyKey = req.body?.propertyKey ? String(req.body.propertyKey) : undefined;
  res.json(await planNext(day, { propertyKey }));
}));

app.get('/posts', needDb, ah(async (req, res) => res.json({ posts: await listPosts({ status: req.query.status, limit: Math.min(Number(req.query.limit) || 50, 200) }) })));
app.get('/posts/:id', needDb, ah(async (req, res) => res.json(await postView(Number(req.params.id)))));
app.post('/posts/:id/render', needDb, ah(async (req, res) => res.json(await limit(() => renderPost(Number(req.params.id), req.body)))));
app.post('/posts/:id/ghl-draft', needDb, ah(async (req, res) => res.json(await draftToGhl(Number(req.params.id)))));
app.post('/posts/:id/status', needDb, ah(async (req, res) => res.json(await setStatus(Number(req.params.id), req.body || {}))));

app.get('/properties', needDb, ah(async (_req, res) => {
  res.json({ properties: await q(`select p.*, (select count(*) from photos x where x.property_key = p.key and x.quality >= 4 and x.approved)::int as good_photos, (select count(*) from photos x where x.property_key = p.key)::int as photos from properties p order by p.key`) });
}));
app.put('/properties/:key', needDb, ah(async (req, res) => {
  const allowed = ['name', 'area', 'type', 'guests', 'size_m2', 'bedrooms', 'url', 'highlights', 'open_questions', 'active'];
  const sets = [];
  const vals = [req.params.key];
  for (const k of allowed) {
    if (k in (req.body || {})) {
      vals.push(req.body[k]);
      sets.push(`${k} = $${vals.length}`);
    }
  }
  if (!sets.length) throw new HttpError(400, 'No known fields to update');
  const rows = await q(`update properties set ${sets.join(', ')} where key = $1 returning *`, vals);
  if (!rows.length) throw new HttpError(404, 'Property not found');
  res.json(rows[0]);
}));

// Photo catalog: upsert analysed photos. Usage counters are kept on update.
app.post('/catalog/upsert', needDb, ah(async (req, res) => {
  const body = req.body || {};
  const { propertyKey } = body;
  // JSON with items[], or form fields for a single photo (what Make sends safely)
  const items = Array.isArray(body.items) ? body.items : body.fileId ? [body] : null;
  if (!propertyKey || !items || !items.length || items.length > 500) throw new HttpError(400, 'propertyKey and 1 to 500 items are required');
  const bool = (v) => v === true || String(v).toLowerCase() === 'true';
  const int = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
  const prop = await q('select key from properties where key = $1', [propertyKey]);
  if (!prop.length) throw new HttpError(404, `Unknown property: ${propertyKey}`);
  let n = 0;
  for (const i of items) {
    if (!i.fileId) continue;
    await q(
      `insert into photos (file_id, property_key, name, web_url, size_bytes, room, motif, time_of_day, quality, issues, has_people, orientation, reel_fit)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (file_id) do update set name = excluded.name, web_url = excluded.web_url, size_bytes = excluded.size_bytes, room = excluded.room, motif = excluded.motif,
         time_of_day = excluded.time_of_day, quality = excluded.quality, issues = excluded.issues, has_people = excluded.has_people, orientation = excluded.orientation,
         reel_fit = excluded.reel_fit, analyzed_at = now()`,
      [i.fileId, propertyKey, i.name ?? null, i.webUrl ?? null, int(i.sizeBytes), i.room ?? null, i.motif ?? null, i.timeOfDay ?? null, int(i.quality), i.issues ?? null, bool(i.hasPeople), i.orientation ?? null, bool(i.reelFit)]
    );
    n++;
  }
  res.json({ upserted: n });
}));
app.get('/catalog/stats', needDb, ah(async (_req, res) => {
  res.json({ perProperty: await q(`select property_key, count(*)::int as photos, count(*) filter (where quality >= 4)::int as good, round(avg(quality), 1)::float as avg_quality from photos group by property_key order by property_key`) });
}));

// Helpers to find the ids needed for GHL_ACCOUNT_IDS and GHL_USER_ID. Need only GHL_API_TOKEN and GHL_LOCATION_ID.
const needGhlBase = (_req, _res, next) => (process.env.GHL_API_TOKEN && process.env.GHL_LOCATION_ID ? next() : next(new HttpError(409, 'Set GHL_API_TOKEN and GHL_LOCATION_ID first')));
app.get('/ghl/accounts', needGhlBase, ah(async (_req, res) => res.json(await listAccounts())));
app.get('/ghl/users', needGhlBase, ah(async (_req, res) => res.json(await listUsers())));

// Numbers for the dashboard: GHL social analytics and tracked link clicks.
app.get('/stats/social', needGhlBase, ah(async (_req, res) => res.json(await getStatistics())));
app.get('/stats/clicks', needDb, ah(async (req, res) => res.json(await clickStats(req.query.days))));

agentPrivate(app, needDb, ah);
insightsRoutes(app, needDb, ah);

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Render failed', detail: String(err.message || err).slice(0, 500) });
});

if (dbEnabled()) {
  migrate().then(seedProperties).then(() => console.log('Database ready')).catch((e) => console.error('Database setup failed', e));
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`SM_engine listening on ${port}`));
