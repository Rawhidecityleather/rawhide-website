/**
 * The sale banner, and the Snipcart rule behind it.
 *
 * One record in the PROMO KV namespace says what sale is on, what the deal is,
 * whether it needs a code, and the dates it runs between. While it is live:
 *
 *   - every storefront page gets its announcement bar swapped for the sale
 *     line on the way out of the Worker, and the cart repeats the code;
 *   - a matching discount rule is created in Snipcart (worker/promo-sync.js)
 *     and archived again when the sale ends, so the banner and the cart can
 *     never disagree.
 *
 * Nothing here needs a deploy. The banner and the rule come from one form:
 * the Labor Day 2026 mix-up — ads said "code LABORDAY15", the rule was
 * automatic, the promo box rejected the code and people walked — happened
 * because the two were set up in two places by hand. The bar also says which
 * kind it is every time: "No code needed" or "Use code X at checkout".
 *
 * Dates are calendar days in Florida. "Ends Sep 8" means live through the last
 * minute of Sep 8 Eastern, not until 8pm the night before because the server
 * thinks in UTC.
 */

import { esc } from './lib.js';

export const PROMO_KEY = 'current';
export const TIME_ZONE = 'America/New_York';

/** What the bar says when no sale is on. Mirrors the markup in every page. */
export const DEFAULT_ANNOUNCEMENT =
  'Handmade in Lakeland, FL · Firefighter Owned · Free Shipping $85 and up';

/**
 * The catalogue, by Snipcart product id. The ids are the data-item-id on each
 * product page; the names are what the picker shows. A new product has to be
 * added here before a sale can be pointed at it — the same as it has to be
 * added to the weight table in worker/pirateship.js.
 */
export const PRODUCTS = [
  ['fully-custom-radio-strap', 'Fully Custom Radio Strap'],
  ['smokey-radio-strap', 'Smokey Radio Strap'],
  ['basic-radio-strap', 'Basic Radio Strap'],
  ['basket-weave-belt', 'Basket Weave Belt'],
  ['heavy-duty-belt', 'Heavy Duty Belt'],
  ['helmet-band', 'Helmet Band'],
  ['glove-strap', 'Glove Strap'],
  ['chin-strap', 'Chin Strap'],
  ['radio-bucket', 'Radio Bucket'],
  ['leather-patch-hat', 'Leather Patch Hat'],
  ['my-wife-beats-me-hat', 'My Wife Beats Me hat'],
  ['scream-for-daddy-hat', 'Scream for Daddy hat'],
  ['velcro-patch', 'Velcro Patch'],
  ['leather-butter', 'Leather Butter'],
];
const PRODUCT_NAME = new Map(PRODUCTS);

export const HEADLINE_MAX = 90;
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,23}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERCENT_MAX = 90;
const AMOUNT_MAX = 500;

export class PromoError extends Error {}

/* ------------------------------------------------------------------ model */

/**
 * Turns the dashboard form into a record, or throws a PromoError the form can
 * show. Everything is normalised here so the rest of the file can trust the
 * shape: headline is one line of trimmed text, the code is upper case, dates
 * are YYYY-MM-DD or empty, the deal is one of three shapes.
 *
 * The `snipcart` block is not set here. It belongs to worker/promo-sync.js,
 * and the save handler carries the stored one across.
 */
export function buildPromo(body = {}, now = new Date(), extra = []) {
  const headline = String(body.headline ?? '').replace(/\s+/g, ' ').trim();
  if (!headline) {
    throw new PromoError('Say what the sale is. The headline is what the bar shows.');
  }
  if (headline.length > HEADLINE_MAX) {
    throw new PromoError(
      `Keep the headline under ${HEADLINE_MAX} characters. It has to fit one line on a phone.`
    );
  }

  const kind = body.kind === 'code' ? 'code' : 'auto';
  let code = '';
  if (kind === 'code') {
    code = String(body.code ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      throw new PromoError(
        'The code is letters, numbers and dashes, 2 to 24 long. Snipcart gets exactly this.'
      );
    }
  }

  const starts = cleanDate(body.starts, 'start');
  const ends = cleanDate(body.ends, 'end');
  if (starts && ends && ends < starts) {
    throw new PromoError('The sale ends before it starts.');
  }

  return {
    enabled: body.enabled === true,
    headline,
    kind,
    code,
    starts,
    ends,
    deal: cleanDeal(body.deal, extra),
    updatedAt: now.toISOString(),
  };
}

