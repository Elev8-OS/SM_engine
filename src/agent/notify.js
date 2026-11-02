// E-mail notification for inquiries that need a person. Sent through a Make webhook (Outlook), configured by
// NOTIFY_WEBHOOK_URL and NOTIFY_EMAIL_TO (comma separated). ORBIT_URL adds a link to the review page.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nl = (s) => esc(s).replace(/\n/g, '<br>');

export const notifyConfigured = () => Boolean(process.env.NOTIFY_WEBHOOK_URL && process.env.NOTIFY_EMAIL_TO);
const recipients = () => String(process.env.NOTIFY_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Instagram only allows a reply within 24 hours of the guest's last message. */
function deadline(createdAt) {
  const t = new Date(new Date(createdAt).getTime() + 24 * 3600 * 1000);
  return new Intl.DateTimeFormat('de-CH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' }).format(t);
}

export function buildMail(row) {
  const failed = row.status === 'failed';
  const name = row.contact_name || 'Unbekannt';
  const link = process.env.ORBIT_URL ? `${process.env.ORBIT_URL.replace(/\/+$/, '')}/sm-manager?ansicht=anfragen` : null;
  const subject = failed ? `Instagram-Anfrage von ${name}: Lea konnte nicht antworten` : `Instagram-Anfrage von ${name} bitte prüfen`;
  const box = 'margin:0 0 14px;padding:10px 12px;background:#f3f4f6;border-radius:6px;';
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:640px;font-size:15px;line-height:1.5;">',
    `<h2 style="margin:0 0 6px;font-size:18px;">${failed ? 'Lea konnte nicht antworten' : 'Diese Anfrage braucht dich'}</h2>`,
    `<p style="margin:0 0 14px;color:#555;">${esc(name)} hat auf Instagram geschrieben. Antwort möglich bis etwa <strong>${esc(deadline(row.created_at))}</strong> (Instagram erlaubt 24 Stunden).</p>`,
    '<p style="margin:0 0 4px;color:#555;font-size:13px;">Nachricht des Gasts</p>',
    `<div style="${box}">${nl(row.guest_message || '(kein Text)')}</div>`,
    failed
      ? `<p style="margin:0 0 4px;color:#555;font-size:13px;">Fehler</p><div style="${box}">${nl(row.error || 'unbekannt')}</div>`
      : `<p style="margin:0 0 4px;color:#555;font-size:13px;">Grund</p><div style="${box}">${nl(row.reason || 'Von Lea zur Prüfung markiert.')}</div><p style="margin:0 0 4px;color:#555;font-size:13px;">Antwortvorschlag von Lea</p><div style="${box}">${nl(row.draft || '')}</div>`,
    link ? `<p style="margin:16px 0 0;"><a href="${esc(link)}" style="background:#f5c400;color:#000;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold;">In Orbit öffnen</a></p>` : '',
    '</div>'
  ].join('');
  return { subject, html };
}

/** One webhook call per recipient. Never throws. */
export async function sendMail({ subject, html }) {
  if (!notifyConfigured()) return { ok: false, reason: 'NOTIFY_WEBHOOK_URL or NOTIFY_EMAIL_TO not set' };
  const results = [];
  for (const to of recipients()) {
    try {
      const res = await fetch(process.env.NOTIFY_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, subject, html }), signal: AbortSignal.timeout(20000) });
      results.push({ to, ok: res.ok, status: res.status });
    } catch (e) {
      results.push({ to, ok: false, error: String(e.message || e).slice(0, 200) });
    }
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}
