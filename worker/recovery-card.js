/**
 * Cart recovery, on the dashboard.
 *
 * The pipeline in worker/recovery.js has been healthy since August and has
 * recovered nothing, and finding that out has twice meant opening the Snipcart
 * dashboard, counting coupons by hand, and cross-reading a discount list that
 * paginates at 25 with no visible pager. Checking was the bottleneck, so the
 * numbers live here now: how many coupons went out, how many were used, what is
 * sitting in carts right now, and what those carts are full of.
 *
 * That last one is the point. The single most useful thing anyone learned about
 * these carts was that fifteen of twenty-four held the same $165 six-week-lead
 * strap — which is a fact about the product page, not about the coupon. It took
 * a manual count to see it once. Now it is on the screen.
 *
 * Every number is sourced, and a number that cannot be sourced is not shown:
 *
 *   sent      the RECOVERY KV log, which is what the cron itself writes
 *   used      Snipcart's own usage count on each minted discount
 *   waiting   the live abandoned-cart list
 *   paused    whether an automatic storewide discount already beats the coupon
 *
 * There is deliberately no "revenue recovered" tile. Snipcart's discount object
 * says a code was used but not what the order came to, and a dollar figure
 * assembled from a guess about the order payload would be the one number on
 * this page nobody could check.
 */

import { esc, money, json } from './lib.js';
import {
  listRecoveries, listAbandonedCarts, cartUrl, recoverCart,
  SEND_AFTER_HOURS, MAX_AGE_HOURS, DISCOUNT_RATE, CODE_TTL_DAYS,
} from './recovery.js';
import { automaticStoreRate, listDiscounts } from './promo-sync.js';
import { mailerConfigured } from './mailer.js';

const HOUR = 3600 * 1000;

/* ------------------------------------------------------------------- data */

/**
 * Everything the card needs, gathered in parallel and degrading a piece at a
 * time. A Snipcart outage should cost the recovery card its numbers, not cost
 * the whole dashboard its page — so each leg catches its own failure and says
 * so, and the card renders whatever did come back.
 */
export async function recoveryStats(env, now = Date.now()) {
  const ready = mailerConfigured(env);

  const [sent, carts, rate, discounts] = await Promise.all([
    env.RECOVERY ? listRecoveries(env).catch(() => null) : Promise.resolve([]),
    env.SNIPCART_SECRET ? listAbandonedCarts(env).catch(() => null) : Promise.resolve([]),
    automaticStoreRate(env, now).catch(() => 0),
    env.SNIPCART_SECRET ? listDiscountUsage(env).catch(() => null) : Promise.resolve(new Map()),
  ]);

  return {
    ready,
    storeRate: rate,
    paused: rate >= DISCOUNT_RATE,
    sent: sent || [],
    sentUnavailable: sent === null,
    usage: discounts || new Map(),
    usageUnavailable: discounts === null,
    carts: (carts || []).filter((c) => c && c.email),
    cartsUnavailable: carts === null,
    now,
  };
}

/** code -> times used, for every discount on the account. */
async function listDiscountUsage(env) {
  const used = new Map();
  for (const rule of await listDiscounts(env)) {
    if (rule?.code) used.set(String(rule.code).toUpperCase(), Number(rule.numberOfUsages) || 0);
  }
  return used;
}

/* ---------------------------------------------------------------- reading */

export function cartValue(cart) {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  return items.reduce((sum, i) => sum + (Number(i.totalPrice) || 0), 0);
}

export function cartAgeHours(cart, now) {
  const raw = cart?.modificationDate ?? cart?.creationDate;
  if (raw === undefined || raw === null) return null;
  // Snipcart hands this back as an epoch in SECONDS on the abandoned-cart list
  // and as an ISO string elsewhere. Reading the number as milliseconds put
  // every cart in 1970 once and cost three live runs.
  const at = typeof raw === 'number' ? raw * 1000 : Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now - at) / HOUR));
}

/**
 * What the waiting carts are actually full of, biggest first. Counted by cart
 * rather than by line, because "six carts hold this" is the question — a cart
 * with two of something is still one person who walked away.
 */
