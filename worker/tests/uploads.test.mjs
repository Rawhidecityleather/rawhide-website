/**
 * Customer artwork uploads.
 *
 * The type check is the whole security story for this endpoint: it is public,
 * unauthenticated, and what it stores gets served back from our own origin. A
 * declared content-type is the customer's browser guessing from a file
 * extension, so these tests drive the byte sniffing directly.
 */

import { readFileSync } from 'node:fs';
import { suite, check } from './harness.mjs';
import {
  detect, safeName, isLogoKey, MAX_BYTES, handleLogoUpload, handleLogoFetch,
} from '../uploads.js';
import { renderSlip } from '../slip.js';

/** Stands in for the R2 binding. Records what the handler stored. */
function fakeBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options) {
      // Drain the stream the handler hands over, the way R2 does.
      const chunks = [];
      for await (const chunk of body) chunks.push(chunk);
      objects.set(key, { body: Buffer.concat(chunks), ...options });
    },
    async get(key) {
      const hit = objects.get(key);
      return hit ? { body: hit.body, httpMetadata: hit.httpMetadata } : null;
    },
  };
}

function uploadRequest(bytes, filename, extraHeaders = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  return new Request('https://rawhidecityleather.com/api/logo-upload', {
    method: 'POST',
    body: form,
    headers: extraHeaders,
  });
}

/** First 16 bytes of a file, built from an [offset, string] list. */
function head(...parts) {
  const bytes = new Uint8Array(16);
  for (const [at, text] of parts) {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  }
  return bytes;
}

const PNG = head([0, '\x89PNG\r\n\x1a\n']);
const JPG = head([0, '\xff\xd8\xff\xe0']);
const GIF = head([0, 'GIF89a']);
const PDF = head([0, '%PDF-1.7']);
const WEBP = head([0, 'RIFF'], [8, 'WEBP']);
const HEIC = head([4, 'ftyp'], [8, 'heic']);

