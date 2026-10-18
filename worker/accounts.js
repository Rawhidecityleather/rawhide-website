/**
 * Customer accounts.
 *
 * A customer signs in with their email and a password they set at sign-up
 * (worker/account-password.js has the hash). Making the account takes one
 * emailed six-digit code as well: it proves the email belongs to whoever is
 * signing up, which is what keeps the 20% sign-up code from being farmed with
 * made-up addresses. A forgotten password is reset with the same kind of
 * code, and a reset signs out every other browser on the account.
 *
 * What an account gives them:
 *   - every order under their email, with its status and tracking. Read live
 *     from Snipcart, which is where the dashboard, the batch ship and the
 *     Pirate Ship tracking email all write — so a tracking number shows up
 *     here the moment it is saved, with nothing to keep in step.
 *   - a card on file, kept by Stripe. See worker/account-cards.js.
 *   - 20% off one order for signing up, good for a month, and 15% off one
 *     order on their birthday, good for a month. Both are one-use Snipcart
 *     codes made non-combinable, so they never stack with each other or a
 *     store sale. See worker/account-coupons.js.
 *   - their email and address filled in at checkout (assets/js/main.js).
 *
 * Storage is the ACCOUNTS KV namespace:
 *   acct:<email>              the account
 *   sess:<sha256 of token>    a signed-in browser, 30 days
 *   code:<email>              a sign-up or password code waiting, 15 minutes
 *   send:<email>, ip:<ip>     how many codes went out this hour
 *   fail:<email>, ipfail:<ip> wrong passwords this hour
 *   bday:<MM-DD>:<email>      the birthday index the cron reads
 *   welcomed:<sha256 email>   this email has had its sign-up code
 *   addr:<sha256 address>     this street address has had its sign-up code
 * The last two outlive a deleted account on purpose — they are one-way hashes,
 * and they are what stops delete-and-sign-up-again from minting another 20%.
 *
 * Off until all of these exist: the ACCOUNTS binding, the ACCOUNT_SECRET
 * secret (peppers the stored codes and passwords), SNIPCART_SECRET, and the Brevo mail
 * secrets. Without them every route answers 503 and the account page says
 * accounts are not switched on yet.
 *
 * Routes (wired in index.js)
 *   GET  /api/account/me        who is signed in, their codes, a sale note
 *   POST /api/account/signin    email and password, for a session
 *   POST /api/account/signup    check the sign-up form, email a code
 *   POST /api/account/verify    the sign-up code back: make the account, sign in
 *   POST /api/account/code      forgot (or change) password: email a code
 *   POST /api/account/reset     that code and a new password: set it, sign in
 *   GET  /api/account/orders    their orders, with tracking
 *   POST /api/account/update    change name, address, phone, birthday email
 *   POST /api/account/signout   end this browser's session
 *   POST /api/account/delete    delete the account and the cards on file
 */

import { json, leadTime } from './lib.js';
import {
  getJson, getOrders, getAllOrders, isPaid, isCancelled, isShipped, refundState, grandTotal,
  trackingUrlFor,
} from './snipcart.js';
import { sendMail } from './mailer.js';
import { stripe } from './wallet.js';
import {
  resetCodeEmail, existingAccountEmail, signUpCodeEmail, noAccountEmail, welcomeEmail, goodThrough,
} from './account-mail.js';
import {
  readPassword, hashPassword, checkPassword, needsRehash, burnOneHash, PasswordError,
} from './account-password.js';
import { grantWelcome, couponList, couponUsage, saleNote } from './account-coupons.js';
import {
  accountsConfigured, cleanEmail, sha256, getAccount, putAccount, deleteAccount,
  birthdayKey, todayEastern,
} from './account-store.js';

export { accountsConfigured, cleanEmail, getAccount, putAccount };

export const SESSION_COOKIE = 'rcl_session';
/** Readable by the page script, and says nothing but "signed in". */
export const HINT_COOKIE = 'rcl_signed_in';

export const SESSION_DAYS = 30;
export const CODE_MINUTES = 15;
export const CODE_TRIES = 5;
export const SENDS_PER_EMAIL = 5;
export const SENDS_PER_IP = 20;
export const MIN_AGE = 18;

/** Everywhere the shop ships: the 50 states, DC, Puerto Rico, the USVI. */
export const STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL',
  'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE',
  'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'PR', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VI', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

export class AccountError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

