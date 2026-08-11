/**
 * Shared helpers for the packing slip and the dashboard.
 */

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function money(value, currency) {
  if (typeof value !== 'number' || !isFinite(value)) return '';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format(value);
  } catch {
    return '$' + value.toFixed(2);
  }
}

/** Whole dollars, thousands abbreviated. For KPI tiles and chart axes. */
export function moneyShort(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 10000) return '$' + Math.round(n / 1000) + 'k';
  return '$' + Math.round(n).toLocaleString('en-US');
}

export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Aug 4" — the table is dense and the year is almost always the current one. */
export function tinyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const now = new Date();
  return d.toLocaleDateString('en-US',
    d.getUTCFullYear() === now.getUTCFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: '2-digit' });
}

/** Whole days since `iso`. Drives the "sitting too long" flag on open orders. */
export function daysSince(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

/** Whole calendar days from today until `date`. Negative once it's past. */
export function daysUntil(date) {
  const d = new Date(date);
  if (isNaN(d)) return null;
  const day = (t) => Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.round((day(d) - day(new Date())) / 86400000);
}

/**
 * Published lead times, in calendar days from the order date. These mirror the
 * promise on shipping.html — change them there and here together.
 *
 * The 1–3 week bucket counts down to 3 weeks: the outer bound is the date the
 * customer was actually promised, so it's the one worth watching. Leather
 * Butter ships from stock in 1–3 business days, five calendar days at worst.
 */
const LEAD_TIMES = [
  { match: /radio.?strap/i, days: 42, promise: '6 weeks' },
  { match: /leather.?butter/i, days: 5, promise: '1–3 business days' },
];

/** Belts, helmet bands, glove straps, chin straps, hats, one-off builds. */
const DEFAULT_LEAD = { days: 21, promise: '1–3 weeks' };

/**
 * Matched on id and name together — the id is exact for catalog items, the
 * name is all a custom build off a quote has. `radio` has to stay in the
 * pattern so glove straps and chin straps don't land in the 6-week bucket.
 */
export function leadTime(item) {
  const key = `${item?.id || ''} ${item?.name || ''}`;
  return LEAD_TIMES.find((l) => l.match.test(key)) || DEFAULT_LEAD;
}

/** The date a line item has to be out the door: order date + its lead time. */
export function shipBy(item, orderDate) {
  const placed = new Date(orderDate);
  if (isNaN(placed)) return null;
  const lead = leadTime(item);
  return { due: new Date(placed.getTime() + lead.days * 86400000), promise: lead.promise };
}

/** "2026-08" — the month bucket key for the revenue chart. */
export function monthKey(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

export function monthLabel(key) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return '';
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

export function page(title, body, { styles = '', script = '', status = 200 } = {}) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Rawhide City Leather</title>
<style>${styles}</style>
</head>
<body>${body}${script ? `<script>${script}</script>` : ''}</body>
</html>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function notice(title, body) {
  return `<div class="wrap"><div class="notice"><h1>${esc(title)}</h1><p>${body}</p></div></div>`;
}
