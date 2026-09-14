/**
 * What the shop changed about a product without a deploy.
 *
 * One record in the CATALOG namespace holds it — photos and wording today,
 * option lists when those are built — and this file is the record and what the
 * storefront does with it. The two halves live next door:
 *
 *   worker/photos.js       the photo machinery: upload, both sizes, the gallery
 *   worker/product-copy.js the wording: the fields, the checks, the markup
 *   worker/products-page.js the dashboard page that edits them
 *
 * Both halves are pure. They take a product's photos or its wording and hand
 * back markup and a list of rules; this file does the record lookups, the KV
 * read, the feed, and the one pass of HTMLRewriter that puts it all on a page.
 * That split is what keeps either half testable without a parser or a binding.
 *
 * Nothing here is required. A product with no record is served exactly as the
 * repo has it, and so is every product if the binding is missing or KV is
 * having a bad afternoon. `product-<id>.html` is the fallback for all of it.
 */

import { PRODUCTS } from './promo.js';
import { photoRules, photoCardRules, feedImageLinks, photosFor } from './photos.js';
import { copyRules, copyFor, itemFor } from './product-copy.js';

/** One record, one key. Small enough that a page reads the lot in one call. */
export const CATALOG_KEY = 'catalog';

const PRODUCT_NAME = new Map(PRODUCTS);
export const PRODUCT_IDS = new Set(PRODUCTS.map(([id]) => id));

export function productName(id) {
  return PRODUCT_NAME.get(id) || id;
}

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

/* ----------------------------------------------------------- the record */

export function productsWithPhotos(record) {
  return Object.keys(record?.products || {}).filter((id) => photosFor(record, id).length);
}

export function productsWithCopy(record) {
  return Object.keys(record?.products || {}).filter((id) => copyFor(record, id));
}

/** Every product this record changes anything about, in catalogue order. */
export function touchedProducts(record) {
  const touched = new Set([...productsWithPhotos(record), ...productsWithCopy(record)]);
  return PRODUCTS.map(([id]) => id).filter((id) => touched.has(id));
}

/**
 * Writes a product's entry, dropping it when there is nothing left to say.
 * "No entry" and "an entry that overrides nothing" have to stay the same
 * thing, or a reset would leave a husk that still counts as an override.
 */
export function withProduct(record, product, { photos, copy }) {
  const products = { ...(record?.products || {}) };
  const entry = {};
  if (photos?.length) entry.photos = photos;
  if (copy) entry.copy = copy;

  if (Object.keys(entry).length) products[product] = entry;
  else delete products[product];

  return { products, updatedAt: new Date().toISOString() };
}

/* --------------------------------------------------------------------- KV */

/**
 * Never throws. This runs on every storefront page, and a KV hiccup must not
 * take a product page down with it. The 60 second cache is KV's floor, and it
 * is why a change takes up to a minute to reach every page.
 */
export async function getCatalog(env) {
  if (!env.CATALOG) return null;
  try {
    return await env.CATALOG.get(CATALOG_KEY, { type: 'json', cacheTtl: 60 });
  } catch {
    return null;
  }
}

export async function putCatalog(env, record) {
  await env.CATALOG.put(CATALOG_KEY, JSON.stringify(record));
}

/* ------------------------------------------------------------------- feed */

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export function xmlEscape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * The Google Merchant feed. It is XML served straight off disk, so this is a
 * string swap rather than a rewriter: inside the `<item>` whose `<g:id>`
 * matches, the image links and the description become the shop's.
 *
 * Item by item, each one found on its own terms. Reaching for the product's id
 * first and taking the block around it reads tidier and is wrong: that span
 * runs from the FIRST item in the feed to the one being changed, so what it
 * swaps belongs to whatever product sits at the top. It shipped that way once
 * — the helmet band's photo landed on the fully custom radio strap and took
 * its six other pictures with it.
 *
 * Feed content matters for more than tidiness. Merchant Center re-reviews a
 * product when its image or description changes, and it reads the words
 * printed in the photograph as well as the ones in the text.
 */
export function rewriteFeed(xml, record, origin) {
  if (!touchedProducts(record).length) return xml;

  return String(xml).replace(/<item>[\s\S]*?<\/item>/g, (block) => {
    const id = /<g:id>([^<]*)<\/g:id>/.exec(block)?.[1];
    if (!id || !PRODUCT_IDS.has(id)) return block;

    let out = block;

    const photos = photosFor(record, id);
    if (photos.length) {
      // The whole run of image lines goes at once, so the count can move up or
      // down. There is one run per item, so this replaces once and stops.
      out = out.replace(
        /<g:image_link>[\s\S]*?<\/g:image_link>(?:\s*<g:additional_image_link>[\s\S]*?<\/g:additional_image_link>)*/,
        feedImageLinks(photos, origin)
      );
    }

    const feedText = copyFor(record, id)?.feed;
    if (feedText) {
      out = out.replace(
        /<g:description>[\s\S]*?<\/g:description>/,
        `<g:description>${xmlEscape(feedText)}</g:description>`
      );
    }

    return out;
  });
}

/* -------------------------------------------------------------- storefront */