/* ------------------------------------------------------------- reading forms */

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function required(input, field, label, max) {
  const v = clean(input[field], max);
  if (!v) throw new AccountError(field, `${label} is required.`);
  return v;
}

/** Whole years between a YYYY-MM-DD birth date and a YYYY-MM-DD today. */
export function ageOn(dob, today) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age;
}

export function readDob(value, today) {
  const dob = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) throw new AccountError('dob', 'Date of birth is required.');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) {
    throw new AccountError('dob', 'That date of birth is not a real date.');
  }
  const age = ageOn(dob, today);
  if (age < 0 || age > 110) throw new AccountError('dob', 'Check the year on your date of birth.');
  if (age < MIN_AGE) throw new AccountError('dob', `You have to be ${MIN_AGE} or older to make an account.`);
  return dob;
}

export function readAddress(input = {}) {
  const line1 = required(input, 'line1', 'Street address', 80);
  const line2 = clean(input.line2, 80);
  const city = required(input, 'city', 'City', 50);
  const state = clean(input.state, 2).toUpperCase();
  if (!STATES.has(state)) throw new AccountError('state', 'Pick your state.');
  const zip = clean(input.zip, 10);
  if (!/^\d{5}(-\d{4})?$/.test(zip)) throw new AccountError('zip', 'ZIP code is 5 digits.');
  return { line1, line2, city, state, zip };
}

/** Optional. Ten digits, a leading 1 dropped, or nothing at all. */
export function readPhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) throw new AccountError('phone', 'Phone is 10 digits, or leave it blank.');
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** The parts of an account the customer can change after sign-up. */
export function readDetails(input = {}) {
  return {
    firstName: required(input, 'firstName', 'First name', 40),
    lastName: required(input, 'lastName', 'Last name', 40),
    address: readAddress(input.address || input),
    phone: readPhone(input.phone),
    birthdayEmails: input.birthdayEmails !== false,
  };
}

/**
 * The sign-up form. Email and date of birth are set here once: the email is
 * the sign-in, and a date of birth that could be changed later would hand out
 * a birthday code every time it was moved to today.
 */
export function readSignup(input = {}, now = Date.now()) {
  const email = cleanEmail(input.email);
  if (!email) throw new AccountError('email', 'Check the email address.');
  const details = readDetails(input);
  const dob = readDob(input.dob, todayEastern(now).date);
  return { email, dob, ...details };
}

/* ---------------------------------------------------------------- crypto */

function randomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function sixDigits(random = crypto.getRandomValues.bind(crypto)) {
  const n = random(new Uint32Array(1))[0];
  return String(n % 1000000).padStart(6, '0');
}

function hashCode(env, email, code) {
  return sha256(`${env.ACCOUNT_SECRET}|${email}|${code}`);
}

function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------------- KV */

export function newAccount(signup, now = Date.now()) {
  const id = 'a_' + [...crypto.getRandomValues(new Uint8Array(6))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    id,
    email: signup.email,
    firstName: signup.firstName,
    lastName: signup.lastName,
    dob: signup.dob,
    address: signup.address,
    phone: signup.phone || '',
    birthdayEmails: signup.birthdayEmails !== false,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    passwordHash: signup.passwordHash || '',
    // Bumped by a password reset. A session made before it stops working.
    epoch: 0,
    stripeCustomerId: '',
    cardCount: 0,
    welcome: null,
    birthdays: {},
  };
}

/** True when this key has already been used `max` times this hour. */
async function overLimit(env, key, max) {
  const rec = await env.ACCOUNTS.get(key, { type: 'json' }).catch(() => null);
  const count = Number(rec && rec.count) || 0;
  if (count >= max) return true;
  await env.ACCOUNTS.put(key, JSON.stringify({ count: count + 1 }), { expirationTtl: 3600 });
  return false;
}

async function tooManyCodes(env, request, email) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (ip && await overLimit(env, 'ip:' + ip, SENDS_PER_IP)) return true;
  return overLimit(env, 'send:' + email, SENDS_PER_EMAIL);
}

async function putCode(env, email, record, now) {
  const exp = Math.floor(now / 1000) + CODE_MINUTES * 60;
  await env.ACCOUNTS.put('code:' + email, JSON.stringify({ ...record, tries: 0, exp }), { expiration: exp });
}

/* -------------------------------------------------------------- sessions */

function cookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

