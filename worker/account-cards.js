/**
 * Cards on file, for signed-in customers.
 *
 * Stripe keeps the cards. The card number goes from the customer's browser
 * straight to Stripe through Stripe's own card field; this Worker never sees
 * it, and the account record holds nothing but the Stripe customer id and a
 * count. What the page shows — brand, last four, expiry — is read back from
 * Stripe each time.
 *
 * Adding one: the account page asks /api/account/cards/setup for a Stripe
 * SetupIntent on the customer's own Stripe customer (made the first time),
 * and Stripe's card field confirms it in the browser.
 *
 * Paying with one: through the same Snipcart custom gateway as Google Pay and
 * Apple Pay (worker/wallet.js). When the checkout email has an account with a
 * card on file, Snipcart's payment step lists "Saved card" next to the wallet.
 * It opens /pay?with=card, which only works signed in, as that same email.
 * The buyer picks a card and types its CVC — a stolen or borrowed session can
 * see the last four digits, but cannot spend the card without the back of
 * it. The PaymentIntent is made here, for Snipcart's amount, on that
 * customer's card only; the browser confirms it with the CVC (and any bank
 * check), and /api/wallet/confirm settles it with Snipcart exactly as it
 * settles a wallet payment.
 *
 * Routes (wired in index.js)
 *   GET  /api/account/cards           the cards on file
 *   POST /api/account/cards/setup     a SetupIntent for the card field
 *   POST /api/account/cards/remove    take one off
 *   GET  /pay?with=card&publicToken=  checkout: pay with a saved card
 *   POST /api/wallet/saved-intent     checkout: the PaymentIntent for it
 */

import { esc, json, money } from './lib.js';
import {
  stripe, walletConfigured, validatePublicToken, paymentSession, readSession,
  testModeAllows, walletPage, SAVED_METHOD_ID, SAVED_METHOD_NAME,
} from './wallet.js';
import { accountsConfigured, cleanEmail, getAccount, putAccount } from './account-store.js';
import { currentAccount, postProblem } from './accounts.js';

export const MAX_CARDS = 5;

export function cardsReady(env) {
  return !!(env && env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY);
}

const PM_ID = /^pm_[A-Za-z0-9_]+$/;

export function cardView(pm) {
  const card = (pm && pm.card) || {};
  return {
    id: pm.id,
    brand: String(card.brand || 'card'),
    last4: String(card.last4 || ''),
    expMonth: Number(card.exp_month) || 0,
    expYear: Number(card.exp_year) || 0,
  };
}

export async function listCards(env, account) {
  if (!account.stripeCustomerId) return [];
  const res = await stripe(env, 'GET',
    `/customers/${encodeURIComponent(account.stripeCustomerId)}/payment_methods?type=card&limit=10`);
  return (Array.isArray(res && res.data) ? res.data : []).map(cardView);
}

/** The count is what the checkout reads to decide whether to offer a card. */
async function keepCount(env, account, cards) {
  if ((Number(account.cardCount) || 0) !== cards.length) {
    account.cardCount = cards.length;
    await putAccount(env, account);
  }
}

async function ensureCustomer(env, account) {
  if (account.stripeCustomerId) return account;
  const customer = await stripe(env, 'POST', '/customers', {
    email: account.email,
    name: `${account.firstName} ${account.lastName}`.trim(),
    'metadata[rawhide_account]': account.id,
  }, { idempotencyKey: 'rawhide-account-' + account.id });
  account.stripeCustomerId = customer.id;
  await putAccount(env, account);
  return account;
}

/** A payment method that belongs to this account's Stripe customer, or null. */
async function ownedCard(env, account, id) {
  if (!account.stripeCustomerId || typeof id !== 'string' || !PM_ID.test(id)) return null;
  const pm = await stripe(env, 'GET', '/payment_methods/' + encodeURIComponent(id)).catch(() => null);
  if (!pm || pm.customer !== account.stripeCustomerId) return null;
  return pm;
}

/* ------------------------------------------------------- the account page */

