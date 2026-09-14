/**
 * Product photos: the record, the markup, the seven places a photo lands, the
 * Google feed, and the two routes — driven through the real Worker with KV,
 * R2 and Cloudflare Images stood in for.
 */

import { suite, check, throws } from './harness.mjs';
import { installHTMLRewriterShim } from './html-rewriter-shim.mjs';
import worker from '../index.js';
import {
  productIdFromPath, buildPhotoSet, photosFor, overriddenProducts, idsInRecord,
  galleryHtml, photoUrl, isPhotoKey, withSchemaImage, rewriteFeed, photoRewrites,
  fit, renderPhotosPage, photoScript, MAX_PHOTOS, ALT_MAX,
} from '../photos.js';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);

const photo = (id, over = {}) => ({ id, alt: 'A strap', w: 1600, h: 1200, tw: 400, th: 300, ...over });
const recordOf = (products) => ({ products, updatedAt: '2026-09-14T00:00:00.000Z' });

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

/** R2, as far as photos.js uses it. Records deletes so a test can count them. */
function makeR2() {
  const store = new Map();
  const deleted = [];
  return {
    async put(key, body) { store.set(key, body); },
    async get(key) {
      if (!store.has(key)) return null;
      return { body: store.get(key), httpMetadata: { contentType: 'image/webp' }, httpEtag: '"etag"' };
    },
    async head(key) { return store.has(key) ? { key } : null; },
    async delete(key) { deleted.push(key); store.delete(key); },
    _store: store,
    _deleted: deleted,
  };
}

/**
 * Cloudflare Images. Reports a fixed 2400x1800 original and hands back a
 * marker for each width asked for, so a test can tell the two sizes apart.
 */
function makeImages({ failResize = false } = {}) {
  return {
    async info() { return { format: 'image/png', width: 2400, height: 1800 }; },
    input() {
      let width = 0;
      const chain = {
        transform(opts) { width = opts.width; return chain; },
        output() { return chain; },
        async response() {
          if (failResize) return new Response('no', { status: 500 });
          return new Response(new Uint8Array([87, width & 0xff]), { status: 200 });
        },
      };
      return chain;
    },
  };
}

const PNG = new Uint8Array(64);
PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

const PRODUCT_PAGE = `<!doctype html><html><head>
<meta property="og:image" content="https://rawhidecityleather.com/assets/img/products/helmet-band.jpg">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Helmet Band","image":"https://rawhidecityleather.com/assets/img/products/helmet-band.jpg","offers":{}}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}
</script>
</head><body>
<div class="product-media" data-gallery><img class="product-main-image" data-main src="assets/img/products/helmet-band.webp" alt="old"><div class="product-thumbs"><button class="thumb" data-full="x"></button></div></div>
<form class="order-form" data-order-form data-snipcart-id="helmet-band" data-snipcart-image="/assets/img/products/helmet-band.jpg"></form>
<button hidden class="snipcart-add-item" data-item-id="helmet-band" data-item-image="/assets/img/products/helmet-band.jpg"></button>
</body></html>`;

const SHOP_PAGE = `<!doctype html><html><body><div class="product-grid">
<a href="/product-helmet-band" class="product-card"><div class="product-card-image"><img width="1400" height="1050" src="assets/img/products/helmet-band.webp" alt="Helmet Band"></div></a>
<a href="/product-glove-strap" class="product-card"><div class="product-card-image"><img width="1400" height="1050" src="assets/img/products/glove-strap.webp" alt="Adjustable Glove Strap"></div></a>
</div></body></html>`;

