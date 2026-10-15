#!/usr/bin/env node
/**
 * Weekly live check of rawhidecityleather.com.
 *
 *   node scripts/site-check.mjs            prints a report, exits 1 on problems
 *   node scripts/site-check.mjs --quiet    prints nothing when everything is fine
 *
 * The test suite (worker/tests/site-content.test.mjs) reads the files in the
 * repo and gates the deploy. This reads the LIVE site and catches what only the
 * live site can show: a photo that stopped loading, a dead link, a sitemap
 * entry that errors, the dashboard override drifting a dropdown away from its
 * Snipcart button, the sale banner missing from a page, an edge serving an old
 * copy, a protected route that stopped asking for a login.
 *
 * No dependencies. Node 18+ for fetch.
 */

const ORIGIN = 'https://rawhidecityleather.com';
const QUIET = process.argv.includes('--quiet');
const problems = [];
const notes = [];
const bust = () => `sc=${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const withBust = (u) => u + (u.includes('?') ? '&' : '?') + bust();

async function get(path, { redirect = 'follow', bustCache = true, retry = false } = {}) {
  const url = path.startsWith('http') ? path : ORIGIN + path;
  try {
    // A request that never answers must not hang the whole check.
    const res = await fetch(bustCache ? withBust(url) : url, { redirect, signal: AbortSignal.timeout(20000), headers: { 'cache-control': 'no-cache', 'user-agent': 'rawhide-site-check/1' } });
    const isText = /text|json|xml|javascript/.test(res.headers.get('content-type') || '');
    // Always finish with the body. An unread body keeps the connection open,
    // and a hundred of those keep the process from exiting.
    const text = isText ? await res.text() : '';
    if (!isText) await res.body?.cancel().catch(() => {});
    return { status: res.status, text, location: res.headers.get('location') || '', url: res.url };
  } catch (err) {
    // One connection-level hiccup under parallel load is not a broken file.
    if (!retry) return get(path, { redirect, bustCache, retry: true });
    return { status: 0, text: '', location: '', url, error: err.message };
  }
}

async function pool(items, worker, size = 8) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx]); }
  }));
  return out;
}

const attrsOf = (tag) => {
  const out = {};
  for (const m of tag.replace(/^<[a-zA-Z0-9]+\s*/, '').matchAll(/([a-zA-Z0-9:_-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? '';
  return out;
};

// ---- 1. the sitemap, and every page in it -----------------------------------
const sitemap = await get('/sitemap.xml');
if (sitemap.status !== 200) problems.push(`sitemap.xml returned ${sitemap.status}`);
const pages = [...sitemap.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1].replace(ORIGIN, '') || '/');
pages.push('/track');
notes.push(`${pages.length} pages from the sitemap (+ /track)`);

const promo = await get('/api/promo');
let promoLive = false; let promoText = '';
try { const j = JSON.parse(promo.text); promoLive = !!j.live; promoText = j.text || j.headline || ''; } catch { problems.push('/api/promo did not return JSON'); }

const assets = new Map(); // url -> first page that referenced it
const pageResults = await pool(pages, async (path) => {
  const res = await get(path);
  if (res.status !== 200) { problems.push(`${path} returned ${res.status}${res.error ? ' (' + res.error + ')' : ''}`); return; }
  const html = res.text;
  // Links are read from the markup only. A URL built inside a <script> (the
  // track page assembles carrier links in JS) is not a link on the page.
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '');

  // Links and files this page depends on.
  for (const m of markup.matchAll(/<a\b[^>]*href="([^"#][^"]*)"/g)) {
    const h = m[1];
    if (/^(mailto:|tel:|javascript:|https?:\/\/(?!rawhidecityleather\.com))/.test(h)) continue;
    const u = h.startsWith('http') ? h.replace(ORIGIN, '') : h.startsWith('/') ? h : '/' + h;
    if (!assets.has(u.split('#')[0])) assets.set(u.split('#')[0], path);
  }
  for (const m of markup.matchAll(/<(?:img|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    const h = m[1];
    if (/^(https?:)?\/\//.test(h) && !h.includes('rawhidecityleather.com')) continue;
    if (/^data:/.test(h)) continue;
    const u = h.startsWith('http') ? h.replace(ORIGIN, '') : h.startsWith('/') ? h : '/' + h;
    if (!assets.has(u)) assets.set(u, path);
  }
  for (const m of markup.matchAll(/srcset="([^"]+)"/g)) {
    for (const part of m[1].split(',')) {
      const h = part.trim().split(/\s+/)[0];
      if (!h) continue;
      const u = h.startsWith('/') ? h : '/' + h;
      if (!assets.has(u)) assets.set(u, path);
    }
  }

  // Search data must parse.
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch { problems.push(`${path}: search data (JSON-LD) does not parse`); }
  }

  // Words we do not use.
  for (const [re, why] of [
    [/hand[- ]?stitch/i, 'says hand-stitched'],
    [/leather balm/i, 'says leather balm'],
    [/only colou?r currently offered/i, 'says only color currently offered'],
    [/compare both/i, 'says compare both'],
  ]) if (re.test(html)) problems.push(`${path}: ${why}`);

  // The sale banner: on every page while a sale is live, on none otherwise.
  const hasBanner = /class="announcement sale"/.test(html);
  if (promoLive && !hasBanner) problems.push(`${path}: sale is live but the page has no sale banner`);
  if (!promoLive && hasBanner) problems.push(`${path}: no sale is live but the page shows a sale banner`);

  // Product pages: the dropdown the customer sees must match the hidden
  // Snipcart button Snipcart validates against — on the LIVE page, where the
  // dashboard override is applied.
  if (path.startsWith('/product-')) {
    const btnTag = (html.match(/<button\b[^>]*snipcart-add-item[^>]*>/) || [])[0];
    if (!btnTag) { problems.push(`${path}: no hidden Snipcart button`); return; }
    const btn = attrsOf(btnTag);
    const byName = {};
    for (const [k, v] of Object.entries(btn)) { const mm = k.match(/^data-item-custom(\d+)-name$/); if (mm) byName[v] = mm[1]; }
    for (const m of html.matchAll(/<select\b([^>]*)>/g)) {
      const sel = attrsOf('<select ' + m[1] + '>');
      if (!('data-options' in sel)) continue;
      const label = sel['data-label'] || sel.name;
      const n = byName[label];
      if (!n) { problems.push(`${path}: "${label}" is priced but not declared on the Snipcart button`); continue; }
      const onButton = btn[`data-item-custom${n}-options`];
      if (onButton !== sel['data-options']) problems.push(`${path}: "${label}" dropdown prices differ from the Snipcart button`);
    }
    for (const m of html.matchAll(/<input\b[^>]*type="file"[^>]*>/g)) {
      if (/\brequired\b/.test(m[0])) problems.push(`${path}: an artwork upload is marked required`);
    }
  }
});

// ---- 2. every linked page and file ------------------------------------------
const assetList = [...assets.keys()].filter((u) => !pages.includes(u.replace(/\.html$/, '')) && !pages.includes(u));
const assetResults = await pool(assetList, async (u) => ({ u, res: await get(u) }), 10);
for (const { u, res } of assetResults) {
  if (res.status !== 200) problems.push(`${u} returned ${res.status} (linked from ${assets.get(u)})`);
}
notes.push(`${assetList.length} linked files and pages checked`);

// ---- 3. main.js must not reintroduce the required picker ---------------------
const mainJs = await get('/assets/js/main.js');
if (mainJs.status !== 200) problems.push(`/assets/js/main.js returned ${mainJs.status}`);
else if (mainJs.text.includes('picker.required')) problems.push('main.js makes an artwork picker required again');

// ---- 4. a missing page is a real 404, with noindex --------------------------
const missing = await get('/site-check-no-such-page-' + Math.floor(Math.random() * 1e9), { bustCache: false });
if (missing.status !== 404) problems.push(`a missing page returned ${missing.status}, not 404`);
if (!/noindex/.test(missing.text)) problems.push('the 404 page has no noindex tag');
if (promoLive && !/class="announcement sale"/.test(missing.text)) problems.push('the 404 page has no sale banner while a sale is live');

// ---- 5. protected routes still ask for a login ------------------------------
for (const path of ['/dashboard', '/packing-slip', '/logo/00000000000000000000000000000000.png']) {
  const res = await get(path, { redirect: 'manual', bustCache: false });
  const ok = (res.status === 302 || res.status === 301) && /cloudflareaccess\.com/.test(res.location);
  if (!ok) problems.push(`${path} is not behind the Cloudflare login (status ${res.status})`);
}
const quote = await get('/quote/site-check-not-a-quote', { bustCache: false });
if (quote.status !== 404 && quote.status !== 410) problems.push(`/quote/<unknown> returned ${quote.status}`);

// ---- 6. the files search engines and assistants read ------------------------
for (const path of ['/robots.txt', '/llms.txt', '/google-merchant-feed.xml']) {
  const res = await get(path);
  if (res.status !== 200) problems.push(`${path} returned ${res.status}`);
  else if (path.endsWith('.xml') && !/<item>/.test(res.text)) problems.push('the Merchant feed has no items');
}

// ---- report ---------------------------------------------------------------
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
if (problems.length) {
  console.log(`Rawhide site check — ${stamp} — ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  for (const p of problems) console.log('  - ' + p);
  console.log('\n' + notes.join('; ') + (promoLive ? `; sale banner live: "${promoText}"` : '; no sale live'));
  process.exit(1);
} else if (!QUIET) {
  console.log(`Rawhide site check — ${stamp} — no problems`);
  console.log(notes.join('; ') + (promoLive ? `; sale banner live: "${promoText}"` : '; no sale live'));
}
process.exit(0);