export function sessionCookies(token) {
  const age = SESSION_DAYS * 24 * 3600;
  return [
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`,
    `${HINT_COOKIE}=1; Path=/; Secure; SameSite=Lax; Max-Age=${age}`,
  ];
}

export function clearedCookies() {
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${HINT_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`,
  ];
}

export function withCookies(response, cookies) {
  const out = new Response(response.body, response);
  for (const c of cookies) out.headers.append('set-cookie', c);
  return out;
}

async function startSession(env, account, now) {
  const token = randomToken();
  await env.ACCOUNTS.put('sess:' + await sha256(token), JSON.stringify({
    email: account.email, accountId: account.id, epoch: Number(account.epoch) || 0,
    createdAt: new Date(now).toISOString(),
  }), { expirationTtl: SESSION_DAYS * 24 * 3600 });
  return token;
}

/**
 * The signed-in account, or null. A session is tied to the account's id as
 * well as its email, so deleting an account kills every browser signed in to
 * it — even one that comes back after the same email signs up again. And to
 * its epoch, so a password reset signs out every browser but the one that
 * did it.
 */
export async function currentAccount(request, env) {
  if (!env || !env.ACCOUNTS) return null;
  const token = cookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const key = 'sess:' + await sha256(token);
  const session = await env.ACCOUNTS.get(key, { type: 'json' }).catch(() => null);
  if (!session || !session.email) return null;
  const account = await getAccount(env, session.email).catch(() => null);
  if (!account || account.id !== session.accountId) return null;
  if ((Number(session.epoch) || 0) !== (Number(account.epoch) || 0)) return null;
  return { account, sessionKey: key };
}

/* --------------------------------------------------------------- what the page sees */

/** The account as the customer's own page shows it. Nothing internal. */
export function publicAccount(account) {
  return {
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
    dob: account.dob,
    address: account.address,
    phone: account.phone || '',
    birthdayEmails: account.birthdayEmails !== false,
    createdAt: account.createdAt,
    cardCount: Number(account.cardCount) || 0,
  };
}

/* ------------------------------------------------------------------ orders */

const SHOWN_ORDERS = 25;

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

/** What a customer chose on a line, minus hidden fields and empty boxes. */
function optionsOf(item) {
  return (Array.isArray(item.customFields) ? item.customFields : [])
    .filter((f) => f && f.type !== 'hidden' && f.name)
    .map((f) => {
      const raw = f.displayValue ?? f.value;
      if (raw === undefined || raw === null || raw === '' || raw === 'false') return null;
      if (f.type === 'checkbox' && (raw === true || raw === 'true')) return { name: String(f.name), value: 'Yes' };
      return { name: String(f.name).slice(0, 60), value: isUrl(raw) ? 'Attached' : String(raw).slice(0, 120) };
    })
    .filter(Boolean);
}

function productPath(url) {
  const m = /^\/(product-[a-z0-9-]+?)(?:\.html)?$/.exec(String(url || ''));
  return m ? '/' + m[1] : '';
}

/**
 * A picture for the line: the 600px webp every built-in product has, with the
 * photo Snipcart kept on the line as the fallback (a dashboard-made product
 * points at /photo/…, which has no small copy). Only our own paths — an
 * outside URL on a line item is not something to put on the page.
 */
function photoOf(item) {
  const own = (src) => (typeof src === 'string' && /^\/(assets\/img\/|photo\/)[A-Za-z0-9/_.-]+$/.test(src) ? src : '');
  const image = own(item.image);
  const named = /^\/assets\/img\/products\/([a-z0-9-]+)\.(?:jpg|jpeg|png|webp)$/.exec(image);
  const slug = productPath(item.url).replace(/^\/product-/, '');
  const thumb = named ? `/assets/img/products/${named[1]}-600.webp`
    : !image && slug ? `/assets/img/products/${slug}-600.webp`
    : image;
  return { thumb, image: image || thumb };
}

export function orderStatus(order) {
  if (isCancelled(order)) return 'cancelled';
  if (refundState(order) === 'full') return 'refunded';
  if (order.status === 'Delivered') return 'delivered';
  if (isShipped(order)) return 'shipped';
  if (isPaid(order)) return 'building';
  return 'pending';
}