/**
 * The product being changed is deliberately NOT the first item. A feed rewrite
 * that spans from the top of the file to the product it wants will swap the
 * wrong item's pictures, and a fixture with the target at the top cannot tell.
 * That bug reached production once.
 */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
    <item>
      <g:id>fully-custom-radio-strap</g:id>
      <g:title>Fully Custom Radio Strap</g:title>
      <g:image_link>https://rawhidecityleather.com/assets/img/products/fully-custom-radio-strap.jpg</g:image_link>
      <g:additional_image_link>https://rawhidecityleather.com/assets/img/products/fully-custom-radio-strap-2.jpg</g:additional_image_link>
      <g:additional_image_link>https://rawhidecityleather.com/assets/img/products/fully-custom-radio-strap-3.jpg</g:additional_image_link>
      <g:price>165.00 USD</g:price>
    </item>
    <item>
      <g:id>helmet-band</g:id>
      <g:title>Helmet Band</g:title>
      <g:image_link>https://rawhidecityleather.com/assets/img/products/helmet-band.jpg</g:image_link>
      <g:additional_image_link>https://rawhidecityleather.com/assets/img/products/helmet-band-2.jpg</g:additional_image_link>
      <g:additional_image_link>https://rawhidecityleather.com/assets/img/products/helmet-band-3.jpg</g:additional_image_link>
      <g:price>50.00 USD</g:price>
    </item>
    <item>
      <g:id>glove-strap</g:id>
      <g:image_link>https://rawhidecityleather.com/assets/img/products/glove-strap.jpg</g:image_link>
      <g:price>30.00 USD</g:price>
    </item>