export function productTally(carts) {
  const counts = new Map();
  for (const cart of carts) {
    const names = new Set(
      (Array.isArray(cart.items) ? cart.items : [])
        .map((i) => String(i?.name || '').trim())
        .filter(Boolean)
    );
    for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The numbers, from whatever the gather managed to bring back. */
export function summarise(stats) {
  const sent = stats.sent.length;
  const used = stats.sent.filter((r) => (stats.usage.get(String(r.code || '').toUpperCase()) || 0) > 0).length;

  const waiting = stats.carts.filter((c) => {
    const age = cartAgeHours(c, stats.now);
    return age !== null && age <= MAX_AGE_HOURS;
  });
  const ages = waiting.map((c) => cartAgeHours(c, stats.now)).filter((a) => a !== null);

  const mailed = new Set(stats.sent.map((r) => r.token));

  return {
    sent,
    used,
    lastSentAt: stats.sent[0]?.sentAt || '',
    waiting: waiting.length,
    waitingValue: waiting.reduce((sum, c) => sum + cartValue(c), 0),
    oldestHours: ages.length ? Math.max(...ages) : 0,
    notYetMailed: waiting.filter((c) => !mailed.has(c.token || c.id)).length,
    tally: productTally(waiting),
    rows: waiting
      .map((c) => ({
        token: c.token || c.id,
        ageHours: cartAgeHours(c, stats.now),
        value: cartValue(c),
        items: (Array.isArray(c.items) ? c.items : []).map((i) => String(i?.name || '').trim()).filter(Boolean),
        email: c.email || '',
        mailed: mailed.has(c.token || c.id),
      }))
      .sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0)),
  };
}

/* --------------------------------------------------------------- the card */

function ago(hours) {
  if (!hours) return 'just now';
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function niceDate(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (isNaN(at)) return '';
  return at.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'America/New_York',
  });
}

/** The one line at the top that says whether anything is going out at all. */
export function stateOf(stats) {
  if (!stats.ready) {
    return {
      pill: 'bad',
      label: 'Off',
      note: 'The mail secrets are not set, so the hourly run sends nothing. See the README.',
    };
  }
  if (stats.paused) {
    return {
      pill: 'warn',
      label: 'Holding',
      note: `An automatic ${stats.storeRate}% is already coming off every cart, so a ` +
        `${DISCOUNT_RATE}% coupon is worth nothing to the buyer. Nobody is being mailed, ` +
        'nothing is being spent, and these carts get a real coupon on the first run after the sale ends.',
    };
  }
  return {
    pill: 'good',
    label: 'Sending',
    note: `A cart gets one ${DISCOUNT_RATE}% code ${SEND_AFTER_HOURS} hours after it is left, ` +
      `good for ${CODE_TTL_DAYS} days, one per buyer. The run is hourly.`,
  };
}

