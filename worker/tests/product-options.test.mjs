/**
 * The choices on the order form: the syntax, reading a page's dropdowns back
 * out of it, the markup, and the two places a priced list has to land — driven
 * through the real Worker against a form shaped like the repo's.
 */

import { suite, check, throws } from './harness.mjs';
import { installHTMLRewriterShim } from './html-rewriter-shim.mjs';
import worker from '../index.js';
import {
  parseChoice, choicesFromText, choicesToText, buildOptions, optionsFor,
  effectiveChoices, withoutBuiltInOptions, optionsHtml, dataOptionsString,
  needsDataOptions, extractOptions, optionRules, CHOICES_MAX, PRICE_MAX,
} from '../product-options.js';
import { catalogRules, touchedProducts } from '../catalog.js';
import { renderProductsPage, productsScript } from '../products-page.js';

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
  return {
    async put() {}, async delete() {},
    async get() { return null; },
    async head() { return null; },
  };
}

/**
 * The radio bucket's form, cut down but shaped exactly like the repo's: a
 * plain dropdown, a priced one that starts on a default rather than making you
 * choose, a locked one that drives the artwork slots, and the hidden buy
 * button Snipcart's crawler reads.
 */
const PAGE = `<!doctype html><html><body>
<form class="order-form" data-order-form data-product="Radio Bucket" data-snipcart-id="radio-bucket" data-snipcart-price="40.00">
  <div class="form-row"><label for="rb-leather">Leather Color<span class="req">*</span></label><select id="rb-leather" name="leather" data-label="Leather color" required><option value="" disabled selected hidden>Select...</option><option>Black</option><option>Chestnut</option></select></div>
  <div class="form-row"><label for="rb-hardware">Hardware Finish<span class="req">*</span></label><select id="rb-hardware" name="hardware" data-label="Hardware finish" required><option value="" disabled selected hidden>Select...</option><option>Black</option><option>Brass</option><option>Nickel</option></select></div>
  <div class="form-row"><label for="rb-stitch">Stitch Color<span class="req">*</span></label><select id="rb-stitch" name="stitch" data-label="Stitch color" data-options="No stitching|White[+10.00]|Red[+10.00]" required><option value="No stitching" selected>No stitching</option><option value="White">White (+$10.00)</option><option value="Red">Red (+$10.00)</option></select></div>
  <div class="form-row"><label for="rb-stamps">Custom Stamps</label><select id="rb-stamps" name="customstamps" data-label="Custom stamps" data-options="None|1 custom stamp[+15.00]" data-logo-count><option value="None" selected>None</option><option value="1 custom stamp">1 custom stamp (+$15.00)</option></select></div>
  <div class="form-row"><label for="rb-notes">Notes</label><textarea id="rb-notes" name="notes" data-label="Notes"></textarea></div>
</form>
<button hidden type="button" class="snipcart-add-item" data-item-id="radio-bucket" data-item-price="40.00" data-item-url="/product-radio-bucket.html" data-item-name="Radio Bucket" data-item-custom1-name="Leather color" data-item-custom2-name="Hardware finish" data-item-custom3-name="Stitch color" data-item-custom3-options="No stitching|White[+10.00]|Red[+10.00]" data-item-custom4-name="Custom stamps" data-item-custom4-options="None|1 custom stamp[+15.00]" data-item-custom5-name="Notes" data-item-custom5-type="textarea"></button>
</body></html>`;

const FEED = `<?xml version="1.0"?><rss xmlns:g="http://base.google.com/ns/1.0"><channel>
<item><g:id>radio-bucket</g:id><g:description>A bucket.</g:description><g:image_link>x.jpg</g:image_link></item>
</channel></rss>`;

