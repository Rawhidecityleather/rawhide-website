/**
 * The cart recovery card: what it counts, what it refuses to claim when a
 * source is unreadable, and the whole thing rendered through the real Worker
 * against a stubbed Snipcart.
 */

import { suite, check } from './harness.mjs';
import worker from '../index.js';
import {
  recoveryStats, summarise, stateOf, productTally, cartValue, cartAgeHours,
  renderRecoveryCard, handleRecoverySend,
} from '../recovery-card.js';

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-09-14T12:00:00Z');

/** Snipcart hands the abandoned list an epoch in SECONDS. */
const secondsAgo = (hours) => Math.floor((NOW - hours * HOUR) / 1000);

const cart = (over = {}) => ({
  token: 'tok-' + Math.random().toString(16).slice(2, 8),
  email: 'someone@example.com',
  modificationDate: secondsAgo(48),
  items: [{ name: 'Fully Custom Adjustable Radio Strap', quantity: 1, totalPrice: 165 }],
  ...over,
});

function fakeKV(records = []) {
  const store = new Map();
  for (const r of records) {
    store.set('recovery:' + r.token, { value: JSON.stringify(r), metadata: r });
  }
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key).value : null; },
    async put(key, value, options = {}) { store.set(key, { value, metadata: options.metadata || null }); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return {
        keys: [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .slice(0, limit)
          .map(([name, v]) => ({ name, metadata: v.metadata })),
      };
    },
  };
}

