/**
 * Customer accounts: the sign-up form, the emailed code, the session, the
 * orders and their tracking, the sign-up and birthday codes, cards on file,
 * and paying with one at checkout.
 *
 * Most of it runs through worker.fetch, the way a browser reaches it, so the
 * routing in index.js is tested along with the handlers.
 */

import { suite, check } from './harness.mjs';
import worker from '../index.js';
import {
  readSignup, readDob, readPhone, readAddress, ageOn, AccountError, orderView, sixDigits,
  withAccountLinks, SESSION_COOKIE, HINT_COOKIE,
} from '../accounts.js';
import {
  welcomeDiscount, birthdayDiscount, addressKey, couponList, runBirthdays,
  WELCOME_RATE, WELCOME_DAYS, BIRTHDAY_RATE,
} from '../account-coupons.js';
import { todayEastern, endOfEasternDay, addDays } from '../account-store.js';
import { savedCardOffer } from '../account-cards.js';
import { handleMethods, settle, METHOD_ID, SAVED_METHOD_ID } from '../wallet.js';
import {
  resetCodeEmail, birthdayEmail, goodThrough,
} from '../account-mail.js';
import {
  readPassword, hashPassword, checkPassword, needsRehash, ROUNDS, PasswordError,
} from '../account-password.js';
import { installHTMLRewriterShim } from './html-rewriter-shim.mjs';

const ORIGIN = 'https://rawhidecityleather.com';
const DAY = 24 * 3600 * 1000;

/* ------------------------------------------------------------------ fakes */

function makeKV() {
  const store = new Map();
  return {
    async get(key, opts) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      const type = typeof opts === 'string' ? opts : opts && opts.type;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts = {}) { store.set(key, String(value)); store.opts = store.opts || new Map(); store.opts.set(key, opts); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
    _store: store,
  };
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Snipcart, Stripe and Brevo, faked. Orders live in net.orders and a PUT to
 * /orders/<token> really changes them, so a tracking number saved by the
 * dashboard is what the account page reads back.
 */
function makeNet() {
  const net = {
    calls: [], mail: [], discounts: [], orders: new Map(), customers: [],
    stripeCustomers: 0, setupIntents: [], intentBody: null, intentHeaders: null,
    paymentMethods: new Map(), detached: [], deletedCustomers: [], discountUses: new Map(),
    session: null, snipcartPayment: null, intents: {}, refuseDiscounts: false, failMail: false,
  };
  net.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method || 'GET').toUpperCase();
    net.calls.push({ url, method });

    if (url.includes('api.brevo.com')) {
      if (net.failMail) return new Response('down', { status: 500, statusText: 'Server Error' });
      net.mail.push(JSON.parse(init.body));
      return jsonRes({ messageId: 'm' + net.mail.length }, 201);
    }

    if (url.startsWith('https://app.snipcart.com/api/discounts')) {
      if (method === 'POST') {
        if (net.refuseDiscounts) return jsonRes({ message: 'nope' }, 500);
        const body = JSON.parse(init.body);
        const id = 'disc-' + (net.discounts.length + 1);
        net.discounts.push({ id, ...body });
        return jsonRes({ id });
      }
      const id = decodeURIComponent(url.split('/discounts/')[1] || '');
      if (id) return jsonRes({ id, numberOfUsages: net.discountUses.get(id) || 0 });
      return jsonRes({ items: [], hasMoreResults: false });
    }
    if (url.startsWith('https://app.snipcart.com/api/customers?')) {
      const email = new URL(url).searchParams.get('email');
      return jsonRes({ items: net.customers.filter((c) => c.email.toLowerCase() === email) });
    }
    if (url.startsWith('https://app.snipcart.com/api/orders?')) {
      const all = [...net.orders.values()];
      return jsonRes({ items: all, totalItems: all.length });
    }
    const custOrders = url.match(/^https:\/\/app\.snipcart\.com\/api\/customers\/([^/]+)\/orders$/);
    if (custOrders) {
      const id = decodeURIComponent(custOrders[1]);
      return jsonRes([...net.orders.values()].filter((o) => o._customer === id));
    }
    const order = url.match(/^https:\/\/app\.snipcart\.com\/api\/orders\/([^/?]+)$/);
    if (order) {
      const token = decodeURIComponent(order[1]);
      const o = net.orders.get(token);
      if (!o) return jsonRes({ message: 'not found' }, 404);
      if (method === 'PUT') Object.assign(o, JSON.parse(init.body));
      return jsonRes(o);
    }

    if (url.includes('/custom-payment-gateway/validate')) {
      return new Response('', { status: url.includes('publicToken=good') ? 200 : 401 });
    }
    if (url.includes('/custom-payment-gateway/payment-session')) return jsonRes(net.session);
    if (url.includes('/private/custom-payment-gateway/payment')) {
      net.snipcartPayment = JSON.parse(init.body);
      return jsonRes({ returnUrl: ORIGIN + '/#/order/abc' });
    }

    if (url === 'https://api.stripe.com/v1/customers' && method === 'POST') {
      net.stripeCustomers++;
      net.customerBody = new URLSearchParams(init.body);
      net.customerHeaders = init.headers;
      return jsonRes({ id: 'cus_' + net.stripeCustomers });
    }
    const delCustomer = url.match(/^https:\/\/api\.stripe\.com\/v1\/customers\/([^/?]+)$/);
    if (delCustomer && method === 'DELETE') {
      net.deletedCustomers.push(decodeURIComponent(delCustomer[1]));
      return jsonRes({ id: delCustomer[1], deleted: true });
    }
    const pms = url.match(/^https:\/\/api\.stripe\.com\/v1\/customers\/([^/]+)\/payment_methods/);
    if (pms) {
      const id = decodeURIComponent(pms[1]);
      return jsonRes({ data: [...net.paymentMethods.values()].filter((p) => p.customer === id) });
    }
    if (url === 'https://api.stripe.com/v1/setup_intents' && method === 'POST') {
      net.setupIntents.push(new URLSearchParams(init.body));
      return jsonRes({ id: 'seti_1', client_secret: 'seti_1_secret' });
    }
    const detach = url.match(/^https:\/\/api\.stripe\.com\/v1\/payment_methods\/([^/]+)\/detach$/);
    if (detach) {
      const id = decodeURIComponent(detach[1]);
      net.detached.push(id);
      const pm = net.paymentMethods.get(id);
      if (pm) pm.customer = null;
      return jsonRes({ id });
    }
    const pm = url.match(/^https:\/\/api\.stripe\.com\/v1\/payment_methods\/([^/?]+)$/);
    if (pm) {
      const found = net.paymentMethods.get(decodeURIComponent(pm[1]));
      return found ? jsonRes(found) : jsonRes({ error: { message: 'No such PaymentMethod' } }, 404);
    }
    if (url === 'https://api.stripe.com/v1/payment_intents' && method === 'POST') {
      net.intentBody = new URLSearchParams(init.body);
      net.intentHeaders = init.headers;
      return jsonRes({ id: 'pi_saved', client_secret: 'pi_saved_secret' });
    }
    if (url.startsWith('https://api.stripe.com/v1/payment_intents/')) {
      const id = decodeURIComponent(url.split('/').pop());
      return net.intents[id] ? jsonRes(net.intents[id]) : jsonRes({ error: { message: 'no' } }, 404);
    }
    throw new Error('unexpected fetch ' + method + ' ' + url);
  };
  return net;
}

