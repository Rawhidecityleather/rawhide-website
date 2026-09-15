/**
 * Products the shop added itself, with no page in the repo.
 *
 * Everything next door to this file edits a product that already exists:
 * worker/photos.js swaps its pictures, worker/product-copy.js its wording,
 * worker/product-options.js the choices on its order form. All three lean on
 * `product-<id>.html` being there — it is what they read, and what they fall
 * back to.
 *
 * A product added from the dashboard has no such page, so this file is the
 * page. It holds the record, and it builds every place that record has to
 * reach: the product page itself, the card in the shop grid, the entry in the
 * Google Shopping feed, the line in the sitemap. worker/catalog.js does the
 * serving; this is pure, and that is what lets a whole page be checked in a
 * test without a binding or a parser.
 *
 * Two rules are baked into the markup rather than left to whoever fills in the
 * form, because both are the kind of thing that fails quietly at checkout:
 *
 *   The id never changes. It is the Snipcart product id, and it is written
 *   into every order ever placed for the thing. Rename it and those orders
 *   point at a product that no longer exists.
 *
 *   Every dropdown is always submitted. assets/js/main.js numbers the custom
 *   fields on the hidden buy button by the fields the customer actually filled
 *   in, and Snipcart's crawler reads the numbering off the page as it is
 *   served. A dropdown that could come back blank would shift every field
 *   after it by one, and the upcharge would land on somebody else's option. So
 *   a required dropdown gets the greyed "Select..." row and an optional one
 *   gets no empty row at all — it opens on its first choice. The notes box is
 *   last precisely because it is the one field allowed to arrive empty.
 */

import { esc } from './lib.js';
import { descriptionHtml, detailsHtml } from './product-copy.js';
import {
  choicesFromText, choicesToText, optionsHtml, dataOptionsString, OptionError,
  CHOICES_MAX,
} from './product-options.js';
import {
  galleryHtml, photoUrl, absolutePhotoUrl, feedImageLinks, buildPhotoSet, PhotoError,
} from './photos.js';

export class CustomProductError extends Error {}

export const NAME_MAX = 90;
export const TITLE_MAX = 150;
export const ID_MAX = 60;
export const EYEBROW_MAX = 40;
export const LABEL_MAX = 60;
export const SUMMARY_MAX = 320;
export const DESCRIPTION_MAX = 4000;
export const DETAIL_MAX = 200;
export const DETAILS_MAX = 20;
export const FEED_MAX = 5000;
/** More dropdowns than the fully custom strap carries, and that is the most here. */
export const FIELDS_MAX = 10;
/** Nothing on this bench is a four-figure item. A bigger number is a typo. */
export const PRICE_CAP = 2000;

/**
 * Where a product sits. The section id is the one on shop.html; `page` is the
 * category page that gets the card as well, where there is one — belts live at
 * /shop#belts and have no page of their own.
 *
 * The feed fields are Google's, and they are copied off the items already in
 * google-merchant-feed.xml rather than picked fresh: a new accessory should
 * land in the same Google category as the chin strap sitting next to it.
 */
export const CATEGORIES = [
  {
    key: 'radio-straps', label: 'Radio Straps', section: 'radio-straps', page: '/radio-straps',
    feedType: 'Radio Straps', googleCategory: '263', lead: '6-weeks',
  },
  {
    key: 'belts', label: 'Belts', section: 'belts', page: '',
    feedType: 'Belts', googleCategory: '169', lead: '1-3-weeks',
  },
  {
    key: 'hats', label: 'Hats', section: 'hats', page: '/hats',
    feedType: 'Hats', googleCategory: '173', lead: '1-3-weeks',
  },
  {
    key: 'accessories', label: 'Accessories', section: 'accessories', page: '',
    feedType: 'Accessories', googleCategory: '2047', lead: '1-3-weeks',
  },
];

const CATEGORY = new Map(CATEGORIES.map((c) => [c.key, c]));

export function categoryFor(key) {
  return CATEGORY.get(key) || CATEGORY.get('accessories');
}

/**
 * Handling time is what Google promises a shopper, in days, and getting it
 * wrong is the kind of thing that gets an account suspended. These are the
 * shop's published lead times and nothing else.
 */
