/**
 * Product wording, changed from the dashboard instead of from the repo.
 *
 * The photo side of this went in first (worker/photos.js). This is the words:
 * the paragraphs on the product page, the spec bullets under them, the line
 * Google shows under the search result, and the longer description in the
 * Shopping feed. Four fields, and between them they reach six places in a page
 * and one in the feed.
 *
 * Every field is optional and empty means the same thing everywhere here: use
 * what the repo says. That is why the dashboard can hand back a product with
 * one sentence changed and nothing else — the other three keep coming out of
 * `product-<id>.html`, and the page is the fallback for all of it.
 *
 * The wording box is plain text, not HTML. A blank line starts a paragraph and
 * `**like this**` goes bold, matching the highlight the repo's pages already
 * use. Nothing else is markup: a product description is not a place to be
 * writing tags, and anything typed in is escaped before it reaches the page.
 *
 * This file has no side effects and touches no bindings. It takes text and
 * returns text, which is what makes the checks at the bottom testable.
 */

import { esc } from './lib.js';

/** Generous, and short enough that a runaway paste cannot fill a KV record. */
export const DESCRIPTION_MAX = 4000;
export const DETAIL_MAX = 200;
export const DETAILS_MAX = 20;
export const SUMMARY_MAX = 320;
/** Google Merchant's own cap on a product description. */
export const FEED_MAX = 5000;

/**
 * What Google shows under a search result before it cuts the line off. Not a
 * limit — a longer one is legal and simply gets truncated — so the page counts
 * toward it rather than refusing at it.
 */
export const SUMMARY_IDEAL = 155;

export class CopyError extends Error {}

/* ------------------------------------------------------------------ model */

function oneLine(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Keeps paragraph breaks, drops the rest of the whitespace noise. */
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
 * Turns the dashboard form into one product's wording, or throws a CopyError
 * the page can show. Returns null when every field is empty: no record at all
 * and "all four fields cleared" have to mean the same thing, or the reset
 * button would leave a husk behind that still counts as an override.
 */
export function buildCopy(input = {}) {
  const description = block(input.description, DESCRIPTION_MAX);
  const summary = oneLine(input.summary, SUMMARY_MAX);
  const feed = block(input.feed, FEED_MAX);

  const rawDetails = Array.isArray(input.details)
    ? input.details
    : String(input.details ?? '').split('\n');
  const details = rawDetails
    .map((line) => oneLine(line, DETAIL_MAX))
    .filter(Boolean);

  if (details.length > DETAILS_MAX) {
    throw new CopyError(`That is more than ${DETAILS_MAX} bullets. Say less, or say it in the wording above.`);
  }

  if (!description && !summary && !feed && !details.length) return null;
  return { description, details, summary, feed };
}

export function copyFor(record, product) {
  const copy = record?.products?.[product]?.copy;
  return copy && typeof copy === 'object' ? copy : null;
}

/** What the site is actually showing, field by field: the override or the repo. */
export function effectiveCopy(copy, builtIn = {}) {
  const pick = (a, b) => (a && String(a).length ? a : (b || ''));
  return {
    description: pick(copy?.description, builtIn.description),
    details: copy?.details?.length ? copy.details : (builtIn.details || []),
    summary: pick(copy?.summary, builtIn.summary),
    feed: pick(copy?.feed, builtIn.feed),
  };
}

/* ----------------------------------------------------------------- markup */

/**
 * Plain text to paragraphs. Escaped first, so the only markup in the result is
 * the markup this function put there. `**bold**` becomes the same highlighted
 * strong the repo's own pages use, so a paragraph written here and one written
 * in the HTML look identical on the page.
 */
export function descriptionHtml(text) {
  const paragraphs = String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return '';
  return paragraphs
    .map((p) => `<p>${inline(p)}</p>`)
    .join('');
}

export function detailsHtml(items) {
  const list = (items || []).map((item) => String(item).trim()).filter(Boolean);
  if (!list.length) return '';
  return list.map((item) => `<li>${inline(item)}</li>`).join('');
}

/**
 * A single line break inside a paragraph becomes a <br>, because somebody
 * writing a list of colours will press Enter once and mean it.
 */
function inline(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--c-cream)">$1</strong>')
    .replace(/\n/g, '<br>');
}

/* ------------------------------------------------- reading the repo's copy */

const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  times: '×', starf: '★', deg: '°', frac12: '½',
}));

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES.has(body) ? ENTITIES.get(body) : whole;
  });
}

/** Markup back to the plain text the dashboard edits. The inverse of inline(). */
function toPlain(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+/g, ' ').trim();
}

/**
 * The wording a product page carries in the repo, so the dashboard can show
 * what the site says today rather than an empty box. Retyping five sentences
 * to change one is not editing, it is rewriting, and nobody does it twice.
 *
 * Only the FIRST `.product-description` is the description. The helmet band
 * carries a second one further down the page holding its long-form guide
 * copy — "Leather or rubber?", the questions — and that block is not edited
 * here and must not be read as if it were.
 */
