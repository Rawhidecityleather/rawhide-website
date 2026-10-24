/**
 * Sale prices inside the strap dropdowns: the modifier arithmetic, the date
 * window, and the rewrite over the real strap pages — select and buy button
 * both, because Snipcart's crawler checks the button.
 */

import { readFileSync } from 'node:fs';
import { suite, check } from './harness.mjs';
import { installHTMLRewriterShim } from './html-rewriter-shim.mjs';
import worker from '../index.js';
import {
  SALE_OPTIONS, activeSaleOptions, modifierCents, saleOptionRules, withSaleOptions,
} from '../sale-options.js';

const page = (name) => readFileSync(new URL(`../../${name}.html`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CUSTOM = page('product-fully-custom-radio-strap');
const BASIC = page('product-basic-radio-strap');
const SMOKEY = page('product-smokey-radio-strap');

function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    async put(key, value) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key) ?? null;
      return v !== null && opts?.type === 'json' ? JSON.parse(v) : v;
    },
    _store: store,
  };
}

const SALE = {
  enabled: true, headline: 'Christmas Specials: 20% and up off', kind: 'auto', code: '',
  starts: '2026-10-24', ends: '2026-11-13', stacks: true,
  deal: { type: 'percent', value: 20, scope: 'store', productIds: [] },
};
// Noon Eastern on each day, well clear of midnight in either offset.
const ON = new Date('2026-10-30T16:00:00Z');
const LAST = new Date('2026-11-13T17:00:00Z');
const AFTER = new Date('2026-11-14T17:00:00Z');
const BEFORE = new Date('2026-10-23T16:00:00Z');

/** What a 20% Snipcart rate leaves of a price, in cents, rounded the way it rounds. */
const afterSale = (cents, rate = 0.2) => cents - Math.round(cents * rate);

const optionsOf = (html, name) => {
  const m = new RegExp(`<select[^>]*name="${name}"[^>]*data-options="([^"]*)"`).exec(html);
  return m ? m[1] : null;
};
const buttonOptions = (html, field) => {
  const button = /<button[^>]*class="snipcart-add-item"[^>]*>/.exec(html)?.[0] || '';
  const n = new RegExp(`data-item-custom(\\d+)-name="${field}"`).exec(button)?.[1];
  return n ? (new RegExp(`data-item-custom${n}-options="([^"]*)"`).exec(button)?.[1] ?? null) : null;
};

