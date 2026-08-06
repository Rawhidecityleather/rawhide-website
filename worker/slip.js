/**
 * Order packing slip — the sheet that goes in the box and doubles as the build
 * sheet on the bench.
 */

import { esc, money, shortDate } from './lib.js';

const SHOP_EMAIL = 'rawhidecityleather@gmail.com';
const SHOP_SITE = 'rawhidecityleather.com';

/**
 * `quote` is the custom-build quote this order came from, when it came from
 * one. It's what carries the tax-exemption paperwork — Snipcart only records
 * that no tax was charged, not why, and "why" is the part worth keeping.
 */
export function renderSlip(order, { quote = null } = {}) {
  const ship = order.shippingAddress || order.billingAddress || {};
  const items = order.items || [];

  return `<div class="wrap slip">
    <div class="toolbar">
      <button type="button" onclick="window.print()">Print</button>
      <a class="back" href="/dashboard">&larr; Dashboard</a>
    </div>

    <header class="head">
      <div class="brand">
        <img src="/assets/img/logo.png" alt="Rawhide City Leather" onerror="this.remove()">
        <p class="tagline">We do not cut corners. We cut leather.</p>
      </div>
      <div class="meta">
        <h1>Packing Slip</h1>
        <dl>
          <dt>Order</dt><dd class="strong">${esc(order.invoiceNumber || order.token)}</dd>
          <dt>Placed</dt><dd>${esc(shortDate(order.creationDate))}</dd>
          <dt>Status</dt><dd>${esc(order.status || '')}</dd>
        </dl>
      </div>
    </header>

    <section class="addresses">
      <div>
        <h2>Ship to</h2>
        ${renderAddress(ship)}
        ${order.email ? `<p class="soft">${esc(order.email)}</p>` : ''}
      </div>
      <div>
        <h2>From</h2>
        <p class="addr"><span class="strong">Rawhide City Leather</span><br>Lakeland, FL<br>${esc(SHOP_SITE)}<br>${esc(SHOP_EMAIL)}</p>
        ${order.trackingNumber ? `<p class="soft">Tracking ${esc(order.trackingNumber)}</p>` : ''}
      </div>
    </section>

    <section class="items">
      <h2>Build sheet</h2>
      ${items.map(renderItem).join('')}
    </section>

    ${renderTotals(order, quote)}
    ${renderNotes(order)}

    <footer class="foot">
      <span>Hand-cut and stamped in Lakeland, Florida.</span>
      <span>Questions: ${esc(SHOP_EMAIL)}</span>
    </footer>
  </div>`;
}

/**
 * Fields that get cut, stamped or painted into the leather — get these wrong
 * and the piece is scrap, so they print in a callout instead of the spec grid.
 * Deliberately narrow: must catch "Text on belt" and "Stamped text" without
 * catching "Text color", "Text outline color" or "Text paint color".
 */
const CRITICAL_FIELD = /stamp|^message$|^notes$|^patch details$|^text on /i;

/**
 * Shorter labels for the callout only. The field names customers pick at
 * checkout are untouched — this is purely what prints, so a long label
 * doesn't wrap to two lines beside its value.
 */
const CALLOUT_LABELS = { 'text / symbols to be stamped': 'Stamp text' };

function calloutLabel(name) {
  const key = String(name || '').trim().toLowerCase();
  return CALLOUT_LABELS[key] || name || '';
}

function renderItem(item) {
  const fields = (item.customFields || []).filter((f) => f && String(f.value || '').trim());
  const critical = fields.filter((f) => CRITICAL_FIELD.test(f.name || ''));
  const specs = fields.filter((f) => !CRITICAL_FIELD.test(f.name || ''));

  const callout = critical.map((f) => `<div class="callout-row">
      <span class="callout-label">${esc(calloutLabel(f.name))}</span>
      <span class="callout-value">${esc(String(f.value).trim()).replace(/\n/g, '<br>')}</span>
    </div>`).join('');

  const opts = specs.map((f) => {
    // Only genuinely long values get a full-width row. Matching on the field
    // name instead would hand a whole line to "Text paint color: White".
    const value = String(f.value).trim();
    const wide = value.length > 40 || value.includes('\n');
    return `<div class="opt${wide ? ' wide' : ''}">
      <dt>${esc(f.name || '')}</dt>
      <dd>${esc(value).replace(/\n/g, '<br>')}</dd>
    </div>`;
  }).join('');

  return `<article class="item">
    <div class="item-head">
      <span class="qty">${esc(String(item.quantity ?? 1))}&times;</span>
      <span class="item-name">${esc(item.name || '')}</span>
      <span class="item-price">${esc(money(item.totalPrice ?? item.price, null))}</span>
    </div>
    ${opts ? `<dl class="opts">${opts}</dl>` : ''}
    ${callout ? `<div class="callout">${callout}</div>` : ''}
    ${!opts && !callout ? '<p class="soft no-opts">No options selected.</p>' : ''}
  </article>`;
}

