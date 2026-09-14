/**
 * Product photos, changed from the dashboard instead of from the repo.
 *
 * Every product page in this repo has its photos typed into it — a main image,
 * a row of thumbs, an og:image, a JSON-LD image, a Snipcart cart thumbnail, a
 * card in the shop grid, and a block of image links in the Google feed. Seven
 * places for one photograph. Swapping a picture meant editing all seven, making
 * a .webp and a thumbnail by hand, and deploying.
 *
 * So the photos move into one record, the same way the sale banner did:
 *
 *   - the shop uploads a photo on /dashboard/products; Cloudflare Images makes
 *     the full-size WebP and the thumbnail, and both go into the PHOTOS bucket;
 *   - one record in CATALOG KV says which photos a product has, in what order;
 *   - the Worker rewrites all seven places on the way out, for that product.
 *
 * Nothing here needs a deploy, and nothing here is required. A product with no
 * record is served exactly as it sits in the repo — that is the fallback, and
 * "Use the built-in photos" on the card puts a product back to it. The repo
 * photos are never deleted or touched.
 *
 * Routes (wired in index.js)
 *   GET  /photo/<key>                     PUBLIC — storefront images.
 *   GET  /dashboard/products              the page.
 *   POST /dashboard/api/photo-upload      one file in, one photo back.
 *   POST /dashboard/api/photos            save one product's set.
 *
 * Bindings:
 *   CATALOG — KV. One record, key `photos`, holding every product's set.
 *   PHOTOS  — R2 bucket `rawhide-product-photos`, the image bytes.
 *   IMAGES  — Cloudflare Images, already bound. Makes the two sizes.
 */

import { esc, json } from './lib.js';
import { PRODUCTS } from './promo.js';
import { renderRail } from './dashboard.js';
import { detect } from './uploads.js';

export const PHOTOS_KEY = 'photos';

/** A phone photo of a strap on a tailgate runs 3-8 MB. This is headroom. */
export const MAX_BYTES = 12 * 1024 * 1024;

/** The longest gallery in the repo is 11 thumbs, on the fully custom strap. */
export const MAX_PHOTOS = 14;

export const ALT_MAX = 180;

/** What the main image is scaled down to. The repo's own are 1400-1600 wide. */
const MAIN_WIDTH = 1600;
/** What a thumb is scaled down to. The repo's thumbs are 300-400 wide. */
const THUMB_WIDTH = 400;
const QUALITY = 82;

const PRODUCT_NAME = new Map(PRODUCTS);
const PRODUCT_IDS = new Set(PRODUCTS.map(([id]) => id));

export class PhotoError extends Error {}

/* ------------------------------------------------------------------ model */

/**
 * The product a storefront path belongs to, or ''. Every product page in the
 * repo is `product-<snipcart id>.html`, and the ids in promo.js are those same
 * ids — one catalogue, so a new product cannot be half-added.
 */
export function productIdFromPath(path) {
  const match = /^\/product-([a-z0-9-]+)$/.exec(String(path || ''));
  if (!match) return '';
  return PRODUCT_IDS.has(match[1]) ? match[1] : '';
}

export function productName(id) {
  return PRODUCT_NAME.get(id) || id;
}

/** `/photo/<32 hex>-m.webp` — 'm' is the full size, 't' the thumbnail. */
export function photoUrl(id, size = 'm') {
  return `/photo/${id}-${size === 't' ? 't' : 'm'}.webp`;
}

export function isPhotoKey(key) {
  return /^[0-9a-f]{32}-[mt]\.webp$/.test(String(key || ''));
}

