/**
 * Abandoned cart recovery, step 3.
 *
 * The checks that matter most are the ones about *not* sending: this is the
 * only code in the repo that mails customers unprompted, on a timer, with a
 * discount attached. A dedup bug here is not a wrong number on a page — it is
 * the same firefighter getting the same coupon every hour for a week.
 */

import { suite, check } from './harness.mjs';
import {
  makeCode, isDue, cartUrl, renderRecoveryEmail, runRecovery, recoverCart,
  SEND_AFTER_HOURS, MAX_AGE_HOURS, MAX_PER_RUN, DISCOUNT_RATE, CODE_TTL_DAYS,
} from '../recovery.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-17T12:00:00Z');

const ADDRESS = 'PO Box 1234, Lakeland, FL 33801';

function cart(overrides = {}) {
  return {
    token: 'cart-' + (overrides.token || '1'),
    email: 'firefighter@example.com',
    modificationDate: new Date(NOW - 80 * HOUR).toISOString(),
    billingAddress: { fullName: 'Dana Reyes' },
    items: [{ name: 'Fully Custom Radio Strap', quantity: 1, totalPrice: 165 }],
    summary: { total: 165 },
    ...overrides,
  };
}

/** Enough of a KV namespace for these tests: get, put with options, list. */
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
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, limit)
        .map(([name, v]) => ({ name, metadata: v.metadata }));
      return { keys };
    },
  };
}

/**
 * Stands in for both Snipcart and SendGrid. Records every call so the tests can
 * assert on what was actually sent, and can be told to fail the mail leg.
 */