function makeEnv(extra = {}) {
  return {
    ACCOUNTS: makeKV(),
    ACCOUNT_SECRET: 'pepper-for-tests',
    SNIPCART_SECRET: 'snip-secret',
    BREVO_KEY: 'brevo',
    RECOVERY_FROM: 'orders@rawhidecityleather.com',
    RECOVERY_POSTAL_ADDRESS: 'PO Box 1, Lakeland FL 33801',
    SLIP_USER: 'rob', SLIP_PASS: 'pw',
    ...extra,
  };
}

/* ------------------------------------------------------------- requests */

function post(path, body, { cookie = '', origin = '', type = 'application/json', ip = '203.0.113.9' } = {}) {
  const headers = { 'content-type': type, 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return new Request(ORIGIN + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function get(path, cookie = '') {
  return new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie, accept: 'application/json' } : { accept: 'application/json' } });
}

const call = (env, req) => worker.fetch(req, env);

/** The session cookie out of a response, ready to send back. */
function sessionFrom(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : String(res.headers.get('set-cookie') || '').split(/,(?=\s*rcl_)/);
  const raw = all.find((c) => c.trim().startsWith(SESSION_COOKIE + '='));
  return raw ? raw.trim().split(';')[0] : '';
}

function lastCode(net) {
  const m = net.mail[net.mail.length - 1];
  const found = /(\d{6})/.exec(m.subject);
  return found ? found[1] : '';
}

const SIGNUP = {
  firstName: 'Rob', lastName: 'Conover', email: 'Rob.Test@Example.com', dob: '1985-03-14',
  address: { line1: '123 N. Main Street', line2: 'Apt #4', city: 'Lakeland', state: 'fl', zip: '33801' },
  phone: '1 (863) 555-0100', birthdayEmails: true, password: 'Engine7-strap',
};

function signin(email, password, ip = '203.0.113.50') {
  return post('/api/account/signin', { email, password }, { ip });
}

/** Signs up and verifies one account. Returns the cookie. */
async function makeAccount(env, net, signup = SIGNUP) {
  await call(env, post('/api/account/signup', signup));
  const code = lastCode(net);
  const res = await call(env, post('/api/account/verify', { email: signup.email, code }));
  return sessionFrom(res);
}

/* ------------------------------------------------------------------ tests */