function newId() {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  let hex = '';
  for (const byte of raw) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * One photo, cleaned. Anything the dashboard sends is re-checked here: the id
 * shape, the dimensions, and the alt text. Dimensions matter beyond tidiness —
 * they are the width and height attributes that stop the page jumping while
 * the image loads.
 */
function cleanPhoto(input, product) {
  const id = String(input?.id || '');
  if (!/^[0-9a-f]{32}$/.test(id)) throw new PhotoError('That photo has a bad id. Upload it again.');

  const size = (name, fallback) => {
    const n = Math.round(Number(input?.[name]));
    return Number.isFinite(n) && n > 0 && n <= 20000 ? n : fallback;
  };

  const alt = String(input?.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, ALT_MAX);

  return {
    id,
    // Falling back to the product name is deliberate. An empty alt on a product
    // photo is a hole in the page for anyone using a screen reader, and the
    // name is a poor description but never a wrong one.
    alt: alt || productName(product),
    w: size('w', MAIN_WIDTH),
    h: size('h', MAIN_WIDTH),
    tw: size('tw', THUMB_WIDTH),
    th: size('th', THUMB_WIDTH),
  };
}

/**
 * Turns the dashboard form into one product's set, or throws a PhotoError the
 * page can show. An empty list is legal and means the same as no record at
 * all — use the repo's photos — so the caller drops the key instead of
 * storing an empty product.
 */
export function buildPhotoSet(body = {}) {
  const product = String(body.productId || '');
  if (!PRODUCT_IDS.has(product)) throw new PhotoError('That is not a product.');

  const list = Array.isArray(body.photos) ? body.photos : [];
  if (list.length > MAX_PHOTOS) {
    throw new PhotoError(`That is more than ${MAX_PHOTOS} photos. The page cannot show them all.`);
  }

  const photos = list.map((p) => cleanPhoto(p, product));

  const seen = new Set();
  for (const p of photos) {
    if (seen.has(p.id)) throw new PhotoError('The same photo is in there twice.');
    seen.add(p.id);
  }

  return { product, photos };
}

/** Every photo id the whole record points at, for finding what R2 can drop. */
export function idsInRecord(record) {
  const out = new Set();
  for (const set of Object.values(record?.products || {})) {
    for (const photo of set?.photos || []) out.add(photo.id);
  }
  return out;
}

export function photosFor(record, product) {
  const set = record?.products?.[product];
  return Array.isArray(set?.photos) ? set.photos : [];
}

/** Which products the record actually overrides. Drives every rewrite below. */
export function overriddenProducts(record) {
  return Object.keys(record?.products || {}).filter((id) => photosFor(record, id).length);
}

/* --------------------------------------------------------------------- KV */

/**
 * Never throws. This runs on every storefront page, and a KV hiccup must not
 * take a product page down with it — a page with the repo's photos on it beats
 * no page. The 60 second cache is KV's floor, and it is why a new photo takes
 * up to a minute to reach every page.
 */
export async function getPhotoRecord(env) {
  if (!env.CATALOG) return null;
  try {
    return await env.CATALOG.get(PHOTOS_KEY, { type: 'json', cacheTtl: 60 });
  } catch {
    return null;
  }
}

export async function putPhotoRecord(env, record) {
  await env.CATALOG.put(PHOTOS_KEY, JSON.stringify(record));
}

/* ------------------------------------------------------------- the markup */

/**
 * The inside of `.product-media` — the main image and the row of thumbs, in
 * the same shape the repo's pages use, so assets/js/main.js drives it without
 * knowing anything changed: `[data-main]` is the big one, `.thumb[data-full]`
 * swaps it, and the thumb's own alt rides along to the main image on click.
 *
 * One photo gets no thumb row. A single thumbnail under a picture of itself is
 * a button that does nothing.
 */
export function galleryHtml(photos) {
  if (!photos.length) return '';
  const [first] = photos;

  const main = `<img width="${first.w}" height="${first.h}" class="product-main-image" data-main ` +
    `fetchpriority="high" src="${esc(photoUrl(first.id))}" alt="${esc(first.alt)}" ` +
    `onerror="this.style.opacity=.15">`;

  if (photos.length === 1) return main;

  const thumbs = photos.map((p, i) =>
    `<button type="button" class="thumb${i === 0 ? ' active' : ''}" data-full="${esc(photoUrl(p.id))}">` +
    `<img width="${p.tw}" height="${p.th}" loading="lazy" src="${esc(photoUrl(p.id, 't'))}" ` +
    `alt="${esc(p.alt)}" onerror="this.parentElement.style.display='none'"></button>`
  ).join('');

  return `${main}<div class="product-thumbs">${thumbs}</div>`;
}

/**
 * The absolute URL for the places that need one: og:image, JSON-LD, the Google
 * feed. A relative path is fine in an `<img src>` and wrong in all three.
 */
export function absolutePhotoUrl(origin, id, size = 'm') {
  return new URL(photoUrl(id, size), origin).toString();
}

/**
 * Swaps the "image" value in a product's JSON-LD without parsing and
 * re-serialising the block — a round trip through JSON.parse would reformat
 * markup that is fine as it is, and would throw away anything it did not
 * understand. Only the Product block has an image; the breadcrumb block has
 * none and comes back untouched.
 *
 * The URL we substitute is one we built ourselves out of hex, so it carries
 * nothing that needs escaping inside a script element.
 */
export function withSchemaImage(text, url) {
  if (!/"@type"\s*:\s*"Product"/.test(text)) return text;
  return text.replace(/"image"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])/, `"image":${JSON.stringify(url)}`);
}

/**
 * The Google Merchant feed. It is XML served straight off disk, so this is a
 * string swap rather than a rewriter: inside the `<item>` whose `<g:id>`
 * matches, the main image link becomes the new first photo and the additional
 * links become the rest.
 *
 * Feed images matter for more than tidiness. Merchant Center re-reviews a
 * product when its image URL changes, and it reads the words printed in the
 * photograph — the glove strap was disapproved once for a blueprint sheet
 * sitting in the frame.
 */
