/**
 * The Worker's routes, driven through its real fetch handler.
 *
 * A KV shim stands in for the QUOTES namespace and a stub stands in for the
 * asset router, so this covers auth, the quote API and the public quote page
 * without Cloudflare or a Snipcart key. Anything that calls Snipcart itself
 * (the dashboard, the packing slip) is out of reach here — slip.test.mjs
 * covers that rendering from a fixture instead.
 */

import { suite, check } from './harness.mjs';
import worker from '../index.js';
import { CHECKOUT_DISCOUNT } from '../quote.js';

/** get/put/list with metadata — the three things quote.js actually uses. */
function makeKV() {
  const store = new Map();
  return {
    async put(key, value, opts = {}) {
      store.set(key, { value, metadata: opts.metadata || null });
    },
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, limit)
        .map(([name, rec]) => ({ name, metadata: rec.metadata }));
      return { keys, list_complete: true };
    },
    _store: store,
  };
}

const REAL_FILES = ['/shop.html', '/index.html', '/assets/css/style.css'];

export default async function run() {
  const env = {
    QUOTES: makeKV(),
    SNIPCART_SECRET: 'test-key-never-used',
    SLIP_USER: 'dev',
    SLIP_PASS: 'dev',
    // Mirrors not_found_handling in wrangler.jsonc: real files 200, else 404.
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(req.url).pathname;
        const real = REAL_FILES.includes(p);
        return new Response(real ? 'asset' : 'the 404 page', {
          status: real ? 200 : 404,
          headers: { 'x-served-by': 'assets' },
        });
      },
    },
  };

  const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
  const DASH = { Authorization: AUTH, 'x-rawhide-dashboard': '1' };
  const ORIGIN = 'https://rawhidecityleather.com';

  const get = (path, headers = {}) =>
    worker.fetch(new Request(ORIGIN + path, { headers }), env);

  const post = (path, body, headers = {}) =>
    worker.fetch(new Request(ORIGIN + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }), env);

  suite('worker — auth');

  check('dashboard demands a login', (await get('/dashboard')).status === 401);
  check('quote API demands a login', (await post('/dashboard/api/quote', {})).status === 401);
  check('a wrong password is refused', (await get('/dashboard', {
    Authorization: 'Basic ' + Buffer.from('dev:wrong').toString('base64'),
  })).status === 401);

  // Browsers attach Basic credentials to cross-site form posts on their own, so
  // being logged in is not proof the dashboard sent the request.
  check('a logged-in POST without the dashboard header is refused',
    (await post('/dashboard/api/quote', {}, { Authorization: AUTH })).status === 403);
  check('static assets still fall through', (await get('/shop.html')).status === 200);

  suite('worker — creating a quote');

  const created = await post('/dashboard/api/quote', {
    title: '12 Memorial Radio Straps — Station 4',
    customer: 'Lt. Dana Reyes',
    department: 'Lakeland Fire Department',
    expiryDays: 30,
    lines: [{ description: 'Fully custom radio strap', quantity: 12, unitPrice: 150 }],
  }, DASH);
  const quote = await created.json();

  check('quote is created', created.status === 200 && quote.ok === true);
  check('response carries the crew-facing total', quote.total === 1800);
  check('button price collects exactly the quoted total',
    Math.round(quote.listPrice * (1 - CHECKOUT_DISCOUNT) * 100) / 100 === 1800,
    `button=${quote.listPrice} rate=${CHECKOUT_DISCOUNT}`);
  check('link is on the live domain', quote.url === ORIGIN + '/quote/' + quote.id, quote.url);

  const bad = await post('/dashboard/api/quote', { title: 'x', customer: 'y', lines: [] }, DASH);
  check('a bad quote returns 400 with the reason',
    bad.status === 400 && (await bad.json()).error.includes('line item'));

  suite('worker — storage');

  const listed = await env.QUOTES.list({ prefix: 'quote:' });
  check('stored under its own key', listed.keys[0]?.name === 'quote:' + quote.id);
  check('summary rides along in KV metadata', listed.keys[0]?.metadata?.total === 1800);
  check('metadata stays under KV\'s 1 KB cap',
    JSON.stringify(listed.keys[0]?.metadata).length < 1024,
    JSON.stringify(listed.keys[0]?.metadata).length + ' bytes');

  suite('worker — the public quote page');

  const pageRes = await get('/quote/' + quote.id);
  const html = await pageRes.text();

  check('is public, no login', pageRes.status === 200);
  check('is noindex', (pageRes.headers.get('x-robots-tag') || '').includes('noindex'));
  check('is not cached', pageRes.headers.get('cache-control') === 'no-store');
  check('the crawler can find the button', html.includes('snipcart-add-item'));
  check('the price matches what the cart will hold',
    html.includes(`data-item-price="${quote.listPrice.toFixed(2)}"`),
    `button=${quote.listPrice}`);
  check('the crew sees the quoted number', html.includes('$1,800.00'));

  check('a made-up id is a 404', (await get('/quote/notarealquoteid')).status === 404);
  check('an id with junk in it is a 404', (await get('/quote/NOT-a-valid-id!')).status === 404);

  // The URL parser collapses ../ before the Worker sees it, so this lands on
  // /dashboard — which must still demand a login rather than leak anything.
  check('path traversal cannot reach the dashboard unauthenticated',
    (await get('/quote/../dashboard')).status === 401);

  const bare = await get('/quote/');
  check('bare /quote belongs to the asset router',
    bare.headers.get('x-served-by') === 'assets' && bare.status === 404);

  suite('worker — voiding');

  check('void succeeds', (await post('/dashboard/api/quote/void', { id: quote.id }, DASH)).status === 200);

  const afterVoid = await get('/quote/' + quote.id);
  // 410 is deliberate: Snipcart treats a non-2xx as a failed price check, so a
  // voided link cannot be paid even from a checkout tab left open.
  check('a voided quote returns 410 so checkout fails', afterVoid.status === 410);
  check('the voided page drops the buy button', !(await afterVoid.text()).includes('snipcart-add-item'));
  check('voiding an unknown quote is a 404',
    (await post('/dashboard/api/quote/void', { id: 'zzzzzzzzzzzz' }, DASH)).status === 404);

  suite('worker — tax-exempt quote, end to end');

  const exemptRes = await post('/dashboard/api/quote', {
    title: 'Station 4 promotion set', customer: 'Chief Alvarez',
    taxExempt: true,
    exemptEntity: 'City of Lakeland Fire Department',
    exemptCertNumber: '85-8012345678C-9',
    exemptExpires: '2027-12-31',
    lines: [{ description: 'Helmet band, stamped', quantity: 6, unitPrice: 50 }],
  }, DASH);
  const exempt = await exemptRes.json();
  const exemptHtml = await (await get('/quote/' + exempt.id)).text();

  check('exempt quote is created', exemptRes.status === 200 && exempt.total === 300);
  check('checkout is told not to tax it', exemptHtml.includes('data-item-taxable="false"'));
  check('the certificate prints on the quote', exemptHtml.includes('85-8012345678C-9'));

  check('exempt with no certificate number is refused',
    (await post('/dashboard/api/quote', {
      title: 'x', customer: 'y', taxExempt: true, exemptEntity: 'Dept',
      lines: [{ description: 'd', quantity: 1, unitPrice: 5 }],
    }, DASH)).status === 400);

  suite('worker — a cash job, end to end');

  const cashRes = await post('/dashboard/api/quote', {
    title: '12 Memorial Radio Straps', customer: 'Lt. Dana Reyes',
    payment: 'cash', taxRatePercent: '7',
    lines: [{ description: 'Fully custom radio strap', quantity: 12, unitPrice: 150 }],
  }, DASH);
  const cash = await cashRes.json();

  check('cash quote is created', cashRes.status === 200 && cash.payment === 'cash');
  check('the response carries what gets collected', cash.grandTotal === 1926, `grand=${cash.grandTotal}`);

  const cashPage = await (await get('/quote/' + cash.id)).text();
  check('the crew page has nothing to click', !cashPage.includes('snipcart-add-item'));
  check('and does not load a cart at all', !/snipcart/i.test(cashPage));

  suite('worker — the printable sheet');

  check('the sheet demands a login', (await get('/dashboard/quote-print?id=' + cash.id)).status === 401);

  const sheetRes = await get('/dashboard/quote-print?id=' + cash.id, { Authorization: AUTH });
  const sheetHtml = await sheetRes.text();
  check('the sheet prints', sheetRes.status === 200);
  check('a cash job prints as an invoice', sheetHtml.includes('<h1>Invoice</h1>'));
  check('with the figure to collect', sheetHtml.includes('$1,926.00'));
  check('a made-up id is a 404',
    (await get('/dashboard/quote-print?id=notarealquoteid', { Authorization: AUTH })).status === 404);
  check('an id with junk in it is a 404',
    (await get('/dashboard/quote-print?id=NOT-valid!', { Authorization: AUTH })).status === 404);
  check('no id at all is a 404',
    (await get('/dashboard/quote-print', { Authorization: AUTH })).status === 404);

  suite('worker — marking a cash job paid');

  check('the stamp demands a login',
    (await post('/dashboard/api/quote/paid', { id: cash.id })).status === 401);
  check('and the dashboard header, like every other write',
    (await post('/dashboard/api/quote/paid', { id: cash.id }, { Authorization: AUTH })).status === 403);

  const stamped = await post('/dashboard/api/quote/paid', { id: cash.id, method: 'check' }, DASH);
  check('the stamp lands', stamped.status === 200);
  check('it records what the money came in as',
    (await stamped.json()).paidMethod === 'check');

  const paidSheet = await (await get('/dashboard/quote-print?id=' + cash.id, { Authorization: AUTH })).text();
  check('the sheet becomes a receipt', paidSheet.includes('<h1>Receipt</h1>'));

  const paidPage = await get('/quote/' + cash.id);
  check('the crew page says it is settled', (await paidPage.text()).includes('has been paid'));

  check('stamping it twice is refused',
    (await post('/dashboard/api/quote/paid', { id: cash.id }, DASH)).status === 409);
  check('stamping an unknown quote is a 404',
    (await post('/dashboard/api/quote/paid', { id: 'zzzzzzzzzzzz' }, DASH)).status === 404);

  // A card quote gets stamped by the webhook when the order lands. A hand
  // stamp on one would mark it paid with nothing in the till behind it.
  const cardJob = await (await post('/dashboard/api/quote', {
    title: 'Card job', customer: 'Cpt. Vance',
    lines: [{ description: 'Strap', quantity: 1, unitPrice: 165 }],
  }, DASH)).json();
  check('a card quote cannot be stamped by hand',
    (await post('/dashboard/api/quote/paid', { id: cardJob.id }, DASH)).status === 409);

  suite('worker — www to apex');

  const WWW = 'https://www.rawhidecityleather.com';
  const fromWww = (path, init) => worker.fetch(new Request(WWW + path, init), env);

  const wwwHome = await fromWww('/');
  check('the www home page 301s to the apex',
    wwwHome.status === 301 && wwwHome.headers.get('location') === ORIGIN + '/',
    `${wwwHome.status} → ${wwwHome.headers.get('location')}`);

  const wwwPage = await fromWww('/product-fully-custom-radio-strap');
  check('the path is preserved',
    wwwPage.headers.get('location') === ORIGIN + '/product-fully-custom-radio-strap');

  const wwwQuery = await fromWww('/shop?sort=price');
  check('the query string survives',
    wwwQuery.headers.get('location') === ORIGIN + '/shop?sort=price');

  // The old Wix URLs were indexed on www, and they are the site's most
  // valuable inbound links. Host and product mapping collapse into one hop so
  // there is no redirect chain between Google and the live page.
  const wwwLegacy = await fromWww('/product-page/custom-radio-strap');
  check('an old Wix URL on www reaches the product page in one hop',
    wwwLegacy.status === 301 &&
    wwwLegacy.headers.get('location') === ORIGIN + '/product-fully-custom-radio-strap',
    `${wwwLegacy.status} → ${wwwLegacy.headers.get('location')}`);

  const wwwLegacyUnknown = await fromWww('/product-page/never-mapped');
  check('an unmapped old URL on www lands on /shop in one hop',
    wwwLegacyUnknown.headers.get('location') === ORIGIN + '/shop');

  const wwwLegacySlash = await fromWww('/product-page/custom-radio-strap/');
  check('trailing slash still collapses in one hop',
    wwwLegacySlash.headers.get('location') === ORIGIN + '/product-fully-custom-radio-strap');

  // A Wix query string means nothing to the new pages, and this is the one
  // place the redirect deliberately drops it rather than passing it through.
  const wwwLegacyQuery = await fromWww('/product-page/custom-radio-strap?variant=7');
  check('the Wix query string is dropped on the product mapping',
    wwwLegacyQuery.headers.get('location') === ORIGIN + '/product-fully-custom-radio-strap');

  const wwwPost = await fromWww('/dashboard/api/quote', {
    method: 'POST', headers: DASH, body: '{}',
  });
  check('a POST gets a 308, so the method survives the hop',
    wwwPost.status === 308, String(wwwPost.status));

  // The stub only 200s the paths in REAL_FILES, so use one of those.
  const apexPage = await get('/shop.html');
  check('the apex is left alone',
    apexPage.status === 200 && apexPage.headers.get('x-served-by') === 'assets');

  suite('worker — legacy Wix product URLs');

  const known = await get('/product-page/custom-radio-strap');
  check('a known old URL 301s to its product page',
    known.status === 301 &&
    known.headers.get('location') === ORIGIN + '/product-fully-custom-radio-strap',
    `${known.status} → ${known.headers.get('location')}`);

  const unknown = await get('/product-page/something-we-never-mapped');
  check('an unmapped old URL 301s to /shop',
    unknown.status === 301 && unknown.headers.get('location') === ORIGIN + '/shop',
    `${unknown.status} → ${unknown.headers.get('location')}`);

  // Wix linked some products with a trailing slash; fetch() normalises the
  // path before matching, so both shapes have to land on the same page.
  const trailing = await get('/product-page/custom-radio-strap/');
  check('a trailing slash lands on the same page',
    trailing.headers.get('location') === ORIGIN + '/product-fully-custom-radio-strap');

  const mixedCase = await get('/product-page/Custom-Radio-Strap');
  check('slug matching ignores case',
    mixedCase.headers.get('location') === ORIGIN + '/product-fully-custom-radio-strap');

  const noSlug = await get('/product-page');
  check('the bare /product-page 301s to /shop',
    noSlug.status === 301 && noSlug.headers.get('location') === ORIGIN + '/shop');

  // 301 is permanent and browsers cache it hard. If this ever fires on a live
  // product URL, that page becomes unreachable until the cache expires.
  const live = await get('/shop.html');
  check('real pages are untouched',
    live.status === 200 && live.headers.get('x-served-by') === 'assets');

  suite('worker — webhook');

  // Token first, method second: an unauthenticated probe should learn nothing
  // about this endpoint, not even which verbs it takes.
  const unvalidated = await worker.fetch(new Request(ORIGIN + '/dashboard/hooks/snipcart', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Snipcart-RequestToken': 'made-up' },
    body: JSON.stringify({ eventName: 'order.completed', content: {} }),
  }), env);
  check('an unvalidated request token is refused', unvalidated.status === 401);
}
