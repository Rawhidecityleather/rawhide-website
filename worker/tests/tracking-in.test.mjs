/**
 * Tracking, back from Pirate Ship on its own.
 *
 * This one writes to live orders off a message that arrives unbidden, so most
 * of what matters is what it refuses: mail from anyone but Pirate Ship, mail
 * for an address with no open order, and the second copy of a tracking email
 * that would otherwise re-ship an order already out the door.
 *
 * The other half is the address block that goes the other way. Its whole job is
 * to survive a paste into a parser we cannot test against, so the checks pin
 * the shape: envelope order, no empty lines, and no country line on a domestic
 * label — where a stray "US" reads as a fourth street line and shoves the zip
 * out of place.
 */

import { suite, check } from './harness.mjs';
import { pirateShipAddressBlock, findTrackingNumber } from '../pirateship.js';
import {
  isTrackingAddress, trackingSenders, senderAllowed, matchOrder, handleTrackingEmail,
  authStrict,
} from '../tracking-in.js';
import { readRaw, MAX_EMAIL_BYTES } from '../email-in.js';

/** Any address will do — the real one is a secret, and not the test's business. */
const INBOX = 'tracking-test@example.com';
const CUSTOMER = 'jane@example.com';
const USPS = '9400111899223197428490';

/**
 * What Pirate Ship actually sends as — the Sender Email on the template, not
 * anything @pirateship.com, once that address is verified in Postmark.
 * See TRACKING_SENDERS in wrangler.jsonc.
 */
const SENDER = 'shipping@rawhidecityleather.com';

/** The sender on the old Pirate Ship account, still allowed. */
const OLD_SENDER = 'orders@rawhidecitylthr.com';

/**
 * What Postmark sends as while a Sender Email is still UNVERIFIED: the real
 * address moves to reply-to, so only the domain entry can match it.
 */
const UNVERIFIED_SENDER = 'ship@pirateship.com';

/**
 * The envelope sender on the same message: a Postmark bounce address, which is
 * why the allowlist reads the From: header and not this.
 */
const ENVELOPE = 'pm_bounces@pm.mtasv.net';

function order(over = {}) {
  return {
    token: 'tok-aaaaaaaa',
    invoiceNumber: 'RCL-1042',
    email: CUSTOMER,
    status: 'Processed',
    creationDate: '2026-08-01T12:00:00Z',
    shippingAddress: {
      fullName: 'Jane Doe',
      address1: '123 Main St',
      city: 'Lakeland',
      province: 'FL',
      postalCode: '33801',
      country: 'US',
    },
    items: [{ id: 'basic-radio-strap', name: 'Basic Radio Strap', quantity: 1 }],
    ...over,
  };
}

function fakeEnv(over = {}) {
  return {
    SNIPCART_SECRET: 'test-key-never-used',
    TRACKING_INBOX: INBOX,
    TRACKING_SENDERS: 'shipping@rawhidecityleather.com,orders@rawhidecitylthr.com,@pirateship.com',
    ...over,
  };
}

/** Answers the order list, records every write. */
function fakeFetch(orders) {
  const puts = [];
  const fetch = async (url, init = {}) => {
    const href = String(url);
    if (init.method === 'PUT' && href.includes('/api/orders/')) {
      puts.push({ href, body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    }
    if (href.includes('/api/orders?')) {
      return new Response(
        JSON.stringify({ items: orders, totalItems: orders.length }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error('unexpected fetch: ' + href);
  };
  return { fetch, puts };
}

async function withFetch(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}

/** A tracking email as Pirate Ship sends it, BCC'd to the shop. */
function trackingMail({ to = CUSTOMER, tracking = USPS, from = SENDER } = {}) {
  return [
    'From: Rawhide City Leather <' + from + '>',
    'To: ' + to,
    'Subject: Your order has shipped!',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your package is on its way.',
    'Tracking number: ' + tracking,
    'Track it at usps.com',
  ].join('\r\n');
}

/** What Email Routing writes on a message that checked out at the edge. */
const PASS = { 'authentication-results': 'mx.cloudflare.net; dmarc=pass; spf=pass; dkim=pass' };

function fakeMessage(raw, { from = ENVELOPE, to = INBOX, headers = PASS } = {}) {
  const bytes = new TextEncoder().encode(raw);
  return {
    from,
    to,
    rawSize: bytes.length,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, Math.ceil(bytes.length / 2)));
        controller.enqueue(bytes.subarray(Math.ceil(bytes.length / 2)));
        controller.close();
      },
    }),
    async forward() {},
  };
}

const ship = (env, orders, message) =>
  withFetch(fakeFetch(orders).fetch,
    () => handleTrackingEmail(message, env, readRaw, MAX_EMAIL_BYTES));

