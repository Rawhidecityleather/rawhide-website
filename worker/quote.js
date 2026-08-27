/**
 * Custom-build quotes — a way to bill a crew for a job that isn't a catalog
 * product: twelve memorial straps, a station's promotion set, a retirement
 * piece with their numbers on it.
 *
 * The shop builds the quote in the dashboard and sends the crew a link. That
 * link is an ordinary product page as far as Snipcart is concerned, so when
 * they pay, a normal order lands and everything downstream — ship queue,
 * packing slip, Pirate Ship export, tracking email — works with no changes.
 *
 * Two things about that page are load-bearing:
 *
 * 1. It has to be public. Before Snipcart accepts an order it fetches
 *    `data-item-url` and checks the price on the page against the price in the
 *    cart. Behind the dashboard login the crawler gets a 401 and every quote
 *    checkout fails. The id in the URL is the secret instead.
 *
 * 2. Each quote gets its own item id. Snipcart refuses two products that share
 *    an id but not a price, so a single reused "custom-build" id would break
 *    the moment a second quote went out at a different number.
 */

import { esc, money, shortDate } from './lib.js';

/** Prefix on every quote's Snipcart item id. Ties an order back to its quote. */
export const QUOTE_ITEM_PREFIX = 'quote-';

/**
 * The discount Snipcart takes at checkout, as a fraction.
 *
 * Zero while no sitewide cart rule is running: the button carries the quoted
 * number and the crew pays the quoted number.
 *
 * Set it again only if another automatic discount goes live. Snipcart's
 * automatic discounts target inclusively — you can say "these products" but not
 * "everything except these" — so a quote item cannot opt out, and a $1,800
 * quote would collect $1,440 under a 20% rule unless the number on the button
 * is grossed up first.
 *
 * This has to move in step with the Snipcart rule, not before or after it. A
 * rule live with this at 0 undercharges by the rule's rate; this left at 0.2
 * with no rule overcharges by 25%.
 */
export const CHECKOUT_DISCOUNT = 0;

/** Orders at or above this ship free; below it, $10.00 flat. Matches /shipping. */
export const FREE_SHIPPING_OVER = 85;

/** Quotes stop working after this many days. */
const DEFAULT_EXPIRY_DAYS = 30;

/** Past this the form is being pasted into, not filled in. */
const MAX_LINES = 25;

/** Snipcart's own ceiling is higher, but nothing here is a five-figure job. */
const MAX_TOTAL = 100000;

/**
 * A card quote carries no tax rate — checkout works it out from the address it
 * collects. A cash sale never gets to checkout, so the shop types the rate in,
 * and this is the ceiling that catches a decimal in the wrong place.
 */
const MAX_TAX_RATE_PERCENT = 15;

/**
 * No i, l or o — these ids get read off a phone screen and typed back, and
 * 32 characters divides 256 evenly, so the bytes map on without modulo bias.
 */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz023456789';

function newId(length = 14) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/** Money in this file is dollars, not cents. Round at every boundary. */
function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/* ------------------------------------------------------------------ pricing */

/**
 * What the buy button has to carry so the crew pays `total` after Snipcart
 * takes its cut. With no sale running this is just the total.
 */
export function listPriceFor(total, rate = CHECKOUT_DISCOUNT) {
  if (!rate) return round2(total);
  return round2(total / (1 - rate));
}

/* -------------------------------------------------------------- validation */

class QuoteError extends Error {}

function requireText(value, field, max = 200) {
  const text = String(value ?? '').trim();
  if (!text) throw new QuoteError(`${field} is required.`);
  if (text.length > max) throw new QuoteError(`${field} is too long.`);
  return text;
}

function optionalText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

/** Blank is 0, not an error — most crew jobs this gets used on are exempt. */
function readTaxRate(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const pct = Number(text);
  if (!isFinite(pct) || pct < 0 || pct > MAX_TAX_RATE_PERCENT) {
    throw new QuoteError(`Sales tax has to be 0 to ${MAX_TAX_RATE_PERCENT}%.`);
  }
  return Math.round(pct * 1000) / 1000;
}

/**
 * Turns the dashboard form into a stored quote. Throws QuoteError with
 * something worth showing the shop, never a bare validation code.
 */
