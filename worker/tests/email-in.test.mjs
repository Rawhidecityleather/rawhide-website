/**
 * Receipts by email.
 *
 * This handler writes rows into the shop's books off a message anyone can
 * address, so the checks lean hard on the ways it must refuse: an unknown
 * sender, a forged From, an unset allowlist, a message too big to have arrived
 * whole. After that, the things that must survive a bad day — a message is
 * always forwarded, a crash never bounces the mail, an unreadable receipt
 * still becomes a row to type in.
 */

import { suite, check } from './harness.mjs';
import {
  handleEmail, allowedSenders, senderAllowed, authPassed, pickAttachments,
  senderVendor, withFallbacks, emailDate, looksForwarded, MAX_EMAIL_BYTES,
} from '../email-in.js';

const SHOP = 'rawhidecityleather@gmail.com';
const ALLOWED = [SHOP, 'rcon8919@gmail.com'];

function wire(text) {
  return text.replace(/\n/g, '\r\n');
}

function base64(text) {
  return Buffer.from(text, 'binary').toString('base64').replace(/(.{76})/g, '$1\r\n');
}

/**
 * One byte per character. `TextEncoder` would turn the 0x89 that starts a PNG
 * into two UTF-8 bytes and the signature check would never fire — the same
 * trap the parser itself is built to avoid.
 */
function binary(text) {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
}

/** Enough bytes past MIN_ATTACHMENT_BYTES to count as a real attachment. */
function pdfBytes(size = 20000) {
  return '%PDF-1.4\n' + 'x'.repeat(size) + '\n%%EOF';
}

function pngBytes(size) {
  return '\x89PNG\r\n\x1a\n' + 'x'.repeat(size);
}

/* ------------------------------------------------------------------ doubles */

function fakeKV() {
  const store = new Map();
  return {
    store,
    async put(key, value, options) { store.set(key, { value, ...options }); },
    async get(key) { return store.has(key) ? store.get(key).value : null; },
    records() {
      return [...store.values()].map((entry) => JSON.parse(entry.value));
    },
  };
}

function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options) { objects.set(key, { body, ...options }); },
  };
}

function fakeAI(reply = '{"vendor":"Tandy Leather","date":"2026-08-14","total":212.44,"tax":14.87,"category":"leather","summary":"veg tan sides"}') {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push(input);
      if (reply instanceof Error) throw reply;
      return { response: reply };
    },
    async toMarkdown() { return { format: 'markdown', data: 'PDF TEXT: total 212.44' }; },
  };
}

function fakeEnv(overrides = {}) {
  return {
    EXPENSES: fakeKV(),
    RECEIPTS: fakeR2(),
    AI: fakeAI(),
    RECEIPT_SENDERS: ALLOWED.join(','),
    RECEIPT_FORWARD_TO: SHOP,
    ...overrides,
  };
}

/** Stands in for the ForwardableEmailMessage the runtime hands the Worker. */
function fakeMessage(raw, { from = SHOP, headers = {}, rawSize } = {}) {
  const bytes = new TextEncoder().encode(raw);
  const forwarded = [];
  return {
    from,
    to: 'receipts@rawhidecityleather.com',
    forwarded,
    rawSize: rawSize === undefined ? bytes.length : rawSize,
    headers: {
      get(name) { return headers[String(name).toLowerCase()] ?? null; },
    },
    raw: new ReadableStream({
      start(controller) {
        // Two chunks, because the real stream arrives in pieces and a reader
        // that only handles one would pass a single-chunk test.
        controller.enqueue(bytes.subarray(0, Math.ceil(bytes.length / 2)));
        controller.enqueue(bytes.subarray(Math.ceil(bytes.length / 2)));
        controller.close();
      },
    }),
    async forward(address) { forwarded.push(address); },
  };
}

const PASS = { 'authentication-results': 'mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass' };
const FAIL = { 'authentication-results': 'mx.cloudflare.net; dkim=fail; spf=fail; dmarc=fail' };

