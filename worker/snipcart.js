/**
 * Snipcart REST client. The secret key never leaves the Worker.
 */

const API = 'https://app.snipcart.com/api';

/** Snipcart's limit tops out at 50 per page. */
const PAGE_SIZE = 50;

/** Backstop so a runaway account can't fan out into hundreds of subrequests. */
const MAX_PAGES = 40;

/** How many order pages to request at once. */
const PAGE_BATCH = 5;

/** Payment states where the money actually landed. Anything else isn't revenue. */
const PAID = new Set(['Paid', 'Paidout', 'PaidDeferred']);

/** Order states that mean the package is already out the door. */
const SHIPPED = new Set(['Shipped', 'Delivered']);

function authHeader(env) {
  // HTTP Basic: secret key as the username, empty password.
  return 'Basic ' + btoa(env.SNIPCART_SECRET + ':');
}

export async function getJson(env, path) {
  const res = await fetch(API + path, {
    headers: { Authorization: authHeader(env), Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Snipcart returned ${res.status} ${res.statusText}`);
  return res.json();
}

export async function putJson(env, path, body) {
  const res = await fetch(API + path, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(env),
      Accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Snipcart returned ${res.status} ${res.statusText}${detail ? ': ' + detail.slice(0, 300) : ''}`
    );
  }
  return res.json().catch(() => ({}));
}

export function getOrder(env, token) {
  return getJson(env, '/orders/' + encodeURIComponent(token));
}

/**
 * Every order, newest first. Test orders are excluded by default, so the
 * revenue figures only ever count real money.
 *
 * Returns { orders, truncated } — `truncated` is true if the account has more
 * orders than MAX_PAGES could reach, so the UI can say so rather than quietly
 * under-reporting the lifetime total.
 */
export async function getAllOrders(env) {
  // format=Full is the default, but say it out loud — Excerpt drops the line
  // items and addresses the ship queue is built from.
  const query = (offset) => `/orders?format=Full&limit=${PAGE_SIZE}&offset=${offset}`;

  const first = await getJson(env, query(0));
  const orders = first.items || [];
  const total = Number(first.totalItems) || orders.length;

  const pagesNeeded = Math.ceil(total / PAGE_SIZE);
  const pages = Math.min(pagesNeeded, MAX_PAGES);

  for (let start = 1; start < pages; start += PAGE_BATCH) {
    const batch = [];
    for (let p = start; p < Math.min(start + PAGE_BATCH, pages); p++) {
      batch.push(getJson(env, query(p * PAGE_SIZE)));
    }
    for (const res of await Promise.all(batch)) orders.push(...(res.items || []));
  }

  return { orders, total, truncated: pagesNeeded > MAX_PAGES };
}

/** Fetches full order records a few at a time, so a big export stays polite. */
export async function getOrders(env, tokens, concurrency = 4) {
  const out = [];
  for (let i = 0; i < tokens.length; i += concurrency) {
    const batch = tokens.slice(i, i + concurrency).map((t) => getOrder(env, t));
    out.push(...await Promise.all(batch));
  }
  return out;
}

/**
 * Confirms a webhook really came from Snipcart. The token in the request header
 * is echoed back to Snipcart, which only validates tokens it issued itself.
 */
export async function validateRequestToken(env, token) {
  if (!token) return false;
  try {
    const res = await fetch(
      `${API}/requestvalidation/${encodeURIComponent(token)}`,
      { headers: { Authorization: authHeader(env), Accept: 'application/json' } }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------- order predicates */

export function isPaid(order) {
  return PAID.has(order?.paymentStatus);
}

export function isCancelled(order) {
  return order?.status === 'Cancelled';
}

export function isShipped(order) {
  return SHIPPED.has(order?.status);
}

/**
 * How much of the order got handed back: 'none', 'partial' or 'full'.
 *
 * Two ways an order ends up fully refunded, and both have to be caught.
 * Snipcart sets paymentStatus to `Refunded` when the whole thing is reversed at
 * once, but refunding the full amount in pieces leaves paymentStatus on `Paid`
 * with `refundsAmount` grown to match the total — so the amount is checked too,
 * not just the status.
 */
export function refundState(order) {
  const refunded = Number(order?.refundsAmount) || 0;
  if (order?.paymentStatus === 'Refunded') return 'full';
  if (refunded <= 0) return 'none';
  return refunded >= grandTotal(order) ? 'full' : 'partial';
}

export function isFullyRefunded(order) {
  return refundState(order) === 'full';
}

/**
 * A sale that still stands. Excludes unpaid, cancelled and fully refunded
 * orders, so it's the one predicate every count in the dashboard runs through.
 * Partial refunds still count as sales — money changed hands and a package is
 * probably still owed; the amount kept is netRevenue's problem, not this one.
 */
export function countsAsSale(order) {
  return isPaid(order) && !isCancelled(order) && !isFullyRefunded(order);
}

/**
 * Paid for, not cancelled, not fully refunded, not yet gone out. The work queue.
 * A partial refund stays here on purpose — refunding shipping or knocking money
 * off a custom build doesn't mean the piece no longer has to be made and sent.
 */
export function needsShipping(order) {
  return countsAsSale(order) && !isShipped(order);
}

/** What the shop actually kept: order total less anything refunded. */
export function netRevenue(order) {
  if (!isPaid(order) || isCancelled(order)) return 0;
  // Refunding more than the order total would otherwise read as negative
  // revenue and quietly eat into the month's real earnings.
  return Math.max(0, grandTotal(order) - (Number(order.refundsAmount) || 0));
}

export function grandTotal(order) {
  return order.grandTotal ?? order.total ?? order.finalGrandTotal ?? 0;
}

/**
 * USPS and UPS are the two carriers Pirate Ship buys from. UPS numbers start
 * with 1Z; everything else Pirate Ship prints is USPS. Snipcart puts this link
 * in the shipping email, so a wrong guess sends the customer to a dead page.
 */
export function trackingUrlFor(number) {
  const n = String(number || '').replace(/\s+/g, '');
  if (!n) return '';
  if (/^1Z[0-9A-Z]{16}$/i.test(n)) {
    return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n);
  }
  return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(n);
}