function cleanDate(value, which) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  // Round-trip through Date so 2026-02-31 is caught, not just the shape.
  const valid = DATE_RE.test(text) &&
    new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) === text;
  if (!valid) throw new PromoError(`The ${which} date is not a real date.`);
  return text;
}

/**
 * percent — a rate off, the whole store or named products
 * amount  — dollars off the order, or off each named product
 * none    — banner only; the shop set the rule up in Snipcart by hand
 */
function cleanDeal(input = {}, extra = []) {
  const type = ['percent', 'amount', 'none'].includes(input?.type) ? input.type : 'none';
  if (type === 'none') return { type, value: 0, scope: 'store', productIds: [] };

  const raw = Number(input.value);
  let value;
  if (type === 'percent') {
    value = Math.round(raw);
    if (!Number.isFinite(raw) || value < 1 || value > PERCENT_MAX || value !== raw) {
      throw new PromoError(`Percent off is a whole number from 1 to ${PERCENT_MAX}.`);
    }
  } else {
    value = Math.round(raw * 100) / 100;
    if (!Number.isFinite(raw) || value < 1 || value > AMOUNT_MAX) {
      throw new PromoError(`Dollars off is from 1 to ${AMOUNT_MAX}.`);
    }
  }

  const scope = input.scope === 'products' ? 'products' : 'store';
  let productIds = [];
  if (scope === 'products') {
    const picked = Array.isArray(input.productIds) ? input.productIds : [];
    // The catalogue plus anything the shop has added itself. Filtered against
    // that list rather than trusted from the form, so a sale can only ever
    // name a product the site actually sells.
    productIds = [...PRODUCTS, ...extra].map(([id]) => id).filter((id) => picked.includes(id));
    if (!productIds.length) throw new PromoError('Pick at least one product, or make it the whole store.');
  }

  return { type, value, scope, productIds };
}

/* ------------------------------------------------------------------ state */

