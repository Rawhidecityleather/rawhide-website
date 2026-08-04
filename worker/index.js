/**
 * Rawhide City Leather — order dashboard and packing slips.
 *
 * Static assets are served before this Worker runs, except for the paths listed
 * under `run_worker_first` in wrangler.jsonc. Everything else falls through to
 * the asset router, which applies the 404 page.
 *
 * Routes
 *   GET  /dashboard                  orders, revenue, ship queue
 *   POST /dashboard/pirate-ship.csv  address spreadsheet for the selected orders
 *   POST /dashboard/api/ship         one order: save tracking, mark shipped
 *   POST /dashboard/api/ship-batch   paste Pirate Ship's list, ship them all
 *   POST /dashboard/hooks/snipcart   webhook: tracking added elsewhere -> Shipped
 *   GET  /packing-slip?token=…       printable slip / build sheet
 *
 * Secrets (set with `wrangler secret put NAME`):
 *   SNIPCART_SECRET — Snipcart secret API key. Reads and updates orders, never
 *                     ships to the browser.
 *   SLIP_USER       — username for the browser login prompt
 *   SLIP_PASS       — password for the browser login prompt
 */

import { esc, json, notice, page } from './lib.js';
import {
  getAllOrders, getOrder, getOrders, putJson, validateRequestToken,
  isCancelled, isShipped, trackingUrlFor,
} from './snipcart.js';
import { renderSlip, SLIP_STYLES } from './slip.js';
import {
  analyze, renderDashboard, DEFAULT_RANGE, DASHBOARD_STYLES, DASHBOARD_SCRIPT,
} from './dashboard.js';
import { pirateShipCsv, parseTrackingPaste } from './pirateship.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // The webhook authenticates with Snipcart's request token, not the login
    // prompt — Snipcart has no way to send Basic credentials.
    if (path === '/dashboard/hooks/snipcart') {
      try {
        return await guardConfigured(env, () => handleWebhook(request, env));
      } catch (err) {
        return failure(err, request);
      }
    }

    if (path === '/packing-slip' || path.startsWith('/dashboard')) {
      if (!authorized(request, env)) return unauthorized();
      return guardConfigured(env, () => route(path, request, env, url));
    }

    return env.ASSETS.fetch(request);
  },
};

async function route(path, request, env, url) {
  // `return await`, not `return` — a bare `return promise` inside try resolves
  // after the catch is out of scope, so a Snipcart outage would escape as a raw
  // Worker exception instead of the error page below.
  try {
    if (path === '/dashboard') return await handleDashboard(request, env, url);
    if (path === '/dashboard/pirate-ship.csv') return await handleCsv(request, env);
    if (path === '/dashboard/api/ship') return await handleShip(request, env);
    if (path === '/dashboard/api/ship-batch') return await handleShipBatch(request, env);
    if (path === '/packing-slip') return await handleSlip(request, env, url);
    return notFound();
  } catch (err) {
    return failure(err, request);
  }
}

function guardConfigured(env, run) {
  if (!env.SNIPCART_SECRET) {
    return page('Not configured', notice(
      'SNIPCART_SECRET is not set.',
      'Run <code>wrangler secret put SNIPCART_SECRET</code> in the site repo, then redeploy.'
    ), { styles: DASHBOARD_STYLES, status: 500 });
  }
  return run();
}

/** HTML pages get an HTML error; fetch() callers get JSON they can show. */
function failure(err, request) {
  const message = err && err.message ? err.message : 'Unexpected error';
  if (wantsJson(request)) return json({ error: message }, 502);

  const missing = /\b404\b/.test(message);
  return page(
    missing ? 'Not found' : 'Snipcart error',
    notice(
      missing ? 'No order with that token.' : 'Could not reach Snipcart.',
      esc(message)
    ),
    { styles: DASHBOARD_STYLES, status: missing ? 404 : 502 }
  );
}

function wantsJson(request) {
  return request.method === 'POST' ||
    (request.headers.get('accept') || '').includes('application/json');
}

function notFound() {
  return page('Not found', notice('Nothing here.', 'Try the <a href="/dashboard">dashboard</a>.'),
    { styles: DASHBOARD_STYLES, status: 404 });
}

/* ------------------------------------------------------------------- auth */

function unauthorized() {
  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Rawhide City Leather", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function authorized(request, env) {
  // No credentials configured means no access. Never fail open.
  if (!env.SLIP_USER || !env.SLIP_PASS) return false;

  const header = request.headers.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }

  const split = decoded.indexOf(':');
  if (split < 0) return false;

  return (
    constantTimeEqual(decoded.slice(0, split), env.SLIP_USER) &&
    constantTimeEqual(decoded.slice(split + 1), env.SLIP_PASS)
  );
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Browsers attach Basic credentials to cross-site form posts automatically, so
 * a POST alone isn't proof the dashboard sent it. A custom header is: setting
 * one cross-origin requires a CORS preflight, which we never answer.
 */
function fromDashboard(request) {
  return request.method === 'POST' && request.headers.get('x-rawhide-dashboard') === '1';
}

/* -------------------------------------------------------------- dashboard */

async function handleDashboard(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);

  const range = url.searchParams.get('range') || DEFAULT_RANGE;
  const { orders, truncated } = await getAllOrders(env);
  const stats = analyze(orders, range);

  return page('Dashboard', renderDashboard(stats, { truncated }), {
    styles: DASHBOARD_STYLES,
    script: DASHBOARD_SCRIPT,
  });
}

