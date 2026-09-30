/**
 * Google Pay and Apple Pay at checkout, through Snipcart's custom payment
 * gateway and the shop's own Stripe account.
 *
 * Snipcart has no wallet support of its own — its Stripe integration predates
 * Stripe's wallets and the feature request has sat open since 2019. What it
 * does offer is a hook: on the payment step it asks a URL of ours which extra
 * payment methods to list, and each one is a link to a page we host. So:
 *
 *   1. Snipcart POSTs /api/wallet/methods with a public token. We answer with
 *      one method, "Google Pay / Apple Pay", whose checkoutUrl is /pay on this
 *      site with that token in the query string.
 *   2. The buyer taps it and lands on /pay. The page asks Snipcart for the
 *      payment session (the amount, the lines) and shows Stripe's wallet
 *      buttons for exactly that amount.
 *   3. The buyer taps the wallet. The page asks /api/wallet/intent for a Stripe
 *      PaymentIntent, Stripe takes the payment, and the page posts the intent
 *      id to /api/wallet/confirm.
 *   4. /api/wallet/confirm re-reads the intent from Stripe (never trusting the
 *      browser for the amount), checks it is paid, for this session, for this
 *      amount, and only then tells Snipcart the session is paid. Snipcart makes
 *      the order, fires the usual webhook (Meta, quotes, the dashboard) and
 *      hands back the URL of its confirmation screen.
 *
 * Why it is worth the trouble: Stripe shows every stalled buyer reaching the
 * card form and never typing a card (Sep 2026). Nearly all of them arrive from
 * an ad, inside the Facebook or Instagram app, where a saved card is out of
 * reach. A wallet is one tap. This cannot skip Snipcart's address step — the
 * hook only fires after it — so it replaces typing sixteen digits, not the
 * whole form.
 *
 * What it refuses to do: charge without Snipcart's word on the amount, record
 * an order Stripe has not paid, or run at all without both Stripe keys — with
 * either missing the methods endpoint answers an empty list and checkout is
 * exactly what it was.
 *
 * Money lands in the same Stripe account Snipcart already charges to. Refunds
 * made from the Snipcart dashboard come back to /api/wallet/refund and go
 * through Stripe; a refund made in Stripe directly works too, Snipcart just
 * won't know about it.
 */

import { esc, money, json } from './lib.js';

const SNIPCART_PAY = 'https://payment.snipcart.com/api';
const SNIPCART_APP = 'https://app.snipcart.com/api';
const STRIPE = 'https://api.stripe.com/v1';

/** The id Snipcart shows in its own records for this payment method. */
export const METHOD_ID = 'rawhide-wallet';
export const METHOD_NAME = 'Google Pay / Apple Pay';

/** Stripe's Apple Pay domain file, served from our own /.well-known path. */
const APPLE_ASSOCIATION_URL =
  'https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association';

/**
 * A session settled once stays settled. A buyer's browser can post confirm
 * twice (a double tap, a retry after a slow network), and Snipcart would
 * refuse the second payment on a session it already closed — which would show
 * the buyer "could not record" for an order that was recorded. The first
 * answer is kept for a day under this prefix in the QUOTES namespace.
 */
const SETTLED_PREFIX = 'wallet:settled:';
const SETTLED_TTL = 24 * 60 * 60;

/**
 * While Stripe holds TEST keys a wallet payment charges nothing, but the
 * Snipcart order it makes is real. So on test keys the wallet is offered only
 * to the shop's own test order, matched on the checkout email; everyone else
 * gets the normal card checkout. Live keys switch the rule off by themselves.
 * No email on the session counts as not ours — it fails closed.
 */
const DEFAULT_TEST_EMAIL = 'rawhidecityleather@gmail.com';

export function stripeInTestMode(env) {
  return String((env && env.STRIPE_SECRET_KEY) || '').startsWith('sk_test_');
}