export function rewriteFeed(xml, record, origin) {
  const products = overriddenProducts(record);
  if (!products.length) return xml;
  const wanted = new Map(products.map((id) => [id, photosFor(record, id)]));

  // Item by item, each one found on its own terms. Reaching for the product's
  // id first and taking the block around it reads tidier and is wrong: that
  // span runs from the FIRST item in the feed to the one being changed, so the
  // image links it swaps belong to whatever product sits at the top. It
  // shipped that way once — the helmet band's photo landed on the fully custom
  // radio strap and took its six other pictures with it.
  return xml.replace(/<item>[\s\S]*?<\/item>/g, (block) => {
    const id = /<g:id>([^<]*)<\/g:id>/.exec(block)?.[1];
    const photos = id ? wanted.get(id) : null;
    if (!photos || !photos.length) return block;

    // Google takes ten additional images and ignores the rest. A feed that
    // claims something Google drops is a feed nobody can check against the site.
    const links =
      `<g:image_link>${absolutePhotoUrl(origin, photos[0].id)}</g:image_link>` +
      photos.slice(1, 11).map((p) =>
        `\n      <g:additional_image_link>${absolutePhotoUrl(origin, p.id)}</g:additional_image_link>`
      ).join('');

    // The whole run of image lines goes at once, so the count can move up or
    // down. There is one run per item, so this replaces once and stops.
    return block.replace(
      /<g:image_link>[\s\S]*?<\/g:image_link>(?:\s*<g:additional_image_link>[\s\S]*?<\/g:additional_image_link>)*/,
      links
    );
  });
}

/* -------------------------------------------------------------- storefront */

/**
 * Every place a product's photo appears in a page, as plain data: a selector,
 * what to do, and the value. Built as a list rather than written straight into
 * HTMLRewriter calls so the tests can read what a page is about to get without
 * needing a parser — the sale banner learned that lesson the other way round.
 *
 * `product` is the page's own product when it is a product page, and '' on the
 * shop and category grids, which carry cards for several products at once.
 */
export function photoRewrites(record, { product = '', origin = 'https://rawhidecityleather.com' } = {}) {
  const rules = [];

  if (product) {
    const photos = photosFor(record, product);
    if (photos.length) {
      const [first] = photos;
      const absolute = absolutePhotoUrl(origin, first.id);

      rules.push({ selector: '.product-media', action: 'inner', value: galleryHtml(photos) });
      rules.push({ selector: 'meta[property="og:image"]', action: 'attr', name: 'content', value: absolute });
      rules.push({ selector: 'meta[name="twitter:image"]', action: 'attr', name: 'content', value: absolute });
      rules.push({ selector: 'script[type="application/ld+json"]', action: 'schema', value: absolute });
      // The cart thumbnail, in both places a page carries it: the form the
      // customer fills in, and the hidden button it drives.
      rules.push({ selector: 'form[data-order-form]', action: 'attr', name: 'data-snipcart-image', value: absolute });
      rules.push({ selector: 'button.snipcart-add-item', action: 'attr', name: 'data-item-image', value: absolute });
    }
  }

  // The grids. A card is an <a> to the product, on the shop page, the category
  // pages and the home page alike, so one selector covers all of them. The
  // card's own alt text is a product name in the repo and stays that way —
  // replacing it with the photo's alt would repeat a sentence in a place that
  // reads better as a label.
  for (const id of overriddenProducts(record)) {
    const [first] = photosFor(record, id);
    rules.push({
      selector: `a[href="/product-${id}"] .product-card-image img`,
      action: 'card',
      value: photoUrl(first.id),
      w: first.w,
      h: first.h,
    });
    rules.push({
      selector: `form[data-card-buy][data-snipcart-id="${id}"]`,
      action: 'attr',
      name: 'data-snipcart-image',
      value: absolutePhotoUrl(origin, first.id),
    });
  }

  return rules;
}

/**
 * Applies those rules with HTMLRewriter. Deliberately the only part of this
 * file that knows the rewriter exists: everything it needs was decided above,
 * where it can be tested.
 *
 * HTMLRewriter is a Workers global. Outside the runtime the page goes back as
 * it came, which is what the Node preview and the tests see.
 */