function fakeFetch({ carts = [], failMail = false } = {}) {
  const calls = { discounts: [], mail: [], cartPages: 0 };

  const fetch = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : null;

    if (href.includes('/carts/abandoned')) {
      calls.cartPages++;
      return new Response(JSON.stringify({ items: carts, hasMoreResults: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (href.includes('/discounts')) {
      calls.discounts.push(body);
      return new Response(JSON.stringify({ id: 'disc-' + calls.discounts.length }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (href.includes('brevo')) {
      if (failMail) return new Response('nope', { status: 500, statusText: 'Server Error' });
      calls.mail.push(body);
      // Brevo answers 201, not 200 — a naive `status === 200` check would read
      // every successful send as a failure.
      return new Response(JSON.stringify({ messageId: '<abc@relay.brevo.com>' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error('unexpected fetch: ' + href);
  };

  return { fetch, calls };
}

function fakeEnv(overrides = {}) {
  return {
    SNIPCART_SECRET: 'test-key-never-used',
    BREVO_KEY: 'test-key-never-used',
    RECOVERY_FROM: 'orders@rawhidecityleather.com',
    RECOVERY_POSTAL_ADDRESS: ADDRESS,
    RECOVERY: fakeKV(),
    ...overrides,
  };
}

/** Swaps global fetch for the duration of one call. */
async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

export default async function run() {
  suite('recovery — who gets one');

  check(`a cart past ${SEND_AFTER_HOURS}h is due`, isDue(cart(), NOW) === true);
  check('a cart an hour short of the line is not',
    isDue(cart({ modificationDate: new Date(NOW - (SEND_AFTER_HOURS - 1) * HOUR).toISOString() }), NOW) === false);
  check('a fresh cart is not', isDue(cart({ modificationDate: new Date(NOW - HOUR).toISOString() }), NOW) === false);
  check(`a cart older than ${MAX_AGE_HOURS / 24} days is left alone`,
    isDue(cart({ modificationDate: new Date(NOW - (MAX_AGE_HOURS + 1) * HOUR).toISOString() }), NOW) === false);
  check('our own test carts never get mail',
    isDue(cart({ email: 'test@example.com' }), NOW) === false);
  check('test carts are matched case-insensitively',
    isDue(cart({ email: 'TEST@Example.com' }), NOW) === false);
  // This one is real: the shop inbox shows up in the live abandoned-cart list
  // from checkout testing, and would otherwise be mailed its own coupon.
  check('the shop\'s own inbox never gets mailed a coupon',
    isDue(cart({ email: 'rawhidecityleather@gmail.com' }), NOW) === false);
  check('and the dashboard shows it uppercased, so case must not matter',
    isDue(cart({ email: 'RAWHIDECITYLEATHER@GMAIL.COM' }), NOW) === false);
  check('a cart with no email is skipped', isDue(cart({ email: '' }), NOW) === false);
  check('a junk email is skipped', isDue(cart({ email: 'not-an-address' }), NOW) === false);
  check('an empty cart is skipped', isDue(cart({ items: [] }), NOW) === false);
  check('a cart with no date is skipped',
    isDue(cart({ modificationDate: '', creationDate: '' }), NOW) === false);

  suite('recovery — the code');

  const code = makeCode();
  check('is prefixed and long enough to not be guessed', /^RCL[A-Z2-9]{8}$/.test(code), code);
  check('avoids characters that get misread off a screen',
    !/[01IOS5]/.test(code.slice(3)), code);

  const codes = new Set(Array.from({ length: 500 }, () => makeCode()));
  check('500 codes are all distinct', codes.size === 500, `got ${codes.size}`);

  suite('recovery — the email');

  const expiresAt = new Date(NOW + CODE_TTL_DAYS * 24 * HOUR).toISOString();
  const mail = renderRecoveryEmail(cart(), 'RCLABCD234', expiresAt, ADDRESS);

  check('subject carries the rate and the real deadline',
    mail.subject.includes(`${DISCOUNT_RATE}% off`) && mail.subject.includes('August 24'), mail.subject);
  check('greets by first name only', mail.text.startsWith('Hey Dana,'));
  check('html carries the code', mail.html.includes('RCLABCD234'));
  check('text carries the code', mail.text.includes('RCLABCD234'));
  check('both halves are present', mail.html.length > 0 && mail.text.length > 0);
  check('the cart link restores the cart',
    mail.html.includes('snipcart_token=cart-1') && mail.html.includes('#!/cart'));
  check('the cart contents are listed', mail.html.includes('Fully Custom Radio Strap'));
  check('prices are formatted', mail.html.includes('$165.00'));
  check('says the code is single-use', mail.text.includes('works once'));
  check('carries the postal address, as commercial mail must',
    mail.html.includes(ADDRESS) && mail.text.includes(ADDRESS));
  check('carries an unsubscribe route',
    mail.html.toLowerCase().includes('unsubscribe') && mail.text.toLowerCase().includes('unsubscribe'));

  const nasty = renderRecoveryEmail(
    cart({ items: [{ name: '<script>alert(1)</script>', quantity: 1, totalPrice: 10 }] }),
    'RCLABCD234', expiresAt, ADDRESS);
  check('a product name cannot inject markup',
    !nasty.html.includes('<script>') && nasty.html.includes('&lt;script&gt;'));

  const noName = renderRecoveryEmail(cart({ billingAddress: null }), 'RCLABCD234', expiresAt, ADDRESS);
  check('a missing name degrades to a plain greeting', noName.text.startsWith('Hey,'));

  check('cart url is built from the token',
    cartUrl(cart()) === 'https://rawhidecityleather.com?snipcart_token=cart-1#!/cart');

  suite('recovery — a run end to end');

  {
    const env = fakeEnv();
    const { fetch, calls } = fakeFetch({ carts: [cart()] });
    const report = await withFetch(fetch, () => runRecovery(env, NOW));

    check('one cart, one email', calls.mail.length === 1, `sent ${calls.mail.length}`);
    check('one cart, one discount', calls.discounts.length === 1);
    check('the discount is a single-use 15% code',
      calls.discounts[0].rate === DISCOUNT_RATE &&
      calls.discounts[0].maxNumberOfUsages === 1 &&
      calls.discounts[0].trigger === 'Code');
    check('the discount cannot stack on a sitewide sale',
      calls.discounts[0].combinable === false);
    check(`the code expires ${CODE_TTL_DAYS} days out, per customer`,
      calls.discounts[0].expires === expiresAt, calls.discounts[0].expires);
    check('the emailed code is the one that was created',
      JSON.stringify(calls.mail[0]).includes(calls.discounts[0].code));
    check('report counts the send', report.counts.sent === 1, JSON.stringify(report.counts));

    // The whole point of the KV record.
    const second = await withFetch(fetch, () => runRecovery(env, NOW + HOUR));
    check('an hour later the same cart is NOT mailed again',
      calls.mail.length === 1, `sent ${calls.mail.length}`);
    check('and no second discount is minted', calls.discounts.length === 1);
    check('the run reports it as already handled',
      second.counts['already-sent'] === 1, JSON.stringify(second.counts));
  }

  suite('recovery — when things go wrong');

  {
    const env = fakeEnv();
    const { fetch, calls } = fakeFetch({ carts: [cart()], failMail: true });
    const report = await withFetch(fetch, () => runRecovery(env, NOW));

    check('a failed send is reported, not thrown',
      report.counts['send-failed'] === 1, JSON.stringify(report.counts));

    // Retrying must reuse the code, or every failure leaves a live orphan
    // discount behind and the customer eventually gets a different code.
    const retry = fakeFetch({ carts: [cart()] });
    await withFetch(retry.fetch, () => runRecovery(env, NOW + HOUR));
    check('the retry does not mint a second discount',
      retry.calls.discounts.length === 0, `minted ${retry.calls.discounts.length}`);
    check('the retry reuses the original code',
      JSON.stringify(retry.calls.mail[0]).includes(calls.discounts[0].code));
  }

  {
    const env = fakeEnv({ BREVO_KEY: '' });
    const { fetch, calls } = fakeFetch({ carts: [cart()] });
    const report = await withFetch(fetch, () => runRecovery(env, NOW));

    check('an unconfigured mailer sends nothing', calls.mail.length === 0);
    check('and mints no discounts it could never deliver',
      calls.discounts.length === 0);
    check('the run says why it did nothing',
      report.skipped === 'mailer-not-configured', JSON.stringify(report));
  }

  {
    const env = fakeEnv({ RECOVERY_POSTAL_ADDRESS: '' });
    const { fetch, calls } = fakeFetch({ carts: [cart()] });
    await withFetch(fetch, () => runRecovery(env, NOW));
    check('no postal address means no send — CAN-SPAM, not a nicety',
      calls.mail.length === 0 && calls.discounts.length === 0);
  }

  suite('recovery — blast radius');

  {
    const many = Array.from({ length: MAX_PER_RUN + 15 }, (_, i) => cart({ token: String(i) }));
    const env = fakeEnv();
    const { fetch, calls } = fakeFetch({ carts: many });
    const report = await withFetch(fetch, () => runRecovery(env, NOW));

    check(`a backlog is capped at ${MAX_PER_RUN} per run`,
      calls.mail.length === MAX_PER_RUN, `sent ${calls.mail.length}`);
    check('the rest are left for the next hour', report.due === MAX_PER_RUN);
  }

  {
    // Ancient carts are the real first-deploy hazard: without the ceiling, the
    // first cron run would mail everyone who ever abandoned anything.
    const old = Array.from({ length: 30 }, (_, i) =>
      cart({ token: 'old' + i, modificationDate: new Date(NOW - 60 * 24 * HOUR).toISOString() }));
    const env = fakeEnv();
    const { fetch, calls } = fakeFetch({ carts: old });
    await withFetch(fetch, () => runRecovery(env, NOW));
    check('a pile of months-old carts gets nothing', calls.mail.length === 0);
  }

  suite('recovery — one cart by hand');

  {
    const env = fakeEnv();
    const { fetch, calls } = fakeFetch({ carts: [] });
    const result = await withFetch(fetch, () => recoverCart(env, cart(), NOW));
    check('a single cart can be driven without the cron', result.status === 'sent');
    check('and it sends exactly one email', calls.mail.length === 1);
  }
}
