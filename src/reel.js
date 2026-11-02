import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { run, loadImage, assertVideoUrl, HttpError } from './util.js';
import { reelOverlay, endCard } from './text.js';

const W = 1080;
const H = 1920;
const FPS = 30;
const XF = 0.4; // crossfade seconds
const MIN_WIDTH = 1296; // photos narrower than this (after scaling to 1920 high) get a small pan range

async function pickMusic(name) {
  const dir = path.resolve('assets/music');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.mp3'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  if (name) {
    const hit = files.find((f) => f.toLowerCase() === `${name.toLowerCase()}.mp3`);
    if (!hit) throw new HttpError(400, `Unknown music track: ${name}`);
    return path.join(dir, hit);
  }
  return path.join(dir, files[Math.floor(Math.random() * files.length)]);
}

export function validateReel(job) {
  if (!job || typeof job !== 'object') throw new HttpError(400, 'Body must be a JSON object');
  if (!Array.isArray(job.photos) || job.photos.length < 2 || job.photos.length > 8) {
    throw new HttpError(400, 'photos must contain 2 to 8 items');
  }
  if (typeof job.hook !== 'string' || !job.hook.trim()) throw new HttpError(400, 'hook is required');
  for (const p of job.photos) {
    if (p.line != null && String(p.line).length > 80) throw new HttpError(400, 'Photo lines must be 80 characters or less');
    if (p.video) {
      assertVideoUrl(p.video.url);
      const start = Number(p.video.start ?? 0);
      if (!(start >= 0) || start > 36000) throw new HttpError(400, 'video.start must be between 0 and 36000 seconds');
    }
  }
  if (String(job.hook).length > 80) throw new HttpError(400, 'hook must be 80 characters or less');
}

/** Scale a photo to 1920 px height and make sure there is room to pan. */
async function preparePhoto(buf, out) {
  const img = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await img.clone().metadata();
  const rotated = meta.orientation && meta.orientation >= 5;
  const w0 = rotated ? meta.height : meta.width;
  const h0 = rotated ? meta.width : meta.height;
  if (!w0 || !h0) throw new HttpError(400, 'Could not read photo dimensions');
  const scaledW = Math.round((w0 * H) / h0);
  let pipeline;
  let finalW;
  if (scaledW < MIN_WIDTH) {
    pipeline = img.resize({ width: MIN_WIDTH, height: H, fit: 'cover' });
    finalW = MIN_WIDTH;
  } else {
    pipeline = img.resize({ height: H });
    finalW = scaledW;
  }
  await pipeline.jpeg({ quality: 90 }).toFile(out);
  return finalW;
}

export async function renderReel(job, dir) {
  const per = Number(job.secondsPerPhoto) > 0 ? Math.min(Number(job.secondsPerPhoto), 6) : 2.7;
  const hookSec = Number(job.hookSeconds) > 0 ? Math.min(Number(job.hookSeconds), 6) : 2.5;
  const endSec = Number(job.endSeconds) > 0 ? Math.min(Number(job.endSeconds), 8) : 3;

  const clips = []; // { file, dur }
  for (let i = 0; i < job.photos.length; i++) {
    const p = job.photos[i];
    const headline = i === 0 ? job.hook : p.line;
    const overlay = headline ? path.join(dir, `text${i}.png`) : null;
    if (overlay) {
      await fs.writeFile(overlay, await reelOverlay({ width: W, height: H, headline, sub: i === 0 ? job.subhook : p.sub, big: i === 0 }));
    }
    const dur = i === 0 ? hookSec : per;
    const T = (dur + XF).toFixed(3);
    const out = path.join(dir, `clip${i}.mp4`);
    const args = ['-y'];
    let graph;
    if (p.video) {
      // Video segment: seek first (fast, uses HTTP range requests), cut to 9:16, no sound.
      const start = Number(p.video.start ?? 0);
      const focus = Math.min(1, Math.max(0, Number(p.video.focus ?? 0.5)));
      args.push('-ss', start.toFixed(2), '-t', T, '-i', p.video.url || p.video.path);
      graph = `[0:v]crop=w='min(iw,ih*9/16)':h=ih:x='(iw-min(iw,ih*9/16))*${focus}':y=0,scale=${W}:${H}:flags=lanczos,setsar=1,fps=${FPS}[b];`;
    } else {
      const buf = await loadImage(p);
      const base = path.join(dir, `base${i}.jpg`);
      const iw = await preparePhoto(buf, base);
      const travel = Math.min(iw - W, 640);
      const x0 = Math.round((iw - W - travel) / 2);
      const prog = i % 2 === 0 ? `(1-cos(PI*t/${T}))/2` : `1-(1-cos(PI*t/${T}))/2`;
      args.push('-loop', '1', '-framerate', String(FPS), '-t', T, '-i', base);
      graph = `[0:v]crop=${W}:${H}:x='${x0}+${travel}*(${prog})':y=0[b];`;
    }
    if (overlay) {
      args.push('-loop', '1', '-framerate', String(FPS), '-t', T, '-i', overlay);
      // Text is hidden while clips crossfade (first XF seconds of a clip and its last XF seconds),
      // so the text of two clips is never on screen at the same time.
      const tIn = i === 0 ? 0.15 : XF + 0.05;
      const tOut = Math.max(tIn + 0.5, dur - 0.2);
      graph += `[1:v]format=rgba,fade=t=in:st=${tIn.toFixed(2)}:d=0.25:alpha=1,fade=t=out:st=${tOut.toFixed(2)}:d=0.2:alpha=1[t];[b][t]overlay=0:0:format=auto,`;
    } else {
      graph += '[b]';
    }
    graph += `format=yuv420p,fps=${FPS}[v]`;
    args.push('-filter_complex', graph, '-map', '[v]', '-an', '-t', T, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out);
    await run('ffmpeg', args);
    clips.push({ file: out, dur });
  }

  // end card (last clip, no crossfade out)
  const ec = job.endCard || {};
  const cardPng = path.join(dir, 'card.png');
  await fs.writeFile(cardPng, await endCard({ width: W, height: H, title: ec.title || 'Book direct. Best rate guaranteed.', subtitle: ec.subtitle, cta: ec.cta || 'Link in bio' }));
  const cardOut = path.join(dir, 'card.mp4');
  await run('ffmpeg', ['-y', '-loop', '1', '-framerate', String(FPS), '-t', endSec.toFixed(3), '-i', cardPng, '-vf', `format=yuv420p,fps=${FPS}`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', cardOut]);
  clips.push({ file: cardOut, dur: endSec });

  // crossfade chain
  const args = ['-y'];
  for (const c of clips) args.push('-i', c.file);
  const music = await pickMusic(job.music);
  const total = clips.reduce((s, c) => s + c.dur, 0);
  if (music) args.push('-stream_loop', '-1', '-i', music);
  let graph = '';
  let prev = '0:v';
  let offset = 0;
  for (let k = 1; k < clips.length; k++) {
    offset += clips[k - 1].dur;
    const label = `v${k}`;
    graph += `[${prev}][${k}:v]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[${label}];`;
    prev = label;
  }
  graph = graph.replace(/;$/, '');
  const out = path.join(dir, 'reel.mp4');
  args.push('-filter_complex', graph, '-map', `[${prev}]`);
  if (music) {
    args.push('-map', `${clips.length}:a`, '-af', `afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5`, '-c:a', 'aac', '-b:a', '160k');
  } else {
    args.push('-an');
  }
  args.push('-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  await run('ffmpeg', args);
  return { file: out, durationSeconds: Number(total.toFixed(1)), music: music ? path.basename(music, '.mp3') : null };
}