export function testModeAllows(env, rawSession) {
  if (!stripeInTestMode(env)) return true;
  const inv = rawSession && rawSession.invoice;
  const email = String((inv && inv.email) || '').trim().toLowerCase();
  const allowed = String((env && env.WALLET_TEST_EMAIL) || DEFAULT_TEST_EMAIL).trim().toLowerCase();
  return !!email && email === allowed;
}

export function walletConfigured(env) {
  return !!(env && env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY && env.SNIPCART_SECRET && env.SNIPCART_GATEWAY_KEY);
}

/* --------------------------------------------------------------- Snipcart */

export async function validatePublicToken(token) {
  if (!token || typeof token !== 'string' || token.length > 512) return false;
  try {
    const res = await fetch(
      `${SNIPCART_PAY}/public/custom-payment-gateway/validate?publicToken=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' } }
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function paymentSession(token) {
  const res = await fetch(
    `${SNIPCART_PAY}/public/custom-payment-gateway/payment-session?publicToken=${encodeURIComponent(token)}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`Snipcart returned ${res.status} for the payment session`);
  return res.json();
}

/**
 * The parts of a payment session this needs, checked. Snipcart's amount is in
 * dollars; Stripe wants cents, and the rounding happens exactly once, here, so
 * the page, the intent and the confirm check all agree to the cent.
 */
export function readSession(session) {
  const inv = session && session.invoice;
  const amount = Number(inv && inv.amount);
  if (!session || !session.id || !isFinite(amount) || amount <= 0) {
    throw new Error('This payment session has no amount on it.');
  }
  const currency = String((inv && inv.currency) || 'usd').toLowerCase();
  const items = Array.isArray(inv.items) ? inv.items : [];
  return {
    id: String(session.id),
    amount,
    cents: Math.round(amount * 100),
    currency,
    items,
    backUrl: typeof session.paymentAuthorizationRedirectUrl === 'string'
      ? session.paymentAuthorizationRedirectUrl : '',
  };
}

/**
 * Confirming a payment is signed with the custom gateway's own API key (the
 * one on Snipcart's custom payment gateway page), not the store's secret key.
 * Snipcart support confirmed this on Sep 30 2026; SNIPCART_SECRET gets refused.
 */
async function snipcartPayment(env, body) {
  const res = await fetch(`${SNIPCART_PAY}/private/custom-payment-gateway/payment`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.SNIPCART_GATEWAY_KEY,
      Accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data && (data.message || data.error);
    throw new Error(`Snipcart returned ${res.status}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
  }
  return data;
}

/** Snipcart's request-token check, the same one the order webhook uses. */
async function validateRequestToken(env, token) {
  if (!token) return false;
  try {
    const res = await fetch(`${SNIPCART_APP}/requestvalidation/${encodeURIComponent(token)}`, {
      headers: { Authorization: 'Basic ' + btoa(env.SNIPCART_SECRET + ':'), Accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- Stripe */

/**
 * Stripe speaks form encoding, not JSON. Nested fields go in as
 * `metadata[key]`; a flat object of those is all this ever sends.
 */
async function stripe(env, method, path, params = null, { idempotencyKey = '' } = {}) {
  const headers = { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, Accept: 'application/json' };
  let body;
  if (params) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(params).toString();
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(STRIPE + path, { method, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data && data.error && data.error.message;
    throw new Error(`Stripe returned ${res.status}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
  }
  return data;
}

/* --------------------------------------------------------------- handlers */

function readJson(request) {
  return request.json().catch(() => ({}));
}

/**
 * Snipcart asks which extra payment methods to show. One answer, or none:
 * with Stripe not set up there is nothing to offer, and an empty list leaves
 * the checkout exactly as it was rather than listing a button that 503s.
 */
export async function handleMethods(request, env, origin) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!walletConfigured(env)) return json([]);

  const body = await readJson(request);
  const token = body && body.publicToken;
  if (!token) return json({ error: 'No public token.' }, 400);
  if (!(await validatePublicToken(token))) return json({ error: 'Invalid public token.' }, 401);

  if (stripeInTestMode(env)) {
    const raw = await paymentSession(token).catch(() => null);
    if (!testModeAllows(env, raw)) return json([]);
  }

  return json([{
    id: METHOD_ID,
    name: METHOD_NAME,
    checkoutUrl: `${origin}/pay?publicToken=${encodeURIComponent(token)}`,
  }]);
}