export function orderView(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const tracking = String(order.trackingNumber || '').trim();
  const status = orderStatus(order);
  // The box ships when the slowest piece in it is done.
  const slowest = items.map((i) => leadTime(i)).sort((a, b) => b.days - a.days)[0];
  return {
    invoice: order.invoiceNumber || '',
    placedAt: order.completionDate || order.creationDate || '',
    status,
    total: Number(grandTotal(order)) || 0,
    currency: String(order.currency || 'usd').toLowerCase(),
    items: items.map((i) => ({
      name: String(i.name || 'Item'),
      quantity: Number(i.quantity) || 1,
      total: Number(i.totalPrice ?? (Number(i.price) || 0) * (Number(i.quantity) || 1)) || 0,
      // "Buy again" goes to the product page. A quote line points at a quote
      // that is already paid for, so it gets no link.
      url: productPath(i.url),
      ...photoOf(i),
      options: optionsOf(i),
    })),
    tracking: tracking ? { number: tracking, url: order.trackingUrl || trackingUrlFor(tracking) } : null,
    leadTime: status === 'building' && slowest ? slowest.promise : '',
  };
}

/**
 * Every order under this email, newest first. Snipcart files orders under a
 * customer record and can look one up by exact email, so this is two or
 * three calls however old the account is. More than one record can carry the
 * same email (a guest checkout and a later one), so every match is read.
 *
 * The email filter is checked again on each order, because this is the one
 * place a mix-up would show one customer another customer's address.
 *
 * Snipcart keeps the email as the buyer typed it, and its docs don't say
 * whether the lookup ignores case. So when it finds nobody, every order is
 * read instead and matched without case — a buyer who typed Pat@Example.com at
 * checkout still sees that order under pat@example.com. For a shop this size
 * that is a page or two of orders, and only for accounts the lookup missed.
 */
export async function ordersFor(env, email) {
  const found = await getJson(env, `/customers?email=${encodeURIComponent(email)}&limit=10`);
  const customers = (found && Array.isArray(found.items) ? found.items : [])
    .filter((c) => c && c.id && String(c.email || '').trim().toLowerCase() === email);
  const lists = customers.length
    ? await Promise.all(customers.map((c) => getJson(env, `/customers/${encodeURIComponent(c.id)}/orders`)))
    : [(await getAllOrders(env)).orders];

  const byToken = new Map();
  for (const list of lists) {
    for (const o of Array.isArray(list) ? list : (list && list.items) || []) {
      if (!o || !o.token) continue;
      if (String(o.email || '').trim().toLowerCase() !== email) continue;
      byToken.set(o.token, o);
    }
  }
  let orders = [...byToken.values()]
    .sort((a, b) => String(b.completionDate || b.creationDate || '').localeCompare(String(a.completionDate || a.creationDate || '')))
    .slice(0, SHOWN_ORDERS);

  // The customer listing may come back without line items. Fetch those whole.
  const thin = orders.filter((o) => !Array.isArray(o.items)).map((o) => o.token);
  if (thin.length) {
    const full = new Map((await getOrders(env, thin)).map((o) => [o.token, o]));
    orders = orders.map((o) => full.get(o.token) || o)
      .filter((o) => String(o.email || '').trim().toLowerCase() === email);
  }
  return orders.map(orderView);
}

/* ------------------------------------------------------------- storefront */

/**
 * Until accounts are switched on, the header's account icon and any other
 * "sign in" line (marked data-account-only) come off every page on the way
 * out. So the pages can carry the link from the day this code lands, and a
 * deploy made before the namespace and secret exist shows customers nothing
 * that leads to "not switched on yet".
 *
 * HTMLRewriter is a Workers global; outside the runtime the page goes back
 * untouched, the same as the sale banner.
 */
export async function withAccountLinks(response, request, env) {
  if (accountsConfigured(env)) return response;
  if (request.method !== 'GET' || response.status !== 200) return response;
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;
  if (typeof HTMLRewriter === 'undefined') return response;
  const gone = { element(el) { el.remove(); } };
  return new HTMLRewriter()
    .on('a.account-link', gone)
    .on('p[data-account-only]', gone)
    .transform(response);
}

/* ---------------------------------------------------------------- requests */

async function readBody(request) {
  return request.json().catch(() => ({}));
}

/**
 * Every POST here changes something, so it has to be the shop's own page
 * asking: JSON (a cross-site form cannot send that without a preflight we never
 * answer) and, when the browser says where it came from, from this origin.
 */
export function postProblem(request) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) return json({ error: 'Send JSON.' }, 415);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Not from this site.' }, 403);
  return null;
}

const OFF = { off: true, error: 'Accounts are not switched on yet.' };