export const LEAD_TIMES = [
  { key: '1-3-days', label: '1–3 business days', min: 1, max: 3 },
  { key: '1-3-weeks', label: '1–3 weeks', min: 7, max: 21 },
  { key: '6-weeks', label: '6 weeks', min: 25, max: 30 },
];

const LEAD = new Map(LEAD_TIMES.map((l) => [l.key, l]));

export const DEFAULT_EYEBROW = 'HANDMADE LEATHER';

/* ------------------------------------------------------------------ model */

/**
 * A name to a web address. `Shop Apron` becomes `shop-apron`, and the page is
 * then at /product-shop-apron. Accents come down to letters, apostrophes go,
 * and anything left that is not a letter or a digit becomes a dash.
 */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX)
    .replace(/-+$/, '');
}

function oneLine(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Keeps paragraph breaks and drops the rest of the whitespace noise. */
function block(value, max) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/**
 * The price as Snipcart wants it: a string with two decimals. It stays a string
 * the whole way through on purpose — it is checked against the number printed
 * on the page and against whatever the cart was handed, and a float that rounds
 * differently in one of those three places is a refused checkout.
 */
export function cleanPrice(value) {
  const raw = String(value ?? '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new CustomProductError('The price wants to be a number, like 85 or 85.00.');
  }
  const amount = Number(raw);
  if (!(amount > 0)) throw new CustomProductError('The price has to be more than nothing.');
  if (amount > PRICE_CAP) {
    throw new CustomProductError(`$${amount} is more than this will take. Check the decimal point.`);
  }
  return amount.toFixed(2);
}

/**
 * One dropdown off the form. The `name` is derived from the label rather than
 * typed, because it is an HTML attribute and nobody should have to think about
 * that. `snipcartName` is the label itself, which is what shows in the cart, on
 * the packing slip and in the order email.
 */
function cleanField(input, taken) {
  const label = oneLine(input?.label, LABEL_MAX);
  if (!label) throw new CustomProductError('A dropdown needs a label — what the customer is picking.');

  const choices = choicesFromText(input?.choices);
  if (!choices.length) {
    throw new CustomProductError(`"${label}" has no choices in it. A dropdown needs at least one.`);
  }
  if (choices.every((c) => c.note)) {
    throw new CustomProductError(`Every choice under "${label}" is marked unavailable. Leave one pickable.`);
  }

  const stem = slugify(label).replace(/-/g, '') || 'option';
  let name = stem;
  let n = 2;
  while (taken.has(name)) name = `${stem}${n++}`;
  taken.add(name);

  return {
    name,
    label,
    snipcartName: label,
    required: Boolean(input?.required),
    choices,
    // Snipcart's own copy of the price list, which its crawler reads off the
    // page to check the total it was handed. Only a list that costs money
    // needs one: an unpriced dropdown on a page this file wrote has nothing
    // for the crawler to disagree with.
    priced: choices.some((c) => c.price),
  };
}

/**
 * Turns the dashboard form into a product, or throws something the page can
 * show. `existing` is the stored version when this is an edit — the id and the
 * date it was created come from there and are never read off the form.
 */
export function buildCustomProduct(input = {}, { existing = null, taken = new Set(), now = new Date() } = {}) {
  const name = oneLine(input.name, NAME_MAX);
  if (!name) throw new CustomProductError('Give it a name. That is the heading on the page.');

  const id = existing ? existing.id : slugify(input.id || name);
  if (!id) throw new CustomProductError('That name has no letters or numbers in it to make an address from.');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new CustomProductError('A web address is lower case letters, numbers and dashes.');
  }
  if (!existing && taken.has(id)) {
    throw new CustomProductError(`/product-${id} is already taken. Give this one a different address.`);
  }

  if (!CATEGORY.has(input.category)) {
    throw new CustomProductError('Pick which part of the shop it goes in.');
  }
  const category = input.category;
  const price = cleanPrice(input.price);
  const lead = LEAD.has(input.lead) ? input.lead : CATEGORY.get(category).lead;

  const names = new Set();
  const rawFields = Array.isArray(input.fields) ? input.fields : [];
  if (rawFields.length > FIELDS_MAX) {
    throw new CustomProductError(`That is more than ${FIELDS_MAX} dropdowns on one form.`);
  }
  const fields = rawFields
    .filter((f) => oneLine(f?.label, LABEL_MAX) || String(f?.choices ?? '').trim())
    .map((f) => cleanField(f, names));

  const notesLabel = oneLine(input.notesLabel, LABEL_MAX);
  const notes = input.notes
    ? {
      label: notesLabel || 'Additional Notes',
      snipcartName: notesLabel || 'Notes',
      placeholder: oneLine(input.notesPlaceholder, 120),
      required: Boolean(input.notesRequired),
    }
    : null;

  const photos = buildPhotoSet(input.photos, id, name);

  const details = (Array.isArray(input.details) ? input.details : String(input.details ?? '').split('\n'))
    .map((line) => oneLine(line, DETAIL_MAX))
    .filter(Boolean);
  if (details.length > DETAILS_MAX) {
    throw new CustomProductError(`That is more than ${DETAILS_MAX} bullets. Say less, or say it in the wording.`);
  }

  const description = block(input.description, DESCRIPTION_MAX);
  const published = Boolean(input.published);

  // A draft can be as empty as it likes. Going on the site is where it has to
  // be a real listing — an empty card in the grid reads as a broken page, not
  // as a product that is not finished yet.
  if (published && !photos.length) {
    throw new CustomProductError('Add a photo before you put it on the site. A card with no picture reads as broken.');
  }
  if (published && !description && !details.length) {
    throw new CustomProductError('Say something about it before it goes up — the wording or the bullets, either one.');
  }

  return {
    id,
    name,
    title: oneLine(input.title, TITLE_MAX) || name,
    price,
    category,
    lead,
    eyebrow: oneLine(input.eyebrow, EYEBROW_MAX) || DEFAULT_EYEBROW,
    summary: oneLine(input.summary, SUMMARY_MAX),
    description,
    details,
    feed: block(input.feed, FEED_MAX),
    photos,
    fields,
    notes,
    // Accessory use only, not PPE, not NFPA certified. Every page in the repo
    // that sells something worn on the fireground carries it.
    disclaimer: input.disclaimer !== false,
    inFeed: Boolean(input.inFeed),
    published,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/* ------------------------------------------------------------- the record */

export function customFor(record, id) {
  const product = record?.custom?.[id];
  return product && typeof product === 'object' && product.id ? product : null;
}

/** Every one the shop has made, oldest first — the order they were added in. */
export function customProducts(record) {
  return Object.values(record?.custom || {})
    .filter((p) => p && p.id)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export function customIds(record) {
  return new Set(customProducts(record).map((p) => p.id));
}

/** The ones actually on the site. An unpublished product is a draft, nothing more. */
export function liveCustomProducts(record) {
  return customProducts(record).filter((p) => p.published);
}

export function withCustomProduct(record, product) {
  return {
    ...(record || {}),
    products: record?.products || {},
    custom: { ...(record?.custom || {}), [product.id]: product },
    updatedAt: new Date().toISOString(),
  };
}

export function withoutCustomProduct(record, id) {
  const custom = { ...(record?.custom || {}) };
  delete custom[id];
  return {
    ...(record || {}),
    products: record?.products || {},
    custom,
    updatedAt: new Date().toISOString(),
  };
}

/** Every photo id the custom half of the record points at, for the R2 sweep. */
export function customPhotoIds(record) {
  const out = new Set();
  for (const product of customProducts(record)) {
    for (const photo of product.photos || []) out.add(photo.id);
  }
  return out;
}

/* ------------------------------------------------------------------ price */

/** True when picking an option can add money, which is what "From $85" means. */
export function hasUpcharge(product) {
  return (product.fields || []).some((f) => (f.choices || []).some((c) => c.price));
}

export function priceLabel(product) {
  return `${hasUpcharge(product) ? 'From ' : ''}$${product.price}`;
}

/* ----------------------------------------------------------------- markup */

/** The `<option>` children, through the same builder the repo's dropdowns use. */
function selectHtml(field) {
  const placeholder = field.required ? { text: 'Select...', required: true } : null;
  const dataOptions = field.priced ? dataOptionsString(field.choices) : '';

  return `<div class="form-row"><label for="cp-${esc(field.name)}">${esc(field.label)}${
    field.required ? '<span class="req">*</span>' : ' <span class="optional">(optional)</span>'
  }</label><select id="cp-${esc(field.name)}" name="${esc(field.name)}" data-label="${esc(field.snipcartName)}"${
    dataOptions ? ` data-options="${esc(dataOptions)}"` : ''
  }${field.required ? ' required' : ''}>${optionsHtml(field.choices, { placeholder })}</select></div>`;
}

function notesHtml(notes) {
  if (!notes) return '';
  return `<div class="form-row"><label for="cp-notes">${esc(notes.label)}${
    notes.required ? '<span class="req">*</span>' : ''
  }</label><textarea id="cp-notes" name="notes" data-label="${esc(notes.snipcartName)}"${
    notes.required ? ' required' : ''
  }${notes.placeholder ? ` placeholder="${esc(notes.placeholder)}"` : ''}></textarea></div>`;
}

export function orderFormHtml(product, { origin = 'https://rawhidecityleather.com' } = {}) {
  const image = product.photos?.length ? absolutePhotoUrl(origin, product.photos[0].id) : '';

  return `<form class="order-form" data-order-form data-product="${esc(product.name)}" ` +
    `data-snipcart-id="${esc(product.id)}" data-snipcart-price="${esc(product.price)}" ` +
    `data-snipcart-image="${esc(image)}">` +
    (product.fields || []).map(selectHtml).join('') +
    notesHtml(product.notes) +
    `<div class="form-row qty-row">
          <label for="qty-${esc(product.id)}">Quantity</label>
          <div class="qty-stepper">
            <button type="button" class="qty-btn" data-qty-step="-1" aria-label="One fewer">&minus;</button>
            <input type="number" id="qty-${esc(product.id)}" class="qty-input" data-qty value="1" min="1" max="99" step="1" inputmode="numeric" aria-label="Quantity">
            <button type="button" class="qty-btn" data-qty-step="1" aria-label="One more">+</button>
          </div>
        </div>
        <button type="submit" class="btn btn-primary btn-full">Add to Cart</button>
        <p class="form-help" style="text-align:center">Adds to cart with all your details.</p>
      </form>`;
}

/**
 * The hidden button Snipcart's crawler reads. Its fields are numbered, and the
 * numbering here has to be the order the form shows them in — that is what the
 * cart script rebuilds against when somebody adds to cart.
 *
 * `data-item-url` has no .html on it, because there is no .html: the Worker
 * builds this page out of the record. Snipcart fetches that URL to check the
 * price it was handed, so it has to be one that answers.
 */
export function buyButtonHtml(product, { origin = 'https://rawhidecityleather.com' } = {}) {
  const image = product.photos?.length ? absolutePhotoUrl(origin, product.photos[0].id) : '';
  let n = 0;
  let out = '<button hidden type="button" class="snipcart-add-item" ' +
    `data-item-id="${esc(product.id)}" data-item-price="${esc(product.price)}" ` +
    `data-item-url="/product-${esc(product.id)}" data-item-name="${esc(product.name)}" ` +
    `data-item-image="${esc(image)}"`;

  for (const field of product.fields || []) {
    n += 1;
    out += ` data-item-custom${n}-name="${esc(field.snipcartName)}"`;
    if (field.priced) out += ` data-item-custom${n}-options="${esc(dataOptionsString(field.choices))}"`;
  }

  if (product.notes) {
    n += 1;
    out += ` data-item-custom${n}-name="${esc(product.notes.snipcartName)}" data-item-custom${n}-type="textarea"`;
  }

  return `${out}></button>`;
}

/**
 * What stands in for the gallery when a product has no photographs.
 *
 * Only a draft can be in that state — publishing refuses without a photo — so
 * the only person who ever reads this is the shop, and it says what to do next
 * rather than apologising to a customer who will never see it.
 *
 * It exists because an empty .product-media collapses to nothing and takes the
 * left half of the page grid with it, and a draft opened for review then looks
 * like a broken page rather than an unfinished one.
 */
const NO_PHOTOS = '<div class="product-media-empty" style="display:flex;align-items:center;' +
  'justify-content:center;min-height:420px;padding:28px;text-align:center;' +
  'background:var(--c-bg-2);border:1px solid var(--c-line-strong)">' +
  '<div><p style="margin:0 0 8px;font-family:var(--font-display);font-weight:600;' +
  'font-size:.82rem;letter-spacing:.22em;text-transform:uppercase;color:var(--c-text)">' +
  'No photos yet</p>' +
  '<p style="margin:0;color:var(--c-text-soft);font-size:.95rem">Add them on the dashboard. ' +
  'This one cannot go on the site until it has at least one.</p></div></div>';

const DISCLAIMER = '<p class="form-help" style="margin-top:14px">Accessory use only. Not PPE and ' +
  'not NFPA certified. <a href="/shipping#use-disclaimer" style="color:var(--c-accent)">Read our ' +
  'Use Disclaimer</a>.</p>';

/** Everything inside `<main class="product-page">`. */
export function mainHtml(product, { origin = 'https://rawhidecityleather.com' } = {}) {
  return `<div class="container product-page-grid">
    <div class="product-media" data-gallery>${galleryHtml(product.photos || []) || NO_PHOTOS}</div>
    <div class="product-info">
      <p class="eyebrow">${esc(product.eyebrow)}</p>
      <h1>${esc(product.name)}</h1>
      <p class="product-price">${esc(priceLabel(product))}</p>
      ${orderFormHtml(product, { origin })}
      ${buyButtonHtml(product, { origin })}
      <div class="product-description rte">${descriptionHtml(product.description)}</div>
      <ul class="product-meta">${detailsHtml(product.details)}</ul>
      ${product.disclaimer ? DISCLAIMER : ''}
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- schema */

/** A JSON string safe to sit inside a `<script>`: `</script>` must not end it. */
function jsonValue(text) {
  return JSON.stringify(String(text ?? '')).replace(/</g, '\\u003c');
}

export function productSchema(product, { origin = 'https://rawhidecityleather.com' } = {}) {
  const url = `${origin}/product-${product.id}`;
  const image = product.photos?.length ? absolutePhotoUrl(origin, product.photos[0].id) : '';

  return '{"@context":"https://schema.org","@type":"Product",' +
    `"name":${jsonValue(product.name)},` +
    `"description":${jsonValue(product.summary || product.name)},` +
    (image ? `"image":${jsonValue(image)},` : '') +
    '"brand":{"@type":"Brand","name":"Rawhide City Leather"},' +
    `"offers":{"@type":"Offer","url":${jsonValue(url)},"priceCurrency":"USD",` +
    `"price":${jsonValue(product.price)},"availability":"https://schema.org/InStock"}}`;
}

export function breadcrumbSchema(product, { origin = 'https://rawhidecityleather.com' } = {}) {
  return '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[' +
    `{"@type":"ListItem","position":1,"name":"Home","item":${jsonValue(`${origin}/`)}},` +
    `{"@type":"ListItem","position":2,"name":"Shop","item":${jsonValue(`${origin}/shop`)}},` +
    `{"@type":"ListItem","position":3,"name":${jsonValue(product.name)},` +
    `"item":${jsonValue(`${origin}/product-${product.id}`)}}]}`;
}

/* ------------------------------------------------------------------- card */

/**
 * The card in a grid, in the shape the repo writes by hand, so the grid CSS
 * treats it like any other. No Add to Cart button on it: a card only gets one
 * where the product has nothing to pick first, and anything added here is
 * assumed to have something.
 */
export function cardHtml(product) {
  const photo = product.photos?.[0];
  if (!photo) return '';

  return `<a href="/product-${esc(product.id)}" class="product-card">` +
    `<div class="product-card-image"><img width="${photo.w}" height="${photo.h}" loading="lazy" ` +
    `src="${esc(photoUrl(photo.id))}" alt="${esc(product.name)}" onerror="this.style.opacity=.2"></div>` +
    `<div class="product-card-body"><h3>${esc(product.name)}</h3>` +
    `<p class="price">${esc(priceLabel(product))}</p></div></a>`;
}

/* ------------------------------------------------------------------- feed */

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function xml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * One `<item>`, in the shape the rest of google-merchant-feed.xml is in.
 *
 * No `<g:shipping>`, deliberately, and this is load-bearing: item-level
 * shipping OVERRIDES the account settings, and the free-over-$85 rule lives
 * there. A block here would switch that off for this product and say nothing.
 * The comment at the top of the feed says the same at more length.
 */
export function feedItemXml(product, { origin = 'https://rawhidecityleather.com' } = {}) {
  const category = categoryFor(product.category);
  const lead = LEAD.get(product.lead) || LEAD.get('1-3-weeks');

  return `    <item>
      <g:id>${xml(product.id)}</g:id>
      <g:title>${xml(product.title || product.name)}</g:title>
      <g:description>${xml(product.feed || product.summary || product.name)}</g:description>
      <g:link>${xml(`${origin}/product-${product.id}`)}</g:link>
      ${product.photos?.length ? feedImageLinks(product.photos, origin) : ''}
      <g:price>${xml(product.price)} USD</g:price>
      <g:availability>in_stock</g:availability>
      <g:condition>new</g:condition>
      <g:brand>Rawhide City Leather</g:brand>
      <g:identifier_exists>no</g:identifier_exists>
      <g:product_type>${xml(category.feedType)}</g:product_type>
      <g:google_product_category>${xml(category.googleCategory)}</g:google_product_category>
      <g:min_handling_time>${lead.min}</g:min_handling_time>
      <g:max_handling_time>${lead.max}</g:max_handling_time>
    </item>
`;
}

/**
 * Whether it is complete enough for Google. An item with no picture or no
 * description is refused on arrival, and a refused item is an account-level
 * problem rather than a quiet one.
 */
export function feedReady(product) {
  return Boolean(product.published && product.inFeed && product.photos?.length
    && (product.feed || product.summary));
}

/* ---------------------------------------------------------------- sitemap */

export function sitemapEntry(product, { origin = 'https://rawhidecityleather.com' } = {}) {
  const day = String(product.updatedAt || product.createdAt || '').slice(0, 10);
  return `  <url><loc>${xml(`${origin}/product-${product.id}`)}</loc>${
    /^\d{4}-\d{2}-\d{2}$/.test(day) ? `<lastmod>${day}</lastmod>` : ''
  }</url>\n`;
}

/* ------------------------------------------------------------------- page */

/**
 * What a donor page has to be turned into.
 *
 * The Worker serves a custom product by fetching a real product page out of the
 * repo and swapping these. The header, the footer, the fonts, the pixel and the
 * cart script then come from the site itself, and cannot drift out of date with
 * it — which is the whole reason for building the page this way rather than
 * writing the chrome out here where it would have to be maintained twice.
 */
export function pageRules(product, { origin = 'https://rawhidecityleather.com' } = {}) {
  const url = `${origin}/product-${product.id}`;
  const title = `${product.title || product.name} · Rawhide City Leather`;
  const summary = product.summary || product.name;
  const image = product.photos?.length ? absolutePhotoUrl(origin, product.photos[0].id) : '';

  const rules = [
    { selector: 'title', action: 'inner', value: esc(title) },
    { selector: 'link[rel="canonical"]', action: 'attr', name: 'href', value: url },
    { selector: 'meta[name="description"]', action: 'attr', name: 'content', value: summary },
    { selector: 'meta[property="og:title"]', action: 'attr', name: 'content', value: title },
    { selector: 'meta[property="og:description"]', action: 'attr', name: 'content', value: summary },
    { selector: 'meta[property="og:url"]', action: 'attr', name: 'content', value: url },
    { selector: 'meta[name="twitter:description"]', action: 'attr', name: 'content', value: summary },
    {
      // Both blocks, replaced outright rather than patched field by field: the
      // donor's are about the donor, and nothing in them is worth keeping.
      selector: 'script[type="application/ld+json"]',
      action: 'blocks',
      values: [productSchema(product, { origin }), breadcrumbSchema(product, { origin })],
    },
    { selector: 'main.product-page', action: 'inner', value: mainHtml(product, { origin }) },
  ];

  if (image) {
    rules.push({ selector: 'meta[property="og:image"]', action: 'attr', name: 'content', value: image });
    rules.push({ selector: 'meta[name="twitter:image"]', action: 'attr', name: 'content', value: image });
  }

  // A draft is not a page Google should be holding on to. It answers, so the
  // shop can look at it before it goes up, and it says so to anything crawling.
  if (!product.published) {
    rules.push({ selector: 'head', action: 'append', value: '<meta name="robots" content="noindex">' });
  }

  return rules;
}

export { choicesToText, choicesFromText, OptionError, PhotoError, CHOICES_MAX };