function fakeFetch({ carts = [], discounts = [], failCarts = false, failDiscounts = false, failMail = false } = {}) {
  const sentMail = [];
  const fn = async function (url, init) {
    const href = String(url);
    arguments[1] = init;
    if (href.includes('/carts/abandoned')) {
      if (failCarts) return new Response('nope', { status: 500, statusText: 'Server Error' });
      return new Response(JSON.stringify({ items: carts, hasMoreResults: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('/discounts')) {
      if (failDiscounts) return new Response('nope', { status: 500, statusText: 'Server Error' });
      return new Response(JSON.stringify({ items: discounts, hasMoreResults: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('brevo')) {
      if (failMail) return new Response('nope', { status: 500, statusText: 'Server Error' });
      sentMail.push(JSON.parse(String(arguments[1]?.body || '{}')));
      return new Response(JSON.stringify({ messageId: '<x@relay>' }), {
        status: 201, headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('/orders')) {
      return new Response(JSON.stringify({ items: [], totalItems: 0 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected fetch: ' + href);
  };
  fn.sentMail = sentMail;
  return fn;
}

async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const env = (over = {}) => ({
  SNIPCART_SECRET: 'test-key-never-used',
  BREVO_KEY: 'test-key-never-used',
  RECOVERY_FROM: 'orders@rawhidecityleather.com',
  RECOVERY_POSTAL_ADDRESS: '1 Somewhere, Lakeland, FL',
  RECOVERY: fakeKV(),
  ...over,
});

export default async function run() {
  suite('recovery card — reading a cart');

  check('a cart is worth the sum of its lines',
    cartValue({ items: [{ totalPrice: 165 }, { totalPrice: 8 }] }) === 173);
  check('a cart with no items is worth nothing', cartValue({}) === 0);

  check('an epoch in seconds reads as an age in hours',
    cartAgeHours({ modificationDate: secondsAgo(48) }, NOW) === 48);
  check('an ISO string works too',
    cartAgeHours({ modificationDate: new Date(NOW - 5 * HOUR).toISOString() }, NOW) === 5);
  check('a cart with no date at all is not guessed at',
    cartAgeHours({}, NOW) === null);
  // Reading the seconds as milliseconds is what put every cart in 1970 and cost
  // three live runs. A week-old cart must not come back as minutes old.
  check('a week-old cart does not read as minutes old',
    cartAgeHours({ modificationDate: secondsAgo(168) }, NOW) === 168);

  suite('recovery card — what is in the carts');

  const tally = productTally([
    cart(), cart(),
    cart({ items: [{ name: 'Leather Butter', totalPrice: 8 }] }),
    cart({ items: [
      { name: 'Fully Custom Adjustable Radio Strap', totalPrice: 165 },
      { name: 'Leather Butter', totalPrice: 8 },
    ] }),
  ]);
  check('the commonest product is first',
    tally[0].name === 'Fully Custom Adjustable Radio Strap' && tally[0].count === 3);
  check('and a cart holding two things counts for both',
    tally.find((t) => t.name === 'Leather Butter').count === 2);
  check('two of one thing in one cart is still one cart', productTally([
    cart({ items: [{ name: 'Helmet Band', totalPrice: 50 }, { name: 'Helmet Band', totalPrice: 50 }] }),
  ])[0].count === 1);
  check('no carts, no tally', productTally([]).length === 0);

  suite('recovery card — the numbers');

  {
    const stats = {
      ready: true, storeRate: 0, paused: false,
      sent: [
        { token: 'a', code: 'RCLAAA', sentAt: '2026-09-10T00:00:00Z' },
        { token: 'b', code: 'RCLBBB', sentAt: '2026-09-09T00:00:00Z' },
      ],
      usage: new Map([['RCLAAA', 1], ['RCLBBB', 0]]),
      carts: [cart({ token: 'a' }), cart({ token: 'c', modificationDate: secondsAgo(3) })],
      now: NOW,
    };
    const sums = summarise(stats);

    check('sent counts the coupon log', sums.sent === 2);
    check('used counts only the codes Snipcart says were redeemed', sums.used === 1);
    check('waiting counts the carts inside the window', sums.waiting === 2);
    check('and adds up what is sitting in them', sums.waitingValue === 330);
    check('a cart that already had a coupon is marked as such',
      sums.rows.find((r) => r.token === 'a').mailed === true);
    check('and one that has not is counted as still to go',
      sums.notYetMailed === 1 && sums.rows.find((r) => r.token === 'c').mailed === false);
    check('the oldest cart leads the table', sums.rows[0].token === 'a');
    check('and the age spread is the oldest one', sums.oldestHours === 48);
  }

  {
    // A cart past the seven-day ceiling is out of the window and out of the count.
    const stats = {
      ready: true, storeRate: 0, paused: false, sent: [], usage: new Map(),
      carts: [cart({ modificationDate: secondsAgo(24 * 8) })],
      now: NOW,
    };
    check('a cart older than the window is not counted as waiting',
      summarise(stats).waiting === 0);
  }

  {
    // A code matched case-insensitively: Snipcart's dashboard uppercases, and
    // the KV metadata carries whatever was minted.
    const stats = {
      ready: true, storeRate: 0, paused: false,
      sent: [{ token: 'a', code: 'rclaaa', sentAt: '' }],
      usage: new Map([['RCLAAA', 2]]), carts: [], now: NOW,
    };
    check('a used code is matched whatever its casing', summarise(stats).used === 1);
  }

  suite('recovery card — what it says it is doing');

  check('with no mail secrets it says it is off',
    stateOf({ ready: false }).label === 'Off');
  check('while a storewide sale beats the coupon it says it is holding',
    stateOf({ ready: true, paused: true, storeRate: 20 }).label === 'Holding');
  check('and names the rate that is already coming off',
    stateOf({ ready: true, paused: true, storeRate: 20 }).note.includes('20%'));
  check('otherwise it says it is sending',
    stateOf({ ready: true, paused: false }).label === 'Sending');

  suite('recovery card — gathering, and what it refuses to claim');

  {
    const e = env({ RECOVERY: fakeKV([{ token: 'a', code: 'RCLAAA', sentAt: '2026-09-10T00:00:00Z' }]) });
    const stats = await withFetch(fakeFetch({
      carts: [cart({ token: 'a' })],
      discounts: [{ code: 'RCLAAA', numberOfUsages: 1 }],
    }), () => recoveryStats(e, NOW));

    check('the coupon log is read from KV', stats.sent.length === 1);
    check('usage is read from Snipcart', stats.usage.get('RCLAAA') === 1);
    check('and the carts from the abandoned list', stats.carts.length === 1);
    check('nothing is reported as unavailable when everything answered',
      !stats.sentUnavailable && !stats.usageUnavailable && !stats.cartsUnavailable);
  }

  {
    // Snipcart down. The card must lose its numbers, not the dashboard its page.
    const stats = await withFetch(fakeFetch({ failCarts: true, failDiscounts: true }),
      () => recoveryStats(env(), NOW));
    check('a Snipcart outage does not throw', stats && typeof stats === 'object');
    check('the carts are marked unreadable rather than reported as zero',
      stats.cartsUnavailable === true);
    check('and so is usage', stats.usageUnavailable === true);
    const html = renderRecoveryCard(stats);
    check('the card renders anyway', html.includes('Cart recovery'));
    check('and says the number could not be read, rather than showing a zero',
      html.includes('Snipcart could not be read'));
  }

  {
    // Carts with no email on them are not abandoned carts, they are browsing.
    const stats = await withFetch(fakeFetch({ carts: [cart(), cart({ email: '' })] }),
      () => recoveryStats(env(), NOW));
    check('a cart with no email attached is left out', stats.carts.length === 1);
  }

  suite('recovery card — on the page');

  {
    const e = env({ RECOVERY: fakeKV([
      { token: 'a', code: 'RCLAAA', sentAt: '2026-09-10T00:00:00Z' },
      { token: 'b', code: 'RCLBBB', sentAt: '2026-09-09T00:00:00Z' },
    ]) });
    const stats = await withFetch(fakeFetch({
      carts: [cart({ token: 'a' }), cart({ token: 'z', items: [{ name: 'Leather Butter', totalPrice: 8 }] })],
      discounts: [{ code: 'RCLAAA', numberOfUsages: 0 }, { code: 'RCLBBB', numberOfUsages: 0 }],
    }), () => recoveryStats(e, NOW));
    const html = renderRecoveryCard(stats);

    check('the tiles carry the counts', html.includes('>2<') && html.includes('Coupons sent'));
    check('the product tally is on the page',
      html.includes('Fully Custom Adjustable Radio Strap') && html.includes('Leather Butter'));
    check('a run of coupons with no uses is called out',
      html.includes('none has been used'));
    check('a cart that had one is marked', html.includes('coupon sent'));
    check('and each row links to the cart it belongs to',
      html.includes('snipcart_token=tok-') || html.includes('snipcart_token=a'));
    check('the link is flagged as the customer’s own cart',
      html.includes('treat it like their address'));
  }

  {
    const stats = await withFetch(fakeFetch({ carts: [], discounts: [] }),
      () => recoveryStats(env(), NOW));
    const html = renderRecoveryCard(stats);
    check('an empty window says so plainly', html.includes('No carts in the window'));
    check('and nothing is called out when nothing has been sent',
      !html.includes('none has been used'));
  }

  suite('recovery card — sending one by hand');

  {
    // The ordinary case: a cart nobody has mailed, sent on a button press.
    const e = env();
    const fetcher = fakeFetch({ carts: [cart({ token: 'aaa' })], discounts: [] });
    const res = await withFetch(fetcher, () => handleRecoverySend(
      new Request('https://x/', { method: 'POST', body: JSON.stringify({ token: 'aaa' }) }), e, NOW
    ));
    const body = await res.json();

    check('a cart on the card can be sent by hand', res.status === 200 && body.ok === true);
    check('and one email actually goes', fetcher.sentMail.length === 1);
    check('a discount was minted for it', e.RECOVERY.store.size > 0);
    check('the card is told plainly what happened', body.said === 'Sent.');
  }

  {
    // The 24-hour floor lives in the run loop, not in recoverCart. That is what
    // makes a by-hand send useful: a cart two hours old can still be reached.
    const e = env();
    const fetcher = fakeFetch({ carts: [cart({ token: 'new', modificationDate: secondsAgo(2) })] });
    const res = await withFetch(fetcher, () => handleRecoverySend(
      new Request('https://x/', { method: 'POST', body: JSON.stringify({ token: 'new' }) }), e, NOW
    ));
    check('a cart younger than 24 hours can still be sent by hand', (await res.json()).ok === true);
  }

  {
    // Pressing twice must not send twice — the guard that was added after one
    // buyer got two codes in the same minute.
    const e = env();
    const fetcher = fakeFetch({ carts: [cart({ token: 'aaa' })] });
    const send = () => withFetch(fetcher, () => handleRecoverySend(
      new Request('https://x/', { method: 'POST', body: JSON.stringify({ token: 'aaa' }) }), e, NOW
    ));
    await send();
    const second = await (await send()).json();

    check('pressing it twice sends one email, not two', fetcher.sentMail.length === 1);
    check('and the second press says why, rather than failing', second.ok === false);
    check('naming the guard that stopped it', second.said.includes('already had one'));
  }

  {
    // Two carts, one buyer: the per-buyer rule holds on the manual path too.
    const e = env();
    const fetcher = fakeFetch({ carts: [cart({ token: 'one' }), cart({ token: 'two' })] });
    await withFetch(fetcher, () => handleRecoverySend(
      new Request('https://x/', { method: 'POST', body: JSON.stringify({ token: 'one' }) }), e, NOW
    ));
    const second = await (await withFetch(fetcher, () => handleRecoverySend(
      new Request('https://x/', { method: 'POST', body: JSON.stringify({ token: 'two' }) }), e, NOW
    ))).json();

    check('a second cart from the same buyer is refused', second.ok === false);
    check('and only one email ever went', fetcher.sentMail.length === 1);
    check('the reason names the buyer, not the cart', second.said.includes('that buyer') || second.said.includes('That buyer'));
  }

  {
    // A token that is not on the card cannot be reached through this endpoint.
    const e = env();
    const res = await withFetch(fakeFetch({ carts: [cart({ token: 'aaa' })] }), () => handleRecoverySend(
      new Request('https://x/', { method: 'POST', body: JSON.stringify({ token: 'somebody-elses' }) }), e, NOW
    ));
    check('a cart not in the window is refused', res.status === 404);
    check('and nothing was written', e.RECOVERY.store.size === 0);
  }

  {
    const e = env();
    const res = await withFetch(fakeFetch({ carts: [] }), () => handleRecoverySend(
      new Request('https://x/', { method: 'POST', body: JSON.stringify({}) }), e, NOW
    ));
    check('a request naming no cart is refused', res.status === 400);
  }

  {
    // No mail secrets: refuse before minting, so no orphan code is left in
    // Snipcart that nobody was ever told about.
    const e = env({ BREVO_KEY: '' });
    const fetcher = fakeFetch({ carts: [cart({ token: 'aaa' })] });
    const res = await withFetch(fetcher, () => handleRecoverySend(
      new Request('https://x/', { method: 'POST', body: JSON.stringify({ token: 'aaa' }) }), e, NOW
    ));
    check('with no mailer it refuses up front', res.status === 500);
    check('and mints nothing', e.RECOVERY.store.size === 0);
  }

  {
    // A send button only appears on a cart that has not had one.
    const e = env({ RECOVERY: fakeKV([{ token: 'aaa', code: 'RCLAAA', sentAt: '2026-09-10T00:00:00Z' }]) });
    const stats = await withFetch(fakeFetch({
      carts: [cart({ token: 'aaa' }), cart({ token: 'bbb' })],
      discounts: [{ code: 'RCLAAA', numberOfUsages: 0 }],
    }), () => recoveryStats(e, NOW));
    const html = renderRecoveryCard(stats);

    check('the waiting cart gets a button', html.includes('data-send="bbb"'));
    check('the one already mailed does not', !html.includes('data-send="aaa"'));
    check('and the card explains what the button does',
      html.includes('does by hand what the hourly run does'));
  }

  suite('recovery card — through the Worker');

  {
    const e = env({
      SLIP_USER: 'dev', SLIP_PASS: 'dev',
      QUOTES: null, EXPENSES: null, PROMO: null,
      RECOVERY: fakeKV([{ token: 'a', code: 'RCLAAA', sentAt: '2026-09-10T00:00:00Z' }]),
      ASSETS: { fetch: async () => new Response('no', { status: 404, headers: { 'content-type': 'text/html' } }) },
    });
    const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
    const res = await withFetch(fakeFetch({
      carts: [cart({ token: 'a' })],
      discounts: [{ code: 'RCLAAA', numberOfUsages: 0 }],
    }), () => worker.fetch(
      new Request('https://rawhidecityleather.com/dashboard', { headers: { Authorization: AUTH } }), e
    ));

    check('the dashboard still renders', res.status === 200);
    const html = await res.text();
    check('with the recovery card on it', html.includes('id="recovery"'));
    check('and a way to get to it from the rail', html.includes('#recovery'));
    check('the card is sending, not holding, with no sale on', html.includes('Sending'));
  }

  {
    // A storewide automatic 15% is live: the card should say it is holding.
    const e = env({
      SLIP_USER: 'dev', SLIP_PASS: 'dev',
      QUOTES: null, EXPENSES: null, PROMO: null,
      ASSETS: { fetch: async () => new Response('no', { status: 404, headers: { 'content-type': 'text/html' } }) },
    });
    const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
    const res = await withFetch(fakeFetch({
      carts: [cart()],
      discounts: [{ name: 'LABORDAY15', trigger: 'Total', type: 'Rate', rate: 15, totalToReach: 1 }],
    }), () => worker.fetch(
      new Request('https://rawhidecityleather.com/dashboard', { headers: { Authorization: AUTH } }), e
    ));
    const html = await res.text();
    check('the card says it is holding while the store is on sale', html.includes('Holding'));
    check('and explains that the coupon would be worth nothing',
      html.includes('worth nothing to the buyer'));
  }
}
