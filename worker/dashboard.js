/**
 * Order dashboard — what came in, what it's worth, and what still has to go out
 * the door.
 *
 * Everything is server-rendered from one pass over the Snipcart order list. The
 * only client-side JavaScript handles selection, the Pirate Ship export, and
 * posting tracking numbers back.
 */

import {
  esc, money, moneyShort, tinyDate, shortDate, daysSince, daysUntil,
  orderShipBy, monthKey, monthLabel,
} from './lib.js';
import {
  isCancelled, isShipped, needsShipping, netRevenue, grandTotal,
  countsAsSale, refundState,
} from './snipcart.js';
import { orderWeightOunces, PIRATE_SHIP_URL } from './pirateship.js';
import { quoteStatus, quoteWarnings, findQuoteOrder, CHECKOUT_DISCOUNT } from './quote.js';

const RANGES = [
  { key: '30d', label: 'Last 30 days', compare: 'vs prior 30 days' },
  { key: 'month', label: 'This month', compare: 'vs last month, same days in' },
  { key: 'year', label: 'This year', compare: 'vs last year, same days in' },
  { key: 'all', label: 'All time', compare: '' },
];

export const DEFAULT_RANGE = '30d';

function rangeInfo(key) {
  return RANGES.find((r) => r.key === key) || RANGES[0];
}

/* ------------------------------------------------------------- analytics */

/**
 * The window to report on, plus the window to compare it against.
 *
 * Calendar ranges compare against the same slice of the previous calendar
 * period, not against the equal-length span immediately before. On the 4th of
 * the month "this month" has to be measured against the first four days of last
 * month — measuring it against the last four days of last month reads as a
 * collapse every time a month turns over.
 */
function rangeBounds(key) {
  const now = new Date();
  const end = now.getTime();

  if (key === 'month') {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const prevStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    return { start, end, prevStart, prevEnd: prevStart + (end - start) };
  }
  if (key === 'year') {
    const start = Date.UTC(now.getUTCFullYear(), 0, 1);
    const prevStart = Date.UTC(now.getUTCFullYear() - 1, 0, 1);
    return { start, end, prevStart, prevEnd: prevStart + (end - start) };
  }
  if (key === 'all') {
    return { start: 0, end, prevStart: null, prevEnd: null };
  }
  const span = 30 * 86400000;
  const start = end - span;
  return { start, end, prevStart: start - span, prevEnd: start };
}

function placedAt(order) {
  const d = new Date(order.creationDate);
  return isNaN(d) ? 0 : d.getTime();
}

export function analyze(orders, requestedRange) {
  // An unknown ?range= falls back rather than rendering a window nothing labels.
  const rangeKey = RANGES.some((r) => r.key === requestedRange) ? requestedRange : DEFAULT_RANGE;
  const sorted = [...orders].sort((a, b) => placedAt(b) - placedAt(a));
  const { start, end, prevStart, prevEnd } = rangeBounds(rangeKey);

  const inRange = sorted.filter((o) => {
    const t = placedAt(o);
    return t >= start && t <= end;
  });

  const comparable = prevStart !== null;
  const previous = comparable
    ? sorted.filter((o) => {
        const t = placedAt(o);
        return t >= prevStart && t < prevEnd;
      })
    : [];

  const revenue = sum(inRange, netRevenue);
  const paidCount = inRange.filter(countsAsSale).length;

  // The queue is the one list that isn't newest-first: it's work to be done,
  // so it runs most-overdue down to furthest-out. An order with nothing to date
  // it — no items, or a creation date Snipcart mangled — sorts to the bottom
  // rather than pretending to be due today.
  const queue = sorted.filter(needsShipping).sort((a, b) => {
    const da = orderShipBy(a);
    const db = orderShipBy(b);
    if (!da || !db) return (da ? 0 : 1) - (db ? 0 : 1);
    // Same deadline: the one that's been waiting longer goes first.
    return da.getTime() - db.getTime() || placedAt(a) - placedAt(b);
  });
  const oldestQueued = queue.length
    ? Math.max(...queue.map((o) => daysSince(o.creationDate) ?? 0))
    : 0;

  return {
    rangeKey,
    orders: sorted,
    inRange,
    queue,
    oldestQueued,
    revenue,
    paidCount,
    avgOrder: paidCount ? revenue / paidCount : 0,
    lifetime: sum(sorted, netRevenue),
    lifetimeCount: sorted.filter(countsAsSale).length,
    prevRevenue: comparable ? sum(previous, netRevenue) : null,
    prevCount: comparable ? previous.filter(countsAsSale).length : null,
    months: monthSeries(sorted, 12),
    products: topProducts(inRange),
    refunded: sum(inRange, (o) => Number(o.refundsAmount) || 0),
    refundedCount: inRange.filter((o) => refundState(o) !== 'none').length,
  };
}

function sum(list, fn) {
  return list.reduce((total, item) => total + (fn(item) || 0), 0);
}

/** Net revenue per month for the last `count` months, oldest first. */
function monthSeries(orders, count) {
  const now = new Date();
  const buckets = new Map();

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.set(
      d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'),
      { revenue: 0, orders: 0 }
    );
  }

  for (const order of orders) {
    const bucket = buckets.get(monthKey(order.creationDate));
    if (!bucket) continue;
    bucket.revenue += netRevenue(order);
    if (countsAsSale(order)) bucket.orders += 1;
  }

  return [...buckets.entries()].map(([key, value]) => ({ key, ...value }));
}

function topProducts(orders) {
  const totals = new Map();

  for (const order of orders) {
    if (!countsAsSale(order)) continue;
    for (const item of order.items || []) {
      const name = item.name || item.id || 'Custom build';
      const row = totals.get(name) || { name, units: 0, revenue: 0 };
      row.units += Number(item.quantity) || 1;
      row.revenue += Number(item.totalPrice ?? item.price ?? 0) || 0;
      totals.set(name, row);
    }
  }

  return [...totals.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8);
}

/* --------------------------------------------------------------- rendering */

export function renderDashboard(stats, { truncated, quotes = [] } = {}) {
  const rangeLabel = rangeInfo(stats.rangeKey).label;

  return `<div class="shell">
  ${renderRail(stats, quotes)}
  <main class="main">
    ${renderTopbar(stats, rangeLabel)}
    <div class="pad">
      ${truncated ? banner('Showing the most recent 2,000 orders. Lifetime totals above that are not counted.') : ''}
      ${renderKpis(stats, rangeLabel)}
      <div class="split">
        ${renderChart(stats.months)}
        ${renderProducts(stats.products, rangeLabel)}
      </div>
      ${renderQueue(stats.queue)}
      ${renderTrackingPanel()}
      ${renderQuotes(quotes, stats.orders)}
      ${renderOrders(stats.inRange, rangeLabel)}
    </div>
  </main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`;
}