export function buildQuote(input, { now = Date.now() } = {}) {
  const lines = (Array.isArray(input.lines) ? input.lines : [])
    .map((line) => ({
      description: String(line?.description ?? '').trim(),
      quantity: Math.floor(Number(line?.quantity)) || 0,
      unitPrice: round2(Number(line?.unitPrice)),
    }))
    // A blank row is the form's empty state, not an error — drop it quietly.
    .filter((line) => line.description || line.quantity || line.unitPrice);

  if (!lines.length) throw new QuoteError('Add at least one line item.');
  if (lines.length > MAX_LINES) throw new QuoteError(`That's more than ${MAX_LINES} line items.`);

  for (const line of lines) {
    if (!line.description) throw new QuoteError('Every line needs a description.');
    if (line.description.length > 200) throw new QuoteError('A line description is too long.');
    if (!(line.quantity >= 1 && line.quantity <= 999)) {
      throw new QuoteError(`Quantity for "${line.description}" has to be 1 to 999.`);
    }
    if (!(line.unitPrice > 0 && line.unitPrice <= MAX_TOTAL)) {
      throw new QuoteError(`Price for "${line.description}" doesn't look right.`);
    }
    line.lineTotal = round2(line.quantity * line.unitPrice);
  }

  const total = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  if (!(total > 0 && total <= MAX_TOTAL)) throw new QuoteError('That total is out of range.');

  const taxExempt = !!input.taxExempt;
  const exemption = taxExempt ? {
    entity: requireText(input.exemptEntity, 'Exempt entity name'),
    certNumber: requireText(input.exemptCertNumber, 'Certificate number', 60),
    // Optional because not every state's certificate carries one, but the
    // dashboard flags a quote whose certificate lapses before the quote does.
    expires: optionalText(input.exemptExpires, 40),
  } : null;

  // Card is the default and the path everything downstream was built for. Cash
  // is the crew that hands over a check at the station: no checkout, no
  // Snipcart order, so the printed sheet is the whole transaction record.
  const payment = input.payment === 'cash' ? 'cash' : 'card';

  // Only a cash sale carries a rate. On a card quote Snipcart charges the tax
  // itself, and a second number here would double it on the sheet.
  const taxRatePercent = payment === 'cash' && !taxExempt ? readTaxRate(input.taxRatePercent) : 0;
  const taxAmount = round2(total * taxRatePercent / 100);
  const grandTotal = round2(total + taxAmount);

  const days = Math.min(Math.max(Math.floor(Number(input.expiryDays)) || DEFAULT_EXPIRY_DAYS, 1), 180);
  const id = newId();

  return {
    id,
    itemId: QUOTE_ITEM_PREFIX + id,
    title: requireText(input.title, 'Quote title', 120),
    customer: requireText(input.customer, 'Contact name', 120),
    department: optionalText(input.department, 160),
    email: optionalText(input.email, 160),
    notes: optionalText(input.notes, 2000),
    lines,
    total,
    payment,
    taxRatePercent,
    taxAmount,
    // What's actually collected. Same as `total` on every card quote, and on
    // any cash quote that isn't charged tax.
    grandTotal,
    // Frozen at creation. If the sale ends mid-quote the stored rate is what
    // the page was built against, and the expiry is what keeps it honest.
    discountRate: CHECKOUT_DISCOUNT,
    listPrice: listPriceFor(total),
    taxExempt,
    exemption,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + days * 86400000).toISOString(),
    voidedAt: null,
    paidAt: null,
    paidOrder: null,
    // 'cash' or 'check' once the shop marks a cash quote collected.
    paidMethod: null,
  };
}

export { QuoteError };

/* ----------------------------------------------------------------- storage */

const KEY_PREFIX = 'quote:';

/**
 * The card on the dashboard needs a line per quote, and KV hands back metadata
 * with the key list for free — so the summary rides along in metadata and the
 * dashboard renders without a read per quote. Keep it well under KV's 1 KB cap.
 */
function summarize(quote) {
  return {
    id: quote.id,
    itemId: quote.itemId,
    title: quote.title.slice(0, 80),
    customer: quote.customer.slice(0, 60),
    department: quote.department.slice(0, 80),
    email: quote.email.slice(0, 120),
    total: quote.total,
    payment: quotePayment(quote),
    grandTotal: quoteGrandTotal(quote),
    taxExempt: quote.taxExempt,
    exemptExpires: quote.exemption?.expires || '',
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
    voidedAt: quote.voidedAt,
    paidAt: quote.paidAt,
    paidMethod: quote.paidMethod || null,
  };
}