export default async function run() {
  installHTMLRewriterShim();

  suite('options — the syntax');

  const one = (line) => { const c = parseChoice(line); return `${c.value}|${c.price}|${c.note}`; };
  check('a plain choice is a name', one('White') === 'White||');
  check('a plus makes it cost money', one('White +10') === 'White|10.00|');
  check('two dashes make it unavailable, and say why',
    one('Brown -- out of stock') === 'Brown||out of stock');
  check('an em dash does the same, since that is what the page shows',
    one('Brown \u2014 no hide left') === 'Brown||no hide left');
  check('two dashes with nothing after them still say something',
    one('Brown --') === 'Brown||out of stock');
  check('a price and a reason can sit on one line',
    one('Gold +5.00 -- back in June') === 'Gold|5.00|back in June');
  check('a dollar sign is allowed and ignored', parseChoice('White +$10.50').price === '10.50');
  check('spacing around the plus does not matter', parseChoice('Navy Blue   +  10.00').value === 'Navy Blue');
  check('a name with a number in it still reads as a name',
    parseChoice('50"-56"').value === '50"-56"' && parseChoice('50"-56"').price === '');
  check('a blank line is not a choice', parseChoice('   ') === null);

  throws('a price with no name is refused', () => parseChoice('+10.00'), 'needs a name');
  throws('a silly price is refused', () => parseChoice(`Gold +${PRICE_MAX + 1}`), 'not a price');
  throws('a free upcharge is refused', () => parseChoice('White +0'), 'not a price');

  const list = choicesFromText('No stitching\nWhite +10.00\n\nRed +10.00\n');
  check('a list comes off one per line, blanks dropped', list.length === 3);
  check('and keeps its order', list.map((c) => c.value).join() === 'No stitching,White,Red');
  check('it round-trips through the box',
    choicesToText(list) === 'No stitching\nWhite +10.00\nRed +10.00');

  throws('the same choice twice is refused', () => choicesFromText('White\nwhite'), 'twice');
  throws('too many choices is refused',
    () => choicesFromText(Array.from({ length: CHOICES_MAX + 1 }, (_, i) => 'c' + i).join('\n')),
    'more than');

  suite('options — reading a page’s dropdowns');

  const fields = extractOptions(PAGE);
  check('every dropdown is found, and nothing else',
    fields.map((f) => f.name).join() === 'leather,hardware,stitch,customstamps');
  check('the label comes off the form, without its asterisk',
    fields[0].label === 'Leather Color' && fields[1].label === 'Hardware Finish');
  check('a required field is marked required', fields[0].required === true);
  check('the "Select..." row is not read as a choice',
    fields[0].choices.length === 2 && fields[0].choices[0].value === 'Black');
  check('and is remembered as the kind that makes you choose',
    fields[0].placeholder.required === true && fields[0].placeholder.text === 'Select...');
  check('a field that starts on a default has no placeholder at all',
    fields[2].placeholder === null);
  check('prices come off data-options, not out of the label',
    fields[2].choices.map((c) => c.price).join() === ',10.00,10.00');
  check('the name Snipcart knows the field by is kept',
    fields[2].snipcartName === 'Stitch color');
  check('a priced field is marked priced', fields[2].priced === true && fields[0].priced === false);
  check('the artwork-count field is locked',
    fields[3].locked === true && fields[0].locked === false);
  check('a page with no order form has no dropdowns', extractOptions('<p>nope</p>').length === 0);

  suite('options — what a save is allowed to write');

  const saved = buildOptions({ leather: 'Black\nBrown\nChestnut' }, fields);
  check('a dropdown the page has can be written',
    saved.leather.choices.map((c) => c.value).join() === 'Black,Brown,Chestnut');
  check('it carries what the rewrite will need later',
    saved.leather.snipcartName === 'Leather color' && saved.leather.placeholder.required === true);
  check('a name the page does not have is ignored, not invented',
    buildOptions({ nonsense: 'A\nB' }, fields) === null);
  check('the artwork-count field cannot be written to',
    buildOptions({ customstamps: 'None\n9 custom stamps' }, fields) === null);
  throws('emptying a dropdown is refused',
    () => buildOptions({ leather: '   ' }, fields), 'at least one');

  check('a list identical to the page is not stored',
    withoutBuiltInOptions(buildOptions({ leather: 'Black\nChestnut' }, fields), fields) === null);
  check('a changed list is stored',
    Object.keys(withoutBuiltInOptions(buildOptions({ leather: 'Black\nBrown\nChestnut' }, fields), fields))
      .join() === 'leather');
  check('and only the one that changed',
    Object.keys(withoutBuiltInOptions(
      buildOptions({ leather: 'Black\nBrown\nChestnut', hardware: 'Black\nBrass\nNickel' }, fields),
      fields
    )).join() === 'leather');

  suite('options — the markup');

  const plain = optionsHtml([{ value: 'Black', price: '' }, { value: 'Brown', price: '' }],
    { placeholder: { text: 'Select...', required: true } });
  check('a "make them choose" list opens on the placeholder',
    plain.startsWith('<option value="" disabled selected hidden>Select...</option>'));
  check('an optional one keeps its own wording and stays pickable',
    optionsHtml([{ value: 'Black', price: '' }], { placeholder: { text: 'No preference', required: false } })
      .startsWith('<option value="">No preference</option>'));
  check('and selects nothing else', !plain.replace(/^<option value="" [^>]*>[^<]*<\/option>/, '').includes('selected'));
  const defaulted = optionsHtml([{ value: 'No stitching', price: '' }, { value: 'White', price: '10.00' }]);
  check('a list without one starts on its first choice',
    defaulted.startsWith('<option value="No stitching" selected>'));
  check('a price is shown in the label, not in the value',
    defaulted.includes('<option value="White">White (+$10.00)</option>'));
  check('a quote in a value is escaped',
    optionsHtml([{ value: '50"-56"', price: '' }]).includes('value="50&quot;-56&quot;"'));
  check('but left alone in the label, the way the page writes it',
    optionsHtml([{ value: '50"-56"', price: '' }]).includes('>50"-56"</option>'));

  const stocked = optionsHtml([
    { value: 'Black', price: '', note: '' },
    { value: 'Brown', price: '', note: 'out of stock' },
  ]);
  check('an unavailable choice is shown but cannot be picked',
    stocked.includes('<option value="Brown" disabled>Brown &mdash; out of stock</option>'));
  check('and the dropdown opens on one that can be',
    stocked.includes('<option value="Black" selected>'));
  const firstGone = optionsHtml([
    { value: 'Brown', price: '', note: 'out of stock' },
    { value: 'Black', price: '', note: '' },
  ]);
  check('even when the unavailable one is at the top',
    !firstGone.includes('"Brown" disabled selected') && firstGone.includes('<option value="Black" selected>'));
  check('an unavailable choice never reaches Snipcart',
    dataOptionsString([{ value: 'Black', price: '' }, { value: 'Brown', price: '', note: 'gone' }])
      === 'Black');

  const grouped = optionsHtml([
    { value: 'Navy (112)', price: '', group: 'Richardson 112' },
    { value: 'Red (WP)', price: '', group: 'Waterproof' },
  ]);
  check('headings become optgroups',
    grouped.includes('<optgroup label="Richardson 112"><option value="Navy (112)"') &&
    grouped.includes('</optgroup><optgroup label="Waterproof">'));
  check('and the last one is closed', grouped.endsWith('</optgroup>'));
  check('a heading round-trips through the box', (() => {
    const text = '## Richardson 112\nNavy (112)\n## Waterproof\nRed (WP)';
    return choicesToText(choicesFromText(text)) === text;
  })());
  check('a choice under a heading remembers which one',
    choicesFromText('## Waterproof\nRed (WP)')[0].group === 'Waterproof');

  check('a priced list is written the way Snipcart parses it',
    dataOptionsString([{ value: 'No stitching', price: '' }, { value: 'White', price: '10.00' }])
      === 'No stitching|White[+10.00]');
  // Four fields on the hats declare an unpriced list. It is what makes the
  // cart show a dropdown and check the value came off it, so it has to survive.
  check('an unpriced one is still written out, because the cart uses it as a dropdown',
    dataOptionsString([{ value: 'Waterproof', price: '' }, { value: 'Richardson 112', price: '' }])
      === 'Waterproof|Richardson 112');
  check('a field the page never declared one for does not get one',
    needsDataOptions({ priced: false, choices: [{ value: 'Black', price: '' }] }) === false);
  check('one that did keeps it even after every price comes off',
    needsDataOptions({ priced: true, choices: [{ value: 'Black', price: '' }] }) === true);
  check('and a price added to a field that had none earns it one',
    needsDataOptions({ priced: false, choices: [{ value: 'Gold', price: '5.00' }] }) === true);

  suite('options — where they land');

  const rules = optionRules(buildOptions({ stitch: 'No stitching\nWhite +10.00\nGreen +12.00' }, fields));
  const select = rules.find((r) => r.action === 'select');
  check('the dropdown itself', select.selector === 'form[data-order-form] select[name="stitch"]');
  check('with the new choices', select.value.includes('Green (+$12.00)'));
  check('and the price list the cart script copies', select.dataOptions === 'No stitching|White[+10.00]|Green[+12.00]');

  const button = rules.find((r) => r.action === 'custom-options');
  check('and Snipcart’s own copy on the buy button, by name not by number',
    button.selector === 'button.snipcart-add-item' &&
    button.byName['Stitch color'] === 'No stitching|White[+10.00]|Green[+12.00]');

  const free = optionRules(buildOptions({ leather: 'Black\nBrown' }, fields));
  check('a list that never cost money does not touch the button',
    !free.some((r) => r.action === 'custom-options'));
  const unpriced = optionRules(buildOptions({ stitch: 'No stitching\nWhite\nRed' }, fields));
  check('a list that used to cost money keeps its entry, now with no prices in it',
    unpriced.find((r) => r.action === 'custom-options').byName['Stitch color']
      === 'No stitching|White|Red');
  check('nothing saved lands nowhere', optionRules(null).length === 0);

  suite('options — through the Worker');

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
        if (p === '/product-radio-bucket') {
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
  check('the editor lists a dropdown with the choices it has now',
    dash.includes('data-option="stitch"') && dash.includes('White +10.00'));
  check('the locked one is shown but has no box',
    dash.includes('Not editable here') && !dash.includes('data-option="customstamps"'));

  const unchangedSave = await post('/dashboard/api/photos', {
    productId: 'radio-bucket',
    photos: [],
    copy: {},
    options: { leather: 'Black\nChestnut', hardware: 'Black\nBrass\nNickel', stitch: 'No stitching\nWhite +10.00\nRed +10.00' },
  }, DASH);
  check('saving the lists a page already has stores nothing', unchangedSave.status === 200);
  check('and leaves the record empty',
    touchedProducts(JSON.parse(env.CATALOG._store.get('catalog') || '{}')).length === 0);

  const res = await post('/dashboard/api/photos', {
    productId: 'radio-bucket',
    photos: [],
    copy: {},
    options: {
      leather: 'Black\nBrown\nChestnut',
      stitch: 'No stitching\nWhite +10.00\nRed +10.00\nGreen +12.00',
    },
  }, DASH);
  check('a real change saves', res.status === 200);
  check('and hands back what each dropdown is showing',
    (await res.json()).showingOptions.leather === 'Black\nBrown\nChestnut');

  const live = await (await get('/product-radio-bucket')).text();
  check('brown is back on the page',
    /<select[^>]*name="leather"[\s\S]*?<option value="Brown">Brown<\/option>/.test(live));
  check('and the customer still has to choose',
    /<select[^>]*name="leather"[\s\S]*?disabled selected hidden>Select\.\.\.</.test(live));
  check('the new stitch colour is there with its price in the label',
    live.includes('<option value="Green">Green (+$12.00)</option>'));
  check('the dropdown carries the price list for the cart script',
    live.includes('data-options="No stitching|White[+10.00]|Red[+10.00]|Green[+12.00]"'));
  check('and Snipcart’s copy on the button agrees with it, on the right field',
    live.includes('data-item-custom3-options="No stitching|White[+10.00]|Red[+10.00]|Green[+12.00]"'));
  check('the artwork-count field on the button was not touched',
    live.includes('data-item-custom4-options="None|1 custom stamp[+15.00]"'));
  check('nor its dropdown', live.includes('<option value="1 custom stamp">1 custom stamp (+$15.00)</option>'));
  check('the hardware dropdown, which nobody edited, is the page’s own',
    /<select[^>]*name="hardware"[\s\S]*?<option>Brass<\/option>/.test(live));

  const dropPrice = await post('/dashboard/api/photos', {
    productId: 'radio-bucket',
    photos: [],
    copy: {},
    options: { stitch: 'No stitching\nWhite\nRed' },
  }, DASH);
  check('taking the upcharge off saves', dropPrice.status === 200);
  const free2 = await (await get('/product-radio-bucket')).text();
  check('the price is gone from the dropdown', !free2.includes('White (+$10.00)'));
  check('the select keeps its list, so the cart still shows a dropdown',
    free2.includes('data-options="No stitching|White|Red"'));
  check('and the button agrees, so the cart stops charging for it',
    free2.includes('data-item-custom3-options="No stitching|White|Red"'));
  check('the other button fields survived the clearing',
    free2.includes('data-item-custom4-options="None|1 custom stamp[+15.00]"') &&
    free2.includes('data-item-custom5-type="textarea"'));

  const reset = await post('/dashboard/api/photos', {
    productId: 'radio-bucket', photos: [], copy: {},
    options: { leather: 'Black\nChestnut', hardware: 'Black\nBrass\nNickel', stitch: 'No stitching\nWhite +10.00\nRed +10.00' },
  }, DASH);
  check('putting every list back saves', reset.status === 200);
  const back = await (await get('/product-radio-bucket')).text();
  check('and the page is exactly the repo’s again', back === PAGE);

  const bad = await post('/dashboard/api/photos', {
    productId: 'radio-bucket', photos: [], copy: {},
    options: { stitch: 'No stitching\nWhite +999999' },
  }, DASH);
  check('a price that is obviously a typo is refused', bad.status === 400);
  check('with the reason', (await bad.json()).error.includes('not a price'));
  check('and nothing was written', (await (await get('/product-radio-bucket')).text()) === PAGE);

  suite('options — the dashboard page');

  const record = recordOf({
    'radio-bucket': { options: { leather: { choices: [{ value: 'Black', price: '' }], placeholder: true } } },
  });
  const html = renderProductsPage(record, {
    ready: true,
    builtIn: { 'radio-bucket': { description: '', details: [], summary: '', feed: '', fields } },
  });
  check('the row says a dropdown was changed', html.includes('1 dropdown'));
  check('a product with no dropdowns says so', html.includes('no dropdowns to change'));
  check('the reset button is offered', html.includes('data-resetoptions="radio-bucket"'));

  const script = productsScript(record, { 'radio-bucket': { fields } });
  check('the script carries the page’s own lists, so a reset has somewhere to go',
    script.includes('No stitching\\nWhite +10.00'));
  check('and leaves the locked field out of them', !script.includes('1 custom stamp +15.00'));
}
