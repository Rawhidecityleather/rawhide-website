/**
 * Products the shop added itself: the record, the page that gets built for
 * them, the card in the grid, the feed, the sitemap, and both routes — driven
 * through the real Worker with KV, R2 and Cloudflare Images stood in for.
 *
 * The donor page is read off disk rather than faked, because the whole page is
 * built by rewriting it. A test against a fixture would still pass the day
 * somebody changes product-leather-butter.html and the real one stops working.
 */

import { readFileSync } from 'node:fs';
import { suite, check, throws } from './harness.mjs';
import { installHTMLRewriterShim } from './html-rewriter-shim.mjs';
import worker from '../index.js';
import {
  buildCustomProduct, CustomProductError, slugify, cleanPrice, priceLabel,
  customProducts, customIds, liveCustomProducts, withCustomProduct, withoutCustomProduct,
  customPhotoIds, buyButtonHtml, orderFormHtml, cardHtml, feedItemXml, feedReady,
  sitemapEntry, pageRules, mainHtml, productSchema, FIELDS_MAX,
} from '../custom-product.js';
import {
  catalogRules, applyRules, rewriteFeed, rewriteSitemap, allPhotoIds,
  extraSaleProducts, customIdFromPath, productIdFromPath,
} from '../catalog.js';
import { buildPromo } from '../promo.js';

const DONOR = readFileSync(new URL('../../product-leather-butter.html', import.meta.url), 'utf8');

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);

const photo = (id) => ({ id, alt: 'On the bench', w: 1600, h: 1200, tw: 400, th: 300 });

/** A complete, publishable product, so a test can change one thing about it. */
const input = (over = {}) => ({
  name: 'Shop Apron',
  price: '95',
  category: 'accessories',
  summary: 'A full-grain leather shop apron cut for a bench.',
  description: 'Cut from the same hide as the belts.\n\nStraps cross at the back.',
  details: ['Full-grain leather', '1–3 week lead time'],
  feed: 'Full-grain leather shop apron, cut and riveted in our shop.',
  photos: [photo(ID_A)],
  published: true,
  inFeed: true,
  ...over,
});

const build = (over = {}, opts = {}) => buildCustomProduct(input(over), opts);

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

function makeR2() {
  const store = new Map();
  const deleted = [];
  return {
    async put(key, body) { store.set(key, body); },
    async get(key) {
      if (!store.has(key)) return null;
      return { body: store.get(key), httpMetadata: { contentType: 'image/webp' }, httpEtag: '"e"' };
    },
    async head(key) { return store.has(key) ? { key } : null; },
    async delete(key) { deleted.push(key); store.delete(key); },
    _store: store,
    _deleted: deleted,
  };
}

const SHOP_PAGE = `<!doctype html><html><body><main>
<section id="radio-straps" class="category-section"><h2>Radio Straps</h2><div class="product-grid">
<a href="/product-basic-radio-strap" class="product-card"><div class="product-card-image"><img src="x.webp" alt="Basic"></div></a>
</div></section>
<section id="belts" class="category-section"><h2>Belts</h2><div class="product-grid">
<a href="/product-heavy-duty-belt" class="product-card"><div class="product-card-image"><img src="y.webp" alt="Belt"></div></a>
</div></section>
<section id="accessories" class="category-section"><h2>Accessories</h2><div class="product-grid">
<a href="/product-chin-strap" class="product-card"><div class="product-card-image"><img src="z.webp" alt="Chin"></div></a>
</div></section>
</main></body></html>`;

const HATS_PAGE = `<!doctype html><html><body><main>
<section class="category-section"><h2>Shop Hats</h2><div class="product-grid">
<a href="/product-leather-patch-hat" class="product-card"><div class="product-card-image"><img src="h.webp" alt="Hat"></div></a>
</div></section>
<section class="category-section"><h2>What You Get</h2><div class="product-grid"></div></section>
</main></body></html>`;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
    <item>
      <g:id>chin-strap</g:id>
      <g:title>Chin Strap</g:title>
      <g:image_link>https://rawhidecityleather.com/assets/img/products/chin-strap.jpg</g:image_link>
      <g:price>35.00 USD</g:price>
    </item>
  </channel></rss>`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://rawhidecityleather.com/shop</loc><lastmod>2026-08-27</lastmod></url>
</urlset>`;