function renderAddress(a) {
  const lines = [
    a.fullName || a.name,
    a.company,
    a.address1,
    a.address2,
    [a.city, a.province, a.postalCode].filter(Boolean).join(', '),
    a.country && a.country.toUpperCase() !== 'US' ? a.country : null,
    a.phone,
  ].filter(Boolean);

  if (!lines.length) return '<p class="addr soft">No shipping address on file.</p>';
  return `<p class="addr"><span class="strong">${esc(lines[0])}</span>${
    lines.slice(1).map((l) => '<br>' + esc(l)).join('')
  }</p>`;
}

function renderTotals(order) {
  const cur = order.currency;

  // Field names verified against a live order (itemsTotal 200, savedAmount 40,
  // grandTotal 160). Two traps: Snipcart's `subtotal` is already discounted, so
  // using it hides the sale entirely; and discount rows carry `amountSaved`,
  // not `amount`.
  const items = order.itemsTotal ?? order.baseTotal ?? order.subtotal;
  const discount = order.savedAmount ?? order.totalDiscountAmount ??
    (order.discounts || []).reduce((sum, d) => sum + (d.amountSaved || 0), 0);
  const shipping = order.shippingFees ?? order.shippingInformation?.fees;
  const tax = order.taxesTotal ??
    (order.taxes || []).reduce((sum, t) => sum + (t.amount || 0), 0);

  const rows = [];
  if (typeof items === 'number') rows.push(['Subtotal', money(items, cur)]);
  if (discount) rows.push(['Discount', '-' + money(Math.abs(discount), cur)]);
  if (typeof shipping === 'number') rows.push(['Shipping', shipping ? money(shipping, cur) : 'Free']);
  // A zero tax row is normally noise, but on an exempt order it's the point —
  // print it so the slip says no tax was charged rather than staying silent.
  if (tax) rows.push(['Tax', money(tax, cur)]);
  else if (quote?.taxExempt) rows.push(['Tax', 'Exempt']);

  const total = order.grandTotal ?? order.total ?? order.finalGrandTotal ?? 0;

  return `<section class="totals">
    <table>
      ${rows.map(([label, v]) => `<tr><th>${label}</th><td>${esc(v)}</td></tr>`).join('')}
      <tr class="grand"><th>Total</th><td>${esc(money(total, cur))}</td></tr>
    </table>
    ${renderExemption(quote)}
  </section>`;
}

/**
 * The exemption on the face of the slip. This is the copy that goes in the box
 * and in the shop's file, so it names the entity and the certificate rather
 * than just asserting the order was exempt.
 */
function renderExemption(quote) {
  if (!quote?.taxExempt || !quote.exemption) return '';
  const { entity, certNumber, expires } = quote.exemption;

  return `<div class="exempt">
    <p class="exempt-head">Sales tax exempt</p>
    <p>${esc(entity)}<br>Certificate ${esc(certNumber)}${
      expires ? ` &middot; valid through ${esc(expires)}` : ''
    }</p>
    <p class="soft">Quote ${esc(quote.id)} &middot; certificate on file with the shop.</p>
  </div>`;
}

function renderNotes(order) {
  const orderFields = (order.customFields || []).filter((f) => f && String(f.value || '').trim());
  if (!order.notes && !orderFields.length) return '';

  return `<section class="notes">
    <h2>Order notes</h2>
    ${order.notes ? `<p>${esc(order.notes).replace(/\n/g, '<br>')}</p>` : ''}
    ${orderFields.map((f) =>
      `<p><span class="soft">${esc(f.name || '')}:</span> ${esc(String(f.value).trim())}</p>`
    ).join('')}
  </section>`;
}