function withPdf({ from = 'Rob <' + SHOP + '>', subject = 'Fwd: Tandy order 88213' } = {}) {
  return wire(
    `From: ${from}\n` +
    'To: receipts@rawhidecityleather.com\n' +
    `Subject: ${subject}\n` +
    'Date: Tue, 18 Aug 2026 09:12:03 -0400\n' +
    'Content-Type: multipart/mixed; boundary="B"\n' +
    '\n' +
    '--B\n' +
    'Content-Type: text/plain\n' +
    '\n' +
    'forwarding this one\n' +
    '--B\n' +
    'Content-Type: application/pdf; name="invoice.pdf"\n' +
    'Content-Disposition: attachment; filename="invoice.pdf"\n' +
    'Content-Transfer-Encoding: base64\n' +
    '\n' + base64(pdfBytes()) + '\n' +
    '--B--'
  );
}

const HTML_ONLY = wire(
  'From: "Meta Platforms" <billing@meta.com>\n' +
  'To: receipts@rawhidecityleather.com\n' +
  'Subject: Your Meta ads receipt\n' +
  'Date: Mon, 17 Aug 2026 06:00:00 +0000\n' +
  'Content-Type: text/html; charset="utf-8"\n' +
  '\n' +
  '<html><body><h1>Receipt</h1><table><tr><td>Amount billed</td><td>$114.02</td></tr>' +
  '<tr><td>Date</td><td>August 17, 2026</td></tr></table></body></html>'
);

/* -------------------------------------------------------------------- tests */