function renderRail(stats, quotes = []) {
  const link = (href, label, badge) =>
    `<a href="${href}">${esc(label)}${
      badge ? `<span class="railbadge">${esc(String(badge))}</span>` : ''
    }</a>`;

  const openQuotes = quotes.filter((q) => quoteStatus(q, stats.orders) === 'open').length;

  return `<aside class="rail">
    <div class="railtop">
      <img src="/assets/img/logo.png" alt="Rawhide City Leather" onerror="this.remove()">
      <p class="railname">Rawhide City<br>Leather</p>
    </div>
    <nav class="railnav">
      ${link('#overview', 'Overview')}
      ${link('#queue', 'Ship queue', stats.queue.length || null)}
      ${link('#tracking', 'Add tracking')}
      ${link('#quotes', 'Quotes', openQuotes || null)}
      ${link('#orders', 'All orders')}
    </nav>
    <div class="railfoot">
      <a href="${PIRATE_SHIP_URL}" target="_blank" rel="noopener noreferrer">Pirate Ship &nearr;</a>
      <a href="https://app.snipcart.com/dashboard" target="_blank" rel="noopener noreferrer">Snipcart &nearr;</a>
      <a href="/" target="_blank" rel="noopener noreferrer">Storefront &nearr;</a>
    </div>
  </aside>`;
}

function renderTopbar(stats, rangeLabel) {
  const options = RANGES.map((r) =>
    `<a class="chip${r.key === stats.rangeKey ? ' on' : ''}" href="?range=${r.key}">${esc(r.label)}</a>`
  ).join('');

  return `<header class="topbar">
    <div class="topleft">
      <h1>Orders</h1>
      <p class="sub">${esc(rangeLabel)} &middot; synced ${esc(clockTime())}</p>
    </div>
    <div class="topright">
      <div class="chips">${options}</div>
      <button type="button" class="btn ghost" onclick="location.reload()">Refresh</button>
    </div>
  </header>`;
}

function clockTime() {
  return new Date().toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
  });
}

function renderKpis(stats, rangeLabel) {
  const compare = rangeInfo(stats.rangeKey).compare;
  const revenueDelta = delta(stats.revenue, stats.prevRevenue);
  const countDelta = delta(stats.paidCount, stats.prevCount);

  const tiles = [
    {
      label: 'Net revenue',
      // Refunds are already out of this number; say so rather than leaving him
      // to wonder why it trails what Stripe deposited.
      note: stats.refunded
        ? `after ${money(stats.refunded, 'usd')} refunded`
        : (revenueDelta ? compare : rangeLabel),
      value: moneyShort(stats.revenue),
      exact: money(stats.revenue, 'usd'),
      delta: revenueDelta,
    },
    {
      label: 'Orders',
      note: countDelta ? compare : rangeLabel,
      value: String(stats.paidCount),
      delta: countDelta,
    },
    {
      label: 'Average order',
      note: rangeLabel,
      value: moneyShort(stats.avgOrder),
      exact: money(stats.avgOrder, 'usd'),
    },
    {
      label: 'Awaiting shipment',
      note: stats.queue.length
        ? `oldest ${stats.oldestQueued} day${stats.oldestQueued === 1 ? '' : 's'} in`
        : 'nothing waiting',
      value: String(stats.queue.length),
      flag: stats.queue.length > 0,
    },
    {
      label: 'Lifetime revenue',
      note: `${stats.lifetimeCount} paid order${stats.lifetimeCount === 1 ? '' : 's'}`,
      value: moneyShort(stats.lifetime),
      exact: money(stats.lifetime, 'usd'),
      wide: true,
    },
  ];

  return `<section id="overview" class="kpis">
    ${tiles.map((t) => `<article class="kpi${t.wide ? ' accent' : ''}">
      <p class="kpilabel">${esc(t.label)}</p>
      <p class="kpivalue"${t.exact ? ` title="${esc(t.exact)}"` : ''}>${esc(t.value)}</p>
      <p class="kpinote${t.flag ? ' flag' : ''}">${t.delta || ''}${esc(t.note)}</p>
    </article>`).join('')}
  </section>`;
}

/** Trend pill against the previous window. Null previous means no basis. */
function delta(current, previous) {
  if (previous === null || previous === undefined) return '';
  if (!previous) {
    return current ? '<span class="delta up">new</span>' : '';
  }
  const change = Math.round(((current - previous) / previous) * 100);
  if (!change) return '<span class="delta flat">flat</span>';
  const dir = change > 0 ? 'up' : 'down';
  const arrow = change > 0 ? '&uarr;' : '&darr;';
  return `<span class="delta ${dir}">${arrow} ${Math.abs(change)}%</span>`;
}

/**
 * Twelve-month revenue bars. Hand-rolled SVG — no chart library reaches the
 * Worker, and this has to render the same in print and on a phone.
 */
function renderChart(months) {
  const peak = Math.max(...months.map((m) => m.revenue), 0);

  if (!peak) {
    return `<section class="card chart">
      <div class="cardhead"><h2>Revenue by month</h2></div>
      <p class="empty">No paid orders in the last 12 months.</p>
    </section>`;
  }

  const top = niceMax(peak);
  const W = 760, H = 240, L = 52, R = 12, T = 16, B = 34;
  const plotW = W - L - R, plotH = H - T - B;
  const slot = plotW / months.length;
  const barW = Math.min(38, slot * 0.56);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = T + plotH - plotH * f;
    return `<line class="grid" x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}"/>
      <text class="axis" x="${L - 10}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(moneyShort(top * f))}</text>`;
  }).join('');

  const bars = months.map((m, i) => {
    const h = (m.revenue / top) * plotH;
    const x = L + slot * i + (slot - barW) / 2;
    const y = T + plotH - h;
    const isLast = i === months.length - 1;
    const title = `${monthLabel(m.key)} ${m.key.slice(0, 4)} — ${money(m.revenue, 'usd')}, ${m.orders} order${m.orders === 1 ? '' : 's'}`;

    return `<g class="bargroup"><title>${esc(title)}</title>
      <rect class="bar${isLast ? ' current' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
        width="${barW.toFixed(1)}" height="${Math.max(h, m.revenue ? 2 : 0).toFixed(1)}" rx="1"/>
      <text class="mon" x="${(x + barW / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle">${esc(monthLabel(m.key))}</text>
    </g>`;
  }).join('');

  return `<section class="card chart">
    <div class="cardhead">
      <h2>Revenue by month</h2>
      <span class="cardnote">last 12 months, net of refunds</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net revenue by month, last 12 months" preserveAspectRatio="none">
      ${grid}
      <line class="grid strong" x1="${L}" y1="${T + plotH}" x2="${W - R}" y2="${T + plotH}"/>
      ${bars}
    </svg>
  </section>`;
}

/** Rounds an axis top up to 1/2/2.5/5 × a power of ten so labels read clean. */
function niceMax(value) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= magnitude * step) return magnitude * step;
  }
  return magnitude * 10;
}

