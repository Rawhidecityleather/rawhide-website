/**
 * The printable quote — the sheet that gets handed across the counter.
 *
 * A card quote settles itself: the crew opens the link, pays, and a normal
 * order lands with a packing slip behind it. A cash job has none of that. The
 * money changes hands at the bench, so this sheet is the whole paper trail —
 * what was agreed, what it comes to, and a line for who took the money.
 *
 * It borrows the packing slip's stylesheet on purpose. Same shop, same paper,
 * same laser printer, and nothing here is a shape the slip didn't already have.
 */

import { esc, money, shortDate } from './lib.js';
import { quotePayment, quoteGrandTotal, FREE_SHIPPING_OVER } from './quote.js';

const SHOP_EMAIL = 'rawhidecityleather@gmail.com';
const SHOP_SITE = 'rawhidecityleather.com';

/**
 * `origin` is the dashboard's own origin — a card quote's sheet prints the pay
 * link, and a relative path is no use to somebody holding a piece of paper.
 */
export function renderQuoteSheet(quote, { status, origin = '' } = {}) {
  const cash = quotePayment(quote) === 'cash';
  const grandTotal = quoteGrandTotal(quote);
  const paid = status === 'paid';

  // What the sheet is called depends on what it's for. A cash job is being
  // billed, not quoted at — by the time this prints, the price is settled.
  const heading = paid ? 'Receipt' : cash ? 'Invoice' : 'Quote';

  return `<div class="wrap slip">
    <div class="toolbar">
      <button type="button" onclick="window.print()">Print</button>
      <a class="back" href="/dashboard#quotes">&larr; Dashboard</a>
    </div>

    <header class="head">
      <div class="brand">
        <img src="/assets/img/logo.png" alt="Rawhide City Leather" onerror="this.remove()">
        <p class="tagline">We do not cut corners. We cut leather.</p>
      </div>
      <div class="meta">
        <h1>${esc(heading)}</h1>
        <dl>
          <dt>Number</dt><dd class="strong">${esc(quote.id)}</dd>
          <dt>Issued</dt><dd>${esc(shortDate(quote.createdAt))}</dd>
          ${paid
            ? `<dt>Paid</dt><dd>${esc(shortDate(quote.paidAt))}</dd>`
            : `<dt>Good through</dt><dd>${esc(shortDate(quote.expiresAt))}</dd>`}
          <dt>Payment</dt><dd>${cash ? 'Cash or check' : 'Card'}</dd>
        </dl>
      </div>
    </header>

    ${status === 'void' || status === 'expired' ? `<p class="qs-dead">
      This ${cash ? 'invoice' : 'quote'} is ${status === 'void' ? 'withdrawn' : 'past its date'}
      &mdash; the online link no longer works.
    </p>` : ''}

    <section class="addresses">
      <div>
        <h2>Billed to</h2>
        <p class="addr"><span class="strong">${esc(quote.customer)}</span>${
          quote.department ? '<br>' + esc(quote.department) : ''
        }${quote.email ? '<br>' + esc(quote.email) : ''}</p>
      </div>
      <div>
        <h2>From</h2>
        <p class="addr"><span class="strong">Rawhide City Leather</span><br>Lakeland, FL<br>${
          esc(SHOP_SITE)}<br>${esc(SHOP_EMAIL)}</p>
      </div>
    </section>

    <section class="qs-work">
      <h2>${esc(quote.title)}</h2>
      <table class="qs-lines">
        <thead><tr>
          <th>Line item</th><th class="qs-num">Qty</th>
          <th class="qs-num">Each</th><th class="qs-num">Total</th>
        </tr></thead>
        <tbody>${quote.lines.map((line) => `<tr>
          <td>${esc(line.description)}</td>
          <td class="qs-num">${esc(String(line.quantity))}</td>
          <td class="qs-num">${esc(money(line.unitPrice, 'usd'))}</td>
          <td class="qs-num strong">${esc(money(line.lineTotal, 'usd'))}</td>
        </tr>`).join('')}</tbody>
      </table>
    </section>

    ${renderTotals(quote, grandTotal, cash)}
    ${quote.notes ? `<section class="notes">
      <h2>Build notes</h2>
      <p>${esc(quote.notes).replace(/\n/g, '<br>')}</p>
    </section>` : ''}

    ${renderPayment(quote, { cash, paid, grandTotal, origin })}

    <footer class="foot">
      <span>Radio straps 6 weeks &middot; belts, bands, straps and hats 1&ndash;3 weeks.</span>
      <span>${esc(SHOP_EMAIL)}</span>
    </footer>
  </div>`;
}

