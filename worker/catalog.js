/**
 * What the shop changed about a product without a deploy.
 *
 * One record in the CATALOG namespace holds it — photos, wording and the
 * choices on the order form — and this file is the record and what the
 * storefront does with it. The three halves live next door:
 *
 *   worker/photos.js          upload, both sizes, the gallery markup
 *   worker/product-copy.js    the wording: the fields, the checks, the markup
 *   worker/product-options.js the dropdowns, and the two places a price lands
 *   worker/products-page.js   the dashboard page that edits all of it
 *
 * All three are pure. They take a product's photos, words or choices and hand
 * back markup and a list of rules; this file does the record lookups, the KV
 * read, the feed, and the one pass of HTMLRewriter that puts it on a page.
 * That split is what keeps each of them testable without a parser or a binding.
 *
 * Nothing here is required. A product with no record is served exactly as the
 * repo has it, and so is every product if the binding is missing or KV is
 * having a bad afternoon. `product-<id>.html` is the fallback for all of it.
 */

import { PRODUCTS } from './promo.js';
import {
  photoRules, photoCardRules, feedImageLinks, photosFor, idsInRecord,
} from './photos.js';
import { copyRules, copyFor, itemFor } from './product-copy.js';
import { optionRules, optionsFor } from './product-options.js';
import {
  cardHtml, categoryFor, customFor, customPhotoIds, feedItemXml, feedReady,
  liveCustomProducts, pageRules, sitemapEntry,
} from './custom-product.js';

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

/**
 * The same, for a product the shop added on the dashboard. A separate function
 * because these two have nothing in common past the shape of the address: one
 * is a page in the repo being rewritten, the other is a page being built.
 */
export function customIdFromPath(path, record) {
  const match = /^\/product-([a-z0-9-]+)$/.exec(String(path || ''));
  if (!match || PRODUCT_IDS.has(match[1])) return '';
  return customFor(record, match[1]) ? match[1] : '';
}

/* ----------------------------------------------------------- the record */

export function productsWithPhotos(record) {
  return Object.keys(record?.products || {}).filter((id) => photosFor(record, id).length);
}

export function productsWithCopy(record) {
  return Object.keys(record?.products || {}).filter((id) => copyFor(record, id));
}

export function productsWithOptions(record) {
  return Object.keys(record?.products || {}).filter((id) => optionsFor(record, id));
}

/** Every product this record changes anything about, in catalogue order. */
/**
 * Whether this record has anything at all to do to a page. The gate on every
 * rewrite below, and it counts both halves: a shop that has changed nothing
 * about a repo product may still have added one of its own.
 */
export function catalogChanges(record) {
  return touchedProducts(record).length + liveCustomProducts(record).length;
}

export function touchedProducts(record) {
  const touched = new Set([
    ...productsWithPhotos(record),
    ...productsWithCopy(record),
    ...productsWithOptions(record),
  ]);
  return PRODUCTS.map(([id]) => id).filter((id) => touched.has(id));
}

/**
 * Writes a product's entry, dropping it when there is nothing left to say.
 * "No entry" and "an entry that overrides nothing" have to stay the same
 * thing, or a reset would leave a husk that still counts as an override.
 */
export function withProduct(record, product, { photos, copy, options }) {
  const products = { ...(record?.products || {}) };
  const entry = {};
  if (photos?.length) entry.photos = photos;
  if (copy) entry.copy = copy;
  if (options) entry.options = options;

  if (Object.keys(entry).length) products[product] = entry;
  else delete products[product];

  // The rest of the record is carried across, not rebuilt. The products the
  // shop added itself live beside this half, and returning only this one
  // deleted every one of them — and swept their photographs out of the bucket
  // behind them — the moment anybody pressed Save on a repo product.
  return { ...(record || {}), products, updatedAt: new Date().toISOString() };
}

/**
 * Every photo id anywhere in the record. Both halves, always: a repo product
 * keeps its photos under `products` and one the shop added keeps them under
 * `custom`, and a sweep that looked at one half would delete the other half's
 * pictures the next time anything at all was saved.
 */