export default async function run() {
  suite('receipts by email — who may file');

  check('the list is read off the env',
    allowedSenders({ RECEIPT_SENDERS: ' a@b.com , C@D.com ' }).join('|') === 'a@b.com|c@d.com');
  check('an unset list is empty', allowedSenders({}).length === 0);
  check('an allowed sender passes', senderAllowed(SHOP, ALLOWED));
  check('the check is case-insensitive', senderAllowed('RawhideCityLeather@Gmail.com', ALLOWED));
  check('anybody else is refused', senderAllowed('stranger@example.com', ALLOWED) === false);
  check('an empty list refuses everyone — it fails closed',
    senderAllowed(SHOP, []) === false);
  check('a whole-domain entry works',
    senderAllowed('accounts@tandyleather.com', ['@tandyleather.com']));
  check('a domain entry does not match a lookalike',
    senderAllowed('rob@nottandyleather.com.evil.com', ['@tandyleather.com']) === false);
  check('a missing sender is refused', senderAllowed('', ALLOWED) === false);

  check('a passing DMARC is accepted',
    authPassed({ headers: { get: () => PASS['authentication-results'] } }));
  check('SPF and DKIM together are accepted',
    authPassed({ headers: { get: () => 'spf=pass; dkim=pass; dmarc=none' } }));
  check('a failing message is refused',
    authPassed({ headers: { get: () => FAIL['authentication-results'] } }) === false);
  check('SPF alone is not enough',
    authPassed({ headers: { get: () => 'spf=pass; dkim=fail; dmarc=fail' } }) === false);
  check('no header at all is let through — the feature must not die silently',
    authPassed({ headers: { get: () => null } }));

  suite('receipts by email — what counts as a receipt');

  const picked = pickAttachments([
    { name: 'logo.png', inline: true, bytes: binary(pngBytes(2000)) },
    { name: 'invoice.pdf', inline: false, bytes: binary(pdfBytes()) },
    { name: 'notes.txt', inline: false, bytes: binary('x'.repeat(20000)) },
  ]);
  check('a real attachment is picked', picked.length === 1 && picked[0].name === 'invoice.pdf');
  check('a signature logo is left behind', !picked.some((f) => f.name === 'logo.png'));
  check('a file type we cannot store is left behind',
    !picked.some((f) => f.name === 'notes.txt'));

  const ordered = pickAttachments([
    { name: 'small.pdf', inline: false, bytes: binary(pdfBytes(7000)) },
    { name: 'big.pdf', inline: false, bytes: binary(pdfBytes(50000)) },
    { name: 'photo.png', inline: true, bytes: binary(pngBytes(60000)) },
  ]);
  check('the largest attachment leads', ordered[0].name === 'big.pdf');
  check('an inline file sorts behind the real attachments',
    ordered[ordered.length - 1].name === 'photo.png');
  check('a big enough inline photo is still kept', ordered.length === 3);
  check('nothing in, nothing out', pickAttachments([]).length === 0);
  check('an undefined list does not throw', pickAttachments(undefined).length === 0);

  suite('receipts by email — filling the gaps');

  check('the send date is read', emailDate('Tue, 18 Aug 2026 09:12:03 -0400') === '2026-08-18');
  check('an unparseable date is empty', emailDate('sometime last week') === '');
  check('a date before the shop existed is refused', emailDate('Wed, 01 Jan 2020 00:00:00 +0000') === '');

  const vendorFromName = senderVendor({ from: 'billing@meta.com', fromName: 'Meta Platforms' }, ALLOWED);
  check('a sender display name becomes the vendor', vendorFromName === 'Meta Platforms');
  check('with no display name the domain is used',
    senderVendor({ from: 'invoices@uline.com', fromName: '' }, ALLOWED) === 'uline.com');
  check('a no-reply prefix is trimmed off the domain',
    senderVendor({ from: 'x@billing.tandyleather.com', fromName: '' }, ALLOWED) === 'tandyleather.com');
  check('the shop forwarding to itself is not a vendor',
    senderVendor({ from: SHOP, fromName: 'Rob' }, ALLOWED) === '');

  const filled = withFallbacks(
    { vendor: '', date: '', amount: null, tax: null, category: 'other', summary: '' },
    { from: 'billing@meta.com', fromName: 'Meta', subject: 'Your Meta ads receipt', date: 'Mon, 17 Aug 2026 06:00:00 +0000' },
    { allowed: ALLOWED, useDate: true }
  );
  check('the vendor falls back to the sender', filled.vendor === 'Meta');
  check('the note falls back to the subject', filled.summary === 'Your Meta ads receipt');
  check('the date falls back to the day it was sent', filled.date === '2026-08-17');
  check('the category is re-guessed from what was filled in',
    filled.category === 'advertising');

  const kept = withFallbacks(
    { vendor: 'Tandy Leather', date: '2026-08-14', amount: 212.44, tax: null, category: 'leather', summary: 'veg tan sides' },
    { from: 'billing@meta.com', fromName: 'Meta', subject: 'Fwd: something else', date: 'Mon, 17 Aug 2026 06:00:00 +0000' },
    { allowed: ALLOWED, useDate: true }
  );
  check('what the reader found is never overwritten',
    kept.vendor === 'Tandy Leather' && kept.date === '2026-08-14' && kept.summary === 'veg tan sides');

  const noDate = withFallbacks({ vendor: '', date: '', category: 'other', summary: '' },
    { from: 'x@y.com', subject: 'Fwd: receipt', date: 'Mon, 17 Aug 2026 06:00:00 +0000' },
    { allowed: ALLOWED });
  check('an attachment never takes the date off the email it rode in on',
    noDate.date === '');

  check('a Fwd: subject is a forward', looksForwarded('Fwd: Order #952287 confirmed', ''));
  check('so is Fw:', looksForwarded('Fw: Order #952287 confirmed', ''));
  check('and FWD: shouted', looksForwarded('FWD: receipt', ''));
  check('a forwarded-message separator in the body counts too',
    looksForwarded('Order #952287 confirmed', 'x\n----- Forwarded Message -----\nFrom: LightBurn'));
  check('so does the Apple Mail wording',
    looksForwarded('receipt', 'Begin forwarded message:\nFrom: LightBurn'));
  check('a reply is not a forward', looksForwarded('Re: your order', 'thanks') === false);
  check('a vendor receipt is not a forward',
    looksForwarded('Your Meta ads receipt', 'Amount billed $114.02') === false);
  check('nothing at all is not a forward', looksForwarded('', '') === false);

  suite('receipts by email — filing a PDF invoice');

  const env = fakeEnv();
  const message = fakeMessage(withPdf(), { headers: PASS });
  const report = await handleEmail(message, env);

  check('one row is filed', report.filed === 1);
  check('the message is forwarded to the shop', message.forwarded[0] === SHOP);
  check('the PDF is in the bucket', env.RECEIPTS.objects.size === 1);
  check('it is stored as a pdf', [...env.RECEIPTS.objects.keys()][0].endsWith('.pdf'));

  const [row] = env.EXPENSES.records();
  check('the row carries what the reader found', row.vendor === 'Tandy Leather');
  check('and the total', row.amount === 212.44);
  check('and the date printed on the invoice', row.date === '2026-08-14');
  check('and the category', row.category === 'leather');
  check('the row points at the stored file', row.key === [...env.RECEIPTS.objects.keys()][0]);
  check('the attachment filename is kept', row.file.name === 'invoice.pdf');
  check('the row lands unchecked, whatever the model said', row.checked === false);
  check('the row is marked as read by the model', row.read === true);

  suite('receipts by email — filing an emailed receipt with no attachment');

  // Billed straight to the filing address rather than forwarded — which only
  // works because the shop put the vendor's domain on the allowlist itself.
  const htmlEnv = fakeEnv({
    RECEIPT_SENDERS: ALLOWED.join(',') + ',@meta.com',
    AI: fakeAI('{"vendor":"Meta","date":"2026-08-17","total":114.02,"category":"advertising","summary":"ads billing"}'),
  });
  const htmlReport = await handleEmail(fakeMessage(HTML_ONLY, { from: 'billing@meta.com', headers: PASS }), htmlEnv);

  check('the body itself becomes a row', htmlReport.filed === 1);
  const [htmlRow] = htmlEnv.EXPENSES.records();
  check('the numbers come off the body', htmlRow.amount === 114.02);
  check('the body is kept as the original', htmlRow.key.endsWith('.html'));
  check('and it is in the bucket', htmlEnv.RECEIPTS.objects.size === 1);
  check('served as html, so it opens in the browser',
    htmlEnv.RECEIPTS.objects.get(htmlRow.key).httpMetadata.contentType.startsWith('text/html'));
  check('R2 records that it came from an email',
    htmlEnv.RECEIPTS.objects.get(htmlRow.key).customMetadata.source === 'email');
  check('the reader was given the flattened text, not the markup',
    htmlEnv.AI.calls[0].messages[1].content.includes('Amount billed $114.02'));
  check('this row too lands unchecked', htmlRow.checked === false);

  // The first real receipt through this in production: a LightBurn order from
  // May, forwarded on in May, forwarded again to the filing address in August.
  // It filed under August. The send date belongs to the forward, not the
  // purchase, and no fallback is better than a wrong month.
  const forwardBody = (subject, separator) => wire(
    `From: Rob <${SHOP}>\n` +
    'To: receipts-k7f2q9@rawhidecityleather.com\n' +
    `Subject: ${subject}\n` +
    'Date: Wed, 19 Aug 2026 18:03:00 +0000\n' +
    'Content-Type: text/html; charset="utf-8"\n' +
    '\n' +
    `<html><body>${separator}<p>From: "LightBurn Software"</p>` +
    '<p>Sent: Mon, May 25, 2026 at 2:19 PM</p>' +
    '<table><tr><td>Order summary</td></tr>' +
    '<tr><td>Upgrade LightBurn Core to LightBurn Pro</td><td>$100.00</td></tr>' +
    '<tr><td>Total</td><td>$100.00 USD</td></tr></table></body></html>'
  );

  const undatedEnv = fakeEnv({
    AI: fakeAI('{"vendor":"LightBurn Software","total":100,"category":"software","summary":"LightBurn Core to LightBurn Pro upgrade"}'),
  });
  const undatedReport = await handleEmail(
    fakeMessage(forwardBody('Fw: Order #952287 confirmed', ''), { headers: PASS }), undatedEnv);
  const [undatedRow] = undatedEnv.EXPENSES.records();

  check('a forwarded receipt still files', undatedReport.filed === 1);
  check('with the vendor and total read off it',
    undatedRow.vendor === 'LightBurn Software' && undatedRow.amount === 100);
  check('but NOT the day it was forwarded', undatedRow.date === '');
  check('so it sorts to the top of the ledger as unfinished',
    undatedRow.date === '' && undatedRow.checked === false);

  const separatorEnv = fakeEnv({
    AI: fakeAI('{"vendor":"LightBurn Software","total":100,"category":"software"}'),
  });
  await handleEmail(fakeMessage(
    forwardBody('Order #952287 confirmed', '----- Forwarded Message -----'),
    { headers: PASS }), separatorEnv);
  check('a forward with an ordinary subject is caught by the body separator',
    separatorEnv.EXPENSES.records()[0].date === '');

  const directEnv = fakeEnv({
    AI: fakeAI('{"vendor":"LightBurn Software","total":100,"category":"software"}'),
  });
  await handleEmail(fakeMessage(
    forwardBody('Order #952287 confirmed', ''), { headers: PASS }), directEnv);
  check('a receipt that is not a forward still takes the send date',
    directEnv.EXPENSES.records()[0].date === '2026-08-19');

  suite('receipts by email — what it refuses');

  const stranger = fakeEnv();
  const strangerMessage = fakeMessage(withPdf({ from: 'stranger@example.com' }),
    { from: 'stranger@example.com', headers: PASS });
  const strangerReport = await handleEmail(strangerMessage, stranger);
  check('a stranger files nothing', strangerReport.filed === 0);
  check('and is told why in the log', strangerReport.why === 'sender not on the list');
  check('nothing reaches the ledger', stranger.EXPENSES.store.size === 0);
  check('nothing reaches the bucket', stranger.RECEIPTS.objects.size === 0);
  check('but the shop still gets the message', strangerMessage.forwarded[0] === SHOP);

  const forged = fakeEnv();
  const forgedReport = await handleEmail(fakeMessage(withPdf(), { headers: FAIL }), forged);
  check('a forged From files nothing', forgedReport.filed === 0);
  check('and says so', forgedReport.why === 'failed SPF, DKIM and DMARC');

  const unset = fakeEnv({ RECEIPT_SENDERS: '' });
  const unsetReport = await handleEmail(fakeMessage(withPdf(), { headers: PASS }), unset);
  check('with no allowlist configured nothing files', unsetReport.filed === 0);
  check('and the reason names the missing setting',
    unsetReport.why === 'RECEIPT_SENDERS is not set');

  const huge = fakeEnv();
  const hugeMessage = fakeMessage(withPdf(), { headers: PASS, rawSize: MAX_EMAIL_BYTES + 1 });
  const hugeReport = await handleEmail(hugeMessage, huge);
  check('a message too big to have arrived whole is not filed', hugeReport.filed === 0);
  check('and is forwarded anyway', hugeMessage.forwarded[0] === SHOP);

  const empty = fakeEnv();
  const emptyReport = await handleEmail(
    fakeMessage(wire('From: Rob <' + SHOP + '>\nSubject: hi\n\n'), { headers: PASS }), empty);
  check('an email with nothing in it files nothing', emptyReport.filed === 0);
  check('and the ledger stays clean', empty.EXPENSES.store.size === 0);

  suite('receipts by email — when things break');

  const blind = fakeEnv({ AI: fakeAI(new Error('model unavailable')) });
  const blindReport = await handleEmail(fakeMessage(withPdf(), { headers: PASS }), blind);
  check('a dead model still files the receipt', blindReport.filed === 1);
  const [blindRow] = blind.EXPENSES.records();
  check('the row comes back to type in', blindRow.read === false);
  check('with the file kept behind it', Boolean(blindRow.key));
  check('and the subject as the note', blindRow.note === 'Fwd: Tandy order 88213');

  const noBucket = fakeEnv({ RECEIPTS: null });
  const noBucketReport = await handleEmail(fakeMessage(withPdf(), { headers: PASS }), noBucket);
  check('with no bucket bound nothing is filed', noBucketReport.filed === 0);
  check('and nothing half-written lands in the ledger', noBucket.EXPENSES.store.size === 0);

  const brokenKV = fakeEnv({
    EXPENSES: { async put() { throw new Error('KV down'); } },
  });
  const brokenMessage = fakeMessage(withPdf(), { headers: PASS });
  const brokenReport = await handleEmail(brokenMessage, brokenKV);
  check('a crash mid-file never throws out of the handler', brokenReport.why === 'crashed');
  check('and the message is still forwarded, so the receipt is not lost',
    brokenMessage.forwarded[0] === SHOP);

  const noForward = fakeEnv({ RECEIPT_FORWARD_TO: '' });
  const noForwardMessage = fakeMessage(withPdf(), { headers: PASS });
  const noForwardReport = await handleEmail(noForwardMessage, noForward);
  check('with no forwarding address the receipt still files', noForwardReport.filed === 1);
  check('and nothing is forwarded', noForwardMessage.forwarded.length === 0);

  const badForward = fakeEnv();
  const badForwardMessage = fakeMessage(withPdf(), { headers: PASS });
  badForwardMessage.forward = async () => { throw new Error('not a verified destination'); };
  const badForwardReport = await handleEmail(badForwardMessage, badForward);
  check('a forward that fails does not lose the row', badForwardReport.filed === 1);
}