export async function routeCards(path, request, env) {
  if (!accountsConfigured(env)) return json({ off: true, error: 'Accounts are not switched on yet.' }, 503);
  const who = await currentAccount(request, env);
  if (!who) return json({ signedIn: false, error: 'Sign in first.' }, 401);
  const account = who.account;

  if (path === '/api/account/cards') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    if (!cardsReady(env)) return json({ enabled: false, cards: [] });
    try {
      const cards = await listCards(env, account);
      await keepCount(env, account, cards);
      return json({ enabled: true, cards, max: MAX_CARDS });
    } catch (err) {
      console.error('account cards: list failed', err?.message || err);
      return json({ error: 'Your cards could not be loaded right now.' }, 502);
    }
  }

  const problem = postProblem(request);
  if (problem) return problem;
  if (!cardsReady(env)) return json({ error: 'Saving a card is not switched on yet.' }, 503);

  if (path === '/api/account/cards/setup') {
    const cards = await listCards(env, account).catch(() => []);
    if (cards.length >= MAX_CARDS) {
      return json({ error: `That is ${MAX_CARDS} cards. Remove one to add another.` }, 400);
    }
    await ensureCustomer(env, account);
    const setup = await stripe(env, 'POST', '/setup_intents', {
      customer: account.stripeCustomerId,
      'payment_method_types[0]': 'card',
      usage: 'on_session',
      'metadata[rawhide_account]': account.id,
    });
    return json({ clientSecret: setup.client_secret, publishableKey: env.STRIPE_PUBLISHABLE_KEY });
  }

  if (path === '/api/account/cards/remove') {
    const body = await request.json().catch(() => ({}));
    const pm = await ownedCard(env, account, body && body.id);
    if (!pm) return json({ error: 'That card is not on your account.' }, 404);
    await stripe(env, 'POST', `/payment_methods/${encodeURIComponent(pm.id)}/detach`, {});
    const cards = await listCards(env, account).catch(() => null);
    if (cards) await keepCount(env, account, cards);
    return json({ ok: true, cards: cards || [] });
  }

  return json({ error: 'Not found.' }, 404);
}

/* --------------------------------------------------------------- checkout */

/**
 * For wallet.handleMethods: "Saved card", when the email typed at checkout
 * has an account with a card on file. It shows nothing but the words — no
 * last four — because anybody can type any email into a checkout.
 */
export async function savedCardOffer(env, token, rawSession, origin) {
  if (!accountsConfigured(env) || !cardsReady(env)) return null;
  const email = cleanEmail(rawSession && rawSession.invoice && rawSession.invoice.email);
  if (!email) return null;
  const account = await getAccount(env, email).catch(() => null);
  if (!account || !(Number(account.cardCount) > 0)) return null;
  return {
    id: SAVED_METHOD_ID,
    name: SAVED_METHOD_NAME,
    checkoutUrl: `${origin}/pay?publicToken=${encodeURIComponent(token)}&with=card`,
  };
}

/** Where the order is going, so the buyer sees it before paying. */
function shipToLine(rawSession) {
  const inv = (rawSession && rawSession.invoice) || {};
  const a = inv.shippingAddress || inv.billingAddress || {};
  const street = a.address1 || a.streetAndNumber || a.street || '';
  const parts = [a.name || a.fullName || '', street, a.city || '', [a.province || a.region || a.state || '', a.postalCode || ''].filter(Boolean).join(' ')]
    .map((p) => String(p || '').trim()).filter(Boolean);
  return parts.join(', ');
}

function brandName(brand) {
  const names = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };
  return names[String(brand).toLowerCase()] || 'Card';
}

const SAVED_STYLES = `
.sc-cards{list-style:none;margin:0 0 18px;padding:0;display:grid;gap:10px}
.sc-cards label{display:flex;align-items:center;gap:12px;border:1px solid var(--c-line-strong);padding:14px 16px;cursor:pointer;background:var(--c-bg)}
.sc-cards input{accent-color:#0F0F0F;width:18px;height:18px;margin:0}
.sc-card-name{font-family:var(--font-display);letter-spacing:.08em;text-transform:uppercase;font-size:.9rem}
.sc-card-exp{margin-left:auto;color:var(--c-text-soft);font-size:.85rem}
.sc-label{display:block;font-family:var(--font-display);font-size:.78rem;letter-spacing:.22em;text-transform:uppercase;color:var(--c-text-soft);margin:0 0 8px}
.sc-cvc{border:1px solid var(--c-line-strong);background:#fff;padding:14px 16px;max-width:160px;margin:0 0 18px}
.sc-ship{font-size:.9rem;color:var(--c-text-soft);margin:0 0 18px}
.sc-pay{width:100%;margin:0 0 12px}
`;