export function applyPhotos(response, rules) {
  if (typeof HTMLRewriter === 'undefined' || !rules.length) return response;

  let rewriter = new HTMLRewriter();

  for (const rule of rules) {
    if (rule.action === 'inner') {
      rewriter = rewriter.on(rule.selector, {
        element(el) { el.setInnerContent(rule.value, { html: true }); },
      });
    } else if (rule.action === 'attr') {
      rewriter = rewriter.on(rule.selector, {
        element(el) { el.setAttribute(rule.name, rule.value); },
      });
    } else if (rule.action === 'card') {
      rewriter = rewriter.on(rule.selector, {
        element(el) {
          el.setAttribute('src', rule.value);
          el.setAttribute('width', String(rule.w));
          el.setAttribute('height', String(rule.h));
          // A repo card may carry a srcset the new photo has no sizes for.
          el.removeAttribute('srcset');
        },
      });
    } else if (rule.action === 'schema') {
      // Text arrives in chunks, so the block is gathered and swapped at the end
      // of it. Two ld+json blocks share this handler, and the parser hands them
      // over one after the other, never interleaved.
      let buffer = '';
      rewriter = rewriter.on(rule.selector, {
        text(chunk) {
          buffer += chunk.text;
          if (!chunk.lastInTextNode) {
            chunk.remove();
            return;
          }
          chunk.replace(withSchemaImage(buffer, rule.value), { html: true });
          buffer = '';
        },
      });
    }
  }

  return rewriter.transform(response);
}

/**
 * The storefront hook. Only touches a 200 to a GET, and only when the record
 * actually overrides something, so a 404, a stylesheet, a page with no products
 * on it, or a shop that has never uploaded anything all pass straight through.
 */
export async function withProductPhotos(response, request, env) {
  if (request.method !== 'GET' || response.status !== 200) return response;
  const type = response.headers.get('content-type') || '';
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const isFeed = path === '/google-merchant-feed.xml';
  if (!type.includes('text/html') && !isFeed) return response;

  const record = await getPhotoRecord(env);
  if (!overriddenProducts(record).length) return response;

  if (isFeed) {
    const xml = await response.text();
    return new Response(rewriteFeed(xml, record, url.origin), {
      status: response.status,
      headers: response.headers,
    });
  }

  return applyPhotos(response, photoRewrites(record, {
    product: productIdFromPath(path),
    origin: url.origin,
  }));
}

/* ----------------------------------------------------------------- upload */

/**
 * One uploaded file becomes two WebPs: the full size the gallery shows, and
 * the thumbnail under it. Cloudflare Images does the work, which is also what
 * lets the shop send a photo straight off a phone — a HEIC is decoded on the
 * way in, the same as it is for a receipt.
 *
 * Both are scale-down, never up: a photo smaller than the target is left at its
 * own size rather than blown up into mush.
 */
export async function handlePhotoUpload(request, env) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!env.PHOTOS) {
    return json({ error: 'Photo storage is not set up. Add the PHOTOS R2 binding — see the README.' }, 500);
  }
  if (!env.IMAGES) {
    return json({ error: 'The Images binding is missing, so the two sizes cannot be made.' }, 500);
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BYTES + 4096) return json({ error: 'That photo is too big. Keep it under 12 MB.' }, 413);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Could not read that upload.' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'No file was attached.' }, 400);
  }
  if (!file.size) return json({ error: 'That file is empty.' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'That photo is too big. Keep it under 12 MB.' }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detect(bytes.slice(0, 16));
  if (!kind || kind.ext === 'pdf') {
    return json({ error: 'That is not a photo. Send a JPG, PNG, WEBP, GIF or HEIC.' }, 415);
  }

  let info = null;
  try {
    info = await env.IMAGES.info(blobStream(bytes, kind.mime));
  } catch (err) {
    console.error('photo info failed', err?.message || err);
  }
  if (!info || !info.width || !info.height) {
    return json({ error: 'That image could not be read. Re-save it and upload it again.' }, 415);
  }

  const main = fit(info.width, info.height, MAIN_WIDTH);
  const thumb = fit(info.width, info.height, THUMB_WIDTH);

  let mainBytes = null;
  let thumbBytes = null;
  try {
    [mainBytes, thumbBytes] = await Promise.all([
      resize(env, bytes, kind.mime, MAIN_WIDTH),
      resize(env, bytes, kind.mime, THUMB_WIDTH),
    ]);
  } catch (err) {
    console.error('photo resize failed', err?.message || err);
  }
  if (!mainBytes || !thumbBytes) {
    return json({ error: 'That photo could not be converted. Try saving it as a JPG.' }, 502);
  }

  const id = newId();
  const meta = { uploaded: new Date().toISOString() };
  await Promise.all([
    env.PHOTOS.put(`${id}-m.webp`, mainBytes, {
      httpMetadata: { contentType: 'image/webp' }, customMetadata: meta,
    }),
    env.PHOTOS.put(`${id}-t.webp`, thumbBytes, {
      httpMetadata: { contentType: 'image/webp' }, customMetadata: meta,
    }),
  ]);

  return json({
    ok: true,
    photo: { id, alt: '', w: main.w, h: main.h, tw: thumb.w, th: thumb.h },
    url: photoUrl(id),
    thumbUrl: photoUrl(id, 't'),
  });
}