/**
 * The page with the wallet buttons. Everything the buttons need to know — the
 * amount, the currency, the token to hand back — is read from Snipcart on the
 * server and written into the page; the browser never tells us a price.
 */
export async function handlePayPage(request, env, origin) {
  const token = new URL(request.url).searchParams.get('publicToken') || '';
  if (!walletConfigured(env)) {
    return walletPage('Not available', `<p>Google Pay and Apple Pay are not switched on yet.
      <a href="${esc(origin)}/#/cart">Go back and pay by card.</a></p>`, 503);
  }
  if (!token || !(await validatePublicToken(token))) {
    return walletPage('Link expired', `<p>This payment link is not valid any more.
      <a href="${esc(origin)}/#/cart">Go back to your cart</a> and start checkout again.</p>`, 400);
  }

  let session;
  try {
    session = readSession(await paymentSession(token));
  } catch (err) {
    console.error('wallet: session unreadable', err.message);
    return walletPage('Link expired', `<p>We could not read this order.
      <a href="${esc(origin)}/#/cart">Go back to your cart</a> and start checkout again.</p>`, 400);
  }

  return walletPage(
    'Pay with Google Pay or Apple Pay',
    renderPayBody(session, origin),
    200,
    { script: renderPayScript(session, token, env.STRIPE_PUBLISHABLE_KEY, origin) }
  );
}

/**
 * The browser asks for a PaymentIntent once the buyer has tapped a wallet
 * button. The amount comes from Snipcart, again, not from the page. The
 * session id is the idempotency key, so a second tap on a slow network gets
 * the same intent back instead of a second charge waiting to happen.
 */
export async function handleIntent(request, env) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!walletConfigured(env)) return json({ error: 'Wallet payments are not set up.' }, 503);

  const body = await readJson(request);
  const token = body && body.publicToken;
  if (!token || !(await validatePublicToken(token))) {
    return json({ error: 'This payment link is not valid any more.' }, 401);
  }

  const raw = await paymentSession(token);
  if (!testModeAllows(env, raw)) {
    return json({ error: 'Google Pay and Apple Pay are not available for this order. Go back and pay by card.' }, 403);
  }
  const session = readSession(raw);
  const intent = await stripe(env, 'POST', '/payment_intents', {
    amount: String(session.cents),
    currency: session.currency,
    'automatic_payment_methods[enabled]': 'true',
    description: 'Rawhide City Leather order',
    'metadata[snipcart_session]': session.id,
    'metadata[method]': METHOD_ID,
  }, { idempotencyKey: 'wallet-' + session.id });

  if (!intent.client_secret) throw new Error('Stripe gave no client secret.');
  return json({ clientSecret: intent.client_secret, amount: session.cents, currency: session.currency });
}

/**
 * The one step that makes an order. Stripe is the source of truth for whether
 * money moved; Snipcart is the source of truth for how much should have. Only
 * when both agree does Snipcart hear that the session is paid.
 *
 * Returns a plain result rather than a Response so the JSON route and the
 * redirect route can share it.
 */
