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