/** Scale-down arithmetic, so the width and height attributes are the truth. */
export function fit(width, height, target) {
  if (!width || !height) return { w: target, h: target };
  if (width <= target) return { w: width, h: height };
  return { w: target, h: Math.max(1, Math.round((height * target) / width)) };
}

function blobStream(bytes, type) {
  return new Blob([bytes], { type }).stream();
}

async function resize(env, bytes, mime, width) {
  const result = await env.IMAGES
    .input(blobStream(bytes, mime))
    .transform({ width, fit: 'scale-down' })
    .output({ format: 'image/webp', quality: QUALITY })
    .response();
  if (!result.ok) return null;
  const out = new Uint8Array(await result.arrayBuffer());
  return out.length ? out : null;
}

/** Deleting a photo's bytes. Both sizes, and never a key of another shape. */
export async function deletePhoto(env, id) {
  if (!env.PHOTOS || !/^[0-9a-f]{32}$/.test(String(id || ''))) return;
  await Promise.all([
    env.PHOTOS.delete(`${id}-m.webp`),
    env.PHOTOS.delete(`${id}-t.webp`),
  ]);
}

/**
 * Serving is public and cached hard. These are storefront images — the same
 * bytes a visitor pulls off /assets — and a key never points at anything else,
 * because a changed photo gets a new id rather than overwriting an old one.
 * That is what makes `immutable` safe to promise.
 */
export async function handlePhotoFetch(path, env) {
  const key = path.slice('/photo/'.length);
  if (!env.PHOTOS || !isPhotoKey(key)) return new Response('Not found.', { status: 404 });

  const object = await env.PHOTOS.get(key);
  if (!object) return new Response('Not found.', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      etag: object.httpEtag,
    },
  });
}

/* -------------------------------------------------------------- dashboard */

/** The repo's own main photo for a product. Every one of them is `<id>.webp`. */
export function builtInPhoto(id) {
  return `/assets/img/products/${id}.webp`;
}

function statusOf(photos) {
  if (!photos.length) return { pill: 'done', label: 'Built-in', note: 'Showing the photos in the repo.' };
  return {
    pill: 'good',
    label: `${photos.length} photo${photos.length === 1 ? '' : 's'}`,
    note: 'Showing photos uploaded here.',
  };
}

/**
 * One row per product, collapsed. The row says what the site is showing right
 * now and opens into the editor for it — fourteen editors stacked open is a
 * page nobody can find anything on.
 */
function renderRow(id, record) {
  const photos = photosFor(record, id);
  const status = statusOf(photos);
  const preview = photos.length ? photoUrl(photos[0].id, 't') : builtInPhoto(id);

  return `<section class="prow" data-row="${esc(id)}">
    <button type="button" class="prowhead" data-toggle="${esc(id)}" aria-expanded="false">
      <span class="prowthumb"><img src="${esc(preview)}" alt="" loading="lazy" onerror="this.style.opacity=0"></span>
      <span class="prowname">${esc(productName(id))}</span>
      <span class="pill ${status.pill}" data-pill="${esc(id)}">${esc(status.label)}</span>
      <span class="soft prownote" data-note="${esc(id)}">${esc(status.note)}</span>
      <span class="prowchev" aria-hidden="true">&rsaquo;</span>
    </button>
    <div class="prowbody" data-body="${esc(id)}" hidden>
      <div class="pstrip" data-strip="${esc(id)}"></div>
      <p class="hint pempty" data-empty="${esc(id)}">
        No photos uploaded for this one. The page is showing what is in the repo.
        Add one below and it takes over &mdash; every photo, not just the first,
        so upload the whole set you want the page to have.
      </p>
      <div class="pactions">
        <label class="btn ghost pfile">
          Add photos
          <input type="file" accept="image/*" multiple data-add="${esc(id)}" hidden>
        </label>
        <button type="button" class="btn" data-save="${esc(id)}">Save</button>
        <button type="button" class="btn ghost" data-reset="${esc(id)}">Use the built-in photos</button>
        <a class="btn ghost" href="/product-${esc(id)}" target="_blank" rel="noopener">Open the page &nearr;</a>
        <span class="soft" data-said="${esc(id)}"></span>
      </div>
    </div>
  </section>`;
}

/**
 * `ready` is whether both bindings exist. Without them the page says how to
 * finish the setup rather than offering an upload button that cannot store
 * anything — the same shape the sale banner uses.
 */
