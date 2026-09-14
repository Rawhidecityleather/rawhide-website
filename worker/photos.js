/**
 * Product photos: the machinery behind them.
 *
 * One photograph appears in seven places on this site — the page gallery, the
 * card in the shop grid, og:image, the JSON-LD image, the Snipcart cart
 * thumbnail on the form and on the hidden button, and the image links in the
 * Google feed. Swapping one meant editing all seven by hand, making a .webp
 * and a thumbnail to go with it, and deploying.
 *
 * So the shop uploads a photo on /dashboard/products instead. Cloudflare
 * Images makes the full size and the thumbnail, both go into the PHOTOS
 * bucket, and the record in worker/catalog.js says which photos a product has
 * and in what order.
 *
 * This file is pure apart from the two handlers at the bottom: it takes a list
 * of photos and gives back markup and a list of rules. The record lookups, the
 * feed and the one pass of HTMLRewriter all live in worker/catalog.js.
 *
 * Routes (wired in index.js)
 *   GET  /photo/<key>                  PUBLIC — storefront images.
 *   POST /dashboard/api/photo-upload   one file in, one photo back.
 *
 * Bindings:
 *   PHOTOS — R2 bucket `rawhide-product-photos`, the image bytes.
 *   IMAGES — Cloudflare Images, already bound. Makes the two sizes.
 */

import { esc, json } from './lib.js';
import { PRODUCTS } from './promo.js';
import { detect } from './uploads.js';

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

export class PhotoError extends Error {}

/* ------------------------------------------------------------------ model */

/** `/photo/<32 hex>-m.webp` — 'm' is the full size, 't' the thumbnail. */
export function photoUrl(id, size = 'm') {
  return `/photo/${id}-${size === 't' ? 't' : 'm'}.webp`;
}

/**
 * The absolute URL for the places that need one: og:image, JSON-LD, the Google
 * feed. A relative path is fine in an `<img src>` and wrong in all three.
 */
export function absolutePhotoUrl(origin, id, size = 'm') {
  return new URL(photoUrl(id, size), origin).toString();
}

export function isPhotoKey(key) {
  return /^[0-9a-f]{32}-[mt]\.webp$/.test(String(key || ''));
}

/** The repo's own main photo for a product. Every one of them is `<id>.webp`. */
export function builtInPhoto(id) {
  return `/assets/img/products/${id}.webp`;
}

export function photosFor(record, product) {
  const set = record?.products?.[product]?.photos;
  return Array.isArray(set) ? set : [];
}

/** Every photo id the whole record points at, for finding what R2 can drop. */
export function idsInRecord(record) {
  const out = new Set();
  for (const entry of Object.values(record?.products || {})) {
    for (const photo of entry?.photos || []) out.add(photo.id);
  }
  return out;
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
    alt: alt || PRODUCT_NAME.get(product) || product,
    w: size('w', MAIN_WIDTH),
    h: size('h', MAIN_WIDTH),
    tw: size('tw', THUMB_WIDTH),
    th: size('th', THUMB_WIDTH),
  };
}

/**
 * Turns the dashboard form into one product's set, or throws a PhotoError the
 * page can show. An empty list is legal and means the same as no photos at
 * all — use the repo's.
 */
export function buildPhotoSet(list, product) {
  const photos = (Array.isArray(list) ? list : []);
  if (photos.length > MAX_PHOTOS) {
    throw new PhotoError(`That is more than ${MAX_PHOTOS} photos. The page cannot show them all.`);
  }

  const cleaned = photos.map((p) => cleanPhoto(p, product));

  const seen = new Set();
  for (const p of cleaned) {
    if (seen.has(p.id)) throw new PhotoError('The same photo is in there twice.');
    seen.add(p.id);
  }

  return cleaned;
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
 * The image lines for one item in the Google feed. Google takes ten additional
 * images and ignores the rest; a feed that claims something Google drops is a
 * feed nobody can check against the site.
 */
export function feedImageLinks(photos, origin) {
  return `<g:image_link>${absolutePhotoUrl(origin, photos[0].id)}</g:image_link>` +
    photos.slice(1, 11).map((p) =>
      `\n      <g:additional_image_link>${absolutePhotoUrl(origin, p.id)}</g:additional_image_link>`
    ).join('');
}

/* ------------------------------------------------------------------ rules */

/** Where a product's photos land in its own page. */
export function photoRules(photos, { origin = 'https://rawhidecityleather.com' } = {}) {
  if (!photos.length) return [];
  const [first] = photos;
  const absolute = absolutePhotoUrl(origin, first.id);

  return [
    { selector: '.product-media', action: 'inner', value: galleryHtml(photos) },
    { selector: 'meta[property="og:image"]', action: 'attr', name: 'content', value: absolute },
    { selector: 'meta[name="twitter:image"]', action: 'attr', name: 'content', value: absolute },
    { selector: 'script[type="application/ld+json"]', action: 'schema', image: absolute },
    // The cart thumbnail, in both places a page carries it: the form the
    // customer fills in, and the hidden button it drives.
    { selector: 'form[data-order-form]', action: 'attr', name: 'data-snipcart-image', value: absolute },
    { selector: 'button.snipcart-add-item', action: 'attr', name: 'data-item-image', value: absolute },
  ];
}

/**
 * Where a product's main photo lands in a grid of cards. The card's own alt
 * text is a product name in the repo and stays that way — swapping in the
 * photo's description would repeat a sentence in a place that reads better as
 * a label.
 */
export function photoCardRules(photos, product, { origin = 'https://rawhidecityleather.com' } = {}) {
  if (!photos.length) return [];
  const [first] = photos;

  return [
    {
      selector: `a[href="/product-${product}"] .product-card-image img`,
      action: 'card',
      value: photoUrl(first.id),
      w: first.w,
      h: first.h,
    },
    {
      selector: `form[data-card-buy][data-snipcart-id="${product}"]`,
      action: 'attr',
      name: 'data-snipcart-image',
      value: absolutePhotoUrl(origin, first.id),
    },
  ];
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