export async function putQuote(env, quote) {
  await env.QUOTES.put(KEY_PREFIX + quote.id, JSON.stringify(quote), {
    metadata: summarize(quote),
    // Let KV drop the record a year after the link dies. The order it produced
    // lives in Snipcart, which is the real book of record.
    expiration: Math.floor(Date.parse(quote.expiresAt) / 1000) + 365 * 86400,
  });
  return quote;
}

export async function getQuote(env, id) {
  if (!isQuoteId(id)) return null;
  const raw = await env.QUOTES.get(KEY_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

/** Newest first. Summaries only — enough for the dashboard card. */
export async function listQuotes(env, limit = 200) {
  const { keys } = await env.QUOTES.list({ prefix: KEY_PREFIX, limit });
  return keys
    .map((key) => key.metadata)
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function voidQuote(env, id) {
  const quote = await getQuote(env, id);
  if (!quote) return null;
  if (quote.paidAt) throw new QuoteError('That quote has already been paid.');
  quote.voidedAt = new Date().toISOString();
  return putQuote(env, quote);
}

/**
 * Stamps a quote paid. Called from the Snipcart webhook, so the public quote
 * page can say "already paid" without an API call on an unauthenticated route.
 * The dashboard doesn't rely on this — it matches against real orders — so a
 * webhook that was never registered costs accuracy nowhere that matters.
 */
export async function markQuotePaid(env, itemId, order) {
  const id = String(itemId || '').slice(QUOTE_ITEM_PREFIX.length);
  const quote = await getQuote(env, id);
  if (!quote || quote.paidAt) return null;

  quote.paidAt = new Date().toISOString();
  quote.paidOrder = order?.invoiceNumber || order?.token || null;
  return putQuote(env, quote);
}

/**
 * Stamps a cash quote collected. Nothing else can do it: a cash sale never
 * reaches Snipcart, so there is no order and no webhook — without this the
 * quote would sit open until it expired on a job that was paid for weeks ago.
 */
export async function markQuoteCashPaid(env, id, { method = 'cash', now = Date.now() } = {}) {
  const quote = await getQuote(env, id);
  if (!quote) return null;
  if (quotePayment(quote) !== 'cash') {
    throw new QuoteError('That quote is set up for card checkout — it marks itself paid when the order lands.');
  }
  if (quote.paidAt) throw new QuoteError('That quote is already marked paid.');
  if (quote.voidedAt) throw new QuoteError('That quote was voided.');

  quote.paidAt = new Date(now).toISOString();
  quote.paidMethod = method === 'check' ? 'check' : 'cash';
  return putQuote(env, quote);
}

export function isQuoteId(id) {
  return typeof id === 'string' && /^[a-z0-9]{10,32}$/.test(id);
}

/* ------------------------------------------------------------------ status */

/**
 * One word for where a quote stands. `orders` is the Snipcart list the
 * dashboard already has in hand — paid is decided by a real order carrying the
 * quote's item id, which beats anything stored locally.
 */
export function quoteStatus(summary, orders = []) {
  // A cash quote has no order to match against — the shop's stamp is all there
  // is, which is why marking it paid is a button on the dashboard.
  if (summary.paidAt) return 'paid';
  if (quotePayment(summary) === 'card' && findQuoteOrder(summary.itemId, orders)) return 'paid';
  if (summary.voidedAt) return 'void';
  if (Date.parse(summary.expiresAt) < Date.now()) return 'expired';
  return 'open';
}

/**
 * How the quote gets paid. Reads through a missing field on purpose: every
 * quote written before cash existed is a card quote, and they're still in KV.
 */
export function quotePayment(quote) {
  return quote?.payment === 'cash' ? 'cash' : 'card';
}

/** What's collected, tax included. Falls back for those same older records. */
export function quoteGrandTotal(quote) {
  return typeof quote?.grandTotal === 'number' ? quote.grandTotal : Number(quote?.total) || 0;
}

export function findQuoteOrder(itemId, orders = []) {
  return orders.find((order) =>
    (order.items || []).some((item) => item.id === itemId)) || null;
}

/**
 * Reasons a quote shouldn't have gone out, or shouldn't be trusted now.
 * Certificate trouble is the one that costs real money: the exemption is only
 * as good as the paperwork behind it on the day of the sale.
 */
export function quoteWarnings(summary) {
  const out = [];
  if (summary.taxExempt && summary.exemptExpires) {
    const certEnd = Date.parse(summary.exemptExpires);
    if (!isNaN(certEnd)) {
      if (certEnd < Date.now()) out.push('exemption certificate has expired');
      else if (certEnd < Date.parse(summary.expiresAt)) {
        out.push('certificate expires before the quote does');
      }
    }
  }
  return out;
}

/* ------------------------------------------------------- the customer's page */

/** Public, so the storefront's own stylesheet does the work. */
const SNIPCART_KEY = 'OWM2YjcyNWItMmQ3Ni00NTJlLWI5YTctNDM0NDFhMWNhOTg0NjM5MTgwOTUzMTYwNzQ0MzM5';
const SNIPCART_VERSION = 'v3.7.1';

export function renderQuotePage(quote, { status }) {
  const closed = status !== 'open';
  const cash = quotePayment(quote) === 'cash';
  const grandTotal = quoteGrandTotal(quote);

  const rows = quote.lines.map((line) => `<tr>
    <td>${esc(line.description)}</td>
    <td class="q-num">${esc(String(line.quantity))}</td>
    <td class="q-num">${esc(money(line.unitPrice, 'usd'))}</td>
    <td class="q-num q-strong">${esc(money(line.lineTotal, 'usd'))}</td>
  </tr>`).join('');

  // No gross-up on this page. The button carries a higher number so Snipcart's
  // sale can land the total on the quote, but showing that here puts a subtotal
  // on the page that doesn't match the lines above it — which reads as an
  // arithmetic mistake, not a discount. The checkout note below covers it.
  const taxRows = quote.taxExempt
    ? '<tr><td>Sales tax</td><td class="q-num">Exempt</td></tr>'
    : quote.taxAmount
      ? `<tr><td>Subtotal</td><td class="q-num">${esc(money(quote.total, 'usd'))}</td></tr>
         <tr><td>Sales tax (${esc(String(quote.taxRatePercent))}%)</td>
           <td class="q-num">${esc(money(quote.taxAmount, 'usd'))}</td></tr>`
      : '';

  const exemptBlock = quote.taxExempt ? `<div class="q-exempt">
    <p class="q-exempt-head">Tax exempt</p>
    <p>${esc(quote.exemption.entity)}<br>
      Certificate ${esc(quote.exemption.certNumber)}${
        quote.exemption.expires ? ` &middot; valid through ${esc(quote.exemption.expires)}` : ''
      }</p>
    <p class="q-soft">No sales tax is charged on this order. A copy of the
      certificate is on file with the shop.</p>
  </div>` : '';

  // The fallback is never reached from quoteStatus, but this page is public and
  // a missing key here would throw mid-render — a blank screen for a customer
  // holding a link is worse than a vague message.
  const closedNote = {
    paid: ['Paid', 'This quote has been paid. Nothing else to do &mdash; we&rsquo;re building it.'],
    expired: ['Expired', 'This quote has run out. Get in touch and we&rsquo;ll send a fresh one.'],
    void: ['Withdrawn', 'This quote has been withdrawn. Get in touch and we&rsquo;ll send a fresh one.'],
  }[status] || ['Closed', 'This quote is no longer open. Get in touch and we&rsquo;ll send a fresh one.'];

  // Cash is settled at the bench, so this page has nothing to click. It's the
  // crew's copy of what they agreed to and what to bring — the shop's copy is
  // the printed sheet off the dashboard.
  const cashPanel = `<div class="q-cash">
    <p class="q-cash-head">Due on pickup</p>
    <p class="q-cash-amount">${esc(money(grandTotal, 'usd'))}</p>
    <p>Cash or check, made out to Rawhide City Leather. Nothing to pay online.
      We start once the order is confirmed.</p>
  </div>`;

  const action = closed
    ? `<div class="q-closed"><p class="q-closed-head">${closedNote[0]}</p><p>${closedNote[1]}</p></div>`
    : cash ? cashPanel
    : `<button type="button" class="btn btn-primary btn-full snipcart-add-item"
        data-item-id="${esc(quote.itemId)}"
        data-item-price="${esc(quote.listPrice.toFixed(2))}"
        data-item-url="/quote/${esc(quote.id)}"
        data-item-name="${esc(quote.title)}"
        data-item-quantity="1"
        data-item-max-quantity="1"
        data-item-taxable="${quote.taxExempt ? 'false' : 'true'}"
        data-item-custom1-name="Quote"
        data-item-custom1-type="readonly"
        data-item-custom1-value="${esc(quote.id)}"
      >Accept &amp; Pay ${esc(money(quote.total, 'usd'))}</button>
      <p class="q-help">Card payment through our normal checkout. ${
        // Shipping follows the standing rule, same as the rest of the shop.
        // Nearly every crew job clears $85, but say which one applies rather
        // than promising free and having checkout add $10.
        quote.total >= FREE_SHIPPING_OVER ? 'Free shipping.' : '$10.00 flat rate shipping.'
      }${
        // Checkout shows the list price struck through with the shop sale taken
        // off it, the same as every product page. Say so here or the two
        // numbers on that screen look like they came out of nowhere.
        quote.discountRate
          ? ` Checkout shows the shop sale applied &mdash; your total stays ${esc(money(quote.total, 'usd'))}.`
          : ''
      }</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Quote ${esc(quote.title)} · Rawhide City Leather</title>
${cash ? '' : `<link rel="preconnect" href="https://app.snipcart.com">
<link rel="preconnect" href="https://cdn.snipcart.com">
<link rel="stylesheet" href="https://cdn.snipcart.com/themes/${SNIPCART_VERSION}/default/snipcart.css">`}
<link rel="stylesheet" href="/assets/css/style.css">
<style>${QUOTE_STYLES}</style>
</head>
<body>
<main class="q-wrap">
  <header class="q-head">
    <img src="/assets/img/logo.png" alt="Rawhide City Leather" onerror="this.remove()">
    <p class="q-tag">"We do not cut corners. We cut leather."</p>
  </header>

  <section class="q-card">
    <p class="eyebrow">Custom Build Quote</p>
    <h1>${esc(quote.title)}</h1>

    <dl class="q-meta">
      <div><dt>Prepared for</dt><dd>${esc(quote.customer)}${
        quote.department ? `<span class="q-soft"> &middot; ${esc(quote.department)}</span>` : ''
      }</dd></div>
      <div><dt>Quote</dt><dd class="q-mono">${esc(quote.id)}</dd></div>
      <div><dt>Issued</dt><dd>${esc(shortDate(quote.createdAt))}</dd></div>
      <div><dt>Good through</dt><dd>${esc(shortDate(quote.expiresAt))}</dd></div>
    </dl>

    <table class="q-lines">
      <thead><tr>
        <th>Item</th><th class="q-num">Qty</th><th class="q-num">Each</th><th class="q-num">Total</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <table class="q-totals">
      <tbody>
        ${taxRows}
        <tr class="q-grand">
          <td>Total</td><td class="q-num">${esc(money(grandTotal, 'usd'))}</td>
        </tr>
      </tbody>
    </table>
    ${quote.taxExempt || cash ? '' : `<p class="q-taxnote">Florida sales tax is added at
      checkout on orders delivered in Florida.</p>`}

    ${exemptBlock}

    ${quote.notes ? `<div class="q-notes"><h2>Build notes</h2><p>${esc(quote.notes).replace(/\n/g, '<br>')}</p></div>` : ''}

    <div class="q-action">${action}</div>
  </section>

  <footer class="q-foot">
    <p>Questions on this quote? Reply to the email it came in on, or reach us at
      <a href="mailto:rawhidecityleather@gmail.com">rawhidecityleather@gmail.com</a>.</p>
    <p class="q-soft">Radio straps run 6 weeks. Belts, helmet bands, glove straps,
      chin straps and hats run 1&ndash;3 weeks. Accessory use only &mdash; not PPE,
      not NFPA certified.</p>
  </footer>
</main>
${cash ? '' : `<div hidden id="snipcart" data-api-key="${SNIPCART_KEY}" data-config-modal-style="side"></div>
<script src="https://cdn.snipcart.com/themes/${SNIPCART_VERSION}/default/snipcart.js"></script>`}
</body>
</html>`;
}

/**
 * Layout only. Colour, type and the button come from the storefront sheet, so a
 * quote looks like the rest of the shop without this file restating the brand.
 */
const QUOTE_STYLES = `
.q-wrap{max-width:760px;margin:0 auto;padding:32px 24px 64px}
.q-head{text-align:center;padding-bottom:24px}
.q-head img{max-height:76px;width:auto;margin:0 auto}
.q-tag{font-family:var(--font-stamp);font-size:.9rem;color:var(--c-text-soft);margin:12px 0 0}
.q-card{background:var(--c-surface);border:1px solid var(--c-line-strong);padding:32px 28px}
.q-card h1{font-size:clamp(1.6rem,4vw,2.4rem);margin-bottom:.6em}
.q-soft{color:var(--c-text-soft)}
.q-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.q-strong{font-weight:700}
.q-mono{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-size:.85em}

.q-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px 20px;
  margin:0 0 28px;padding:18px 0;border-top:1px solid var(--c-line);border-bottom:1px solid var(--c-line)}
.q-meta dt{font-family:var(--font-display);text-transform:uppercase;letter-spacing:.16em;
  font-size:.66rem;color:var(--c-text-soft);margin-bottom:4px}
.q-meta dd{margin:0;font-size:.95rem}

.q-lines,.q-totals{width:100%;border-collapse:collapse;font-size:.95rem}
.q-lines th{font-family:var(--font-display);text-transform:uppercase;letter-spacing:.14em;
  font-size:.66rem;color:var(--c-text-soft);text-align:left;padding:0 0 8px;border-bottom:1px solid var(--c-line)}
.q-lines td{padding:12px 0;border-bottom:1px solid var(--c-line);vertical-align:top}
.q-lines th.q-num,.q-lines td.q-num{padding-left:16px}
.q-totals{margin-top:14px}
.q-totals td{padding:6px 0}
.q-totals td.q-num{padding-left:16px}
.q-taxnote{margin:8px 0 0;font-size:.82rem;color:var(--c-text-soft);text-align:right}
.q-grand td{border-top:2px solid var(--c-text);padding-top:12px;font-family:var(--font-display);
  font-size:1.35rem;letter-spacing:.04em}

.q-exempt{margin-top:24px;padding:16px 18px;background:var(--c-bg);border-left:3px solid var(--c-text)}
.q-exempt p{margin:0 0 6px;font-size:.9rem}
.q-exempt p:last-child{margin-bottom:0}
.q-exempt-head{font-family:var(--font-display);text-transform:uppercase;letter-spacing:.16em;
  font-size:.7rem}

.q-notes{margin-top:28px}
.q-notes h2{font-size:.8rem;letter-spacing:.18em}
.q-notes p{color:var(--c-text-soft);font-size:.95rem;margin:0}

.q-action{margin-top:32px}
.q-help{text-align:center;font-size:.82rem;color:var(--c-text-soft);margin:10px 0 0}
.q-closed{text-align:center;padding:24px;background:var(--c-bg);border:1px solid var(--c-line)}
.q-closed-head{font-family:var(--font-display);text-transform:uppercase;letter-spacing:.18em;
  font-size:.8rem;margin:0 0 8px}
.q-closed p:last-child{margin:0;color:var(--c-text-soft);font-size:.92rem}

.q-cash{text-align:center;padding:22px 20px;background:var(--c-bg);border:2px solid var(--c-text)}
.q-cash-head{font-family:var(--font-display);text-transform:uppercase;letter-spacing:.18em;
  font-size:.75rem;margin:0}
.q-cash-amount{font-family:var(--font-display);font-size:2.2rem;line-height:1;margin:.35em 0 .5em;
  font-variant-numeric:tabular-nums}
.q-cash p:last-child{margin:0;color:var(--c-text-soft);font-size:.9rem}

.q-foot{margin-top:28px;text-align:center;font-size:.88rem}
.q-foot p{margin:0 0 8px}
@media(max-width:520px){
  .q-card{padding:24px 18px}
  .q-lines{font-size:.88rem}
}

/* The crew prints their copy off this page. The shop's copy comes off the
   dashboard sheet, which is laid out for paper from the start. */
@media print{
  @page{size:letter;margin:.5in}
  .q-wrap{max-width:none;padding:0}
  .q-card{border:0;padding:0}
  .q-action{page-break-inside:avoid;break-inside:avoid}
}
`;