export function renderPhotosPage(record, { ready = true, railCounts = {} } = {}) {
  const overridden = overriddenProducts(record).length;
  const rows = PRODUCTS.map(([id]) => renderRow(id, record)).join('');
  const saved = record?.updatedAt
    ? 'Last changed ' + new Date(record.updatedAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
      })
    : 'Nothing changed here yet';

  return `<div class="shell">
  ${renderRail({ ...railCounts, active: 'products' })}
  <main class="main">
    <header class="topbar">
      <div class="topleft">
        <h1>Products</h1>
        <p class="sub">Photos &middot; ${PRODUCTS.length} products &middot; ${
          overridden ? `${overridden} with photos from here` : 'all on the built-in photos'
        }</p>
      </div>
      <div class="topright">
        <span class="soft">${esc(saved)}</span>
      </div>
    </header>
    <div class="pad">
      ${ready ? '' : `<p class="banner">
        Photo storage is not set up. Create the KV namespace and the R2 bucket and add the
        <code>CATALOG</code> and <code>PHOTOS</code> bindings to <code>wrangler.jsonc</code>
        &mdash; see the README. Nothing uploads or saves until then.
      </p>`}

      <section class="card">
        <div class="cardhead">
          <h2>Product photos</h2>
          <span class="cardnote">what the site shows, without a deploy</span>
        </div>
        <p class="hint">
          Upload a photo here and it replaces the built-in one everywhere that product
          appears: the product page gallery, the card in the shop grid, the cart
          thumbnail, the link preview when someone shares it, and the Google
          Shopping feed. The photo at the front of the row is the main one. Changes
          reach the site within a minute.
        </p>
        <p class="hint">
          <b>Google reads the words printed in a photo.</b> A worksheet, a price list
          or a brand name in the frame can get the product disapproved in Merchant
          Center &mdash; that is what happened to the glove strap. Changing a photo
          also sends that product back for review.
        </p>
        <p class="hint">
          Photos off a phone are fine, up to 12 MB each. The full size and the
          thumbnail are made here; there is nothing to resize first.
        </p>
        <div class="plist">${rows}</div>
      </section>
    </div>
  </main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`;
}

export const PHOTO_STYLES = `
.plist{display:flex;flex-direction:column;gap:8px;margin-top:16px}
.prow{border:1px solid var(--line);border-radius:3px;background:var(--paper);overflow:hidden}
.prow.open{border-color:var(--ink)}
.prowhead{display:flex;align-items:center;gap:12px;width:100%;padding:10px 14px;border:0;
  background:none;text-align:left;cursor:pointer;font:inherit;color:inherit}
.prowhead:hover{background:var(--hover,rgba(0,0,0,.03))}
.prowthumb{flex:none;width:44px;height:44px;border:1px solid var(--line);border-radius:2px;
  overflow:hidden;background:#EBE8E1}
.prowthumb img{width:100%;height:100%;object-fit:cover;display:block}
.prowname{flex:none;min-width:210px;font-weight:600;font-size:13.5px}
.prownote{flex:1;font-size:12.5px}
.prowchev{flex:none;font-size:20px;line-height:1;transition:transform .12s}
.prow.open .prowchev{transform:rotate(90deg)}
.prowbody{padding:4px 14px 16px;border-top:1px solid var(--line)}
.prowbody[hidden]{display:none}
.pstrip{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.pcard{width:168px;border:1px solid var(--line);border-radius:2px;background:var(--bg,#fff);
  display:flex;flex-direction:column}
.pcard.first{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.pcard img{width:100%;height:126px;object-fit:cover;display:block;background:#EBE8E1}
.pcardmain{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;
  padding:4px 6px;background:var(--ink);color:var(--paper);text-align:center}
.pcardbody{padding:6px;display:flex;flex-direction:column;gap:6px}
.pcard input[type=text]{width:100%;font:inherit;font-size:11.5px;padding:4px 6px;
  border:1px solid var(--line);border-radius:2px;background:var(--paper);color:inherit}
.pcardbtns{display:flex;gap:4px}
.pcardbtns button{flex:1;font:inherit;font-size:11px;padding:3px 0;cursor:pointer;
  border:1px solid var(--line);border-radius:2px;background:var(--paper);color:inherit}
.pcardbtns button:hover:not(:disabled){border-color:var(--ink)}
.pcardbtns button:disabled{opacity:.35;cursor:default}
.pcardbtns button.rm:hover{border-color:#8B2E2E;color:#8B2E2E}
.pactions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.pfile{cursor:pointer}
.pempty{margin:14px 0 0}
.pempty[hidden]{display:none}
.prow.dirty .prowname::after{content:' · unsaved';font-weight:400;color:#8B2E2E;font-size:12px}
@media (max-width:720px){
  .prowname{min-width:0}
  .prownote{display:none}
  .pcard{width:calc(50% - 5px)}
}
`;

/**
 * Runs inside the dashboard page. Holds one product's photo list in memory,
 * redraws the strip from it, and posts the whole list on save. Photos are
 * uploaded one at a time as they are picked, so a strap that fails to convert
 * does not take the other five down with it.
 *
 * Built with createElement rather than innerHTML: alt text is typed by hand
 * and goes straight back into the page, and this is the one place in the
 * dashboard where that happens.
 */
