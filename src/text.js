import sharp from 'sharp';

export const BRAND = { yellow: '#F6BB12', black: '#0B0B0B', white: '#FFFFFF' };
const FONT = "Inter, 'DejaVu Sans', sans-serif";

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function wrap(text, fontSize, maxWidth) {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.56)));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function textBlock({ lines, fontSize, x, y, weight = 600, fill = BRAND.white, anchor = 'middle', lineHeight = 1.18 }) {
  return lines
    .map((l, i) => `<text x="${x}" y="${Math.round(y + i * fontSize * lineHeight)}" font-family="${FONT}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(l)}</text>`)
    .join('');
}

/**
 * Transparent text overlay for a reel clip. Text sits inside the Instagram safe zone
 * (see the comment below for the areas kept free).
 */
export async function reelOverlay({ width, height, headline, sub, big = false }) {
  // Instagram draws profile, caption and buttons over a reel: keep text out of the top 14 %,
  // the bottom 36 % and a right-hand strip for the like/comment/share icons.
  const fs = big ? 76 : 60;
  const subFs = 36;
  const textW = width - 300; // text column 780 px wide, shifted left of centre to clear the icon strip
  const cx = (width - 140) / 2;
  const lines = wrap(headline, fs, textW);
  const subLines = sub ? wrap(sub, subFs, textW - 20) : [];
  const blockH = lines.length * fs * 1.18 + (subLines.length ? subLines.length * subFs * 1.3 + 24 : 0);
  const padY = 44;
  const bottomLimit = height - 700;
  const bandBottom = bottomLimit;
  const bandTop = bandBottom - blockH - padY * 2;
  let y = bandTop + padY + fs * 0.9;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  svg += `<rect x="0" y="${Math.round(bandTop)}" width="${width}" height="${Math.round(bandBottom - bandTop)}" fill="rgba(0,0,0,0.5)"/>`;
  svg += textBlock({ lines, fontSize: fs, x: cx, y });
  if (subLines.length) {
    y += (lines.length - 1) * fs * 1.18 + fs * 0.35 + subFs * 1.2;
    svg += textBlock({ lines: subLines, fontSize: subFs, x: cx, y, weight: 400, lineHeight: 1.3 });
  }
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function endCard({ width, height, title, subtitle, cta, hint }) {
  const tFs = 76;
  const tLines = wrap(title || 'Book direct.', tFs, width - 160);
  const sLines = subtitle ? wrap(subtitle, 40, width - 200) : [];
  let y = height / 2 - 170;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  svg += `<rect width="${width}" height="${height}" fill="${BRAND.black}"/>`;
  svg += textBlock({ lines: tLines, fontSize: tFs, x: width / 2, y });
  y += (tLines.length - 1) * tFs * 1.18 + 70;
  if (sLines.length) {
    svg += textBlock({ lines: sLines, fontSize: 40, x: width / 2, y, weight: 400, lineHeight: 1.3 });
    y += sLines.length * 52 + 30;
  }
  // Plain text, not a button: nothing on an Instagram post is tappable, so it must not look tappable.
  if (cta) {
    svg += `<text x="${width / 2}" y="${Math.round(y + 40)}" font-family="${FONT}" font-size="56" font-weight="700" fill="${BRAND.yellow}" text-anchor="middle">${esc(cta)}</text>`;
    if (hint) svg += `<text x="${width / 2}" y="${Math.round(y + 104)}" font-family="${FONT}" font-size="36" font-weight="400" fill="#BDBDBD" text-anchor="middle">${esc(hint)}</text>`;
  }
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Flat text band for a 4:5 carousel slide, drawn at the bottom. */
export async function slideOverlay({ width, height, headline, sub, cta, darken, bottomInset = 0 }) {
  const fs = 64;
  const subFs = 34;
  const lines = wrap(headline, fs, width - 120);
  const subLines = sub ? wrap(sub, subFs, width - 120) : [];
  const blockH = lines.length * fs * 1.18 + (subLines.length ? subLines.length * subFs * 1.3 + 16 : 0) + (cta ? 120 : 0);
  const padB = 64;
  const bandH = Math.round(blockH + padB + 56);
  const bandTop = height - bandH - bottomInset;
  let y = bandTop + 56 + fs * 0.9;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  if (darken) svg += `<rect width="${width}" height="${height}" fill="rgba(0,0,0,0.45)"/>`;
  svg += `<rect x="0" y="${bandTop}" width="${width}" height="${bandH}" fill="rgba(0,0,0,${darken ? 0 : 0.5})"/>`;
  svg += textBlock({ lines, fontSize: fs, x: 60, y, anchor: 'start' });
  y += (lines.length - 1) * fs * 1.18 + fs * 0.3;
  if (subLines.length) {
    y += subFs * 1.2;
    svg += textBlock({ lines: subLines, fontSize: subFs, x: 60, y, weight: 400, anchor: 'start', lineHeight: 1.3 });
    y += (subLines.length - 1) * subFs * 1.3;
  }
  if (cta) {
    svg += `<text x="60" y="${Math.round(y + 80)}" font-family="${FONT}" font-size="46" font-weight="700" fill="${BRAND.yellow}" text-anchor="start">${esc(cta)}</text>`;
  }
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}
