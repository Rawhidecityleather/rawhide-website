/**
 * Site content checks: the static pages against each other and against the
 * facts in CLAUDE.md.
 *
 * Built Oct 15 2026, the day a customer was blocked at checkout by an artwork
 * upload that was supposed to be optional, and a pass over every page turned up
 * twenty more stale or contradictory lines — a colour missing from one stitch
 * list, a bucket price list updated in the dropdown but not in the hidden
 * Snipcart button, a search snippet promising a patch colour the form does not
 * offer. None of them were failures the suite could see.
 *
 * These read the HTML files in the repo root, not the live site. The deploy is
 * gated on this suite, so a page that breaks one of these rules cannot go out.
 * The weekly live check (scripts/site-check.mjs) covers what only the live site
 * can show: a dead link, a photo that stopped loading, an edge serving stale.
 */

import { suite, check } from './harness.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

const PUBLIC = readdirSync(ROOT).filter((f) => f.endsWith('.html') && f !== '404.html' && !/^google[0-9a-f]+\.html$/.test(f));
const PAGES = Object.fromEntries(PUBLIC.map((f) => [f, read(f)]));
const PRODUCTS = PUBLIC.filter((f) => f.startsWith('product-'));

// ---- tiny parsers. The markup is ours and regular; a DOM library would be a
// dependency for the sake of six regexes.

