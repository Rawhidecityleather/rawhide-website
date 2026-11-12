/**
 * The build list: every piece still owed, with its options, in ship-by order.
 *
 * A list like this is only worth having if it can be trusted at the bench
 * without opening the slips to check it. So the checks lean on the promises
 * that make it trustworthy: nothing owed is missing and nothing shipped is on
 * it, it never disagrees with the ship queue about what is next or how late
 * it is, an option the customer picked is never dropped, and nothing a
 * customer typed can break the page it is printed on.
 *
 * The quote reads ride on the dashboard's own request, so the promise there is
 * different: whatever goes wrong with them, the dashboard still loads.
 */

import { suite, check } from './harness.mjs';
import {
  buildPieces, groupPieces, buildQuoteIds, loadBuildQuotes, renderBuildCard,
  BUILD_SCRIPT, BUILD_STYLES, BUILD_VIEW_KEY,
} from '../build-list.js';
import {
  analyze, renderDashboard, renderRail, cashJobsWaiting, DASHBOARD_SCRIPT,
} from '../dashboard.js';
import { daysUntil } from '../lib.js';
import { itemFields, calloutLabel, renderSlip } from '../slip.js';
import {
  buildQuote, putQuote, listQuotes, markQuoteCashPaid, markQuoteHandedOver,
} from '../quote.js';
import worker from '../index.js';

// One clock for the whole file, the same reason lib.test.mjs keeps one.
const NOW = Date.now();
const placed = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const f = (name, value) => ({ name, value });

const waiting = (invoice, daysAgo, items, extra = {}) => ({
  token: 'tok-' + invoice, invoiceNumber: invoice, creationDate: placed(daysAgo),
  status: 'Processed', paymentStatus: 'Paid', currency: 'usd', grandTotal: 100,
  email: 'buyer@example.com',
  shippingAddress: { fullName: 'Mike Doyle', city: 'Tampa', province: 'FL' },
  items, ...extra,
});

const band = (fields = [], extra = {}) =>
  ({ id: 'helmet-band', name: 'Helmet Band', quantity: 1, customFields: fields, ...extra });
const strap = (fields = [], extra = {}) => ({
  id: 'fully-custom-radio-strap', name: 'Fully Custom Adjustable Radio Strap',
  quantity: 1, customFields: fields, ...extra,
});
const belt = (fields = [], extra = {}) =>
  ({ id: 'heavy-duty-belt', name: 'Heavy Duty Belt', quantity: 1, customFields: fields, ...extra });

/** The queue the dashboard would hand over — the real sort, not a hand-made one. */
const queueOf = (orders) => analyze(orders, 'all').queue;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** One arrangement's markup: from its opening tag to the next one's, or the end. */
const view = (html, key) => {
  const start = html.indexOf(`data-buildview="${key}"`);
  if (start < 0) return '';
  const next = html.indexOf('data-buildview="', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
};
const slips = (html) =>
  [...html.matchAll(/href="\/packing-slip\?token=tok-([^"]+)"/g)].map((m) => m[1]);
const section = (html, id) => html.split(`<section id="${id}"`)[1].split('</section>')[0];

/** get/put/list with metadata, and a count of reads — what quote.js uses. */
function makeKV() {
  const store = new Map();
  const kv = {
    reads: 0,
    async put(key, value, opts = {}) { store.set(key, { value, metadata: opts.metadata || null }); },
    async get(key) { kv.reads += 1; return store.get(key)?.value ?? null; },
    async list({ prefix = '' } = {}) {
      const keys = [...store.entries()].filter(([k]) => k.startsWith(prefix))
        .map(([name, rec]) => ({ name, metadata: rec.metadata }));
      return { keys, list_complete: true };
    },
  };
  return kv;
}

/**
 * Snipcart, stood in for. The dashboard route asks it for the order list and a
 * few other things; this answers the order list with `orders` and everything
 * else with an empty page, and refuses any other host outright.
 */
async function withSnipcart(orders, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname !== 'app.snipcart.com') throw new Error('unexpected fetch: ' + url);
    const body = u.pathname === '/api/orders'
      ? { items: orders, totalItems: orders.length }
      : { items: [], totalItems: 0 };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}