export default async function run() {
  const original = globalThis.fetch;
  const NOW = Date.parse('2026-10-18T16:00:00Z'); // noon Eastern, a Sunday

  try {
    /* ----------------------------------------------------------- the form */
    suite('accounts — reading the sign-up form');

    const s = readSignup(SIGNUP, NOW);
    check('email is trimmed and lowercased', s.email === 'rob.test@example.com');
    check('state is uppercased', s.address.state === 'FL');
    check('phone is ten digits, formatted, a leading 1 dropped', s.phone === '(863) 555-0100');
    check('birthday email defaults on', s.birthdayEmails === true);
    const fails = (input, field) => { try { readSignup({ ...SIGNUP, ...input }, NOW); return false; } catch (e) { return e instanceof AccountError && e.field === field; } };
    check('no first name is refused on firstName', fails({ firstName: ' ' }, 'firstName'));
    check('no last name is refused on lastName', fails({ lastName: '' }, 'lastName'));
    check('a bad email is refused on email', fails({ email: 'rob@' }, 'email'));
    check('no date of birth is refused', fails({ dob: '' }, 'dob'));
    check('February 30 is refused', fails({ dob: '1990-02-30' }, 'dob'));
    check('a future birthday is refused', fails({ dob: '2030-01-01' }, 'dob'));
    check('a 17-year-old is refused', fails({ dob: '2009-01-01' }, 'dob'));
    check('turning 18 tomorrow is still 17 today', fails({ dob: '2008-10-19' }, 'dob'));
    check('turning 18 today is old enough', readDob('2008-10-18', '2026-10-18') === '2008-10-18');
    check('ageOn counts the birthday itself', ageOn('2000-10-18', '2026-10-18') === 26 && ageOn('2000-10-19', '2026-10-18') === 25);
    check('a state the shop does not ship to is refused', fails({ address: { ...SIGNUP.address, state: 'ZZ' } }, 'state'));
    check('Puerto Rico and the USVI are taken', readAddress({ ...SIGNUP.address, state: 'PR' }).state === 'PR' && readAddress({ ...SIGNUP.address, state: 'vi' }).state === 'VI');
    check('a 4-digit ZIP is refused', fails({ address: { ...SIGNUP.address, zip: '3380' } }, 'zip'));
    check('ZIP+4 is taken', readAddress({ ...SIGNUP.address, zip: '33801-1234' }).zip === '33801-1234');
    check('no street is refused on line1', fails({ address: { ...SIGNUP.address, line1: '' } }, 'line1'));
    check('phone is optional', readPhone('') === '');
    check('a short phone is refused', (() => { try { readPhone('555-0100'); return false; } catch (e) { return e.field === 'phone'; } })());
    check('a code is always six digits', [0, 5, 999999, 4294967295].every((n) => sixDigits(() => new Uint32Array([n])).length === 6));

    /* ----------------------------------------------------- switched off */
    suite('accounts — off until configured');

    globalThis.fetch = makeNet().fetch;
    const off = await call({ SNIPCART_SECRET: 'x' }, get('/api/account/me'));
    check('with no namespace every route answers 503', off.status === 503);
    check('and says accounts are off', (await off.json()).off === true);
    const offCode = await call(makeEnv({ ACCOUNT_SECRET: '' }), post('/api/account/code', { email: 'a@example.com' }));
    check('with no secret a code request is refused, not sent', offCode.status === 503);

    /* -------------------------------------------------- sign up, verify */
    suite('accounts — sign up with an emailed code');

    let net = makeNet();
    globalThis.fetch = net.fetch;
    let env = makeEnv();

    const weak = await call(env, post('/api/account/signup', { ...SIGNUP, password: 'short' }));
    check('a short password is refused on the password field', weak.status === 400 && (await weak.json()).field === 'password');
    const noPw = await call(env, post('/api/account/signup', { ...SIGNUP, password: '' }));
    check('no password is refused', noPw.status === 400);
    check('and neither sends an email', net.mail.length === 0);

    const signup = await call(env, post('/api/account/signup', SIGNUP));
    check('the sign-up form is taken', signup.status === 200);
    check('one email goes out', net.mail.length === 1);
    check('to the address typed', net.mail[0].to[0].email === 'rob.test@example.com');
    const code = lastCode(net);
    check('with a six-digit code in the subject', /^\d{6}$/.test(code));
    check('sent transactional: no unsubscribe header on a sign-in code', !net.mail[0].headers);
    const stored = env.ACCOUNTS._store.get('code:rob.test@example.com');
    check('the code is stored hashed, never as typed', stored && !stored.includes(code));
    check('the password waits hashed with the form, never as typed', stored.includes('pbkdf2-sha256$') && !stored.includes(SIGNUP.password));
    check('no account exists until the code comes back', !env.ACCOUNTS._store.has('acct:rob.test@example.com'));
    check('and no discount is made yet', net.discounts.length === 0);

    const wrong = await call(env, post('/api/account/verify', { email: SIGNUP.email, code: code === '000000' ? '111111' : '000000' }));
    check('a wrong code is a 400', wrong.status === 400);
    check('that says how many tries are left', /4 tries left/.test((await wrong.json()).error));

    const verified = await call(env, post('/api/account/verify', { email: SIGNUP.email, code }));
    check('the right code signs in', verified.status === 200);
    const vBody = await verified.json();
    check('and says the account was made', vBody.created === true);
    const cookies = verified.headers.getSetCookie();
    const sess = cookies.find((c) => c.startsWith(SESSION_COOKIE + '='));
    check('the session cookie is HttpOnly, Secure, SameSite=Lax, 30 days',
      /HttpOnly/.test(sess) && /Secure/.test(sess) && /SameSite=Lax/.test(sess) && /Max-Age=2592000/.test(sess));
    check('the hint cookie is readable by the page and says only "1"', cookies.some((c) => c.startsWith(HINT_COOKIE + '=1;') && !/HttpOnly/.test(c)));
    const cookie = sessionFrom(verified);
    const sessionKeys = [...env.ACCOUNTS._store.keys()].filter((k) => k.startsWith('sess:'));
    check('the session is stored under a hash of the token, not the token', sessionKeys.length === 1 && !sessionKeys[0].includes(cookie.split('=')[1]));
    check('the code is gone once used', !env.ACCOUNTS._store.has('code:rob.test@example.com'));
    const reuse = await call(env, post('/api/account/verify', { email: SIGNUP.email, code }));
    check('the same code does not work twice', reuse.status === 400);

    const account = JSON.parse(env.ACCOUNTS._store.get('acct:rob.test@example.com'));
    check('the account holds the date of birth', account.dob === '1985-03-14');
    check('and the password, hashed at ' + ROUNDS + ' rounds', account.passwordHash.startsWith('pbkdf2-sha256$' + ROUNDS + '$'));
    check('nowhere in the namespace is the password as typed', ![...env.ACCOUNTS._store.values()].some((v) => String(v).includes(SIGNUP.password)));
    check('and the address', account.address.line1 === '123 N. Main Street' && account.address.zip === '33801');
    check('the birthday index is written', env.ACCOUNTS._store.has('bday:03-14:rob.test@example.com'));

    suite('accounts — the 20% sign-up code');

    check('one discount is made', net.discounts.length === 1);
    const welcome = net.discounts[0];
    check('20% off', welcome.type === 'Rate' && welcome.rate === WELCOME_RATE && WELCOME_RATE === 20);
    check('a code to type, not automatic', welcome.trigger === 'Code' && welcome.code.startsWith('WELCOME'));
    check('one use', welcome.maxNumberOfUsages === 1);
    check('does not stack', welcome.combinable === false);
    const today = todayEastern().date;
    const monthOn = addDays(today, WELCOME_DAYS);
    check('good for 30 days, through midnight Eastern', WELCOME_DAYS === 30 &&
      welcome.expires === endOfEasternDay(monthOn) && goodThrough(welcome.expires) === goodThrough(endOfEasternDay(monthOn)));
    check('named for Rob\'s Snipcart list, with no email in it', /^Account welcome: Rob C\. \(a_[0-9a-f]+\)$/.test(welcome.name));
    check('the account keeps the code', account.welcome.code === welcome.code && account.welcome.discountId === 'disc-1');
    const welcomeMail = net.mail[net.mail.length - 1];
    check('a welcome email carries the code', welcomeMail.htmlContent.includes(welcome.code) && welcomeMail.textContent.includes(welcome.code));
    check('and says it does not stack', /does not stack/.test(welcomeMail.textContent));

    /* ------------------------------------------------------------- /me */
    suite('accounts — the account page data');

    const me = await call(env, get('/api/account/me', cookie));
    check('signed in, /me answers', me.status === 200);
    const meBody = await me.json();
    check('with the name', meBody.account.firstName === 'Rob');
    check('without anything internal', !('stripeCustomerId' in meBody.account) && !('id' in meBody.account) && !('welcome' in meBody.account) && !('passwordHash' in meBody.account));
    check('with the sign-up code, ready', meBody.coupons.length === 1 && meBody.coupons[0].status === 'ready' && meBody.coupons[0].code === welcome.code);
    check('and the day it runs out', meBody.coupons[0].goodThrough === goodThrough(endOfEasternDay(monthOn)));

    const anon = await call(env, get('/api/account/me'));
    check('signed out, /me is a 401', anon.status === 401);
    check('and clears a stale hint cookie', anon.headers.getSetCookie().some((c) => c.startsWith(HINT_COOKIE + '=;') && /Max-Age=0/.test(c)));
    const forged = await call(env, get('/api/account/me', SESSION_COOKIE + '=made-up'));
    check('a made-up session is a 401', forged.status === 401);

    net.discountUses.set('disc-1', 1);
    const used = await (await call(env, get('/api/account/me', cookie))).json();
    check('a code Snipcart says was used shows as used', used.coupons[0].status === 'used');
    net.discountUses.delete('disc-1');

    /* -------------------------------------------------------- the guards */
    suite('accounts — what a request has to be');

    check('a POST from another site is refused', (await call(env, post('/api/account/code', { email: 'a@example.com' }, { origin: 'https://evil.example' }))).status === 403);
    check('a POST from this site is fine', (await call(env, post('/api/account/code', { email: 'a@example.com' }, { origin: ORIGIN, ip: '198.51.100.1' }))).status === 200);
    check('a form post (not JSON) is refused', (await call(env, post('/api/account/code', { email: 'a@example.com' }, { type: 'application/x-www-form-urlencoded' }))).status === 415);
    check('GET on a POST route is refused', (await call(env, get('/api/account/code'))).status === 405);

    const before = net.mail.length;
    const unknown = await call(env, post('/api/account/code', { email: 'nobody@example.com' }, { ip: '198.51.100.2' }));
    const knownRes = await call(env, post('/api/account/code', { email: 'rob.test@example.com' }, { ip: '198.51.100.3' }));
    check('an unknown email gets the same answer as a known one', unknown.status === 200 && knownRes.status === 200);
    check('the unknown one is told by email there is no account, with no code', /No Rawhide City Leather account/.test(net.mail[before].subject) && !/\d{6}/.test(net.mail[before].subject));
    check('the known one gets a code', /^\d{6} is your/.test(net.mail[before + 1].subject));
    check('no code is stored for an email with no account', !env.ACCOUNTS._store.has('code:nobody@example.com'));

    let limited = 0;
    for (let i = 0; i < 6; i++) {
      const r = await call(env, post('/api/account/code', { email: 'spam@example.com' }, { ip: '198.51.100.' + (10 + i) }));
      if (r.status === 429) limited++;
    }
    check('the sixth code to one email in an hour is refused', limited === 1);
    let ipLimited = 0;
    for (let i = 0; i < 22; i++) {
      const r = await call(env, post('/api/account/code', { email: `x${i}@example.com` }, { ip: '192.0.2.77' }));
      if (r.status === 429) ipLimited++;
    }
    check('one address asking for codes to many emails is cut off at 20', ipLimited === 2);

    // Five wrong tries and the code is dead, even for the right one after.
    await call(env, post('/api/account/code', { email: 'rob.test@example.com' }, { ip: '198.51.100.40' }));
    const good = lastCode(net);
    const bad = good === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await call(env, post('/api/account/reset', { email: 'rob.test@example.com', code: bad, password: 'New-pass-123' }));
    const late = await call(env, post('/api/account/reset', { email: 'rob.test@example.com', code: good, password: 'New-pass-123' }));
    check('after five wrong tries the right code no longer works', late.status === 429 || late.status === 400);
    check('and the password did not change', (await call(env, signin(SIGNUP.email, SIGNUP.password))).status === 200);

    /* ------------------------------------------------------ passwords */
    suite('accounts — signing in with a password');

    const good1 = await call(env, signin('ROB.test@example.com', SIGNUP.password));
    check('the right password signs in, whatever case the email is typed in', good1.status === 200 && !!sessionFrom(good1));
    const goodBody = await good1.json();
    check('and answers with the account', goodBody.account && goodBody.account.firstName === 'Rob');
    const badPw = await call(env, signin(SIGNUP.email, 'wrong-password'));
    const badPwBody = await badPw.json();
    check('a wrong password is refused', badPw.status === 400 && !sessionFrom(badPw));
    const nobody = await call(env, signin('nobody@example.com', 'whatever-123'));
    const nobodyBody = await nobody.json();
    check('an email with no account gets the very same answer', nobody.status === 400 && nobodyBody.error === badPwBody.error);
    check('and the same field', nobodyBody.field === badPwBody.field && badPwBody.field === 'password');
    check('no password is a 400 on the password field', (await (await call(env, signin(SIGNUP.email, ''))).json()).field === 'password');

    const lockEnv = makeEnv();
    const lockCookie = await makeAccount(lockEnv, net, { ...SIGNUP, email: 'lock@example.com', address: { ...SIGNUP.address, line1: '9 Lock Ln' } });
    for (let i = 0; i < 10; i++) await call(lockEnv, signin('lock@example.com', 'guess-' + i, '198.18.0.' + i));
    const locked = await call(lockEnv, signin('lock@example.com', SIGNUP.password, '198.18.1.1'));
    check('ten wrong passwords for one email and even the right one waits', locked.status === 429);
    check('saying how to get back in', /Forgot your password/.test((await locked.json()).error));
    check('a browser already signed in stays signed in', (await call(lockEnv, get('/api/account/me', lockCookie))).status === 200);

    const ipEnv = makeEnv();
    for (let i = 0; i < 30; i++) await call(ipEnv, signin(`guess${i}@example.com`, 'whatever-123', '198.18.9.9'));
    check('thirty wrong tries from one address and it waits too', (await call(ipEnv, signin('x@example.com', 'whatever-123', '198.18.9.9'))).status === 429);

    const legacyEnv = makeEnv();
    legacyEnv.ACCOUNTS._store.set('acct:old@example.com', JSON.stringify({ id: 'a_old', email: 'old@example.com', firstName: 'O', lastName: 'L', dob: '1980-01-01', address: SIGNUP.address, epoch: 0 }));
    const legacy = await call(legacyEnv, signin('old@example.com', 'anything-123'));
    check('an account with no password yet is told to set one', legacy.status === 400 && /no password yet/.test((await legacy.json()).error));

    check('the sign-up code cannot be used as a reset code',
      (await call(env, post('/api/account/reset', { email: 'nobody@example.com', code: '123456', password: 'New-pass-123' }))).status === 400);

    /* ------------------------------------------------------ forgot password */
    suite('accounts — forgot password');

    const resetEnv = makeEnv();
    const otherBrowser = await makeAccount(resetEnv, net, { ...SIGNUP, email: 'reset@example.com', address: { ...SIGNUP.address, line1: '5 Reset Rd' } });
    check('signed in somewhere before the reset', (await call(resetEnv, get('/api/account/me', otherBrowser))).status === 200);
    const ask = await call(resetEnv, post('/api/account/code', { email: 'reset@example.com' }, { ip: '198.51.100.70' }));
    check('asking for a reset sends a code', ask.status === 200 && /password code/.test(net.mail[net.mail.length - 1].subject));
    const rcode = lastCode(net);
    const weakReset = await call(resetEnv, post('/api/account/reset', { email: 'reset@example.com', code: rcode, password: 'abc' }));
    check('a weak new password is refused', weakReset.status === 400 && (await weakReset.json()).field === 'password');
    const reset = await call(resetEnv, post('/api/account/reset', { email: 'reset@example.com', code: rcode, password: 'Brand-new-99' }));
    check('and does not use up the code: the right one then works', reset.status === 200);
    const resetCookie = sessionFrom(reset);
    check('the reset signs this browser in', !!resetCookie && (await call(resetEnv, get('/api/account/me', resetCookie))).status === 200);
    check('and signs out every browser signed in before it', (await call(resetEnv, get('/api/account/me', otherBrowser))).status === 401);
    check('the old password no longer works', (await call(resetEnv, signin('reset@example.com', SIGNUP.password))).status === 400);
    check('the new one does', (await call(resetEnv, signin('reset@example.com', 'Brand-new-99'))).status === 200);
    check('a used reset code does not work twice', (await call(resetEnv, post('/api/account/reset', { email: 'reset@example.com', code: rcode, password: 'Another-one-1' }))).status === 400);

    suite('accounts — the password itself');

    const pwFails = (v, email) => { try { readPassword(v, { email }); return false; } catch (e) { return e instanceof PasswordError; } };
    check('7 characters is too short', pwFails('abcdefg'));
    check('8 is enough', readPassword('abcdefgh') === 'abcdefgh');
    check('no composition rules: a long phrase of plain words is fine', readPassword('engine seven radio strap') === 'engine seven radio strap');
    check('the ones everybody tries first are refused', pwFails('password123') && pwFails('12345678') && pwFails('Firefighter'));
    check('one character over and over is refused', pwFails('aaaaaaaaaa'));
    check('the email, or the part before the @, is refused', pwFails('rob@example.com', 'rob@example.com') && pwFails('robertsmith', 'robertsmith@example.com'));
    check('past 128 characters is refused', pwFails('x'.repeat(129)));
    const pepper = { ACCOUNT_SECRET: 'pepper-a' };
    const h = await hashPassword(pepper, 'Engine7-strap');
    check('a hash checks out against its own password', await checkPassword(pepper, 'Engine7-strap', h));
    check('and not against another', !(await checkPassword(pepper, 'Engine7-strap!', h)));
    check('two hashes of one password differ (salted)', h !== await hashPassword(pepper, 'Engine7-strap'));
    check('without the Worker secret the hash cannot be checked (peppered)', !(await checkPassword({ ACCOUNT_SECRET: 'pepper-b' }, 'Engine7-strap', h)));
    check('a junk stored value is just a no, never a crash', !(await checkPassword(pepper, 'x', 'garbage')) && !(await checkPassword(pepper, 'x', null)));
    check('a hash from fewer rounds is due a re-hash', needsRehash('pbkdf2-sha256$20000$a$b') && !needsRehash(h));

    /* ------------------------------------------------------ signing up again */
    suite('accounts — one sign-up code per person');

    const mintedBefore = net.discounts.length;
    const again = await call(env, post('/api/account/signup', { ...SIGNUP, firstName: 'Robert' }));
    check('signing up again with the same email looks the same from outside', again.status === 200);
    check('but emails that there is already an account, with no code in it', /already one under it/.test(net.mail[net.mail.length - 1].textContent) && !/\d{6}/.test(net.mail[net.mail.length - 1].subject));
    check('and nothing waits to be verified', !env.ACCOUNTS._store.has('code:rob.test@example.com'));
    check('the name was not changed by the second form', JSON.parse(env.ACCOUNTS._store.get('acct:rob.test@example.com')).firstName === 'Rob');
    check('and no second code was made', net.discounts.length === mintedBefore);

    const housemate = { ...SIGNUP, firstName: 'Sam', email: 'sam@example.com', address: { line1: '123 north main st', line2: 'unit 4', city: 'Lakeland', state: 'FL', zip: '33801-0001' } };
    await makeAccount(env, net, housemate);
    const sam = JSON.parse(env.ACCOUNTS._store.get('acct:sam@example.com'));
    check('the same front door written differently is the same address', addressKey(SIGNUP.address) === addressKey(housemate.address));
    check('a second account at that address gets no sign-up code', sam.welcome && sam.welcome.skipped === 'address' && net.discounts.length === mintedBefore);
    check('but the account itself is made fine', sam.email === 'sam@example.com');

    const neighbor = { ...SIGNUP, email: 'pat@example.com', address: { ...SIGNUP.address, line2: 'Apt 5' } };
    await makeAccount(env, net, neighbor);
    check('the apartment next door is a different address', !!JSON.parse(env.ACCOUNTS._store.get('acct:pat@example.com')).welcome.code);

    /* ------------------------------------------------------------- orders */
    suite('accounts — orders and tracking');

    net.customers.push({ id: 'cust-1', email: 'rob.test@example.com' }, { id: 'cust-2', email: 'Rob.Test@example.com' }, { id: 'cust-9', email: 'someone@example.org' });
    const items = [
      { id: 'fully-custom-radio-strap', name: 'Fully Custom Radio Strap', quantity: 1, price: 165, totalPrice: 165, url: '/product-fully-custom-radio-strap.html',
        customFields: [
          { name: 'Leather Color', value: 'Chestnut', type: 'dropdown' },
          { name: 'Logo', value: 'https://rawhidecityleather.com/logo/abc', type: 'textbox' },
          { name: 'internal', value: 'x', type: 'hidden' },
          { name: 'Rush', value: 'false', type: 'checkbox' },
        ] },
    ];
    net.orders.set('a1b2c3d4-e5f6', { _customer: 'cust-1', token: 'a1b2c3d4-e5f6', invoiceNumber: 'SNIP-2001', email: 'rob.test@example.com', completionDate: '2026-10-01T15:00:00Z', status: 'Processed', paymentStatus: 'Paid', grandTotal: 148.5, items });
    net.orders.set('tok-2', { _customer: 'cust-2', token: 'tok-2', invoiceNumber: 'SNIP-1990', email: 'rob.test@example.com', completionDate: '2026-09-01T15:00:00Z', status: 'Shipped', paymentStatus: 'Paid', grandTotal: 58, trackingNumber: '9400111899223344556677', items: [{ name: 'Leather Butter', quantity: 2, price: 8, totalPrice: 16, url: '/product-leather-butter.html' }] });
    net.orders.set('tok-3', { _customer: 'cust-1', token: 'tok-3', invoiceNumber: 'SNIP-1980', email: 'other@example.com', completionDate: '2026-09-02T15:00:00Z', status: 'Processed', paymentStatus: 'Paid', grandTotal: 99, items: [] });
    net.orders.set('tok-4', { _customer: 'cust-9', token: 'tok-4', invoiceNumber: 'SNIP-1970', email: 'someone@example.org', completionDate: '2026-09-03T15:00:00Z', status: 'Processed', paymentStatus: 'Paid', grandTotal: 40, items: [] });
    net.orders.set('tok-5', { _customer: 'cust-1', token: 'tok-5', invoiceNumber: 'SNIP-1960', email: 'rob.test@example.com', completionDate: '2026-08-03T15:00:00Z', status: 'Processed', paymentStatus: 'Refunded', grandTotal: 600, items: [{ id: 'quote-xyz', name: 'Crew order', quantity: 1, totalPrice: 600, url: '/quote/q_123' }] });

    const ordRes = await call(env, get('/api/account/orders', cookie));
    check('orders load', ordRes.status === 200);
    const orders = (await ordRes.json()).orders;
    check('only this email\'s orders, from every customer record it has', orders.map((o) => o.invoice).join(',') === 'SNIP-2001,SNIP-1990,SNIP-1960');
    check('an order under another email on the same record is left out', !orders.some((o) => o.invoice === 'SNIP-1980'));
    check('newest first', orders[0].invoice === 'SNIP-2001');
    check('a paid order not yet shipped is being built', orders[0].status === 'building');
    check('with the radio strap lead time', orders[0].leadTime === '6 weeks');
    check('options are shown, hidden fields and empty boxes are not', orders[0].items[0].options.map((o) => o.name).join(',') === 'Leather Color,Logo');
    check('an uploaded file shows as attached, not as a link to the shop\'s files', orders[0].items[0].options[1].value === 'Attached');
    check('"buy again" points at the product page', orders[0].items[0].url === '/product-fully-custom-radio-strap');
    check('a shipped order carries its tracking number', orders[1].status === 'shipped' && orders[1].tracking.number === '9400111899223344556677');
    check('and a USPS link when Snipcart has none', orders[1].tracking.url.startsWith('https://tools.usps.com/'));
    check('a refunded order says refunded', orders[2].status === 'refunded');
    check('a quote line gets no "buy again"', orders[2].items[0].url === '');
    check('signed out, orders are a 401', (await call(env, get('/api/account/orders'))).status === 401);

    // The whole point: Rob saves tracking on the dashboard, and it is there.
    const ship = await call(env, new Request(ORIGIN + '/dashboard/api/ship', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1', Authorization: 'Basic ' + btoa('rob:pw') },
      body: JSON.stringify({ token: 'a1b2c3d4-e5f6', trackingNumber: '1Z999AA10123456784' }),
    }));
    check('the dashboard ships the order', ship.status === 200);
    const after = (await (await call(env, get('/api/account/orders', cookie))).json()).orders;
    check('the account shows it shipped on the next look', after[0].status === 'shipped');
    check('with the number the dashboard saved', after[0].tracking && after[0].tracking.number === '1Z999AA10123456784');
    check('and the UPS link the dashboard wrote', after[0].tracking.url === 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
    check('lead time stops showing once it has shipped', after[0].leadTime === '');

    net.orders.set('tok-6', { _customer: 'cust-x', token: 'tok-6', invoiceNumber: 'SNIP-1950', email: 'Mixed.Case@Example.com', completionDate: '2026-07-01T15:00:00Z', status: 'Delivered', paymentStatus: 'Paid', grandTotal: 30, items: [] });
    const mixed = await makeAccount(env, net, { ...SIGNUP, email: 'mixed.case@example.com', address: { ...SIGNUP.address, line1: '8 Case St' } });
    const mixedOrders = (await (await call(env, get('/api/account/orders', mixed))).json()).orders;
    check('when Snipcart finds no customer, orders are matched by email without case', mixedOrders.length === 1 && mixedOrders[0].invoice === 'SNIP-1950');
    check('a delivered order says delivered', mixedOrders[0].status === 'delivered');
    check('and the fallback still shows no other customer\'s order',!mixedOrders.some((o) => o.invoice === 'SNIP-2001'));

    check('a built-in product line gets its small photo', orders[0].items[0].thumb === '/assets/img/products/fully-custom-radio-strap-600.webp');
    const pics = orderView({ status: 'Processed', paymentStatus: 'Paid', items: [
      { name: 'A', url: '/product-helmet-band.html', image: '/assets/img/products/helmet-band.jpg' },
      { name: 'B', url: '/product-custom-x', image: '/photo/abc123.webp' },
      { name: 'C', url: '/product-y', image: 'https://evil.example/x.png' },
    ] }).items;
    check('the photo Snipcart kept is the fallback for the small one', pics[0].thumb === '/assets/img/products/helmet-band-600.webp' && pics[0].image === '/assets/img/products/helmet-band.jpg');
    check('a dashboard-made product uses its own photo', pics[1].thumb === '/photo/abc123.webp');
    check('an outside image link is never put on the page', !/evil/.test(pics[2].thumb + pics[2].image));

    const thin = orderView({ invoiceNumber: 'X', status: 'Cancelled', paymentStatus: 'Paid', items: [] });
    check('a cancelled order says cancelled', thin.status === 'cancelled');

    /* ---------------------------------------------------- details, delete */
    suite('accounts — changing details, signing out, deleting');

    const upd = await call(env, post('/api/account/update', { firstName: 'Rob', lastName: 'Conover', address: { ...SIGNUP.address, line1: '9 Oak Ln' }, phone: '', birthdayEmails: false, dob: '2026-10-18', email: 'new@example.com' }, { cookie }));
    check('details can be changed', upd.status === 200);
    const changed = JSON.parse(env.ACCOUNTS._store.get('acct:rob.test@example.com'));
    check('the address changed', changed.address.line1 === '9 Oak Ln');
    check('the birthday email can be turned off', changed.birthdayEmails === false);
    check('the date of birth cannot be moved', changed.dob === '1985-03-14');
    check('the email cannot be changed here', changed.email === 'rob.test@example.com' && !env.ACCOUNTS._store.has('acct:new@example.com'));
    const badUpd = await call(env, post('/api/account/update', { firstName: '', lastName: 'C', address: SIGNUP.address }, { cookie }));
    check('a bad edit names the field', badUpd.status === 400 && (await badUpd.json()).field === 'firstName');

    const out = await call(env, post('/api/account/signout', {}, { cookie }));
    check('signing out answers ok', out.status === 200);
    check('and that browser is signed out', (await call(env, get('/api/account/me', cookie))).status === 401);

    /* --------------------------------------------------------------- cards */
    suite('accounts — cards on file');

    net = makeNet();
    globalThis.fetch = net.fetch;
    env = makeEnv();
    const c1 = await makeAccount(env, net);
    const noStripe = await (await call(env, get('/api/account/cards', c1))).json();
    check('with no Stripe keys, cards are off and say so', noStripe.enabled === false);
    check('and /me says the same', (await (await call(env, get('/api/account/me', c1))).json()).cards.enabled === false);

    env.STRIPE_SECRET_KEY = 'sk_live_x';
    env.STRIPE_PUBLISHABLE_KEY = 'pk_live_x';
    const empty = await (await call(env, get('/api/account/cards', c1))).json();
    check('no Stripe customer yet means no cards, and no call to Stripe', empty.enabled === true && empty.cards.length === 0 && net.stripeCustomers === 0);

    const setup = await call(env, post('/api/account/cards/setup', {}, { cookie: c1 }));
    check('adding a card gets a SetupIntent', setup.status === 200 && (await setup.json()).clientSecret === 'seti_1_secret');
    check('on a Stripe customer made for this account', net.stripeCustomers === 1 && net.setupIntents[0].get('customer') === 'cus_1');
    check('the customer is made idempotently, keyed to the account', /^rawhide-account-a_/.test(net.customerHeaders['Idempotency-Key']));
    check('the card is for paying on site, with the CVC', net.setupIntents[0].get('usage') === 'on_session');
    await call(env, post('/api/account/cards/setup', {}, { cookie: c1 }));
    check('a second card reuses the customer', net.stripeCustomers === 1);

    net.paymentMethods.set('pm_mine', { id: 'pm_mine', customer: 'cus_1', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } });
    net.paymentMethods.set('pm_theirs', { id: 'pm_theirs', customer: 'cus_77', card: { brand: 'amex', last4: '0005', exp_month: 1, exp_year: 2031 } });
    const listed = await (await call(env, get('/api/account/cards', c1))).json();
    check('the card shows brand, last four and expiry, nothing more', listed.cards.length === 1 && listed.cards[0].last4 === '4242' && listed.cards[0].brand === 'visa' && !('number' in listed.cards[0]));
    check('the account keeps a count for the checkout', JSON.parse(env.ACCOUNTS._store.get('acct:rob.test@example.com')).cardCount === 1);
    check('nothing card-shaped is stored on the account', !/4242/.test(env.ACCOUNTS._store.get('acct:rob.test@example.com')));

    const steal = await call(env, post('/api/account/cards/remove', { id: 'pm_theirs' }, { cookie: c1 }));
    check('removing somebody else\'s card is refused', steal.status === 404 && net.detached.length === 0);
    const rm = await call(env, post('/api/account/cards/remove', { id: 'pm_mine' }, { cookie: c1 }));
    check('removing your own card detaches it at Stripe', rm.status === 200 && net.detached.includes('pm_mine'));
    check('and the count drops', JSON.parse(env.ACCOUNTS._store.get('acct:rob.test@example.com')).cardCount === 0);
    net.paymentMethods.get('pm_mine').customer = 'cus_1';
    await call(env, get('/api/account/cards', c1));

    /* ------------------------------------------------------------ checkout */
    suite('accounts — paying with a saved card at checkout');

    env.SNIPCART_GATEWAY_KEY = 'gw';
    net.session = {
      id: 'sess_9',
      invoice: {
        amount: 176.55, currency: 'USD', email: 'Rob.Test@example.com',
        items: [{ name: 'Fully Custom Radio Strap', quantity: 1, amount: 165 }, { name: 'Sales tax', quantity: 1, amount: 11.55 }],
        shippingAddress: { name: 'Rob Conover', address1: '9 Oak Ln', city: 'Lakeland', province: 'FL', postalCode: '33801' },
      },
      paymentAuthorizationRedirectUrl: ORIGIN + '/#/checkout',
    };

    const offer = await savedCardOffer(env, 'good', net.session, ORIGIN);
    check('a checkout under an account email with a card offers "Saved card"', offer && offer.id === SAVED_METHOD_ID && offer.name === 'Saved card');
    check('pointing at the saved-card page', offer.checkoutUrl === ORIGIN + '/pay?publicToken=good&with=card');
    check('with no last four on it, because anyone can type any email', !/4242/.test(JSON.stringify(offer)));
    check('an email with no account gets no offer', await savedCardOffer(env, 'good', { invoice: { email: 'nobody@example.com' } }, ORIGIN) === null);

    const methods = await (await call(env, post('/api/wallet/methods', { publicToken: 'good' }))).json();
    check('Snipcart is told about both: saved card, then the wallet', methods.length === 2 && methods[0].id === SAVED_METHOD_ID && methods[1].id === METHOD_ID);
    const plain = await (await handleMethods(post('/api/wallet/methods', { publicToken: 'good' }), env, ORIGIN)).json();
    check('the wallet alone when no offer is wired in, exactly as before', plain.length === 1 && plain[0].id === METHOD_ID);
    const broken = await (await handleMethods(post('/api/wallet/methods', { publicToken: 'good' }), env, ORIGIN, async () => { throw new Error('kv down'); })).json();
    check('a saved-card lookup that throws still offers the wallet', broken.length === 1 && broken[0].id === METHOD_ID);

    const pageOut = await call(env, get('/pay?publicToken=good&with=card'));
    const pageOutHtml = await pageOut.text();
    check('signed out, the saved-card page asks to sign in', pageOut.status === 200 && /Sign in to use your card/.test(pageOutHtml));
    check('and the sign-in comes straight back here', pageOutHtml.includes('/account?next=' + encodeURIComponent('/pay?publicToken=good&with=card').replace(/&/g, '&amp;')));
    check('no card is shown to a signed-out visitor', !/4242/.test(pageOutHtml));

    const pageIn = await call(env, get('/pay?publicToken=good&with=card', c1));
    const pageInHtml = await pageIn.text();
    check('signed in, the page lists the card', pageIn.status === 200 && pageInHtml.includes('&bull;&bull;&bull;&bull; 4242'));
    check('asks for the CVC', pageInHtml.includes('id="cvc"') && pageInHtml.includes("create('cardCvc'"));
    check('shows where it is shipping', pageInHtml.includes('Shipping to Rob Conover, 9 Oak Ln, Lakeland, FL 33801'));
    check('and the total from Snipcart', pageInHtml.includes('$176.55'));
    check('the page may open a card sheet', pageIn.headers.get('permissions-policy').includes('payment=*'));

    const c2 = await makeAccount(env, net, { ...SIGNUP, email: 'other@example.com', address: { ...SIGNUP.address, line1: '7 Elm St' } });
    const pageWrong = await call(env, get('/pay?publicToken=good&with=card', c2));
    check('signed in as a different email, the page refuses', pageWrong.status === 403 && /A different email/.test(await pageWrong.text()));

    const noSess = await call(env, post('/api/wallet/saved-intent', { publicToken: 'good', paymentMethod: 'pm_mine' }));
    check('the intent needs a signed-in session', noSess.status === 401);
    const wrongAcct = await call(env, post('/api/wallet/saved-intent', { publicToken: 'good', paymentMethod: 'pm_mine' }, { cookie: c2 }));
    check('and the order\'s own email', wrongAcct.status === 403);
    const notMine = await call(env, post('/api/wallet/saved-intent', { publicToken: 'good', paymentMethod: 'pm_theirs' }, { cookie: c1 }));
    check('and a card on that account', notMine.status === 403 && net.intentBody === null);
    const badToken = await call(env, post('/api/wallet/saved-intent', { publicToken: 'forged', paymentMethod: 'pm_mine' }, { cookie: c1 }));
    check('and a token Snipcart vouches for', badToken.status === 401);
    const crossSite = await call(env, post('/api/wallet/saved-intent', { publicToken: 'good', paymentMethod: 'pm_mine' }, { cookie: c1, origin: 'https://evil.example' }));
    check('and a request from this site', crossSite.status === 403 && net.intentBody === null);

    const ok = await call(env, post('/api/wallet/saved-intent', { publicToken: 'good', paymentMethod: 'pm_mine' }, { cookie: c1 }));
    check('all of that, and the intent is made', ok.status === 200 && (await ok.json()).clientSecret === 'pi_saved_secret');
    check('for Snipcart\'s amount, in cents', net.intentBody.get('amount') === '17655' && net.intentBody.get('currency') === 'usd');
    check('on this customer\'s card', net.intentBody.get('customer') === 'cus_1' && net.intentBody.get('payment_method') === 'pm_mine');
    check('cards only', net.intentBody.get('payment_method_types[0]') === 'card');
    check('not confirmed on the server: the browser does that with the CVC', !net.intentBody.has('confirm'));
    check('tagged for the settle and refund checks', net.intentBody.get('metadata[snipcart_session]') === 'sess_9' && net.intentBody.get('metadata[method]') === SAVED_METHOD_ID);
    check('idempotent per session and card', net.intentHeaders['Idempotency-Key'] === 'saved-sess_9-pm_mine');

    net.intents.pi_saved = { id: 'pi_saved', status: 'succeeded', amount: 17655, currency: 'usd', metadata: { snipcart_session: 'sess_9', method: SAVED_METHOD_ID } };
    env.QUOTES = makeKV();
    const settled = await settle(env, ORIGIN, 'good', 'pi_saved');
    check('the saved-card payment settles with Snipcart like a wallet one', settled.ok === true && net.snipcartPayment.state === 'processed');
    check('and Snipcart\'s record says a saved card paid', /^Paid by Saved card through Stripe/.test(net.snipcartPayment.instructions));

    env.STRIPE_SECRET_KEY = 'sk_test_x';
    const testKeys = await call(env, post('/api/wallet/saved-intent', { publicToken: 'good', paymentMethod: 'pm_mine' }, { cookie: c1 }));
    check('on Stripe test keys, only the shop\'s own test order may use it', testKeys.status === 403);
    env.STRIPE_SECRET_KEY = 'sk_live_x';

    suite('accounts — deleting an account');

    const del0 = await call(env, post('/api/account/delete', { confirm: 'nope' }, { cookie: c1 }));
    check('deleting needs DELETE typed', del0.status === 400);
    const del = await call(env, post('/api/account/delete', { confirm: 'DELETE' }, { cookie: c1 }));
    check('deleting answers ok', del.status === 200);
    check('the Stripe customer goes, taking the cards with it', net.deletedCustomers.includes('cus_1'));
    check('the account is gone', !env.ACCOUNTS._store.has('acct:rob.test@example.com'));
    check('so is the birthday index', !env.ACCOUNTS._store.has('bday:03-14:rob.test@example.com'));
    check('the session no longer works', (await call(env, get('/api/account/me', c1))).status === 401);
    const markKeys = [...env.ACCOUNTS._store.keys()].filter((k) => k.startsWith('welcomed:') || k.startsWith('addr:'));
    check('what is kept is hashes, with no email or street in them', markKeys.length >= 2 && !markKeys.some((k) => /rob|main|oak|@/i.test(k)));
    const minted = net.discounts.length;
    const back = await makeAccount(env, net);
    check('signing up again after deleting works', !!back);
    check('but does not mint a second sign-up code', net.discounts.length === minted && JSON.parse(env.ACCOUNTS._store.get('acct:rob.test@example.com')).welcome.skipped === 'email');

    /* ------------------------------------------------------- a failed mint */
    suite('accounts — Snipcart down at sign-up');

    net = makeNet();
    globalThis.fetch = net.fetch;
    env = makeEnv();
    net.refuseDiscounts = true;
    const c3 = await makeAccount(env, net);
    check('the account is still made', !!c3 && env.ACCOUNTS._store.has('acct:rob.test@example.com'));
    check('the code is marked to try again', JSON.parse(env.ACCOUNTS._store.get('acct:rob.test@example.com')).welcome.pending === true);
    check('the welcome email goes without a code rather than not at all', /account is set/.test(net.mail[net.mail.length - 1].subject));
    net.refuseDiscounts = false;
    const retry = await (await call(env, get('/api/account/me', c3))).json();
    check('the next look at the account makes it', retry.coupons.length === 1 && retry.coupons[0].code.startsWith('WELCOME'));

    /* ----------------------------------------------------------- birthdays */
    suite('accounts — the birthday code');

    net = makeNet();
    globalThis.fetch = net.fetch;
    env = makeEnv();
    await makeAccount(env, net, { ...SIGNUP, dob: '1990-10-18' });
    await makeAccount(env, net, { ...SIGNUP, email: 'quiet@example.com', dob: '1991-10-18', birthdayEmails: false, address: { ...SIGNUP.address, line1: '1 Quiet Rd' } });
    await makeAccount(env, net, { ...SIGNUP, email: 'leap@example.com', dob: '1992-02-29', address: { ...SIGNUP.address, line1: '2 Leap Rd' } });
    await makeAccount(env, net, { ...SIGNUP, email: 'later@example.com', dob: '1993-11-02', address: { ...SIGNUP.address, line1: '3 Later Rd' } });
    const welcomeCount = net.discounts.length;
    const mailCount = net.mail.length;

    const early = await runBirthdays(env, Date.parse('2026-10-18T12:00:00Z')); // 8am Eastern
    check('nothing before 9am Eastern', early.skipped === 'before-9am' && net.discounts.length === welcomeCount);

    const r1 = await runBirthdays(env, Date.parse('2026-10-18T14:00:00Z')); // 10am Eastern
    check('both October 18 birthdays get a code', r1.minted === 2);
    const bday = net.discounts.slice(welcomeCount);
    check('15% off', bday.every((d) => d.type === 'Rate' && d.rate === BIRTHDAY_RATE && BIRTHDAY_RATE === 15));
    check('one use, does not stack', bday.every((d) => d.maxNumberOfUsages === 1 && d.combinable === false && d.trigger === 'Code'));
    check('good for 30 days, through Nov 17', bday.every((d) => d.expires === endOfEasternDay('2026-11-17')) && goodThrough(bday[0].expires) === 'Nov 17, 2026');
    check('only the one who wants the email gets one', r1.emailed === 1 && net.mail.length === mailCount + 1);
    const bmail = net.mail[net.mail.length - 1];
    check('it is marketing mail: unsubscribe header and the postal address', !!(bmail.headers && bmail.headers['List-Unsubscribe']) && bmail.textContent.includes('PO Box 1, Lakeland FL 33801'));
    check('and it carries the code', bmail.textContent.includes(bday[0].code) || bmail.textContent.includes(bday[1].code));
    const quiet = JSON.parse(env.ACCOUNTS._store.get('acct:quiet@example.com'));
    check('the quiet one still has the code on the account page', quiet.birthdays['2026'] && quiet.birthdays['2026'].code.startsWith('BDAY'));

    const r2 = await runBirthdays(env, Date.parse('2026-10-18T15:00:00Z'));
    check('the next hour makes nothing new', r2.minted === 0 && net.discounts.length === welcomeCount + 2);
    check('and mails nobody twice', net.mail.length === mailCount + 1);

    const nextYear = await runBirthdays(env, Date.parse('2027-10-18T14:00:00Z'));
    check('next year brings a new one', nextYear.minted === 2);

    const leap = await runBirthdays(env, Date.parse('2027-02-28T15:00:00Z'));
    check('a February 29 birthday is kept on the 28th in a year without one', leap.minted === 1 && !!JSON.parse(env.ACCOUNTS._store.get('acct:leap@example.com')).birthdays['2027']);
    const leapYear = await runBirthdays(env, Date.parse('2028-02-28T15:00:00Z'));
    check('and on the 29th when there is one', leapYear.minted === 0);

    const robNow = JSON.parse(env.ACCOUNTS._store.get('acct:rob.test@example.com'));
    const meCodes = couponList(robNow, {}, Date.parse('2026-10-20T12:00:00Z'));
    check('the account page shows the sign-up code and the birthday codes still good', meCodes.map((c) => c.kind).join(',') === 'welcome,birthday,birthday');
    const latePage = couponList(robNow, {}, Date.parse('2027-10-25T12:00:00Z'));
    check('an expired birthday code drops off the page', !latePage.some((c) => c.label === 'Birthday code 2026') && latePage.some((c) => c.label === 'Birthday code 2027'));
    check('an expired sign-up code stays, marked expired', latePage[0].kind === 'welcome' && latePage[0].status === 'expired');

    await makeAccount(env, net, { ...SIGNUP, email: 'retry@example.com', dob: '1994-06-01', address: { ...SIGNUP.address, line1: '4 Retry Rd' } });
    net.failMail = true;
    const fail1 = await runBirthdays(env, Date.parse('2027-06-01T14:00:00Z'));
    check('a birthday email that fails keeps the code made', fail1.minted === 1 && fail1.emailed === 0);
    net.failMail = false;
    const fail2 = await runBirthdays(env, Date.parse('2027-06-01T15:00:00Z'));
    check('and the email goes on the next run, with no second code', fail2.minted === 0 && fail2.emailed === 1);

    const many = makeEnv();
    for (let i = 0; i < 13; i++) {
      many.ACCOUNTS._store.set(`acct:p${i}@example.com`, JSON.stringify({ id: 'a_' + i, email: `p${i}@example.com`, firstName: 'P', lastName: 'Q', dob: '1990-05-05', birthdayEmails: false, birthdays: {} }));
      many.ACCOUNTS._store.set(`bday:05-05:p${i}@example.com`, '');
    }
    const capped = await runBirthdays(many, Date.parse('2027-05-05T14:00:00Z'));
    check('a busy birthday stops at 10 a run and says there are more', capped.minted === 10 && capped.more === true);
    const rest = await runBirthdays(many, Date.parse('2027-05-05T15:00:00Z'));
    check('the rest go the next hour', rest.minted === 3 && rest.more === false);

    /* ------------------------------------------------------------ helpers */
    suite('accounts — dates, emails, the header link');

    check('end of an Eastern day in daylight time is 04:00 UTC next day', endOfEasternDay('2026-10-18') === '2026-10-19T04:00:00.000Z');
    check('and in standard time 05:00 UTC', endOfEasternDay('2026-12-18') === '2026-12-19T05:00:00.000Z');
    check('Eastern "today" at 1am UTC is still yesterday', todayEastern(Date.parse('2026-10-19T01:00:00Z')).date === '2026-10-18');
    check('addDays crosses months', addDays('2026-10-18', 30) === '2026-11-17');
    const w = welcomeDiscount({ id: 'a_1', firstName: 'A', lastName: 'B' }, 'WELCOMEX', NOW);
    check('the welcome rule body is non-combinable 20%', w.body.combinable === false && w.body.rate === 20);
    const b = birthdayDiscount({ id: 'a_1', firstName: 'A', lastName: 'B' }, 'BDAYX', '2026-10-18');
    check('the birthday rule body is non-combinable 15%', b.body.combinable === false && b.body.rate === 15);
    const codeMail = resetCodeEmail('123456');
    check('the password email says the code works for 15 minutes', codeMail.text.includes('15 minutes') && codeMail.html.includes('123456'));
    const bm = birthdayEmail('Rob', { code: 'BDAY1', expiresAt: endOfEasternDay('2026-11-17') }, { postalAddress: 'PO Box', unsubscribeTo: 'x@y.z' });
    check('the birthday email tells them how to stop it', /Untick "birthday email"/.test(bm.text));
    check('no stacked exclamation points in any account email', ![codeMail, bm].some((m) => /!!/.test(m.text)));

    installHTMLRewriterShim();
    const pageHtml = '<header><div class="header-actions"><a href="/account" class="account-link" aria-label="Your account"><svg></svg></a><a href="#" class="snipcart-checkout cart-link">c</a></div></header><p data-account-only>Have an account?</p><p>Keep</p>';
    const htmlRes = () => new Response(pageHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const hidden = await (await withAccountLinks(htmlRes(), new Request(ORIGIN + '/'), {})).text();
    check('accounts off: the header icon comes off the page', !hidden.includes('account-link') && hidden.includes('cart-link'));
    check('and so does the "have an account" line', !hidden.includes('Have an account') && hidden.includes('Keep'));
    const shown = await (await withAccountLinks(htmlRes(), new Request(ORIGIN + '/'), makeEnv())).text();
    check('accounts on: the page is untouched', shown === pageHtml);
  } finally {
    globalThis.fetch = original;
  }
}