/**
 * Swaps the "image" and "description" values in a product's JSON-LD without
 * parsing and re-serialising the block — a round trip through JSON.parse would
 * reformat markup that is fine as it is, and throw away anything it did not
 * understand. Only the Product block carries either; the breadcrumb block
 * comes back untouched.
 */
export function withSchemaFields(text, { image = '', description = '' } = {}) {
  if (!/"@type"\s*:\s*"Product"/.test(text)) return text;
  let out = text;
  if (image) {
    out = out.replace(/"image"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])/, `"image":${jsonValue(image)}`);
  }
  if (description) {
    out = out.replace(/"description"\s*:\s*"(?:[^"\\]|\\.)*"/, `"description":${jsonValue(description)}`);
  }
  return out;
}

/**
 * A JSON string safe to sit inside a <script> element. JSON.stringify escapes
 * quotes and backslashes but leaves `<` alone, and a description containing
 * `</script>` would end the block early and spill the rest onto the page.
 */
function jsonValue(text) {
  return JSON.stringify(String(text)).replace(/</g, '\\u003c');
}

/**
 * Everything a page gets, as plain data: a selector, what to do, and the
 * value. Built as a list rather than written straight into HTMLRewriter calls
 * so the tests can read what a page is about to get without needing a parser.
 *
 * `product` is the page's own product when it is a product page, and '' on the
 * shop and category grids, which carry cards for several products at once.
 */
export function catalogRules(record, { product = '', origin = 'https://rawhidecityleather.com' } = {}) {
  const rules = [];

  if (product) {
    rules.push(...photoRules(photosFor(record, product), { origin }));
    rules.push(...copyRules(copyFor(record, product)));
  }

  // The grids. A card is an <a> to the product, on the shop page, the category
  // pages and the home page alike, so one selector covers all of them. Only
  // photos reach a card — the cards carry a name and a price, no wording.
  for (const id of productsWithPhotos(record)) {
    rules.push(...photoCardRules(photosFor(record, id), id, { origin }));
  }

  return rules;
}

/**
 * Applies those rules with HTMLRewriter. Deliberately the only place that
 * knows the rewriter exists: everything it needs was decided above, where it
 * can be tested.
 *
 * HTMLRewriter is a Workers global. Outside the runtime the page goes back as
 * it came, which is what the Node preview sees.
 */
export function applyRules(response, rules) {
  if (typeof HTMLRewriter === 'undefined' || !rules.length) return response;

  let rewriter = new HTMLRewriter();

  // Both halves can want something from the structured data — the photo half
  // an image, the wording half a description — and two text handlers on one
  // element would each rewrite what the other just wrote. They are merged into
  // one before anything is registered.
  const schema = rules.filter((r) => r.action === 'schema');
  const rest = rules.filter((r) => r.action !== 'schema');

  for (const rule of rest) {
    if (rule.action === 'inner') {
      let seen = 0;
      rewriter = rewriter.on(rule.selector, {
        element(el) {
          // `once` is for a page that carries the selector twice: the helmet
          // band has a second .product-description holding its guide copy,
          // and the wording belongs only in the first.
          if (rule.once && seen++) return;
          el.setInnerContent(rule.value, { html: true });
        },
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
    }
  }

  if (schema.length) {
    const fields = {
      image: schema.find((r) => r.image)?.image || '',
      description: schema.find((r) => r.description)?.description || '',
    };
    // Text arrives in chunks, so the block is gathered and swapped at the end
    // of it. Two ld+json blocks share this handler, and the parser hands them
    // over one after the other, never interleaved.
    let buffer = '';
    rewriter = rewriter.on(schema[0].selector, {
      text(chunk) {
        buffer += chunk.text;
        if (!chunk.lastInTextNode) {
          chunk.remove();
          return;
        }
        chunk.replace(withSchemaFields(buffer, fields), { html: true });
        buffer = '';
      },
    });
  }

  return rewriter.transform(response);
}

/**
 * The storefront hook. Only touches a 200 to a GET, and only when the record
 * changes something, so a 404, a stylesheet, a page with no products on it, or
 * a shop that has never saved anything all pass straight through.
 */
export async function withCatalog(response, request, env) {
  if (request.method !== 'GET' || response.status !== 200) return response;
  const type = response.headers.get('content-type') || '';
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const isFeed = path === '/google-merchant-feed.xml';
  if (!type.includes('text/html') && !isFeed) return response;

  const record = await getCatalog(env);
  if (!touchedProducts(record).length) return response;

  if (isFeed) {
    const xml = await response.text();
    return new Response(rewriteFeed(xml, record, url.origin), {
      status: response.status,
      headers: response.headers,
    });
  }

  return applyRules(response, catalogRules(record, {
    product: productIdFromPath(path),
    origin: url.origin,
  }));
}

/**
 * What a product page says in the repo, for the dashboard to show and edit.
 * Returns null when the page cannot be read — the editor then starts empty for
 * that product rather than the whole page failing.
 */
export async function builtInCopy(env, product, origin, extract) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(`/product-${product}`, origin)));
    if (!res.ok) return null;
    return extract(await res.text());
  } catch {
    return null;
  }
}

export { itemFor };