export default async function run() {
  // Handed over newest first, the order Snipcart lists them in, so a list that
  // came back in the same order would prove nothing was sorted.
  const orders = [
    waiting('NEW-STRAP', 2, [strap()]),                     // due in 40
    waiting('MIXED', 10, [strap(), band()]),                // the band's 11
    waiting('SOON-BELT', 18, [belt([], { quantity: 2 })]),  // due in 3
    waiting('LATE-BAND', 23, [band()]),                     // 2 days late
    waiting('OLD-STRAP', 30, [strap()]),                    // due in 12
  ];
  const queue = queueOf(orders);
  const pieces = buildPieces(queue);

  suite('build list — one row per thing to make');

  check('every line item on an open order is a piece', pieces.length === 6);
  check('an order with two products gives two rows',
    pieces.filter((p) => p.order.invoiceNumber === 'MIXED').length === 2);
  check('a quantity rides on its row', pieces.find((p) => p.order.invoiceNumber === 'SOON-BELT').quantity === 2);
  check('a mangled quantity is still one piece owed, never none',
    same(buildPieces([waiting('A', 1, [band([], { quantity: 0 }), band([], { quantity: 'x' }), band([], { quantity: undefined })])])
      .map((p) => p.quantity), [1, 1, 1]));
  check('an order with no items adds nothing and does not throw',
    () => buildPieces([waiting('EMPTY', 1, []), { ...waiting('NONE', 1, []), items: undefined }]).length === 0);
  check('no arguments at all is an empty list', () => buildPieces().length === 0);

  // What is and isn't on the bench is the queue's call, not this card's.
  const board = renderDashboard(analyze([
    waiting('OPEN', 3, [band([f('Stamped text', 'OPENONE')])]),
    waiting('GONE', 9, [band([f('Stamped text', 'SHIPPEDONE')])], { status: 'Shipped' }),
    waiting('DROPPED', 9, [band([f('Stamped text', 'CANCELLEDONE')])], { status: 'Cancelled' }),
    waiting('UNPAID', 9, [band([f('Stamped text', 'UNPAIDONE')])], { paymentStatus: 'Authorized' }),
    waiting('BACK', 9, [band([f('Stamped text', 'REFUNDEDONE')])], { refundsAmount: 100 }),
  ], 'all'), {});
  const built = section(board, 'build');
  check('an open order is on it', built.includes('OPENONE'));
  check('a shipped order is not', !built.includes('SHIPPEDONE'));
  check('nor a cancelled, unpaid or fully refunded one',
    !built.includes('CANCELLEDONE') && !built.includes('UNPAIDONE') && !built.includes('REFUNDEDONE'));

  suite('build list — ship-by order');

  const byDate = pieces.map((p) => p.order.invoiceNumber);
  check('by date it runs most overdue to furthest out',
    same(byDate, ['LATE-BAND', 'SOON-BELT', 'MIXED', 'MIXED', 'OLD-STRAP', 'NEW-STRAP']), byDate.join(' '));
  check('which is the ship queue\'s order, opened up into pieces',
    same([...new Set(byDate)], queue.map((o) => o.invoiceNumber)));

  // The box ships as one box. The strap in MIXED is owed with the band, at
  // three weeks, not at its own six — the same date the queue prints.
  const mixed = pieces.filter((p) => p.order.invoiceNumber === 'MIXED');
  check('both pieces of a mixed order carry the order\'s date',
    mixed.every((p) => daysUntil(p.due) === 11), mixed.map((p) => daysUntil(p.due)).join(' '));
  check('and sit together, in the order they were bought',
    same(mixed.map((p) => p.name), ['Fully Custom Adjustable Radio Strap', 'Helmet Band']));
  check('an order nothing can date goes last',
    buildPieces(queueOf([
      { ...waiting('NO-DATE', 5, [band()]), creationDate: 'not a date' },
      waiting('DATED', 1, [band()]),
    ])).map((p) => p.order.invoiceNumber).join(' ') === 'DATED NO-DATE');

  const card = renderBuildCard(queue);
  check('the by-date list links the slips in that order',
    same(slips(view(card, 'date')), ['LATE-BAND', 'SOON-BELT', 'MIXED', 'MIXED', 'OLD-STRAP', 'NEW-STRAP']));

  // One wording, one set of thresholds: the two cards badge the same order
  // the same way or the bench stops believing either.
  const both = renderDashboard(analyze(orders, 'all'), {});
  for (const badge of ['<span class="due hot">2d late</span>', '<span class="due soon">3d</span>',
    '<span class="due">11d</span>', '<span class="due">40d</span>']) {
    check(`the queue and the build list both say ${badge.replace(/<[^>]+>/g, '')}`,
      section(both, 'queue').includes(badge) && section(both, 'build').includes(badge));
  }
  check('an undated piece gets a dash, not a made-up date', () => {
    const html = renderBuildCard([{ ...waiting('NO-DATE', 5, [band()]), creationDate: 'not a date' }]);
    return html.includes('<div class="pc-due"><span class="soft">&mdash;</span></div>') && !html.includes('NaN');
  });

  suite('build list — by product');

  const groups = groupPieces(pieces);
  check('one heading per product',
    same(groups.map((g) => g.name), ['Helmet Band', 'Heavy Duty Belt', 'Fully Custom Adjustable Radio Strap']),
    groups.map((g) => g.name).join(' | '));
  check('products run in the order their most urgent piece is due',
    groups[0].pieces[0].order.invoiceNumber === 'LATE-BAND');
  check('inside a product the rows run soonest first',
    same(groups[2].pieces.map((p) => p.order.invoiceNumber), ['MIXED', 'OLD-STRAP', 'NEW-STRAP']));
  check('a mixed order\'s pieces land under their own products',
    groups[0].pieces.some((p) => p.order.invoiceNumber === 'MIXED')
    && groups[2].pieces.some((p) => p.order.invoiceNumber === 'MIXED'));
  check('the heading counts pieces, not rows', groups[1].count === 2 && groups[1].pieces.length === 1);
  check('and the card adds them all up', card.includes('7 pieces &middot; 5 orders'));
  check('the by-product list links the slips product by product',
    same(slips(view(card, 'product')), ['LATE-BAND', 'MIXED', 'SOON-BELT', 'MIXED', 'OLD-STRAP', 'NEW-STRAP']));
  check('the headings are on the page in that order', () => {
    const at = groups.map((g) => view(card, 'product').indexOf(`<span>${g.name}</span>`));
    return at.every((i) => i > 0) && same(at, [...at].sort((a, b) => a - b));
  });

  // A product renamed between two orders is still one product on the bench.
  const renamed = groupPieces(buildPieces(queueOf([
    waiting('A', 2, [{ id: 'fully-custom-radio-strap', name: 'Fully Custom Adjustable Radio Strap' }]),
    waiting('B', 30, [{ id: 'fully-custom-radio-strap', name: 'Fully Custom Radio Strap' }]),
  ])));
  check('a renamed product stays one heading', renamed.length === 1 && renamed[0].pieces.length === 2);
  check('an item with no id is grouped on its name',
    groupPieces(buildPieces(queueOf([
      waiting('A', 2, [{ name: 'Shield' }]), waiting('B', 3, [{ name: 'shield ' }]), waiting('C', 4, [{ name: 'Axe' }]),
    ]))).length === 2);

  check('under a heading the name is not repeated on a single piece', () => {
    const product = view(card, 'product');
    return (product.match(/<p class="pc-name">/g) || []).length === 1
      && product.includes('<span class="pc-qty many">2&times;</span> Heavy Duty Belt');
  });
  check('by date every row says what it is',
    (view(card, 'date').match(/<p class="pc-name">/g) || []).length === 6);
  check('more than one is the loud number, one is the quiet one',
    view(card, 'date').includes('<span class="pc-qty many">2&times;</span> Heavy Duty Belt')
    && view(card, 'date').includes('<span class="pc-qty">1&times;</span> Helmet Band'));

  suite('build list — the options');

  const custom = strap([
    f('Strap length', '62"-68"'), f('Leather color', 'Black'), f('Stitch color', 'None'),
    f('Stamp above name', 'Maltese Cross'), f('Text / symbols to be stamped', 'RAMIREZ E-7'),
    f('Text paint color', ''), f('Text outline color', '   '),
    f('Logo 1 artwork', 'station7.png - https://rawhidecityleather.com/logo/2026/10/4be2d81a.png'),
    f('Add leather butter', 'Yes'),
    f('Message', 'Retirement gift.\nNeeds to be in hand before Dec 12.'),
  ]);
  const one = renderBuildCard(queueOf([waiting('RCL-1058', 30, [custom])]));
  const row = view(one, 'date');

  check('every option the customer picked is on the row',
    ['Strap length', '62&quot;-68&quot;', 'Leather color', 'Black', 'Add leather butter', 'Yes']
      .every((text) => row.includes(text)));
  // "None" on the stitch list is a build instruction: no stitching. A list
  // that tidied it away would get the strap stitched out of habit.
  check('a None is an answer and stays',
    row.includes('<dt>Stitch color</dt><dd>None</dd>'));
  check('a field left blank is not a row',
    !row.includes('Text paint color') && !row.includes('Text outline color'));
  check('what gets stamped is in the callout, under the slip\'s label',
    /<span class="pc-calllabel">Stamp text<\/span>\s*<span class="pc-callvalue">RAMIREZ E-7<\/span>/.test(row));
  // The slip and the list split a strap's fields with the same function, so a
  // field can't be a callout on one and small print on the other.
  check('the split is the packing slip\'s: same callout fields, same grid fields', () => {
    const { critical, specs } = itemFields(custom);
    const slip = renderSlip(waiting('RCL-1058', 30, [custom]));
    return critical.length === 4 && specs.length === 4
      && critical.every((c) => row.includes(`<span class="pc-calllabel">${calloutLabel(c.name)}</span>`)
        && slip.includes(`<span class="callout-label">${calloutLabel(c.name)}</span>`))
      && specs.every((s) => row.includes(`<dt>${s.name}</dt>`) && slip.includes(`<dt>${s.name}</dt>`));
  });
  check('the artwork is one click away, in a new tab',
    row.includes('station7.png - <a target="_blank" rel="noopener noreferrer" '
      + 'href="https://rawhidecityleather.com/logo/2026/10/4be2d81a.png">'));
  check('a message keeps its line breaks',
    row.includes('Retirement gift.<br>Needs to be in hand before Dec 12.'));
  check('a long value gets the full width', () => {
    const wide = renderBuildCard(queueOf([waiting('W', 1, [band([
      f('Leather color', 'Black'), f('Belt size (in)', 'Measured over the belt loops, 36 and a half inches'),
    ])])]));
    return wide.includes('<div class="pc-opt"><dt>Leather color</dt>')
      && wide.includes('<div class="pc-opt wide"><dt>Belt size (in)</dt>');
  });
  check('a piece with nothing to choose says so rather than looking unfinished',
    renderBuildCard(queueOf([waiting('B', 1, [{ id: 'leather-butter', name: 'Leather Butter', quantity: 2 }])]))
      .includes('No options on this one.'));

  // A note typed against the order belongs to every piece in it: by product,
  // its pieces are under different headings.
  const noted = renderBuildCard(queueOf([
    waiting('NOTED', 5, [strap(), band()], { notes: 'Second belt is a 38.\nCalled 11/3.' }),
  ]));
  check('an order note rides on every piece of that order',
    (view(noted, 'date').match(/Order note<\/span>\s*<span class="pc-callvalue">Second belt is a 38\.<br>Called 11\/3\./g) || []).length === 2
    && (view(noted, 'product').match(/Second belt is a 38\./g) || []).length === 2);
  check('so does anything filled in at checkout for the whole order',
    renderBuildCard(queueOf([waiting('F', 5, [band()], { customFields: [f('Gift wrap', 'Yes'), f('Blank', ' ')] })]))
      .includes('<span class="pc-calllabel">Gift wrap</span>'));

  suite('build list — nothing a customer types can break the page');

  const hostile = renderBuildCard(queueOf([waiting('"><i>INV', 4, [{
    id: 'x"><script>id()</script>', name: '<img src=x onerror=name()>', quantity: 1,
    customFields: [
      f('<b>Leather</b>', '"><script>value()</script>'),
      f('Stamped text', '</section><script>stamp()</script>'),
      f('Notes', 'see <a href="https://evil.example/x">this</a> and https://ok.example/a"onmouseover="x'),
    ],
  }], {
    token: 'tok-"><script>token()</script>',
    notes: '<script>note()</script>',
    shippingAddress: { fullName: 'Jane "JD" <u>Doe</u>' },
  })]));
  check('no tag a customer typed survives',
    !/<script|<img|<b>|<u>|<i>/.test(hostile), (hostile.match(/<(script|img|b|u|i)\b[^>]*>/) || [''])[0]);
  check('nor a closing section that would cut the card in half',
    hostile.split('</section>').length === 2);
  check('an attribute cannot be closed from inside a value', !/"onmouseover=|" onmouseover=/.test(hostile));
  check('only an address typed in the clear becomes a link, and only once',
    (hostile.match(/<a target="_blank" rel="noopener noreferrer" href="https:\/\/evil\.example\/x&quot;/g) || []).length === 2
    && hostile.includes('&lt;a href=&quot;'));
  check('the token stays inside its own href',
    hostile.includes('href="/packing-slip?token=tok-&quot;&gt;&lt;script&gt;token()&lt;/script&gt;"'));

  suite('build list — records that are not the shape it expects');

  // Snipcart's records are somebody else's. None of this has been seen on a
  // real order; the point is that if it ever is, the list shrugs.
  const odd = [
    null,
    { ...waiting('NO-ITEMS', 3, []), items: 'not a list' },
    waiting('ODD', 4, [
      null,
      { id: 7, name: 42, quantity: '2', customFields: 'not a list' },
      { name: 'Typed oddly', customFields: [
        null, 'a string', { name: null, value: 12 }, { name: 'Engraved', value: true },
        { name: { deep: 1 }, value: { deep: 2 } }, { name: 'Zero', value: 0 },
      ] },
    ], { customFields: { not: 'a list' }, notes: 404, shippingAddress: null, billingAddress: null, email: null }),
  ];
  let oddPieces = [];
  check('they do not throw', () => { oddPieces = buildPieces(odd, { cashJobs: [null, {}] }); return true; });
  check('and what can be listed is listed', oddPieces.filter((p) => p.order).length === 2
    && oddPieces[0].name === '42' && oddPieces[0].quantity === 2);
  const oddCard = renderBuildCard(odd, [null, {}]);
  check('the card draws them rather than apologising', oddCard.includes('data-buildview="date"')
    && !oddCard.includes('could not be drawn'));
  check('a number or a yes/no still reads as what was picked',
    oddCard.includes('<dd>12</dd>') && oddCard.includes('<dt>Engraved</dt><dd>true</dd>')
    && oddCard.includes('<span class="pc-callvalue">404</span>'));
  check('the heading counts the orders it actually lists',
    oddCard.includes('4 pieces &middot; 1 order &middot; 1 cash job'), (oddCard.match(/cardnote">([^<]*)/) || [])[1]);

  // The backstop. If something does throw, it costs this card and only this
  // card — under the dashboard route a throw reads "Could not reach Snipcart"
  // and takes the ship queue down with it.
  // A quote job on the bench makes the card look its record up, and the
  // lookup is what blows. Nothing else on the page touches it.
  const poisoned = { get() { throw new Error('boom <b>'); } };
  const withJob = [...orders, waiting('CREW', 5, [{ id: 'quote-abcdefghij1234', name: 'Crew job' }])];
  // The card logs what stopped it, which is right in production and noise
  // here: a stack trace in the middle of a passing run reads like a failure.
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  let wounded = '';
  let sorry = '';
  try {
    wounded = renderDashboard(analyze(withJob, 'all'), { buildQuotes: poisoned });
    sorry = renderBuildCard(queueOf(withJob), [], { quotes: poisoned });
  } finally {
    console.error = realError;
  }
  const fine = renderDashboard(analyze(withJob, 'all'), {});
  check('what stopped it goes to the log, where wrangler tail shows it',
    logged.length === 2 && logged.every((line) => line.includes('build list') && line.includes('boom')));
  check('a card that cannot be drawn says so in its own place',
    section(wounded, 'build').includes('could not be drawn')
    && section(wounded, 'build').includes('<code>boom &lt;b&gt;</code>')
    && !section(fine, 'build').includes('could not be drawn'));
  check('and the rest of the dashboard is untouched',
    section(wounded, 'queue') === section(fine, 'queue')
    && section(wounded, 'orders') === section(fine, 'orders')
    && section(wounded, 'queue').includes('CREW')
    && wounded.indexOf('<section id="build"') < wounded.indexOf('<section id="queue"'));
  check('the apology is still one whole section, where the rail points',
    sorry.startsWith('<section id="build" class="card">') && sorry.split('</section>').length === 2);

  suite('build list — jobs billed off a quote');

  const env = { QUOTES: makeKV() };
  const crew = await putQuote(env, buildQuote({
    title: '12 Memorial Radio Straps — Station 4', customer: 'Lt. Dana Reyes',
    department: 'Lakeland Fire Department',
    notes: 'Black bridle, white stitch.\nNames on the list attached.',
    lines: [
      { description: 'Fully custom radio strap <black>', quantity: 12, unitPrice: 150 },
      { description: 'Leather butter', quantity: 1, unitPrice: 8 },
    ],
  }));
  const plaque = await putQuote(env, buildQuote({
    title: 'Retirement axe plaque', customer: 'Chief Alvarez', department: 'Lakeland Fire Department',
    payment: 'cash', notes: 'Walnut backer.',
    lines: [{ description: 'Axe plaque', quantity: 1, unitPrice: 240 }],
  }));
  const unpaidCash = await putQuote(env, buildQuote({
    title: 'Unpaid shield', customer: 'Capt. Vance', payment: 'cash',
    lines: [{ description: 'Shield', quantity: 1, unitPrice: 90 }],
  }));
  await markQuoteCashPaid(env, plaque.id, { method: 'check' });

  // Exactly what a paid card quote leaves in Snipcart: one line, the quote's
  // title for a name, and its id as the only field. See QUOTE_CART_GUARD.
  const crewOrder = waiting('RCL-2001', 8, [{
    id: crew.itemId, name: crew.title, quantity: 1,
    customFields: [{ name: 'Quote', type: 'readonly', value: crew.id }],
  }], { shippingAddress: { fullName: 'Lt. Dana Reyes' } });
  const crewQueue = queueOf([crewOrder, waiting('RCL-2002', 20, [band([f('Stamped text', 'DOYLE')])])]);
  const summaries = await listQuotes(env);
  const cashWaiting = cashJobsWaiting(summaries);

  check('only the paid cash job is waiting', cashWaiting.length === 1 && cashWaiting[0].id === plaque.id);
  check('the list asks for the quote jobs on the bench and nothing else',
    same(buildQuoteIds(crewQueue, cashWaiting), [crew.id, plaque.id]));

  env.QUOTES.reads = 0;
  const records = await loadBuildQuotes(env, crewQueue, cashWaiting);
  check('one read per quote job', env.QUOTES.reads === 2 && records.size === 2);

  const jobs = renderBuildCard(crewQueue, cashWaiting, { quotes: records });
  const jobsByDate = view(jobs, 'date');
  check('a crew job is written out line by line',
    jobsByDate.includes('<span class="pc-qty many">12&times;</span> Fully custom radio strap &lt;black&gt;')
    && jobsByDate.includes('<span class="pc-qty">1&times;</span> Leather butter'));
  check('with its build notes in the callout, line breaks kept',
    /Build notes<\/span>\s*<span class="pc-callvalue">Black bridle, white stitch\.<br>Names on the list attached\./.test(jobsByDate));
  check('the bare quote id is not printed as if it were an option', !jobsByDate.includes('<dt>Quote</dt>'));
  check('its sheet is a click away, beside the slip',
    jobsByDate.includes(`href="/dashboard/quote-print?id=${crew.id}" target="_blank" rel="noopener noreferrer">Quote sheet`)
    && jobsByDate.includes('href="/packing-slip?token=tok-RCL-2001"'));
  check('a job gets no 1× of its own — the quantities are on its lines',
    jobsByDate.includes(`<p class="pc-name">${'12 Memorial Radio Straps — Station 4'}</p>`));
  check('it is dated like any order: a strap job gets the six weeks',
    daysUntil(buildPieces(crewQueue, { quotes: records }).find((p) => p.quoteId === crew.id).due) === 34);
  check('the heading counts what the lines add up to',
    /<span>12 Memorial Radio Straps — Station 4<\/span><span class="bgroup-count">13 pieces<\/span>/.test(view(jobs, 'product')));

  check('the paid cash job is on the list, last, with no ship-by date', () => {
    const list = buildPieces(crewQueue, { cashJobs: cashWaiting, quotes: records });
    const last = list[list.length - 1];
    return last.job?.id === plaque.id && last.due === null && list.length === 3;
  });
  check('it says when the money came in instead',
    /<div class="pc-due"><span class="soft">paid [A-Z][a-z]{2} \d{1,2}<\/span><\/div>/.test(jobsByDate));
  check('its lines and notes are written out too',
    jobsByDate.includes('<span class="pc-qty">1&times;</span> Axe plaque') && jobsByDate.includes('Walnut backer.'));
  check('it links to its invoice, not to a slip that does not exist',
    jobsByDate.includes(`class="mono">${plaque.id}</a>`) && !slips(jobs).includes(plaque.id));
  check('and wears the same pill as in the ship queue, by date and by product',
    jobsByDate.includes('Retirement axe plaque<span class="pill cash">Check</span>')
    && view(jobs, 'product').includes('<span>Retirement axe plaque</span><span class="pill cash">Check</span>'));
  check('an unpaid cash job is not work owed yet', !jobs.includes(unpaidCash.id) && !jobs.includes('Unpaid shield'));
  check('the card counts the job', jobs.includes('15 pieces &middot; 2 orders &middot; 1 cash job'));

  // The fallback: the records could not be read. Every job still has a row.
  const blind = renderBuildCard(crewQueue, cashWaiting);
  check('without the records every job still has its row',
    blind.includes('12 Memorial Radio Straps — Station 4') && blind.includes('Retirement axe plaque'));
  check('and says where the detail is instead of looking empty',
    (view(blind, 'date').match(/The lines and build notes are on the quote sheet\./g) || []).length === 2
    && view(blind, 'date').includes(`quote-print?id=${crew.id}`));
  check('a heading does not state a count nobody could read',
    !/12 Memorial Radio Straps — Station 4<\/span><span class="bgroup-count">/.test(view(blind, 'product'))
    && view(blind, 'product').includes('<span>Helmet Band</span><span class="bgroup-count">1 piece</span>'));

  const beforeHandover = section(renderDashboard(analyze([], 'all'), { quotes: summaries }), 'build');
  await markQuoteHandedOver(env, plaque.id);
  const afterHandover = section(renderDashboard(analyze([], 'all'), { quotes: await listQuotes(env) }), 'build');
  check('the dashboard puts a waiting cash job on the list by itself',
    beforeHandover.includes('Retirement axe plaque') && beforeHandover.includes('1 cash job'));
  check('handed over, it comes off',
    !afterHandover.includes('Retirement axe plaque') && afterHandover.includes('Nothing to build.'));

  suite('build list — the quote reads cannot take the dashboard down');

  const quiet = { QUOTES: makeKV() };
  await loadBuildQuotes(quiet, queue, []);
  check('a bench of catalog work costs no reads at all', quiet.QUOTES.reads === 0);
  check('no QUOTES binding is an empty answer, not a crash',
    (await loadBuildQuotes({}, crewQueue, cashWaiting)).size === 0
    && (await loadBuildQuotes(undefined, crewQueue, cashWaiting)).size === 0);

  const broken = { QUOTES: { get: async () => { throw new Error('KV is down'); } } };
  const fromBroken = await loadBuildQuotes(broken, crewQueue, cashWaiting).catch((err) => err);
  check('KV down: it resolves, with nothing', fromBroken instanceof Map && fromBroken.size === 0);

  // One bad record must not cost the others.
  const flaky = { QUOTES: { get: async (key) => {
    if (key.endsWith(crew.id)) throw new Error('timeout');
    return env.QUOTES.get(key);
  } } };
  const fromFlaky = await loadBuildQuotes(flaky, crewQueue, cashWaiting);
  check('one failed read keeps the ones that worked',
    fromFlaky.size === 1 && fromFlaky.has(plaque.id));
  const garbled = { QUOTES: { get: async () => '{not json' } };
  check('a record that will not parse is skipped',
    (await loadBuildQuotes(garbled, crewQueue, cashWaiting)).size === 0);
  check('a queue with holes in it does not throw',
    (await loadBuildQuotes(env, [null, {}, { items: [null, {}] }], [null, {}])).size === 0);

  // The cap. Soonest first, so what gets cut off is what is furthest out.
  const id = (n) => 'quotejob' + String(n).padStart(6, '0');
  const many = queueOf(Array.from({ length: 15 }, (_, n) =>
    waiting('Q' + n, 20 - n, [{ id: 'quote-' + id(n), name: 'Job ' + n }])));
  const asked = buildQuoteIds(many, [{ id: id(99) }]);
  check('never more than twelve reads on one page load', asked.length === 12);
  check('the most urgent jobs are the ones read', asked[0] === id(0) && asked[11] === id(11));
  check('a job is asked for once however many times it appears',
    buildQuoteIds([{ items: [{ id: 'quote-' + id(1) }, { id: 'quote-' + id(1) }] }], [{ id: id(1) }]).length === 1);
  check('a catalog item is never mistaken for a quote',
    buildQuoteIds([{ items: [{ id: 'helmet-band' }, { id: 'quote-' }, { id: 'quote-NOT/AN/ID' }, { id: 'quotes-helmetband12' }] }]).length === 0);

  suite('build list — through the real Worker');

  // The one place the wiring itself is checked: the route reads the quote
  // records, hands them to the page, and inlines this card's styles and
  // script. Everything above drives the functions; this drives /dashboard.
  const liveEnv = {
    QUOTES: env.QUOTES,
    SNIPCART_SECRET: 'test-key-never-used',
    SLIP_USER: 'dev',
    SLIP_PASS: 'dev',
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
  };
  const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
  const dashboard = (withEnv, headers = { Authorization: AUTH }) => withSnipcart(
    [crewOrder, waiting('RCL-2002', 20, [band([f('Stamped text', 'DOYLE')])])],
    () => worker.fetch(new Request('https://rawhidecityleather.com/dashboard', { headers }), withEnv, { waitUntil() {} }),
  );

  // A second cash job, since the first was handed over above.
  const shield = await putQuote(env, buildQuote({
    title: 'Station 9 shield', customer: 'Capt. Vance', payment: 'cash',
    lines: [{ description: 'Hand-tooled shield', quantity: 2, unitPrice: 90 }],
  }));
  await markQuoteCashPaid(env, shield.id);

  const live = await dashboard(liveEnv);
  const liveHtml = await live.text();
  const liveBuild = liveHtml.includes('<section id="build"') ? section(liveHtml, 'build') : '';
  check('the dashboard loads', live.status === 200, `status ${live.status}`);
  check('with the catalog order\'s options on the list', liveBuild.includes('DOYLE'));
  check('the crew job\'s lines, read from its quote record',
    liveBuild.includes('<span class="pc-qty many">12&times;</span> Fully custom radio strap &lt;black&gt;'));
  check('and the waiting cash job\'s',
    liveBuild.includes('<span class="pc-qty many">2&times;</span> Hand-tooled shield'));
  check('the handed-over job stays off it', !liveBuild.includes('Retirement axe plaque'));
  check('the card\'s styles and script are on the page, once each',
    liveHtml.split(BUILD_STYLES).length === 2 && liveHtml.split(BUILD_SCRIPT).length === 2);
  check('it is still behind the login', (await dashboard(liveEnv, {})).status === 401);

  // The promise that matters most: the quote reads failing is a thinner list,
  // never a dashboard that will not open.
  const down = await dashboard({
    ...liveEnv,
    QUOTES: { ...env.QUOTES, get: async () => { throw new Error('KV is down'); } },
  });
  const downHtml = await down.text();
  check('with the quote records unreadable the dashboard still loads', down.status === 200, `status ${down.status}`);
  check('and every job keeps its row, pointing at its sheet', () => {
    const list = section(downHtml, 'build');
    return list.includes('12 Memorial Radio Straps — Station 4') && list.includes('Station 9 shield')
      && list.includes('The lines and build notes are on the quote sheet.') && list.includes('DOYLE');
  });

  suite('build list — on the dashboard');

  const dash = renderDashboard(analyze(orders, 'all'), {});
  check('it sits above the ship queue: build it, then ship it',
    dash.indexOf('<section id="build"') > 0
    && dash.indexOf('<section id="build"') < dash.indexOf('<section id="queue"'));
  check('the rail links to it, above the ship queue',
    /<a href="#build"[^>]*>Build list<\/a>\s*<a href="#queue"/.test(dash));
  check('and from the other pages behind the login',
    renderRail({ active: 'expenses' }).includes('href="/dashboard#build"'));
  check('the card is one section, start to finish',
    card.startsWith('<section id="build" class="card">')
    && (card.match(/<section/g) || []).length === 1 && card.split('</section>').length === 2);
  check('by product is the one showing; by date is there, hidden',
    /<div class="bview" data-buildview="product">/.test(card)
    && /<div class="bview" data-buildview="date" hidden>/.test(card));
  check('the chip for the one showing is the one pressed', () => {
    const chips = [...card.matchAll(/<button type="button" class="chip( on)?" data-view="(\w+)"\s+aria-pressed="(true|false)"/g)]
      .map((m) => `${m[2]}:${m[1] ? 'on' : 'off'}:${m[3]}`);
    return same(chips, ['product:on:true', 'date:off:false']);
  });
  check('every chip has a list to show', () => {
    const chips = [...card.matchAll(/data-view="(\w+)"/g)].map((m) => m[1]);
    return chips.length === 2 && chips.every((key) => card.includes(`data-buildview="${key}"`));
  });
  check('both arrangements hold exactly the same pieces',
    same([...slips(view(card, 'product'))].sort(), [...slips(view(card, 'date'))].sort())
    && (view(card, 'product').match(/<li class="piece">/g) || []).length === 6
    && (view(card, 'date').match(/<li class="piece">/g) || []).length === 6);
  // The Email button is counted across the page by customer-mail's checks,
  // and a third one here would also be a third place to send from.
  check('it adds no Email button and no checkbox of its own',
    !card.includes('cmail') && !card.includes('type="checkbox"'));

  const empty = renderBuildCard([], []);
  check('nothing owed says so', empty.includes('Nothing to build.') && !empty.includes('buildview'));
  check('and is still the section the rail points at', empty.startsWith('<section id="build" class="card">'));
  check('called with nothing at all it still renders', () => renderBuildCard().includes('Nothing to build.'));
  check('a dashboard with no orders renders it empty',
    section(renderDashboard(analyze([], '30d'), {}), 'build').includes('Nothing to build.'));

  suite('build list — the script and the styles');

  let parsed = true;
  try { new Function(BUILD_SCRIPT); } catch (err) { parsed = err.message; }
  check('the script parses', parsed === true, String(parsed));
  check('it remembers the choice under the key the module names',
    BUILD_SCRIPT.includes(JSON.stringify(BUILD_VIEW_KEY)) && BUILD_SCRIPT.includes('localStorage'));
  check('it reads the same attributes the card writes',
    BUILD_SCRIPT.includes("getElementById('buildview')") && card.includes('id="buildview"')
    && BUILD_SCRIPT.includes('data-buildview') && BUILD_SCRIPT.includes('data-view'));
  check('neither can close the tag it is inlined in',
    !/<\/script/i.test(BUILD_SCRIPT) && !/<\/style/i.test(BUILD_STYLES));
  check('every class the card uses has a rule', () => {
    // Every kind of row at once: catalog work, a crew job, a cash job, nothing.
    const all = card + jobs + blind + empty;
    const used = new Set([...all.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
    // Shared with the rest of the dashboard, styled in DASHBOARD_STYLES.
    const shared = ['card', 'cardhead', 'cardnote', 'hint', 'filters', 'chip', 'on', 'soft', 'block', 'mono',
      'due', 'hot', 'soon', 'pill', 'cash', 'empty'];
    const missing = [...used].filter((c) => !shared.includes(c) && !BUILD_STYLES.includes('.' + c));
    if (missing.length) throw new Error('no rule for: ' + missing.join(' '));
    return used.size > 20;
  });
  // Stepping through slips has to follow the arrangement on screen, and the
  // other one is still in the page, hidden. See rememberSlipList.
  check('the slip stepper skips anything hidden above the link, not just a hidden row',
    DASHBOARD_SCRIPT.includes("a.closest('[hidden]')"));
}