function renderProducts(products, rangeLabel) {
  if (!products.length) {
    return `<section class="card">
      <div class="cardhead"><h2>Top products</h2></div>
      <p class="empty">Nothing sold in this window.</p>
    </section>`;
  }

  const peak = products[0].revenue || 1;

  return `<section class="card">
    <div class="cardhead">
      <h2>Top products</h2>
      <span class="cardnote">${esc(rangeLabel.toLowerCase())}</span>
    </div>
    <table class="mini">
      <tbody>
        ${products.map((p) => `<tr>
          <td class="pname">
            <span>${esc(p.name)}</span>
            <span class="track"><span class="fill" style="width:${((p.revenue / peak) * 100).toFixed(1)}%"></span></span>
          </td>
          <td class="num soft">${esc(String(p.units))}</td>
          <td class="num strong">${esc(moneyShort(p.revenue))}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </section>`;
}

function renderQueue(queue) {
  if (!queue.length) {
    return `<section id="queue" class="card">
      <div class="cardhead"><h2>Ship queue</h2></div>
      <p class="empty">Nothing waiting. Every paid order is out the door.</p>
    </section>`;
  }

  const rows = queue.map((order) => {
    const a = order.shippingAddress || order.billingAddress || {};
    const items = (order.items || [])
      .map((i) => `${i.quantity || 1}&times; ${esc(i.name || '')}`)
      .join('<br>');

    return `<tr data-token="${esc(order.token)}">
      <td class="pick"><input type="checkbox" class="sel" value="${esc(order.token)}"
        aria-label="Select order ${esc(order.invoiceNumber || order.token)}"></td>
      <td><a class="mono" href="/packing-slip?token=${esc(order.token)}">${esc(order.invoiceNumber || order.token)}</a></td>
      <td class="nowrap">${esc(tinyDate(order.creationDate))}</td>
      <td class="nowrap">${renderDue(order)}</td>
      <td>${esc(a.fullName || a.name || order.email || '')}
        <span class="soft block">${esc([a.city, a.province].filter(Boolean).join(', '))}</span></td>
      <td class="items">${items}</td>
      <td class="num soft nowrap">${esc(String(orderWeightOunces(order)))} oz</td>
      <td class="num strong">${esc(money(grandTotal(order), order.currency))}</td>
      <td class="shipcell">
        <form class="shipform">
          <input type="text" name="tracking" placeholder="Tracking number"
            autocomplete="off" spellcheck="false" inputmode="numeric">
          <button type="submit" class="btn tiny">Ship</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  return `<section id="queue" class="card">
    <div class="cardhead">
      <h2>Ship queue</h2>
      <span class="cardnote">${queue.length} paid order${queue.length === 1 ? '' : 's'} waiting
        &middot; soonest deadline first</span>
    </div>

    <div class="bulkbar">
      <label class="allbox"><input type="checkbox" id="selall"> Select all</label>
      <span class="selcount" id="selcount">0 selected</span>
      <span class="spacer"></span>
      <button type="button" class="btn" id="csvbtn" disabled>Download Pirate Ship CSV</button>
      <a class="btn ghost" href="${PIRATE_SHIP_URL}" target="_blank" rel="noopener noreferrer">Open Pirate Ship &nearr;</a>
    </div>
    <p class="hint">
      Pick the orders, download the CSV, then upload it on Pirate Ship's spreadsheet
      screen to batch the labels. Map the columns once on the first upload. Weights
      are estimates &mdash; check them against a scale.
    </p>

    <div class="scroll">
      <table class="grid">
        <thead><tr>
          <th class="pick"></th><th>Order</th><th>Placed</th><th>Ship by</th><th>Customer</th>
          <th>Items</th><th class="num">Weight</th><th class="num">Total</th><th>Tracking</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

/**
 * The queue's deadline cell. The badge is the whole point — the date alone
 * makes you do arithmetic, and the number of days left is what decides which
 * order goes on the bench next.
 */
function renderDue(order) {
  const due = orderShipBy(order);
  if (!due) return '<span class="soft">&mdash;</span>';

  const left = daysUntil(due);
  const badge = left < 0 ? [`${Math.abs(left)}d late`, 'hot']
    : left === 0 ? ['today', 'hot']
    : [`${left}d`, left <= 7 ? 'soon' : ''];

  return `${esc(tinyDate(due))}
    <span class="due${badge[1] ? ' ' + badge[1] : ''}">${esc(badge[0])}</span>`;
}

function renderTrackingPanel() {
  return `<section id="tracking" class="card">
    <div class="cardhead">
      <h2>Add tracking in bulk</h2>
      <span class="cardnote">marks each order shipped and emails the customer</span>
    </div>
    <p class="hint">
      Paste Pirate Ship's shipment list straight in &mdash; or type one order and
      tracking number per line. Each match gets its tracking number saved, flips to
      <strong>Shipped</strong>, and Snipcart sends the customer the tracking email.
    </p>
    <textarea id="pastebox" rows="6" spellcheck="false"
      placeholder="1042, 9400111899223197428374&#10;1043, 9400111899223197428381"></textarea>
    <div class="panelfoot">
      <button type="button" class="btn" id="pastebtn">Match &amp; mark shipped</button>
      <span class="soft" id="pastenote"></span>
    </div>
    <div id="pasteresult"></div>
  </section>`;
}

/* ------------------------------------------------------------------ quotes */

const QUOTE_TONE = { open: 'warn', paid: 'good', expired: 'bad', void: 'bad' };

/**
 * Bill a crew for a job that isn't in the catalog. The form builds the quote;
 * the table below is what's outstanding, so nothing sits forgotten.
 */
function renderQuotes(quotes, orders) {
  const rows = quotes.map((quote) => {
    const status = quoteStatus(quote, orders);
    const order = findQuoteOrder(quote.itemId, orders);
    const warnings = quoteWarnings(quote);

    const who = `${esc(quote.customer)}${
      quote.department ? `<span class="soft block">${esc(quote.department)}</span>` : ''
    }`;

    // A paid quote points at its order — that's where the work is now.
    const link = order
      ? `<a class="mono" href="/packing-slip?token=${esc(order.token)}">${esc(order.invoiceNumber || order.token)}</a>`
      : `<a class="mono" href="/quote/${esc(quote.id)}" target="_blank" rel="noopener noreferrer">${esc(quote.id)}</a>`;

    // Nothing here sends mail on its own — "Email it" opens your own mail
    // client with the link already in the body, so the message comes from you
    // and lands in your sent folder like every other note to a crew.
    const actions = status === 'open'
      ? `${quote.email ? `<button type="button" class="btn tiny qmail"
             data-id="${esc(quote.id)}" data-email="${esc(quote.email)}"
             data-who="${esc(quote.customer)}" data-what="${esc(quote.title)}"
           >Email it</button>` : ''}
         <button type="button" class="btn tiny ghost qcopy" data-id="${esc(quote.id)}">Copy link</button>
         <button type="button" class="btn tiny ghost qvoid" data-id="${esc(quote.id)}">Void</button>`
      : '<span class="soft">&mdash;</span>';

    return `<tr data-quote="${esc(quote.id)}">
      <td>${link}</td>
      <td>${esc(quote.title)}
        ${quote.taxExempt ? '<span class="pill exempt">Tax exempt</span>' : ''}
        ${warnings.map((w) => `<span class="pill bad" title="${esc(w)}">Cert</span>`).join('')}</td>
      <td>${who}</td>
      <td class="nowrap">${esc(tinyDate(quote.createdAt))}</td>
      <td class="nowrap">${esc(tinyDate(quote.expiresAt))}</td>
      <td class="num strong">${esc(money(quote.total, 'usd'))}</td>
      <td><span class="pill ${QUOTE_TONE[status]}">${status === 'void' ? 'Voided' : esc(status[0].toUpperCase() + status.slice(1))}</span></td>
      <td class="qactions">${actions}</td>
    </tr>`;
  }).join('');

  const flagged = quotes.filter((q) => quoteWarnings(q).length);

  return `<section id="quotes" class="card">
    <div class="cardhead">
      <h2>Quotes</h2>
      <span class="cardnote">custom jobs billed outside the catalog</span>
    </div>

    <p class="hint">
      Build the quote, send the crew the link. They pay through the normal
      checkout, so it lands as an ordinary order &mdash; ship queue, packing slip
      and tracking all work from there. Links die after the expiry you set.
    </p>

    ${CHECKOUT_DISCOUNT ? `<p class="banner">
      The ${Math.round(CHECKOUT_DISCOUNT * 100)}% sale is on, so the button carries a
      grossed-up price and Snipcart's discount lands the total on your number.
      When the sale ends, set <code>CHECKOUT_DISCOUNT</code> to 0 in
      <code>worker/quote.js</code> or every quote overcharges.
    </p>` : ''}

    ${flagged.length ? banner(
      `${flagged.length} quote${flagged.length === 1 ? '' : 's'} with a certificate problem — check the Cert flag below.`
    ) : ''}

    <form id="quoteform" class="qform">
      <div class="qgrid">
        <label class="qfield qwide">
          <span>What is it</span>
          <input type="text" name="title" required maxlength="120"
            placeholder="12 Memorial Radio Straps — Station 4">
        </label>
        <label class="qfield">
          <span>Contact name</span>
          <input type="text" name="customer" required maxlength="120" placeholder="Lt. Dana Reyes">
        </label>
        <label class="qfield">
          <span>Department <em>(optional)</em></span>
          <input type="text" name="department" maxlength="160" placeholder="Lakeland Fire Department">
        </label>
        <label class="qfield">
          <span>Their email <em>(optional)</em></span>
          <input type="email" name="email" maxlength="160" placeholder="dreyes@example.gov">
        </label>
        <label class="qfield qnarrow">
          <span>Good for</span>
          <select name="expiryDays">
            <option value="14">14 days</option>
            <option value="30" selected>30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
          </select>
        </label>
      </div>

      <div class="qlines" id="qlines">
        <div class="qlinehead">
          <span>Line item</span><span class="num">Qty</span><span class="num">Unit price</span><span></span>
        </div>
      </div>
      <button type="button" class="btn tiny ghost" id="qaddline">Add line</button>

      <label class="qfield qwide qnotes">
        <span>Build notes <em>(shown to the customer)</em></span>
        <textarea name="notes" rows="3" maxlength="2000"
          placeholder="Black bridle, white stitch, each strap stamped with the man's last name and badge number. List attached."></textarea>
      </label>

      <div class="qexempt">
        <label class="qcheck">
          <input type="checkbox" name="taxExempt" id="qexempt">
          <span>Tax exempt &mdash; certificate on file</span>
        </label>
        <p class="hint qexempthint">
          Only tick this once you have their exemption certificate in hand. The
          checkout charges no sales tax and the quote shows the certificate on
          its face, so the number below is what you'd stand behind in an audit.
        </p>
        <div class="qgrid qexemptfields" id="qexemptfields" hidden>
          <label class="qfield">
            <span>Entity on the certificate</span>
            <input type="text" name="exemptEntity" maxlength="200" placeholder="City of Lakeland Fire Department">
          </label>
          <label class="qfield">
            <span>Certificate number</span>
            <input type="text" name="exemptCertNumber" maxlength="60" placeholder="85-8012345678C-9">
          </label>
          <label class="qfield qnarrow">
            <span>Valid through</span>
            <input type="text" name="exemptExpires" maxlength="40" placeholder="2027-12-31">
          </label>
        </div>
      </div>

      <div class="panelfoot">
        <button type="submit" class="btn" id="qcreate">Create quote</button>
        <span class="soft" id="qtotal">No lines yet</span>
      </div>
      <div id="qresult"></div>
    </form>

    ${quotes.length ? `<div class="scroll qtable">
      <table class="grid">
        <thead><tr>
          <th>Quote</th><th>What</th><th>Customer</th><th>Sent</th>
          <th>Expires</th><th class="num">Total</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : '<p class="empty">No quotes yet.</p>'}
  </section>`;
}

const STATUS_TONE = {
  Shipped: 'good',
  Delivered: 'done',
  Cancelled: 'bad',
  Disputed: 'bad',
  Pending: 'warn',
  InProgress: 'warn',
  Processed: 'warn',
};

function statusPill(order) {
  const raw = order.status || 'Unknown';
  const tone = STATUS_TONE[raw] || 'warn';
  // "InProgress" reads as "In Progress" without touching Snipcart's own wording.
  const label = raw.replace(/([a-z])([A-Z])/g, '$1 $2');
  return `<span class="pill ${tone}">${esc(label)}</span>`;
}

/** Past this many rows the table is scroll fodder, not information. */
const ORDER_ROW_CAP = 400;

function renderOrders(allOrders, rangeLabel) {
  if (!allOrders.length) {
    return `<section id="orders" class="card">
      <div class="cardhead"><h2>All orders</h2></div>
      <p class="empty">No orders in this window.</p>
    </section>`;
  }

  const orders = allOrders.slice(0, ORDER_ROW_CAP);
  const hidden = allOrders.length - orders.length;

  const rows = orders.map((order) => {
    const a = order.shippingAddress || order.billingAddress || {};
    const refund = refundState(order);

    // One primary state per row. Refund is tracked separately because a
    // partially refunded order is still open, shipped or unpaid underneath.
    const bucket = isCancelled(order) ? 'cancelled'
      : refund === 'full' ? 'refunded'
      : isShipped(order) ? 'shipped'
      : needsShipping(order) ? 'open' : 'unpaid';

    const tracking = order.trackingNumber
      ? `<a class="mono" href="${esc(order.trackingUrl || '#')}" target="_blank" rel="noopener noreferrer">${esc(order.trackingNumber)}</a>`
      : '<span class="soft">&mdash;</span>';

    const refundTag = refund === 'none' ? '' :
      `<span class="pill refund" title="${esc(money(Number(order.refundsAmount) || 0, order.currency))} refunded">${
        refund === 'full' ? 'Refunded' : 'Part refund'
      }</span>`;

    // Refunded and cancelled orders start hidden — see ACTIVE_BUCKETS below.
    const startsHidden = bucket === 'refunded' || bucket === 'cancelled';

    return `<tr data-bucket="${bucket}" data-refund="${refund}"${startsHidden ? ' hidden' : ''}>
      <td><a class="mono" href="/packing-slip?token=${esc(order.token)}">${esc(order.invoiceNumber || order.token)}</a></td>
      <td class="nowrap">${esc(shortDate(order.creationDate))}</td>
      <td>${esc(a.fullName || a.name || order.email || '')}</td>
      <td class="num">${esc(String((order.items || []).reduce((n, i) => n + (Number(i.quantity) || 1), 0)))}</td>
      <td class="num strong">${esc(money(grandTotal(order), order.currency))}</td>
      <td>${statusPill(order)}${refundTag}</td>
      <td class="soft">${esc((order.paymentStatus || '').replace(/([a-z])([A-Z])/g, '$1 $2'))}</td>
      <td>${tracking}</td>
    </tr>`;
  }).join('');

  // Counts come off the same predicates the rows use, so a chip never promises
  // rows the filter won't show.
  const tally = (test) => orders.filter(test).length;
  const filters = [
    ['active', 'Active', tally((o) => !isCancelled(o) && refundState(o) !== 'full')],
    ['open', 'Needs shipping', tally(needsShipping)],
    ['shipped', 'Shipped', tally((o) => isShipped(o) && !isCancelled(o) && refundState(o) !== 'full')],
    ['refunded', 'Refunded', tally((o) => refundState(o) !== 'none')],
    ['cancelled', 'Cancelled', tally(isCancelled)],
    ['all', 'All', orders.length],
  ];

  return `<section id="orders" class="card">
    <div class="cardhead">
      <h2>All orders</h2>
      <span class="cardnote">${allOrders.length} in ${esc(rangeLabel.toLowerCase())}${
        hidden ? ` &middot; newest ${orders.length} shown` : ''
      }</span>
    </div>
    <div class="filters" id="filters">
      ${filters.map(([key, label, count], i) =>
        `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-filter="${key}"${
          count ? '' : ' disabled'
        }>${esc(label)}<span class="chipnum">${count}</span></button>`
      ).join('')}
    </div>
    <div class="scroll">
      <table class="grid">
        <thead><tr>
          <th>Order</th><th>Placed</th><th>Customer</th><th class="num">Items</th>
          <th class="num">Total</th><th>Status</th><th>Payment</th><th>Tracking</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function banner(text) {
  return `<p class="banner">${esc(text)}</p>`;
}

/* ------------------------------------------------------------------ client */

export const DASHBOARD_SCRIPT = `
(function(){
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg, bad){
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, 5000);
  }

  function post(path, body){
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
      body: JSON.stringify(body)
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  /* ---- selection + Pirate Ship export ---- */

  var boxes = [].slice.call(document.querySelectorAll('.sel'));
  var selAll = document.getElementById('selall');
  var selCount = document.getElementById('selcount');
  var csvBtn = document.getElementById('csvbtn');

  function selected(){
    return boxes.filter(function(b){ return b.checked && b.offsetParent !== null; })
      .map(function(b){ return b.value; });
  }

  function syncSelection(){
    if (!selCount) return;
    var n = selected().length;
    selCount.textContent = n + ' selected';
    csvBtn.disabled = n === 0;
    csvBtn.textContent = n ? 'Download Pirate Ship CSV (' + n + ')' : 'Download Pirate Ship CSV';
    if (selAll) selAll.checked = n > 0 && n === boxes.length;
  }

  boxes.forEach(function(b){ b.addEventListener('change', syncSelection); });
  if (selAll) selAll.addEventListener('change', function(){
    boxes.forEach(function(b){ b.checked = selAll.checked; });
    syncSelection();
  });
  syncSelection();

  if (csvBtn) csvBtn.addEventListener('click', function(){
    var tokens = selected();
    if (!tokens.length) return;
    csvBtn.disabled = true;
    var label = csvBtn.textContent;
    csvBtn.textContent = 'Building…';

    fetch('/dashboard/pirate-ship.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
      body: JSON.stringify({ tokens: tokens })
    }).then(function(res){
      if (!res.ok) throw new Error('Export failed (' + res.status + ')');
      return res.blob();
    }).then(function(blob){
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'pirate-ship-' + tokens.length + '-orders.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
      toast(tokens.length + ' address' + (tokens.length === 1 ? '' : 'es') + ' exported. Upload it on Pirate Ship.');
    }).catch(function(err){
      toast(err.message, true);
    }).then(function(){
      csvBtn.textContent = label;
      syncSelection();
    });
  });

  /* ---- one order, one tracking number ---- */

  document.addEventListener('submit', function(event){
    var form = event.target.closest('.shipform');
    if (!form) return;
    event.preventDefault();

    var row = form.closest('tr');
    var input = form.querySelector('input[name=tracking]');
    var button = form.querySelector('button');
    var tracking = (input.value || '').trim();
    if (!tracking) { input.focus(); return; }

    button.disabled = true;
    button.textContent = '…';

    post('/dashboard/api/ship', { token: row.getAttribute('data-token'), trackingNumber: tracking })
      .then(function(){
        row.classList.add('shipped');
        button.textContent = 'Shipped';
        toast('Marked shipped. Snipcart is emailing the tracking number.');
        setTimeout(function(){ location.reload(); }, 1200);
      })
      .catch(function(err){
        button.disabled = false;
        button.textContent = 'Ship';
        toast(err.message, true);
      });
  });

  /* ---- bulk tracking paste ---- */

  var pasteBtn = document.getElementById('pastebtn');
  if (pasteBtn) pasteBtn.addEventListener('click', function(){
    var box = document.getElementById('pastebox');
    var out = document.getElementById('pasteresult');
    var text = (box.value || '').trim();
    if (!text) { box.focus(); return; }

    pasteBtn.disabled = true;
    pasteBtn.textContent = 'Matching…';
    out.innerHTML = '';

    post('/dashboard/api/ship-batch', { text: text })
      .then(function(data){
        var parts = [];
        if (data.shipped && data.shipped.length) {
          parts.push('<p class="ok">Shipped ' + data.shipped.length + ': ' +
            data.shipped.map(function(s){ return s.invoiceNumber; }).join(', ') + '</p>');
        }
        if (data.failed && data.failed.length) {
          parts.push('<p class="err">Failed ' + data.failed.length + ': ' +
            data.failed.map(function(f){ return f.invoiceNumber + ' (' + f.error + ')'; }).join('; ') + '</p>');
        }
        if (data.unmatched && data.unmatched.length) {
          parts.push('<p class="err">No matching order for ' + data.unmatched.length +
            ' line' + (data.unmatched.length === 1 ? '' : 's') + ': ' +
            data.unmatched.map(function(u){ return u.trackingNumber; }).join(', ') +
            '. Add the order number to those lines.</p>');
        }
        if (!parts.length) parts.push('<p class="err">No tracking numbers found in that paste.</p>');
        out.innerHTML = parts.join('');

        if (data.shipped && data.shipped.length) {
          toast('Shipped ' + data.shipped.length + ' order' + (data.shipped.length === 1 ? '' : 's') + '.');
          setTimeout(function(){ location.reload(); }, 2500);
        }
      })
      .catch(function(err){ toast(err.message, true); })
      .then(function(){
        pasteBtn.disabled = false;
        pasteBtn.textContent = 'Match & mark shipped';
      });
  });

  /* ---- quote builder ---- */

  var qLines = document.getElementById('qlines');
  var qForm = document.getElementById('quoteform');

  function money(n){
    return '$' + (Math.round(n * 100) / 100).toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  }

  function addLine(){
    var row = document.createElement('div');
    row.className = 'qline';
    row.innerHTML =
      '<input type="text" class="qdesc" maxlength="200" placeholder="Fully custom radio strap, black bridle, name + badge no.">' +
      '<input type="number" class="qqty num" min="1" max="999" step="1" value="1">' +
      '<input type="number" class="qprice num" min="0.01" max="100000" step="0.01" placeholder="0.00">' +
      '<button type="button" class="qdrop" title="Remove line" aria-label="Remove line">&times;</button>';
    qLines.appendChild(row);
    return row;
  }

  function lineData(){
    return [].slice.call(qLines.querySelectorAll('.qline')).map(function(row){
      return {
        description: row.querySelector('.qdesc').value.trim(),
        quantity: Number(row.querySelector('.qqty').value),
        unitPrice: Number(row.querySelector('.qprice').value)
      };
    }).filter(function(l){ return l.description || l.unitPrice; });
  }

  function syncTotal(){
    var lines = lineData();
    var total = lines.reduce(function(sum, l){
      return sum + (Math.round((l.quantity || 0) * (l.unitPrice || 0) * 100) / 100);
    }, 0);
    var note = document.getElementById('qtotal');
    if (!note) return;
    note.textContent = lines.length
      ? 'Customer pays ' + money(total)
      : 'No lines yet';
  }

  if (qLines) {
    addLine();
    document.getElementById('qaddline').addEventListener('click', function(){
      addLine().querySelector('.qdesc').focus();
    });
    qLines.addEventListener('click', function(event){
      var drop = event.target.closest('.qdrop');
      if (!drop) return;
      // Never leave the form with nothing to type into.
      if (qLines.querySelectorAll('.qline').length > 1) drop.closest('.qline').remove();
      else drop.closest('.qline').querySelectorAll('input').forEach(function(i){ i.value = i.classList.contains('qqty') ? '1' : ''; });
      syncTotal();
    });
    qLines.addEventListener('input', syncTotal);
  }

  var exemptBox = document.getElementById('qexempt');
  if (exemptBox) exemptBox.addEventListener('change', function(){
    var fields = document.getElementById('qexemptfields');
    fields.hidden = !exemptBox.checked;
    // Required only while they're in play, or the form can't submit unexempt.
    fields.querySelectorAll('input').forEach(function(input){
      if (input.name !== 'exemptExpires') input.required = exemptBox.checked;
    });
  });

  if (qForm) qForm.addEventListener('submit', function(event){
    event.preventDefault();
    var btn = document.getElementById('qcreate');
    var out = document.getElementById('qresult');
    var data = new FormData(qForm);

    btn.disabled = true;
    btn.textContent = 'Creating…';
    out.innerHTML = '';

    post('/dashboard/api/quote', {
      title: data.get('title'),
      customer: data.get('customer'),
      department: data.get('department'),
      email: data.get('email'),
      notes: data.get('notes'),
      expiryDays: data.get('expiryDays'),
      taxExempt: !!data.get('taxExempt'),
      exemptEntity: data.get('exemptEntity'),
      exemptCertNumber: data.get('exemptCertNumber'),
      exemptExpires: data.get('exemptExpires'),
      lines: lineData()
    }).then(function(res){
      out.innerHTML = '<p class="ok">Quote ready. Send them this link:</p>' +
        '<div class="qlink"><input type="text" readonly value="' + res.url + '">' +
        '<button type="button" class="btn tiny" id="qcopynew">Copy</button></div>';
      document.getElementById('qcopynew').addEventListener('click', function(){
        copy(res.url);
      });
      toast('Quote created for ' + money(res.total) + '.');
      setTimeout(function(){ location.reload(); }, 4000);
    }).catch(function(err){
      out.innerHTML = '<p class="err">' + err.message + '</p>';
      toast(err.message, true);
    }).then(function(){
      btn.disabled = false;
      btn.textContent = 'Create quote';
    });
  });

  function copy(text){
    // clipboard.writeText needs a secure context; the prompt is the fallback
    // that still works if the dashboard is ever opened over plain http.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function(){ toast('Link copied.'); });
    } else {
      window.prompt('Copy this link:', text);
    }
  }

  document.addEventListener('click', function(event){
    var copyBtn = event.target.closest('.qcopy');
    if (copyBtn) {
      copy(location.origin + '/quote/' + copyBtn.getAttribute('data-id'));
      return;
    }

    var mailBtn = event.target.closest('.qmail');
    if (mailBtn) {
      var link = location.origin + '/quote/' + mailBtn.getAttribute('data-id');
      var who = mailBtn.getAttribute('data-who').split(' ').pop();
      var body = who + ',\\n\\n' +
        'Here is the quote for ' + mailBtn.getAttribute('data-what') + '.\\n\\n' +
        link + '\\n\\n' +
        'Everything is on that page. When you are ready, the button at the ' +
        'bottom takes the payment and we get started.\\n\\n' +
        'Any changes, just tell me and I will send a new one.\\n\\n' +
        'Rawhide City Leather\\n';
      window.location.href = 'mailto:' + encodeURIComponent(mailBtn.getAttribute('data-email')) +
        '?subject=' + encodeURIComponent('Quote — ' + mailBtn.getAttribute('data-what')) +
        '&body=' + encodeURIComponent(body);
      return;
    }

    var voidBtn = event.target.closest('.qvoid');
    if (!voidBtn) return;
    if (!confirm('Void this quote? The link stops working immediately.')) return;

    voidBtn.disabled = true;
    post('/dashboard/api/quote/void', { id: voidBtn.getAttribute('data-id') })
      .then(function(){
        toast('Quote voided.');
        setTimeout(function(){ location.reload(); }, 900);
      })
      .catch(function(err){
        voidBtn.disabled = false;
        toast(err.message, true);
      });
  });

  /* ---- status filter on the all-orders table ---- */

  // 'active' and 'refunded' span more than one bucket, so each filter is a
  // predicate rather than a bucket string match.
  var MATCH = {
    all:       function(){ return true; },
    active:    function(b){ return b !== 'cancelled' && b !== 'refunded'; },
    refunded:  function(b, r){ return r !== 'none'; },
    open:      function(b){ return b === 'open'; },
    shipped:   function(b){ return b === 'shipped'; },
    cancelled: function(b){ return b === 'cancelled'; }
  };

  var filters = document.getElementById('filters');
  if (filters) filters.addEventListener('click', function(event){
    var chip = event.target.closest('[data-filter]');
    if (!chip || chip.disabled) return;
    var test = MATCH[chip.getAttribute('data-filter')] || MATCH.all;
    [].forEach.call(filters.children, function(c){ c.classList.toggle('on', c === chip); });
    [].forEach.call(document.querySelectorAll('#orders tbody tr'), function(row){
      row.hidden = !test(row.getAttribute('data-bucket'), row.getAttribute('data-refund'));
    });
  });
})();
`;

/* ------------------------------------------------------------------ styles */

export const DASHBOARD_STYLES = `
:root{
  --ink:#0F0F0F; --ink-2:#1F1E1C; --ink-3:#3A3833;
  --paper:#fff; --bg:#EFEDE7; --stone:#D9D5CB;
  --soft:#6B6358; --line:rgba(15,15,15,.10); --line-2:rgba(15,15,15,.16);
  --good:#2F5D3A; --good-bg:#E5EDE4;
  --warn:#7A5C14; --warn-bg:#F5EDD8;
  --bad:#8A2B24;  --bad-bg:#F5E3E1;
  --display:'Oswald','Arial Narrow',Haettenschweiler,sans-serif;
  --body:'Segoe UI',system-ui,-apple-system,'Helvetica Neue',sans-serif;
  --rail:236px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2{font-family:var(--display);text-transform:uppercase;margin:0;font-weight:600}
a{color:inherit}
.num{text-align:right;font-variant-numeric:tabular-nums}
.strong{font-weight:700}
.soft{color:var(--soft)}
.block{display:block}
.nowrap{white-space:nowrap}
.mono{font-family:ui-monospace,'Cascadia Mono','Consolas',monospace;font-size:12.5px;font-weight:600}
.spacer{flex:1}

/* ---------------------------------------------------------------- shell */
.shell{display:flex;min-height:100vh}
.rail{width:var(--rail);flex:0 0 var(--rail);background:var(--ink);color:#EBE8E1;
  display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.railtop{padding:22px 20px 18px;border-bottom:1px solid rgba(235,232,225,.14)}
.railtop img{max-height:40px;width:auto;display:block;filter:invert(1) brightness(1.6)}
.railname{font-family:var(--display);text-transform:uppercase;letter-spacing:.14em;
  font-size:13px;line-height:1.25;margin:12px 0 0}
.railnav{display:flex;flex-direction:column;padding:14px 10px;gap:2px}
.railnav a{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:2px;
  font-family:var(--display);text-transform:uppercase;letter-spacing:.13em;font-size:11.5px;
  color:rgba(235,232,225,.72);text-decoration:none}
.railnav a:hover{background:var(--ink-2);color:#fff}
.railbadge{margin-left:auto;background:#EBE8E1;color:var(--ink);border-radius:9px;
  padding:1px 7px;font-size:10.5px;letter-spacing:.04em;font-weight:700}
.railfoot{margin-top:auto;padding:16px 22px 20px;display:flex;flex-direction:column;gap:9px;
  border-top:1px solid rgba(235,232,225,.14);font-size:12px}
.railfoot a{color:rgba(235,232,225,.6);text-decoration:none}
.railfoot a:hover{color:#fff}

.main{flex:1;min-width:0}
.topbar{position:sticky;top:0;z-index:5;background:rgba(239,237,231,.94);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--line-2);
  padding:16px 28px;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}
.topbar h1{font-size:22px;letter-spacing:.1em}
.sub{margin:3px 0 0;font-size:12px;color:var(--soft)}
.topright{display:flex;align-items:center;gap:12px}
/* overflow-x:auto, not hidden — hidden still clips the rounded corners the same
   way, but on a phone it also swallowed the last chips with no way to reach
   them. Scrolling keeps every filter available at any width. */
.chips{display:flex;gap:0;border:1px solid var(--line-2);border-radius:2px;
  overflow-x:auto;overscroll-behavior-x:contain;background:var(--paper)}
.chip{font-family:var(--display);text-transform:uppercase;letter-spacing:.11em;font-size:10.5px;
  padding:8px 13px;color:var(--soft);text-decoration:none;background:none;border:0;cursor:pointer;
  border-right:1px solid var(--line);flex:0 0 auto;white-space:nowrap}
.chip:last-child{border-right:0}
.chip:hover{background:var(--bg);color:var(--ink)}
.chip.on{background:var(--ink);color:#EBE8E1}
.pad{padding:22px 28px 60px;max-width:1400px}

.btn{font-family:var(--display);text-transform:uppercase;letter-spacing:.14em;font-size:10.5px;
  padding:9px 16px;border:1.5px solid var(--ink);background:var(--ink);color:#EBE8E1;
  cursor:pointer;border-radius:2px;text-decoration:none;display:inline-block;white-space:nowrap}
.btn:hover{background:var(--ink-3);border-color:var(--ink-3)}
.btn:disabled{opacity:.35;cursor:not-allowed}
.btn.ghost{background:var(--paper);color:var(--ink)}
.btn.ghost:hover{background:var(--stone)}
.btn.tiny{padding:6px 11px;font-size:9.5px;letter-spacing:.1em}

.banner{margin:0 0 18px;padding:11px 14px;background:var(--warn-bg);color:var(--warn);
  border-left:3px solid var(--warn);font-size:13px;border-radius:2px}

/* ------------------------------------------------------------------ kpis */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(172px,1fr));gap:14px;margin-bottom:18px}
/* All five across on a desktop. Left to auto-fit they wrap 4 + 1, and the
   orphaned lifetime tile reads like something failed to load. */
@media (min-width:1150px){ .kpis{grid-template-columns:repeat(5,minmax(0,1fr))} }
.kpi{background:var(--paper);border:1px solid var(--line);border-radius:3px;padding:16px 18px 14px}
.kpi.accent{background:var(--ink);color:#EBE8E1;border-color:var(--ink)}
.kpilabel{font-family:var(--display);text-transform:uppercase;letter-spacing:.17em;
  font-size:10px;color:var(--soft);margin:0}
.kpi.accent .kpilabel{color:rgba(235,232,225,.62)}
.kpivalue{font-family:var(--display);font-size:33px;font-weight:600;line-height:1.05;
  margin:9px 0 6px;font-variant-numeric:tabular-nums}
.kpinote{margin:0;font-size:11.5px;color:var(--soft);display:flex;align-items:center;gap:7px}
.kpi.accent .kpinote{color:rgba(235,232,225,.62)}
.kpinote.flag{color:var(--warn);font-weight:600}
.delta{font-size:10.5px;font-weight:700;padding:2px 6px;border-radius:2px;letter-spacing:.03em}
.delta.up{background:var(--good-bg);color:var(--good)}
.delta.down{background:var(--bad-bg);color:var(--bad)}
.delta.flat{background:var(--stone);color:var(--soft)}

/* ----------------------------------------------------------------- cards */
.card{background:var(--paper);border:1px solid var(--line);border-radius:3px;
  padding:16px 18px 18px;margin-bottom:18px}
.cardhead{display:flex;align-items:baseline;justify-content:space-between;gap:14px;
  padding-bottom:11px;margin-bottom:14px;border-bottom:1px solid var(--line)}
.cardhead h2{font-size:13px;letter-spacing:.2em}
.cardnote{font-size:11.5px;color:var(--soft)}
.empty{margin:0;padding:14px 0 6px;color:var(--soft);font-style:italic}
.hint{margin:0 0 14px;font-size:12.5px;color:var(--soft);max-width:78ch}
.split{display:grid;grid-template-columns:minmax(0,1.85fr) minmax(0,1fr);gap:18px;align-items:start}
.split .card{margin-bottom:18px}

/* ----------------------------------------------------------------- chart */
.chart svg{width:100%;height:240px;display:block;overflow:visible}
.grid{stroke:rgba(15,15,15,.10);stroke-width:1}
.grid.strong{stroke:rgba(15,15,15,.30)}
.axis,.mon{font-family:var(--body);font-size:10.5px;fill:var(--soft)}
.mon{font-family:var(--display);letter-spacing:.08em;text-transform:uppercase;font-size:10px}
.bar{fill:var(--ink-3)}
.bar.current{fill:var(--ink)}
.bargroup:hover .bar{fill:var(--soft)}

/* --------------------------------------------------------------- tables */
.scroll{overflow-x:auto}
table.grid,table.mini{width:100%;border-collapse:collapse}
table.grid th,table.grid td{text-align:left;padding:9px 11px;border-bottom:1px solid var(--line);
  vertical-align:top}
table.grid thead th{font-family:var(--display);text-transform:uppercase;letter-spacing:.15em;
  font-size:9.5px;color:var(--soft);border-bottom:1px solid var(--line-2);white-space:nowrap;
  padding-top:0;position:sticky;top:0;background:var(--paper)}
table.grid tbody tr:hover{background:#FAF9F6}
table.grid tbody tr.shipped{opacity:.45}
table.grid a.mono{text-decoration:none;border-bottom:1px solid var(--line-2)}
table.grid a.mono:hover{border-bottom-color:var(--ink)}
.items{font-size:12.5px;line-height:1.5;min-width:11rem}
.pick{width:30px;padding-right:0}
.pick input{width:15px;height:15px;accent-color:#0F0F0F;cursor:pointer}
.due{display:inline-block;margin-left:6px;font-size:10px;font-weight:700;color:var(--soft);
  background:var(--stone);border-radius:2px;padding:1px 5px}
.due.soon{background:var(--warn-bg);color:var(--warn)}
.due.hot{background:var(--bad-bg);color:var(--bad)}

table.mini td{padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px}
table.mini tr:last-child td{border-bottom:0}
.pname{min-width:0}
.pname>span:first-child{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:15rem}
.track{display:block;height:3px;background:var(--stone);margin-top:5px;border-radius:2px}
.track .fill{display:block;height:3px;background:var(--ink-3);border-radius:2px}

.pill{display:inline-block;font-family:var(--display);text-transform:uppercase;
  letter-spacing:.11em;font-size:9.5px;font-weight:600;padding:3px 8px;border-radius:2px;white-space:nowrap}
.pill.good{background:var(--good-bg);color:var(--good)}
.pill.done{background:var(--stone);color:var(--ink-3)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}
/* Outlined, not filled — it sits beside a status pill and must not outshout it. */
.pill.refund{margin-left:5px;background:none;color:var(--bad);
  box-shadow:inset 0 0 0 1px currentColor}
.pill.exempt{margin-left:6px;background:none;color:var(--soft);
  box-shadow:inset 0 0 0 1px var(--line-2)}

/* ---------------------------------------------------------------- quotes */
.qform{border:1px solid var(--line);border-radius:3px;padding:16px 16px 14px;
  margin-bottom:18px;background:#FBFAF7}
.qgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.qfield{display:flex;flex-direction:column;gap:5px;min-width:0}
.qfield>span{font-family:var(--display);text-transform:uppercase;letter-spacing:.15em;
  font-size:9.5px;color:var(--soft)}
.qfield>span em{font-style:normal;text-transform:none;letter-spacing:.02em;opacity:.7}
.qfield input,.qfield select,.qfield textarea{font:inherit;font-size:13px;padding:8px 10px;
  border:1px solid var(--line-2);border-radius:2px;background:var(--paper);color:var(--ink);
  width:100%;min-width:0}
.qfield textarea{resize:vertical;line-height:1.5}
.qfield input:focus,.qfield select:focus,.qfield textarea:focus,
.qline input:focus{outline:2px solid var(--ink);outline-offset:-1px}
.qwide{grid-column:1/-1}
.qnarrow{max-width:200px}
.qnotes{margin-top:12px}

.qlines{margin-top:16px}
.qlinehead,.qline{display:grid;grid-template-columns:minmax(0,1fr) 76px 116px 30px;gap:8px;
  align-items:center}
.qlinehead{font-family:var(--display);text-transform:uppercase;letter-spacing:.15em;
  font-size:9.5px;color:var(--soft);margin-bottom:6px}
.qlinehead .num{text-align:right}
.qline{margin-bottom:7px}
.qline input{font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--line-2);
  border-radius:2px;background:var(--paper);color:var(--ink);width:100%;min-width:0}
.qline input.num{text-align:right;font-variant-numeric:tabular-nums}
.qdrop{border:0;background:none;color:var(--soft);font-size:19px;line-height:1;cursor:pointer;
  padding:4px 6px;border-radius:2px}
.qdrop:hover{background:var(--bad-bg);color:var(--bad)}

.qexempt{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.qcheck{display:inline-flex;align-items:center;gap:8px;cursor:pointer;
  font-family:var(--display);text-transform:uppercase;letter-spacing:.13em;font-size:10.5px}
.qcheck input{width:15px;height:15px;accent-color:#0F0F0F;cursor:pointer}
.qexempthint{margin:8px 0 0}
.qexemptfields{margin-top:12px}

.qlink{display:flex;gap:8px;margin-top:8px;align-items:center}
.qlink input{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;font-size:12px;
  padding:8px 10px;border:1px solid var(--line-2);border-radius:2px;flex:1;min-width:0;
  background:var(--paper);color:var(--ink)}
.qactions{white-space:nowrap}
.qactions .btn{margin-right:5px}
.qtable{margin-top:4px}
@media (max-width:640px){
  .qlinehead{display:none}
  .qline{grid-template-columns:minmax(0,1fr) 64px 96px 28px;gap:6px}
}

.filters{display:flex;gap:0;margin-bottom:12px;border:1px solid var(--line-2);
  border-radius:2px;overflow-x:auto;overscroll-behavior-x:contain;
  width:max-content;max-width:100%;background:var(--paper)}
.filters .chip{display:inline-flex;align-items:center;gap:6px}
.filters .chip:disabled{opacity:.4;cursor:default}
.filters .chip:disabled:hover{background:none;color:var(--soft)}
.chipnum{font-variant-numeric:tabular-nums;font-size:9.5px;padding:1px 5px;border-radius:8px;
  background:rgba(15,15,15,.09);color:var(--soft);letter-spacing:.02em}
.chip.on .chipnum{background:rgba(235,232,225,.22);color:#EBE8E1}

/* -------------------------------------------------------------- shipping */
.bulkbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px;
  padding:11px 13px;background:var(--bg);border:1px solid var(--line);border-radius:2px}
.allbox{display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;white-space:nowrap}
.allbox input{width:15px;height:15px;accent-color:#0F0F0F;cursor:pointer}
.selcount{font-size:11.5px;color:var(--soft);font-variant-numeric:tabular-nums}
.shipcell{min-width:13rem}
.shipform{display:flex;gap:6px}
.shipform input{flex:1;min-width:8rem;font-family:ui-monospace,'Consolas',monospace;font-size:12px;
  padding:6px 8px;border:1px solid var(--line-2);border-radius:2px;background:var(--paper);color:var(--ink)}
.shipform input:focus{outline:2px solid var(--ink);outline-offset:-1px;border-color:var(--ink)}

#pastebox{width:100%;font-family:ui-monospace,'Consolas',monospace;font-size:12.5px;
  padding:11px 12px;border:1px solid var(--line-2);border-radius:2px;resize:vertical;
  background:var(--paper);color:var(--ink);line-height:1.6}
#pastebox:focus{outline:2px solid var(--ink);outline-offset:-1px}
.panelfoot{display:flex;align-items:center;gap:14px;margin-top:12px}
#pasteresult p{margin:12px 0 0;font-size:12.5px;padding:9px 12px;border-radius:2px}
#pasteresult .ok{background:var(--good-bg);color:var(--good)}
#pasteresult .err{background:var(--bad-bg);color:var(--bad)}

/* ---------------------------------------------------------------- toast */
.toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,140%);
  background:var(--ink);color:#EBE8E1;padding:12px 20px;border-radius:3px;font-size:13px;
  box-shadow:0 10px 30px rgba(15,15,15,.28);transition:transform .22s ease;z-index:50;
  max-width:min(90vw,44rem);text-align:center}
.toast.show{transform:translate(-50%,0)}
.toast.bad{background:var(--bad)}

.notice{max-width:36rem;margin:12vh auto;background:var(--paper);border:1px solid var(--line);
  padding:32px 34px;border-radius:3px}
.notice h1{font-size:19px;letter-spacing:.1em;margin-bottom:10px}
.notice p{color:var(--soft);margin:0}
code{font-family:ui-monospace,'Consolas',monospace;background:rgba(15,15,15,.06);
  padding:1px 5px;border-radius:2px}

@media (max-width:1080px){
  .split{grid-template-columns:1fr}
}
@media (max-width:860px){
  .rail{position:static;height:auto;width:100%;flex:none}
  .shell{flex-direction:column}
  .railtop{display:flex;align-items:center;gap:14px;padding:14px 18px}
  .railname{margin:0}
  .railnav{flex-direction:row;overflow-x:auto;padding:8px}
  .railfoot{flex-direction:row;gap:18px;padding:12px 18px}
  .pad,.topbar{padding-left:16px;padding-right:16px}
  .topbar{position:static}
}
`;