export const SLIP_STYLES = `
:root{
  --ink:#0F0F0F; --soft:#6B6358; --line:rgba(15,15,15,.14);
  --line-faint:rgba(15,15,15,.08); --paper:#fff;
  --display:'Oswald','Arial Narrow',Haettenschweiler,sans-serif;
  --body:'Segoe UI',system-ui,-apple-system,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:#EBE8E1;color:var(--ink);font-family:var(--body);font-size:13px;line-height:1.45}
.wrap{max-width:7.5in;margin:0 auto;padding:28px 32px;background:var(--paper)}
h1,h2{font-family:var(--display);text-transform:uppercase;letter-spacing:.08em;margin:0}
h1{font-size:20px}
h2{font-size:11px;letter-spacing:.22em;color:var(--soft);margin:0 0 6px;padding-bottom:4px;border-bottom:1px solid var(--line-faint)}
.strong{font-weight:700}
.soft{color:var(--soft)}

.toolbar{margin-bottom:14px;display:flex;align-items:center;gap:16px}
.toolbar button{font-family:var(--display);text-transform:uppercase;letter-spacing:.18em;font-size:11px;
  padding:9px 22px;border:2px solid var(--ink);background:var(--ink);color:#EBE8E1;cursor:pointer;border-radius:2px}
.toolbar .back{font-family:var(--display);text-transform:uppercase;letter-spacing:.14em;font-size:10px;
  color:var(--soft);text-decoration:none}
.toolbar .back:hover{color:var(--ink)}

.head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
  padding-bottom:14px;border-bottom:2px solid var(--ink)}
.brand img{max-height:58px;width:auto;display:block}
.tagline{font-family:'Special Elite','Courier New',monospace;font-size:10px;color:var(--soft);margin:8px 0 0}
.meta{text-align:right;flex:0 0 auto}
.meta dl{display:grid;grid-template-columns:auto auto;gap:1px 10px;margin:8px 0 0;justify-content:end}
.meta dt{font-family:var(--display);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--soft)}
.meta dd{margin:0;text-align:right}

.addresses{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin:16px 0}
.addr{margin:0;line-height:1.5}

.items{margin-top:4px}
.item{border:1px solid var(--line);border-radius:2px;padding:9px 11px;margin-bottom:7px;page-break-inside:avoid;break-inside:avoid}
.item-head{display:flex;align-items:baseline;gap:9px;margin-bottom:6px;
  padding-bottom:5px;border-bottom:1px dashed var(--line-faint)}
.qty{font-family:var(--display);font-size:15px;font-weight:700}
.item-name{font-family:var(--display);font-size:14px;text-transform:uppercase;letter-spacing:.04em;flex:1}
.item-price{color:var(--soft)}

.opts{display:grid;grid-template-columns:1fr 1fr;gap:2px 22px;margin:0}
.opt{display:flex;gap:7px;align-items:baseline;min-width:0}
.opt.wide{grid-column:1 / -1}
.opt dt{flex:0 0 auto;color:var(--soft);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.opt dd{margin:0;font-weight:600;min-width:0;overflow-wrap:anywhere}
.no-opts{margin:0;font-style:italic}

/* Border + weight carry the emphasis, not colour — these print on B&W lasers. */
.callout{margin-top:8px;border:1.5px solid var(--ink);border-radius:2px;
  padding:7px 10px;background:rgba(15,15,15,.045)}
.callout-row{display:flex;gap:12px;align-items:baseline}
.callout-row + .callout-row{margin-top:5px;padding-top:5px;border-top:1px solid var(--line)}
.callout-label{font-family:var(--display);font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--soft);flex:0 0 1.1in;line-height:1.6}
.callout-value{font-size:14px;font-weight:700;line-height:1.3;overflow-wrap:anywhere}

/* Column, not row — the exemption block sits under the table and matches its
   right edge, so it reads as part of the money rather than a loose aside. */
.totals{display:flex;flex-direction:column;align-items:flex-end;margin-top:12px}
.totals table{border-collapse:collapse;min-width:2.3in}
.exempt{margin-top:10px;padding:8px 11px;border:1px solid var(--line);
  border-left:3px solid var(--ink);max-width:3.4in;page-break-inside:avoid;break-inside:avoid}
.exempt p{margin:0 0 3px;font-size:11.5px;line-height:1.45}
.exempt p:last-child{margin-bottom:0}
.exempt-head{font-family:var(--display);font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase}
.totals th{font-weight:400;color:var(--soft);text-align:left;padding:2px 18px 2px 0}
.totals td{text-align:right;padding:2px 0;font-variant-numeric:tabular-nums}
.totals .grand th,.totals .grand td{border-top:1px solid var(--ink);padding-top:5px;font-weight:700;
  font-size:15px;color:var(--ink);font-family:var(--display)}

.notes{margin-top:16px;page-break-inside:avoid;break-inside:avoid}
.notes p{margin:0 0 4px}

.foot{display:flex;justify-content:space-between;gap:16px;margin-top:22px;padding-top:8px;
  border-top:1px solid var(--line-faint);font-size:10px;color:var(--soft)}

.notice{padding:36px 0}
.notice p{color:var(--soft)}
code{font-family:'Courier New',monospace;background:rgba(15,15,15,.06);padding:1px 5px;border-radius:2px}

@media print{
  @page{size:letter;margin:.45in}
  body{background:#fff;font-size:11.5px}
  .wrap{max-width:none;margin:0;padding:0}
  .toolbar{display:none}
  .item{border-color:rgba(0,0,0,.25)}
}
`;
