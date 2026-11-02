import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function run(cmd, args, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}: ${err}`));
    });
  });
}

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const MAX_BYTES = 30 * 1024 * 1024;

export async function loadImage(source) {
  if (source && typeof source.base64 === 'string') {
    const buf = Buffer.from(source.base64, 'base64');
    if (!buf.length || buf.length > MAX_BYTES) throw new HttpError(400, 'Invalid base64 image size');
    return buf;
  }
  const url = source && source.url;
  if (typeof url !== 'string') throw new HttpError(400, 'Each photo needs a url or base64 field');
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, `Invalid photo URL: ${url}`);
  }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Photo URLs must use https');
  const allowed = (process.env.ALLOWED_PHOTO_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) {
    throw new HttpError(400, `Host not allowed: ${u.hostname}`);
  }
  const addrs = await lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, 'Host resolves to a private address');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new HttpError(400, `Could not download photo (${res.status}): ${u.hostname}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new HttpError(400, 'Photo too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new HttpError(400, 'Photo too large');
  return buf;
}

export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** Video sources are restricted to SharePoint download links (or hosts in VIDEO_HOSTS). */
export function assertVideoUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'Invalid video URL');
  }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Video URLs must use https');
  const allowed = (process.env.VIDEO_HOSTS || 'sharepoint.com').split(',').map((h) => h.trim()).filter(Boolean);
  if (!allowed.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) {
    throw new HttpError(400, `Video host not allowed: ${u.hostname}`);
  }
}
