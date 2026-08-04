/**
 * Rawhide City Leather — order packing slips.
 *
 * Static assets are served before this Worker runs, so the only requests that
 * reach us are paths with no matching file. We handle /packing-slip and hand
 * everything else back to the asset router, which applies the 404 page.
 *
 * Secrets (set with `wrangler secret put NAME`):
 *   SNIPCART_SECRET — Snipcart secret API key. Reads every order, never ships
 *                     to the browser.
 *   SLIP_USER       — username for the browser login prompt
 *   SLIP_PASS       — password for the browser login prompt
 */

const SNIPCART_API = 'https://app.snipcart.com/api';
const SHOP_EMAIL = 'rawhidecityleather@gmail.com';
const SHOP_SITE = 'rawhidecityleather.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.replace(/\/+$/, '') === '/packing-slip') {
      return handleSlip(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------------------------------------------------------------- routing */

async function handleSlip(request, env, url) {
  if (!authorized(request, env)) return unauthorized();

  if (!env.SNIPCART_SECRET) {
    return page('Not configured', notice(
      'SNIPCART_SECRET is not set.',
      'Run <code>wrangler secret put SNIPCART_SECRET</code> in the site repo, then redeploy.'
    ), 500);
  }

  const token = url.searchParams.get('token');

  try {
    if (!token) {
      const list = await snipcart(env, '/orders?limit=30');
      return page('Recent orders', renderList(list));
    }

    const order = await snipcart(env, '/orders/' + encodeURIComponent(token));

    // ?raw=1 dumps the untouched API response, for checking field names.
    if (url.searchParams.get('raw')) {
      return new Response(JSON.stringify(order, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    return page(`Order ${order.invoiceNumber || ''}`.trim(), renderSlip(order));
  } catch (err) {
    const missing = /\b404\b/.test(err.message);
    return page(
      missing ? 'Order not found' : 'Snipcart error',
      notice(
        missing ? 'No order with that token.' : 'Could not reach Snipcart.',
        esc(err.message)
      ),
      missing ? 404 : 502
    );
  }
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

/* --------------------------------------------------------------- snipcart */

async function snipcart(env, path) {
  const res = await fetch(SNIPCART_API + path, {
    headers: {
      // HTTP Basic: secret key as the username, empty password.
      Authorization: 'Basic ' + btoa(env.SNIPCART_SECRET + ':'),
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Snipcart returned ${res.status} ${res.statusText}`);
  return res.json();
}

/* -------------------------------------------------------------- rendering */

function renderList(list) {
  const orders = list.items || [];
  if (!orders.length) return notice('No orders yet.', '');

  const rows = orders.map((o) => {
    const ship = o.shippingAddress || o.billingAddress || {};
    return `<tr>
      <td><a href="/packing-slip?token=${esc(o.token)}">${esc(o.invoiceNumber || o.token)}</a></td>
      <td>${esc(shortDate(o.creationDate))}</td>
      <td>${esc(ship.fullName || ship.name || o.email || '')}</td>
      <td class="num">${esc(money(grandTotal(o), o.currency))}</td>
      <td><span class="status">${esc(o.status || '')}</span></td>
    </tr>`;
  }).join('');

  return `<div class="wrap list">
    <h1>Recent orders</h1>
    <table class="orders">
      <thead><tr><th>Order</th><th>Date</th><th>Name</th><th class="num">Total</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderSlip(order) {
  const ship = order.shippingAddress || order.billingAddress || {};
  const items = order.items || [];

  return `<div class="wrap slip">
    <div class="toolbar"><button type="button" onclick="window.print()">Print</button></div>

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

    ${renderTotals(order)}
    ${renderNotes(order)}

    <footer class="foot">
      <span>Hand-cut and stamped in Lakeland, Florida.</span>
      <span>Questions: ${esc(SHOP_EMAIL)}</span>
    </footer>
  </div>`;
}

function renderItem(item) {
  const fields = (item.customFields || []).filter((f) => f && String(f.value || '').trim());

  const opts = fields.map((f) => {
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
    ${opts ? `<dl class="opts">${opts}</dl>` : '<p class="soft no-opts">No options selected.</p>'}
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
  if (tax) rows.push(['Tax', money(tax, cur)]);

  return `<section class="totals">
    <table>
      ${rows.map(([label, v]) => `<tr><th>${label}</th><td>${esc(v)}</td></tr>`).join('')}
      <tr class="grand"><th>Total</th><td>${esc(money(grandTotal(order), cur))}</td></tr>
    </table>
  </section>`;
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

function notice(title, body) {
  return `<div class="wrap"><div class="notice"><h1>${esc(title)}</h1><p>${body}</p></div></div>`;
}

/* ----------------------------------------------------------------- helpers */

function grandTotal(order) {
  return order.grandTotal ?? order.total ?? order.finalGrandTotal ?? 0;
}

function money(value, currency) {
  if (typeof value !== 'number') return '';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format(value);
  } catch {
    return '$' + value.toFixed(2);
  }
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Rawhide City Leather</title>
<style>${STYLES}</style>
</head>
<body>${body}</body>
</html>`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

function html(body) {
  return page('Packing slip', body);
}

// Exported so the layout can be previewed against a fixture without a live key.
export { renderSlip, renderList, page };

/* ------------------------------------------------------------------ styles */

const STYLES = `
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

.toolbar{margin-bottom:14px}
.toolbar button{font-family:var(--display);text-transform:uppercase;letter-spacing:.18em;font-size:11px;
  padding:9px 22px;border:2px solid var(--ink);background:var(--ink);color:#EBE8E1;cursor:pointer;border-radius:2px}

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

.totals{display:flex;justify-content:flex-end;margin-top:12px}
.totals table{border-collapse:collapse;min-width:2.3in}
.totals th{font-weight:400;color:var(--soft);text-align:left;padding:2px 18px 2px 0}
.totals td{text-align:right;padding:2px 0;font-variant-numeric:tabular-nums}
.totals .grand th,.totals .grand td{border-top:1px solid var(--ink);padding-top:5px;font-weight:700;
  font-size:15px;color:var(--ink);font-family:var(--display)}

.notes{margin-top:16px;page-break-inside:avoid;break-inside:avoid}
.notes p{margin:0 0 4px}

.foot{display:flex;justify-content:space-between;gap:16px;margin-top:22px;padding-top:8px;
  border-top:1px solid var(--line-faint);font-size:10px;color:var(--soft)}

.orders{width:100%;border-collapse:collapse;margin-top:14px}
.orders th,.orders td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line-faint)}
.orders thead th{font-family:var(--display);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--soft)}
.orders .num{text-align:right;font-variant-numeric:tabular-nums}
.orders a{color:var(--ink);font-weight:700}
.status{font-family:var(--display);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--soft)}

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