export function allPhotoIds(record) {
  const out = new Set(idsInRecord(record));
  for (const id of customPhotoIds(record)) out.add(id);
  return out;
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
  // The shop's own products are not in the file to be rewritten — they are
  // added to it, right before the channel closes, in the same shape as the
  // rest. Only the ones complete enough for Google go in: an item with no
  // picture or no description is refused on arrival, and a refused item is an
  // account-level problem rather than a quiet one.
  const added = liveCustomProducts(record).filter(feedReady)
    .map((product) => feedItemXml(product, { origin }))
    .join('');
  const withAdded = (text) => (added
    ? text.replace(/[ \t]*<\/channel>/, added + '  </channel>')
    : text);

  if (!touchedProducts(record).length) return withAdded(String(xml));

  return withAdded(String(xml).replace(/<item>[\s\S]*?<\/item>/g, (block) => {
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
  }));
}

/**
 * The sitemap. Same idea and for the same reason: a page the Worker builds is
 * not in the file on disk, so it is added to the end of it. A draft is left
 * out — it carries a noindex tag of its own, and a sitemap that lists a page
 * telling Google not to index it is a warning in Search Console.
 */
export function rewriteSitemap(xml, record, origin) {
  const added = liveCustomProducts(record)
    .map((product) => sitemapEntry(product, { origin }))
    .join('');
  if (!added) return xml;
  return String(xml).replace('</urlset>', added + '</urlset>');
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
export function catalogRules(record, {
  product = '', path = '', origin = 'https://rawhidecityleather.com',
} = {}) {
  const rules = [];

  if (product) {
    rules.push(...photoRules(photosFor(record, product), { origin }));
    rules.push(...copyRules(copyFor(record, product)));
    rules.push(...optionRules(optionsFor(record, product)));
  }

  // The grids. A card is an <a> to the product, on the shop page, the category
  // pages and the home page alike, so one selector covers all of them. Only
  // photos reach a card — the cards carry a name and a price, no wording.
  for (const id of productsWithPhotos(record)) {
    rules.push(...photoCardRules(photosFor(record, id), id, { origin }));
  }

  // A product the shop added has no card anywhere to swap, so one is put in.
  // The shop page files its cards by section; the two category pages that
  // exist are each about one thing, so their first grid is the right one and
  // there is nothing to choose between. Belts and accessories have no page of
  // their own — /shop#belts is where the footer sends people.
  const here = String(path).replace(/[/]+$/, '') || '/';
  for (const made of liveCustomProducts(record)) {
    const card = cardHtml(made);
    if (!card) continue;
    const category = categoryFor(made.category);

    if (here === '/shop') {
      rules.push({ selector: '#' + category.section + ' .product-grid', action: 'append', value: card });
    } else if (category.page && here === category.page) {
      rules.push({ selector: '.product-grid', action: 'append', value: card, once: true });
    }
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
    } else if (rule.action === 'append') {
      // A card going into a grid that has no card for it to replace. `once`
      // is for the category pages, where the grid is found by class rather
      // than by id and the page carries more than one.
      let seen = 0;
      rewriter = rewriter.on(rule.selector, {
        element(el) {
          if (rule.once && seen++) return;
          el.append(rule.value, { html: true });
        },
      });
    } else if (rule.action === 'blocks') {
      // A run of elements replaced outright, in order — the two ld+json blocks
      // on a page the Worker builds. Anything past the end of the list is
      // removed rather than left: what is in it belongs to the donor page, and
      // a stray Product block would describe the wrong product to Google.
      let index = 0;
      rewriter = rewriter.on(rule.selector, {
        element(el) {
          const value = rule.values[index++];
          if (value === undefined) el.remove();
          else el.setInnerContent(value, { html: true });
        },
      });
    } else if (rule.action === 'select') {
      // The dropdown itself: its choices, and the price list the cart script
      // copies onto the buy button when somebody adds to cart.
      rewriter = rewriter.on(rule.selector, {
        element(el) {
          el.setInnerContent(rule.value, { html: true });
          if (rule.dataOptions) el.setAttribute('data-options', rule.dataOptions);
          else el.removeAttribute('data-options');
        },
      });
    } else if (rule.action === 'custom-options') {
      // Snipcart's own copy of the price list, which its crawler reads off the
      // page to check what the cart was handed. Its fields are numbered, and
      // the number is positional — so it is resolved here, from the page being
      // streamed, by matching the field's name. A number stored in the record
      // would be silently wrong the day a field moved in the HTML, and the
      // upcharge would land on somebody else's option.
      rewriter = rewriter.on(rule.selector, {
        element(el) {
          const indexOf = new Map();
          for (const [name, value] of el.attributes) {
            const found = /^data-item-custom(\d+)-name$/.exec(name);
            if (found) indexOf.set(value, found[1]);
          }
          for (const [fieldName, options] of Object.entries(rule.byName)) {
            const index = indexOf.get(fieldName);
            if (!index) continue;
            if (options) el.setAttribute(`data-item-custom${index}-options`, options);
            else el.removeAttribute(`data-item-custom${index}-options`);
          }
        },
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
  const isSitemap = path === '/sitemap.xml';
  if (!type.includes('text/html') && !isFeed && !isSitemap) return response;

  const record = await getCatalog(env);
  if (!catalogChanges(record)) return response;

  if (isFeed || isSitemap) {
    const xml = await response.text();
    return new Response(
      isFeed ? rewriteFeed(xml, record, url.origin) : rewriteSitemap(xml, record, url.origin),
      { status: response.status, headers: response.headers }
    );
  }

  return applyRules(response, catalogRules(record, {
    product: productIdFromPath(path),
    path,
    origin: url.origin,
  }));
}

/* ------------------------------------------- a page that is not in the repo */

/**
 * The page a custom product is built out of.
 *
 * Its own product is replaced wholesale — the gallery, the price, the form,
 * the buy button, both structured data blocks, every meta tag — so what is
 * left of it is the chrome: the header, the nav, the fonts, the footer, the
 * pixel, the cart script. Taking those from a real page means they cannot
 * drift out of date with the site, which writing them out here would
 * guarantee the first time the footer changed.
 *
 * Leather Butter is the donor because it is the plainest page in the repo:
 * one product, no upload slots, no crew pricing panel, exactly the two ld+json
 * blocks every product page carries.
 */
export const DONOR_PAGE = '/product-leather-butter';

export async function serveCustomProduct(env, product, url) {
  // Without the rewriter the donor would go back as itself, which is to say
  // the wrong product at the right address. Better a 404: this is only ever
  // missing outside the Workers runtime, which is the Node preview.
  if (typeof HTMLRewriter === 'undefined') return null;

  let donor;
  try {
    donor = await env.ASSETS.fetch(new Request(new URL(DONOR_PAGE, url.origin)));
  } catch {
    return null;
  }
  if (!donor.ok) return null;

  const headers = new Headers(donor.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  // A minute, the same as the KV record behind it. Promising longer would mean
  // a price change sitting in a cache after the record already moved on.
  headers.set('cache-control', 'public, max-age=60');
  // Both belong to the donor, and this is not the donor. A conditional request
  // carrying them back would be answered 304 with the other product's page.
  headers.delete('etag');
  headers.delete('last-modified');

  return applyRules(
    new Response(donor.body, { status: 200, headers }),
    pageRules(product, { origin: url.origin })
  );
}

/**
 * The hook in index.js: a storefront address that no file answers to, which
 * may belong to a product the shop added. Returns null for everything else,
 * and the 404 goes back untouched.
 *
 * The shape is checked before the record is read, so the Worker is not making
 * a KV lookup for every bot asking after /wp-login.
 */
export async function customProductPage(request, env, url, path) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (!/^\/product-[a-z0-9-]+$/.test(path)) return null;

  const record = await getCatalog(env);
  const id = customIdFromPath(path, record);
  if (!id) return null;

  return await serveCustomProduct(env, customFor(record, id), url);
}

/**
 * The products a sale can be pointed at beyond the ones in PRODUCTS: whatever
 * the shop has added and put on the site. A draft is left out — there is no
 * card to put a price strike through, and Snipcart would be holding a rule
 * against a product nobody can buy.
 */
export function extraSaleProducts(record) {
  return liveCustomProducts(record).map((product) => [product.id, product.name]);
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