/** Wrong passwords allowed before that email or that address waits an hour. */
export const FAILS_PER_EMAIL = 10;
export const FAILS_PER_IP = 30;

async function mail(env, message, to) {
  await sendMail(env, { to, subject: message.subject, html: message.html, text: message.text, transactional: true });
}

function fieldError(err) {
  if (err instanceof AccountError || err instanceof PasswordError) {
    return json({ error: err.message, field: err.field }, 400);
  }
  throw err;
}

/**
 * Checks a code against what is waiting for this email, for this purpose.
 * Answers { rec } when it matches (and the code is used up), or { response }
 * with what to tell the browser. Five wrong tries and the code is dead.
 */
async function takeCode(env, email, code, purpose, now) {
  const key = 'code:' + email;
  const rec = await env.ACCOUNTS.get(key, { type: 'json' });
  if (!rec || !rec.hash || rec.purpose !== purpose || (rec.exp && rec.exp * 1000 <= now)) {
    return { response: json({ error: 'That code has run out. Send a new one.', field: 'code', expired: true }, 400) };
  }
  if ((Number(rec.tries) || 0) >= CODE_TRIES) {
    await env.ACCOUNTS.delete(key);
    return { response: json({ error: 'Too many wrong tries. Send a new code.', field: 'code', expired: true }, 429) };
  }
  if (!sameText(await hashCode(env, email, code), rec.hash)) {
    const tries = (Number(rec.tries) || 0) + 1;
    const floor = Math.floor(now / 1000) + 60;
    await env.ACCOUNTS.put(key, JSON.stringify({ ...rec, tries }), { expiration: Math.max(rec.exp || 0, floor) });
    const left = CODE_TRIES - tries;
    return {
      response: json({
        error: left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Send a new code.',
        field: 'code',
        expired: left <= 0,
      }, 400),
    };
  }
  await env.ACCOUNTS.delete(key);
  return { rec };
}

function signedIn(env, account, now, extra = {}) {
  return startSession(env, account, now).then((token) =>
    withCookies(json({ ok: true, account: publicAccount(account), ...extra }), sessionCookies(token)));
}

/**
 * "Forgot your password?" — and "change password" from the account page,
 * which is the same thing. Emails a code to set a new one. Same answer
 * whether or not the email has an account, so the page never says who does;
 * the email tells the person at that address, and only them.
 */
async function handleCode(request, env, now) {
  const body = await readBody(request);
  const email = cleanEmail(body.email);
  if (!email) return json({ error: 'Check the email address.', field: 'email' }, 400);
  if (await tooManyCodes(env, request, email)) {
    return json({ error: 'That is a lot of codes. Wait an hour and try again.' }, 429);
  }

  const account = await getAccount(env, email);
  try {
    if (account) {
      const code = sixDigits();
      await putCode(env, email, { hash: await hashCode(env, email, code), purpose: 'reset' }, now);
      await mail(env, resetCodeEmail(code), email);
    } else {
      await mail(env, noAccountEmail(), email);
    }
  } catch (err) {
    console.error('account code email failed', err?.message || err);
    return json({ error: 'We could not send the email. Try again in a minute.' }, 502);
  }
  return json({ ok: true, email });
}

/**
 * The sign-up form, password and all. Nothing is made yet: the password is
 * hashed and held with the form under a code emailed to the address, and the
 * account appears only when that code comes back. That one step is what
 * proves the email is theirs, and so what stops made-up addresses from
 * collecting 20% codes.
 */
async function handleSignup(request, env, now) {
  const body = await readBody(request);
  let signup;
  let password;
  try {
    signup = readSignup(body, now);
    password = readPassword(body.password, { email: signup.email });
  } catch (err) {
    return fieldError(err);
  }
  if (await tooManyCodes(env, request, signup.email)) {
    return json({ error: 'That is a lot of codes. Wait an hour and try again.' }, 429);
  }

  const existing = await getAccount(env, signup.email);
  try {
    if (existing) {
      // Same work as a new sign-up, so the answer takes as long either way.
      await burnOneHash(env);
      await mail(env, existingAccountEmail(), signup.email);
    } else {
      const code = sixDigits();
      const passwordHash = await hashPassword(env, password);
      await putCode(env, signup.email, {
        hash: await hashCode(env, signup.email, code), purpose: 'signup', signup: { ...signup, passwordHash },
      }, now);
      await mail(env, signUpCodeEmail(code, signup.firstName), signup.email);
    }
  } catch (err) {
    console.error('account signup email failed', err?.message || err);
    return json({ error: 'We could not send the email. Try again in a minute.' }, 502);
  }
  return json({ ok: true, email: signup.email });
}

