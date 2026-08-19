/**
 * Rawhide City Leather — order dashboard and packing slips.
 *
 * Static assets are served before this Worker runs, except for the paths listed
 * under `run_worker_first` in wrangler.jsonc. Everything else falls through to
 * the asset router, which applies the 404 page.
 *
 * Routes
 *   GET  /product-page/…             301 to the new product page. Old Wix URLs.
 *   GET  /dashboard                  orders, revenue, ship queue, quotes
 *   POST /dashboard/pirate-ship.csv  address spreadsheet for the selected orders
 *   POST /dashboard/api/ship         one order: save tracking, mark shipped
 *   POST /dashboard/api/ship-batch   paste Pirate Ship's list, ship them all
 *   POST /dashboard/api/quote        build a custom-job quote, get a link
 *   POST /dashboard/api/quote/void   kill a quote link
 *   POST /dashboard/api/quote/paid   stamp a cash quote collected
 *   GET  /dashboard/quote-print?id=… printable quote / cash invoice
 *   GET  /dashboard/expenses         the receipt ledger for one year
 *   POST /dashboard/api/receipt      upload a receipt photo, get a draft row
 *   POST /dashboard/api/expense      save one ledger row
 *   POST /dashboard/api/expense/delete   drop a row and its photo
 *   GET  /dashboard/expenses.csv     the year's receipts as a spreadsheet
 *   GET  /dashboard/expenses/report  the printable year-end packet
 *   POST /dashboard/hooks/snipcart   webhook: tracking -> Shipped, paid -> quote
 *   GET  /packing-slip?token=…       printable slip / build sheet
 *   GET  /logo/<key>                 customer artwork for a custom stamp
 *   GET  /receipt/<key>              a stored receipt photo
 *   POST /api/logo-upload            PUBLIC. Artwork upload from a product page.
 *   POST /api/inquiry                PUBLIC. Contact-form inquiry, emailed to the shop.
 *   GET  /quote/…                    PUBLIC. The crew's quote page.
 *
 * Email
 *   the private filing address — a forwarded receipt becomes a row on the
 *   expenses page. See worker/email-in.js.
 *
 * Cron
 *   hourly — abandoned cart recovery, step 3. See worker/recovery.js.
 *
 * Secrets (set with `wrangler secret put NAME`):
 *   SNIPCART_SECRET — Snipcart secret API key. Reads and updates orders, never
 *                     ships to the browser.
 *   SLIP_USER       — username for the browser login prompt
 *   SLIP_PASS       — password for the browser login prompt
 *   BREVO_KEY       — cart recovery email. See worker/mailer.js for why Brevo.
 *   RECOVERY_FROM   — from address for recovery email, on the
 *                     rawhidecityleather.com domain authenticated in Brevo.
 *   RECOVERY_POSTAL_ADDRESS — footer mailing address. CAN-SPAM. A PO box is fine.
 *
 * Bindings:
 *   QUOTES   — KV namespace holding custom-job quotes. See the README.
 *   RECOVERY — KV namespace recording which carts have had a recovery email.
 *   EXPENSES — KV namespace holding the receipt ledger. See the README.
 *   LOGOS    — R2 bucket holding customer artwork uploads. See the README.
 *   RECEIPTS — R2 bucket holding receipt photos.
 *   AI       — Workers AI, used to read a receipt photo. Optional: without it
 *              uploads still store and the row gets filled in by hand.
 */