export async function settle(env, origin, token, paymentIntentId) {
  if (!token || !paymentIntentId || typeof paymentIntentId !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) {
    return { ok: false, status: 400, error: 'Missing payment details.' };
  }
  if (!(await validatePublicToken(token))) {
    return { ok: false, status: 401, error: 'This payment link is not valid any more.' };
  }
  const session = readSession(await paymentSession(token));

  // Settled before? Same answer, no second word to Snipcart.
  const settledKey = SETTLED_PREFIX + session.id;
  if (env.QUOTES) {
    const before = await env.QUOTES.get(settledKey).catch(() => null);
    if (before) return { ok: true, returnUrl: before, repeat: true };
  }

  const intent = await stripe(env, 'GET', '/payment_intents/' + encodeURIComponent(paymentIntentId));
  if (intent.status !== 'succeeded') {
    return { ok: false, status: 402, error: 'The payment did not go through. Nothing was charged.', paymentIntent: intent.id };
  }
  const meta = intent.metadata || {};
  if (meta.snipcart_session !== session.id
      || Number(intent.amount) !== session.cents
      || String(intent.currency || '').toLowerCase() !== session.currency) {
    console.error('wallet: intent does not match session', intent.id, session.id, intent.amount, session.cents);
    return { ok: false, status: 409, error: 'That payment does not match this order.', paymentIntent: intent.id };
  }

  let placed;
  try {
    placed = await snipcartPayment(env, {
      paymentSessionId: session.id,
      state: 'processed',
      transactionId: intent.id,
      instructions: `Paid by ${METHOD_NAME} through Stripe (${intent.id}).`,
      links: { refunds: `${origin}/api/wallet/refund` },
    });
  } catch (err) {
    // The one outcome that needs a human: money moved and the order did not.
    // The intent id is in the log, in Stripe under this session id, and on the
    // buyer's screen, so it can be matched up by hand.
    console.error('wallet: PAID BUT NOT PLACED', intent.id, 'session', session.id, err.message);
    return {
      ok: false, status: 502, paid: true, paymentIntent: intent.id,
      error: 'Your payment went through, but the order could not be recorded. ' +
        'Email rawhidecityleather@gmail.com with reference ' + intent.id + ' and we will sort it out. Nothing else to pay.',
    };
  }

  const returnUrl = (placed && typeof placed.returnUrl === 'string' && placed.returnUrl) || `${origin}/`;
  if (env.QUOTES) {
    await env.QUOTES.put(settledKey, returnUrl, { expirationTtl: SETTLED_TTL }).catch(() => {});
  }
  return { ok: true, returnUrl };
}

export async function handleConfirm(request, env, origin) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!walletConfigured(env)) return json({ error: 'Wallet payments are not set up.' }, 503);
  const body = await readJson(request);
  const result = await settle(env, origin, body && body.publicToken, body && body.paymentIntent);
  if (result.ok) return json({ ok: true, returnUrl: result.returnUrl });
  const { status, ...rest } = result;
  return json(rest, status);
}

/**
 * Where Stripe sends a buyer back when a wallet needs a redirect (rare for
 * Google Pay, never for Apple Pay, but the return_url is required). Same
 * settle, then straight on to Snipcart's confirmation screen.
 */
export async function handleReturn(request, env, origin) {
  if (!walletConfigured(env)) return json({ error: 'Wallet payments are not set up.' }, 503);
  const url = new URL(request.url);
  const result = await settle(env, origin,
    url.searchParams.get('publicToken') || '',
    url.searchParams.get('payment_intent') || '');
  if (result.ok) {
    return new Response(null, { status: 303, headers: { location: result.returnUrl, 'cache-control': 'no-store' } });
  }
  return walletPage(result.paid ? 'Paid, not yet recorded' : 'Payment not completed',
    `<p>${esc(result.error)}</p>
     <p><a href="${esc(origin)}/#/cart">Back to your cart</a></p>`,
    result.status);
}

/**
 * Snipcart calling back to refund a wallet payment, after Rob presses Refund
 * on the order in Snipcart's dashboard. Proof it is Snipcart: the request
 * token on the header (validated the way the order webhook validates it), or
 * failing that a public token that Snipcart itself vouches for. Neither, and
 * nobody's money moves. The payment must also be one of ours — an intent
 * carrying a Snipcart session id — so this cannot be pointed at any other
 * charge in the account.
 */