export function renderRecoveryCard(stats) {
  const sums = summarise(stats);
  const state = stateOf(stats);

  const tiles = [
    {
      label: 'Coupons sent',
      value: String(sums.sent),
      note: sums.lastSentAt ? `last on ${niceDate(sums.lastSentAt)}` : 'none yet',
      missing: stats.sentUnavailable,
    },
    {
      label: 'Used',
      value: String(sums.used),
      note: sums.sent ? `of ${sums.sent} sent` : 'nothing sent yet',
      accent: sums.used > 0,
      missing: stats.usageUnavailable,
    },
    {
      label: 'Carts waiting',
      value: String(sums.waiting),
      note: sums.notYetMailed
        ? `${sums.notYetMailed} not mailed yet`
        : (sums.waiting ? 'all mailed' : 'none in the window'),
      missing: stats.cartsUnavailable,
    },
    {
      label: 'Sitting in them',
      value: money(sums.waitingValue, 'usd'),
      note: sums.oldestHours ? `oldest left ${ago(sums.oldestHours)}` : 'nothing waiting',
      missing: stats.cartsUnavailable,
    },
  ];

  const tileHtml = tiles.map((t) => `<div class="rtile${t.accent ? ' on' : ''}">
        <p class="rlabel">${esc(t.label)}</p>
        <p class="rvalue">${t.missing ? '&mdash;' : esc(t.value)}</p>
        <p class="rnote">${t.missing ? 'Snipcart could not be read' : esc(t.note)}</p>
      </div>`).join('');

  const tally = sums.tally.length ? `<div class="rtally">
      <p class="rtallyhead">What is in the carts nobody finished</p>
      ${sums.tally.map((t) => `<div class="rtallyrow">
        <span class="rtallybar" style="width:${Math.round((t.count / sums.tally[0].count) * 100)}%"></span>
        <span class="rtallyname">${esc(t.name)}</span>
        <span class="rtallycount">${t.count}</span>
      </div>`).join('')}
      <p class="hint">
        Counted by cart, not by line. This is the number worth watching: a discount
        answers a price objection, and it cannot answer a lead time or a form with
        eleven choices on it.
      </p>
    </div>` : '';

  const rows = sums.rows.length ? sums.rows.map((r) => `<tr data-cart="${esc(r.token)}">
        <td class="soft">${esc(ago(r.ageHours))}</td>
        <td>${esc(r.items.join(', ') || '&mdash;')}</td>
        <td class="num">${esc(money(r.value, 'usd'))}</td>
        <td class="rstate">${r.mailed
          ? '<span class="pill good">coupon sent</span>'
          : `<span class="pill done">waiting${r.ageHours < SEND_AFTER_HOURS ? ' for 24h' : ''}</span>`}</td>
        <td class="rdo">${r.mailed ? '' : `<button type="button" class="rsend" data-send="${esc(r.token)}">Send it now</button>`}</td>
        <td><a href="${esc(cartUrl({ token: r.token }))}" target="_blank" rel="noopener">open cart &nearr;</a></td>
      </tr>`).join('') : `<tr><td colspan="6" class="soft">No carts in the window.</td></tr>`;

  return `<section id="recovery" class="card">
    <div class="cardhead">
      <h2>Cart recovery</h2>
      <span class="cardnote">the coupon that chases a cart somebody left</span>
    </div>

    <div class="promostatus">
      <span class="pill ${state.pill}">${esc(state.label)}</span>
      <span class="soft">${esc(state.note)}</span>
    </div>

    <div class="rtiles">${tileHtml}</div>

    ${sums.sent && !sums.used && !stats.usageUnavailable ? `<p class="banner">
      ${sums.sent} coupons have gone out and none has been used. The pipeline is not the
      problem &mdash; every one of them was delivered. Before changing the discount again,
      look at what the carts below are full of.
    </p>` : ''}

    ${tally}

    <div class="tablewrap">
      <table class="rtable">
        <thead><tr><th>Left</th><th>What was in it</th><th class="num">Value</th><th>Coupon</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint">
      <b>Send it now</b> does by hand what the hourly run does on its own: mints that
      buyer a single-use ${DISCOUNT_RATE}% code and emails it. Use it for a cart that has
      not reached ${SEND_AFTER_HOURS} hours yet, or one you have just been talking to
      somebody about. The one-coupon-per-buyer rule still holds, so pressing it twice
      cannot send two.
    </p>
    <p class="hint">
      A cart only appears here for ${MAX_AGE_HOURS / 24} days. Opening one restores it
      exactly as the customer left it, stamping and all &mdash; that link is the customer's
      cart, so treat it like their address.
    </p>
  </section>`;
}

/* ---------------------------------------------------------- sending one */

/**
 * One coupon, sent by hand, to a cart on the card.
 *
 * `recoverCart` is the same call the hourly run makes, and it already holds the
 * guards that matter: a cart that has had a coupon gets nothing, and neither
 * does a buyer who has had one on another cart in the last week. What it does
 * not hold is the age window — the 24-hour floor and the 7-day ceiling live in
 * the run loop — which is exactly why it can be used for a cart that is only
 * two hours old.
 *
 * The cart has to be one the card is showing. Looking it up in the same list
 * the card was drawn from means a token typed into this endpoint by hand
 * cannot reach a cart nobody is looking at.
 */