import { esc, json, notice, page } from './lib.js';
import {
  getAllOrders, getOrder, getOrders, putJson, validateRequestToken,
  isCancelled, isShipped, trackingUrlFor,
} from './snipcart.js';
import { renderSlip, SLIP_STYLES } from './slip.js';
import { renderQuoteSheet, QUOTE_SHEET_STYLES } from './quote-sheet.js';
import {
  analyze, renderDashboard, DEFAULT_RANGE, DASHBOARD_STYLES, DASHBOARD_SCRIPT,
} from './dashboard.js';
import { pirateShipCsv, parseTrackingPaste } from './pirateship.js';
import { handleLogoUpload, handleLogoFetch } from './uploads.js';
import { runRecovery } from './recovery.js';
import { handleInquiry } from './inquiry.js';
import {
  buildQuote, putQuote, getQuote, listQuotes, voidQuote, markQuotePaid,
  renderQuotePage, quoteStatus, isQuoteId, QuoteError, QUOTE_ITEM_PREFIX,
  markQuoteCashPaid,
} from './quote.js';
import { storeUpload, handleReceiptFetch, deleteReceipt } from './receipts.js';
import {
  buildExpense, applyEdit, putExpense, getExpense, deleteExpense, listExpenses,
  forYear, totals, yearsPresent, expensesCsv, isExpenseId, ExpenseError,
  renderExpensesPage, renderExpenseReport, EXPENSE_STYLES, REPORT_STYLES,
  EXPENSES_SCRIPT,
} from './expenses.js';
import { handleEmail } from './email-in.js';