export const PHOTO_SCRIPT = `
(function(){
  var list = document.querySelector('.plist');
  if (!list) return;

  var STATE = __STATE__;
  var NAMES = __NAMES__;
  var MAX = __MAX__;

  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg, bad){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, 5000);
  }

  function q(sel){ return document.querySelector(sel); }
  function photos(id){ return STATE[id] || (STATE[id] = []); }
  function row(id){ return q('[data-row="' + id + '"]'); }
  function said(id, text){ var el = q('[data-said="' + id + '"]'); if (el) el.textContent = text || ''; }

  function dirty(id, on){
    var el = row(id);
    if (el) el.classList.toggle('dirty', !!on);
  }

  function url(photoId, size){ return '/photo/' + photoId + '-' + size + '.webp'; }

  function button(label, title, cls, onClick, disabled){
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function paint(id){
    var strip = q('[data-strip="' + id + '"]');
    var empty = q('[data-empty="' + id + '"]');
    var pill = q('[data-pill="' + id + '"]');
    var note = q('[data-note="' + id + '"]');
    var set = photos(id);
    if (!strip) return;

    strip.textContent = '';
    set.forEach(function(photo, i){
      var card = document.createElement('div');
      card.className = 'pcard' + (i === 0 ? ' first' : '');

      var img = document.createElement('img');
      img.src = url(photo.id, 't');
      img.alt = '';
      img.loading = 'lazy';
      card.appendChild(img);

      if (i === 0) {
        var flag = document.createElement('div');
        flag.className = 'pcardmain';
        flag.textContent = 'Main photo';
        card.appendChild(flag);
      }

      var body = document.createElement('div');
      body.className = 'pcardbody';

      var alt = document.createElement('input');
      alt.type = 'text';
      alt.value = photo.alt || '';
      alt.maxLength = __ALTMAX__;
      alt.placeholder = 'Describe it';
      alt.title = 'What is in the photo. Read out to anyone who cannot see it, and read by Google.';
      alt.addEventListener('input', function(){ photo.alt = alt.value; dirty(id, true); });
      body.appendChild(alt);

      var btns = document.createElement('div');
      btns.className = 'pcardbtns';
      btns.appendChild(button('\\u2190', 'Move earlier', '', function(){ move(id, i, -1); }, i === 0));
      btns.appendChild(button('\\u2192', 'Move later', '', function(){ move(id, i, 1); }, i === set.length - 1));
      btns.appendChild(button('Remove', 'Take this photo off the page', 'rm', function(){ drop(id, i); }));
      body.appendChild(btns);

      card.appendChild(body);
      strip.appendChild(card);
    });

    if (empty) empty.hidden = set.length > 0;
    if (pill) {
      pill.className = 'pill ' + (set.length ? 'good' : 'done');
      pill.textContent = set.length ? set.length + (set.length === 1 ? ' photo' : ' photos') : 'Built-in';
    }
    if (note) {
      note.textContent = set.length ? 'Showing photos uploaded here.' : 'Showing the photos in the repo.';
    }

    var thumb = row(id) && row(id).querySelector('.prowthumb img');
    if (thumb) thumb.src = set.length ? url(set[0].id, 't') : '/assets/img/products/' + id + '.webp';
  }

  function move(id, index, by){
    var set = photos(id);
    var to = index + by;
    if (to < 0 || to >= set.length) return;
    var moved = set.splice(index, 1)[0];
    set.splice(to, 0, moved);
    dirty(id, true);
    paint(id);
  }

  function drop(id, index){
    photos(id).splice(index, 1);
    dirty(id, true);
    paint(id);
  }

  function post(path, body){
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
      body: JSON.stringify(body)
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  function upload(file){
    var body = new FormData();
    body.append('file', file);
    return fetch('/dashboard/api/photo-upload', {
      method: 'POST',
      headers: { 'x-rawhide-dashboard': '1' },
      body: body
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Upload failed (' + res.status + ')'));
        return data.photo;
      });
    });
  }

  // One at a time on purpose. Six phone photos posted at once is 40 MB in
  // flight and a conversion queue; one after another is slower to watch and
  // finishes more often.
  function addFiles(id, files){
    var queue = [].slice.call(files);
    if (!queue.length) return;
    var room = MAX - photos(id).length;
    if (queue.length > room) {
      toast('Room for ' + room + ' more on this one. Taking the first ' + room + '.', true);
      queue = queue.slice(0, Math.max(0, room));
    }
    if (!queue.length) return;

    var done = 0;
    function next(){
      if (!queue.length) {
        said(id, done ? 'Added ' + done + '. Not saved yet.' : '');
        if (done) { dirty(id, true); toast('Uploaded. Press Save to put ' + (done === 1 ? 'it' : 'them') + ' on the site.'); }
        return;
      }
      var file = queue.shift();
      said(id, 'Uploading ' + file.name + '\\u2026');
      upload(file).then(function(photo){
        photo.alt = '';
        photos(id).push(photo);
        done++;
        paint(id);
      }).catch(function(err){
        toast(file.name + ': ' + err.message, true);
      }).then(next);
    }
    next();
  }

  function save(id, reset){
    var btn = q('[data-' + (reset ? 'reset' : 'save') + '="' + id + '"]');
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving\\u2026'; }

    post('/dashboard/api/photos', {
      productId: id,
      photos: reset ? [] : photos(id).map(function(p){
        return { id: p.id, alt: p.alt || '', w: p.w, h: p.h, tw: p.tw, th: p.th };
      })
    }).then(function(data){
      STATE[id] = data.photos || [];
      dirty(id, false);
      paint(id);
      said(id, 'Saved.');
      toast(data.photos && data.photos.length
        ? 'Saved. ' + NAMES[id] + ' shows these within a minute.'
        : NAMES[id] + ' is back on the built-in photos.');
    }).catch(function(err){
      toast(err.message, true);
    }).then(function(){
      if (btn) { btn.disabled = false; btn.textContent = label; }
    });
  }

  list.addEventListener('click', function(e){
    var el = e.target.closest ? e.target.closest('[data-toggle],[data-save],[data-reset]') : null;
    if (!el) return;

    var id = el.getAttribute('data-toggle');
    if (id) {
      var body = q('[data-body="' + id + '"]');
      var open = body.hidden;
      body.hidden = !open;
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
      row(id).classList.toggle('open', open);
      if (open) paint(id);
      return;
    }

    id = el.getAttribute('data-save');
    if (id) { save(id, false); return; }

    id = el.getAttribute('data-reset');
    if (id) {
      if (photos(id).length && !confirm('Put ' + NAMES[id] + ' back on the photos in the repo? The ones uploaded here are deleted.')) return;
      save(id, true);
    }
  });

  list.addEventListener('change', function(e){
    var id = e.target.getAttribute && e.target.getAttribute('data-add');
    if (!id) return;
    addFiles(id, e.target.files);
    e.target.value = '';
  });
})();
`;

