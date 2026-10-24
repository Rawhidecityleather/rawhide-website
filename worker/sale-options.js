/**
 * Sale prices that live inside a product's dropdowns.
 *
 * Snipcart's discount rules see products, never the options on them, so
 * "chestnut straps 25% off, brown 30%" cannot be a rule. It can be a price
 * modifier on the Leather color dropdown: the storewide sale takes its 20% off
 * the whole cart as usual, and the colour's modifier is sized so that what is
 * left after the 20% is exactly the colour's price. Custom stamps go free the
 * same way — the dropdown keeps its choices and loses its upcharge.
 *
 * Two copies of every priced list, as always (worker/product-options.js): the
 * <select> the customer uses, and the hidden buy button Snipcart's crawler
 * reads to check the price. Both are rewritten here, from the page as it is
 * being served — after the dashboard's own option changes — so a colour Rob
 * marks out of stock stays out of stock and keeps its place.
 *
 * Nothing here needs undoing. Each sale is a date window in code AND needs the
 * sale banner live: past the end date, or with the banner switched off, the
 * pages go back to their own prices on the next request.
 */

import { getPromo, isLive, localDate, quoteDiscountRate } from './promo.js';
import { extractOptions } from './product-options.js';
import { applyRules, productIdFromPath } from './catalog.js';
import { esc } from './lib.js';

/**
 * `leather` — percent off per colour, by the value in the dropdown. A colour
 * not named here gets the storewide sale and nothing more.
 * `freeStamps` — the Custom stamps dropdown charges nothing.
 */
export const SALE_OPTIONS = [
  {
    name: 'Christmas Specials',
    starts: '2026-10-24',
    ends: '2026-11-13',
    products: {
      'fully-custom-radio-strap': { leather: { Black: 20, Chestnut: 25, Brown: 30 }, freeStamps: true },
      'basic-radio-strap': { leather: { Black: 20, Chestnut: 25, Brown: 30 } },
      'smokey-radio-strap': { freeStamps: true },
    },
  },
];

/**
 * The sale whose window today falls in, while the banner is live and
 * automatic. Automatic matters: the modifiers are sized against a sale that
 * comes off on its own, and a code sale would put the colour discount on the
 * page for everybody and then take the code off on top of it.
 */
export function activeSaleOptions(promo, now = new Date(), sales = SALE_OPTIONS) {
  if (!isLive(promo, now) || promo.kind !== 'auto') return null;
  const today = localDate(now);
  return sales.find((s) => today >= s.starts && today <= s.ends) || null;
}

/**
 * Cents off the price, as a modifier, so that `price` less the modifier less
 * the storewide sale comes to `price` less `rate` percent.
 *
 * Snipcart takes a rate off the order and rounds the discount to the cent, so
 * the exact answer is usually a fraction of a cent: 25% off $165 under a 20%
 * sale wants $10.3125 off first. The neighbours of it are tried and the
 * nearest one that lands on the right total wins.
 *
 * 0 when the storewide sale is already as good as the colour's.
 */
export function modifierCents(priceCents, rate, storeRate = 0) {
  const target = Math.round(priceCents * (100 - rate) / 100);
  const keep = 1 - storeRate;
  if (keep <= 0) return 0;
  const afterSale = (c) => c - Math.round(c * storeRate);
  if (afterSale(priceCents) <= target) return 0;

  const exact = priceCents - target / keep;
  const base = Math.round(exact);
  for (const step of [0, 1, -1, 2, -2, 3, -3]) {
    const off = base + step;
    if (off > 0 && afterSale(priceCents - off) === target) return off;
  }
  return base;
}

const money = (cents) => (cents / 100).toFixed(2);
const shortDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
};