export default {
  /**
   * Receipts forwarded to the shop's private filing address. Cloudflare Email
   * Routing points that one address here instead of at the inbox; every other
   * address on the domain still forwards to Gmail untouched.
   *
   * handleEmail never throws — a thrown error bounces the message back to the
   * sender, and a receipt the shop forwarded is not something to bounce.
   */
  async email(message, env) {
    await handleEmail(message, env);
  },

  /**
   * Abandoned cart recovery. Runs hourly rather than once a day so a cart
   * crossing the 72 hour line waits at most an hour, instead of landing at
   * whatever time of day the daily run happens to fire.
   *
   * runRecovery never throws for a single bad cart — it reports per-cart
   * status — so anything caught here is a whole-run failure worth logging.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runRecovery(env)
        .then((report) => {
          console.log('cart recovery', JSON.stringify(report.counts || {}),
            `scanned=${report.scanned} due=${report.due}`,
            'reasons=' + JSON.stringify(report.reasons || {}),
            'ages=' + JSON.stringify(report.ageSpread || {}),
            report.skipped ? `skipped=${report.skipped}` : '');
        })
        .catch((err) => {
          console.error('cart recovery failed', err?.message || err);
        })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Both normalisations below write into one URL and issue one redirect. An
    // old Wix URL on the www host needs both, and that combination is exactly
    // where Google holds the radio strap rankings — doing it in two hops would
    // put an extra redirect on the site's most valuable inbound links.
    const canonical = new URL(url);

    // www and the apex both answer 200 and serve the whole shop, so Google
    // holds two copies of every page. The <link rel="canonical"> tag points at
    // the apex, but a canonical is a hint — this is what actually collapses
    // them.
    if (canonical.hostname.startsWith('www.')) {
      canonical.hostname = canonical.hostname.slice('www.'.length);
    }

    const path = canonical.pathname.replace(/\/+$/, '') || '/';

    // Dead URLs from the Wix store, still holding the site's Google rankings.
    // Listed in `run_worker_first` so they reach this line instead of the
    // asset router's 404 page.
    if (path === '/product-page' || path.startsWith('/product-page/')) {
      canonical.pathname = legacyProductTarget(path);
      // Any query string on these was Wix's own and means nothing to the new
      // pages. Dropping it also matches what this redirect did before.
      canonical.search = '';
    }

    // 308 for POST: a 301 lets the browser downgrade the method to GET, which
    // would silently break a dashboard form submitted from the www host.
    if (canonical.href !== url.href) {
      const permanent = request.method === 'GET' || request.method === 'HEAD';
      return new Response(null, {
        status: permanent ? 301 : 308,
        headers: { location: canonical.href },
      });
    }

    // The webhook authenticates with Snipcart's request token, not the login
    // prompt — Snipcart has no way to send Basic credentials.
    if (path === '/dashboard/hooks/snipcart') {
      try {
        return await guardConfigured(env, () => handleWebhook(request, env));
      } catch (err) {
        return failure(err, request);
      }
    }

    // Public on purpose: the person writing in about a custom build is a
    // shopper, not the shop. Outside guardConfigured — an inquiry has nothing
    // to do with Snipcart.
    if (path === '/api/inquiry') {
      try {
        return await handleInquiry(request, env);
      } catch (err) {
        return failure(err, request);
      }
    }

    // Public for the same reason: the customer uploading their artwork is a
    // shopper. Deliberately outside guardConfigured — an upload has nothing to
    // do with Snipcart, and a missing SNIPCART_SECRET shouldn't break the
    // product page.
    if (path === '/api/logo-upload') {
      try {
        return await handleLogoUpload(request, env);
      } catch (err) {
        return failure(err, request);
      }
    }

    // Public on purpose. Snipcart's crawler fetches this page to check the
    // price before it will accept the order, and it can't answer a login
    // prompt — the unguessable id in the URL is what keeps a quote private.
    if (path.startsWith('/quote/')) {
      try {
        return await handleQuotePage(path, env);
      } catch (err) {
        return failure(err, request);
      }
    }

    // Customer artwork is somebody else's property — it sits behind the same
    // login as the slip it prints on, not out in the open. Answered before
    // guardConfigured because fetching a stored file never touches Snipcart.
    if (path.startsWith('/logo/')) {
      if (!authorized(request, env)) return unauthorized();
      try {
        return await handleLogoFetch(path, env);
      } catch (err) {
        return failure(err, request);
      }
    }

    // The shop's own receipts. Same login as the ledger they belong to, and
    // answered before guardConfigured for the same reason as artwork: reading
    // a stored file never touches Snipcart.
    if (path.startsWith('/receipt/')) {
      if (!authorized(request, env)) return unauthorized();
      try {
        return await handleReceiptFetch(path, env);
      } catch (err) {
        return failure(err, request);
      }
    }

    // The receipt ledger sits outside guardConfigured on purpose: it is the
    // shop's own books and touches Snipcart nowhere except one optional line on
    // the report. A store key that expired must not lock the shop out of its
    // receipts — least of all in the week they're being sent to the accountant.
    if (isExpensePath(path)) {
      if (!authorized(request, env)) return unauthorized();
      try {
        return await routeExpenses(path, request, env, url);
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
    if (path === '/dashboard/api/quote') return await handleQuoteCreate(request, env);
    if (path === '/dashboard/api/quote/void') return await handleQuoteVoid(request, env);
    if (path === '/dashboard/api/quote/paid') return await handleQuoteCashPaid(request, env);
    if (path === '/dashboard/quote-print') return await handleQuotePrint(env, url);
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

/* -------------------------------------------------------- legacy Wix URLs */

/**
 * The Wix store served products at /product-page/<slug>. Those URLs are where
 * Google still holds this site's radio strap rankings — "radio strap" (2,900
 * searches/mo, #60), "custom radio straps" (1,600/mo, #42), "personalized
 * radio straps" (1,600/mo, #50), "custom leather radio strap" (590/mo, #41) —
 * and every one of them has answered 404 since the move off Wix. The ranking
 * history points at a dead page, which is the likeliest reason those terms sit
 * in the 40s and 60s instead of climbing.
 *
 * Only slugs confirmed against the live Google index go in this map. A guess
 * that lands wrong is worse than the fallback: it hands a customer the wrong
 * product and teaches Google the wrong page for the term.
 *
 * To extend — Search Console → Pages → "Not found (404)", filter for
 * /product-page/, and pair each slug with the product it actually sold.
 */
const LEGACY_PRODUCT_URLS = new Map([
  ['custom-radio-strap', '/product-fully-custom-radio-strap'],
]);

/**
 * Unknown slugs go to /shop rather than 404. Google may read a pile of
 * redirects onto one page as a soft 404 and pass little through, but a
 * customer following an old link still lands somewhere they can buy.
 */
function legacyProductTarget(path) {
  const slug = path.slice('/product-page/'.length).toLowerCase();
  return LEGACY_PRODUCT_URLS.get(slug) || '/shop';
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
  const [{ orders, truncated }, quotes, receipts] = await Promise.all([
    getAllOrders(env),
    // A missing KV binding shouldn't take the whole dashboard down — the
    // quotes card just renders empty until it's wired up.
    env.QUOTES ? listQuotes(env).catch(() => []) : Promise.resolve([]),
    // Only for the rail's badge, and only ever a count. One list call, run
    // alongside the Snipcart fetch, so it costs the page nothing.
    env.EXPENSES ? listExpenses(env).catch(() => []) : Promise.resolve([]),
  ]);
  const stats = analyze(orders, range);

  return page('Dashboard', renderDashboard(stats, {
    truncated,
    quotes,
    toCheck: receipts.filter((r) => !r.checked).length,
  }), {
    styles: DASHBOARD_STYLES,
    script: DASHBOARD_SCRIPT,
  });
}

/* ------------------------------------------------------------------ quotes */

function guardQuotes(env) {
  if (env.QUOTES) return null;
  return json({
    error: 'Quote storage is not set up. Create the KV namespace and add the ' +
      'QUOTES binding to wrangler.jsonc — see the README.',
  }, 500);
}

async function handleQuoteCreate(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);
  const missing = guardQuotes(env);
  if (missing) return missing;

  const body = await request.json().catch(() => ({}));

  let quote;
  try {
    quote = buildQuote(body);
  } catch (err) {
    // A validation complaint is the shop's typo, not a server fault — 400 so
    // the form shows the message instead of the generic error page.
    if (err instanceof QuoteError) return json({ error: err.message }, 400);
    throw err;
  }

  await putQuote(env, quote);

  return json({
    ok: true,
    id: quote.id,
    total: quote.total,
    grandTotal: quote.grandTotal,
    payment: quote.payment,
    listPrice: quote.listPrice,
    url: new URL('/quote/' + quote.id, request.url).toString(),
  });
}