export default async function () {
  installHTMLRewriterShim();

  suite('sale options — the arithmetic');

  const c25 = modifierCents(16500, 25, 0.2);
  const c30 = modifierCents(16500, 30, 0.2);
  check('chestnut custom: $165 less the modifier less 20% is $123.75', afterSale(16500 - c25) === 12375, String(c25));
  check('brown custom: lands on $115.50', afterSale(16500 - c30) === 11550, String(c30));
  check('chestnut basic: lands on $86.25', afterSale(11500 - modifierCents(11500, 25, 0.2)) === 8625);
  check('brown basic: lands on $80.50', afterSale(11500 - modifierCents(11500, 30, 0.2)) === 8050);
  check('black at 20% under a 20% sale needs nothing', modifierCents(16500, 20, 0.2) === 0);
  check('a bigger storewide sale than the colour needs nothing', modifierCents(16500, 25, 0.3) === 0);
  check('with no storewide sale the modifier is the whole cut', modifierCents(16500, 25, 0) === 4125);

  suite('sale options — the window');

  check('live on a day inside it', activeSaleOptions(SALE, ON)?.name === 'Christmas Specials');
  check('live on the last day', !!activeSaleOptions(SALE, LAST));
  check('gone the day after, with nobody touching anything', activeSaleOptions(SALE, AFTER) === null);
  check('not before it starts', activeSaleOptions({ ...SALE, starts: '' }, BEFORE) === null);
  check('not while the banner is switched off', activeSaleOptions({ ...SALE, enabled: false }, ON) === null);
  check('not under a code sale',
    activeSaleOptions({ ...SALE, kind: 'code', code: 'XMAS' }, ON) === null);
  check('the window in code ends when the sale does',
    SALE_OPTIONS[0].starts === '2026-10-24' && SALE_OPTIONS[0].ends === '2026-11-13');

  suite('sale options — the strap pages');

  const sale = SALE_OPTIONS[0];
  const customRules = saleOptionRules(CUSTOM, sale, 'fully-custom-radio-strap', 0.2);
  const leatherRule = customRules.find((r) => r.selector.includes('name="leather"'));
  check('custom: the leather list carries the two cuts and leaves black alone',
    leatherRule?.dataOptions === `Black|Brown[-${(c30 / 100).toFixed(2)}]|Chestnut[-${(c25 / 100).toFixed(2)}]`,
    leatherRule?.dataOptions);
  check('custom: the dropdown says the percent, not the modifier',
    leatherRule.value.includes('>Chestnut (25% off)<') && leatherRule.value.includes('>Black (20% off)<') &&
    !leatherRule.value.includes('10.31'));
  check('custom: the customer still has to choose a colour',
    leatherRule.value.startsWith('<option value="" disabled selected hidden>'));
  const stampRule = customRules.find((r) => r.selector.includes('name="customstamps"'));
  check('custom: stamps cost nothing and keep their values',
    stampRule?.dataOptions === 'None|1 custom stamp|2 custom stamps' &&
    stampRule.value.includes('value="2 custom stamps"') && stampRule.value.includes('free through Nov 13'));
  const button = customRules.find((r) => r.action === 'custom-options');
  check('custom: the buy button gets the same two lists, by field name',
    button.byName['Leather color'] === leatherRule.dataOptions &&
    button.byName['Custom stamps'] === stampRule.dataOptions);
  const note = customRules.find((r) => r.action === 'after');
  check('custom: the prices under the price are the real ones',
    note.value.includes('Black $132.00') && note.value.includes('Brown $115.50') &&
    note.value.includes('Chestnut $123.75') && note.value.includes('Custom stamps free'));

  const basicRules = saleOptionRules(BASIC, sale, 'basic-radio-strap', 0.2);
  check('basic: colour prices, no stamps line',
    basicRules.find((r) => r.action === 'after').value.includes('Black $92.00 &middot; Brown $80.50 &middot; Chestnut $86.25') &&
    !basicRules.some((r) => r.selector.includes('customstamps')));

  const smokeyRules = saleOptionRules(SMOKEY, sale, 'smokey-radio-strap', 0.2);
  check('smokey: free stamps, and no leather cut on a fixed colourway',
    smokeyRules.some((r) => r.selector.includes('customstamps')) &&
    !smokeyRules.some((r) => r.selector.includes('name="leather"')));

  check('a product with no deal gets nothing', saleOptionRules(CUSTOM, sale, 'helmet-band', 0.2).length === 0);

  const outOfStock = CUSTOM.replace('<option>Brown</option>', '<option value="Brown" disabled>Brown &mdash; out of stock</option>');
  const oosRule = saleOptionRules(outOfStock, sale, 'fully-custom-radio-strap', 0.2)
    .find((r) => r.selector.includes('name="leather"'));
  check('a colour marked out of stock stays greyed and off the price list',
    oosRule.value.includes('<option value="Brown" disabled>Brown &mdash; out of stock</option>') &&
    !oosRule.dataOptions.includes('Brown'));

  suite('sale options — served');

  const env = { PROMO: makeKV({ current: SALE }) };
  const serve = async (html, path, now) => (await withSaleOptions(
    new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    new Request('https://rawhidecityleather.com' + path), env, now)).text();

  const live = await serve(CUSTOM, '/product-fully-custom-radio-strap', ON);
  check('the select and the button agree on the page',
    optionsOf(live, 'leather') === buttonOptions(live, 'Leather color') &&
    optionsOf(live, 'leather').includes('Chestnut[-'));
  check('stamps are free on the button Snipcart crawls',
    buttonOptions(live, 'Custom stamps') === 'None|1 custom stamp|2 custom stamps');
  check('the sale line sits right after the price',
    /<p class="product-price">\$165\.00<\/p><p class="product-sale" data-sale-options/.test(live));
  check('the list price itself is untouched', live.includes('data-item-price="165.00"'));

  const over = await serve(CUSTOM, '/product-fully-custom-radio-strap', AFTER);
  check('the day after it ends the page is back at its own prices',
    over === CUSTOM && buttonOptions(over, 'Custom stamps') === 'None|1 custom stamp[+5.00]|2 custom stamps[+10.00]');

  const helmet = '<p class="product-price">$50.00</p>';
  check('other pages pass straight through',
    (await serve(helmet, '/product-helmet-band', ON)) === helmet);

  const off = { PROMO: makeKV({ current: { ...SALE, enabled: false } }) };
  const offPage = await (await withSaleOptions(
    new Response(CUSTOM, { headers: { 'content-type': 'text/html' } }),
    new Request('https://rawhidecityleather.com/product-fully-custom-radio-strap'), off, ON)).text();
  check('banner switched off, prices back', offPage === CUSTOM);

  const viaWorker = await (await worker.fetch(
    new Request('https://rawhidecityleather.com/product-basic-radio-strap'),
    {
      PROMO: makeKV({ current: { ...SALE, enabled: false } }),
      ASSETS: { fetch: async () => new Response(BASIC, { headers: { 'content-type': 'text/html' } }) },
    })).text();
  check('the Worker serves the strap page through the hook without breaking it',
    viaWorker.includes('data-snipcart-id="basic-radio-strap"') && !viaWorker.includes('data-sale-options'));
}