export default async function run() {
  installHTMLRewriterShim();

  /* ------------------------------------------------------------------ model */

  suite('added products — the address');

  check('a name becomes a web address', slugify('Shop Apron') === 'shop-apron');
  check('punctuation and apostrophes go', slugify("Fireman's 2\" Belt!") === 'firemans-2-belt');
  check('accents come down to letters', slugify('Café Strap') === 'cafe-strap');
  check('a name with nothing usable in it makes nothing', slugify('!!! ???') === '');
  check('an address is made from the name when none is given', build().id === 'shop-apron');
  check('a typed address wins over the name', build({ id: 'bench-apron' }).id === 'bench-apron');

  throws('a name with no letters is refused',
    () => build({ name: '!!!', id: '' }), 'name');
  throws('an address already in the repo is refused',
    () => build({ id: 'leather-butter' }, { taken: new Set(['leather-butter']) }), 'already taken');
  check('a typed address is cleaned up rather than refused',
    buildCustomProduct({ ...input(), id: 'Shop Apron' }).id === 'shop-apron');

  const made = build();
  const edited = buildCustomProduct({ ...input({ name: 'Bench Apron', id: 'something-else' }) },
    { existing: made });
  check('editing never moves the address', edited.id === 'shop-apron');
  check('editing keeps the day it was created', edited.createdAt === made.createdAt);
  check('but the name can change', edited.name === 'Bench Apron');

  suite('added products — the price');

  check('a whole number gets its cents', cleanPrice('95') === '95.00');
  check('a dollar sign and spaces come off', cleanPrice(' $95.50 ') === '95.50');
  throws('words are not a price', () => cleanPrice('ninety five'), 'number');
  throws('nothing is not a price', () => cleanPrice('0'), 'more than nothing');
  throws('a runaway number is refused', () => cleanPrice('9500'), 'decimal point');
  check('the card says the price', priceLabel(build()) === '$95.00');
  check('and says "From" once an option can add to it',
    priceLabel(build({ fields: [{ label: 'Stitch', choices: 'None\nWhite +10.00' }] })) === 'From $95.00');

  suite('added products — what a draft may leave out, and a listing may not');

  check('a draft can be almost empty',
    buildCustomProduct({ name: 'Half an idea', price: '5', category: 'accessories' }).published === false);
  throws('going on the site needs a photo',
    () => build({ photos: [] }), 'photo');
  throws('and needs something said about it',
    () => build({ description: '', details: [] }), 'Say something');
  check('a draft with neither is fine',
    buildCustomProduct(input({ published: false, photos: [], description: '', details: [] })).id === 'shop-apron');

  suite('added products — the dropdowns');

  const withFields = build({
    fields: [
      { label: 'Leather Color', required: true, choices: 'Black\nChestnut\nBrown -- out of stock' },
      { label: 'Stitch Color', required: false, choices: 'No stitching\nWhite +10.00\nRed +10.00' },
    ],
  });

  check('a label becomes a form field name',
    withFields.fields[0].name === 'leathercolor' && withFields.fields[1].name === 'stitchcolor');
  check('the label is what the cart and the packing slip show',
    withFields.fields[0].snipcartName === 'Leather Color');
  check('an unpriced list is not marked priced', withFields.fields[0].priced === false);
  check('a list with money in it is', withFields.fields[1].priced === true);
  check('an out-of-stock choice keeps its reason',
    withFields.fields[0].choices[2].note === 'out of stock');

  const twice = build({
    fields: [
      { label: 'Colour', choices: 'Black' },
      { label: 'Colour', choices: 'Brass' },
    ],
  });
  check('two dropdowns with the same label still get different names',
    twice.fields[0].name !== twice.fields[1].name);

  check('an empty dropdown row is dropped rather than refused',
    build({ fields: [{ label: '', choices: '' }] }).fields.length === 0);
  throws('a dropdown with a label and no choices is refused',
    () => build({ fields: [{ label: 'Leather', choices: '' }] }), 'no choices');
  throws('a dropdown where nothing can be picked is refused',
    () => build({ fields: [{ label: 'Leather', choices: 'Black -- out of stock' }] }), 'pickable');
  throws('more dropdowns than a form should carry is refused',
    () => build({
      fields: Array.from({ length: FIELDS_MAX + 1 }, (_, i) => ({ label: 'F' + i, choices: 'One' })),
    }), 'dropdowns');

  suite('added products — the form and the buy button agree');

  const form = orderFormHtml(withFields);
  const button = buyButtonHtml(withFields);

  check('a required dropdown makes the customer choose',
    form.includes('<option value="" disabled selected hidden>Select...</option>'));
  // The numbering on the hidden button is positional, and the cart script
  // rebuilds it from the fields that came back filled in. A dropdown that can
  // arrive blank shifts every field after it, and the upcharge lands on
  // somebody else's option.
  check('an optional dropdown has no blank row to come back empty',
    (form.match(/<option value=""/g) || []).length === 1);
  check('and opens on its first choice',
    form.includes('<option value="No stitching" selected>'));

  const names = [...button.matchAll(/data-item-custom(\d+)-name="([^"]*)"/g)].map((m) => m[2]);
  const labels = [...form.matchAll(/data-label="([^"]*)"/g)].map((m) => m[1]);
  check('the button lists the fields in the order the form shows them',
    names.join('|') === labels.join('|'));

  const priced = build({
    fields: [{ label: 'Stitch Color', choices: 'No stitching\nWhite +10.00' }],
    notes: true,
  });
  const pricedForm = orderFormHtml(priced);
  const pricedButton = buyButtonHtml(priced);
  check('a priced list reaches the dropdown',
    pricedForm.includes('data-options="No stitching|White[+10.00]"'));
  check('and Snipcart’s own copy on the button',
    pricedButton.includes('data-item-custom1-options="No stitching|White[+10.00]"'));
  check('an unpriced list carries no data-options on the button',
    !buyButtonHtml(build({ fields: [{ label: 'Leather', choices: 'Black\nBrown' }] }))
      .includes('-options='));
  check('the notes box is last, because it is the one allowed to be empty',
    pricedButton.includes('data-item-custom2-name="Notes"')
    && pricedButton.includes('data-item-custom2-type="textarea"'));
  check('the buy button points at an address with no .html on it',
    pricedButton.includes('data-item-url="/product-shop-apron"'));

  suite('added products — the record');

  const record = withCustomProduct(null, made);
  check('a product goes in', customProducts(record).length === 1);
  check('and can be found by id', customIds(record).has('shop-apron'));
  check('its photos count toward the sweep', customPhotoIds(record).has(ID_A));
  check('a draft is not live',
    liveCustomProducts(withCustomProduct(null, buildCustomProduct(
      input({ published: false })))).length === 0);
  check('deleting takes it back out',
    customProducts(withoutCustomProduct(record, 'shop-apron')).length === 0);
  check('the repo half is left alone by both',
    withCustomProduct({ products: { 'helmet-band': { photos: [photo(ID_B)] } } }, made)
      .products['helmet-band'].photos.length === 1);

  // The bug this is here for: a sweep that only walked one half of the record
  // would delete the other half's pictures the next time anything was saved.
  const both = withCustomProduct({ products: { 'helmet-band': { photos: [photo(ID_B)] } } }, made);
  check('the sweep list holds both halves',
    allPhotoIds(both).has(ID_A) && allPhotoIds(both).has(ID_B));

  check('a sale can be pointed at one that is live',
    extraSaleProducts(record)[0][0] === 'shop-apron');
  check('but not at a draft',
    extraSaleProducts(withCustomProduct(null, buildCustomProduct(input({ published: false })))).length === 0);
  check('and the sale form takes it',
    buildPromo({
      headline: 'Apron sale', deal: { type: 'percent', value: 10, scope: 'products', productIds: ['shop-apron'] },
    }, new Date(), extraSaleProducts(record)).deal.productIds[0] === 'shop-apron');
  throws('while an unknown id is still refused',
    () => buildPromo({
      headline: 'x', deal: { type: 'percent', value: 10, scope: 'products', productIds: ['shop-apron'] },
    }), 'at least one');

  suite('added products — which page an address belongs to');

  check('a repo product is still a repo product', productIdFromPath('/product-leather-butter') === 'leather-butter');
  check('an added one is not read as one', productIdFromPath('/product-shop-apron') === '');
  check('but is found in the record', customIdFromPath('/product-shop-apron', record) === 'shop-apron');
  check('a repo id never resolves to an added product',
    customIdFromPath('/product-leather-butter', record) === '');
  check('an address for nothing at all is nothing',
    customIdFromPath('/product-flamethrower', record) === '');

  /* ------------------------------------------------------------ the markup */

  suite('added products — the page');

  const built = await applyRules(
    new Response(DONOR, { headers: { 'content-type': 'text/html' } }),
    pageRules(made, { origin: 'https://rawhidecityleather.com' })
  );
  const html = await built.text();

  check('the title is the product', html.includes('<title>Shop Apron · Rawhide City Leather</title>'));
  check('the canonical points at its own address',
    html.includes('<link rel="canonical" href="https://rawhidecityleather.com/product-shop-apron">'));
  check('the search summary is the one that was typed',
    html.includes('content="A full-grain leather shop apron cut for a bench."'));
  check('og:image is the uploaded photo',
    html.includes(`content="https://rawhidecityleather.com/photo/${ID_A}-m.webp"`));
  check('the heading is the name', html.includes('<h1>Shop Apron</h1>'));
  check('the price is on the page', html.includes('<p class="product-price">$95.00</p>'));
  check('the wording became paragraphs',
    html.includes('<p>Cut from the same hide as the belts.</p>'));
  check('the bullets became a list', html.includes('<li>Full-grain leather</li>'));
  check('the buy button is the product’s', html.includes('data-item-id="shop-apron"'));
  check('the structured data is the product’s',
    html.includes('"name":"Shop Apron"') && html.includes('"price":"95.00"'));
  check('and so is the breadcrumb',
    html.includes('"item":"https://rawhidecityleather.com/product-shop-apron"'));

  // The donor is a real page with a real product on it. Anything of its own
  // still showing is something the rewrite missed.
  check('nothing of the donor is left in the body', !html.includes('leather-butter'));
  check('nor its name', !html.includes('Leather Butter'));
  check('nor its price', !html.includes('$8.00'));
  check('the chrome it was borrowed for is still there',
    html.includes('class="site-footer"') && html.includes('cdn.snipcart.com')
    && html.includes('class="site-header"'));
  check('a published product is left to be indexed', !html.includes('name="robots"'));

  const draft = await applyRules(
    new Response(DONOR, { headers: { 'content-type': 'text/html' } }),
    pageRules(buildCustomProduct(input({ published: false })), {})
  );
  check('a draft tells Google to skip it',
    (await draft.text()).includes('<meta name="robots" content="noindex">'));

  check('a product with no notes box has no textarea on its form',
    !mainHtml(made).includes('<textarea'));
  check('the not-PPE line is there unless it is turned off',
    mainHtml(made).includes('Use Disclaimer')
    && !mainHtml(build({ disclaimer: false })).includes('Use Disclaimer'));
  check('a description with a closing script tag cannot end the block early',
    !productSchema(build({ summary: 'One</script><script>alert(1)</script>' })).includes('</script>'));

  suite('added products — the card in the grid');

  check('the card links to the page and carries the photo',
    cardHtml(made).includes('href="/product-shop-apron"')
    && cardHtml(made).includes(`/photo/${ID_A}-m.webp`));
  check('a product with no photo has no card', cardHtml(build({ photos: [], published: false })) === '');

  const shop = await applyRules(
    new Response(SHOP_PAGE, { headers: { 'content-type': 'text/html' } }),
    catalogRules(record, { path: '/shop' })
  );
  const shopHtml = await shop.text();
  check('the card lands in the section it was filed under',
    /id="accessories"[\s\S]*?product-shop-apron/.test(shopHtml));
  check('and not in another one',
    !/id="belts"[\s\S]*?product-shop-apron[\s\S]*?<\/section>\s*<section id="accessories"/.test(shopHtml));
  check('the cards already there are untouched', shopHtml.includes('/product-chin-strap'));

  const hatRecord = withCustomProduct(null, build({ name: 'Wildland Hat', category: 'hats' }));
  const hats = await applyRules(
    new Response(HATS_PAGE, { headers: { 'content-type': 'text/html' } }),
    catalogRules(hatRecord, { path: '/hats' })
  );
  const hatsHtml = await hats.text();
  check('a hat lands on the hats page',
    hatsHtml.includes('/product-wildland-hat'));
  check('in the first grid only, not every grid on the page',
    (hatsHtml.match(/product-wildland-hat/g) || []).length === 1);

  const elsewhere = await applyRules(
    new Response(SHOP_PAGE, { headers: { 'content-type': 'text/html' } }),
    catalogRules(record, { path: '/about' })
  );
  check('a page with no grid for it gets nothing',
    !(await elsewhere.text()).includes('product-shop-apron'));
  check('a draft gets no card anywhere',
    catalogRules(withCustomProduct(null, buildCustomProduct(input({ published: false }))),
      { path: '/shop' }).length === 0);

  suite('added products — the feed and the sitemap');

  const item = feedItemXml(made, { origin: 'https://rawhidecityleather.com' });
  check('the item carries the id the orders use', item.includes('<g:id>shop-apron</g:id>'));
  check('the price is in the shape Google wants', item.includes('<g:price>95.00 USD</g:price>'));
  check('the accessory category is the one the chin strap is in',
    item.includes('<g:google_product_category>2047</g:google_product_category>'));
  check('handling time is the lead time in days',
    item.includes('<g:min_handling_time>7</g:min_handling_time>'));
  check('a radio strap gets the six-week handling time',
    feedItemXml(build({ category: 'radio-straps' })).includes('<g:max_handling_time>30</g:max_handling_time>'));
  // Item-level shipping overrides the account settings, which is where the
  // free-over-$85 rule lives.
  check('no shipping block, ever', !item.includes('<g:shipping>'));

  check('a published product that is not in the feed stays out',
    feedReady(build({ inFeed: false })) === false);
  check('and so does a draft', feedReady(buildCustomProduct(input({ published: false }))) === false);
  check('one with nothing said about it stays out too',
    feedReady(build({ feed: '', summary: '' })) === false);

  const feed = rewriteFeed(FEED, record, 'https://rawhidecityleather.com');
  check('the item is added before the channel closes',
    feed.indexOf('<g:id>shop-apron</g:id>') < feed.indexOf('</channel>'));
  check('the item already in the file is left alone',
    feed.includes('<g:id>chin-strap</g:id>') && feed.includes('chin-strap.jpg'));
  check('a record with nothing in it leaves the feed exactly as it was',
    rewriteFeed(FEED, { products: {} }, 'https://rawhidecityleather.com') === FEED);
  check('the added item is indented like the ones already in the file',
    feed.includes('\n    <item>\n      <g:id>shop-apron'));
  check('every item still opens and closes',
    (feed.match(/<item>/g) || []).length === (feed.match(/<\/item>/g) || []).length);

  const map = rewriteSitemap(SITEMAP, record, 'https://rawhidecityleather.com');
  check('the page is in the sitemap',
    map.includes('<loc>https://rawhidecityleather.com/product-shop-apron</loc>'));
  check('with the day it last changed', /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemapEntry(made)));
  check('a draft is left out of it',
    !rewriteSitemap(SITEMAP, withCustomProduct(null, buildCustomProduct(input({ published: false }))),
      'https://rawhidecityleather.com').includes('shop-apron'));

  /* ----------------------------------------------------------- the Worker */

  suite('added products — through the Worker');

  const env = {
    CATALOG: makeKV(),
    PHOTOS: makeR2(),
    IMAGES: null,
    EXPENSES: null,
    SNIPCART_SECRET: 'test-key-never-used',
    SLIP_USER: 'dev',
    SLIP_PASS: 'dev',
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(req.url).pathname;
        const html = (body) => new Response(body, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
        if (p === '/product-leather-butter') return html(DONOR);
        if (p === '/shop') return html(SHOP_PAGE);
        if (p === '/google-merchant-feed.xml') {
          return new Response(FEED, { headers: { 'content-type': 'application/xml' } });
        }
        if (p === '/sitemap.xml') {
          return new Response(SITEMAP, { headers: { 'content-type': 'application/xml' } });
        }
        return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
      },
    },
  };

  const ORIGIN = 'https://rawhidecityleather.com';
  const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
  const DASH = { Authorization: AUTH, 'x-rawhide-dashboard': '1' };
  const get = (path, headers = {}) => worker.fetch(new Request(ORIGIN + path, { headers }), env);
  const post = (path, body, headers = DASH) => worker.fetch(new Request(ORIGIN + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), env);

  // Both photos are in the bucket before anything points at them, the way an
  // upload would have put them there.
  for (const id of [ID_A, ID_B, ID_C]) {
    await env.PHOTOS.put(`${id}-m.webp`, new Uint8Array([1]));
    await env.PHOTOS.put(`${id}-t.webp`, new Uint8Array([1]));
  }

  check('adding a product needs a login',
    (await post('/dashboard/api/product-new', {}, {})).status === 401);
  check('and the dashboard header',
    (await post('/dashboard/api/product-new', {}, { Authorization: AUTH })).status === 403);
  check('deleting needs both too',
    (await post('/dashboard/api/product-delete', {}, { Authorization: AUTH })).status === 403);

  check('the page renders with nothing added',
    (await get('/dashboard/products', { Authorization: AUTH })).status === 200);
  check('and offers the form',
    (await (await get('/dashboard/products', { Authorization: AUTH })).text()).includes('Add a product'));

  check('the address a dead Wix URL still holds is refused',
    (await (await post('/dashboard/api/product-new', input({ id: 'page' }))).json())
      .error.includes('already taken'));
  check('an address a repo page already answers to is refused',
    (await (await post('/dashboard/api/product-new', input({ id: 'leather-butter' }))).json())
      .error.includes('already taken'));
  check('a photo that is not in storage is refused',
    (await (await post('/dashboard/api/product-new',
      input({ photos: [photo('f'.repeat(32))] }))).json()).error.includes('not in storage'));

  const created = await (await post('/dashboard/api/product-new', input())).json();
  check('a product is created', created.ok === true && created.created === true);
  check('at the address made from its name', created.product.id === 'shop-apron');

  const page = await get('/product-shop-apron');
  check('its page answers', page.status === 200);
  const pageHtml = await page.text();
  check('with the product on it',
    pageHtml.includes('<h1>Shop Apron</h1>') && pageHtml.includes('data-item-id="shop-apron"'));
  check('and none of the page it was built from', !pageHtml.includes('Leather Butter'));
  check('an address for nothing still 404s', (await get('/product-flamethrower')).status === 404);

  check('the card is in the shop grid',
    (await (await get('/shop')).text()).includes('/product-shop-apron'));
  check('the item is in the feed',
    (await (await get('/google-merchant-feed.xml')).text()).includes('<g:id>shop-apron</g:id>'));
  check('the page is in the sitemap',
    (await (await get('/sitemap.xml')).text()).includes('/product-shop-apron</loc>'));

  const saved = await (await post('/dashboard/api/product-new', {
    ...input({ name: 'Bench Apron', price: '105', inFeed: false }),
    productId: 'shop-apron',
  })).json();
  check('an edit saves without creating a second one', saved.created === false);
  check('and keeps the address', saved.product.id === 'shop-apron');
  check('the page shows the new price',
    (await (await get('/product-shop-apron')).text()).includes('$105.00'));
  check('unticking the feed takes the item back out',
    !(await (await get('/google-merchant-feed.xml')).text()).includes('<g:id>shop-apron</g:id>'));
  check('while the page and the card stay',
    (await (await get('/shop')).text()).includes('/product-shop-apron'));

  // The sweep bug: saving a repo product must not take an added product's
  // photographs down with it.
  await post('/dashboard/api/photos', {
    productId: 'helmet-band',
    photos: [{ id: ID_B, alt: 'A band', w: 1400, h: 1050, tw: 400, th: 300 }],
    copy: {},
    options: {},
  });
  check('saving a repo product leaves an added product’s photos alone',
    env.PHOTOS._deleted.length === 0);
  check('and the added product still has its picture',
    (await (await get('/product-shop-apron')).text()).includes(`/photo/${ID_A}-m.webp`));

  const gone = await post('/dashboard/api/product-delete', { productId: 'shop-apron' });
  check('deleting works', gone.status === 200);
  check('the page stops answering', (await get('/product-shop-apron')).status === 404);
  check('the card comes off the grid',
    !(await (await get('/shop')).text()).includes('/product-shop-apron'));
  check('the line comes out of the sitemap',
    !(await (await get('/sitemap.xml')).text()).includes('/product-shop-apron'));
  check('its photos are deleted out of the bucket',
    env.PHOTOS._deleted.includes(`${ID_A}-m.webp`) && env.PHOTOS._deleted.includes(`${ID_A}-t.webp`));
  check('and the repo product’s are not',
    !env.PHOTOS._deleted.includes(`${ID_B}-m.webp`));
  check('deleting it twice says so, rather than pretending',
    (await post('/dashboard/api/product-delete', { productId: 'shop-apron' })).status === 404);
}