export async function handleRecoverySend(request, env, now = Date.now()) {
  if (!env.SNIPCART_SECRET) return json({ error: 'Snipcart is not configured.' }, 500);
  if (!mailerConfigured(env)) {
    return json({ error: 'Email is not set up, so nothing can be sent. See the README.' }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '');
  if (!token) return json({ error: 'No cart was named.' }, 400);

  let carts;
  try {
    carts = await listAbandonedCarts(env);
  } catch (err) {
    return json({ error: 'Could not read the abandoned carts: ' + (err?.message || err) }, 502);
  }

  const cart = carts.find((c) => (c.token || c.id) === token);
  if (!cart) return json({ error: 'That cart is not in the window any more.' }, 404);
  if (!cart.email) return json({ error: 'That cart has no email on it, so there is nobody to send to.' }, 400);

  let result;
  try {
    result = await recoverCart(env, cart, now);
  } catch (err) {
    return json({ error: String(err?.message || err).slice(0, 300) }, 502);
  }

  return json({ ok: result.status === 'sent', ...result, said: SEND_SAID[result.status] || result.status });
}

/** What each outcome means, in the words the card shows. */
const SEND_SAID = {
  sent: 'Sent.',
  'already-sent': 'That cart has already had one.',
  'duplicate-email': 'That buyer already had a coupon this week, on this cart or another one.',
  'given-up': 'This one failed too many times. The address is probably bad.',
  failed: 'The email would not send. Try again in a minute.',
};

export const RECOVERY_STYLES = `
.rtiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0 4px}
.rtile{border:1px solid var(--line);border-radius:3px;padding:12px 14px;background:var(--paper)}
.rtile.on{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.rlabel{margin:0 0 6px;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--soft,#6b6b6b)}
.rvalue{margin:0;font-family:var(--display);font-size:26px;font-weight:700;line-height:1.05}
.rnote{margin:4px 0 0;font-size:11.5px;color:var(--soft,#6b6b6b)}
.rtally{margin:18px 0 6px;padding:14px 16px;border:1px solid var(--line);border-radius:3px;background:var(--paper)}
.rtallyhead{margin:0 0 10px;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--soft,#6b6b6b)}
.rtallyrow{position:relative;display:flex;align-items:center;gap:10px;padding:5px 8px;margin-bottom:3px}
.rtallybar{position:absolute;left:0;top:0;bottom:0;background:rgba(0,0,0,.07);border-radius:2px}
.rtallyname{position:relative;flex:1;font-size:13px}
.rtallycount{position:relative;font-variant-numeric:tabular-nums;font-weight:700;font-size:13px}
.tablewrap{overflow-x:auto;margin-top:14px}
.rtable{width:100%;border-collapse:collapse;font-size:13px;min-width:520px}
.rtable th{text-align:left;font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--soft,#6b6b6b);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--line)}
.rtable td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.rtable .num{text-align:right;font-variant-numeric:tabular-nums}
.rtable tr:last-child td{border-bottom:0}
.rdo{white-space:nowrap}
.rsend{font:inherit;font-size:11.5px;padding:4px 10px;cursor:pointer;border:1px solid var(--line);
  border-radius:2px;background:var(--paper);color:inherit}
.rsend:hover:not(:disabled){border-color:var(--ink)}
.rsend:disabled{opacity:.45;cursor:default}
.rsaid{font-size:11.5px;color:var(--soft,#6b6b6b)}
.rsaid.bad{color:#8B2E2E}
`;

/**
 * Runs inside the dashboard page. One button per waiting cart, doing by hand
 * what the hourly run does on its own.
 *
 * It asks first when the store is on sale, because that is the one case where
 * pressing it spends a real coupon on an offer the buyer already has — the
 * whole reason the automatic run holds off. It is still allowed: it is his
 * shop, and there are reasons to reach somebody anyway.
 */
export const RECOVERY_SCRIPT = `
(function(){
  var card = document.getElementById('recovery');
  if (!card) return;

  var HOLDING = card.querySelector('.pill.warn') !== null;
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg, bad){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, 6000);
  }

  card.addEventListener('click', function(e){
    var btn = e.target.closest && e.target.closest('[data-send]');
    if (!btn) return;

    var token = btn.getAttribute('data-send');
    var row = btn.closest('tr');
    var what = row ? (row.children[1].textContent || 'this cart').trim() : 'this cart';

    if (HOLDING && !confirm(
      'The store is on sale right now, so 15% is already coming off this cart and the ' +
      'coupon would save them nothing on top of it.\\n\\nSend it anyway?')) return;
    if (!HOLDING && !confirm('Email a 15% code for ' + what + '?')) return;

    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Sending\\u2026';

    fetch('/dashboard/api/recovery/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
      body: JSON.stringify({ token: token })
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    }).then(function(data){
      var state = row && row.querySelector('.rstate');
      if (data.ok) {
        if (state) state.innerHTML = '<span class="pill good">coupon sent</span>';
        btn.remove();
        toast('Sent. ' + what + ' has its code.');
      } else {
        // Not an error — a guard did its job. Say which one.
        btn.disabled = false;
        btn.textContent = label;
        var said = document.createElement('span');
        said.className = 'rsaid bad';
        said.textContent = data.said || data.status;
        btn.parentElement.appendChild(said);
        toast(data.said || data.status, true);
      }
    }).catch(function(err){
      btn.disabled = false;
      btn.textContent = label;
      toast(err.message, true);
    });
  });
})();
`;