export async function handleRefund(request, env) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!walletConfigured(env)) return json({ error: 'Wallet payments are not set up.' }, 503);

  const body = await readJson(request);
  const headerToken = request.headers.get('X-Snipcart-RequestToken');
  const vouched = (await validateRequestToken(env, headerToken))
    || (!!body.publicToken && await validatePublicToken(body.publicToken));
  if (!vouched) return json({ error: 'Could not prove this came from Snipcart.' }, 401);

  const paymentId = body && body.paymentId;
  const amount = Number(body && body.amount);
  if (!paymentId || typeof paymentId !== 'string' || !/^pi_[A-Za-z0-9_]+$/.test(paymentId)) {
    return json({ error: 'No payment id.' }, 400);
  }
  if (!isFinite(amount) || amount <= 0) return json({ error: 'No refund amount.' }, 400);

  const intent = await stripe(env, 'GET', '/payment_intents/' + encodeURIComponent(paymentId));
  if (!intent.metadata || !intent.metadata.snipcart_session) {
    return json({ error: 'That payment was not made through this gateway.' }, 404);
  }

  const cents = Math.round(amount * 100);
  const refund = await stripe(env, 'POST', '/refunds', {
    payment_intent: intent.id,
    amount: String(cents),
    'metadata[snipcart_session]': intent.metadata.snipcart_session,
  }, { idempotencyKey: `wallet-refund-${intent.id}-${cents}` });

  return json({ refundId: refund.id });
}

/**
 * Apple Pay checks the domain by fetching this file over HTTPS. Stripe hosts
 * the current one; serving it from here means nothing to keep in the repo
 * and nothing to update when Stripe rotates it.
 */
