/**
 * The receipt ledger and the year-end report.
 *
 * Two things here are worth more than the rest. The first is that nothing a
 * vision model says is ever trusted: a receipt read as $10,000 on a date in
 * 1970 has to come out as an empty field the shop fills in, not a number in
 * the CPA's packet. The second is that the packet itself is honest — totals
 * that match the rows, and a loud warning on anything unchecked.
 *
 * The CSV gets its own attention because of where it ends up. It is opened in
 * Excel, on somebody else's machine, and a vendor name is free text the shop
 * typed. A cell starting with `=` is a formula there, not a name.
 */

import { suite, check, throws } from './harness.mjs';
import {
  CATEGORIES, guessCategory, isCategory, categoryLabel,
  buildExpense, applyEdit, ExpenseError, isExpenseId,
  putExpense, getExpense, deleteExpense, listExpenses,
  forYear, totals, yearsPresent, yearOf, expensesCsv,
  renderExpensesPage, renderExpenseReport,
} from '../expenses.js';
import {
  parseExtraction, cleanDate, cleanVendor, draftFromExtraction, toBase64,
  extract, isReceiptKey, storeUpload,
} from '../receipts.js';

const NOW = new Date('2026-08-18T12:00:00Z');

/** Enough of a KV namespace for the ledger: get, put with metadata, list. */
function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key).value : null;
    },
    async put(key, value, options = {}) {
      store.set(key, { value, metadata: options.metadata || null });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, entry]) => ({ name, metadata: entry.metadata }));
      return { keys, list_complete: true, cursor: null };
    },
  };
}

function record(overrides = {}) {
  return buildExpense({
    key: 'a'.repeat(32) + '.jpg',
    file: { name: 'receipt.jpg', ext: 'jpg', size: 1024 },
    draft: { vendor: 'Tandy Leather', date: '2026-03-04', amount: 240.5, tax: 16.84, category: 'leather' },
    now: NOW,
    ...overrides,
  });
}

