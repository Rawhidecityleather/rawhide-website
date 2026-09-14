/**
 * The one-off coupon: what it will and will not mint, what it hands back, and
 * the fact that it emails nobody.
 */

import { suite, check, throws } from './harness.mjs';
import worker from '../index.js';
import {
  buildCoupon, dealWords, recentCoupons, renderCouponCard, handleCouponCreate,
  ONE_OFF_PREFIX, PERCENT_MAX, AMOUNT_MAX, DAYS_MAX,
} from '../coupon.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const DAY = 24 * 3600 * 1000;

function fakeFetch({ discounts = [], refuse = '' } = {}) {
  const calls = { minted: [], mail: [], lists: 0 };
  const fn = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : null;

    if (href.includes('/discounts') && init.method === 'POST') {
      if (refuse) return new Response(JSON.stringify({ message: refuse }), { status: 400, statusText: 'Bad Request' });
      calls.minted.push(body);
      return new Response(JSON.stringify({ id: 'disc-' + calls.minted.length }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('/discounts')) {
      calls.lists++;
      return new Response(JSON.stringify({ items: discounts, hasMoreResults: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('brevo')) {
      calls.mail.push(body);
      return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (href.includes('/orders') || href.includes('/carts')) {
      return new Response(JSON.stringify({ items: [], totalItems: 0 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected fetch: ' + href);
  };
  fn.calls = calls;
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

const post = (body) => new Request('https://x/', { method: 'POST', body: JSON.stringify(body) });
const env = (over = {}) => ({ SNIPCART_SECRET: 'test-key-never-used', ...over });

export default async function run() {
  suite('coupon — what it will mint');

  const made = buildCoupon({ label: '  Mike,  missed the 15 ', type: 'percent', value: 15, days: 14 }, 'RCLTEST', NOW);
  check('the label is tidied and kept', made.label === 'Mike, missed the 15');
  check('and carries the prefix that finds it again',
    made.body.name === ONE_OFF_PREFIX + 'Mike, missed the 15');
  check('it is a code the buyer types', made.body.trigger === 'Code' && made.body.code === 'RCLTEST');
  check('worth what was asked', made.body.type === 'Rate' && made.body.rate === 15);
  check('it works exactly once', made.body.maxNumberOfUsages === 1);
  check('and never stacks on a sale', made.body.combinable === false);
  check('the expiry is the days asked for',
    Date.parse(made.body.expires) === NOW + 14 * DAY);

  const dollars = buildCoupon({ label: 'Refund make-good', type: 'amount', value: 25, days: 7 }, 'RCLX', NOW);
  check('dollars off is a fixed amount, not a rate',
    dollars.body.type === 'FixedAmount' && dollars.body.amount === 25 && dollars.body.rate === undefined);

  throws('a coupon for nobody is refused',
    () => buildCoupon({ label: '   ', type: 'percent', value: 15 }, 'X', NOW), 'who it is for');
  throws('a percent over the cap is refused',
    () => buildCoupon({ label: 'x', type: 'percent', value: PERCENT_MAX + 1 }, 'X', NOW), 'whole number');
  throws('a fractional percent is refused',
    () => buildCoupon({ label: 'x', type: 'percent', value: 12.5 }, 'X', NOW), 'whole number');
  throws('a silly dollar amount is refused',
    () => buildCoupon({ label: 'x', type: 'amount', value: AMOUNT_MAX + 1 }, 'X', NOW), 'Dollars off');
  throws('a zero discount is refused',
    () => buildCoupon({ label: 'x', type: 'percent', value: 0 }, 'X', NOW), 'whole number');
  throws('an expiry beyond the cap is refused',
    () => buildCoupon({ label: 'x', type: 'percent', value: 10, days: DAYS_MAX + 1 }, 'X', NOW), 'Good for');
  throws('and one that expires before it starts',
    () => buildCoupon({ label: 'x', type: 'percent', value: 10, days: 0 }, 'X', NOW), 'Good for');

  check('a long label is cut, not refused',
    buildCoupon({ label: 'y'.repeat(200), type: 'percent', value: 10 }, 'X', NOW).label.length === 60);
  check('the deal reads back in words',
    dealWords('percent', 15) === '15% off' && dealWords('amount', 25) === '$25 off'
    && dealWords('amount', 12.5) === '$12.50 off');

  suite('coupon — minting one');

  {
    const fetcher = fakeFetch();
    const real = await withFetch(fetcher, () => handleCouponCreate(
      post({ label: 'Mike', type: 'percent', value: 15, days: 14 }), env(), NOW
    ));
    const body = await real.json();

    check('it mints exactly one discount', fetcher.calls.minted.length === 1);
    check('and hands back a code that looks like ours', /^RCL[A-Z0-9]{8}$/.test(body.code));
    check('with the terms spelled out', body.deal === '15% off' && body.days === 14);
    check('and it emails nobody at all', fetcher.calls.mail.length === 0);
  }

  {
    const fetcher = fakeFetch();
    const res = await withFetch(fetcher, () => handleCouponCreate(post({ label: '' }), env(), NOW));
    check('a bad form is a 400 with the complaint', res.status === 400);
    check('and nothing is minted', fetcher.calls.minted.length === 0);
  }

  {
    const fetcher = fakeFetch({ refuse: 'code already exists' });
    const res = await withFetch(fetcher, () => handleCouponCreate(
      post({ label: 'Mike', type: 'percent', value: 15 }), env(), NOW
    ));
    check('Snipcart refusing is reported, not swallowed', res.status === 502);
    check('with what Snipcart said', (await res.json()).error.includes('would not take it'));
  }

  {
    const res = await handleCouponCreate(post({ label: 'Mike' }), { SNIPCART_SECRET: '' }, NOW);
    check('with no Snipcart key it says so', res.status === 500);
  }

  suite('coupon — the ones already made');

  {
    const discounts = [
      { name: ONE_OFF_PREFIX + 'Mike', code: 'RCLAAA', type: 'Rate', rate: 15, numberOfUsages: 1, creationDate: '2026-09-10' },
      { name: ONE_OFF_PREFIX + 'Dana', code: 'RCLBBB', type: 'FixedAmount', amount: 25, numberOfUsages: 0, creationDate: '2026-09-12', expires: '2026-09-30T00:00:00Z' },
      { name: ONE_OFF_PREFIX + 'Old', code: 'RCLCCC', type: 'Rate', rate: 10, numberOfUsages: 0, creationDate: '2026-08-01', expires: '2026-08-10T00:00:00Z' },
      { name: 'Sale banner: 15% off the whole store', code: '', type: 'Rate', rate: 15, creationDate: '2026-09-13' },
      { name: 'Cart recovery 15% - someone', code: 'RCLZZZ', type: 'Rate', rate: 15, creationDate: '2026-09-13' },
    ];
    const list = await withFetch(fakeFetch({ discounts }), () => recentCoupons(env(), NOW));

    check('only the one-offs are listed', list.length === 3);
    check('a sale rule is not one', !list.some((c) => c.label.includes('whole store')));
    check('nor is a recovery coupon', !list.some((c) => c.code === 'RCLZZZ'));
    check('newest first', list[0].label === 'Dana');
    check('a used one is marked used', list.find((c) => c.label === 'Mike').used === true);
    check('an expired one is marked expired', list.find((c) => c.label === 'Old').expired === true);
    check('one still good is neither', (() => {
      const dana = list.find((c) => c.label === 'Dana');
      return dana.used === false && dana.expired === false;
    })());
    check('the deal comes back in words', list.find((c) => c.label === 'Dana').deal === '$25 off');
    check('a Snipcart failure comes back as null, not an empty list', (await withFetch(
      async () => { throw new Error('down'); }, () => recentCoupons(env(), NOW)
    )) === null);
  }

  suite('coupon — the card');

  {
    const html = renderCouponCard([
      { label: 'Mike', code: 'RCLAAA', deal: '15% off', used: true, expired: false, archived: false, expires: '' },
    ], { ready: true });
    check('the form is there', html.includes('id="couponform"'));
    check('it says plainly that it sends nothing',
      html.includes('it does not email') || html.includes('does not email anyone'));
    check('it warns that it will not stack on a sale', html.includes('not stack on a storewide sale'));
    check('a past code is listed with its state', html.includes('RCLAAA') && html.includes('used'));
    check('with no Snipcart key the form is hidden and explained',
      renderCouponCard([], { ready: false }).includes('not configured'));
    check('an unreadable list says so rather than showing none',
      renderCouponCard(null, { ready: true }).includes('could not be read'));
    check('an empty list says none yet', renderCouponCard([], { ready: true }).includes('None made yet'));
  }

  suite('coupon — through the Worker');

  {
    const e = {
      SNIPCART_SECRET: 'test-key-never-used',
      SLIP_USER: 'dev', SLIP_PASS: 'dev',
      QUOTES: null, EXPENSES: null, PROMO: null, RECOVERY: null,
      ASSETS: { fetch: async () => new Response('no', { status: 404, headers: { 'content-type': 'text/html' } }) },
    };
    const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
    const DASH = { Authorization: AUTH, 'x-rawhide-dashboard': '1', 'content-type': 'application/json' };
    const fetcher = fakeFetch();

    const page = await withFetch(fetcher, () => worker.fetch(
      new Request('https://rawhidecityleather.com/dashboard', { headers: { Authorization: AUTH } }), e
    ));
    check('the dashboard carries the card', (await page.text()).includes('id="coupon"'));

    check('minting needs a login', (await worker.fetch(
      new Request('https://rawhidecityleather.com/dashboard/api/coupon', { method: 'POST' }), e
    )).status === 401);

    check('and the dashboard header', (await worker.fetch(
      new Request('https://rawhidecityleather.com/dashboard/api/coupon', {
        method: 'POST', headers: { Authorization: AUTH },
      }), e
    )).status === 403);

    const res = await withFetch(fetcher, () => worker.fetch(
      new Request('https://rawhidecityleather.com/dashboard/api/coupon', {
        method: 'POST', headers: DASH,
        body: JSON.stringify({ label: 'Mike', type: 'percent', value: 15, days: 14 }),
      }), e
    ));
    const body = await res.json();
    check('a good request mints and returns the code',
      res.status === 200 && body.ok === true && /^RCL[A-Z0-9]{8}$/.test(body.code));
    check('and still nobody was emailed', fetcher.calls.mail.length === 0);
  }
}