async function handleQuoteVoid(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);
  const missing = guardQuotes(env);
  if (missing) return missing;

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '');
  if (!isQuoteId(id)) return json({ error: 'Bad quote id.' }, 400);

  try {
    const quote = await voidQuote(env, id);
    if (!quote) return json({ error: 'No quote with that id.' }, 404);
    return json({ ok: true, id });
  } catch (err) {
    if (err instanceof QuoteError) return json({ error: err.message }, 409);
    throw err;
  }
}

/**
 * Stamps a cash quote collected. Card quotes are refused here on purpose —
 * those get stamped by the webhook when the order lands, and a hand stamp on
 * one would say paid with nothing in the till to back it.
 */
async function handleQuoteCashPaid(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);
  const missing = guardQuotes(env);
  if (missing) return missing;

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '');
  if (!isQuoteId(id)) return json({ error: 'Bad quote id.' }, 400);

  try {
    const quote = await markQuoteCashPaid(env, id, { method: body.method });
    if (!quote) return json({ error: 'No quote with that id.' }, 404);
    return json({ ok: true, id, paidAt: quote.paidAt, paidMethod: quote.paidMethod });
  } catch (err) {
    if (err instanceof QuoteError) return json({ error: err.message }, 409);
    throw err;
  }
}

/**
 * The paper copy — the invoice for a cash job, or a quote to hand over instead
 * of email. Behind the dashboard login: this is the shop's own sheet, and the
 * customer's copy is the /quote/ link.
 *
 * Status comes off the stored record alone, without pulling the order list.
 * That's a page of Snipcart's API for one printout, and the only thing it
 * would add is catching a card quote whose paid webhook never fired.
 */
async function handleQuotePrint(env, url) {
  if (!env.QUOTES) return notFound();

  const id = url.searchParams.get('id') || '';
  if (!isQuoteId(id)) return notFound();

  const quote = await getQuote(env, id);
  if (!quote) return notFound();

  return page(`Quote ${quote.id}`, renderQuoteSheet(quote, {
    status: quoteStatus(quote),
    origin: url.origin,
  }), { styles: SLIP_STYLES + QUOTE_SHEET_STYLES });
}

/**
 * The crew's page. Unauthenticated, so it says as little as possible about
 * anything but the one quote whose id was in the URL.
 */
