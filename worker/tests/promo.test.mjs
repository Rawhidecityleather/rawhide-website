/**
 * The sale banner: the record, the date window, the card, the rewrite, the
 * two routes, and the Snipcart rule behind it — driven through the real Worker
 * with a KV shim and a stand-in for Snipcart's discounts API.
 */

import { suite, check, throws } from './harness.mjs';
import { installHTMLRewriterShim } from './html-rewriter-shim.mjs';
import worker from '../index.js';
import {
  buildPromo, promoState, isLive, bannerText, publicPromo, localDate, endOfDayUtc,
  renderPromoCard, applyPromoBanner, stateSentence, snipcartSentence, dealSentence,
  quoteDiscountRate, DEFAULT_ANNOUNCEMENT, HEADLINE_MAX, PRODUCTS,
} from '../promo.js';
import { discountBody, syncPromo, RULE_PREFIX } from '../promo-sync.js';
import { buildQuote } from '../quote.js';

function makeKV() {
  const store = new Map();
  return {
    async put(key, value) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key) ?? null;
      return v !== null && opts?.type === 'json' ? JSON.parse(v) : v;
    },
    _store: store,
  };
}

/**
 * Snipcart's /discounts, as far as promo-sync.js uses it. Records every call
 * so a test can say "that was one PUT and no POST". `refuse` makes the next
 * write fail the way Snipcart fails — a 400 with a message in the body.
 */
function stubSnipcart() {
  const real = globalThis.fetch;
  const api = { calls: [], rules: new Map(), refuse: '', nextId: 1 };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://app.snipcart.com/api/discounts')) return real(url, init);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const id = decodeURIComponent((u.match(/discounts\/([^/?]+)/) || [])[1] || '');
    api.calls.push({ method, id, body });

    if (method !== 'GET' && api.refuse) return reply({ message: api.refuse }, 400);
    if (method === 'POST') {
      const rule = { id: 'disc_' + api.nextId++, archived: false, numberOfUsages: 0,
        creationDate: new Date().toISOString(), ...body };
      api.rules.set(rule.id, rule);
      return reply(rule, 201);
    }
    if (method === 'PUT') {
      const rule = api.rules.get(id);
      if (!rule) return reply({ message: 'not found' }, 404);
      Object.assign(rule, body);
      return reply(rule);
    }
    if (id) {
      const rule = api.rules.get(id);
      return rule ? reply(rule) : reply({ message: 'not found' }, 404);
    }
    return reply([...api.rules.values()]);
  };

  api.restore = () => { globalThis.fetch = real; };
  api.active = () => [...api.rules.values()].filter((r) => !r.archived);
  api.writes = () => api.calls.filter((c) => c.method !== 'GET');
  return api;
}

const PAGE = `<!doctype html><html><body>
<div class="announcement"><div class="container"><p>${DEFAULT_ANNOUNCEMENT}</p></div></div>
<main>shop</main></body></html>`;

