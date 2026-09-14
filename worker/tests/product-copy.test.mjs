/**
 * Product wording: the fields, the markup, reading the repo's own copy back
 * out of a page, the two content rules, and the whole thing driven through the
 * real Worker against real page and feed markup.
 */

import { suite, check, throws } from './harness.mjs';
import { installHTMLRewriterShim } from './html-rewriter-shim.mjs';
import worker from '../index.js';
import {
  buildCopy, copyFor, effectiveCopy, descriptionHtml, detailsHtml, decodeEntities,
  extractCopy, extractFeedDescription, contentWarnings, copyRules,
  DETAILS_MAX, SUMMARY_MAX,
} from '../product-copy.js';
import { rewriteFeed, catalogRules, withSchemaFields, touchedProducts } from '../catalog.js';
import { withoutBuiltIn, renderProductsPage, productsScript } from '../products-page.js';

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

function makeR2() {
  const store = new Map();
  return {
    async put(key, body) { store.set(key, body); },
    async get(key) { return store.has(key) ? { body: store.get(key), httpMetadata: {}, httpEtag: '"e"' } : null; },
    async head(key) { return store.has(key) ? { key } : null; },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

/**
 * A product page shaped like the repo's: two JSON-LD blocks, the wording block,
 * the bullets, and — as the helmet band really does — a SECOND
 * `.product-description` further down holding long-form guide copy that is not
 * edited here and must not be touched.
 */
const PAGE = `<!doctype html><html><head>
<meta name="description" content="Hand-cut 10-12 oz English bridle leather helmet band, rubber-backed so it stays put.">
<meta property="og:description" content="Hand-cut 10-12 oz English bridle leather helmet band, rubber-backed so it stays put.">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Leather Firefighter Helmet Band","description":"Hand-cut 10-12 oz English bridle leather helmet band, rubber-backed so it stays put.","image":"https://rawhidecityleather.com/assets/img/products/helmet-band.jpg","offers":{"price":"50.00"}}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}
</script>
</head><body>
<div class="product-media" data-gallery><img class="product-main-image" data-main src="assets/img/products/helmet-band.webp" alt="old"></div>
<div class="product-description rte"><p>The helmet band that earns its spot. Cut from a single piece of 10&ndash;12 oz English bridle leather, and backed with <strong style="color:var(--c-cream)">a rubber layer</strong> to keep it from slipping.</p><p>All helmet bands are 31 inches unless otherwise noted.</p></div>
<ul class="product-meta">
  <li>10&ndash;12 oz English bridle leather</li>
  <li>Rubber backing to prevent slipping off the helmet</li>
  <li>1&ndash;3 week lead time</li>
</ul>
<div class="product-description rte" style="margin-top:28px">
  <h2>Leather or rubber?</h2>
  <p>A rubber band costs six dollars and does one job.</p>
</div>
</body></html>`;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>
    <item>
      <g:id>fully-custom-radio-strap</g:id>
      <g:description>Custom leather firefighter radio strap built to your spec.</g:description>
      <g:image_link>https://rawhidecityleather.com/assets/img/products/fully-custom-radio-strap.jpg</g:image_link>
      <g:price>165.00 USD</g:price>
    </item>
    <item>
      <g:id>helmet-band</g:id>
      <g:description>Leather fire helmet band hand-cut from 10-12 oz English bridle leather. Custom stamping at no extra cost.</g:description>
      <g:image_link>https://rawhidecityleather.com/assets/img/products/helmet-band.jpg</g:image_link>
      <g:price>50.00 USD</g:price>
    </item>
</channel></rss>`;

export default async function run() {
  installHTMLRewriterShim();

  suite('copy — the fields');

  const made = buildCopy({
    description: 'First line.\n\n\n\nSecond   paragraph.',
    details: 'One\n\n  Two  \nThree',
    summary: '  A   summary  ',
    feed: 'For the feed.',
  });
  check('paragraph breaks survive, extra blank lines do not',
    made.description === 'First line.\n\nSecond paragraph.');
  check('bullets come off one per line, blanks dropped',
    made.details.join('|') === 'One|Two|Three');
  check('the summary is squeezed to one line', made.summary === 'A summary');

  check('an empty form is no override at all', buildCopy({}) === null);
  check('so is one full of whitespace',
    buildCopy({ description: '   ', details: '\n\n', summary: '', feed: '  ' }) === null);
  check('one field alone is enough to count',
    buildCopy({ summary: 'Just this' })?.summary === 'Just this');
  check('a details array is accepted as well as a block of text',
    buildCopy({ details: ['A', 'B'] }).details.length === 2);

  throws('too many bullets is refused',
    () => buildCopy({ details: Array.from({ length: DETAILS_MAX + 1 }, (_, i) => 'b' + i) }),
    'more than');
  check('a runaway summary is cut, not refused',
    buildCopy({ summary: 'x'.repeat(900) }).summary.length === SUMMARY_MAX);

  suite('copy — what the page is showing');

  const builtIn = { description: 'Repo words.', details: ['Repo bullet'], summary: 'Repo summary.', feed: 'Repo feed.' };
  const partial = { summary: 'New summary.' };
  const showing = effectiveCopy(partial, builtIn);
  check('a changed field is the shop’s', showing.summary === 'New summary.');
  check('an unchanged one is still the repo’s', showing.description === 'Repo words.');
  check('and so are the bullets', showing.details.join() === 'Repo bullet');
  check('nothing saved shows the repo throughout',
    effectiveCopy(null, builtIn).description === 'Repo words.');

  suite('copy — dropping what matches the repo');

  check('wording identical to the repo is not stored at all',
    withoutBuiltIn({ description: 'Repo words.', details: ['Repo bullet'], summary: 'Repo summary.', feed: 'Repo feed.' }, builtIn) === null);
  check('whitespace alone is not a change',
    withoutBuiltIn({ description: '  Repo words.  ' }, builtIn) === null);
  const oneChange = withoutBuiltIn({ description: 'Repo words.', summary: 'Different.' }, builtIn);
  check('only the field that moved is kept',
    Object.keys(oneChange).join() === 'summary' && oneChange.summary === 'Different.');
  check('a changed bullet list is kept whole',
    withoutBuiltIn({ details: ['Repo bullet', 'And another'] }, builtIn).details.length === 2);

  suite('copy — the markup');

  check('a paragraph is a paragraph',
    descriptionHtml('One.') === '<p>One.</p>');
  check('a blank line starts another',
    descriptionHtml('One.\n\nTwo.') === '<p>One.</p><p>Two.</p>');
  check('a single break stays inside the paragraph',
    descriptionHtml('One.\nTwo.') === '<p>One.<br>Two.</p>');
  check('two stars make the same highlight the repo uses',
    descriptionHtml('The **sway strap** comes with it.')
      === '<p>The <strong style="color:var(--c-cream)">sway strap</strong> comes with it.</p>');
  check('bullets become list items', detailsHtml(['A', 'B']) === '<li>A</li><li>B</li>');
  check('nothing in, nothing out', descriptionHtml('') === '' && detailsHtml([]) === '');

  const attack = descriptionHtml('<img src=x onerror=alert(1)> and <script>bad()</script>');
  check('typed markup is text, never markup',
    attack.includes('&lt;img') && !attack.includes('<img') && !attack.includes('<script>'));
  check('a quote comes out as a quote, however it is spelled on the way',
    decodeEntities(descriptionHtml('Cut 1.5" wide')) === '<p>Cut 1.5" wide</p>');

  suite('copy — reading what the repo says');

  const read = extractCopy(PAGE);
  check('both paragraphs come back, split by a blank line',
    read.description.split('\n\n').length === 2);
  check('entities come back as characters',
    read.description.includes('10–12 oz') && !read.description.includes('&ndash;'));
  check('a highlight comes back as two stars',
    read.description.includes('**a rubber layer**'));
  check('the guide copy further down the page is NOT read as the description',
    !read.description.includes('rubber band costs six dollars'));
  check('the bullets come back in order',
    read.details.length === 3 && read.details[2] === '1–3 week lead time');
  check('and the search summary off the meta tag',
    read.summary.startsWith('Hand-cut 10-12 oz'));
  check('a page that could not be read is empty, not broken',
    extractCopy('').description === '' && extractCopy('').details.length === 0);

  check('the feed description is its own text',
    extractFeedDescription(FEED, 'helmet-band').startsWith('Leather fire helmet band'));
  check('and it is the right product’s',
    extractFeedDescription(FEED, 'fully-custom-radio-strap').startsWith('Custom leather firefighter'));
  check('a product not in the feed is empty', extractFeedDescription(FEED, 'leather-butter') === '');

  check('what is read back survives being written out again', (() => {
    const round = extractCopy(PAGE);
    const html = descriptionHtml(round.description);
    return html.includes('<strong style="color:var(--c-cream)">a rubber layer</strong>')
      && html.includes('10–12 oz')
      && (html.match(/<p>/g) || []).length === 2;
  })());

  check('entities decode, including numeric ones',
    decodeEntities('3&quot; patch &#38; more &#x2014; done') === '3" patch & more — done');

  suite('copy — the two rules the shop set');

  const warnOf = (product, copy) => contentWarnings(product, copy).map((w) => w.field + ':' + w.message);

  check('hand-stitched is flagged',
    warnOf('helmet-band', { description: 'Every strap is hand-stitched.' })[0].includes('walking-foot machine'));
  check('so is stitched by hand, spelled out',
    warnOf('helmet-band', { feed: 'Each one stitched by hand.' }).length === 1);
  check('hand-stamped is fine, it is true',
    warnOf('helmet-band', { description: 'Hand-stamped and hand-cut.' }).length === 0);

  check('Lakeland in product wording is flagged',
    warnOf('helmet-band', { summary: 'Made in Lakeland, FL.' })[0].includes('provenance'));
  check('so is firefighter owned',
    warnOf('helmet-band', { description: 'A firefighter-owned shop.' }).length === 1);
  check('but for firefighters is fine, that is the audience',
    warnOf('helmet-band', { description: 'Built for firefighters.' }).length === 0);

  check('hand-cut on a hat is flagged, because the patch is lasered',
    warnOf('my-wife-beats-me-hat', { description: 'Hand-cut patch.' })[0].includes('laser cut'));
  check('hand-cut on a strap is not, because it really is',
    warnOf('helmet-band', { description: 'Hand-cut from bridle leather.' }).length === 0);

  check('the field that tripped is named',
    contentWarnings('helmet-band', { feed: 'Made in Lakeland.' })[0].where.includes('Google Shopping'));
  check('clean wording says nothing', warnOf('helmet-band', { description: 'Full-grain, built to last.' }).length === 0);
  check('nothing saved says nothing', contentWarnings('helmet-band', null).length === 0);

  suite('copy — where it lands');

  const rules = copyRules({ description: 'New words.', details: ['A'], summary: 'New summary.' });
  const has = (selector) => rules.some((r) => r.selector === selector);
  check('the wording block', has('.product-description'));
  check('and only the first one on the page',
    rules.find((r) => r.selector === '.product-description').once === true);
  check('the bullets', has('ul.product-meta'));
  check('the search result line', has('meta[name="description"]'));
  check('the share preview', has('meta[property="og:description"]'));
  check('the structured data', has('script[type="application/ld+json"]'));
  check('a field left alone lands nowhere',
    !copyRules({ summary: 'Only this.' }).some((r) => r.selector === '.product-description'));
  check('nothing saved lands nowhere at all', copyRules(null).length === 0);

  check('the structured data gets the summary, not the page wording',
    rules.find((r) => r.action === 'schema').description === 'New summary.');

  suite('copy — the structured data');

  const withDesc = withSchemaFields(
    '{"@type":"Product","description":"Old.","image":"a.jpg","name":"X"}',
    { description: 'New.', image: 'b.webp' }
  );
  check('both fields swap at once',
    withDesc.includes('"description":"New."') && withDesc.includes('"image":"b.webp"'));
  check('the name is left alone', withDesc.includes('"name":"X"'));
  check('it is still JSON', (() => JSON.parse(withDesc).description === 'New.')());
  check('a quote in the wording does not break the block', (() => {
    const out = withSchemaFields('{"@type":"Product","description":"Old."}', { description: 'Cut 1.5" wide' });
    return JSON.parse(out).description === 'Cut 1.5" wide';
  })());
  check('a closing script tag cannot end the block early', (() => {
    const out = withSchemaFields('{"@type":"Product","description":"Old."}',
      { description: 'a </script> b' });
    return !out.includes('</script>') && JSON.parse(out).description === 'a </script> b';
  })());

  suite('copy — the Google feed');

  const feed = rewriteFeed(FEED, recordOf({ 'helmet-band': { copy: { feed: 'A new feed description.' } } }),
    'https://rawhidecityleather.com');
  check('the description is swapped',
    feed.includes('<g:description>A new feed description.</g:description>'));
  check('the item above it keeps its own',
    feed.includes('<g:description>Custom leather firefighter radio strap built to your spec.</g:description>'));
  check('the images are left alone, nothing was said about them',
    feed.includes('products/helmet-band.jpg'));
  check('an ampersand is escaped, so the feed still parses',
    rewriteFeed(FEED, recordOf({ 'helmet-band': { copy: { feed: 'Black & brown' } } }), 'https://x')
      .includes('<g:description>Black &amp; brown</g:description>'));
  check('and so is a bracket',
    rewriteFeed(FEED, recordOf({ 'helmet-band': { copy: { feed: '1.5" <wide>' } } }), 'https://x')
      .includes('&lt;wide&gt;'));

  suite('copy — through the Worker');

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
        if (p === '/product-helmet-band') {
          return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
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

  const dash = await (await get('/dashboard/products', { Authorization: AUTH })).text();
  check('the editor opens on what the repo says, not an empty box',
    dash.includes('The helmet band that earns its spot'));
  check('with the bullets filled in too', dash.includes('Rubber backing to prevent slipping'));
  check('and the feed description in its own field',
    dash.includes('Leather fire helmet band hand-cut'));
  check('the guide copy is not dragged into the wording box',
    !dash.includes('A rubber band costs six dollars'));

  const unchanged = await post('/dashboard/api/photos', {
    productId: 'helmet-band',
    photos: [],
    copy: {
      description: extractCopy(PAGE).description,
      details: extractCopy(PAGE).details,
      summary: extractCopy(PAGE).summary,
      feed: extractFeedDescription(FEED, 'helmet-band'),
    },
  }, DASH);
  check('saving a row nobody edited stores nothing', unchanged.status === 200);
  check('and leaves the record empty',
    touchedProducts(JSON.parse(env.CATALOG._store.get('catalog') || '{}')).length === 0);

  const saved = await post('/dashboard/api/photos', {
    productId: 'helmet-band',
    photos: [],
    copy: {
      description: 'Cut from one piece. **Rubber backed** so it stays put.\n\nThirty-one inches.',
      details: extractCopy(PAGE).details,
      summary: 'A leather helmet band that holds your front piece flat.',
      feed: 'Leather fire helmet band, 31 inches, rubber backed. Black, brown or chestnut.',
    },
  }, DASH);
  const savedBody = await saved.json();
  check('a real change saves', saved.status === 200 && savedBody.ok === true);
  check('and comes back with nothing to flag', savedBody.warnings.length === 0);
  check('the bullets were left matching the repo, so they were not stored', (() => {
    const stored = JSON.parse(env.CATALOG._store.get('catalog')).products['helmet-band'].copy;
    return !stored.details && !!stored.description && !!stored.summary && !!stored.feed;
  })());

  const live = await (await get('/product-helmet-band')).text();
  check('the page shows the new wording',
    live.includes('<p>Cut from one piece.') && live.includes('<p>Thirty-one inches.</p>'));
  check('the highlight renders as the repo styles it',
    live.includes('<strong style="color:var(--c-cream)">Rubber backed</strong>'));
  check('the old wording is gone', !live.includes('earns its spot'));
  check('the guide copy further down is untouched',
    live.includes('A rubber band costs six dollars and does one job.'));
  check('the bullets are still the repo’s', live.includes('Rubber backing to prevent slipping'));
  check('the search result line changed',
    live.includes('content="A leather helmet band that holds your front piece flat."'));
  check('the share preview with it',
    (live.match(/A leather helmet band that holds your front piece flat\./g) || []).length >= 3);
  check('the structured data says the summary and still parses', (() => {
    const blocks = [...live.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const product = JSON.parse(blocks[0][1].trim());
    return blocks.length === 2 && product.description === 'A leather helmet band that holds your front piece flat.'
      && product.name === 'Leather Firefighter Helmet Band'
      && JSON.parse(blocks[1][1].trim())['@type'] === 'BreadcrumbList';
  })());

  const xml = await (await get('/google-merchant-feed.xml')).text();
  check('the feed carries the new description',
    xml.includes('<g:description>Leather fire helmet band, 31 inches, rubber backed. Black, brown or chestnut.</g:description>'));
  check('and the other product is untouched',
    xml.includes('<g:description>Custom leather firefighter radio strap built to your spec.</g:description>'));

  const flagged = await post('/dashboard/api/photos', {
    productId: 'helmet-band',
    photos: [],
    copy: { description: 'Every strap hand-stitched here in Lakeland, FL.' },
  }, DASH);
  const flaggedBody = await flagged.json();
  check('wording that breaks a rule still saves', flagged.status === 200);
  check('but the save says what it tripped', flaggedBody.warnings.length === 2);
  check('and names both rules',
    flaggedBody.warnings.some((w) => w.message.includes('walking-foot')) &&
    flaggedBody.warnings.some((w) => w.message.includes('provenance')));

  const reset = await post('/dashboard/api/photos', {
    productId: 'helmet-band',
    photos: [],
    copy: {
      description: extractCopy(PAGE).description,
      details: extractCopy(PAGE).details,
      summary: extractCopy(PAGE).summary,
      feed: extractFeedDescription(FEED, 'helmet-band'),
    },
  }, DASH);
  check('putting it back to the repo’s words saves', reset.status === 200);
  const back = await (await get('/product-helmet-band')).text();
  check('and the page is the repo’s again', back.includes('earns its spot'));
  check('down to the entity it was written with', back.includes('10&ndash;12 oz'));
  check('the feed too', (await (await get('/google-merchant-feed.xml')).text()) === FEED);

  suite('copy — the dashboard page');

  const record = recordOf({ 'helmet-band': { copy: { summary: 'A summary.' } } });
  const html = renderProductsPage(record, { ready: true, builtIn: { 'helmet-band': builtIn } });
  check('the row says wording was changed', html.includes('wording'));
  check('every wording field has a box',
    ['description', 'details', 'summary', 'feed']
      .every((f) => html.includes(`data-copy="${f}" data-for="helmet-band"`)));
  check('the box holds what is showing, override first', html.includes('A summary.'));
  check('and the repo’s text where nothing was changed', html.includes('Repo words.'));
  check('it explains the two stars', html.includes('**Two stars**'));

  const script = productsScript(record, { 'helmet-band': builtIn });
  check('the script carries the repo text so a reset has something to go back to',
    script.includes('Repo words.'));
  check('and the checks, so a line is flagged while it is typed',
    script.includes('walking-foot') && !script.includes('__CHECKS__'));
  check('every placeholder is filled',
    !script.includes('__STATE__') && !script.includes('__HATS__') && !script.includes('__IDEAL__'));
}