/** The script with this record baked into it. Kept out of the template above
 *  so the JSON goes through JSON.stringify rather than into a string by hand. */
export function photoScript(record) {
  const state = {};
  for (const [id] of PRODUCTS) state[id] = photosFor(record, id);

  return PHOTO_SCRIPT
    .replace('__STATE__', JSON.stringify(state))
    .replace('__NAMES__', JSON.stringify(Object.fromEntries(PRODUCTS)))
    .replace('__MAX__', String(MAX_PHOTOS))
    .replace('__ALTMAX__', String(ALT_MAX));
}

/* ------------------------------------------------------------------- save */

/**
 * Saves one product's set. An empty list removes the product from the record
 * rather than storing an empty one, so "no record" and "no photos" stay the
 * same thing: the repo's photos.
 *
 * Bytes for photos that are no longer pointed at anywhere in the record are
 * deleted here. A photo uploaded and never saved is left in the bucket — it
 * costs a fraction of a cent and nothing can see it.
 */
export async function handlePhotoSave(request, env) {
  if (!env.CATALOG || !env.PHOTOS) {
    return json({
      error: 'Photo storage is not set up. Add the CATALOG KV and PHOTOS R2 bindings — see the README.',
    }, 500);
  }

  const body = await request.json().catch(() => ({}));

  let set;
  try {
    set = buildPhotoSet(body);
  } catch (err) {
    if (err instanceof PhotoError) return json({ error: err.message }, 400);
    throw err;
  }

  // Every new photo is checked against the bucket before it can go live. An id
  // that is not there means an upload that failed quietly, and a product page
  // with a broken main image on it is worse than one with an old photo.
  const before = await getPhotoRecord(env);
  const known = idsInRecord(before);
  for (const photo of set.photos) {
    if (known.has(photo.id)) continue;
    const head = await env.PHOTOS.head(`${photo.id}-m.webp`);
    if (!head) return json({ error: 'One of those photos is not in storage. Upload it again.' }, 400);
  }

  const record = { products: { ...(before?.products || {}) }, updatedAt: new Date().toISOString() };
  if (set.photos.length) record.products[set.product] = { photos: set.photos };
  else delete record.products[set.product];

  await putPhotoRecord(env, record);

  const orphans = [...known].filter((id) => !idsInRecord(record).has(id));
  for (const id of orphans) {
    try {
      await deletePhoto(env, id);
    } catch (err) {
      // A deleted record with bytes left behind is untidy, not broken.
      console.error('photo delete failed', err?.message || err);
    }
  }

  return json({ ok: true, product: set.product, photos: set.photos });
}
