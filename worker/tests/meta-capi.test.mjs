/**
 * The server-side Purchase sent to Meta from the order webhook.
 *
 * What matters: buyer details only ever leave hashed, the event id matches the
 * one the browser pixel sends (or Meta counts the sale twice), and nothing is
 * sent when it shouldn't be — no token, a test-mode order, or an order with no
 * browser details to match on. And a Meta failure never throws into the
 * webhook, which would make Snipcart retry the whole order.
 */

import { suite, check } from './harness.mjs';
import { createHash } from 'node:crypto';
import { buildPurchaseEvent, sendPurchase, purchaseEventId, normalize, PIXEL_ID } from '../meta-capi.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

function order(extra = {}) {
  return {
    token: 'tok-test',
    invoiceNumber: 'SNIP-1042',
    email: '  Jane.Doe@Example.com ',
    currency: 'usd',
    grandTotal: 175,
    completionDate: '2026-09-21T14:00:00Z',
    billingAddress: {
      fullName: 'Jane Q. Doe', city: 'Lake Wales', province: 'FL',
      postalCode: '33853-1234', country: 'US', phone: '(863) 555-0100',
    },
    items: [{ id: 'fully-custom-radio-strap', quantity: 1 }, { id: 'leather-butter', quantity: 2 }],
    metadata: { ua: 'Mozilla/5.0 test', fbp: 'fb.1.1700000000.123', fbc: 'fb.1.1700000000.abc', url: 'https://rawhidecityleather.com/product-fully-custom-radio-strap' },
    ...extra,
  };
}

export default async function run() {
  suite('meta capi — the event');

  const now = Date.parse('2026-09-21T15:00:00Z');
  const { event } = await buildPurchaseEvent(order(), now);
  const u = event.user_data;

  check('event id is the invoice number, same as the pixel', event.event_id === 'SNIP-1042');
  check('falls back to the token when there is no invoice number',
    purchaseEventId({ token: 'tok-x' }) === 'tok-x');
  check('email is trimmed, lowercased, then hashed', u.em[0] === sha('jane.doe@example.com'));
  check('first and last name come off the full name', u.fn[0] === sha('jane') && u.ln[0] === sha('doe'));
  check('city loses its space', u.ct[0] === sha('lakewales'));
  check('state is two letters', u.st[0] === sha('fl'));
  check('US zip is cut to five digits', u.zp[0] === sha('33853'));
  check('country is two lowercase letters', u.country[0] === sha('us'));
  check('a 10-digit phone gets the US country code', u.ph[0] === sha('18635550100'));
  check('nothing personal leaves in the clear', () => {
    const text = JSON.stringify(event);
    return !/jane|doe|lake|33853|555/i.test(text);
  });
  check('pixel cookies and user agent pass through as-is',
    u.fbp === 'fb.1.1700000000.123' && u.fbc === 'fb.1.1700000000.abc' && u.client_user_agent === 'Mozilla/5.0 test');
  check('value, currency and items', event.custom_data.value === 175
    && event.custom_data.currency === 'USD'
    && event.custom_data.num_items === 3
    && event.custom_data.content_ids.join() === 'fully-custom-radio-strap,leather-butter');
  check('event time is when the order was placed',
    event.event_time === Math.floor(Date.parse('2026-09-21T14:00:00Z') / 1000));
  const future = (await buildPurchaseEvent(order({ completionDate: '2030-01-01T00:00:00Z' }), now)).event;
  check('a clock-skewed order is pulled back to now', future.event_time === Math.floor(now / 1000));

  const noAddr = (await buildPurchaseEvent(order({ billingAddress: undefined, shippingAddress: undefined }), now)).event;
  check('no address just means fewer fields, not a crash', noAddr.user_data.em && !noAddr.user_data.ct);
  const oneName = (await buildPurchaseEvent(order({ billingAddress: { fullName: 'Cher' } }), now)).event;
  check('a single name is a first name only', oneName.user_data.fn && !oneName.user_data.ln);

  check('non-US zip keeps its letters', normalize.zip('K1A 0B1', 'ca') === 'k1a0b1');
  check('a spelled-out state is dropped, not sent wrong', normalize.state('Florida') === '');

  suite('meta capi — when not to send');

  const noUa = await buildPurchaseEvent(order({ metadata: {} }), now);
  check('no browser details (a quote paid off its link) is skipped', !!noUa.skip);
  const noId = await buildPurchaseEvent(order({ invoiceNumber: '', token: '' }), now);
  check('no id to dedupe on is skipped', !!noId.skip);

  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('{"events_received":1}', { status: 200 });
    };

    const off = await sendPurchase({}, order(), { mode: 'Live' });
    check('no token configured sends nothing', off.sent === false && calls.length === 0);

    const test = await sendPurchase({ META_CAPI_TOKEN: 't' }, order(), { mode: 'Test' });
    check('a Snipcart test-mode order sends nothing', test.sent === false && calls.length === 0);

    const ok = await sendPurchase({ META_CAPI_TOKEN: 'secret token' }, order(), { mode: 'Live' });
    check('a live order is sent', ok.sent === true && calls.length === 1);
    check('to the shop pixel', calls[0].url.includes('/' + PIXEL_ID + '/events'));
    check('token is URL-encoded', calls[0].url.includes('access_token=secret%20token'));
    check('no test code unless one is set', !('test_event_code' in calls[0].body));

    await sendPurchase({ META_CAPI_TOKEN: 't', META_TEST_EVENT_CODE: 'TEST123' }, order(), { mode: 'Live' });
    check('test code rides along when set', calls[1].body.test_event_code === 'TEST123');

    globalThis.fetch = async () => new Response('{"error":{}}', { status: 400 });
    const bad = await sendPurchase({ META_CAPI_TOKEN: 't' }, order(), { mode: 'Live' });
    check('a Meta error is reported, not thrown', bad.sent === false && /400/.test(bad.reason));

    globalThis.fetch = async () => { throw new Error('network down'); };
    const down = await sendPurchase({ META_CAPI_TOKEN: 't' }, order(), { mode: 'Live' });
    check('a network failure is reported, not thrown', down.sent === false);
  } finally {
    globalThis.fetch = realFetch;
  }
}