export default async function run() {
  installHTMLRewriterShim();

  suite('promo — the record');

  const good = () => buildPromo({
    headline: '  15% off   every radio strap  ', kind: 'code', code: ' fall15 ',
    starts: '2026-09-20', ends: '2026-09-27', enabled: true,
    deal: { type: 'percent', value: 15, scope: 'store' },
  }, new Date('2026-09-13T12:00:00Z'));

  check('headline is collapsed to one line', good().headline === '15% off every radio strap');
  check('code is trimmed and upper-cased', good().code === 'FALL15');
  check('dates come through as typed', good().starts === '2026-09-20' && good().ends === '2026-09-27');
  check('enabled is a real boolean, not a truthy string', buildPromo({ headline: 'x', enabled: 'true' }).enabled === false);
  check('updatedAt is stamped', good().updatedAt === '2026-09-13T12:00:00.000Z');
  check('kind defaults to automatic with an empty code',
    buildPromo({ headline: 'x' }).kind === 'auto' && buildPromo({ headline: 'x' }).code === '');
  check('an automatic sale ignores whatever is in the code box',
    buildPromo({ headline: 'x', kind: 'auto', code: 'STALE' }).code === '');
  check('the record never carries a snipcart block from the form',
    !('snipcart' in buildPromo({ headline: 'x', snipcart: { id: 'forged' } })));

  throws('a blank headline is refused', () => buildPromo({ headline: '   ' }), 'headline');
  throws('a headline over the cap is refused',
    () => buildPromo({ headline: 'x'.repeat(HEADLINE_MAX + 1) }), 'characters');
  throws('a code with spaces is refused', () => buildPromo({ headline: 'x', kind: 'code', code: 'FALL 15' }), 'code');
  throws('a one-character code is refused', () => buildPromo({ headline: 'x', kind: 'code', code: 'F' }), 'code');
  throws('a missing code on a code sale is refused', () => buildPromo({ headline: 'x', kind: 'code' }), 'code');
  throws('a date in the wrong shape is refused', () => buildPromo({ headline: 'x', starts: '9/20/2026' }), 'start date');
  throws('a date that does not exist is refused', () => buildPromo({ headline: 'x', ends: '2026-02-31' }), 'end date');
  throws('ending before starting is refused',
    () => buildPromo({ headline: 'x', starts: '2026-09-27', ends: '2026-09-20' }), 'ends before');

  suite('promo — the deal');

  const dealOf = (deal) => buildPromo({ headline: 'x', deal }).deal;
  check('no deal means banner only', dealOf(undefined).type === 'none' && dealOf({}).type === 'none');
  check('banner only carries no value or products',
    JSON.stringify(dealOf({ type: 'none', value: 50, productIds: ['helmet-band'] })) ===
    '{"type":"none","value":0,"scope":"store","productIds":[]}');
  check('percent off the store', JSON.stringify(dealOf({ type: 'percent', value: '15' })) ===
    '{"type":"percent","value":15,"scope":"store","productIds":[]}');
  check('dollars off keeps cents', dealOf({ type: 'amount', value: '12.5' }).value === 12.5);
  check('products are kept in catalogue order and unknown ids dropped',
    JSON.stringify(dealOf({ type: 'percent', value: 10, scope: 'products',
      productIds: ['glove-strap', 'bogus', 'helmet-band'] }).productIds) === '["helmet-band","glove-strap"]');
  throws('zero percent is refused', () => dealOf({ type: 'percent', value: 0 }), 'Percent');
  throws('a fraction of a percent is refused', () => dealOf({ type: 'percent', value: 12.5 }), 'Percent');
  throws('91 percent is refused', () => dealOf({ type: 'percent', value: 91 }), 'Percent');
  throws('a non-number is refused', () => dealOf({ type: 'amount', value: 'ten' }), 'Dollars');
  throws('$501 is refused', () => dealOf({ type: 'amount', value: 501 }), 'Dollars');
  throws('these-products with none picked is refused',
    () => dealOf({ type: 'percent', value: 10, scope: 'products', productIds: [] }), 'Pick at least one');
  throws('these-products with only unknown ids is refused',
    () => dealOf({ type: 'percent', value: 10, scope: 'products', productIds: ['nope'] }), 'Pick at least one');

  check('the deal reads back in words', dealSentence(dealOf({ type: 'percent', value: 15 })) === '15% off the whole store');
  check('dollars off the order', dealSentence(dealOf({ type: 'amount', value: 10 })) === '$10 off the order');
  check('dollars off each named product',
    dealSentence(dealOf({ type: 'amount', value: 7.5, scope: 'products', productIds: ['helmet-band'] })) === '$7.50 off each Helmet Band');
  check('four products are counted, not listed',
    dealSentence(dealOf({ type: 'percent', value: 20, scope: 'products',
      productIds: PRODUCTS.slice(0, 4).map(([id]) => id) })) === '20% off 4 products');

  suite('promo — the window is Florida calendar days');

  const sale = {
    enabled: true, headline: 'Fall sale', kind: 'auto', code: '', starts: '2026-09-20', ends: '2026-09-27',
    deal: { type: 'percent', value: 15, scope: 'store', productIds: [] },
  };

  check('en-CA gives YYYY-MM-DD', localDate(new Date('2026-09-13T12:00:00Z')) === '2026-09-13');
  check('nothing saved is off', promoState(null) === 'off');
  check('switched off is off whatever the dates', promoState({ ...sale, enabled: false }, new Date('2026-09-22T12:00:00Z')) === 'off');
  check('the day before it starts is scheduled', promoState(sale, new Date('2026-09-19T12:00:00Z')) === 'scheduled');
  check('03:59Z on the start date is still the night before in Florida',
    promoState(sale, new Date('2026-09-20T03:59:00Z')) === 'scheduled');
  check('04:00Z on the start date is midnight Eastern, so live',
    promoState(sale, new Date('2026-09-20T04:00:00Z')) === 'live');
  check('mid-window is live', isLive(sale, new Date('2026-09-23T12:00:00Z')));
  check('03:59Z the day after it ends is still the last minute of the last day',
    promoState(sale, new Date('2026-09-28T03:59:00Z')) === 'live');
  check('04:00Z the day after it ends is ended', promoState(sale, new Date('2026-09-28T04:00:00Z')) === 'ended');
  check('no start date means live from now', promoState({ ...sale, starts: '' }, new Date('2026-01-01T12:00:00Z')) === 'live');
  check('no end date means live until switched off', promoState({ ...sale, ends: '' }, new Date('2030-01-01T12:00:00Z')) === 'live');
  check('end of a summer day is 04:00Z next day', endOfDayUtc('2026-09-27') === '2026-09-28T04:00:00.000Z');
  check('end of a winter day is 05:00Z next day', endOfDayUtc('2026-12-20') === '2026-12-21T05:00:00.000Z');
  check('end of the year rolls the year', endOfDayUtc('2026-12-31') === '2027-01-01T05:00:00.000Z');

  suite('promo — what the bar, the cart and the quotes get');

  check('an automatic sale says so', bannerText(sale) === 'Fall sale · No code needed');
  check('a code sale names the code',
    bannerText({ ...sale, kind: 'code', code: 'FALL15' }) === 'Fall sale · Use code FALL15 at checkout');
  check('the public shape is empty when off', JSON.stringify(publicPromo(null)) === '{"live":false}');
  check('the public shape is empty when scheduled',
    publicPromo(sale, new Date('2026-09-19T12:00:00Z')).live === false);
  const pub = publicPromo({ ...sale, kind: 'code', code: 'FALL15' }, new Date('2026-09-23T12:00:00Z'));
  check('the public shape carries the code and the line', pub.live && pub.code === 'FALL15' && pub.text.includes('FALL15'));
  check('the public shape never says the dates or the deal',
    !('starts' in pub) && !('ends' in pub) && !('enabled' in pub) && !('deal' in pub) && !('snipcart' in pub));

  const mid = new Date('2026-09-23T12:00:00Z');
  check('a storewide automatic percent grosses quotes up', quoteDiscountRate(sale, mid) === 0.15);
  check('a code sale leaves quotes alone', quoteDiscountRate({ ...sale, kind: 'code', code: 'X15' }, mid) === 0);
  check('dollars off leaves quotes alone', quoteDiscountRate({ ...sale, deal: { type: 'amount', value: 10, scope: 'store', productIds: [] } }, mid) === 0);
  check('a product sale leaves quotes alone',
    quoteDiscountRate({ ...sale, deal: { type: 'percent', value: 15, scope: 'products', productIds: ['helmet-band'] } }, mid) === 0);
  check('banner only leaves quotes alone', quoteDiscountRate({ ...sale, deal: { type: 'none' } }, mid) === 0);
  check('a scheduled sale leaves quotes alone', quoteDiscountRate(sale, new Date('2026-09-01T12:00:00Z')) === 0);
  check('nothing saved leaves quotes alone', quoteDiscountRate(null) === 0);

  const quote = buildQuote({
    title: 'Straps', customer: 'Dana', lines: [{ description: 'Strap', quantity: 12, unitPrice: 150 }],
  }, { discountRate: 0.2 });
  check('a quote built under a 20% sale carries a grossed-up button',
    quote.total === 1800 && quote.listPrice === 2250 && quote.discountRate === 0.2);
  check('a quote built with no rate passed is at face value',
    buildQuote({ title: 'Straps', customer: 'Dana', lines: [{ description: 'Strap', quantity: 1, unitPrice: 100 }] }).listPrice === 100);

  suite('promo — the page rewrite');

  const html = async (promo) => {
    const res = await applyPromoBanner(new Response(PAGE, { headers: { 'content-type': 'text/html' } }), promo);
    return res.text();
  };
  const live = await html(sale);
  check('the bar text is swapped', live.includes('<p>Fall sale · No code needed</p>') && !live.includes(DEFAULT_ANNOUNCEMENT));
  check('the bar picks up the sale class', live.includes('<div class="announcement sale">'));
  check('the rest of the page is untouched', live.includes('<main>shop</main>'));
  const nasty = await html({ ...sale, headline: '<img src=x onerror=alert(1)> off' });
  check('a headline is text, never markup', nasty.includes('&lt;img') && !nasty.includes('<img'));

  suite('promo — the Snipcart rule body');

  const body = (over) => discountBody({ ...sale, ...over });
  const autoStore = body({});
  check('automatic storewide percent is a Total trigger with a Rate',
    autoStore.trigger === 'Total' && autoStore.totalToReach === 1 && autoStore.type === 'Rate' && autoStore.rate === 15);
  check('it is named so it can be found again', autoStore.name === RULE_PREFIX + '15% off the whole store');
  check('it never stacks with a recovery coupon', autoStore.combinable === false);
  check('it has no usage cap', autoStore.maxNumberOfUsages === null);
  check('the end date becomes the last minute of that day in Florida', autoStore.expires === '2026-09-28T04:00:00.000Z');
  check('no end date means no expiry', body({ ends: '' }).expires === null);
  check('no code field on an automatic rule', !('code' in autoStore));

  const codeStore = body({ kind: 'code', code: 'FALL15' });
  check('a code sale is a Code trigger carrying the code',
    codeStore.trigger === 'Code' && codeStore.code === 'FALL15' && !('totalToReach' in codeStore));
  check('the code is in the name too', codeStore.name.endsWith('(FALL15)'));

  const amountStore = body({ deal: { type: 'amount', value: 10, scope: 'store', productIds: [] } });
  check('dollars off the order is a FixedAmount with the amount as the minimum',
    amountStore.type === 'FixedAmount' && amountStore.amount === 10 && amountStore.totalToReach === 10);

  const pctProducts = body({ deal: { type: 'percent', value: 20, scope: 'products', productIds: ['helmet-band', 'glove-strap'] } });
  check('percent on products is RateOnItems with a comma list',
    pctProducts.type === 'RateOnItems' && pctProducts.rate === 20 && pctProducts.productIds === 'helmet-band,glove-strap');
  const amtProducts = body({ deal: { type: 'amount', value: 5, scope: 'products', productIds: ['velcro-patch'] } });
  check('dollars on products is FixedAmountOnItems',
    amtProducts.type === 'FixedAmountOnItems' && amtProducts.amount === 5 && amtProducts.productIds === 'velcro-patch');
  check('a product rule is not gated on an order minimum', pctProducts.totalToReach === 1);

  suite('promo — the card');

  const now = new Date('2026-09-23T12:00:00Z');
  const liveRec = { ...sale, kind: 'code', code: 'FALL15', updatedAt: '2026-09-13T12:00:00Z',
    snipcart: { id: 'disc_1', state: 'on', hash: 'x', at: '', error: '' } };
  const card = renderPromoCard(liveRec, { now, rule: { id: 'disc_1', archived: false, numberOfUsages: 3 } });
  check('a live sale shows Live now', card.includes('Live now') && card.includes('pill good'));
  check('the preview strip shows the sale line', card.includes('Fall sale · Use code FALL15 at checkout'));
  check('the form is filled from the record',
    card.includes('value="Fall sale"') && card.includes('value="FALL15"') && card.includes('value="2026-09-20"'));
  check('the code radio is picked and the code field shown',
    card.includes('value="code" checked') && !card.includes('id="promocodefield" hidden'));
  check('the deal radios and value are filled',
    card.includes('value="percent" checked') && card.includes('value="15"') && card.includes('value="store" checked'));
  check('every catalogue product is in the picker', PRODUCTS.every(([id]) => card.includes(`value="${id}"`)));
  check('the switch is ticked', card.includes('id="promoenabled" checked'));
  check('the card says when it was saved', card.includes('Last saved Sep 13, 2026'));
  check('the Snipcart line shows the live rule and its uses',
    card.includes('Rule is live on Snipcart: 15% off the whole store, code FALL15. Used 3 times.'));

  const archivedByHand = renderPromoCard(liveRec, { now, rule: { id: 'disc_1', archived: true } });
  check('a rule archived by hand is called out', archivedByHand.includes('archived on Snipcart by hand'));

  const refused = renderPromoCard({ ...liveRec, snipcart: { id: '', state: 'off', error: 'Snipcart returned 400: code taken.' } }, { now });
  check('a refusal is quoted on the card', refused.includes('Snipcart said no: Snipcart returned 400: code taken.'));

  const empty = renderPromoCard(null, { now });
  check('no record shows Off and the stock bar', empty.includes('>Off<') && empty.includes(DEFAULT_ANNOUNCEMENT));
  check('no record leaves the code field hidden and Automatic picked',
    empty.includes('id="promocodefield" hidden') && empty.includes('value="auto" checked'));
  check('no record is banner only with the deal fields hidden',
    empty.includes('value="none" checked') && empty.includes('id="promodeal" hidden'));

  const evil = renderPromoCard({ ...sale, headline: '"><script>x</script>' }, { now });
  check('the headline is escaped in the input and the preview',
    !evil.includes('<script>') && evil.includes('&quot;&gt;&lt;script&gt;'));

  check('scheduled says when it goes up',
    stateSentence(sale, new Date('2026-09-01T12:00:00Z')) === 'Goes up on Sep 20, 2026, comes down after Sep 27, 2026.');
  check('ended says it came down',
    stateSentence(sale, new Date('2026-10-01T12:00:00Z')).startsWith('Came down after Sep 27, 2026.'));
  check('live says when it comes down',
    stateSentence(sale, now) === 'On every page now. Comes down after Sep 27, 2026.');
  check('live with no end date says to switch it off',
    stateSentence({ ...sale, ends: '' }, now).includes('Switch it off here'));
  check('scheduled says the rule goes up with the banner',
    snipcartSentence(sale, { now: new Date('2026-09-01T12:00:00Z') }).includes('goes up with the banner on Sep 20, 2026'));
  check('banner only says to set the rule up by hand',
    snipcartSentence({ ...sale, deal: { type: 'none' } }, { now }).startsWith('Banner only.'));

  const notReady = renderPromoCard(null, { ready: false, now });
  check('without the binding the card explains and hides the form',
    notReady.includes('not set up') && notReady.includes('id="promoform" class="qform" hidden'));

  suite('promo — keeping Snipcart in step');

  const api = stubSnipcart();
  try {
    const env = {
      PROMO: makeKV(),
      QUOTES: makeKV(),
      SNIPCART_SECRET: 'test-key-never-used',
      SLIP_USER: 'dev',
      SLIP_PASS: 'dev',
      ASSETS: {
        fetch: async (req) => {
          const p = new URL(req.url).pathname;
          if (p === '/' || p === '/shop') {
            return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
          }
          if (p === '/assets/css/style.css') {
            return new Response('.announcement{}', { headers: { 'content-type': 'text/css' } });
          }
          return new Response(PAGE, { status: 404, headers: { 'content-type': 'text/html' } });
        },
      },
    };
    const ORIGIN = 'https://rawhidecityleather.com';
    const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
    const DASH = { Authorization: AUTH, 'x-rawhide-dashboard': '1' };
    const get = (path, headers = {}) => worker.fetch(new Request(ORIGIN + path, { headers }), env);
    const post = (path, body, headers = {}) => worker.fetch(new Request(ORIGIN + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }), env);
    const today = localDate(new Date());
    const tomorrow = localDate(new Date(Date.now() + 86400000));

    check('the public route needs no login', (await get('/api/promo')).status === 200);
    check('with nothing saved it says not live', (await (await get('/api/promo')).json()).live === false);
    check('a page passes through untouched with nothing saved', (await (await get('/')).text()).includes(DEFAULT_ANNOUNCEMENT));

    check('saving demands a login', (await post('/dashboard/api/promo', {})).status === 401);
    check('saving demands the dashboard header', (await post('/dashboard/api/promo', {}, { Authorization: AUTH })).status === 403);
    const bad = await post('/dashboard/api/promo', { headline: '' }, DASH);
    check('a bad record is a 400 with the complaint', bad.status === 400 && (await bad.json()).error.includes('headline'));
    check('a refused save touches Snipcart not at all', api.calls.length === 0);

    // 1. A live code sale: the rule is created.
    const saved = await post('/dashboard/api/promo', {
      headline: 'Fall sale', kind: 'code', code: 'fall15', starts: today, ends: '', enabled: true,
      deal: { type: 'percent', value: 15, scope: 'store' },
    }, DASH);
    const savedBody = await saved.json();
    check('a good record saves', saved.status === 200 && savedBody.ok === true);
    check('the save reports live, with the line and the sentence',
      savedBody.state === 'live' && savedBody.text === 'Fall sale · Use code FALL15 at checkout' &&
      savedBody.sentence.startsWith('On every page now'));
    check('it landed in KV under the one key', env.PROMO._store.has('current'));
    check('one rule was created on Snipcart', api.writes().length === 1 && api.writes()[0].method === 'POST');
    check('the rule is the code sale', api.active().length === 1 && api.active()[0].code === 'FALL15' && api.active()[0].rate === 15);
    check('the save reports the rule live', savedBody.snipcart.state === 'on' && savedBody.snipcart.id === api.active()[0].id
      && savedBody.snipcartSentence.startsWith('Rule is live on Snipcart'));

    const pubRes = await get('/api/promo');
    check('the public route now says live with the code',
      (await pubRes.json()).code === 'FALL15' && pubRes.headers.get('cache-control') === 'public, max-age=60');
    const page = await (await get('/shop')).text();
    check('a page now carries the sale line', page.includes('Fall sale · Use code FALL15 at checkout') && page.includes('announcement sale'));
    check('a 404 page is left alone', !(await (await get('/nope')).text()).includes('Fall sale'));
    check('a stylesheet is left alone', (await (await get('/assets/css/style.css')).text()) === '.announcement{}');
    check('a POST to a page is left alone',
      !(await (await worker.fetch(new Request(ORIGIN + '/shop', { method: 'POST' }), env)).text()).includes('Fall sale'));

    // 2. Saving the same sale again costs Snipcart nothing.
    const before = api.calls.length;
    await post('/dashboard/api/promo', {
      headline: 'Fall sale', kind: 'code', code: 'FALL15', starts: today, ends: '', enabled: true,
      deal: { type: 'percent', value: 15, scope: 'store' },
    }, DASH);
    check('an unchanged sale makes no Snipcart calls', api.calls.length === before);

    // 3. Changing the deal edits the same rule rather than making another.
    const ruleId = api.active()[0].id;
    await post('/dashboard/api/promo', {
      headline: 'Fall sale', kind: 'code', code: 'FALL15', starts: today, ends: '', enabled: true,
      deal: { type: 'percent', value: 20, scope: 'products', productIds: ['helmet-band', 'glove-strap'] },
    }, DASH);
    check('the rule was edited in place', api.active().length === 1 && api.active()[0].id === ruleId);
    check('and now carries the product scope',
      api.active()[0].type === 'RateOnItems' && api.active()[0].rate === 20 && api.active()[0].productIds === 'helmet-band,glove-strap');

    // 4. Switching the sale off archives the rule and forgets the id.
    await post('/dashboard/api/promo', {
      headline: 'Fall sale', kind: 'code', code: 'FALL15', starts: today, ends: '', enabled: false,
      deal: { type: 'percent', value: 20, scope: 'products', productIds: ['helmet-band'] },
    }, DASH);
    check('switching it off archives the rule', api.active().length === 0 && api.rules.get(ruleId).archived === true);
    const offRec = JSON.parse(env.PROMO._store.get('current'));
    check('the record forgets the rule', offRec.snipcart.state === 'off' && offRec.snipcart.id === '');
    check('switching it off puts the stock bar back', (await (await get('/')).text()).includes(DEFAULT_ANNOUNCEMENT));

    // 5. A scheduled sale waits; the hourly run puts it up on the day.
    await post('/dashboard/api/promo', {
      headline: 'Weekend sale', kind: 'auto', starts: tomorrow, ends: tomorrow, enabled: true,
      deal: { type: 'amount', value: 10, scope: 'store' },
    }, DASH);
    check('a scheduled sale creates nothing yet', api.active().length === 0);
    const schedRec = JSON.parse(env.PROMO._store.get('current'));
    check('the card says it goes up with the banner', snipcartSentence(schedRec).includes('goes up with the banner'));
    const dayOf = new Date(Date.now() + 86400000);
    dayOf.setUTCHours(16);
    const cronUp = await syncPromo(env, schedRec, dayOf);
    check('the hourly run creates it on the start date', cronUp.changed && api.active().length === 1 &&
      api.active()[0].type === 'FixedAmount' && api.active()[0].amount === 10 && api.active()[0].trigger === 'Total');
    const again = await syncPromo(env, JSON.parse(env.PROMO._store.get('current')), dayOf);
    check('the next hour does nothing', again.changed === false);
    const dayAfter = new Date(dayOf.getTime() + 86400000);
    const cronDown = await syncPromo(env, JSON.parse(env.PROMO._store.get('current')), dayAfter);
    check('the hourly run archives it after the end date', cronDown.changed && api.active().length === 0);
    const cronIdle = await syncPromo(env, JSON.parse(env.PROMO._store.get('current')), dayAfter);
    check('and then leaves it alone', cronIdle.changed === false);

    // 6. A stale record that has forgotten its rule finds it by name.
    const orphan = { id: 'disc_orphan', name: RULE_PREFIX + 'leftover', archived: false, creationDate: '2026-01-01T00:00:00Z',
      trigger: 'Total', type: 'Rate', rate: 5 };
    api.rules.set(orphan.id, orphan);
    const liveNow = buildPromo({ headline: 'Fall sale', kind: 'auto', enabled: true, deal: { type: 'percent', value: 15, scope: 'store' } });
    const healed = await syncPromo(env, liveNow, new Date());
    check('an existing rule of ours is reused, not duplicated',
      healed.snipcart.id === 'disc_orphan' && api.active().length === 1 && api.active()[0].rate === 15);

    // 7. Two of ours live at once: keep one, archive the rest.
    api.rules.set('disc_dupe', { id: 'disc_dupe', name: RULE_PREFIX + 'dupe', archived: false,
      creationDate: '2026-02-01T00:00:00Z', trigger: 'Total', type: 'Rate', rate: 15 });
    const deduped = await syncPromo(env, { ...liveNow, deal: { type: 'percent', value: 25, scope: 'store', productIds: [] } }, new Date());
    check('a duplicate rule is archived, one survives', api.active().length === 1 && deduped.snipcart.state === 'on');

    // 8. Snipcart refusing does not lose the banner.
    api.refuse = 'A discount with this code already exists.';
    const refusedSave = await post('/dashboard/api/promo', {
      headline: 'Taken code', kind: 'code', code: 'TAKEN', starts: '', ends: '', enabled: true,
      deal: { type: 'percent', value: 10, scope: 'store' },
    }, DASH);
    const refusedBody = await refusedSave.json();
    check('the save still succeeds', refusedSave.status === 200 && refusedBody.ok === true);
    check('the refusal is on the record and in the sentence',
      refusedBody.snipcart.error.includes('already exists') && refusedBody.snipcartSentence.startsWith('Snipcart said no'));
    check('the banner is up regardless', (await (await get('/')).text()).includes('Taken code'));
    api.refuse = '';
    const retried = await syncPromo(env, JSON.parse(env.PROMO._store.get('current')), new Date());
    check('the next hour retries and clears the error', retried.snipcart.error === '' && retried.snipcart.state === 'on');

    // 9. Banner only never touches Snipcart, and archives anything of ours.
    const writesBefore = api.writes().length;
    await post('/dashboard/api/promo', {
      headline: 'Free shipping all week', kind: 'auto', starts: '', ends: '', enabled: true, deal: { type: 'none' },
    }, DASH);
    check('banner only archives the live rule and creates nothing',
      api.active().length === 0 && api.writes().slice(writesBefore).every((w) => w.method === 'PUT'));
    check('the bar still shows it', (await (await get('/')).text()).includes('Free shipping all week'));

    // 10. Without the binding or the key, nothing breaks.
    const noKv = { ...env, PROMO: undefined };
    const noKvSave = await worker.fetch(new Request(ORIGIN + '/dashboard/api/promo', {
      method: 'POST', headers: { 'content-type': 'application/json', ...DASH }, body: '{}',
    }), noKv);
    check('without the binding a save says how to set it up', noKvSave.status === 500 && (await noKvSave.json()).error.includes('PROMO'));
    check('without the binding pages still pass through',
      (await worker.fetch(new Request(ORIGIN + '/'), noKv)).status === 200);
    const noKey = await syncPromo({ ...env, SNIPCART_SECRET: '' }, liveNow, new Date());
    check('without a Snipcart key the sync steps aside', noKey.changed === false && noKey.skipped === 'no Snipcart key');
  } finally {
    api.restore();
  }
}