/* ------------------------------------------------------------ pirate ship */

async function handleCsv(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);

  const body = await request.json().catch(() => ({}));
  const tokens = (Array.isArray(body.tokens) ? body.tokens : [])
    .filter((t) => typeof t === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(t))
    .slice(0, 250);

  if (!tokens.length) return json({ error: 'No orders selected.' }, 400);

  // Fetched one at a time rather than reused from the list: an address typo'd
  // into a label costs a wasted stamp, so take the authoritative record.
  const orders = await getOrders(env, tokens);
  const csv = pirateShipCsv(orders);

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="pirate-ship-${tokens.length}-orders.csv"`,
      'cache-control': 'no-store',
    },
  });
}

/* ---------------------------------------------------------------- shipping */

/** Carrier numbers are alphanumeric. Anything else is a typo, not a label. */
function cleanTracking(value) {
  const n = String(value || '').replace(/[\s-]+/g, '').toUpperCase();
  return /^[0-9A-Z]{8,40}$/.test(n) ? n : '';
}

async function markShipped(env, token, trackingNumber) {
  return putJson(env, '/orders/' + encodeURIComponent(token), {
    status: 'Shipped',
    trackingNumber,
    trackingUrl: trackingUrlFor(trackingNumber),
  });
}

async function handleShip(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);

  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '');
  const trackingNumber = cleanTracking(body.trackingNumber);

  if (!/^[A-Za-z0-9-]{8,64}$/.test(token)) return json({ error: 'Bad order token.' }, 400);
  if (!trackingNumber) return json({ error: "That doesn't look like a tracking number." }, 400);

  await markShipped(env, token, trackingNumber);
  return json({ ok: true, token, trackingNumber });
}

async function handleShipBatch(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);

  const body = await request.json().catch(() => ({}));
  const text = String(body.text || '');
  if (!text.trim()) return json({ error: 'Nothing pasted.' }, 400);

  const { orders } = await getAllOrders(env);
  const { matched, unmatched } = parseTrackingPaste(text, orders);

  const shipped = [];
  const failed = [];

  // Sequential on purpose — a dozen writes at once invites Snipcart's rate
  // limiter, and a half-applied batch is worse than a slow one.
  for (const row of matched) {
    const trackingNumber = cleanTracking(row.trackingNumber);
    if (!trackingNumber) {
      failed.push({ invoiceNumber: row.invoiceNumber, error: 'unreadable tracking number' });
      continue;
    }
    try {
      await markShipped(env, row.token, trackingNumber);
      shipped.push({ invoiceNumber: row.invoiceNumber, trackingNumber });
    } catch (err) {
      failed.push({ invoiceNumber: row.invoiceNumber, error: err.message });
    }
  }

  return json({ ok: true, shipped, failed, unmatched });
}

/* ---------------------------------------------------------------- webhook */

/**
 * Fires when a tracking number lands on an order from anywhere — Snipcart's own
 * dashboard, this dashboard, or the API — and flips the order to Shipped so the
 * status never disagrees with reality.
 *
 * Register it in Snipcart under Store Configurations → Webhooks:
 *   https://rawhidecityleather.com/dashboard/hooks/snipcart
 */
async function handleWebhook(request, env) {
  // Token first, method second: an unauthenticated probe should learn nothing
  // about this endpoint, not even which verbs it takes.
  const token = request.headers.get('X-Snipcart-RequestToken');
  if (!await validateRequestToken(env, token)) {
    return json({ error: 'Invalid request token.' }, 401);
  }

  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const body = await request.json().catch(() => ({}));
  if (body.eventName !== 'order.trackingNumber.changed') {
    return json({ ok: true, ignored: body.eventName || 'unknown event' });
  }

  const order = body.content || {};
  const trackingNumber = cleanTracking(body.trackingNumber || order.trackingNumber);

  if (!order.token) return json({ ok: true, skipped: 'no order token' });
  if (!trackingNumber) return json({ ok: true, skipped: 'tracking number cleared' });

  // Already out the door, or never going out. Also stops the update this
  // handler makes from bouncing back through the webhook a second time.
  if (isShipped(order) || isCancelled(order)) {
    return json({ ok: true, skipped: 'order is ' + order.status });
  }

  try {
    const patch = { status: 'Shipped' };
    // Don't overwrite a carrier link Snipcart or the shop already set.
    if (!(body.trackingUrl || order.trackingUrl)) {
      patch.trackingUrl = trackingUrlFor(trackingNumber);
    }
    await putJson(env, '/orders/' + encodeURIComponent(order.token), patch);
  } catch (err) {
    // Non-2xx tells Snipcart to retry, which is what a transient failure wants.
    return json({ error: err.message }, 502);
  }

  return json({ ok: true, shipped: order.invoiceNumber || order.token });
}

/* ------------------------------------------------------------ packing slip */

async function handleSlip(request, env, url) {
  const token = url.searchParams.get('token');

  // The old token-less listing lived here; the dashboard does that job now.
  if (!token) return Response.redirect(new URL('/dashboard', url).toString(), 302);

  const order = await getOrder(env, token);

  // ?raw=1 dumps the untouched API response, for checking field names.
  if (url.searchParams.get('raw')) {
    return new Response(JSON.stringify(order, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  return page(`Order ${order.invoiceNumber || ''}`.trim(), renderSlip(order), {
    styles: SLIP_STYLES,
  });
}

// Exported so the layout can be previewed against a fixture without a live key.
export { renderSlip, renderDashboard, analyze, page };