/** The code from the sign-up email. Makes the account and signs it in. */
async function handleVerify(request, env, now) {
  const body = await readBody(request);
  const email = cleanEmail(body.email);
  const code = String(body.code ?? '').replace(/\D/g, '');
  if (!email || code.length !== 6) return json({ error: 'The code is 6 digits.', field: 'code' }, 400);

  const taken = await takeCode(env, email, code, 'signup', now);
  if (taken.response) return taken.response;
  const { rec } = taken;

  let account = await getAccount(env, email);
  let created = false;
  if (!account) {
    if (!rec.signup || !rec.signup.passwordHash) {
      return json({ error: 'That code has run out. Fill in the form again.', field: 'code', expired: true }, 400);
    }
    account = newAccount(rec.signup, now);
    await putAccount(env, account);
    await env.ACCOUNTS.put(birthdayKey(account), '');
    created = true;
    account = await grantWelcome(env, account, now);
    try {
      await mail(env, welcomeEmail(account.firstName, account.welcome), email);
    } catch (err) {
      // The code is on their account page either way.
      console.error('account welcome email failed', err?.message || err);
    }
  }
  return signedIn(env, account, now, { created });
}

/**
 * Email and password. A wrong one counts against the email and against the
 * address it came from; ten for one email or thirty from one address in an
 * hour, and it waits. The answer for an email with no account looks and
 * takes the same as a wrong password.
 */