function renderTotals(quote, grandTotal, cash) {
  const rows = [];

  if (quote.taxExempt) {
    rows.push(['Subtotal', money(quote.total, 'usd')]);
    rows.push(['Sales tax', 'Exempt']);
  } else if (quote.taxAmount) {
    rows.push(['Subtotal', money(quote.total, 'usd')]);
    rows.push([`Sales tax (${quote.taxRatePercent}%)`, money(quote.taxAmount, 'usd')]);
  } else if (!cash) {
    // Card quotes hand tax to checkout, so the sheet can't print a figure —
    // say that plainly rather than printing a total that grows at payment.
    rows.push(['Sales tax', 'Added at checkout']);
  }

  // Same reason: checkout adds the shipping, and a sheet that stays silent
  // about it reads as a total that turned out to be wrong. A cash job is
  // handed over at the bench, so there's nothing to say.
  if (!cash) {
    rows.push(['Shipping',
      quote.total >= FREE_SHIPPING_OVER ? 'Free' : '$10.00 at checkout']);
  }

  return `<section class="totals">
    <table>
      ${rows.map(([label, value]) =>
        `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join('')}
      <tr class="grand"><th>${cash ? 'Total' : 'Quote total'}</th>
        <td>${esc(money(grandTotal, 'usd'))}</td></tr>
    </table>
    ${renderExemption(quote)}
  </section>`;
}

/**
 * The exemption, named on the face of the sheet. Same copy as the packing
 * slip: an audit wants the entity and the certificate, not an assertion that
 * no tax was charged.
 */
function renderExemption(quote) {
  if (!quote.taxExempt || !quote.exemption) return '';
  const { entity, certNumber, expires } = quote.exemption;

  return `<div class="exempt">
    <p class="exempt-head">Sales tax exempt</p>
    <p>${esc(entity)}<br>Certificate ${esc(certNumber)}${
      expires ? ` &middot; valid through ${esc(expires)}` : ''
    }</p>
    <p class="soft">Certificate on file with the shop.</p>
  </div>`;
}

/**
 * The bottom of the sheet, and the only part that differs by much between a
 * cash job and a card one. Cash gets the sign-off block: the shop's copy of
 * who took the money, when, and in what.
 */
function renderPayment(quote, { cash, paid, grandTotal, origin }) {
  if (paid) {
    const how = quote.paidMethod === 'check' ? 'by check'
      : quote.paidMethod === 'cash' ? 'in cash'
      : 'by card';
    return `<section class="qs-pay paid">
      <p class="qs-pay-head">Paid in full</p>
      <p class="qs-amount">${esc(money(grandTotal, 'usd'))}</p>
      <p class="soft">Received ${esc(how)} on ${esc(shortDate(quote.paidAt))}${
        quote.paidOrder ? ` &middot; order ${esc(quote.paidOrder)}` : ''
      }.</p>
    </section>`;
  }

  if (!cash) {
    return `<section class="qs-pay">
      <p class="qs-pay-head">Pay online</p>
      <p class="qs-amount">${esc(money(grandTotal, 'usd'))}</p>
      <p class="qs-link">${esc(origin)}/quote/${esc(quote.id)}</p>
      <p class="soft">Card checkout. Link works through ${esc(shortDate(quote.expiresAt))}.</p>
    </section>`;
  }

  return `<section class="qs-pay">
    <p class="qs-pay-head">Due on pickup &mdash; cash or check</p>
    <p class="qs-amount">${esc(money(grandTotal, 'usd'))}</p>
    <p class="soft">Checks made out to Rawhide City Leather.</p>
    <div class="qs-sign">
      <div class="qs-boxes">
        <span class="qs-box">Cash</span>
        <span class="qs-box">Check no. <span class="qs-fill"></span></span>
      </div>
      <div class="qs-rule"><span class="qs-rule-label">Received by</span></div>
      <div class="qs-rule"><span class="qs-rule-label">Date</span></div>
    </div>
  </section>`;
}

/** Rides on top of SLIP_STYLES — only the shapes the packing slip didn't have. */
export const QUOTE_SHEET_STYLES = `
.qs-dead{margin:12px 0 0;padding:8px 11px;border:1px solid var(--line);
  border-left:3px solid var(--ink);font-size:11.5px}

.qs-work{margin-top:4px}
.qs-work h2{font-family:var(--display);font-size:14px;letter-spacing:.06em;color:var(--ink);
  text-transform:uppercase;border-bottom:1px solid var(--line);padding-bottom:5px;margin-bottom:8px}
.qs-lines{width:100%;border-collapse:collapse;font-size:12.5px}
.qs-lines th{font-family:var(--display);text-transform:uppercase;letter-spacing:.16em;
  font-size:9.5px;color:var(--soft);text-align:left;padding:0 0 5px;border-bottom:1px solid var(--line-faint)}
.qs-lines td{padding:7px 0;border-bottom:1px solid var(--line-faint);vertical-align:top}
.qs-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:16px}

/* Border and weight carry it, not colour — these print on a B&W laser. */
.qs-pay{margin-top:16px;padding:12px 14px;border:2px solid var(--ink);
  page-break-inside:avoid;break-inside:avoid}
.qs-pay.paid{border-width:1px;background:rgba(15,15,15,.045)}
.qs-pay p{margin:0}
.qs-pay-head{font-family:var(--display);text-transform:uppercase;letter-spacing:.16em;font-size:10px}
.qs-amount{font-family:var(--display);font-size:22px;line-height:1.1;margin:4px 0 3px;
  font-variant-numeric:tabular-nums}
.qs-link{font-family:'Courier New',monospace;font-size:11.5px;margin:4px 0 3px;overflow-wrap:anywhere}

.qs-sign{display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px 22px;margin-top:14px}
.qs-boxes{display:flex;gap:16px;font-size:11.5px}
/* An empty square to tick, drawn in CSS so nothing depends on a glyph the
   printer may not have. */
.qs-box{display:inline-flex;align-items:center;gap:6px}
.qs-box::before{content:'';width:11px;height:11px;border:1px solid var(--ink);flex:0 0 auto}
.qs-fill{display:inline-block;min-width:.9in;border-bottom:1px solid var(--ink)}
.qs-rule{flex:1 1 1.8in;border-bottom:1px solid var(--ink);padding-bottom:16px}
.qs-rule-label{font-family:var(--display);text-transform:uppercase;letter-spacing:.14em;
  font-size:9px;color:var(--soft)}

@media print{
  .qs-pay{border-color:#000}
}
`;
