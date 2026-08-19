/**
 * "Your gear is on the way", sent by us.
 *
 * This one only exists for the package that went out without a Pirate Ship
 * label, so the checks that matter most are about when it stays quiet: no tick,
 * no email. A second copy landing on a customer who already got Pirate Ship's
 * is the exact failure this feature could introduce.
 *
 * After that, the things that must survive a bad day — the order still ships
 * when the mail bounces, and the shop is told which half happened.
 */

import { suite, check } from './harness.mjs';
import {
  firstName, shipDate, shippedHtml, shippedText, sendShippedEmail,
  sendTestShippedEmail, SHIPPED_SUBJECT,
} from '../shipped-mail.js';

const USPS = '9400111899223197428490';
/** 2026-08-19 16:00 UTC — noon in Lakeland, so the date is unambiguous. */
const NOW = Date.parse('2026-08-19T16:00:00Z');

function order(over = {}) {
  return {
    token: 'tok-aaaaaaaa',
    invoiceNumber: 'RCL-1042',
    email: 'jane@example.com',
    shippingAddress: { fullName: 'Jane Doe', city: 'Lakeland', province: 'FL' },
    ...over,
  };
}

function fakeEnv(over = {}) {
  return {
    BREVO_KEY: 'test-key-never-used',
    RECOVERY_FROM: 'orders@rawhidecityleather.com',
    RECOVERY_POSTAL_ADDRESS: 'PO Box 1, Lakeland FL',
    ...over,
  };
}

function fakeFetch({ fail = false } = {}) {
  const sent = [];
  const fetch = async (url, init = {}) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return fail
      ? new Response('{"message":"nope"}', { status: 400, statusText: 'Bad Request' })
      : new Response('{"messageId":"<abc@brevo>"}', { status: 201 });
  };
  return { fetch, sent };
}

async function withFetch(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}

export default async function run() {
  suite('shipped mail — the greeting');

  check('a first name is used on its own', firstName(order()) === 'Jane');
  check('a shouted label name is calmed down',
    firstName(order({ shippingAddress: { fullName: 'JANE DOE' } })) === 'Jane');
  check('a one-word name still works',
    firstName(order({ shippingAddress: { fullName: 'Cher' } })) === 'Cher');
  check('no name yields nothing rather than "Hey ,"',
    firstName(order({ shippingAddress: {} })) === '');
  check('and the greeting closes cleanly without one', () => {
    const html = shippedHtml(order({ shippingAddress: {} }), USPS, NOW);
    return html.includes('>Hey,</p>') && !html.includes('Hey ,');
  });

  suite('shipped mail — what the customer sees');

  const html = shippedHtml(order(), USPS, NOW);
  check('the tracking number is in it', html.includes(USPS));
  check('the track link points at our own page',
    html.includes('rawhidecityleather.com/track?num=' + USPS), 'track link');
  check("the ship date is the shop's day, not UTC's",
    html.includes('August 19, 2026'), shipDate(NOW));
  check('the tagline is there', html.includes('We do not cut corners'));
  check('it carries no unsubscribe link — this is not marketing',
    !/unsubscribe/i.test(html));

  const text = shippedText(order(), USPS, NOW);
  check('the plain-text copy carries the number too', text.includes(USPS));
  check('and a greeting', text.startsWith('Hey Jane,'));

  check('a name with HTML in it cannot break out', () => {
    const nasty = shippedHtml(
      order({ shippingAddress: { fullName: '<script>alert(1)</script> Doe' } }), USPS, NOW);
    return !nasty.includes('<script>');
  });

  suite('shipped mail — sending');

  const { fetch, sent } = fakeFetch();
  const result = await withFetch(fetch, () => sendShippedEmail(fakeEnv(), order(), USPS, NOW));
  check('it goes to Brevo', sent[0]?.url.includes('brevo.com'), sent[0]?.url);
  check('addressed to the customer', sent[0]?.body.to[0].email === 'jane@example.com');
  check('from the storefront domain, which is the one Brevo authenticates',
    sent[0]?.body.sender.email === 'orders@rawhidecityleather.com');
  check('with the same subject Pirate Ship uses',
    sent[0]?.body.subject === SHIPPED_SUBJECT, sent[0]?.body.subject);
  check('and no List-Unsubscribe header, because it is transactional',
    !sent[0]?.body.headers, JSON.stringify(sent[0]?.body.headers));
  check('the message id comes back', Boolean(result.messageId));

  // Awaited out here: the harness calls a thunk and compares to true, so an
  // async one hands it a Promise and the check fails whatever the code does.
  let noAddress = '';
  try {
    await withFetch(fakeFetch().fetch,
      () => sendShippedEmail(fakeEnv(), order({ email: '' }), USPS, NOW));
  } catch (err) { noAddress = err.message; }
  check('an order with no email address is refused, not silently skipped',
    /no email address/i.test(noAddress), noAddress);

  let unconfigured = '';
  try {
    await withFetch(fakeFetch().fetch,
      () => sendShippedEmail(fakeEnv({ BREVO_KEY: '' }), order(), USPS, NOW));
  } catch (err) { unconfigured = err.message; }
  check('with no mail credentials it says so instead of pretending',
    /not configured/i.test(unconfigured), unconfigured);

  let bounced = '';
  try {
    await withFetch(fakeFetch({ fail: true }).fetch,
      () => sendShippedEmail(fakeEnv(), order(), USPS, NOW));
  } catch (err) { bounced = err.message; }
  check("a provider error is surfaced, carrying Brevo's own words",
    /400/.test(bounced) && /nope/.test(bounced), bounced);

  suite('shipped mail — the test send');

  const t = fakeFetch();
  const testResult = await withFetch(t.fetch, () => sendTestShippedEmail(fakeEnv(), NOW));
  check('it goes to the shop, never a customer',
    t.sent[0]?.body.to[0].email === 'rawhidecityleather@gmail.com', testResult.to);
  check('and says it is a test in the subject',
    /^\[test\]/.test(t.sent[0]?.body.subject || ''), t.sent[0]?.body.subject);
  check('the sample carries no real order email',
    !JSON.stringify(t.sent[0]?.body).includes('jane@example.com'));
  check('but still renders a full email to look at',
    (t.sent[0]?.body.htmlContent || '').includes('Your gear is on the way'));
}