const decode = (s) => String(s ?? '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&ndash;/g, '–')
  .replace(/&mdash;/g, '—').replace(/&rsquo;/g, '’').replace(/&ldquo;|&rdquo;/g, '"');

function attrsOf(tag) {
  const out = {};
  const body = tag.replace(/^<[a-zA-Z0-9]+\s*/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(/([a-zA-Z0-9:_-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] === undefined ? '' : decode(m[2]);
  return out;
}

function selects(html) {
  return [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].map((m) => {
    const a = attrsOf('<select ' + m[1] + '>');
    const options = [...m[2].matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((o) => {
      const oa = attrsOf('<option ' + o[1] + '>');
      const text = decode(o[2]).trim();
      return { value: 'value' in oa ? oa.value : text, text, disabled: 'disabled' in oa };
    });
    return { ...a, options };
  });
}

const firstTag = (html, re) => { const m = html.match(re); return m ? attrsOf(m[0]) : null; };
const hiddenButton = (html) => firstTag(html, /<button\b[^>]*snipcart-add-item[^>]*>/);
const orderForm = (html) => firstTag(html, /<form\b[^>]*data-order-form[^>]*>/);
const cardForms = (html) => [...html.matchAll(/<form\b[^>]*data-card-buy[^>]*>/g)].map((m) => attrsOf(m[0]));
const fileInputs = (html) => [...html.matchAll(/<input\b[^>]*type="file"[^>]*>/g)].map((m) => m[0]);
const labels = (html) => [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)]
  .map((m) => ({ ...attrsOf('<label ' + m[1] + '>'), inner: m[2] }));
const controlById = (html, id) => {
  const m = html.match(new RegExp('<(input|select|textarea)\\b[^>]*\\bid="' + id + '"[^>]*>'));
  return m ? m[0] : null;
};
const jsonLd = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const metaDesc = (html) => (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];
const productOf = (f) => f.replace(/^product-/, '').replace(/\.html$/, '');

export default async function run() {
  // -------------------------------------------------------------------------
  suite('site content — artwork uploads are never required');

  for (const f of PUBLIC) {
    for (const tag of fileInputs(PAGES[f])) {
      check(`${f}: ${attrsOf(tag).id || 'file input'} is optional`, !/\brequired\b/.test(tag));
    }
  }
  check('main.js never flips a picker to required', !read('assets/js/main.js').includes('picker.required'));

  // -------------------------------------------------------------------------
  // Snipcart validates an order against the hidden button on the product page,
  // not against the dropdown the customer saw. A colour added to one and not
  // the other goes through the cart and fails at checkout.
  suite('site content — every priced option is on the Snipcart button too');

  for (const f of PRODUCTS) {
    const html = PAGES[f];
    const btn = hiddenButton(html);
    const form = orderForm(html);
    check(`${f}: has a hidden Snipcart button`, !!btn);
    check(`${f}: has an order form`, !!form);
    if (!btn || !form) continue;
    check(`${f}: button id matches the form`, btn['data-item-id'] === form['data-snipcart-id'],
      `${btn['data-item-id']} vs ${form['data-snipcart-id']}`);

    const byName = {};
    for (const [k, v] of Object.entries(btn)) {
      const m = k.match(/^data-item-custom(\d+)-name$/);
      if (m) byName[v] = m[1];
    }

    for (const sel of selects(html)) {
      if (!('data-options' in sel)) continue;
      const label = sel['data-label'] || sel.name;
      const n = byName[label];
      check(`${f}: "${label}" is declared on the button`, !!n);
      if (!n) continue;
      const onButton = btn[`data-item-custom${n}-options`];
      check(`${f}: "${label}" options match the button`, onButton === sel['data-options'],
        onButton === sel['data-options'] ? '' : `select: ${sel['data-options']}\n        button: ${onButton}`);

      const declared = new Set(sel['data-options'].split('|').map((e) => e.replace(/\[[^\]]*\]$/, '')));
      const missing = sel.options.filter((o) => o.value && !o.disabled && !declared.has(o.value)).map((o) => o.value);
      check(`${f}: every "${label}" choice is priced in data-options`, missing.length === 0, missing.join(', '));
    }
  }

  // -------------------------------------------------------------------------
  // Rob stocks one set of thread. Every stitch list on the site offers it, so
  // a glove strap can match a strap and a chin strap can match a band.
  suite('site content — colour lists agree across products');

  const STITCH = ['White', 'Black', 'Red', 'Blue', 'Navy Blue', 'Orange', 'Pink', 'Purple', 'Yellow'];
  const SENTINEL = new Set(['', 'None', 'No preference', 'Match my strap', 'No stitching']);
  for (const f of PUBLIC) {
    for (const sel of selects(PAGES[f])) {
      if (sel.name !== 'stitch') continue;
      const have = sel.options.map((o) => o.value).filter((v) => !SENTINEL.has(v));
      const missing = STITCH.filter((c) => !have.includes(c));
      const extra = have.filter((c) => !STITCH.includes(c));
      check(`${f}: stitch list is the full set`, missing.length === 0 && extra.length === 0,
        [missing.length ? 'missing ' + missing.join(', ') : '', extra.length ? 'extra ' + extra.join(', ') : ''].filter(Boolean).join('; '));
    }
  }

  // Cut from paint and outline on Sep 6 2026 (never picked; Grey duplicates
  // Silver). Purple stays as a stitch colour, which is why this is by name.
  const PAINT_BANNED = ['Purple', 'Grey', 'Gray'];
  for (const f of PUBLIC) {
    for (const sel of selects(PAGES[f])) {
      if (!['lettercolor', 'letteroutline', 'textcolor'].includes(sel.name)) continue;
      const bad = sel.options.map((o) => o.value).filter((v) => PAINT_BANNED.includes(v));
      check(`${f}: ${sel.name} has no Purple or Grey`, bad.length === 0, bad.join(', '));
    }
  }

  // -------------------------------------------------------------------------
  suite('site content — one price per product, everywhere it appears');

  const pricesById = {};
  for (const f of PRODUCTS) {
    const html = PAGES[f];
    const form = orderForm(html);
    const btn = hiddenButton(html);
    if (!form || !btn) continue;
    const formPrice = form['data-snipcart-price'];
    pricesById[form['data-snipcart-id']] = formPrice;
    check(`${f}: form and button agree`, formPrice === btn['data-item-price'], `${formPrice} vs ${btn['data-item-price']}`);

    let ldPrice = null;
    for (const raw of jsonLd(html)) {
      try { const j = JSON.parse(raw); if (j['@type'] === 'Product') ldPrice = j.offers?.price ?? j.offers?.lowPrice ?? null; } catch { /* reported below */ }
    }
    check(`${f}: search data agrees`, ldPrice !== null && Number(ldPrice) === Number(formPrice), `${ldPrice} vs ${formPrice}`);

    const shown = (html.match(/class="product-price">([^<]*)</) || [])[1] || '';
    check(`${f}: the price on the page agrees`, shown.includes('$' + formPrice), `${shown} vs ${formPrice}`);
  }

  for (const f of PUBLIC) {
    for (const card of cardForms(PAGES[f])) {
      const id = card['data-snipcart-id'];
      check(`${f}: card for ${id} charges the product-page price`, pricesById[id] === card['data-snipcart-price'],
        `${card['data-snipcart-price']} vs ${pricesById[id]}`);
    }
  }

  // -------------------------------------------------------------------------
  suite('site content — lead times match the shop rule');

  const LEAD = (id) => (/radio-strap$/.test(id) ? /6 weeks?/i : id === 'leather-butter' ? /1[–-]3 business days/i : /1[–-]3 weeks?/i);
  for (const f of PRODUCTS) {
    const id = productOf(f);
    check(`${f}: states its lead time`, LEAD(id).test(decode(PAGES[f])));
  }

  // -------------------------------------------------------------------------
  // Each of these was live on the site at some point in 2026 and wrong.
  suite('site content — words we do not use');

  const BANNED = [
    [/hand[- ]?stitch/i, 'hand-stitched (the stitching is machine)'],
    [/leather balm/i, 'leather balm (it is Leather Butter)'],
    [/only colou?r currently offered/i, 'only color currently offered (the bucket comes in two)'],
    [/compare both/i, 'compare both (there are three straps)'],
    [/both (of our|firefighter radio) straps/i, 'both straps (there are three)'],
  ];
  const extraFiles = ['llms.txt', 'google-merchant-feed.xml', ...readdirSync(resolve(ROOT, 'email')).filter((e) => e.endsWith('.html')).map((e) => 'email/' + e)];
  const corpus = { ...PAGES, ...Object.fromEntries(extraFiles.map((e) => [e, read(e)])) };
  for (const [re, why] of BANNED) {
    const hits = Object.entries(corpus).filter(([, html]) => re.test(html)).map(([f]) => f);
    check(`nowhere says ${why}`, hits.length === 0, hits.join(', '));
  }

  // -------------------------------------------------------------------------
  // The red star and the browser's required flag have to say the same thing.
  // The Oct 15 bug was exactly this drift, done in JS.
  suite('site content — the red star matches the required flag');

  for (const f of PUBLIC) {
    const html = PAGES[f];
    for (const lab of labels(html)) {
      if (!lab.for) continue;
      const control = controlById(html, lab.for);
      if (!control) continue;
      const starred = /class="req"/.test(lab.inner);
      const required = /\brequired\b/.test(control);
      if (/type="file"/.test(control)) {
        check(`${f}: ${lab.for} (upload) carries no star`, !starred);
      } else {
        check(`${f}: ${lab.for} star and required agree`, starred === required, starred ? 'starred but not required' : 'required but not starred');
      }
    }
  }

  // -------------------------------------------------------------------------
  suite('site content — search data and snippets');

  const COLOURS = ['black', 'brown', 'chestnut', 'mahogany', 'khaki', 'white', 'red', 'blue', 'navy', 'orange', 'pink', 'purple', 'yellow', 'green', 'gold', 'silver', 'turquoise', 'pewter', 'grey', 'gray', 'brass', 'nickel'];
  for (const f of PUBLIC) {
    const html = PAGES[f];
    for (const raw of jsonLd(html)) {
      check(`${f}: search data parses`, () => { JSON.parse(raw); return true; });
    }
    check(`${f}: has a search description`, !!metaDesc(html));

    // A snippet may only name colours the page actually offers. (It cannot
    // tell a hat colour from a patch colour — that one still needs eyes.)
    const sels = selects(html).filter((s) => s.options.length);
    const desc = metaDesc(html);
    if (!desc || !sels.length || !f.startsWith('product-')) continue;
    // Offered = dropdown values plus the feature-list bullets, so a one-colourway
    // product (the Smokey is chestnut, with no dropdown) still passes.
    const bullets = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => decode(m[1]).toLowerCase());
    const offered = new Set([...sels.flatMap((s) => s.options.map((o) => o.value.toLowerCase())), ...bullets].flatMap((v) => v.split(/[^a-z]+/)));
    const named = COLOURS.filter((c) => new RegExp('\\b' + c + '\\b', 'i').test(desc));
    const unoffered = named.filter((c) => !offered.has(c) && !(c === 'navy' && offered.has('navy blue')));
    check(`${f}: snippet names only colours the form offers`, unoffered.length === 0, unoffered.join(', '));
  }

  // -------------------------------------------------------------------------
  // The tiers are Snipcart rules the sale rule blocks (see worker/promo.js).
  // Wherever a page advertises them it must carry the note the Worker reveals.
  suite('site content — crew-tier pages carry the sale note');

  for (const f of PUBLIC) {
    if (!/or more hats|or more patches|crew discount/i.test(PAGES[f])) continue;
    check(`${f}: carries data-crew-sale-note`, PAGES[f].includes('data-crew-sale-note'));
  }

  // -------------------------------------------------------------------------
  suite('site content — sitemap lists every public page');

  const sitemap = read('sitemap.xml');
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  const UNLISTED = new Set(['index.html', 'track.html']);
  for (const f of PUBLIC) {
    if (UNLISTED.has(f)) continue;
    const url = 'https://rawhidecityleather.com/' + f.replace(/\.html$/, '');
    check(`sitemap lists /${f.replace(/\.html$/, '')}`, locs.includes(url));
  }
  check('sitemap lists the home page', locs.includes('https://rawhidecityleather.com/'));
  for (const loc of locs) {
    const slug = loc.replace('https://rawhidecityleather.com/', '');
    const file = slug === '' ? 'index.html' : slug + '.html';
    check(`sitemap entry ${loc} has a page`, file in PAGES);
  }

  // -------------------------------------------------------------------------
  // A tracker switched on without a line in the privacy policy is the gap this
  // closes. Google Analytics and Google Ads sit OFF in main.js until an id is
  // pasted in; the day one is, the deploy fails here until privacy.html says
  // so. The same goes for every other service the pages load.
  suite('site content — the privacy policy names what the site runs');

  const privacy = decode(PAGES['privacy.html'] || '');
  const mainJs = read('assets/js/main.js');
  const idOf = (name) => (mainJs.match(new RegExp('var ' + name + "='([^']*)'")) || [])[1];
  check('main.js still declares GA4_ID and ADS_ID', idOf('GA4_ID') !== undefined && idOf('ADS_ID') !== undefined);
  const anyPage = (re) => Object.values(PAGES).some((html) => re.test(html));
  const RUNS = [
    ['Meta Pixel', anyPage(/fbq\('init'/), /Meta Pixel|Meta's pixel/],
    ['Google Analytics', Boolean(idOf('GA4_ID')), /Google Analytics/],
    ['Google Ads', Boolean(idOf('ADS_ID')), /Google Ads/],
    ['Google Fonts', anyPage(/fonts\.googleapis\.com/), /Google Fonts/],
    ['Kit newsletter', anyPage(/app\.kit\.com/), /\bKit\b/],
    ['Snipcart', anyPage(/cdn\.snipcart\.com/), /Snipcart/],
    ['Stripe', /js\.stripe\.com/.test(read('worker/wallet.js')), /Stripe/],
    ['Google Customer Reviews', /renderOptIn/.test(mainJs), /Google Customer Reviews/],
  ];
  for (const [name, on, said] of RUNS) {
    if (on) check(`privacy policy mentions ${name}`, said.test(privacy));
  }
  check('privacy policy answers Do Not Track', /Do Not Track/.test(privacy));

  for (const f of PUBLIC) {
    check(`${f}: links the privacy policy`, /href="\/privacy"/.test(PAGES[f]));
    check(`${f}: links the terms`, /href="\/terms"/.test(PAGES[f]));
  }

  // -------------------------------------------------------------------------
  // The terms say buying means agreeing to them, so the checkout has to say so
  // where the buyer pays. Snipcart renders whatever sits in its payment
  // "bottom" slot under Place order; a page whose #snipcart div lost it checks
  // out silently. The quote page and the wallet page build their own.
  //
  // data-templates-url is load-bearing, odd as "inline" looks. With the legacy
  // install this site uses (no window.SnipcartSettings), Snipcart 3.7.1 reads
  // slot templates out of #snipcart only when that attribute is present, and
  // never fetches the value. Drop it and the slot renders nothing, with no
  // error. Found by testing on Oct 18 2026.
  suite('site content — checkout says buying means agreeing to the terms');

  const TERMS_SLOT = /<div hidden id="snipcart"[^>]*\bdata-templates-url="inline"[^>]*><payment section="bottom"><p class="rc-terms-note">By purchasing, you agree to our <a href="\/terms"[^>]*>Terms of Service<\/a>/;
  for (const f of PUBLIC) {
    if (!PAGES[f].includes('id="snipcart"')) continue;
    check(`${f}: checkout carries the terms line`, TERMS_SLOT.test(PAGES[f]));
  }
  check('quote page checkout carries the terms line', /<div hidden id="snipcart"[^>]*\bdata-templates-url="inline"[^>]*><payment section="bottom"><p class="rc-terms-note">[^<]*<a href="\/terms"/.test(read('worker/quote.js')));
  check('wallet page carries the terms line', /class="w-terms">By purchasing, you agree to our <a href="\/terms"/.test(read('worker/wallet.js')));
}