export async function handleSavedCardPage(request, env, origin) {
  const url = new URL(request.url);
  const token = url.searchParams.get('publicToken') || '';
  const cart = `${origin}/#/cart`;

  if (!walletConfigured(env) || !cardsReady(env) || !accountsConfigured(env)) {
    return walletPage('Not available', `<p>Saved cards are not switched on yet.
      <a href="${esc(cart)}">Go back and pay another way.</a></p>`, 503);
  }
  if (!token || !(await validatePublicToken(token))) {
    return walletPage('Link expired', `<p>This payment link is not valid any more.
      <a href="${esc(cart)}">Go back to your cart</a> and start checkout again.</p>`, 400);
  }

  let raw;
  let session;
  try {
    raw = await paymentSession(token);
    session = readSession(raw);
  } catch (err) {
    console.error('saved card: session unreadable', err.message);
    return walletPage('Link expired', `<p>We could not read this order.
      <a href="${esc(cart)}">Go back to your cart</a> and start checkout again.</p>`, 400);
  }
  const back = session.backUrl || cart;
  const goBack = `<p class="w-help"><a href="${esc(back)}">Go back and pay another way.</a></p>`;

  if (!testModeAllows(env, raw)) {
    return walletPage('Not available', `<p>Saved cards are not available for this order.</p>${goBack}`, 403);
  }

  const orderEmail = cleanEmail(raw.invoice && raw.invoice.email);
  const who = await currentAccount(request, env);
  if (!who) {
    const next = `/pay?publicToken=${encodeURIComponent(token)}&with=card`;
    return walletPage('Sign in to use your card',
      `<p>Your card is saved to your Rawhide account. Sign in with <strong>${esc(orderEmail)}</strong> and you come straight back here.</p>
       <p><a class="btn btn-primary sc-pay" href="/account?next=${encodeURIComponent(next)}">Sign In</a></p>${goBack}`, 200);
  }
  if (who.account.email !== orderEmail) {
    return walletPage('A different email',
      `<p>You are signed in as <strong>${esc(who.account.email)}</strong>, but this order is under <strong>${esc(orderEmail)}</strong>. A saved card only pays for an order under its own account's email.</p>${goBack}`, 403);
  }

  let cards;
  try {
    cards = await listCards(env, who.account);
    await keepCount(env, who.account, cards);
  } catch (err) {
    console.error('saved card: list failed', err?.message || err);
    return walletPage('Cards unavailable', `<p>Your saved cards could not be loaded right now.</p>${goBack}`, 502);
  }
  if (!cards.length) {
    return walletPage('No saved card', `<p>There is no card on your account any more.</p>${goBack}`, 200);
  }

  const lines = session.items.map((item) => {
    const qty = Number(item && item.quantity);
    const amount = Number(item && item.amount);
    return `<tr><td>${esc(item && item.name ? item.name : 'Item')}${qty > 1 ? ` <span class="w-soft">&times; ${esc(String(qty))}</span>` : ''}</td>
      <td class="w-num">${isFinite(amount) ? esc(money(amount, session.currency)) : ''}</td></tr>`;
  }).join('');
  const shipTo = shipToLine(raw);
  const options = cards.map((c, i) => `<li><label>
      <input type="radio" name="card" value="${esc(c.id)}"${i === 0 ? ' checked' : ''}>
      <span class="sc-card-name">${esc(brandName(c.brand))} &bull;&bull;&bull;&bull; ${esc(c.last4)}</span>
      <span class="sc-card-exp">${esc(String(c.expMonth).padStart(2, '0'))}/${esc(String(c.expYear).slice(-2))}</span>
    </label></li>`).join('');

  const body = `<p class="w-total-label">Total to pay</p>
    <p class="w-total">${esc(money(session.amount, session.currency))}</p>
    ${lines ? `<table class="w-lines"><tbody>${lines}</tbody></table>` : ''}
    ${shipTo ? `<p class="sc-ship">Shipping to ${esc(shipTo)}</p>` : ''}
    <ul class="sc-cards">${options}</ul>
    <span class="sc-label" id="cvc-label">CVC on the back of the card</span>
    <div id="cvc" class="sc-cvc" aria-labelledby="cvc-label"></div>
    <button id="pay" type="button" class="btn btn-primary sc-pay">Pay ${esc(money(session.amount, session.currency))}</button>
    <p id="w-status" class="w-status" aria-live="polite"></p>
    <p class="w-terms">By purchasing, you agree to our <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>
    ${goBack}`;

  return walletPage('Pay with your saved card', body, 200, {
    script: savedCardScript(token, env.STRIPE_PUBLISHABLE_KEY),
    styles: SAVED_STYLES,
  });
}