/** Today's calendar date in Florida, as YYYY-MM-DD. en-CA formats that way. */
export function localDate(now = new Date(), timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * The instant a Florida calendar day ends: midnight Eastern the next day, as
 * UTC. That is 04:00Z in summer and 05:00Z in winter, and rather than carry a
 * DST table this asks Intl which hour the date rolls over on.
 */
export function endOfDayUtc(date) {
  const [y, m, d] = date.split('-').map(Number);
  for (let hour = 3; hour <= 6; hour++) {
    const at = new Date(Date.UTC(y, m - 1, d + 1, hour));
    if (localDate(at) > date) return at.toISOString();
  }
  throw new Error(`could not find the end of ${date}`);
}

/**
 * off       — nothing saved, or the switch is off
 * scheduled — on, but the start date is still ahead
 * live      — on the site right now
 * ended     — on, but the end date has passed
 *
 * String comparison is enough because every date is YYYY-MM-DD.
 */
export function promoState(promo, now = new Date()) {
  if (!promo || !promo.enabled) return 'off';
  const today = localDate(now);
  if (promo.starts && today < promo.starts) return 'scheduled';
  if (promo.ends && today > promo.ends) return 'ended';
  return 'live';
}

export function isLive(promo, now = new Date()) {
  return promoState(promo, now) === 'live';
}

/** The one line the bar shows. Always says whether a code is involved. */
export function bannerText(promo) {
  const tail = promo.kind === 'code'
    ? `Use code ${promo.code} at checkout`
    : 'No code needed';
  return `${promo.headline} · ${tail}`;
}

/** The deal in words, for the card and the Snipcart rule's name. */
export function dealSentence(deal) {
  if (!deal || deal.type === 'none') return 'Banner only';
  const names = deal.productIds.map((id) => PRODUCT_NAME.get(id) || id);
  const list = names.length <= 3 ? names.join(', ') : `${names.length} products`;
  if (deal.type === 'percent') {
    return deal.scope === 'products' ? `${deal.value}% off ${list}` : `${deal.value}% off the whole store`;
  }
  const dollars = '$' + (Number.isInteger(deal.value) ? deal.value : deal.value.toFixed(2));
  return deal.scope === 'products' ? `${dollars} off each ${list}` : `${dollars} off the order`;
}

/**
 * The fraction a crew quote has to gross up by. Only an automatic percentage
 * on the whole store reaches a quote: Snipcart's automatic rules can be
 * pointed at products but never away from them, so a quote item cannot opt
 * out of a storewide rule. A code, a dollar amount, or a product-scoped rule
 * leaves the quote's button price alone.
 */
export function quoteDiscountRate(promo, now = new Date()) {
  if (!isLive(promo, now) || promo.kind !== 'auto') return 0;
  const deal = promo.deal;
  if (!deal || deal.type !== 'percent' || deal.scope !== 'store') return 0;
  return deal.value / 100;
}

/** What the storefront script is allowed to know. Nothing about dates. */
export function publicPromo(promo, now = new Date()) {
  if (!isLive(promo, now)) return { live: false };
  return {
    live: true,
    text: bannerText(promo),
    headline: promo.headline,
    kind: promo.kind,
    code: promo.code,
  };
}

/* --------------------------------------------------------------------- KV */

/**
 * Never throws: a KV hiccup must not take a product page down with it. The
 * 60 second cache is KV's floor, and it is why a change takes up to a minute
 * to reach every page.
 */
export async function getPromo(env) {
  if (!env.PROMO) return null;
  try {
    return await env.PROMO.get(PROMO_KEY, { type: 'json', cacheTtl: 60 });
  } catch {
    return null;
  }
}

export async function putPromo(env, promo) {
  await env.PROMO.put(PROMO_KEY, JSON.stringify(promo));
}

/* ------------------------------------------------------------- storefront */

/**
 * Swaps the announcement bar on a page for the sale line. Only touches a 200
 * HTML response to a GET, and only while the sale is live, so a 404, an image,
 * or a quiet week all pass straight through untouched.
 */
export async function withPromoBanner(response, request, env) {
  if (request.method !== 'GET' || response.status !== 200) return response;
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  const promo = await getPromo(env);
  if (!isLive(promo)) return response;
  return applyPromoBanner(response, promo);
}

/**
 * setInnerContent escapes by default, so a headline is text however it was
 * typed. HTMLRewriter is a Workers global; outside the runtime (the tests, a
 * Node preview) the page goes back as it came unless a shim is installed.
 */
export function applyPromoBanner(response, promo) {
  if (typeof HTMLRewriter === 'undefined') return response;
  const text = bannerText(promo);
  return new HTMLRewriter()
    .on('.announcement', {
      element(el) {
        const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
        if (!classes.includes('sale')) classes.push('sale');
        el.setAttribute('class', classes.join(' '));
      },
    })
    .on('.announcement p', {
      element(el) {
        el.setInnerContent(text);
      },
    })
    .transform(response);
}

/* -------------------------------------------------------------- dashboard */

const STATE_COPY = {
  off: { pill: 'done', label: 'Off' },
  scheduled: { pill: 'warn', label: 'Scheduled' },
  live: { pill: 'good', label: 'Live now' },
  ended: { pill: 'bad', label: 'Ended' },
};

function niceDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/** One sentence under the pill saying what the site is doing about it. */
export function stateSentence(promo, now = new Date()) {
  const state = promoState(promo, now);
  if (state === 'off') {
    return promo ? 'Saved, but switched off. The site shows the stock bar.'
                 : 'No sale saved. The site shows the stock bar.';
  }
  if (state === 'scheduled') {
    return `Goes up on ${niceDate(promo.starts)}${promo.ends ? `, comes down after ${niceDate(promo.ends)}` : ''}.`;
  }
  if (state === 'ended') {
    return `Came down after ${niceDate(promo.ends)}. The site is back on the stock bar.`;
  }
  return promo.ends
    ? `On every page now. Comes down after ${niceDate(promo.ends)}.`
    : 'On every page now, with no end date. Switch it off here when it is over.';
}

/**
 * What Snipcart has, in one sentence. `rule` is the discount fetched from
 * Snipcart for the card, or null when there was nothing to fetch or the fetch
 * failed — the sentence falls back to what the last sync recorded.
 */
export function snipcartSentence(promo, { rule = null, now = new Date() } = {}) {
  if (!promo) return 'Nothing on Snipcart.';
  const deal = promo.deal || { type: 'none' };
  const sc = promo.snipcart || { id: '', state: 'off', error: '' };
  const state = promoState(promo, now);

  if (sc.error) {
    return `Snipcart said no: ${sc.error} The banner is saved; the rule is not. ` +
      'Fix it and save again, or it retries on the hour.';
  }
  if (deal.type === 'none') {
    return 'Banner only. No rule is created here — set the discount up in Snipcart yourself, ' +
      'and make it match what the bar says.';
  }
  if (sc.state === 'on' && sc.id) {
    if (rule && rule.archived) {
      return 'The rule was archived on Snipcart by hand. Save again to put it back, or switch the sale off here.';
    }
    const uses = rule && typeof rule.numberOfUsages === 'number'
      ? ` Used ${rule.numberOfUsages} time${rule.numberOfUsages === 1 ? '' : 's'}.` : '';
    return `Rule is live on Snipcart: ${dealSentence(deal)}${promo.kind === 'code' ? `, code ${promo.code}` : ', automatic'}.${uses}`;
  }
  if (state === 'scheduled') return `No rule on Snipcart yet. It goes up with the banner on ${niceDate(promo.starts)}.`;
  if (state === 'live') return 'Rule not on Snipcart yet. It goes up within the hour, or save again to push it now.';
  return 'No rule on Snipcart. It is archived when the sale ends or is switched off.';
}

/**
 * The card. `ready` is whether the KV binding exists; without it the card
 * says how to finish the setup instead of offering a form that cannot save.
 * `rule` is Snipcart's copy of the discount, when the dashboard could fetch it.
 */
export function renderPromoCard(promo, {
  ready = true, rule = null, now = new Date(), extra = [],
} = {}) {
  const state = promoState(promo, now);
  const tone = STATE_COPY[state];
  const p = promo || { headline: '', kind: 'auto', code: '', starts: '', ends: '', enabled: false };
  const deal = p.deal || { type: 'none', value: 0, scope: 'store', productIds: [] };
  const preview = state === 'live' ? bannerText(p) : DEFAULT_ANNOUNCEMENT;
  const savedLabel = promo && promo.updatedAt
    ? 'Last saved ' + new Date(promo.updatedAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: TIME_ZONE,
      })
    : 'Nothing saved yet';
  const snipTone = (promo?.snipcart?.error) ? 'bad'
    : (promo?.snipcart?.state === 'on' && !(rule && rule.archived)) ? 'good'
    : (rule && rule.archived) ? 'bad' : 'done';

  const checked = (test) => (test ? ' checked' : '');
  const products = [...PRODUCTS, ...extra].map(([id, name]) => `<label class="qcheck promoproduct">
          <input type="checkbox" name="productIds" value="${esc(id)}"${checked(deal.productIds.includes(id))}>
          <span>${esc(name)}</span>
        </label>`).join('');

  return `<section id="sale" class="card">
    <div class="cardhead">
      <h2>Sale banner</h2>
      <span class="cardnote">the strip across the top of every page, and the rule behind it</span>
    </div>

    <p class="hint">
      Save a sale here and two things happen: the bar at the top of the site
      says it, on every page, between the dates you pick; and the matching
      discount is created in Snipcart so the cart takes it off. Both come down
      on their own when the end date passes. The bar changes within a minute;
      the rule goes up right away, or on the start date.
    </p>
    <p class="hint">
      Percent off the whole store also reaches crew quotes &mdash; the quote
      button is grossed up so the crew still pays the quoted number. A code, a
      dollar amount, or a sale on named products leaves quotes alone.
    </p>

    ${ready ? '' : `<p class="banner">
      Sale storage is not set up. Create the KV namespace and add the
      <code>PROMO</code> binding to <code>wrangler.jsonc</code> &mdash; see the README.
      Nothing saves until then.
    </p>`}

    <div class="promostatus">
      <span class="pill ${tone.pill}" id="promopill">${esc(tone.label)}</span>
      <span class="soft" id="promosentence">${esc(stateSentence(promo, now))}</span>
    </div>
    <div class="promostatus">
      <span class="pill ${snipTone}" id="promosnippill">Snipcart</span>
      <span class="soft" id="promosnip">${esc(snipcartSentence(promo, { rule, now }))}</span>
    </div>

    <div class="promobar${state === 'live' ? ' live' : ''}" id="promobar" aria-label="What the bar will say">
      <span id="promobartext">${esc(preview)}</span>
    </div>

    <form id="promoform" class="qform"${ready ? '' : ' hidden'}>
      <div class="qgrid">
        <label class="qfield qwide">
          <span>Headline <em>(what the bar says)</em></span>
          <input type="text" name="headline" required maxlength="${HEADLINE_MAX}"
            value="${esc(p.headline)}" placeholder="15% off every radio strap through Labor Day">
        </label>
        <label class="qfield qnarrow">
          <span>Starts <em>(blank for now)</em></span>
          <input type="date" name="starts" value="${esc(p.starts)}">
        </label>
        <label class="qfield qnarrow">
          <span>Ends <em>(blank for open-ended)</em></span>
          <input type="date" name="ends" value="${esc(p.ends)}">
        </label>
      </div>

      <div class="qpay">
        <span class="qpaylabel">The deal</span>
        <div class="qpayopts">
          <label class="qradio">
            <input type="radio" name="dealType" value="percent"${checked(deal.type === 'percent')}>
            <span><b>Percent off</b></span>
          </label>
          <label class="qradio">
            <input type="radio" name="dealType" value="amount"${checked(deal.type === 'amount')}>
            <span><b>Dollars off</b></span>
          </label>
          <label class="qradio">
            <input type="radio" name="dealType" value="none"${checked(deal.type === 'none')}>
            <span><b>Banner only</b> &mdash; I set the rule up in Snipcart myself</span>
          </label>
        </div>
        <div class="promodeal" id="promodeal"${deal.type === 'none' ? ' hidden' : ''}>
          <div class="qgrid">
            <label class="qfield qnarrow">
              <span id="promovaluelabel">${deal.type === 'amount' ? 'Dollars off' : 'Percent off'}</span>
              <input type="number" name="value" min="1" max="${deal.type === 'amount' ? AMOUNT_MAX : PERCENT_MAX}"
                step="${deal.type === 'amount' ? '0.01' : '1'}" value="${deal.value || ''}" placeholder="15">
            </label>
          </div>
          <div class="qpayopts promoscope">
            <label class="qradio">
              <input type="radio" name="scope" value="store"${checked(deal.scope !== 'products')}>
              <span><b>Whole store</b></span>
            </label>
            <label class="qradio">
              <input type="radio" name="scope" value="products"${checked(deal.scope === 'products')}>
              <span><b>These products</b></span>
            </label>
          </div>
          <div class="promoproducts" id="promoproducts"${deal.scope === 'products' ? '' : ' hidden'}>
            ${products}
          </div>
          <p class="hint promodealsentence" id="promodealsentence">${esc(dealSentence(deal))}</p>
        </div>
      </div>

      <div class="qpay">
        <span class="qpaylabel">How it applies</span>
        <div class="qpayopts">
          <label class="qradio">
            <input type="radio" name="kind" value="auto"${checked(p.kind !== 'code')}>
            <span><b>Automatic</b> &mdash; comes off in the cart on its own</span>
          </label>
          <label class="qradio">
            <input type="radio" name="kind" value="code"${checked(p.kind === 'code')}>
            <span><b>Code</b> &mdash; the buyer types it at checkout</span>
          </label>
        </div>
        <div class="qgrid" id="promocodefield"${p.kind === 'code' ? '' : ' hidden'}>
          <label class="qfield qnarrow">
            <span>Code <em>(Snipcart gets exactly this)</em></span>
            <input type="text" name="code" maxlength="24" value="${esc(p.code)}"
              placeholder="LABORDAY15" autocapitalize="characters" spellcheck="false">
          </label>
        </div>
      </div>

      <div class="qexempt">
        <label class="qcheck">
          <input type="checkbox" name="enabled" id="promoenabled"${checked(p.enabled)}>
          <span>Show it on the site</span>
        </label>
      </div>

      <div class="panelfoot">
        <button type="submit" class="btn" id="promosave">Save</button>
        <span class="soft" id="promosaved">${esc(savedLabel)}</span>
      </div>
    </form>
  </section>`;
}