export default async function run() {
  suite('pirate ship — the address block');

  const block = pirateShipAddressBlock(order());
  check('the name leads', block.split('\n')[0] === 'Jane Doe');
  check('the city line carries state and zip', block.includes('Lakeland, FL 33801'), block);
  check('a domestic label carries no country line', !/\bUS\b/.test(block), block);
  check('the email rides along, because it is what mails tracking back',
    block.includes(CUSTOMER));
  check('no blank lines, which a parser would read as a missing field',
    !block.split('\n').some((line) => line === ''));

  const intl = pirateShipAddressBlock(order({
    shippingAddress: {
      ...order().shippingAddress, country: 'CA', province: 'ON', postalCode: 'M5V 2T6',
    },
  }));
  check('an international label names the country', intl.includes('CA'), intl);

  const sparse = pirateShipAddressBlock({
    email: '', shippingAddress: { fullName: 'Bo', address1: '1 A St' },
  });
  check('missing fields collapse instead of leaving holes',
    sparse === 'Bo\n1 A St', JSON.stringify(sparse));

  check('a company sits under the name', () => {
    const withCo = pirateShipAddressBlock(order({
      shippingAddress: { ...order().shippingAddress, company: 'Engine 12' },
    }));
    return withCo.split('\n')[1] === 'Engine 12';
  });

  suite('pirate ship — reading a tracking number');

  check('a USPS number is found', findTrackingNumber('Tracking: ' + USPS) === USPS);
  check('a UPS number is found',
    findTrackingNumber('1Z999AA10123456784 shipped') === '1Z999AA10123456784');
  check('prose alone yields nothing', findTrackingNumber('your order has shipped') === '');

  suite('tracking in — which mailbox it is');

  check('the tracking inbox is recognised',
    isTrackingAddress({ to: INBOX }, fakeEnv()) === true);
  check('casing and spacing do not matter',
    isTrackingAddress({ to: '  ' + INBOX.toUpperCase() + ' ' }, fakeEnv()) === true);
  check('the receipts address is left to the receipts handler',
    isTrackingAddress({ to: 'receipts-k7f2q9@rawhidecityleather.com' }, fakeEnv()) === false);
  check('with no inbox configured nothing is a tracking email',
    isTrackingAddress({ to: INBOX }, fakeEnv({ TRACKING_INBOX: '' })) === false);

  suite('tracking in — who may report a shipment');

  check('the address the template actually sends as may',
    senderAllowed(SENDER, trackingSenders(fakeEnv())));
  check('the old account&apos;s sender still may, until that account is retired',
    senderAllowed(OLD_SENDER, trackingSenders(fakeEnv())));
  check('an unverified sender falls back to Pirate Ship&apos;s own address, which may',
    senderAllowed(UNVERIFIED_SENDER, trackingSenders(fakeEnv())));
  check('Pirate Ship&apos;s own domain may too, for a template that uses it',
    senderAllowed('notifications@pirateship.com', trackingSenders(fakeEnv())));
  check('the Postmark envelope sender may NOT — it is not who the mail is from',
    senderAllowed(ENVELOPE, trackingSenders(fakeEnv())) === false);
  check('a lookalike domain may not',
    senderAllowed('notifications@pirateship.com.evil.net', trackingSenders(fakeEnv())) === false);
  check('nor a lookalike of the shop&apos;s own sender',
    senderAllowed('orders@rawhidecitylthr.com.evil.net', trackingSenders(fakeEnv())) === false);
  check('nor a lookalike of the current sender',
    senderAllowed('shipping@rawhidecityleather.com.evil.net', trackingSenders(fakeEnv())) === false);
  check('nor a different address on the shop&apos;s own domain',
    senderAllowed('orders@rawhidecityleather.com', trackingSenders(fakeEnv())) === false);
  check('the default covers the live sender, not everyone',
    trackingSenders({}).includes(SENDER));
  check('an explicitly blank list allows nobody',
    senderAllowed('x@pirateship.com', []) === false);

  suite('tracking in — proving it came from Pirate Ship');

  check('a message the edge vouched for passes', authStrict({
    headers: { get: () => 'mx.cloudflare.net; dmarc=pass; spf=pass; dkim=pass' },
  }) === true);
  check('SPF and DKIM together are enough without DMARC', authStrict({
    headers: { get: () => 'mx.cloudflare.net; spf=pass; dkim=pass' },
  }) === true);
  check('a failed verdict does not', authStrict({
    headers: { get: () => 'mx.cloudflare.net; dmarc=fail; spf=fail; dkim=fail' },
  }) === false);
  check('SPF alone does not — that is forgeable by anyone who can send mail',
    authStrict({ headers: { get: () => 'mx.cloudflare.net; spf=pass' } }) === false);
  check('and NO verdict fails closed, unlike the receipt path',
    authStrict({ headers: { get: () => null } }) === false);
  check('a header bag that throws fails closed too',
    authStrict({ headers: { get() { throw new Error('nope'); } } }) === false);

  suite('tracking in — finding the order');

  check('matched on the customer address',
    matchOrder(CUSTOMER, [order()]).token === 'tok-aaaaaaaa');
  check('an unknown address matches nothing',
    matchOrder('nobody@example.com', [order()]) === null);
  check('an empty address matches nothing', matchOrder('', [order()]) === null);
  check('a cancelled order is never matched',
    matchOrder(CUSTOMER, [order({ status: 'Cancelled' })]) === null);

  check('two open orders break toward the oldest', () => {
    const older = order({ token: 'tok-old', creationDate: '2026-08-01T00:00:00Z' });
    const newer = order({ token: 'tok-new', creationDate: '2026-08-10T00:00:00Z' });
    return matchOrder(CUSTOMER, [newer, older]).token === 'tok-old';
  });

  check('an open order outranks a shipped one', () => {
    const shipped = order({
      token: 'tok-shipped', status: 'Shipped', creationDate: '2026-07-01T00:00:00Z',
    });
    return matchOrder(CUSTOMER, [shipped, order({ token: 'tok-open' })]).token === 'tok-open';
  });

  check('with everything shipped a second label still lands somewhere', () => {
    const shipped = order({ token: 'tok-shipped', status: 'Shipped' });
    return matchOrder(CUSTOMER, [shipped]).token === 'tok-shipped';
  });

  suite('tracking in — the whole trip');

  const orders = [order()];
  const { fetch, puts } = fakeFetch(orders);
  const report = await withFetch(fetch, () =>
    handleTrackingEmail(fakeMessage(trackingMail()), fakeEnv(), readRaw, MAX_EMAIL_BYTES));

  check('the order ships', report.shipped === true, report.why);
  check('under the number Pirate Ship sent', report.trackingNumber === USPS);
  check('and it is written back to Snipcart', puts.length === 1);
  check('as Shipped', puts[0]?.body.status === 'Shipped');
  check('with a trackable URL',
    /usps/i.test(puts[0]?.body.trackingUrl || ''), puts[0]?.body.trackingUrl);
  check('against the right order', puts[0]?.href.includes('tok-aaaaaaaa'));

  const stranger = await ship(fakeEnv(), orders,
    fakeMessage(trackingMail({ from: 'phish@notpirateship.net' })));
  check('a stranger reporting a shipment is refused',
    stranger.shipped === false && stranger.why === 'sender not on the list', stranger.why);

  // The regression this whole check was rewritten for: the envelope sender is a
  // Postmark bounce address on every real one of these, so an allowlist reading
  // message.from would refuse every genuine tracking email.
  const realShaped = await ship(fakeEnv(), orders, fakeMessage(trackingMail()));
  check('a message whose envelope is Postmark still ships, because From: is the shop',
    realShaped.shipped === true, realShaped.why);
  check('and the sender reported is the header, not the envelope',
    realShaped.from === SENDER, realShaped.from);

  const noOrder = await ship(fakeEnv(), orders,
    fakeMessage(trackingMail({ to: 'someone-else@example.com' })));
  check('a tracking email for nobody we know is left alone',
    noOrder.shipped === false && noOrder.why === 'no open order for that address', noOrder.why);

  const noNumber = await ship(fakeEnv(), orders, fakeMessage(trackingMail({ tracking: 'soon' })));
  check('a mail with no tracking number in it ships nothing',
    noNumber.shipped === false && noNumber.why === 'no tracking number in it', noNumber.why);

  const repeat = await ship(fakeEnv(), [order({ status: 'Shipped', trackingNumber: USPS })],
    fakeMessage(trackingMail()));
  check('the second mail from the carrier does not re-ship the order',
    repeat.shipped === false && repeat.why === 'already on the order', repeat.why);

  const forged = await ship(fakeEnv(), orders, fakeMessage(trackingMail(), {
    headers: { 'authentication-results': 'mx.cloudflare.net; dmarc=fail; spf=fail; dkim=fail' },
  }));
  check('a forged From that says Pirate Ship ships nothing',
    forged.shipped === false && forged.why === 'could not prove who sent it',
    forged.why);

  const unsigned = await ship(fakeEnv(), orders, fakeMessage(trackingMail(), { headers: {} }));
  check('and neither does one with no verdict at all',
    unsigned.shipped === false && unsigned.why === 'could not prove who sent it',
    unsigned.why);

  const huge = fakeMessage(trackingMail());
  huge.rawSize = MAX_EMAIL_BYTES + 1;
  const tooBig = await ship(fakeEnv(), orders, huge);
  check('a truncated message is not guessed at',
    tooBig.shipped === false && tooBig.why === 'too big to read', tooBig.why);
}
