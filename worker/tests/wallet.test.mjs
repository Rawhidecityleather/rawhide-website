/**
 * Google Pay / Apple Pay through Snipcart's custom gateway.
 *
 * What matters: the amount always comes from Snipcart, never the browser; an
 * order is recorded only for an intent Stripe says succeeded, for this
 * session, for this amount; a settled session settles once; a refund needs
 * Snipcart's word and can only touch a payment this gateway made; and with
 * Stripe not set up, checkout is exactly what it was.
 *
 * Every call to Snipcart and Stripe is faked below, so this runs with no keys
 * and no network.
 */

import { suite, check } from './harness.mjs';
import worker from '../index.js';
import {
  handleMethods, handlePayPage, handleIntent, handleConfirm, handleReturn,
  handleRefund, handleAppleAssociation, settle, readSession, walletConfigured, METHOD_ID,
} from '../wallet.js';

const ORIGIN = 'https://rawhidecityleather.com';

function makeKV() {
  const store = new Map();
  return {
    async put(key, value) { store.set(key, value); },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    _store: store,
  };
}

function session(extra = {}) {
  return {
    id: 'sess_1',
    invoice: {
      amount: 176.55,
      currency: 'USD',
      items: [
        { type: 'Item', name: 'Fully Custom Adjustable Radio Strap', quantity: 1, amount: 165 },
        { type: 'Tax', name: 'Sales tax', quantity: 1, amount: 11.55 },
      ],
    },
    paymentAuthorizationRedirectUrl: 'https://rawhidecityleather.com/#/checkout',
    ...extra,
  };
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The network, faked. `good` is the only public token Snipcart vouches for,
 * `valid-token` the only request token; every Stripe intent lives in
 * state.intents.
 */
function fakeNet(state) {
  return async (input, init = {}) => {
    const url = String(input);
    const method = (init.method || 'GET').toUpperCase();
    state.calls.push({ url, method, init });

    if (url.includes('/custom-payment-gateway/validate')) {
      return new Response('', { status: url.includes('publicToken=good') ? 200 : 401 });
    }
    if (url.includes('/custom-payment-gateway/payment-session')) return jsonRes(state.session);
    if (url.includes('/private/custom-payment-gateway/payment')) {
      state.snipcartPayment = JSON.parse(init.body);
      state.snipcartAuth = init.headers.Authorization;
      if (state.snipcartFails) return jsonRes({ message: 'Payment session already processed.' }, 400);
      return jsonRes({ returnUrl: ORIGIN + '/#/order/abc' });
    }
    if (url.includes('app.snipcart.com/api/requestvalidation/')) {
      return new Response('{}', { status: url.endsWith('/valid-token') ? 200 : 404 });
    }
    if (url === 'https://api.stripe.com/v1/payment_intents' && method === 'POST') {
      state.intentBody = new URLSearchParams(init.body);
      state.intentHeaders = init.headers;
      return jsonRes({ id: 'pi_new', client_secret: 'pi_new_secret_abc', status: 'requires_payment_method' });
    }
    if (url.startsWith('https://api.stripe.com/v1/payment_intents/')) {
      const id = decodeURIComponent(url.split('/').pop());
      return state.intents[id]
        ? jsonRes(state.intents[id])
        : jsonRes({ error: { message: 'No such payment_intent: ' + id } }, 404);
    }
    if (url === 'https://api.stripe.com/v1/refunds' && method === 'POST') {
      state.refundBody = new URLSearchParams(init.body);
      state.refundHeaders = init.headers;
      return jsonRes({ id: 're_1', status: 'succeeded' });
    }
    if (url.startsWith('https://stripe.com/files/apple-pay/')) return new Response('APPLE-FILE');
    throw new Error('unexpected fetch ' + method + ' ' + url);
  };
}

function intent(id, extra = {}) {
  return { id, status: 'succeeded', amount: 17655, currency: 'usd', metadata: { snipcart_session: 'sess_1', method: METHOD_ID }, ...extra };
}

const post = (path, body, headers = {}) => new Request(ORIGIN + path, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const get = (path) => new Request(ORIGIN + path);

export default async function run() {
  const original = globalThis.fetch;
  const state = { calls: [], session: session(), intents: {}, snipcartFails: false };
  globalThis.fetch = fakeNet(state);
  const env = { STRIPE_SECRET_KEY: 'sk_test_never', STRIPE_PUBLISHABLE_KEY: 'pk_test_shown', SNIPCART_SECRET: 'snip-secret', SNIPCART_GATEWAY_KEY: 'gw-key', QUOTES: makeKV() };
  const stripeCalls = () => state.calls.filter((c) => c.url.startsWith('https://api.stripe.com')).length;
  const snipcartPayments = () => state.calls.filter((c) => c.url.includes('/private/custom-payment-gateway/payment')).length;

  try {
    suite('wallet — reading the session');

    const s = readSession(session());
    check('the amount is in cents, rounded once', s.cents === 17655);
    check('the currency is lowercased for Stripe', s.currency === 'usd');
    check('the items come along for the page', s.items.length === 2);
    check('the way back to the card form is kept', s.backUrl === ORIGIN + '/#/checkout');
    check('a session with no amount is refused', () => { try { readSession(session({ invoice: { amount: 0 } })); return false; } catch (e) { return e.message.includes('no amount'); } });
    check('a session with no invoice is refused', () => { try { readSession({ id: 'x' }); return false; } catch { return true; } });
    check('a session with no id is refused', () => { try { readSession({ invoice: { amount: 5 } }); return false; } catch { return true; } });
    check('$0.10 does not become 9 cents', readSession(session({ invoice: { amount: 0.1 } })).cents === 10);

    suite('wallet — switched off');

    const bare = {};
    check('nothing configured is not configured', walletConfigured(bare) === false);
    check('only the secret key is not configured', walletConfigured({ STRIPE_SECRET_KEY: 'x', SNIPCART_SECRET: 'y' }) === false);
    check('without the gateway key it is not configured', walletConfigured({ ...env, SNIPCART_GATEWAY_KEY: '' }) === false);
    check('all four keys is configured', walletConfigured(env) === true);
    const before = state.calls.length;
    const offMethods = await handleMethods(post('/api/wallet/methods', { publicToken: 'good' }), bare, ORIGIN);
    check('the methods list is empty, so checkout is unchanged', offMethods.status === 200 && (await offMethods.json()).length === 0);
    check('and nothing was asked of anyone', state.calls.length === before);
    check('the pay page says it is not switched on', (await handlePayPage(get('/pay?publicToken=good'), bare, ORIGIN)).status === 503);
    check('an intent is refused', (await handleIntent(post('/api/wallet/intent', { publicToken: 'good' }), bare)).status === 503);
    check('a confirm is refused', (await handleConfirm(post('/api/wallet/confirm', { publicToken: 'good', paymentIntent: 'pi_x' }), bare, ORIGIN)).status === 503);
    check('a refund is refused', (await handleRefund(post('/api/wallet/refund', { paymentId: 'pi_x', amount: 1 }), bare)).status === 503);

    suite('wallet — what Snipcart is offered');

    check('GET is refused', (await handleMethods(get('/api/wallet/methods'), env, ORIGIN)).status === 405);
    check('no token is a 400', (await handleMethods(post('/api/wallet/methods', {}), env, ORIGIN)).status === 400);
    check('a token Snipcart does not vouch for is a 401', (await handleMethods(post('/api/wallet/methods', { publicToken: 'forged' }), env, ORIGIN)).status === 401);
    const methods = await (await handleMethods(post('/api/wallet/methods', { publicToken: 'good' }), env, ORIGIN)).json();
    check('one method comes back', methods.length === 1 && methods[0].id === METHOD_ID);
    check('named for what the buyer sees', methods[0].name === 'Google Pay / Apple Pay');
    check('pointing at our pay page with the token on it', methods[0].checkoutUrl === ORIGIN + '/pay?publicToken=good');

    suite('wallet — the pay page');

    check('a bad token is turned away', (await handlePayPage(get('/pay?publicToken=forged'), env, ORIGIN)).status === 400);
    check('no token is turned away', (await handlePayPage(get('/pay'), env, ORIGIN)).status === 400);
    const pageRes = await handlePayPage(get('/pay?publicToken=good'), env, ORIGIN);
    const html = await pageRes.text();
    check('it renders', pageRes.status === 200);
    check('the total is Snipcart\'s, to the cent', html.includes('$176.55'));
    check('the lines are listed', html.includes('Fully Custom Adjustable Radio Strap') && html.includes('Sales tax'));
    check('the publishable key is on the page', html.includes('pk_test_shown'));
    check('the secret key is not', !html.includes('sk_test_never'));
    check('the token is handed to the script', html.includes('"token":"good"'));
    check('the amount the buttons charge is in cents', html.includes('"amount":17655'));
    check('the return url carries the token', html.includes('/api/wallet/return?publicToken=good'));
    check('Stripe.js is loaded', html.includes('https://js.stripe.com/v3/'));
    check('the way back to the card form is Snipcart\'s own checkout', html.includes('href="https://rawhidecityleather.com/#/checkout"'));
    check('search engines are told to skip it', html.includes('noindex') && pageRes.headers.get('x-robots-tag') === 'noindex');
    check('it is never cached', pageRes.headers.get('cache-control') === 'no-store');
    check('the wallet sheet is allowed on this page', (pageRes.headers.get('permissions-policy') || '').includes('payment=*'));
    state.session = session({ invoice: { amount: 50, currency: 'usd', items: [{ name: '<script>alert(1)</script>', quantity: 2, amount: 25 }] } });
    const hostile = await (await handlePayPage(get('/pay?publicToken=good'), env, ORIGIN)).text();
    check('an item name cannot inject markup', !hostile.includes('<script>alert') && hostile.includes('&lt;script&gt;'));
    check('a quantity above one is shown', hostile.includes('&times; 2'));
    state.session = session();
    state.session.paymentAuthorizationRedirectUrl = undefined;
    const noBack = await (await handlePayPage(get('/pay?publicToken=good'), env, ORIGIN)).text();
    check('with no checkout url from Snipcart the way back is the cart', noBack.includes('href="https://rawhidecityleather.com/#/cart"'));
    state.session = session();

    suite('wallet — making the intent');

    check('a bad token makes no intent', (await handleIntent(post('/api/wallet/intent', { publicToken: 'forged' }), env)).status === 401 && !state.intentBody);
    const intentRes = await handleIntent(post('/api/wallet/intent', { publicToken: 'good' }), env);
    const intentJson = await intentRes.json();
    check('the browser gets a client secret', intentRes.status === 200 && intentJson.clientSecret === 'pi_new_secret_abc');
    check('the amount is Snipcart\'s, in cents', state.intentBody.get('amount') === '17655');
    check('in Snipcart\'s currency', state.intentBody.get('currency') === 'usd');
    check('the intent remembers which session it is for', state.intentBody.get('metadata[snipcart_session]') === 'sess_1');
    check('and that this gateway made it', state.intentBody.get('metadata[method]') === METHOD_ID);
    check('a second tap gets the same intent, not a second charge', state.intentHeaders['Idempotency-Key'] === 'wallet-sess_1');
    check('the secret key is the bearer', state.intentHeaders.Authorization === 'Bearer sk_test_never');

    suite('wallet — recording the order');

    state.intents = {
      pi_unpaid: intent('pi_unpaid', { status: 'requires_payment_method' }),
      pi_short: intent('pi_short', { amount: 16500 }),
      pi_other: intent('pi_other', { metadata: { snipcart_session: 'sess_9' } }),
      pi_euro: intent('pi_euro', { currency: 'eur' }),
      pi_ok: intent('pi_ok'),
    };
    const paymentsBefore = snipcartPayments();
    check('junk details are a 400', (await settle(env, ORIGIN, 'good', 'drop table')).status === 400);
    check('a bad token is a 401', (await settle(env, ORIGIN, 'forged', 'pi_ok')).status === 401);
    const unpaid = await settle(env, ORIGIN, 'good', 'pi_unpaid');
    check('an unpaid intent records nothing', unpaid.ok === false && unpaid.status === 402);
    check('and says nothing was charged', unpaid.error.includes('Nothing was charged'));
    check('a paid intent for less than the order is refused', (await settle(env, ORIGIN, 'good', 'pi_short')).status === 409);
    check('a paid intent for another session is refused', (await settle(env, ORIGIN, 'good', 'pi_other')).status === 409);
    check('a paid intent in another currency is refused', (await settle(env, ORIGIN, 'good', 'pi_euro')).status === 409);
    let ghost = '';
    try { await settle(env, ORIGIN, 'good', 'pi_ghost'); } catch (e) { ghost = e.message; }
    check('an intent Stripe has never heard of is an error, not an order', ghost.includes('Stripe returned 404'));
    check('none of those reached Snipcart', snipcartPayments() === paymentsBefore);

    const done = await settle(env, ORIGIN, 'good', 'pi_ok');
    check('a paid, matching intent records the order', done.ok === true);
    check('and hands back Snipcart\'s confirmation url', done.returnUrl === ORIGIN + '/#/order/abc');
    check('Snipcart was told which session', state.snipcartPayment.paymentSessionId === 'sess_1');
    check('that it is processed', state.snipcartPayment.state === 'processed');
    check('with the Stripe intent as the transaction', state.snipcartPayment.transactionId === 'pi_ok');
    check('and where to send a refund', state.snipcartPayment.links.refunds === ORIGIN + '/api/wallet/refund');
    check('signed with the gateway key, not the store secret', state.snipcartAuth === 'Bearer gw-key');
    const again = await settle(env, ORIGIN, 'good', 'pi_ok');
    check('settling it twice gives the same answer', again.ok === true && again.returnUrl === done.returnUrl && again.repeat === true);
    check('without a second word to Snipcart', snipcartPayments() === paymentsBefore + 1);

    state.session = session({ id: 'sess_2' });
    state.intents.pi_two = intent('pi_two', { metadata: { snipcart_session: 'sess_2' } });
    state.snipcartFails = true;
    const stuck = await settle(env, ORIGIN, 'good', 'pi_two');
    check('Snipcart refusing after the charge is reported, not hidden', stuck.ok === false && stuck.status === 502 && stuck.paid === true);
    check('with the reference the buyer needs', stuck.error.includes('pi_two') && stuck.error.includes('rawhidecityleather@gmail.com'));
    check('and it is not marked settled', (await env.QUOTES.get('wallet:settled:sess_2')) === null);
    state.snipcartFails = false;
    state.session = session();

    suite('wallet — the two doors in');

    const confirmRes = await handleConfirm(post('/api/wallet/confirm', { publicToken: 'good', paymentIntent: 'pi_ok' }), env, ORIGIN);
    check('the JSON door answers with the url', confirmRes.status === 200 && (await confirmRes.json()).returnUrl === ORIGIN + '/#/order/abc');
    // A settled session answers settled whatever comes next, so the refusals
    // need a session nothing has settled.
    state.session = session({ id: 'sess_3' });
    const confirmBad = await handleConfirm(post('/api/wallet/confirm', { publicToken: 'good', paymentIntent: 'pi_unpaid' }), env, ORIGIN);
    check('and with the refusal', confirmBad.status === 402 && (await confirmBad.json()).error.includes('did not go through'));
    check('GET on it is refused', (await handleConfirm(get('/api/wallet/confirm'), env, ORIGIN)).status === 405);
    state.session = session();
    const back = await handleReturn(get('/api/wallet/return?publicToken=good&payment_intent=pi_ok&redirect_status=succeeded'), env, ORIGIN);
    check('the redirect door sends the buyer on to Snipcart', back.status === 303 && back.headers.get('location') === ORIGIN + '/#/order/abc');
    state.session = session({ id: 'sess_3' });
    const backBad = await handleReturn(get('/api/wallet/return?publicToken=good&payment_intent=pi_unpaid'), env, ORIGIN);
    check('or shows why not', backBad.status === 402 && (await backBad.text()).includes('did not go through'));
    state.session = session();

    suite('wallet — refunds');

    state.intents.pi_foreign = { id: 'pi_foreign', status: 'succeeded', amount: 5000, currency: 'usd', metadata: {} };
    check('GET is refused', (await handleRefund(get('/api/wallet/refund'), env)).status === 405);
    check('nobody vouching for it is a 401', (await handleRefund(post('/api/wallet/refund', { paymentId: 'pi_ok', amount: 25 }), env)).status === 401);
    check('a forged request token is a 401', (await handleRefund(post('/api/wallet/refund', { paymentId: 'pi_ok', amount: 25 }, { 'X-Snipcart-RequestToken': 'forged' }), env)).status === 401);
    check('a forged public token is a 401', (await handleRefund(post('/api/wallet/refund', { paymentId: 'pi_ok', amount: 25, publicToken: 'forged' }), env)).status === 401);
    check('and none of that reached Stripe', !state.refundBody);
    const okHeaders = { 'X-Snipcart-RequestToken': 'valid-token' };
    check('a junk payment id is a 400', (await handleRefund(post('/api/wallet/refund', { paymentId: 'ch_123', amount: 25 }, okHeaders), env)).status === 400);
    check('no amount is a 400', (await handleRefund(post('/api/wallet/refund', { paymentId: 'pi_ok' }, okHeaders), env)).status === 400);
    check('a payment this gateway did not make is refused', (await handleRefund(post('/api/wallet/refund', { paymentId: 'pi_foreign', amount: 25 }, okHeaders), env)).status === 404);
    check('still nothing reached Stripe\'s refunds', !state.refundBody);
    const refund = await handleRefund(post('/api/wallet/refund', { paymentId: 'pi_ok', amount: 25 }, okHeaders), env);
    check('a vouched-for refund goes through', refund.status === 200 && (await refund.json()).refundId === 're_1');
    check('for the right payment', state.refundBody.get('payment_intent') === 'pi_ok');
    check('in cents', state.refundBody.get('amount') === '2500');
    check('and cannot be run twice by a retry', state.refundHeaders['Idempotency-Key'] === 'wallet-refund-pi_ok-2500');
    state.refundBody = null;
    const viaPublic = await handleRefund(post('/api/wallet/refund', { paymentId: 'pi_ok', amount: 10, publicToken: 'good' }), env);
    check('a public token Snipcart vouches for is enough too', viaPublic.status === 200 && state.refundBody.get('amount') === '1000');

    suite('wallet — Apple Pay domain file');

    const apple = await handleAppleAssociation();
    check('Stripe\'s file is served from here', apple.status === 200 && (await apple.text()) === 'APPLE-FILE');
    check('as plain text', (apple.headers.get('content-type') || '').startsWith('text/plain'));

    suite('wallet — through the Worker');

    const wenv = {
      ...env,
      SLIP_USER: 'dev', SLIP_PASS: 'dev',
      ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    };
    const via = (req) => worker.fetch(req, wenv);
    const m = await via(post('/api/wallet/methods', { publicToken: 'good' }));
    check('Snipcart can ask for the methods with no login', m.status === 200 && (await m.json())[0].id === METHOD_ID);
    const p = await via(get('/pay?publicToken=good'));
    check('the buyer can open the pay page with no login', p.status === 200 && (await p.text()).includes('$176.55'));
    check('and the wallet sheet is allowed there', (p.headers.get('permissions-policy') || '').includes('payment=*'));
    const i = await via(post('/api/wallet/intent', { publicToken: 'good' }));
    check('the browser can ask for an intent', i.status === 200 && (await i.json()).clientSecret === 'pi_new_secret_abc');
    const c = await via(post('/api/wallet/confirm', { publicToken: 'good', paymentIntent: 'pi_ok' }));
    check('and confirm', c.status === 200);
    const r = await via(post('/api/wallet/refund', { paymentId: 'pi_ok', amount: 5 }, okHeaders));
    check('Snipcart can refund', r.status === 200);
    const a = await via(get('/.well-known/apple-developer-merchantid-domain-association'));
    check('Apple can fetch the domain file', a.status === 200 && (await a.text()) === 'APPLE-FILE');
    check('an unknown wallet path is a 404', (await via(get('/api/wallet/nothing'))).status === 404);
    state.session = session({ invoice: { amount: 0 } });
    const broken = await via(post('/api/wallet/intent', { publicToken: 'good' }));
    check('a session with no amount is an error the browser can show', broken.status === 502 && (await broken.json()).error.includes('no amount'));
    state.session = session();
    const store = await via(get('/shop.html'));
    check('the storefront still forbids the payment sheet', (store.headers.get('permissions-policy') || '').includes('payment=()'));
  } finally {
    globalThis.fetch = original;
  }
}