export const PROMO_STYLES = `
.promostatus{display:flex;align-items:center;gap:12px;margin:0 0 10px;font-size:12.5px}
.promostatus+.promobar{margin-top:6px}
.promobar{margin:0 0 16px;padding:10px 16px;text-align:center;border:1px solid var(--line);
  border-radius:3px;background:#EBE8E1;color:#0F0F0F;font-family:var(--display);
  font-size:11px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;
  overflow-wrap:anywhere}
.promobar.live{background:#0F0F0F;color:#EBE8E1;border-color:#0F0F0F}
.promodeal{margin-top:12px}
.promoscope{margin-top:12px}
.promoproducts{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px 14px;
  margin-top:10px;padding:10px 12px;border:1px solid var(--line);border-radius:2px;background:var(--paper)}
.promoproducts[hidden]{display:none}
.promoproduct{font-size:12.5px}
.promodealsentence{margin:10px 0 0;font-weight:600;color:var(--ink)}
`;

/**
 * Runs inside the dashboard page. Keeps the preview strip and the deal
 * sentence honest as you type, and saves without a reload. Its own tiny
 * post() rather than the dashboard's: that one lives inside another closure,
 * and ten lines beats an export.
 */
export const PROMO_SCRIPT = `
(function(){
  var form = document.getElementById('promoform');
  if (!form) return;

  var DEFAULT_BAR = ${JSON.stringify(DEFAULT_ANNOUNCEMENT)};
  var NAMES = __NAMES__;
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg, bad){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, 5000);
  }

  var $ = function(id){ return document.getElementById(id); };
  var bar = $('promobar'), barText = $('promobartext');
  var pill = $('promopill'), sentence = $('promosentence');
  var snipPill = $('promosnippill'), snip = $('promosnip');
  var codeField = $('promocodefield');
  var dealBox = $('promodeal'), valueLabel = $('promovaluelabel');
  var productsBox = $('promoproducts'), dealSentence = $('promodealsentence');
  var saved = $('promosaved'), saveBtn = $('promosave');

  function picked(name){
    var el = form.querySelector('input[name=' + name + ']:checked');
    return el ? el.value : '';
  }

  function values(){
    return {
      headline: form.headline.value,
      kind: picked('kind') || 'auto',
      code: form.code.value,
      starts: form.starts.value,
      ends: form.ends.value,
      enabled: form.enabled.checked,
      deal: {
        type: picked('dealType') || 'none',
        value: form.value.value,
        scope: picked('scope') || 'store',
        productIds: [].slice.call(form.querySelectorAll('input[name=productIds]:checked'))
          .map(function(c){ return c.value; })
      }
    };
  }

  // Same words the server uses, so what you see is what goes up.
  function previewText(v){
    var head = v.headline.replace(/\\s+/g, ' ').trim();
    if (!head) return DEFAULT_BAR;
    var tail = v.kind === 'code'
      ? 'Use code ' + (v.code.trim().toUpperCase() || '\\u2026') + ' at checkout'
      : 'No code needed';
    return head + ' \\u00b7 ' + tail;
  }

  function dealWords(d){
    if (d.type === 'none') return 'Banner only';
    var n = Number(d.value);
    var names = d.productIds.map(function(id){ return NAMES[id] || id; });
    var list = names.length <= 3 ? names.join(', ') : names.length + ' products';
    var onProducts = d.scope === 'products';
    if (d.type === 'percent') {
      var pct = (n ? n : '\\u2026') + '%';
      return onProducts ? pct + ' off ' + (list || '\\u2026') : pct + ' off the whole store';
    }
    var usd = '$' + (n ? (Number.isInteger(n) ? n : n.toFixed(2)) : '\\u2026');
    return onProducts ? usd + ' off each ' + (list || '\\u2026') : usd + ' off the order';
  }

  function paint(){
    var v = values();
    var isCode = v.kind === 'code';
    codeField.hidden = !isCode;
    var d = v.deal;
    dealBox.hidden = d.type === 'none';
    productsBox.hidden = d.scope !== 'products';
    if (d.type === 'amount') {
      valueLabel.textContent = 'Dollars off';
      form.value.step = '0.01'; form.value.max = '${AMOUNT_MAX}';
    } else {
      valueLabel.textContent = 'Percent off';
      form.value.step = '1'; form.value.max = '${PERCENT_MAX}';
    }
    dealSentence.textContent = dealWords(d);
    var showing = v.enabled && v.headline.trim();
    barText.textContent = showing ? previewText(v) : DEFAULT_BAR;
    bar.className = 'promobar' + (showing ? ' live' : '');
  }
  form.addEventListener('input', paint);
  form.addEventListener('change', paint);

  var PILLS = { off: 'done', scheduled: 'warn', live: 'good', ended: 'bad' };
  var LABELS = { off: 'Off', scheduled: 'Scheduled', live: 'Live now', ended: 'Ended' };

  form.addEventListener('submit', function(e){
    e.preventDefault();
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\\u2026';
    fetch('/dashboard/api/promo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
      body: JSON.stringify(values())
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    }).then(function(data){
      pill.className = 'pill ' + PILLS[data.state];
      pill.textContent = LABELS[data.state];
      sentence.textContent = data.sentence;
      snip.textContent = data.snipcartSentence;
      snipPill.className = 'pill ' + (data.snipcart && data.snipcart.error ? 'bad'
        : data.snipcart && data.snipcart.state === 'on' ? 'good' : 'done');
      barText.textContent = data.state === 'live' ? data.text : DEFAULT_BAR;
      bar.className = 'promobar' + (data.state === 'live' ? ' live' : '');
      form.code.value = data.promo.code;
      form.headline.value = data.promo.headline;
      saved.textContent = 'Saved just now';
      if (data.snipcart && data.snipcart.error) {
        toast('Banner saved, but Snipcart refused the rule. See the Snipcart line.', true);
      } else {
        toast(data.state === 'live' ? 'Saved. The bar changes on the site within a minute.'
            : data.state === 'scheduled' ? 'Saved. It goes up on the start date.'
            : 'Saved. The site shows the stock bar.');
      }
    }).catch(function(err){
      toast(err.message, true);
    }).then(function(){
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    });
  });
})();
`;

/**
 * The script with the product names in it. A name is only used to say what was
 * picked, but the list has to match the checkboxes the card rendered — a
 * product the shop added is in one and would be missing from the other.
 */
export function promoScript(extra = []) {
  return PROMO_SCRIPT.replace(
    '__NAMES__',
    JSON.stringify(Object.fromEntries([...PRODUCTS, ...extra]))
  );
}