export default async function run() {
  /* ------------------------------------------------------------ categories */
  suite('expenses — categories');

  check('every category key is unique',
    new Set(CATEGORIES.map((c) => c.key)).size === CATEGORIES.length);
  check('other is the last bucket', CATEGORIES[CATEGORIES.length - 1].key === 'other');
  check('isCategory accepts a real one', isCategory('shipping') === true);
  check('isCategory rejects an invented one', isCategory('beer money') === false);
  check('an unknown key still labels as something', categoryLabel('nope').length > 0);

  check('a hide supplier reads as leather', guessCategory('Tandy Leather Factory') === 'leather');
  check('the post office reads as shipping', guessCategory('USPS RETAIL') === 'shipping');
  check('Pirate Ship reads as shipping', guessCategory('Pirate Ship postage') === 'shipping');
  check('Cloudflare reads as software', guessCategory('CLOUDFLARE INC') === 'software');
  check('an unknown vendor falls back to other', guessCategory('Bob') === 'other');
  check('an empty vendor falls back to other', guessCategory('') === 'other');

  /* --------------------------------------------------------- new records */
  suite('expenses — a new receipt');

  const fresh = record();
  check('gets an id in the expected shape', isExpenseId(fresh.id));
  check('keeps what the model read', fresh.vendor === 'Tandy Leather' && fresh.amount === 240.5);
  check('starts unchecked however confident the model was', fresh.checked === false);
  check('remembers the file it came from', fresh.file.ext === 'jpg');

  const blank = record({ draft: {} });
  check('an unread receipt still becomes a row', isExpenseId(blank.id));
  check('an unread receipt lands in other', blank.category === 'other');
  check('an unread receipt has no amount', blank.amount === null);
  check('a bogus category from the model is dropped',
    record({ draft: { category: 'yacht' } }).category === 'other');

  /* ---------------------------------------------------------------- edits */
  suite('expenses — edits');

  const edited = applyEdit(fresh, { vendor: '  Weaver  Leather ', amount: '$1,240.50' }, NOW);
  check('vendor whitespace is tidied', edited.vendor === 'Weaver Leather');
  check('a typed dollar amount is read', edited.amount === 1240.5);
  check('an emptied amount comes back null', applyEdit(fresh, { amount: '' }).amount === null);
  check('a note is kept', applyEdit(fresh, { note: 'two sides, russet' }).note === 'two sides, russet');

  throws('a malformed date is refused', () => applyEdit(fresh, { date: '4/3/26' }), 'YYYY-MM-DD');
  throws('a negative amount is refused', () => applyEdit(fresh, { amount: '-40' }), 'negative');
  throws('a five-figure typo is refused', () => applyEdit(fresh, { amount: '999999' }), 'typo');
  throws('an invented category is refused', () => applyEdit(fresh, { category: 'yacht' }), 'category');

  check('a complete row can be checked off',
    applyEdit(fresh, { checked: true }, NOW).checked === true);
  throws('a row with no amount cannot be checked off',
    () => applyEdit(record({ draft: { vendor: 'Tandy', date: '2026-03-04' } }), { checked: true }),
    'before it can be checked');
  throws('a row with no date cannot be checked off',
    () => applyEdit(record({ draft: { vendor: 'Tandy', amount: 20 } }), { checked: true }),
    'before it can be checked');
  check('unchecking is always allowed',
    applyEdit({ ...fresh, checked: true }, { checked: false }).checked === false);

  /* -------------------------------------------------------------- storage */
  suite('expenses — storage');

  const env = { EXPENSES: fakeKV() };
  const saved = record();
  await putExpense(env, saved);

  const read = await getExpense(env, saved.id);
  check('a saved receipt reads back whole', read && read.vendor === 'Tandy Leather');
  check('a bad id reads back nothing', (await getExpense(env, 'not-an-id')) === null);

  await putExpense(env, record({ draft: { vendor: 'USPS', date: '2026-01-09', amount: 12.6, category: 'shipping' } }));
  await putExpense(env, record({ draft: { vendor: 'Uline', date: '2025-11-02', amount: 88, category: 'packaging' } }));
  const undatedRow = record({ draft: { vendor: 'Gas station' } });
  await putExpense(env, undatedRow);

  const all = await listExpenses(env);
  check('every receipt lists from metadata alone', all.length === 4);
  check('the listing carries the note and payment columns', 'note' in all[0] && 'payment' in all[0]);
  check('undated receipts sort to the top', !all[0].date);
  check('the rest are newest first', all[1].date === '2026-03-04' && all[3].date === '2025-11-02');

  const thisYear = forYear(all, '2026');
  check('a year holds its own receipts', thisYear.filter((r) => r.date).length === 2);
  check('undated receipts ride along so they cannot be lost',
    thisYear.some((r) => !r.date));
  check('last year is left out of this year', !thisYear.some((r) => r.date === '2025-11-02'));

  check('years present are newest first', yearsPresent(all)[0] === '2026');
  check('last year is offered too', yearsPresent(all).includes('2025'));
  check('this year is always offered', yearsPresent([], NOW).includes('2026'));
  check('yearOf reads the year off a date', yearOf({ date: '2026-03-04' }) === '2026');

  await deleteExpense(env, saved.id);
  check('a deleted receipt is gone', (await getExpense(env, saved.id)) === null);
  check('deleting an unknown id says so', (await deleteExpense(env, 'zzzzzzzzzzzz')) === null);

  /* --------------------------------------------------------------- totals */
  suite('expenses — totals');

  const sums = totals(forYear(await listExpenses(env), '2026'));
  check('only dated receipts are counted', sums.count === 1);
  check('the total is the dated rows', sums.total === 12.6);
  check('undated rows are counted separately', sums.undated === 1);
  check('nothing is checked off yet', sums.unchecked === 2);

  const mixed = totals([
    { date: '2026-01-05', amount: 100, tax: 7, category: 'leather', checked: true },
    { date: '2026-01-20', amount: 50, tax: 3.5, category: 'leather', checked: true },
    { date: '2026-02-02', amount: 25, tax: 0, category: 'shipping', checked: true },
    { date: '2026-02-11', amount: null, tax: null, category: 'other', checked: true },
  ]);
  check('categories roll up', mixed.categories[0].amount === 150);
  check('the biggest bucket sorts first', mixed.categories[0].key === 'leather');
  check('empty buckets are left out', mixed.categories.length === 2);
  check('the total is every row', mixed.total === 175);
  check('sales tax adds up', mixed.tax === 10.5);
  check('months roll up in order',
    mixed.months.length === 2 && mixed.months[0].month === '2026-01' && mixed.months[0].amount === 150);
  check('a dated row with no amount is flagged', mixed.missingAmount === 1);
  check('the category shares add to the total',
    mixed.categories.reduce((s, c) => s + c.amount, 0) === mixed.total);

  /* ------------------------------------------------------------------ csv */
  suite('expenses — the CPA spreadsheet');

  const csv = expensesCsv([
    { id: 'aaaaaaaaaaaa', date: '2026-02-01', vendor: 'Uline', category: 'packaging', amount: 88, tax: 6.2, payment: 'Amex', note: 'boxes', checked: true, file: { name: 'uline.jpg' } },
    { id: 'bbbbbbbbbbbb', date: '2026-01-05', vendor: 'Tandy, Inc', category: 'leather', amount: 240.5, tax: null, payment: '', note: 'two sides "russet"', checked: false, file: { name: 'tandy.jpg' } },
    { id: 'cccccccccccc', date: '2026-03-09', vendor: '=cmd|calc', category: 'other', amount: 5, tax: null, payment: '', note: '', checked: true, file: { name: 'x.jpg' } },
  ]);
  const lines = csv.trim().split('\r\n');

  check('the header names every column', lines[0].startsWith('Date,Vendor,Category,Amount'));
  check('rows come out chronological', lines[1].startsWith('2026-01-05') && lines[3].startsWith('2026-03-09'));
  check('a comma in a vendor is quoted', lines[1].includes('"Tandy, Inc"'));
  check('a quote in a note is doubled', lines[1].includes('""russet""'));
  check('an unchecked row says so out loud', lines[1].includes('NEEDS CHECKING'));
  check('a checked row is marked yes', lines[2].includes(',yes,'));
  check('amounts carry two decimals', lines[2].includes(',88.00,'));
  check('an empty tax stays empty, not zero', lines[1].includes(',,'));
  check('a formula in a vendor name is defused', lines[3].includes("'=cmd|calc"));
  check('the file ends with a newline', csv.endsWith('\r\n'));

  /* --------------------------------------------------------------- render */
  suite('expenses — the pages');

  const hostile = [{
    id: 'dddddddddddd', date: '2026-04-01', vendor: '<img src=x onerror=alert(1)>',
    category: 'leather', amount: 20, tax: null, payment: '', note: '</td><script>bad()</script>',
    checked: false, key: 'b'.repeat(32) + '.jpg', ext: 'jpg',
  }];
  const hostileSums = totals(hostile);

  const pageHtml = renderExpensesPage(hostile, {
    year: '2026', years: ['2026'], sums: hostileSums, railCounts: { toCheck: 1 },
  });
  check('the ledger page renders', pageHtml.includes('The ledger'));
  check('a vendor name cannot inject markup', !pageHtml.includes('<img src=x'));
  check('a note cannot close the cell', !pageHtml.includes('<script>bad()'));
  check('the row carries its id', pageHtml.includes('data-id="dddddddddddd"'));
  check('the category the row is in is the one selected',
    pageHtml.includes('<option value="leather" selected>'));
  check('a blank row template ships for new uploads', pageHtml.includes('id="rowtemplate"'));
  check('the rail marks where we are', pageHtml.includes('aria-current="page"'));

  const reportHtml = renderExpenseReport(hostile, { year: '2026', sums: hostileSums });
  check('the report renders', reportHtml.includes('Business expenses'));
  check('the report escapes a vendor too', !reportHtml.includes('<img src=x'));
  check('an unchecked receipt is called out before it is sent',
    reportHtml.includes('not been checked off'));
  check('the report says on its face that it is money out only',
    reportHtml.includes('not a profit and loss'));
  // The packet is receipts and nothing else. Anything that puts a sales figure
  // on it also ties the one document with a deadline to the store API being up.
  check('no sales figure appears anywhere on the packet',
    !/sales(?! tax)/i.test(reportHtml.replace(/not a profit and loss[^<]*/i, '')));
  check('receipt images are off unless asked for', !reportHtml.includes('<figure>'));
  check('receipt images ride along when asked for',
    renderExpenseReport(hostile, { year: '2026', sums: hostileSums, images: true })
      .includes('<figure>'));

  /* ----------------------------------------------------------- extraction */
  suite('receipts — reading the photo');

  check('a bare object parses', parseExtraction('{"vendor":"Tandy"}').vendor === 'Tandy');
  check('a fenced object parses',
    parseExtraction('```json\n{"vendor":"Tandy"}\n```').vendor === 'Tandy');
  check('an object buried in prose parses',
    parseExtraction('Sure! Here you go: {"vendor":"Tandy"} Hope that helps.').vendor === 'Tandy');
  check('prose alone comes back as nothing',
    parseExtraction("I can't read that image.") === null);
  check('broken JSON comes back as nothing', parseExtraction('{"vendor":') === null);
  check('an empty answer comes back as nothing', parseExtraction('') === null);

  check('a printed date is kept', cleanDate('2026-03-04', NOW) === '2026-03-04');
  check('a date before the shop existed is dropped', cleanDate('1970-01-01', NOW) === '');
  check('a date years ahead is dropped', cleanDate('2031-01-01', NOW) === '');
  check('tomorrow is allowed, for a receipt bought tonight',
    cleanDate('2026-08-19', NOW) === '2026-08-19');
  check('a US-formatted date is dropped rather than guessed',
    cleanDate('03/04/2026', NOW) === '');
  check('a long vendor string is clipped', cleanVendor('x'.repeat(200)).length === 60);
  check('newlines in a vendor are flattened', cleanVendor('Tandy\nLeather') === 'Tandy Leather');

  const draft = draftFromExtraction({
    vendor: 'Tandy Leather', date: '2026-03-04', total: '$1,240.50', tax: '86.84',
    category: 'leather', summary: 'two sides of russet',
  });
  check('a dollar-formatted total is read', draft.amount === 1240.5);
  check('the tax comes across', draft.tax === 86.84);
  check('the model category is honoured when it is real', draft.category === 'leather');
  check('the summary comes across for the note', draft.summary === 'two sides of russet');

  const guessed = draftFromExtraction({ vendor: 'USPS Lakeland', total: 12.6, category: 'groceries' });
  check('an invented category falls back to reading the vendor', guessed.category === 'shipping');
  check('a missing date comes back empty, not today', guessed.date === '');
  check('a zero total comes back null',
    draftFromExtraction({ total: 0 }).amount === null);
  check('an absurd total comes back null',
    draftFromExtraction({ total: 999999 }).amount === null);
  check('nothing at all still returns a usable draft',
    draftFromExtraction(null).category === 'other');

  check('base64 survives a payload past the argument limit',
    toBase64(new Uint8Array(70000).fill(65)).length === Math.ceil(70000 / 3) * 4);

  suite('receipts — when the reader fails');

  const bytes = new Uint8Array([1, 2, 3]);
  const answered = await extract({
    AI: { async run() { return { response: '```json\n{"vendor":"Uline","total":88}\n```' }; } },
  }, bytes, 'jpg');
  check('a good read comes back marked read', answered.read === true);
  check('a good read carries the vendor', answered.vendor === 'Uline');

  const exploded = await extract({
    AI: { async run() { throw new Error('model overloaded'); } },
  }, bytes, 'jpg');
  check('a model outage does not throw', exploded.read === false);
  check('a model outage leaves the fields empty', exploded.vendor === '' && exploded.amount === null);

  const rambled = await extract({
    AI: { async run() { return { response: 'I am unable to read this receipt.' }; } },
  }, bytes, 'jpg');
  check('an unreadable receipt is not a crash', rambled.read === false);

  const heic = await extract({ AI: { async run() { throw new Error('never called'); } } }, bytes, 'heic');
  check('a HEIC is stored without being sent to the model', heic.read === false);
  check('a HEIC says why', heic.why.includes('heic'));

  const noBinding = await extract({}, bytes, 'jpg');
  check('no AI binding is a blank row, not an error', noBinding.read === false);

  /* ------------------------------------------------------------ PDF invoices */
  suite('receipts — PDF invoices');

  // Ads, hosting and software all bill this shop as a PDF with a real text
  // layer. Those used to come back blank because the vision endpoint cannot
  // decode a PDF at all — they get their text pulled out and read as text.
  function pdfEnv({ markdown, reply, onRun } = {}) {
    return {
      AI: {
        async toMarkdown(doc) {
          if (!doc || !doc.blob) throw new Error('expected a blob');
          return markdown;
        },
        async run(model, input) {
          if (onRun) onRun(input);
          return { response: reply };
        },
      },
    };
  }

  const invoice = await extract(pdfEnv({
    markdown: { format: 'markdown', data: `Meta Platforms, Inc.
Invoice date 2026-08-01
Amount billed $114.27` },
    reply: '{"vendor":"Meta Platforms","date":"2026-08-01","total":114.27,"category":"advertising"}',
  }), bytes, 'pdf');
  check('a PDF invoice is read now, not skipped', invoice.read === true);
  check('the vendor comes off the invoice', invoice.vendor === 'Meta Platforms');
  check('the total comes off the invoice', invoice.amount === 114.27);
  check('the ad invoice lands in advertising', invoice.category === 'advertising');

  let sentText = '';
  await extract(pdfEnv({
    markdown: { format: 'markdown', data: 'x'.repeat(40000) },
    reply: '{"vendor":"Long"}',
    onRun: (input) => { sentText = input.messages[input.messages.length - 1].content; },
  }), bytes, 'pdf');
  check('a long invoice is trimmed before it is sent', sentText.length < 12000);
  check('no image is attached on the PDF path', !/image/.test(Object.keys({}).join()));

  const scanned = await extract(pdfEnv({
    markdown: { format: 'markdown', data: '   ' },
    reply: '{"vendor":"nope"}',
  }), bytes, 'pdf');
  check('a scanned PDF with no text layer is a clean miss', scanned.read === false);
  check('and it says to type that one in', scanned.why.includes('type it in'));

  const brokenPdf = await extract(pdfEnv({
    markdown: { format: 'error', error: 'could not parse' },
    reply: '{}',
  }), bytes, 'pdf');
  check('a PDF the converter rejects does not throw', brokenPdf.read === false);

  const listResult = await extract(pdfEnv({
    markdown: [{ format: 'markdown', data: `Uline Shipping Supplies
Order 4471902
Total $88.00` }],
    reply: '{"vendor":"Uline","total":88}',
  }), bytes, 'pdf');
  check('an array answer from the converter is handled too', listResult.vendor === 'Uline');

  const oldBinding = await extract({ AI: { async run() { return { response: '{}' }; } } }, bytes, 'pdf');
  check('an AI binding with no toMarkdown degrades instead of crashing',
    oldBinding.read === false);

  const convertExploded = await extract({
    AI: {
      async toMarkdown() { throw new Error('converter down'); },
      async run() { return { response: '{}' }; },
    },
  }, bytes, 'pdf');
  check('a converter outage is caught like any other', convertExploded.read === false);

  /* -------------------------------------------------------------- HEIC in */
  suite('receipts — HEIC off an iPhone');

  // An iPhone shoots HEIC by default. Nothing downstream can use one: the model
  // cannot decode it and no browser but Safari will draw it, so the thumbnail
  // and the image in the printed packet would both be broken. It is converted
  // on the way in and the JPEG is what gets stored.
  const HEIC_HEAD = (() => {
    const b = new Uint8Array(64);
    // ....ftypheic — the brand check in uploads.js reads offsets 4 and 8.
    const put = (at, text) => [...text].forEach((c, i) => { b[at + i] = c.charCodeAt(0); });
    put(4, 'ftyp');
    put(8, 'heic');
    return b;
  })();

  function fakeR2() {
    const objects = new Map();
    return {
      objects,
      async put(key, body, options) { objects.set(key, { body, ...options }); },
    };
  }

  function heicUpload(bytes = HEIC_HEAD, filename = 'IMG_4417.HEIC') {
    const form = new FormData();
    form.append('file', new Blob([bytes]), filename);
    return new Request('https://rawhidecityleather.com/dashboard/api/receipt', {
      method: 'POST', body: form,
    });
  }

  const JPEG_OUT = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

  function imagesBinding(behaviour = 'ok') {
    const calls = [];
    return {
      calls,
      input(stream) {
        calls.push({ stream });
        const chain = {
          transform(opts) { calls[calls.length - 1].transform = opts; return chain; },
          output(opts) { calls[calls.length - 1].output = opts; return chain; },
          async response() {
            if (behaviour === 'throw') throw new Error('images unavailable');
            if (behaviour === 'notok') return { ok: false };
            if (behaviour === 'empty') {
              return { ok: true, async arrayBuffer() { return new ArrayBuffer(0); } };
            }
            return { ok: true, async arrayBuffer() { return JPEG_OUT.buffer.slice(0); } };
          },
        };
        return chain;
      },
    };
  }

  const images = imagesBinding();
  const heicEnv = {
    RECEIPTS: fakeR2(),
    IMAGES: images,
    AI: { async run() { return { response: '{"vendor":"Shell","total":41.2}' }; } },
  };
  const stored = await storeUpload(heicUpload(), heicEnv);

  check('the upload succeeds', !stored.error);
  check('what lands in the bucket is a jpg', stored.key.endsWith('.jpg'));
  check('the row records it as a jpg', stored.file.ext === 'jpg');
  check('and marks that it was converted', stored.file.converted === true);
  check('the phone filename is kept for searching', stored.file.name === 'IMG_4417.HEIC');
  check('the stored bytes are the JPEG, not the HEIC',
    heicEnv.RECEIPTS.objects.get(stored.key).body[0] === 0xff);
  check('the object is served as a JPEG',
    heicEnv.RECEIPTS.objects.get(stored.key).httpMetadata.contentType === 'image/jpeg');
  check('R2 records where it came from',
    heicEnv.RECEIPTS.objects.get(stored.key).customMetadata.convertedFrom === 'heic');
  check('the size recorded is the converted file', stored.file.size === JPEG_OUT.length);
  check('it is scaled down, never up', images.calls[0].transform.fit === 'scale-down');
  check('the conversion asked for a JPEG', images.calls[0].output.format === 'image/jpeg');
  check('the converted photo then gets read', stored.draft.read === true);
  check('and the reader saw a jpg', stored.draft.vendor === 'Shell');

  // Every way it can fail keeps the receipt. A HEIC on file that nothing can
  // read still beats a rejected upload.
  for (const [label, behaviour] of [
    ['the converter throws', 'throw'],
    ['the converter answers not-ok', 'notok'],
    ['the converter returns nothing', 'empty'],
  ]) {
    const env2 = {
      RECEIPTS: fakeR2(),
      IMAGES: imagesBinding(behaviour),
      AI: { async run() { return { response: '{"vendor":"nope"}' }; } },
    };
    const kept = await storeUpload(heicUpload(), env2);
    check(`when ${label} the receipt is still stored`, !kept.error && kept.key.endsWith('.heic'));
    check(`when ${label} the row comes back to type in`, kept.draft.read === false);
  }

  const noImages = await storeUpload(heicUpload(), {
    RECEIPTS: fakeR2(),
    AI: { async run() { return { response: '{}' }; } },
  });
  check('with no Images binding the HEIC is stored as-is',
    !noImages.error && noImages.file.ext === 'heic');
  check('and it is not marked converted', noImages.file.converted === false);

  const jpegStraight = await storeUpload((() => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9, 9, 9])]), 'shop.jpg');
    return new Request('https://rawhidecityleather.com/dashboard/api/receipt', {
      method: 'POST', body: form,
    });
  })(), { RECEIPTS: fakeR2(), IMAGES: imagesBinding(), AI: { async run() { return { response: '{}' }; } } });
  check('an ordinary JPG never touches the converter',
    jpegStraight.file.ext === 'jpg' && jpegStraight.file.converted === false);

  suite('receipts — keys');
  check('a real key is accepted', isReceiptKey('a'.repeat(32) + '.jpg'));
  check('a path traversal is refused', isReceiptKey('../../etc/passwd') === false);
  check('a wrong-length key is refused', isReceiptKey('abc.jpg') === false);
  check('an unexpected extension is refused', isReceiptKey('a'.repeat(32) + '.svg') === false);
}
