import { dbEnabled, q } from './db.js';
import { bookingUrl } from './ghl.js';

const BOT = /bot|crawler|spider|facebookexternalhit|preview|slurp|headless|monitor/i;
const FALLBACK = 'https://www.elevate-villas.com';
const clean = (s, d) => (/^[a-z0-9_]{1,30}$/i.test(String(s || '')) ? String(s) : d);

/**
 * Public tracked link: /go/bio (link in bio), /go/<postId> (one post, for stories, DMs or ads) or /go/latest.
 * /go/bio sends visitors to the main page, because one bio link cannot tell which post brought them.
 * The others redirect to the villa page of that post (latest = most recent scheduled or published post).
 * It records the click and must never fail the visitor.
 */
export async function goHandler(req, res) {
  const source = clean(req.query.s, 'instagram');
  let post = null;
  let target;
  try {
    if (dbEnabled()) {
      const id = req.params.id;
      if (/^\d+$/.test(id)) {
        post = (await q('select * from posts where id = $1', [Number(id)]))[0] || null;
      } else if (id !== 'bio') {
        post = (await q("select * from posts where status in ('scheduled','published') and scheduled_for <= now() order by scheduled_for desc limit 1"))[0] || null;
      }
    }
  } catch (e) {
    console.error('go lookup failed', e.message);
  }
  target = post ? bookingUrl(post, source) : `${FALLBACK}/?utm_source=${source}&utm_medium=social&utm_campaign=bio`;
  res.redirect(302, target);
  if (dbEnabled()) {
    const ua = String(req.get('user-agent') || '').slice(0, 300);
    q('insert into clicks (post_id, source, is_bot, user_agent) values ($1,$2,$3,$4)', [post?.id ?? null, source, BOT.test(ua) || !ua, ua]).catch((e) => console.error('click log failed', e.message));
  }
}

/** Click numbers per post and per day for the last N days (bots excluded). */
export async function clickStats(days = 30) {
  const d = Math.min(Math.max(Number(days) || 30, 1), 365);
  const perPost = await q(
    `select p.id, p.plan_date, p.format, p.pillar, p.property_key, p.status, count(c.id)::int as clicks
       from posts p left join clicks c on c.post_id = p.id and not c.is_bot and c.created_at > now() - make_interval(days => $1)
      group by p.id order by clicks desc, p.id desc limit 50`,
    [d]
  );
  const perDay = await q(
    `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as clicks
       from clicks where not is_bot and created_at > now() - make_interval(days => $1) group by 1 order by 1`,
    [d]
  );
  const total = (await q(`select count(*)::int as n, count(*) filter (where post_id is null)::int as bio_generic from clicks where not is_bot and created_at > now() - make_interval(days => $1)`, [d]))[0];
  return { days: d, total: total.n, withoutPost: total.bio_generic, perPost, perDay };
}
