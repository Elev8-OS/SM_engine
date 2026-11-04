import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { q, dbEnabled } from './db.js';
import { HttpError, run } from './util.js';
import { putFile, presign, openObject, storageEnabled } from './storage.js';
import { cleanTrack, problem, choose, looksLikeMp3, MAX_BYTES } from './music-rules.js';

// Music library for the reels. The team uploads tracks in the SM Manager and confirms the license of each one.
// Only tracks with a confirmed license (and a reference) are ever used. Without such a track the reel stays silent.

let ready = null;
export function ensureMusicTable() {
  ready ??= q(`create table if not exists music_tracks (
    id serial primary key,
    created_at timestamptz not null default now(),
    title text not null,
    provider text not null default '',
    mood text not null default 'any',
    license_ref text not null default '',
    license_ok boolean not null default false,
    active boolean not null default true,
    note text not null default '',
    s3_key text not null,
    size_bytes int,
    used_count int not null default 0,
    last_used_at timestamptz
  )`).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

const COLS = 'id, created_at, title, provider, mood, license_ref, license_ok, active, note, s3_key, size_bytes, used_count, last_used_at';

/** Picks a licensed track for a mood and copies it into dir. Returns { file, id, title } or null (the reel is then silent). */
export async function pickLibraryTrack({ dir, mood } = {}) {
  if (!dbEnabled()) return null;
  try {
    await ensureMusicTable();
    const rows = await q(`select ${COLS} from music_tracks where license_ok and active`);
    const t = choose(rows, mood);
    if (!t) return null;
    const file = path.join(dir, 'music.mp3');
    const o = await openObject(t.s3_key);
    await pipeline(o.stream, createWriteStream(file));
    await q('update music_tracks set used_count = used_count + 1, last_used_at = now() where id = $1', [t.id]);
    return { file, id: t.id, title: t.title };
  } catch (e) {
    console.error('Music library:', e.message);
    return null;
  }
}

const bad = (e) => new HttpError(400, String(e.message || e));

export function musicRoutes(app, needDb, ah) {
  app.get('/music', needDb, ah(async (_req, res) => {
    await ensureMusicTable();
    const rows = await q(`select ${COLS} from music_tracks order by license_ok desc, id desc`);
    const tracks = await Promise.all(
      rows.map(async (r) => {
        let previewUrl = null;
        try {
          previewUrl = await presign(r.s3_key, 6 * 3600);
        } catch {
          previewUrl = null;
        }
        const { s3_key: _key, ...rest } = r;
        return { ...rest, previewUrl };
      })
    );
    res.json({ storage: storageEnabled(), usable: rows.filter((r) => r.license_ok && r.active).length, tracks });
  }));

  // Upload: JSON with the file as base64 in data (what the SM Manager sends)
  app.post('/music', needDb, ah(async (req, res) => {
    await ensureMusicTable();
    const b = req.body || {};
    let clean;
    try {
      clean = cleanTrack(b, { create: true });
    } catch (e) {
      throw bad(e);
    }
    const t = { provider: '', license_ref: '', note: '', mood: 'any', license_ok: false, active: true, ...clean };
    const err = problem(t);
    if (err) throw new HttpError(400, err);
    const buf = Buffer.from(String(b.data || ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'There is no file');
    if (buf.length > MAX_BYTES) throw new HttpError(400, 'The file is larger than 15 MB');
    if (!looksLikeMp3(buf)) throw new HttpError(400, 'This does not look like an MP3 file');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smmusic-'));
    try {
      const file = path.join(dir, 'track.mp3');
      await fs.writeFile(file, buf);
      try {
        await run('ffmpeg', ['-v', 'error', '-i', file, '-t', '2', '-f', 'null', '-']);
      } catch {
        throw new HttpError(400, 'The file could not be read as audio');
      }
      const key = `music/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`;
      await putFile(file, key, 'audio/mpeg');
      const rows = await q(
        `insert into music_tracks (title, provider, mood, license_ref, license_ok, active, note, s3_key, size_bytes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${COLS}`,
        [t.title, t.provider, t.mood, t.license_ref, t.license_ok, t.active, t.note, key, buf.length]
      );
      res.status(201).json(rows[0]);
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }));

  app.put('/music/:id', needDb, ah(async (req, res) => {
    await ensureMusicTable();
    const id = Number(req.params.id);
    const [old] = await q(`select ${COLS} from music_tracks where id = $1`, [id]);
    if (!old) throw new HttpError(404, 'Track not found');
    let clean;
    try {
      clean = cleanTrack(req.body || {});
    } catch (e) {
      throw bad(e);
    }
    const t = { ...old, ...clean };
    const err = problem(t);
    if (err) throw new HttpError(400, err);
    const rows = await q(
      `update music_tracks set title=$2, provider=$3, mood=$4, license_ref=$5, license_ok=$6, active=$7, note=$8 where id = $1 returning ${COLS}`,
      [id, t.title, t.provider, t.mood, t.license_ref, t.license_ok, t.active, t.note]
    );
    res.json(rows[0]);
  }));

  app.delete('/music/:id', needDb, ah(async (req, res) => {
    await ensureMusicTable();
    await q('delete from music_tracks where id = $1', [Number(req.params.id)]);
    res.json({ id: Number(req.params.id), deleted: true });
  }));
}
