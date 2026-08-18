/**
 * Contact-form inquiries.
 *
 * These are the highest-value leads the site takes — custom builds, crew
 * orders, memorials — and the customer gets one shot at sending one. So the
 * checks lean on the failure paths: what happens when a field is missing, when
 * the mailer is unconfigured, and when someone posts something hostile.
 */

import { suite, check } from './harness.mjs';
import {
  handleInquiry, parseInquiry, renderInquiryEmail, looksLikeEmail,
  safeHeaderValue, clean,
} from '../inquiry.js';

const ADDRESS = 'PO Box 1234, Lakeland, FL 33801';

function fakeEnv(overrides = {}) {
  return {
    BREVO_KEY: 'test-key-never-used',
    RECOVERY_FROM: 'orders@rawhidecityleather.com',
    RECOVERY_POSTAL_ADDRESS: ADDRESS,
    ...overrides,
  };
}

function body(fields) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) p.set(k, v);
  return p.toString();
}

const GOOD = {
  'fields[inquiry_type]': 'Custom build',
  'fields[first_name]': 'Dana Reyes',
  email_address: 'dana@example.com',
  'fields[department]': 'Station 12',
  'fields[needed_by]': 'Retirement, Oct 3',
  'fields[details]': 'Fully custom strap, 62-68 inch, black, red stitch.',
};

function req(fields, method = 'POST') {
  return new Request('https://rawhidecityleather.com/api/inquiry', {
    method,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? body(fields) : undefined,
  });
}

/** Captures what would have gone to Brevo. */
function fakeFetch({ fail = false } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (fail) return new Response('nope', { status: 500, statusText: 'Server Error' });
    return new Response(JSON.stringify({ messageId: '<x@relay.brevo.com>' }), { status: 201 });
  };
  return { fetch, calls };
}

async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

export default async function run() {
  suite('inquiry — validation');

  check('a complete inquiry is accepted',
    parseInquiry(new URLSearchParams(body(GOOD))).errors.length === 0);
  check('a missing name is caught',
    parseInquiry(new URLSearchParams(body({ ...GOOD, 'fields[first_name]': '' }))).errors.includes('name'));
  check('a missing email is caught',
    parseInquiry(new URLSearchParams(body({ ...GOOD, email_address: '' }))).errors.includes('email'));
  check('a junk email is caught',
    parseInquiry(new URLSearchParams(body({ ...GOOD, email_address: 'not-an-address' }))).errors.includes('email'));
  check('missing details are caught',
    parseInquiry(new URLSearchParams(body({ ...GOOD, 'fields[details]': '   ' }))).errors.includes('details'));
  check('optional fields stay optional',
    parseInquiry(new URLSearchParams(body({ ...GOOD, 'fields[department]': '', 'fields[needed_by]': '' }))).errors.length === 0);

  check('a plus-addressed email is allowed', looksLikeEmail('dana+straps@example.com'));
  check('a long TLD is allowed', looksLikeEmail('rob@rawhidecityleather.company'));
  check('an address with no dot is refused', looksLikeEmail('dana@localhost') === false);

  // An unrecognised type means the markup drifted or someone posted by hand.
  // Keep the inquiry, drop the claim — never lose the lead over a dropdown.
  const odd = parseInquiry(new URLSearchParams(body({ ...GOOD, 'fields[inquiry_type]': 'Free money' })));
  check('an unrecognised inquiry type is normalised, not rejected',
    odd.errors.length === 0 && odd.inquiry.type === 'Something else', odd.inquiry.type);

  check('an over-long field is truncated rather than refused',
    clean('x'.repeat(99999)).length === 4000);

  suite('inquiry — the email');

  const { inquiry } = parseInquiry(new URLSearchParams(body(GOOD)));
  const mail = renderInquiryEmail(inquiry);

  check('subject names the type and the person',
    mail.subject.includes('Custom build') && mail.subject.includes('Dana Reyes'), mail.subject);
  check('the details survive into the text part', mail.text.includes('62-68 inch'));
  check('the details survive into the html part', mail.html.includes('62-68 inch'));
  check('optional fields appear when given', mail.text.includes('Station 12'));

  const bare = renderInquiryEmail(parseInquiry(
    new URLSearchParams(body({ ...GOOD, 'fields[department]': '', 'fields[needed_by]': '' }))).inquiry);
  check('empty optional fields are not printed as blank rows',
    !bare.text.includes('Department or station:'));

  const nasty = renderInquiryEmail(parseInquiry(new URLSearchParams(body({
    ...GOOD, 'fields[details]': '<script>alert(1)</script>',
  }))).inquiry);
  check('customer text cannot inject markup into the email',
    !nasty.html.includes('<script>') && nasty.html.includes('&lt;script&gt;'));

  check('a newline cannot be smuggled into a header',
    safeHeaderValue('a@b.com\r\nBcc: evil@example.com').indexOf('\n') === -1);

  suite('inquiry — the endpoint');

  {
    const { fetch, calls } = fakeFetch();
    const res = await withFetch(fetch, () => handleInquiry(req(GOOD), fakeEnv()));
    check('a good inquiry returns 200', res.status === 200, String(res.status));
    check('and exactly one email is sent', calls.length === 1);
    check('it goes to the shop inbox',
      calls[0].to[0].email === 'rawhidecityleather@gmail.com');
    check('reply-to is the CUSTOMER, so hitting reply answers them',
      calls[0].replyTo.email === 'dana@example.com', JSON.stringify(calls[0].replyTo));
    check('no List-Unsubscribe on a transactional notice',
      !calls[0].headers || !calls[0].headers['List-Unsubscribe']);
  }

  {
    const { fetch, calls } = fakeFetch();
    const res = await withFetch(fetch, () => handleInquiry(req({ ...GOOD, 'fields[first_name]': '' }), fakeEnv()));
    check('an incomplete inquiry returns 400', res.status === 400);
    check('and sends nothing', calls.length === 0);
  }

  {
    // The honeypot is invisible to people. Anything in it is a bot — answer 200
    // so it has nothing to tune against, but send no mail.
    const { fetch, calls } = fakeFetch();
    const res = await withFetch(fetch, () => handleInquiry(req({ ...GOOD, company: 'Acme' }), fakeEnv()));
    check('a filled honeypot looks like success to the bot', res.status === 200);
    check('but sends nothing', calls.length === 0);
  }

  {
    const { fetch, calls } = fakeFetch();
    const res = await withFetch(fetch, () => handleInquiry(req(GOOD), fakeEnv({ BREVO_KEY: '' })));
    check('an unconfigured mailer returns 503, not a crash', res.status === 503);
    check('and sends nothing', calls.length === 0);
    const parsed = await res.json();
    check('and tells the page to fall back to mailto',
      parsed.fallback === 'mailto', JSON.stringify(parsed));
  }

  {
    const res = await handleInquiry(req(GOOD, 'GET'), fakeEnv());
    check('GET is refused', res.status === 405);
  }

  {
    const huge = new Request('https://rawhidecityleather.com/api/inquiry', {
      method: 'POST', body: 'x'.repeat(40000),
    });
    const { fetch, calls } = fakeFetch();
    const res = await withFetch(fetch, () => handleInquiry(huge, fakeEnv()));
    check('an oversized body is refused before anything is parsed', res.status === 413);
    check('and sends nothing', calls.length === 0);
  }
}
