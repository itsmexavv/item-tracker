// Pure text helpers shared by the views: relative times, distances, and
// HTML templating that escapes user text. No DOM access, so tests can import it.

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a short date. */
export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.max(1, Math.floor(s / 3600));
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Clock time, e.g. "14:32". */
export function clock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Clock time for today, otherwise date and time, e.g. "Oct 20, 14:32". */
export function stamp(ts, now = Date.now()) {
  if (new Date(ts).toDateString() === new Date(now).toDateString()) return clock(ts);
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "8 m", "120 m", "1.4 km", "12 km". */
export function formatDistance(m) {
  if (m == null || !Number.isFinite(m)) return '–';
  if (m < 999.5) return `${Math.round(m)} m`;
  if (m < 9950) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const SAFE = Symbol('safe-html');

/** Marks a string as trusted HTML so `html` inserts it unescaped. */
export const raw = (s) => ({ [SAFE]: String(s) });

/**
 * Template tag for markup: interpolated values are HTML-escaped unless they came
 * from `html` or `raw`. Arrays are joined; null, undefined and false render nothing.
 */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += piece(v) + strings[i + 1];
  });
  return raw(out);
}

function piece(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(piece).join('');
  if (typeof v === 'object' && SAFE in v) return v[SAFE];
  return escapeHtml(v);
}

/** The markup string inside an `html` / `raw` value. */
export const str = (h) => h[SAFE];