async function handleSignin(request, env, now) {
  const body = await readBody(request);
  const email = cleanEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email) return json({ error: 'Check the email address.', field: 'email' }, 400);
  if (!password) return json({ error: 'Type your password.', field: 'password' }, 400);
  if (password.length > 256) return json({ error: "That email and password don't match.", field: 'password' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const emailKey = 'fail:' + email;
  const ipKey = ip ? 'ipfail:' + ip : '';
  const [byEmail, byIp] = await Promise.all([
    env.ACCOUNTS.get(emailKey, { type: 'json' }).catch(() => null),
    ipKey ? env.ACCOUNTS.get(ipKey, { type: 'json' }).catch(() => null) : null,
  ]);
  if ((Number(byEmail && byEmail.count) || 0) >= FAILS_PER_EMAIL || (Number(byIp && byIp.count) || 0) >= FAILS_PER_IP) {
    return json({ error: 'Too many wrong passwords. Wait an hour, or tap "Forgot your password?" to set a new one.' }, 429);
  }

  const account = await getAccount(env, email);
  let ok = false;
  if (account && account.passwordHash) {
    ok = await checkPassword(env, password, account.passwordHash);
  } else {
    await burnOneHash(env);
  }

  if (!ok) {
    const bump = (key, rec) => env.ACCOUNTS.put(key, JSON.stringify({ count: (Number(rec && rec.count) || 0) + 1 }), { expirationTtl: 3600 });
    await Promise.all([bump(emailKey, byEmail), ipKey ? bump(ipKey, byIp) : null]);
    if (account && !account.passwordHash) {
      return json({ error: 'This account has no password yet. Tap "Forgot your password?" and we will email a code to set one.', field: 'password' }, 400);
    }
    return json({ error: "That email and password don't match.", field: 'password' }, 400);
  }

  if (byEmail) await env.ACCOUNTS.delete(emailKey).catch(() => {});
  if (needsRehash(account.passwordHash)) {
    account.passwordHash = await hashPassword(env, password);
    await putAccount(env, account);
  }
  return signedIn(env, account, now);
}

/**
 * The code from a password email, plus the new password. Sets it, signs out
 * every other browser on the account, and signs this one in.
 */
async function handleReset(request, env, now) {
  const body = await readBody(request);
  const email = cleanEmail(body.email);
  const code = String(body.code ?? '').replace(/\D/g, '');
  if (!email) return json({ error: 'Check the email address.', field: 'email' }, 400);
  if (code.length !== 6) return json({ error: 'The code is 6 digits.', field: 'code' }, 400);
  let password;
  try {
    password = readPassword(body.password, { email });
  } catch (err) {
    return fieldError(err);
  }

  const taken = await takeCode(env, email, code, 'reset', now);
  if (taken.response) return taken.response;

  const account = await getAccount(env, email);
  if (!account) return json({ error: 'There is no account under this email.', field: 'email' }, 400);
  account.passwordHash = await hashPassword(env, password);
  account.epoch = (Number(account.epoch) || 0) + 1;
  await putAccount(env, account);
  await env.ACCOUNTS.delete('fail:' + email).catch(() => {});
  return signedIn(env, account, now);
}

function signedOut() {
  return withCookies(json({ signedIn: false, error: 'Sign in first.' }, 401), clearedCookies());
}

async function handleMe(request, env, now) {
  const who = await currentAccount(request, env);
  if (!who) return signedOut();
  let account = who.account;

  // A sign-up code that Snipcart would not take at sign-up gets another go.
  if (account.welcome && account.welcome.pending) {
    account = await grantWelcome(env, account, now);
  }

  const [usage, sale] = await Promise.all([couponUsage(env, account, now), saleNote(env, now)]);
  return json({
    signedIn: true,
    account: publicAccount(account),
    coupons: couponList(account, usage, now).map((c) => ({ ...c, goodThrough: goodThrough(c.expiresAt) })),
    sale,
    cards: { enabled: !!(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY) },
  });
}

async function handleOrders(request, env) {
  const who = await currentAccount(request, env);
  if (!who) return signedOut();
  try {
    return json({ orders: await ordersFor(env, who.account.email) });
  } catch (err) {
    console.error('account orders failed', err?.message || err);
    return json({ error: 'Your orders could not be loaded right now. Try again in a minute.' }, 502);
  }
}

async function handleUpdate(request, env) {
  const who = await currentAccount(request, env);
  if (!who) return signedOut();
  const body = await readBody(request);
  let details;
  try {
    details = readDetails(body);
  } catch (err) {
    return fieldError(err);
  }
  const account = { ...who.account, ...details };
  await putAccount(env, account);
  return json({ ok: true, account: publicAccount(account) });
}

async function handleSignout(request, env) {
  const who = await currentAccount(request, env);
  if (who) await env.ACCOUNTS.delete(who.sessionKey);
  return withCookies(json({ ok: true }), clearedCookies());
}

/**
 * Gone means gone: the record, the birthday index, and the Stripe customer,
 * which takes every saved card with it. If Stripe will not delete the cards,
 * nothing is deleted — an account removed with a card still on file is the
 * one outcome worse than a retry.
 *
 * Orders stay in Snipcart: they are the shop's sales records, kept for taxes
 * and the warranty, as the privacy policy says.
 */
async function handleDelete(request, env) {
  const who = await currentAccount(request, env);
  if (!who) return signedOut();
  const body = await readBody(request);
  if (String(body.confirm || '').trim().toLowerCase() !== 'delete') {
    return json({ error: 'Type DELETE to confirm.', field: 'confirm' }, 400);
  }
  const account = who.account;
  if (account.stripeCustomerId) {
    try {
      await stripe(env, 'DELETE', '/customers/' + encodeURIComponent(account.stripeCustomerId));
    } catch (err) {
      if (!/404/.test(String(err?.message))) {
        console.error('account delete: stripe refused', err?.message || err);
        return json({ error: 'We could not remove your saved cards. Nothing was deleted. Try again in a minute.' }, 502);
      }
    }
  }
  await env.ACCOUNTS.delete(birthdayKey(account));
  await deleteAccount(env, account);
  await env.ACCOUNTS.delete(who.sessionKey);
  return withCookies(json({ ok: true }), clearedCookies());
}

export async function routeAccount(path, request, env, now = Date.now()) {
  if (!accountsConfigured(env)) return json(OFF, 503);

  if (path === '/api/account/me') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    return handleMe(request, env, now);
  }
  if (path === '/api/account/orders') {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    return handleOrders(request, env);
  }

  const problem = postProblem(request);
  if (problem) return problem;

  if (path === '/api/account/signin') return handleSignin(request, env, now);
  if (path === '/api/account/signup') return handleSignup(request, env, now);
  if (path === '/api/account/verify') return handleVerify(request, env, now);
  if (path === '/api/account/code') return handleCode(request, env, now);
  if (path === '/api/account/reset') return handleReset(request, env, now);
  if (path === '/api/account/update') return handleUpdate(request, env);
  if (path === '/api/account/signout') return handleSignout(request, env);
  if (path === '/api/account/delete') return handleDelete(request, env);
  return json({ error: 'Not found.' }, 404);
}