function savedCardScript(token, publishableKey) {
  const config = JSON.stringify({ pk: publishableKey, token }).replace(/</g, '\\u003c');
  return `var CFG = ${config};
(function(){
  var status = document.getElementById('w-status');
  var pay = document.getElementById('pay');
  var busy = false;
  function say(text, cls){ status.textContent = text; status.className = 'w-status' + (cls ? ' ' + cls : ''); }
  if(!window.Stripe){ say('Could not load the card form. Go back and pay another way.', 'w-bad'); pay.disabled = true; return; }

  var stripe = Stripe(CFG.pk);
  var cvc = stripe.elements().create('cardCvc', {
    placeholder: 'CVC',
    style: { base: { fontSize: '18px', color: '#0F0F0F', fontFamily: 'Georgia, serif', '::placeholder': { color: '#6B6358' } } }
  });
  cvc.mount('#cvc');

  pay.addEventListener('click', function(){
    if(busy) return;
    var picked = document.querySelector('input[name=card]:checked');
    if(!picked){ say('Pick a card.', 'w-bad'); return; }
    busy = true; pay.disabled = true;
    say('Taking your payment\\u2026');
    post('/api/wallet/saved-intent', { publicToken: CFG.token, paymentMethod: picked.value }).then(function(intent){
      return stripe.confirmCardPayment(intent.clientSecret, {
        payment_method: picked.value,
        payment_method_options: { card: { cvc: cvc } }
      });
    }).then(function(r){
      if(r.error) throw new Error(r.error.message);
      say('Paid. Recording your order\\u2026');
      return post('/api/wallet/confirm', { publicToken: CFG.token, paymentIntent: r.paymentIntent.id });
    }).then(function(done){
      window.location.replace(done.returnUrl);
    }).catch(function(err){
      busy = false; pay.disabled = false;
      say(err && err.message ? err.message : 'Something went wrong. Nothing was charged.', 'w-bad');
    });
  });

  function post(path, body){
    return fetch(path, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if(!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }
})();`;
}

/**
 * The PaymentIntent for a saved card. Every check the page could be lied to
 * about is made again here: Snipcart vouches for the token, the session is
 * signed in as the order's email, and the card belongs to that account's
 * Stripe customer. The amount is Snipcart's. The intent is not confirmed
 * here — the browser does that with the CVC.
 */
export async function handleSavedIntent(request, env) {
  const problem = postProblem(request);
  if (problem) return problem;
  if (!walletConfigured(env) || !cardsReady(env) || !accountsConfigured(env)) {
    return json({ error: 'Saved cards are not switched on yet.' }, 503);
  }

  const body = await request.json().catch(() => ({}));
  const token = body && body.publicToken;
  if (!token || !(await validatePublicToken(token))) {
    return json({ error: 'This payment link is not valid any more.' }, 401);
  }
  const raw = await paymentSession(token);
  if (!testModeAllows(env, raw)) {
    return json({ error: 'Saved cards are not available for this order. Go back and pay another way.' }, 403);
  }
  const session = readSession(raw);

  const who = await currentAccount(request, env);
  if (!who) return json({ error: 'Sign in first.' }, 401);
  if (who.account.email !== cleanEmail(raw.invoice && raw.invoice.email)) {
    return json({ error: 'This order is under a different email.' }, 403);
  }
  const pm = await ownedCard(env, who.account, body && body.paymentMethod);
  if (!pm) return json({ error: 'That card is not on your account.' }, 403);

  const intent = await stripe(env, 'POST', '/payment_intents', {
    amount: String(session.cents),
    currency: session.currency,
    customer: who.account.stripeCustomerId,
    payment_method: pm.id,
    'payment_method_types[0]': 'card',
    description: 'Rawhide City Leather order',
    'metadata[snipcart_session]': session.id,
    'metadata[method]': SAVED_METHOD_ID,
    'metadata[rawhide_account]': who.account.id,
  }, { idempotencyKey: `saved-${session.id}-${pm.id}` });

  if (!intent.client_secret) throw new Error('Stripe gave no client secret.');
  return json({ clientSecret: intent.client_secret });
}