export function extractCopy(html) {
  const page = String(html || '');

  const descBlock = /<div class="product-description rte"[^>]*>([\s\S]*?)<\/div>/i.exec(page);
  const paragraphs = descBlock
    ? [...descBlock[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => toPlain(m[1])).filter(Boolean)
    : [];

  const metaBlock = /<ul class="product-meta">([\s\S]*?)<\/ul>/i.exec(page);
  const details = metaBlock
    ? [...metaBlock[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => toPlain(m[1])).filter(Boolean)
    : [];

  const summaryTag = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(page);

  return {
    description: paragraphs.join('\n\n'),
    details,
    summary: summaryTag ? decodeEntities(summaryTag[1]).trim() : '',
  };
}

/** The Shopping feed says it differently and at more length. Its own field. */
export function extractFeedDescription(xml, product) {
  const item = itemFor(xml, product);
  if (!item) return '';
  const found = /<g:description>([\s\S]*?)<\/g:description>/i.exec(item);
  return found ? decodeEntities(found[1]).trim() : '';
}

/** The one `<item>` for a product. Items do not nest, so lazy is exact here. */
export function itemFor(xml, product) {
  for (const match of String(xml || '').matchAll(/<item>[\s\S]*?<\/item>/g)) {
    const id = /<g:id>([^<]*)<\/g:id>/.exec(match[0])?.[1];
    if (id === product) return match[0];
  }
  return null;
}

/* ------------------------------------------------------------- the checks */

/**
 * Two rules the shop set itself, and one that only applies to the hats. None
 * of them blocks a save — it is his shop and his wording — but a save says so
 * plainly, and the page says it while the words are still being typed.
 *
 * They are here rather than in somebody's head because both were caught the
 * expensive way: a "hand-stitched" line ran over footage of the machine doing
 * the stitching, and provenance in a description had to be pulled back out of
 * eight pages and the feed.
 */
export const HAT_IDS = ['leather-patch-hat', 'my-wife-beats-me-hat', 'scream-for-daddy-hat'];

/**
 * Held as pattern strings rather than literals so the dashboard's own script
 * can rebuild the same regexes and flag a line while it is still being typed.
 * One definition, checked in both places — two copies would drift, and the one
 * that drifted would be the one nobody was looking at.
 */
export const CONTENT_CHECKS = [
  {
    pattern: 'hand[\\s-]?stitch|stitch(?:ed|ing)?\\s+by\\s+hand|every\\s+stitch',
    message: 'The stitching is done on a walking-foot machine, not by hand. ' +
      'Hand-stamped and hand-cut are both still true.',
  },
  {
    pattern: 'lakeland|firefighter[\\s-]?owned|firefighter\\s+owned',
    message: 'Location and owner provenance stay off product wording. ' +
      'The banner, the footer and the About page carry it instead.',
  },
  {
    // The patch on a hat is laser cut and engraved, then heat-pressed. There
    // is no handwork anywhere in it, and crisp repeatable crests are the
    // actual selling point on a crew order.
    hatsOnly: true,
    pattern: 'hand[\\s-]?cut|cut\\s+by\\s+hand|engraved\\s+by\\s+hand|hand[\\s-]?finish',
    message: 'The patch on a hat is laser cut and engraved, then heat-pressed. ' +
      'Nothing on it is cut or finished by hand.',
  },
];

const FIELD_LABEL = {
  description: 'the wording',
  details: 'the bullets',
  summary: 'the search summary',
  feed: 'the Google Shopping description',
};

/**
 * Every rule a product's wording trips, with the field it tripped on. Returns
 * [] for wording that is fine, which is what the page checks for.
 */
export function contentWarnings(product, copy, { hats = null } = {}) {
  if (!copy) return [];
  // A hat added from the dashboard is not in HAT_IDS and never will be, so the
  // caller can say. Everything else asks the list, which is the three in the repo.
  const isHat = hats === null ? HAT_IDS.includes(product) : hats;
  const warnings = [];

  for (const [field, label] of Object.entries(FIELD_LABEL)) {
    const value = field === 'details' ? (copy.details || []).join('\n') : (copy[field] || '');
    if (!value) continue;
    for (const check of CONTENT_CHECKS) {
      if (check.hatsOnly && !isHat) continue;
      if (new RegExp(check.pattern, 'i').test(value)) {
        warnings.push({ field, where: label, message: check.message });
      }
    }
  }

  return warnings;
}

/* ------------------------------------------------------------------ rules */

/**
 * Where a product's wording lands in its page, as plain data — the same shape
 * photos.js produces, so one applier handles both. `once` is on the wording
 * block because a page can carry a second one: see extractCopy.
 */
export function copyRules(copy, builtIn = {}) {
  if (!copy) return [];
  const rules = [];
  const showing = effectiveCopy(copy, builtIn);

  if (copy.description) {
    rules.push({
      selector: '.product-description',
      action: 'inner',
      once: true,
      value: descriptionHtml(copy.description),
    });
  }

  if (copy.details?.length) {
    rules.push({ selector: 'ul.product-meta', action: 'inner', value: detailsHtml(copy.details) });
  }

  if (copy.summary) {
    for (const selector of [
      'meta[name="description"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
    ]) {
      rules.push({ selector, action: 'attr', name: 'content', value: copy.summary });
    }
  }

  // The structured data's description is the search summary, not the page
  // wording: it sits beside the same fields Google reads off the meta tags,
  // and a paragraph of prose there says something different from the line
  // above it for no reason.
  if (showing.summary && copy.summary) {
    rules.push({ selector: 'script[type="application/ld+json"]', action: 'schema', description: copy.summary });
  }

  return rules;
}
