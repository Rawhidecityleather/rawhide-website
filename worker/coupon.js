/**
 * A one-off coupon for one person.
 *
 * The three discounts this shop already runs are all systems: the sale banner
 * puts a rule on the whole store, cart recovery mints one per abandoned cart on
 * a schedule, and a quote prices a crew order. None of them covers the ordinary
 * thing — somebody emails, something went wrong, and they should get a code.
 *
 * That has happened for real. A customer's cart missed the Labor Day 15% on
 * 2026-09-13 because the rule had been re-saved underneath him, and the only
 * fix available was talking him through clearing and rebuilding his cart.
 *
 * **It does not email anybody.** It mints the code, shows it, and stops there.
 * Rob writes to customers in his own voice, so the useful thing here is the
 * code on a plate, not a message drafted for him.
 *
 * There is no new storage. Snipcart is the record: every code made here is
 * named `One-off: <label>`, which is how the card finds them again and how the
 * usage count comes back. The same trick the sale banner uses on its own rule.
 *
 * Routes (wired in index.js)
 *   POST /dashboard/api/coupon   mint one
 */

import { esc, json } from './lib.js';
import { postJson } from './snipcart.js';
import { makeCode } from './recovery.js';
import { listDiscounts } from './promo-sync.js';

/** Every code made here carries this, and that is how they are found again. */
export const ONE_OFF_PREFIX = 'One-off: ';

export const LABEL_MAX = 60;
export const PERCENT_MAX = 90;
export const AMOUNT_MAX = 500;
export const DAYS_MAX = 90;
export const DAYS_DEFAULT = 14;

const HOUR = 3600 * 1000;

export class CouponError extends Error {}

/* ------------------------------------------------------------------ model */

/**
 * Turns the form into a Snipcart discount body, or throws a CouponError the
 * card can show.
 *
 * `label` is only ever seen by the shop — it is what tells two codes apart in a
 * list a month later, so "Mike, missed the Labor Day 15" beats "discount 3".
 * It lands in the Snipcart discount name, which is private to the account.
 */
export function buildCoupon(input = {}, code, now = Date.now()) {
  const label = String(input.label ?? '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  if (!label) {
    throw new CouponError('Say who it is for. You will not remember in a month otherwise.');
  }

  const type = input.type === 'amount' ? 'amount' : 'percent';
  const raw = Number(input.value);
  let value;
  if (type === 'percent') {
    value = Math.round(raw);
    if (!Number.isFinite(raw) || value < 1 || value > PERCENT_MAX || value !== raw) {
      throw new CouponError(`Percent off is a whole number from 1 to ${PERCENT_MAX}.`);
    }
  } else {
    value = Math.round(raw * 100) / 100;
    if (!Number.isFinite(raw) || value < 1 || value > AMOUNT_MAX) {
      throw new CouponError(`Dollars off is from 1 to ${AMOUNT_MAX}.`);
    }
  }

  const days = Math.round(Number(input.days ?? DAYS_DEFAULT));
  if (!Number.isFinite(days) || days < 1 || days > DAYS_MAX) {
    throw new CouponError(`Good for 1 to ${DAYS_MAX} days.`);
  }

  const expires = new Date(now + days * 24 * HOUR);

  return {
    body: {
      name: `${ONE_OFF_PREFIX}${label}`.slice(0, 100),
      trigger: 'Code',
      code,
      type: type === 'percent' ? 'Rate' : 'FixedAmount',
      ...(type === 'percent' ? { rate: value } : { amount: value }),
      maxNumberOfUsages: 1,
      // Like every other rule this repo writes. A one-off must not stack on a
      // storewide sale and quietly hand out more than was meant.
      combinable: false,
      expires: expires.toISOString(),
    },
    label,
    type,
    value,
    days,
    expiresAt: expires.toISOString(),
  };
}

export function dealWords(type, value) {
  if (type === 'amount') {
    return '$' + (Number.isInteger(value) ? value : Number(value).toFixed(2)) + ' off';
  }
  return `${value}% off`;
}

/* ----------------------------------------------------------------- making */