function labelText(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The <option> children, in the shape worker/product-options.js writes them. */
function optionsMarkup(field, label) {
  const ph = field.placeholder;
  let out = ph
    ? (ph.required
      ? `<option value="" disabled selected hidden>${labelText(ph.text)}</option>`
      : `<option value="">${labelText(ph.text)}</option>`)
    : '';
  const first = field.choices.findIndex((c) => !c.note);
  let group = '';

  field.choices.forEach((c, i) => {
    const want = c.group || '';
    if (want !== group) {
      if (group) out += '</optgroup>';
      if (want) out += `<optgroup label="${esc(want)}">`;
      group = want;
    }
    const selected = !ph && i === first ? ' selected' : '';
    out += c.note
      ? `<option value="${esc(c.value)}" disabled>${labelText(c.value)} &mdash; ${labelText(c.note)}</option>`
      : `<option value="${esc(c.value)}"${selected}>${labelText(label(c))}</option>`;
  });

  return group ? out + '</optgroup>' : out;
}

/**
 * Everything one strap page gets, as catalog rules (worker/catalog.js applies
 * them). `html` is the page as it is about to be served.
 */
export function saleOptionRules(html, sale, product, storeRate = 0) {
  const deal = sale?.products?.[product];
  if (!deal) return [];

  const fields = extractOptions(html);
  const priceAttr = /data-order-form[^>]*data-snipcart-price="([\d.]+)"/.exec(html);
  const priceCents = priceAttr ? Math.round(Number(priceAttr[1]) * 100) : 0;
  const ends = shortDate(sale.ends);
  const rules = [];
  const byName = {};
  const lines = [];

  const leather = deal.leather && priceCents ? fields.find((f) => f.name === 'leather') : null;
  if (leather) {
    const off = new Map();
    for (const c of leather.choices) {
      const rate = deal.leather[c.value];
      if (rate) off.set(c.value, { rate, cents: modifierCents(priceCents, rate, storeRate) });
    }
    const dataOptions = leather.choices
      .filter((c) => !c.note)
      .map((c) => (off.get(c.value)?.cents ? `${c.value}[-${money(off.get(c.value).cents)}]` : c.value))
      .join('|');
    const shown = (c) => {
      const o = off.get(c.value);
      return o ? `${c.value} (${Math.max(o.rate, Math.round(storeRate * 100))}% off)` : c.value;
    };
    rules.push({
      selector: 'form[data-order-form] select[name="leather"]',
      action: 'select',
      value: optionsMarkup(leather, shown),
      dataOptions,
    });
    byName[leather.snipcartName] = dataOptions;

    for (const c of leather.choices) {
      const o = off.get(c.value);
      if (!o || c.note) continue;
      const pct = Math.max(o.rate, Math.round(storeRate * 100));
      lines.push(`${esc(c.value)} $${money(Math.round(priceCents * (100 - pct) / 100))}`);
    }
  }

  const stamps = deal.freeStamps ? fields.find((f) => f.name === 'customstamps') : null;
  if (stamps) {
    const dataOptions = stamps.choices.filter((c) => !c.note).map((c) => c.value).join('|');
    rules.push({
      selector: 'form[data-order-form] select[name="customstamps"]',
      action: 'select',
      value: optionsMarkup(stamps, (c) => (c.price ? `${c.value} (free through ${ends})` : c.value)),
      dataOptions,
    });
    byName[stamps.snipcartName] = dataOptions;
  }

  if (!rules.length) return [];
  rules.push({ selector: 'button.snipcart-add-item', action: 'custom-options', byName });

  // One line under the price, so the deal is on the page and not only in a
  // dropdown somebody has to open.
  // A strap with no colour prices (the Smokey) still says what the sale
  // takes off it, or the line reads as stamps-only.
  const said = [];
  if (lines.length) said.push(lines.join(' &middot; '));
  else if (storeRate) said.push(`${Math.round(storeRate * 100)}% off`);
  if (stamps) said.push(lines.length ? 'Custom stamps free' : 'custom stamps free');
  rules.push({
    selector: '.product-price',
    action: 'after',
    once: true,
    value: `<p class="product-sale" data-sale-options style="margin:-4px 0 14px;color:var(--c-accent);` +
      `font-family:var(--font-stamp);font-size:.8rem;letter-spacing:.06em;line-height:1.6">` +
      `${esc(sale.name)} through ${ends}: ${said.join(lines.length ? '. ' : ' and ')}. Comes off in the cart, no code needed.</p>`,
  });

  return rules;
}

/**
 * The storefront hook. Runs last of the page rewrites, so it sees the
 * dropdowns the dashboard set. Only a 200 GET of a product page that has a
 * deal, while the sale is on; every other request passes straight through
 * without its body being touched.
 */
export async function withSaleOptions(response, request, env, now = new Date()) {
  if (request.method !== 'GET' || response.status !== 200) return response;
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;

  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const product = productIdFromPath(path);
  if (!product || !SALE_OPTIONS.some((s) => s.products[product])) return response;

  const promo = await getPromo(env);
  const sale = activeSaleOptions(promo, now);
  if (!sale || !sale.products[product]) return response;

  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  const page = () => new Response(html, { status: response.status, headers });

  // The body is read by now, so a failure past here still has to hand a page
  // back — the one it was given, at its own prices.
  try {
    const rules = saleOptionRules(html, sale, product, quoteDiscountRate(promo, now));
    return rules.length ? applyRules(page(), rules) : page();
  } catch (err) {
    console.error('sale options failed', err?.message || err);
    return page();
  }
}
