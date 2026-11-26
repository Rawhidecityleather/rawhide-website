/**
 * "Your gear is in your hands" — the thank-you for an order handed over in
 * person. What matters: it never pretends there is a package to track, it goes
 * to the email on the order and nowhere else, and the test send stays home.
 */

import { suite, check } from './harness.mjs';
import {
  deliveredHtml, deliveredText, sendDeliveredEmail, sendTestDeliveredEmail, DELIVERED_SUBJECT,
} from '../delivered-mail.js';
import { REVIEW_URL } from '../shipped-mail.js';

/** 2026-08-19 16:00 UTC — noon in Lakeland, so the date is unambiguous. */
const NOW = Date.parse('2026-08-19T16:00:00Z');

const order = (over = {}) => ({
  token: 'tok-aaaaaaaa',
  invoiceNumber: 'RCL-1042',
  email: 'jane@example.com',
  shippingAddress: { fullName: 'Jane Doe' },
  ...over,
});

const env = () => ({
  BREVO_KEY: 'test-key-never-used',
  RECOVERY_FROM: 'orders@rawhidecityleather.com',
  RECOVERY_POSTAL_ADDRESS: 'PO Box 1, Lakeland FL',
});

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
  suite('delivered mail — what it says');

  const html = deliveredHtml(order(), NOW);
  const text = deliveredText(order(), NOW);
  check('greets the customer by first name', html.includes('Hey Jane,') && text.startsWith('Hey Jane,'));
  check('says it was handed over, with the date', html.includes('Handed over August 19, 2026'), text);
  check('names the order', html.includes('RCL-1042') && text.includes('RCL-1042'));
  check('has no tracking anywhere', !/track/i.test(html) && !/track/i.test(text));
  check('asks for a review', html.includes(REVIEW_URL) && text.includes(REVIEW_URL));
  check('no order number, no empty box label',
    !deliveredHtml(order({ invoiceNumber: '' }), NOW).includes('>Order<'));
  check('a name with markup in it is escaped',
    !deliveredHtml(order({ shippingAddress: { fullName: '<b>Jo' } }), NOW).includes('<b>Jo'));

  suite('delivered mail — sending');

  const t = fakeFetch();
  await withFetch(t.fetch, () => sendDeliveredEmail(env(), order(), NOW));
  check('goes to the email on the order', t.sent[0]?.body.to[0].email === 'jane@example.com');
  check('with the thank-you subject', t.sent[0]?.body.subject === DELIVERED_SUBJECT);

  let threw = '';
  await withFetch(fakeFetch().fetch, () => sendDeliveredEmail(env(), order({ email: '' }), NOW))
    .catch((e) => { threw = e.message; });
  check('an order with no email is refused, not sent blank', /no email/.test(threw), threw);

  threw = '';
  await sendDeliveredEmail({}, order(), NOW).catch((e) => { threw = e.message; });
  check('no mail settings says so plainly', /not configured/.test(threw), threw);

  threw = '';
  await withFetch(fakeFetch({ fail: true }).fetch, () => sendDeliveredEmail(env(), order(), NOW))
    .catch((e) => { threw = e.message; });
  check('a bounce comes back as an error the dashboard can show', /400|nope/.test(threw), threw);

  suite('delivered mail — the test send');

  const s = fakeFetch();
  const result = await withFetch(s.fetch, () => sendTestDeliveredEmail(env(), NOW));
  check('it goes to the shop, never a customer',
    s.sent[0]?.body.to[0].email === 'rawhidecityleather@gmail.com', result.to);
  check('and says it is a test in the subject', /^\[test\]/.test(s.sent[0]?.body.subject || ''));
  check('but still renders the full email',
    (s.sent[0]?.body.htmlContent || '').includes('Your gear is in your hands'));
}