</channel></rss>`;

export default async function run() {
  installHTMLRewriterShim();

  suite('photos — which product a page belongs to');

  check('a product page is its product', productIdFromPath('/product-helmet-band') === 'helmet-band');
  check('a hat with a long slug too', productIdFromPath('/product-my-wife-beats-me-hat') === 'my-wife-beats-me-hat');
  check('a page for no product we sell is nothing', productIdFromPath('/product-flamethrower') === '');
  check('the shop is not a product page', productIdFromPath('/shop') === '');
  check('nor is the home page', productIdFromPath('/') === '');
  check('nor a guide that starts the same way', productIdFromPath('/product-page/helmet') === '');

  suite('photos — the record');

  const set = buildPhotoSet({ productId: 'helmet-band', photos: [photo(ID_A), photo(ID_B)] });
  check('a good set comes back with its photos in order',
    set.product === 'helmet-band' && set.photos.map((p) => p.id).join() === `${ID_A},${ID_B}`);

  throws('a product we do not sell is refused',
    () => buildPhotoSet({ productId: 'flamethrower', photos: [] }), 'not a product');
  throws('a photo with a bad id is refused',
    () => buildPhotoSet({ productId: 'helmet-band', photos: [{ id: 'nope' }] }), 'bad id');
  throws('the same photo twice is refused',
    () => buildPhotoSet({ productId: 'helmet-band', photos: [photo(ID_A), photo(ID_A)] }), 'twice');
  throws('more than the page can show is refused',
    () => buildPhotoSet({
      productId: 'helmet-band',
      photos: Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => photo(String(i).padStart(32, '0'))),
    }), 'more than');

  const blank = buildPhotoSet({ productId: 'helmet-band', photos: [photo(ID_A, { alt: '   ' })] });
  check('an empty description falls back to the product name', blank.photos[0].alt === 'Helmet Band');
  const messy = buildPhotoSet({
    productId: 'helmet-band',
    photos: [photo(ID_A, { alt: '  black   band \n on a helmet ' })],
  });
  check('a description is tidied to one line', messy.photos[0].alt === 'black band on a helmet');
  const long = buildPhotoSet({ productId: 'helmet-band', photos: [photo(ID_A, { alt: 'x'.repeat(500) })] });
  check('and cut to a sane length', long.photos[0].alt.length === ALT_MAX);

  const junk = buildPhotoSet({
    productId: 'helmet-band',
    photos: [photo(ID_A, { w: -5, h: 'tall', tw: 0, th: 99999 })],
  });
  check('nonsense dimensions fall back rather than reaching the page',
    junk.photos[0].w === 1600 && junk.photos[0].h === 1600 && junk.photos[0].tw === 400 && junk.photos[0].th === 400);
  check('an empty set is legal — it means the built-in photos',
    buildPhotoSet({ productId: 'helmet-band', photos: [] }).photos.length === 0);

  const record = recordOf({
    'helmet-band': { photos: [photo(ID_A), photo(ID_B)] },
    'glove-strap': { photos: [] },
  });
  check('only products with photos count as overridden',
    overriddenProducts(record).join() === 'helmet-band');
  check('photosFor finds a set', photosFor(record, 'helmet-band').length === 2);
  check('photosFor on an untouched product is empty', photosFor(record, 'chin-strap').length === 0);
  check('every id in the record is found', [...idsInRecord(record)].sort().join() === [ID_A, ID_B].sort().join());
  check('nothing saved is nothing overridden', overriddenProducts(null).length === 0);

  suite('photos — scale-down arithmetic');

  check('a big photo is scaled and the ratio kept',
    JSON.stringify(fit(2400, 1800, 1600)) === JSON.stringify({ w: 1600, h: 1200 }));
  check('a small photo is left alone, never blown up',
    JSON.stringify(fit(900, 600, 1600)) === JSON.stringify({ w: 900, h: 600 }));
  check('a tall photo keeps its height', fit(1000, 4000, 400).h === 1600);
  check('a photo of unknown size falls back to the target', fit(0, 0, 400).w === 400);

  suite('photos — the gallery markup');

  const gallery = galleryHtml([photo(ID_A), photo(ID_B, { alt: 'Second' })]);
  check('the main image is the first photo',
    gallery.includes(`src="/photo/${ID_A}-m.webp"`) && gallery.includes('data-main'));
  check('it carries its real size, so the page does not jump',
    gallery.includes('width="1600"') && gallery.includes('height="1200"'));
  check('the first thumb is the active one', gallery.includes('class="thumb active"'));
  check('a thumb points at the full size and shows the small one',
    gallery.includes(`data-full="/photo/${ID_B}-m.webp"`) && gallery.includes(`src="/photo/${ID_B}-t.webp"`));
  check('each thumb carries its own description', gallery.includes('alt="Second"'));
  check('one photo gets no thumb row', !galleryHtml([photo(ID_A)]).includes('product-thumbs'));
  check('no photos is no markup', galleryHtml([]) === '');

  const nasty = galleryHtml([photo(ID_A, { alt: '"><img src=x onerror=alert(1)>' })]);
  check('a description is text, never markup',
    nasty.includes('&lt;img') && !nasty.includes('<img src=x'));

  suite('photos — the JSON-LD image');

  const productJson = '{"@type":"Product","name":"Helmet Band","image":"https://x/old.jpg","offers":{}}';
  const swapped = withSchemaImage(productJson, 'https://x/new.webp');
  check('the product image is swapped',
    swapped.includes('"image":"https://x/new.webp"') && !swapped.includes('old.jpg'));
  check('the rest of the block is left alone', swapped.includes('"name":"Helmet Band"') && swapped.includes('"offers":{}'));
  check('a breadcrumb block has no image and is untouched',
    withSchemaImage('{"@type":"BreadcrumbList","itemListElement":[]}', 'https://x/new.webp')
      === '{"@type":"BreadcrumbList","itemListElement":[]}');
  check('a list of images is replaced by the one',
    withSchemaImage('{"@type":"Product","image":["a","b"],"x":1}', 'https://x/n.webp')
      === '{"@type":"Product","image":"https://x/n.webp","x":1}');
  check('what comes out is still JSON', (() => {
    JSON.parse(swapped);
    return true;
  })());

  suite('photos — the Google feed');

  const feed = rewriteFeed(FEED, recordOf({ 'helmet-band': { photos: [photo(ID_A), photo(ID_B)] } }),
    'https://rawhidecityleather.com');
  check('the main image link is the new first photo',
    feed.includes(`<g:image_link>https://rawhidecityleather.com/photo/${ID_A}-m.webp</g:image_link>`));
  check('the extra photos become the additional links',
    feed.includes(`<g:additional_image_link>https://rawhidecityleather.com/photo/${ID_B}-m.webp</g:additional_image_link>`));
  check('the old links are gone', !feed.includes('helmet-band-2.jpg') && !feed.includes('helmet-band.jpg'));
  check('the rest of the item is untouched', feed.includes('<g:price>50.00 USD</g:price>') && feed.includes('<g:title>Helmet Band</g:title>'));
  check('a product with no photos here keeps its own', feed.includes('glove-strap.jpg'));
  // The one that shipped broken: the item above the changed one kept nothing.
  check('the item ABOVE it keeps its own main image',
    feed.includes('<g:image_link>https://rawhidecityleather.com/assets/img/products/fully-custom-radio-strap.jpg</g:image_link>'));
  check('and keeps all of its extra images',
    feed.includes('fully-custom-radio-strap-2.jpg') && feed.includes('fully-custom-radio-strap-3.jpg'));
  check('only one item changed at all',
    (feed.match(/\/photo\//g) || []).length === 2);

  const oneShot = rewriteFeed(FEED, recordOf({ 'helmet-band': { photos: [photo(ID_C)] } }),
    'https://rawhidecityleather.com');
  check('fewer photos means fewer additional links',
    !oneShot.includes('helmet-band-2.jpg') && !oneShot.includes('helmet-band-3.jpg'));
  check('and the ones on other products are still there',
    (oneShot.match(/additional_image_link/g) || []).length === 4);
  check('and the one that is left is the new one', oneShot.includes(`${ID_C}-m.webp`));
  check('nothing saved leaves the feed alone', rewriteFeed(FEED, null, 'https://x') === FEED);

  const both = rewriteFeed(FEED, recordOf({
    'fully-custom-radio-strap': { photos: [photo(ID_A)] },
    'glove-strap': { photos: [photo(ID_B)] },
  }), 'https://rawhidecityleather.com');
  check('two products at once each get their own photo',
    both.includes(`<g:id>fully-custom-radio-strap</g:id>`) &&
    /fully-custom-radio-strap<\/g:id>[\s\S]*?aaaa/.test(both) &&
    /glove-strap<\/g:id>[\s\S]*?bbbb/.test(both));
  check('and the one between them is left alone', both.includes('helmet-band.jpg'));

  suite('photos — the places a photo lands');

  const rules = photoRewrites(recordOf({ 'helmet-band': { photos: [photo(ID_A)] } }), {
    product: 'helmet-band', origin: 'https://rawhidecityleather.com',
  });
  const has = (selector) => rules.some((r) => r.selector === selector);
  check('the gallery', has('.product-media'));
  check('the link preview', has('meta[property="og:image"]'));
  check('the structured data', has('script[type="application/ld+json"]'));
  check('the cart thumbnail on the form', has('form[data-order-form]'));
  check('and on the hidden button', has('button.snipcart-add-item'));
  check('the card in the grid', has('a[href="/product-helmet-band"] .product-card-image img'));
  check('every absolute URL is absolute', rules
    .filter((r) => r.name === 'content' || r.name === 'data-snipcart-image')
    .every((r) => r.value.startsWith('https://rawhidecityleather.com/photo/')));

  const gridOnly = photoRewrites(recordOf({ 'helmet-band': { photos: [photo(ID_A)] } }), { product: '' });
  check('a page that is not a product page still gets its cards',
    gridOnly.length === 2 && gridOnly.every((r) => !r.selector.startsWith('.product-media')));
  check('a product with nothing saved gets no rules at all',
    photoRewrites(recordOf({}), { product: 'helmet-band' }).length === 0);

  suite('photos — through the Worker');

  const env = {
    CATALOG: makeKV(),
    PHOTOS: makeR2(),
    IMAGES: makeImages(),
    EXPENSES: null,
    SNIPCART_SECRET: 'test-key-never-used',
    SLIP_USER: 'dev',
    SLIP_PASS: 'dev',
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(req.url).pathname;
        if (p === '/product-helmet-band') {
          return new Response(PRODUCT_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (p === '/shop') {
          return new Response(SHOP_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (p === '/google-merchant-feed.xml') {
          return new Response(FEED, { headers: { 'content-type': 'application/xml' } });
        }
        return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
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

  const upload = (bytes, name = 'strap.png', headers = DASH) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), name);
    return worker.fetch(new Request(ORIGIN + '/dashboard/api/photo-upload', {
      method: 'POST', headers, body: form,
    }), env);
  };

  check('the page needs a login', (await get('/dashboard/products')).status === 401);
  check('saving needs a login', (await post('/dashboard/api/photos', {})).status === 401);
  check('saving needs the dashboard header',
    (await post('/dashboard/api/photos', {}, { Authorization: AUTH })).status === 403);
  check('uploading needs the dashboard header',
    (await upload(PNG, 'x.png', { Authorization: AUTH })).status === 403);

  check('the page renders with nothing saved', (await get('/dashboard/products', { Authorization: AUTH })).status === 200);
  const pageHtml = await (await get('/dashboard/products', { Authorization: AUTH })).text();
  check('it lists every product', pageHtml.includes('Helmet Band') && pageHtml.includes('Leather Butter'));
  check('and says they are all on the built-in photos', pageHtml.includes('all on the built-in photos'));

  const uploaded = await upload(PNG);
  const uploadBody = await uploaded.json();
  check('a photo uploads and comes back with an id',
    uploaded.status === 200 && /^[0-9a-f]{32}$/.test(uploadBody.photo.id));
  check('its size is the scaled-down size, not the original',
    uploadBody.photo.w === 1600 && uploadBody.photo.h === 1200);
  check('the thumb is sized too', uploadBody.photo.tw === 400 && uploadBody.photo.th === 300);
  check('both sizes are in the bucket',
    env.PHOTOS._store.has(`${uploadBody.photo.id}-m.webp`) && env.PHOTOS._store.has(`${uploadBody.photo.id}-t.webp`));

  const notAPhoto = await upload(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0]), 'invoice.pdf');
  check('a PDF is refused', notAPhoto.status === 415 && (await notAPhoto.json()).error.includes('not a photo'));
  const nothing = await upload(new Uint8Array(0), 'empty.png');
  check('an empty file is refused', nothing.status === 400);

  const first = uploadBody.photo;
  const saveRes = await post('/dashboard/api/photos', {
    productId: 'helmet-band',
    photos: [{ ...first, alt: 'Burgundy band on a black helmet' }],
  }, DASH);
  check('the set saves', saveRes.status === 200 && (await saveRes.json()).photos.length === 1);
  check('it landed in KV under the one key', env.CATALOG._store.has('photos'));

  const ghost = await post('/dashboard/api/photos', {
    productId: 'glove-strap', photos: [photo(ID_C)],
  }, DASH);
  check('a photo that is not in the bucket is refused rather than going live',
    ghost.status === 400 && (await ghost.json()).error.includes('not in storage'));

  const live = await (await get('/product-helmet-band')).text();
  check('the product page shows the uploaded photo', live.includes(`/photo/${first.id}-m.webp`));
  check('the built-in photo is gone from the gallery', !live.includes('products/helmet-band.webp'));
  check('the description reached the page', live.includes('alt="Burgundy band on a black helmet"'));
  check('the link preview points at it',
    live.includes(`content="https://rawhidecityleather.com/photo/${first.id}-m.webp"`));
  check('so does the structured data', live.includes(`"image":"https://rawhidecityleather.com/photo/${first.id}-m.webp"`));
  check('the breadcrumb block still parses', (() => {
    const blocks = [...live.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    return blocks.length === 2 && blocks.every((b) => JSON.parse(b[1].trim()));
  })());
  check('the cart thumbnail follows', live.includes(`data-snipcart-image="https://rawhidecityleather.com/photo/${first.id}-m.webp"`));

  const shop = await (await get('/shop')).text();
  check('the card in the grid shows it', shop.includes(`src="/photo/${first.id}-m.webp"`));
  check('and carries the new size', shop.includes('width="1600"'));
  check('a product with nothing saved keeps its card', shop.includes('products/glove-strap.webp'));

  const xml = await (await get('/google-merchant-feed.xml')).text();
  check('the Google feed points at it too', xml.includes(`/photo/${first.id}-m.webp`));
  check('and the untouched product is still itself', xml.includes('glove-strap.jpg'));

  const image = await get(`/photo/${first.id}-m.webp`);
  check('the image serves to anyone, no login', image.status === 200);
  check('and is cached hard, because a key never changes meaning',
    image.headers.get('cache-control') === 'public, max-age=31536000, immutable');
  check('a made-up key is a 404', (await get('/photo/' + 'f'.repeat(32) + '-m.webp')).status === 404);
  check('so is a key of the wrong shape', (await get('/photo/../secret')).status === 404);

  const reset = await post('/dashboard/api/photos', { productId: 'helmet-band', photos: [] }, DASH);
  check('resetting to the built-in photos saves', reset.status === 200);
  const back = await (await get('/product-helmet-band')).text();
  check('the page is back on the repo photo', back.includes('products/helmet-band.webp'));
  check('the bytes are deleted, both sizes',
    env.PHOTOS._deleted.includes(`${first.id}-m.webp`) && env.PHOTOS._deleted.includes(`${first.id}-t.webp`));
  check('the feed is back too', !(await (await get('/google-merchant-feed.xml')).text()).includes('/photo/'));

  suite('photos — when the plumbing is missing');

  const bare = { ...env, CATALOG: null, PHOTOS: null };
  const bareGet = (path, headers = {}) => worker.fetch(new Request(ORIGIN + path, { headers }), bare);
  check('a storefront page is served as the repo has it',
    (await (await bareGet('/product-helmet-band')).text()).includes('products/helmet-band.webp'));
  check('the dashboard page says how to set it up',
    (await (await bareGet('/dashboard/products', { Authorization: AUTH })).text()).includes('is not set up'));
  const bareSave = await worker.fetch(new Request(ORIGIN + '/dashboard/api/photos', {
    method: 'POST', headers: { 'content-type': 'application/json', ...DASH },
    body: JSON.stringify({ productId: 'helmet-band', photos: [] }),
  }), bare);
  check('and saving says the same rather than pretending it worked',
    bareSave.status === 500 && (await bareSave.json()).error.includes('not set up'));

  const broken = { ...env, CATALOG: { async get() { throw new Error('KV is down'); } } };
  check('a KV outage serves the page rather than an error',
    (await (await worker.fetch(new Request(ORIGIN + '/product-helmet-band'), broken)).text())
      .includes('products/helmet-band.webp'));

  const noImages = { ...env, IMAGES: null };
  const noImagesUp = await worker.fetch(new Request(ORIGIN + '/dashboard/api/photo-upload', {
    method: 'POST', headers: DASH, body: (() => {
      const f = new FormData();
      f.append('file', new Blob([PNG], { type: 'image/png' }), 'x.png');
      return f;
    })(),
  }), noImages);
  check('without the Images binding an upload says so', noImagesUp.status === 500);

  suite('photos — the dashboard page');

  const withRecord = recordOf({ 'helmet-band': { photos: [photo(ID_A), photo(ID_B)] } });
  const html = renderPhotosPage(withRecord, { ready: true });
  check('it counts what is overridden', html.includes('1 with photos from here'));
  check('the row shows how many', html.includes('2 photos'));
  check('the row previews the saved photo', html.includes(`/photo/${ID_A}-t.webp`));
  check('an untouched product previews its repo photo', html.includes('/assets/img/products/glove-strap.webp'));
  check('it warns about what Google reads in a photo', html.includes('Google reads the words printed in a photo'));
  check('a missing binding is explained, not hidden',
    renderPhotosPage(null, { ready: false }).includes('not set up'));

  const script = photoScript(withRecord);
  check('the script carries the record', script.includes(ID_A) && !script.includes('__STATE__'));
  check('and every placeholder is filled',
    !script.includes('__NAMES__') && !script.includes('__MAX__') && !script.includes('__ALTMAX__'));
  check('product names reach it', script.includes('Helmet Band'));

  suite('photos — keys');

  check('a main key is a key', isPhotoKey(`${ID_A}-m.webp`));
  check('a thumb key is a key', isPhotoKey(`${ID_A}-t.webp`));
  check('a third size is not', !isPhotoKey(`${ID_A}-x.webp`));
  check('a path is not a key', !isPhotoKey('../../etc/passwd'));
  check('nor a short id', !isPhotoKey('abc-m.webp'));
  check('the url builder agrees with it', isPhotoKey(photoUrl(ID_A).slice('/photo/'.length)));
}