export async function handleCouponCreate(request, env, now = Date.now()) {
  if (!env.SNIPCART_SECRET) return json({ error: 'Snipcart is not configured.' }, 500);

  const input = await request.json().catch(() => ({}));

  let plan;
  try {
    plan = buildCoupon(input, makeCode(), now);
  } catch (err) {
    if (err instanceof CouponError) return json({ error: err.message }, 400);
    throw err;
  }

  let created;
  try {
    created = await postJson(env, '/discounts', plan.body);
  } catch (err) {
    return json({ error: 'Snipcart would not take it: ' + String(err?.message || err).slice(0, 200) }, 502);
  }

  return json({
    ok: true,
    code: plan.body.code,
    id: created?.id || '',
    label: plan.label,
    deal: dealWords(plan.type, plan.value),
    days: plan.days,
    expiresAt: plan.expiresAt,
  });
}

/* ------------------------------------------------------------------ recent */

function niceDate(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (isNaN(at)) return '';
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

/**
 * The ones made here, newest first, with whether they were used. Read straight
 * off Snipcart so there is nothing to keep in step.
 */
export async function recentCoupons(env, now = Date.now(), limit = 8) {
  if (!env.SNIPCART_SECRET) return [];

  let rules;
  try {
    rules = await listDiscounts(env);
  } catch {
    return null;
  }

  return rules
    .filter((r) => typeof r?.name === 'string' && r.name.startsWith(ONE_OFF_PREFIX))
    .map((r) => ({
      label: r.name.slice(ONE_OFF_PREFIX.length),
      code: r.code || '',
      deal: r.type === 'FixedAmount' ? dealWords('amount', Number(r.amount)) : dealWords('percent', Number(r.rate)),
      used: (Number(r.numberOfUsages) || 0) > 0,
      expired: Boolean(r.expires && Date.parse(r.expires) <= now),
      expires: r.expires || '',
      archived: Boolean(r.archived),
      createdAt: r.creationDate || '',
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

/* --------------------------------------------------------------- the card */

export function renderCouponCard(recent, { ready = true } = {}) {
  const rows = recent === null
    ? '<tr><td colspan="4" class="soft">Snipcart could not be read.</td></tr>'
    : (recent.length ? recent.map((c) => `<tr>
        <td>${esc(c.label)}</td>
        <td><code class="ccode">${esc(c.code)}</code></td>
        <td class="soft">${esc(c.deal)}</td>
        <td>${c.used
          ? '<span class="pill good">used</span>'
          : c.archived
            ? '<span class="pill done">archived</span>'
            : c.expired
              ? '<span class="pill bad">expired</span>'
              : `<span class="pill done">good to ${esc(niceDate(c.expires))}</span>`}</td>
      </tr>`).join('') : '<tr><td colspan="4" class="soft">None made yet.</td></tr>');

  return `<section id="coupon" class="card">
    <div class="cardhead">
      <h2>One-off coupon</h2>
      <span class="cardnote">a code for one person, made here and sent by you</span>
    </div>

    <p class="hint">
      For when somebody emails and something needs putting right. It makes a
      single-use code, shows it to you, and stops &mdash; <b>it does not email
      anyone</b>, so the message is yours to write. The code works once, on any
      cart, until it expires.
    </p>
    <p class="hint">
      It will not stack on a storewide sale. If one is running, whoever uses this
      gets the better of the two, not both.
    </p>

    ${ready ? '' : `<p class="banner">
      Snipcart is not configured, so nothing can be minted. See the README.
    </p>`}

    <form id="couponform" class="qform"${ready ? '' : ' hidden'}>
      <div class="qgrid">
        <label class="qfield qwide">
          <span>Who is it for <em>(only you see this)</em></span>
          <input type="text" name="label" required maxlength="${LABEL_MAX}"
            placeholder="Mike, cart missed the Labor Day 15">
        </label>
        <label class="qfield qnarrow">
          <span id="couponvaluelabel">Percent off</span>
          <input type="number" name="value" min="1" max="${PERCENT_MAX}" step="1" value="15">
        </label>
        <label class="qfield qnarrow">
          <span>Good for <em>(days)</em></span>
          <input type="number" name="days" min="1" max="${DAYS_MAX}" step="1" value="${DAYS_DEFAULT}">
        </label>
      </div>

      <div class="qpayopts">
        <label class="qradio">
          <input type="radio" name="type" value="percent" checked>
          <span><b>Percent off</b></span>
        </label>
        <label class="qradio">
          <input type="radio" name="type" value="amount">
          <span><b>Dollars off</b></span>
        </label>
      </div>

      <div class="panelfoot">
        <button type="submit" class="btn" id="couponmake">Make the code</button>
        <span class="soft" id="couponsaid"></span>
      </div>
    </form>

    <div class="cmade" id="couponmade" hidden>
      <p class="clabel">Give them this</p>
      <p class="cbig" id="couponcode"></p>
      <button type="button" class="btn ghost" id="couponcopy">Copy it</button>
      <p class="hint" id="couponterms"></p>
    </div>

    <div class="tablewrap">
      <table class="rtable">
        <thead><tr><th>Who</th><th>Code</th><th>Deal</th><th>State</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

export const COUPON_STYLES = `
.cmade{margin:14px 0 4px;padding:18px 20px;border:1px solid var(--ink);border-radius:3px;
  background:#0F0F0F;color:#EBE8E1;text-align:center}
.cmade[hidden]{display:none}
.clabel{margin:0 0 8px;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#A9A59B}
.cbig{margin:0 0 12px;font-family:'Courier New',Courier,monospace;font-weight:700;font-size:30px;
  letter-spacing:5px}
.cmade .btn{border-color:#A9A59B;color:#EBE8E1;background:transparent}
.cmade .hint{color:#A9A59B;margin:10px 0 0}
.ccode{font-family:'Courier New',Courier,monospace;font-size:12.5px;letter-spacing:1px}
`;

/**
 * Runs inside the dashboard page. Makes the code, shows it big, and copies it.
 * Nothing here sends anything; the copy button is the whole delivery mechanism.
 */
export const COUPON_SCRIPT = `
(function(){
  var form = document.getElementById('couponform');
  if (!form) return;

  var made = document.getElementById('couponmade');
  var codeEl = document.getElementById('couponcode');
  var termsEl = document.getElementById('couponterms');
  var saidEl = document.getElementById('couponsaid');
  var btn = document.getElementById('couponmake');
  var copyBtn = document.getElementById('couponcopy');
  var valueLabel = document.getElementById('couponvaluelabel');
  var toastEl = document.getElementById('toast');
  var toastTimer;

  function toast(msg, bad){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, 6000);
  }

  function kind(){
    var el = form.querySelector('input[name=type]:checked');
    return el ? el.value : 'percent';
  }

  form.addEventListener('change', function(){
    var dollars = kind() === 'amount';
    valueLabel.textContent = dollars ? 'Dollars off' : 'Percent off';
    form.value.step = dollars ? '0.01' : '1';
    form.value.max = dollars ? '${AMOUNT_MAX}' : '${PERCENT_MAX}';
  });

  form.addEventListener('submit', function(e){
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Making\\u2026';
    saidEl.textContent = '';

    fetch('/dashboard/api/coupon', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
      body: JSON.stringify({
        label: form.label.value,
        type: kind(),
        value: form.value.value,
        days: form.days.value
      })
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    }).then(function(data){
      codeEl.textContent = data.code;
      termsEl.textContent = data.deal + ', works once, good for ' + data.days +
        (data.days === 1 ? ' day' : ' days') + '. It does not stack on a sale.';
      made.hidden = false;
      saidEl.textContent = 'Made for ' + data.label + '.';
      toast('Code made. Copy it and send it yourself.');
      form.label.value = '';
    }).catch(function(err){
      toast(err.message, true);
    }).then(function(){
      btn.disabled = false;
      btn.textContent = 'Make the code';
    });
  });

  // Selecting the code is the fallback, and it has to actually happen. Telling
  // somebody to "select it by hand" while leaving nothing selected is the kind
  // of dead end that makes a button worse than no button.
  function selectCode(){
    var range = document.createRange();
    range.selectNodeContents(codeEl);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Selected. Press Ctrl+C.');
  }

  copyBtn.addEventListener('click', function(){
    var done = function(){
      copyBtn.textContent = 'Copied';
      setTimeout(function(){ copyBtn.textContent = 'Copy it'; }, 2000);
    };
    // The clipboard API exists on plenty of pages where it still refuses —
    // an unfocused window is enough — so the rejection has to land somewhere
    // useful rather than in a dead end.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(codeEl.textContent).then(done, selectCode);
    } else {
      selectCode();
    }
  });
})();
`;