export default async function run() {
  suite('uploads — what the bytes actually say');

  check('png', () => detect(PNG).ext === 'png');
  check('jpg', () => detect(JPG).ext === 'jpg');
  check('gif', () => detect(GIF).ext === 'gif');
  check('pdf', () => detect(PDF).ext === 'pdf');
  check('webp', () => detect(WEBP).ext === 'webp');
  check('heic — an iPhone photo straight off the camera roll', () => detect(HEIC).ext === 'heic');

  check('png maps to image/png', () => detect(PNG).mime === 'image/png');

  suite('uploads — what gets turned away');

  // SVG is the one that matters. It is XML that can carry script, and these
  // files are served back from our own origin, so accepting one would be a
  // stored XSS on the packing slip.
  check('svg', () => detect(head([0, '<svg xmlns='])) === null);
  check('html masquerading as art', () => detect(head([0, '<!doctype html>'])) === null);
  check('a zip', () => detect(head([0, 'PK\x03\x04'])) === null);
  check('empty', () => detect(head()) === null);
  check('nothing at all', () => detect(null) === null);

  // 'ftyp' at offset 4 is the whole ISO base media family, so the naive check
  // that catches HEIC also catches every .mp4 and .mov a phone can shoot.
  check('an mp4 sharing HEIC\'s ftyp header', () => detect(head([4, 'ftyp'], [8, 'isom'])) === null);
  check('a quicktime movie', () => detect(head([4, 'ftyp'], [8, 'qt  '])) === null);
  check('heic sibling brand mif1 still passes', () => detect(head([4, 'ftyp'], [8, 'mif1'])).ext === 'heic');

  check('8 MB cap', () => MAX_BYTES === 8 * 1024 * 1024);

  suite('uploads — the customer\'s filename');

  check('kept when it is ordinary', () => safeName('engine-12-crest.png') === 'engine-12-crest.png');
  check('directories stripped', () => safeName('C:\\Users\\rob\\Desktop\\crest.png') === 'crest.png');
  check('unix paths stripped', () => safeName('/tmp/../../etc/passwd') === 'passwd');
  // Spaces are kept — plenty of real filenames have them. What must not survive
  // is anything that could open a tag or an attribute where this gets printed.
  check('markup stripped', () => !/[<>="']/.test(safeName('<img src=x onerror="1">.png')));
  check('spaces are left alone', () => safeName('engine 12 crest.png') === 'engine 12 crest.png');
  check('blank falls back', () => safeName('') === 'artwork');
  check('all-junk falls back', () => safeName('///') === 'artwork');
  check('long names truncated', () => safeName('a'.repeat(300)).length === 60);

  suite('uploads — stored keys');

  const key = 'a'.repeat(32) + '.png';
  check('a real key', () => isLogoKey(key) === true);
  check('traversal', () => isLogoKey('../../secret.png') === false);
  check('wrong extension', () => isLogoKey('a'.repeat(32) + '.svg') === false);
  check('too short', () => isLogoKey('abc.png') === false);
  check('uppercase hex is not what we mint', () => isLogoKey('A'.repeat(32) + '.png') === false);
  check('empty', () => isLogoKey('') === false);

  suite('uploads — how artwork prints on the slip');

  const order = {
    token: '305e2604-cacf-4ddd-8520-07bd0b9dc8c2',
    invoiceNumber: 'RCL-1099',
    creationDate: '2026-08-14T12:00:00Z',
    status: 'Processed', currency: 'usd', email: 'buyer@example.com',
    itemsTotal: 190, shippingFees: 0, taxesTotal: 0, grandTotal: 190,
    shippingAddress: {
      fullName: 'Mike Doyle', address1: '12 Main St',
      city: 'Tampa', province: 'FL', postalCode: '33601',
    },
    items: [{
      id: 'fully-custom-radio-strap', name: 'Fully Custom Adjustable Radio Strap',
      quantity: 1, totalPrice: 190,
      customFields: [
        { name: 'Custom stamps', value: '2 custom stamps' },
        { name: 'Logo 1 artwork', value: 'crest.png - https://rawhidecityleather.com/logo/' + key },
        { name: 'Add leather butter', value: 'No' },
      ],
    }],
  };

  const html = renderSlip(order);
  check('the artwork link is clickable', () => html.includes('<a href="https://rawhidecityleather.com/logo/' + key + '">'));
  check('the customer\'s filename still prints', () => html.includes('crest.png'));
  check('the stamp count prints', () => html.includes('2 custom stamps'));

  // Whatever a customer types lands in these same fields, and the linkifier
  // runs over the rendered string — so it has to run after escaping, not before.
  const hostile = JSON.parse(JSON.stringify(order));
  hostile.items[0].customFields.push({
    name: 'Message', value: '<script>alert(1)</script> https://example.com/"onmouseover="alert(1)',
  });
  const hostileHtml = renderSlip(hostile);
  check('no script tag survives', () => !hostileHtml.includes('<script>alert(1)'));
  check('no attribute break-out through the link', () => !hostileHtml.includes('"onmouseover="'));

  // The endpoint driven end to end against a stand-in bucket. `wrangler dev`
  // can't be used for this: assets.directory is ".", so wrangler's own
  // .wrangler writes retrigger its watcher and the server reloads forever.
  suite('uploads — the endpoint end to end');

  const bucket = fakeBucket();
  const env = { LOGOS: bucket };

  const good = await handleLogoUpload(uploadRequest(PNG, 'engine 12 crest.png'), env);
  const body = await good.json();

  check('a png is accepted', () => good.status === 200 && body.ok === true);
  check('the response carries a link', () => /^https:\/\/rawhidecityleather\.com\/logo\/[0-9a-f]{32}\.png$/.test(body.url));
  check('the filename comes back for the customer', () => body.name === 'engine 12 crest.png');
  check('one object was stored', () => bucket.objects.size === 1);
  check('stored under a random key, not the customer\'s name', () => isLogoKey([...bucket.objects.keys()][0]));
  check('stored with the sniffed type, not the declared one',
    () => [...bucket.objects.values()][0].httpMetadata.contentType === 'image/png');

  const svg = await handleLogoUpload(uploadRequest(
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    'logo.svg'), env);
  check('an svg is refused', () => svg.status === 415);
  check('and nothing extra was stored', () => bucket.objects.size === 1);

  const empty = await handleLogoUpload(uploadRequest(new Uint8Array(0), 'nothing.png'), env);
  check('an empty file is refused', () => empty.status === 400);

  const renamed = await handleLogoUpload(uploadRequest(
    new TextEncoder().encode('<!doctype html><script>alert(1)</script>'), 'totally-a.png'), env);
  check('html renamed to .png is still refused', () => renamed.status === 415);

  const wrongMethod = await handleLogoUpload(
    new Request('https://rawhidecityleather.com/api/logo-upload'), env);
  check('GET is refused', () => wrongMethod.status === 405);

  const crossSite = await handleLogoUpload(
    uploadRequest(PNG, 'crest.png', { origin: 'https://not-us.example' }), env);
  check('a cross-site post is refused', () => crossSite.status === 403);

  const unconfigured = await handleLogoUpload(uploadRequest(PNG, 'crest.png'), {});
  check('a missing bucket binding fails loudly rather than silently', () => unconfigured.status === 500);

  suite('uploads — serving it back');

  const storedKey = [...bucket.objects.keys()][0];
  const served = await handleLogoFetch('/logo/' + storedKey, env);
  check('the stored file comes back', () => served.status === 200);
  check('with its real type', () => served.headers.get('content-type') === 'image/png');
  check('and nosniff, so the browser cannot re-guess it',
    () => served.headers.get('x-content-type-options') === 'nosniff');
  check('and out of the index', () => /noindex/.test(served.headers.get('x-robots-tag') || ''));

  const traversal = await handleLogoFetch('/logo/../../etc/passwd', env);
  check('traversal is a 404', () => traversal.status === 404);

  const missing = await handleLogoFetch('/logo/' + 'b'.repeat(32) + '.png', env);
  check('an unknown key is a 404', () => missing.status === 404);

  productPageChecks();
}

/**
 * The priced options live in two places on the product page: the form the
 * customer fills in, and the hidden buy button Snipcart re-fetches to price the
 * order. If those two ever disagree, the cart charges something the page never
 * offered — silently, and only on real orders. This is that guard rail.
 */
/** The order form and the hidden buy button, pulled apart for comparison. */
function pageParts(file) {
  const html = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const form = html.slice(html.indexOf('<form class="order-form"'), html.indexOf('</form>'));
  const button = html.slice(html.indexOf('<button hidden type="button" class="snipcart-add-item"'));

  // Fields the cart will actually carry: named, and not a file picker (main.js
  // skips anything without a name, which is why the pickers have none).
  const fields = [...form.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /\sname="/.test(tag))
    .map((tag) => ({
      label: (tag.match(/data-label="([^"]*)"/) || [])[1] || '',
      options: (tag.match(/data-options="([^"]*)"/) || [])[1] || '',
    }));

  const declared = [];
  for (let i = 1; ; i++) {
    const name = (button.match(new RegExp(`data-item-custom${i}-name="([^"]*)"`)) || [])[1];
    if (!name) break;
    declared.push({
      label: name,
      options: (button.match(new RegExp(`data-item-custom${i}-options="([^"]*)"`)) || [])[1] || '',
    });
  }

  return { form, button, fields, declared };
}

function productPageChecks() {
  suite('product pages — the form and the buy button agree');

  // Every page carrying a priced option needs both copies in step. Add a page
  // here the moment it gets one.
  const PRICED_PAGES = [
    'product-fully-custom-radio-strap.html',
    'product-basic-radio-strap.html',
    'product-leather-patch-hat.html',
  ];

  const parts = {};
  for (const file of PRICED_PAGES) {
    const p = pageParts(file);
    parts[file] = p;
    const page = file.replace('product-', '').replace('.html', '');

    check(`${page}: every form field is declared (${p.fields.length})`,
      () => p.fields.length === p.declared.length,
      `form=${p.fields.length} button=${p.declared.length}`);

    check(`${page}: and in the same order`,
      () => p.fields.every((f, i) => p.declared[i] && p.declared[i].label === f.label),
      p.fields.map((f, i) => (p.declared[i] && p.declared[i].label === f.label ? '' : `${i + 1}:${f.label}`))
        .filter(Boolean).join(' ') || 'all match');

    check(`${page}: price modifiers identical in both places`,
      () => p.fields.every((f, i) => p.declared[i] && p.declared[i].options === f.options));
  }

  suite('product pages — the money');

  const custom = parts['product-fully-custom-radio-strap.html'];
  const basic = parts['product-basic-radio-strap.html'];

  const both = (p, text) => p.form.includes(text) && p.button.includes(text);

  check('one stamp adds $15', () => both(custom, '1 custom stamp[+15.00]'));
  check('two stamps add $25, not $40', () => both(custom, '2 custom stamps[+25.00]'));

  // Matches the standalone Leather Butter price, deliberately — an add-on that
  // undercuts the product's own page is a discount nobody decided to give.
  check('butter adds $8 on the custom strap', () => both(custom, 'No|Yes[+8.00]'));
  check('butter adds $8 on the basic strap too', () => both(basic, 'No|Yes[+8.00]'));

  check('stamps default to None so nobody buys one by accident',
    () => /<option value="None" selected>/.test(custom.form));
  check('butter defaults to No on the custom strap',
    () => /<option value="No" selected>/.test(custom.form));
  check('butter defaults to No on the basic strap',
    () => /<option value="No" selected>/.test(basic.form));

  suite('product pages — artwork pickers');

  // A picker that writes into an id that doesn't exist uploads fine and then
  // silently drops the URL, so the order arrives with no artwork on it.
  const targets = [...custom.form.matchAll(/data-logo-target="([^"]+)"/g)].map((m) => m[1]);
  check('both pickers have a slot', () => targets.length === 2);
  check('each picker writes into a field that exists',
    () => targets.every((id) => custom.form.includes(`id="${id}"`)));
  check('the artwork fields are readonly in the cart',
    () => (custom.form.match(/data-type="readonly"/g) || []).length === 2);
  check('customers are warned that fine detail will not stamp',
    () => /do not stamp/i.test(custom.form));
}