export async function handleAppleAssociation() {
  const res = await fetch(APPLE_ASSOCIATION_URL);
  if (!res.ok) return new Response('not available', { status: 502 });
  return new Response(await res.text(), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

/* ------------------------------------------------------------------- page */

function renderPayBody(session, origin) {
  const lines = session.items.map((item) => {
    const name = esc(item && item.name ? item.name : 'Item');
    const qty = Number(item && item.quantity);
    const amount = Number(item && item.amount);
    return `<tr><td>${name}${qty > 1 ? ` <span class="w-soft">&times; ${esc(String(qty))}</span>` : ''}</td>
      <td class="w-num">${isFinite(amount) ? esc(money(amount, session.currency)) : ''}</td></tr>`;
  }).join('');
  const back = session.backUrl || `${origin}/#/cart`;

  return `<p class="w-total-label">Total to pay</p>
    <p class="w-total">${esc(money(session.amount, session.currency))}</p>
    ${lines ? `<table class="w-lines"><tbody>${lines}</tbody></table>` : ''}
    <div id="wallet" class="w-buttons"></div>
    <p id="w-status" class="w-status" aria-live="polite">Loading your payment options&hellip;</p>
    <p class="w-help"><a href="${esc(back)}">Go back and pay by card instead.</a></p>`;
}

/**
 * The browser side. Stripe's Express Checkout Element draws the wallet buttons
 * the device actually has — Google Pay on Android and Chrome, Apple Pay on
 * iPhones and Safari, nothing on a device with neither, in which case the
 * page says so and points back to the card form.
 */
function renderPayScript(session, token, publishableKey, origin) {
  const config = JSON.stringify({
    pk: publishableKey,
    token,
    amount: session.cents,
    currency: session.currency,
    returnUrl: `${origin}/api/wallet/return?publicToken=${encodeURIComponent(token)}`,
  }).replace(/</g, '\\u003c');

  return `var CFG = ${config};
(function(){
  var status = document.getElementById('w-status');
  var mount = document.getElementById('wallet');
  var busy = false;
  function say(text, cls){ status.textContent = text; status.className = 'w-status' + (cls ? ' ' + cls : ''); }
  if(!window.Stripe){ say('Could not load the payment buttons. Go back and pay by card.', 'w-bad'); return; }

  var stripe = Stripe(CFG.pk);
  var elements = stripe.elements({
    mode: 'payment', amount: CFG.amount, currency: CFG.currency,
    appearance: { theme: 'stripe', variables: { colorPrimary: '#0F0F0F', borderRadius: '2px' } }
  });
  var wallet = elements.create('expressCheckout', {
    buttonType: { applePay: 'buy', googlePay: 'buy' },
    buttonHeight: 52,
    layout: { maxColumns: 1, maxRows: 2 },
    paymentMethods: { link: 'never', paypal: 'never', amazonPay: 'never', klarna: 'never' }
  });
  wallet.mount('#wallet');

  wallet.on('ready', function(ev){
    if(!ev.availablePaymentMethods){
      mount.hidden = true;
      say('No Google Pay or Apple Pay on this device. Go back and pay by card.', 'w-bad');
    } else {
      say('One tap. Nothing else to type.');
    }
  });
  wallet.on('loaderror', function(){ say('Could not load the payment buttons. Go back and pay by card.', 'w-bad'); });
  wallet.on('click', function(ev){ ev.resolve(); });

  wallet.on('confirm', function(){
    if(busy) return; busy = true;
    say('Taking your payment\\u2026');
    elements.submit().then(function(r){
      if(r && r.error) throw new Error(r.error.message);
      return post('/api/wallet/intent', { publicToken: CFG.token });
    }).then(function(intent){
      return stripe.confirmPayment({
        elements: elements,
        clientSecret: intent.clientSecret,
        confirmParams: { return_url: CFG.returnUrl },
        redirect: 'if_required'
      });
    }).then(function(r){
      if(r.error) throw new Error(r.error.message);
      say('Paid. Recording your order\\u2026');
      return post('/api/wallet/confirm', { publicToken: CFG.token, paymentIntent: r.paymentIntent.id });
    }).then(function(done){
      window.location.replace(done.returnUrl);
    }).catch(function(err){
      busy = false;
      say(err && err.message ? err.message : 'Something went wrong. Nothing was charged.', 'w-bad');
    });
  });

  function post(path, body){
    return fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if(!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }
})();`;
}

const WALLET_STYLES = `
.w-wrap{max-width:520px;margin:0 auto;padding:36px 20px 80px}
.w-head{text-align:center;margin-bottom:28px}
.w-head img{max-height:64px;width:auto;margin:0 auto 10px}
.w-tag{font-family:var(--font-stamp);font-size:.95rem;color:var(--c-text-soft);margin:0}
.w-card{background:var(--c-surface);border:1px solid var(--c-line-strong);padding:28px 24px}
.w-card h1{font-size:1.6rem;margin:0 0 18px}
.w-total-label{font-family:var(--font-display);font-size:.78rem;letter-spacing:.3em;text-transform:uppercase;color:var(--c-text-soft);margin:0 0 4px}
.w-total{font-family:var(--font-stamp);font-size:2rem;font-weight:700;margin:0 0 18px}
.w-lines{width:100%;border-collapse:collapse;margin:0 0 22px;font-size:.95rem}
.w-lines td{padding:7px 0;border-top:1px solid var(--c-line);color:var(--c-text-soft)}
.w-num{text-align:right;white-space:nowrap}
.w-soft{color:var(--c-muted)}
.w-buttons{min-height:52px;margin:0 0 12px}
.w-status{font-size:.9rem;color:var(--c-text-soft);margin:0 0 18px;text-align:center}
.w-status.w-bad{color:#8A2E1C;font-weight:600}
.w-help{text-align:center;font-size:.9rem;margin:0}
.w-help a{color:var(--c-accent);text-decoration:underline}
`;

function walletPage(title, body, status = 200, { script = '' } = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Rawhide City Leather</title>
<link rel="stylesheet" href="/assets/css/style.css">
<style>${WALLET_STYLES}</style>
${script ? '<script src="https://js.stripe.com/v3/"></script>' : ''}
</head>
<body>
<main class="w-wrap">
  <header class="w-head">
    <img src="/assets/img/logo.png" alt="Rawhide City Leather" onerror="this.remove()">
    <p class="w-tag">"We do not cut corners. We cut leather."</p>
  </header>
  <section class="w-card">
    <h1>${esc(title)}</h1>
    ${body}
  </section>
</main>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      // The storefront default is payment=(), which would switch the wallet
      // sheet off on the one page that exists to open it.
      'permissions-policy': 'payment=*, camera=(), microphone=(), geolocation=()',
    },
  });
}