async function handleQuotePage(path, env) {
  const id = path.slice('/quote/'.length);
  if (!env.QUOTES || !isQuoteId(id)) return quoteGone();

  const quote = await getQuote(env, id);
  if (!quote) return quoteGone();

  const status = quoteStatus(quote);

  return new Response(renderQuotePage(quote, { status }), {
    // 410 on a dead quote is deliberate. Snipcart's crawler treats a non-2xx
    // as a failed price check, so an expired or voided link can't be paid even
    // if someone kept the checkout tab open.
    status: status === 'expired' || status === 'void' ? 410 : 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** One page for "no such quote" and "not yours to see" — they look identical. */
function quoteGone() {
  return page('Quote not found', notice(
    'No quote here.',
    'This link is wrong, or the quote has been withdrawn. Check with the shop at ' +
    '<a href="mailto:rawhidecityleather@gmail.com">rawhidecityleather@gmail.com</a>.'
  ), { styles: DASHBOARD_STYLES, status: 404 });
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

  if (body.eventName === 'order.completed') {
    return handleQuotePaid(body.content || {}, env);
  }

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

/**
 * A quote just got paid — stamp it so its link stops taking money and the
 * customer sees "paid" instead of a live button.
 *
 * Only a convenience. The dashboard decides paid/unpaid by matching real
 * Snipcart orders, so if this event was never registered nothing breaks; the
 * link just stays live until it expires.
 */
async function handleQuotePaid(order, env) {
  if (!env.QUOTES) return json({ ok: true, skipped: 'no quote storage' });

  const item = (order.items || []).find((i) =>
    String(i.id || '').startsWith(QUOTE_ITEM_PREFIX));
  if (!item) return json({ ok: true, skipped: 'not a quote order' });

  try {
    const quote = await markQuotePaid(env, item.id, order);
    return json({ ok: true, quote: quote ? quote.id : 'already marked' });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

/* ---------------------------------------------------------------- expenses */

const EXPENSE_PATHS = new Set([
  '/dashboard/expenses',
  '/dashboard/expenses.csv',
  '/dashboard/expenses/report',
  '/dashboard/api/receipt',
  '/dashboard/api/expense',
  '/dashboard/api/expense/delete',
]);

function isExpensePath(path) {
  return EXPENSE_PATHS.has(path);
}

async function routeExpenses(path, request, env, url) {
  const missing = guardLedger(env, request);
  if (missing) return missing;

  if (path === '/dashboard/expenses') return await handleExpensesPage(request, env, url);
  if (path === '/dashboard/expenses.csv') return await handleExpensesCsv(request, env, url);
  if (path === '/dashboard/expenses/report') return await handleExpenseReport(request, env, url);
  if (path === '/dashboard/api/receipt') return await handleReceiptUpload(request, env);
  if (path === '/dashboard/api/expense') return await handleExpenseSave(request, env);
  if (path === '/dashboard/api/expense/delete') return await handleExpenseDelete(request, env);
  return notFound();
}

function guardLedger(env, request) {
  if (env.EXPENSES) return null;

  const message = 'Receipt storage is not set up. Create the KV namespace and add ' +
    'the EXPENSES binding to wrangler.jsonc — see the README.';

  if (wantsJson(request)) return json({ error: message }, 500);
  return page('Not configured', notice('Receipts are not set up yet.', esc(message)),
    { styles: EXPENSE_STYLES, status: 500 });
}

/**
 * Which year's book to open. Anything unparseable falls back to this one rather
 * than erroring — a hand-edited URL should show a page, not a stack trace.
 */
function cleanYear(value, now = new Date()) {
  const current = now.getUTCFullYear();
  const asked = Number(String(value || '').trim());
  if (!Number.isInteger(asked) || asked < 2024 || asked > current + 1) return String(current);
  return String(asked);
}

async function handleExpensesPage(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);

  const year = cleanYear(url.searchParams.get('year'));
  const records = await listExpenses(env);
  const sums = totals(forYear(records, year));

  return page('Receipts', renderExpensesPage(records, {
    year,
    years: yearsPresent(records),
    sums,
    railCounts: { toCheck: records.filter((r) => !r.checked).length },
  }), { styles: EXPENSE_STYLES, script: EXPENSES_SCRIPT });
}

async function handleExpensesCsv(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);

  const year = cleanYear(url.searchParams.get('year'));
  const records = await listExpenses(env);
  const csv = expensesCsv(forYear(records, year));

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="rawhide-expenses-${year}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

async function handleExpenseReport(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);

  const year = cleanYear(url.searchParams.get('year'));
  const images = url.searchParams.get('images') === '1';
  const records = await listExpenses(env);
  const sums = totals(forYear(records, year));

  // Deliberately touches nothing but KV.
  //
  // An earlier version put the year's sales on this page beside the spending,
  // read from Snipcart. It cost a walk of the entire order history to render
  // one row, and it made the one document with a deadline on it depend on the
  // store API being up and the key being current — which is exactly the thing
  // that will have quietly expired by the time anyone opens this in January.
  // The packet is a receipt summary. Sales come off the store's own reports.
  return page(`Expenses ${year}`, renderExpenseReport(records, { year, sums, images }),
    { styles: REPORT_STYLES });
}

async function handleReceiptUpload(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);

  const stored = await storeUpload(request, env);
  if (stored.error) return json({ error: stored.error }, stored.status || 400);

  const record = buildExpense(stored);
  await putExpense(env, record);

  // `why` rides alongside rather than into the record: it describes this one
  // reading, not the receipt, and the upload line is the only place it belongs.
  // Without it a row that came back empty gave the shop no idea whether the
  // file was unreadable, the model was down, or it simply had no text.
  return json({ ok: true, record, why: stored.draft?.why || '' });
}

async function handleExpenseSave(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '');
  if (!isExpenseId(id)) return json({ error: 'Bad receipt id.' }, 400);

  const record = await getExpense(env, id);
  if (!record) return json({ error: 'No receipt with that id.' }, 404);

  let updated;
  try {
    updated = applyEdit(record, body);
  } catch (err) {
    // The shop's typo, not a server fault — 400 so the row shows the message.
    if (err instanceof ExpenseError) return json({ error: err.message }, 400);
    throw err;
  }

  await putExpense(env, updated);
  return json({ ok: true, record: updated });
}

async function handleExpenseDelete(request, env) {
  if (!fromDashboard(request)) return json({ error: 'Bad request.' }, 403);

  const body = await request.json().catch(() => ({}));
  const id = String(body.id || '');
  if (!isExpenseId(id)) return json({ error: 'Bad receipt id.' }, 400);

  const record = await deleteExpense(env, id);
  if (!record) return json({ error: 'No receipt with that id.' }, 404);

  // The row is already gone from KV. A photo left behind in R2 is untidy; a
  // row pointing at a photo that isn't there is a broken page, so the file goes
  // second and its failure doesn't undo the delete.
  if (record.key) {
    await deleteReceipt(env, record.key).catch((err) =>
      console.error('receipt file not deleted', record.key, err?.message || err));
  }

  return json({ ok: true, id });
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

  return page(`Order ${order.invoiceNumber || ''}`.trim(),
    renderSlip(order, { quote: await quoteForOrder(env, order) }), {
      styles: SLIP_STYLES,
    });
}

/** The quote an order came from, if it came from one. Null is the normal case. */
async function quoteForOrder(env, order) {
  if (!env.QUOTES) return null;

  const item = (order.items || []).find((i) =>
    String(i.id || '').startsWith(QUOTE_ITEM_PREFIX));
  if (!item) return null;

  // A slip that can't reach KV should still print. The exemption block is the
  // only thing missing, and the alternative is no packing slip at all.
  return getQuote(env, String(item.id).slice(QUOTE_ITEM_PREFIX.length)).catch(() => null);
}

// Exported so the layout can be previewed against a fixture without a live key.
export { renderSlip, renderDashboard, analyze, page };
