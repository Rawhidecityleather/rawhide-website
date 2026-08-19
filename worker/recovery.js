/**
 * Abandoned cart recovery, step 3: a unique 15% code per cart.
 *
 * Snipcart's own recovery campaign handles steps 1 and 2 (4h and 24h, no
 * discount). It cannot handle this one. Its discounts carry a single absolute
 * expiry date shared by every recipient, so "good for 7 days" would mean a full
 * week for an early abandoner and an afternoon for a late one. The only way to
 * give everyone the same seven days is to mint a code per cart, which means
 * sending this email ourselves.
 *
 * So: Snipcart's campaign must be TWO steps only. If step 3 is left on there,
 * every customer gets two last-call emails. See email/ABANDONED-CART-SETUP.md.
 *
 * The flow, once an hour on a cron trigger:
 *
 *   1. List carts abandoned in the last week.
 *   2. Keep the ones aged past 72 hours that we have not already emailed.
 *   3. Mint a single-use code and create the discount in Snipcart.
 *   4. Send the email ourselves.
 *   5. Write a KV marker so the next run leaves that cart alone.
 */

import { getJson, postJson } from './snipcart.js';
import { sendMail, mailerConfigured, MailError, UNSUBSCRIBE_TO } from './mailer.js';

/** 72 hours. The "3 days" in the brief, and the step-3 slot in the campaign. */
export const SEND_AFTER_HOURS = 72;

/**
 * Carts older than this are left alone. Without it, the first run after deploy
 * would mail every cart Snipcart has ever recorded — including people who
 * walked away months ago and would rightly read it as spam.
 */
export const MAX_AGE_HOURS = 24 * 7;

/**
 * Ceiling per run. A backlog trickles out over a few hours instead of arriving
 * as one blast, which is both better for sender reputation and a smaller blast
 * radius if something here is wrong.
 */
export const MAX_PER_RUN = 25;

/** How long each customer's code lives. The whole point of the exercise. */
export const CODE_TTL_DAYS = 7;

/** Percent off. */
export const DISCOUNT_RATE = 15;

/** Give up on a cart after this many failed sends so it can't retry forever. */
export const MAX_ATTEMPTS = 3;

const KEY_PREFIX = 'recovery:';

/**
 * Never mail these. Our own addresses, not customers.
 *
 * `rawhidecityleather@gmail.com` is the shop's own inbox and it does turn up in
 * the live abandoned-cart list from checkout testing — without it here, Rob gets
 * a coupon and a real single-use discount is minted and wasted.
 *
 * The cost of this list: an address on it can no longer be used to test the real
 * flow end to end, because the cron will skip it. Use a different inbox you own
 * for that, and add nothing here that you still want to receive mail.
 */
const TEST_EMAILS = new Set([
  'test@example.com',
  'rawhidecityleather@gmail.com',
]);

const STORE_URL = 'https://rawhidecityleather.com';

const HOUR = 3600 * 1000;

/* ------------------------------------------------------------------ codes */

/**
 * No 0/O/1/I/5/S — these get read off a screen and typed by someone on shift.
 * 8 characters out of this alphabet is ~30 bits, far past guessing range for a
 * code that is also single-use and expires in a week.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

export function makeCode(random = crypto.getRandomValues.bind(crypto)) {
  const bytes = random(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return 'RCL' + out;
}

/* ------------------------------------------------------------------ carts */

/**
 * Every cart abandoned in the last week, newest pages first.
 *
 * `timeRange` is an upper bound only — LessThanAWeek means "at most a week
 * old", not "between 3 and 7 days" — so the 72 hour floor is applied here in
 * code rather than by the API.
 */
export async function listAbandonedCarts(env, limit = 50) {
  const carts = [];
  let continuationToken = null;

  // Bounded so a large account can't fan out into unlimited subrequests.
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ timeRange: 'LessThanAWeek', limit: String(limit) });
    if (continuationToken) params.set('continuationToken', continuationToken);

    const res = await getJson(env, '/carts/abandoned?' + params);
    carts.push(...(res.items || []));

    if (!res.hasMoreResults || !res.continuationToken) break;
    continuationToken = res.continuationToken;
  }

  return carts;
}

/**
 * Field names, most specific first. Snipcart's abandoned-cart payload does NOT
 * use `modificationDate` / `creationDate` — assuming it did made every cart
 * read as undateable, and the first live run skipped all nine with
 * `reasons={"no-date":9}`. Rather than guess one replacement and wait an hour
 * per attempt, this tries the plausible spellings in order and falls back to
 * any date-ish field that parses. `logCartShape` below records what the payload
 * actually contains so this list can be cut back to the real name.
 */
const DATE_FIELDS = [
  'lastModificationDate', 'modificationDate', 'dateModified', 'modifiedOn',
  'lastActivityDate', 'abandonedDate',
  'creationDate', 'dateCreated', 'createdOn',
];

/**
 * Snipcart sends these as a **numeric epoch in seconds**, which cost two live
 * runs to pin down. `Date.parse()` on a number returns NaN, so the first
 * version read every cart as undateable; treating the number as milliseconds
 * then dated them all to 1970 and they were skipped as too old. Nine carts
 * abandoned days apart differ by ~600,000 seconds, which misread as
 * milliseconds is ten minutes — which is why every age came back identical.
 *
 * So: seconds and milliseconds both have to work, and so do the ISO strings
 * every other Snipcart endpoint returns.
 */
function parseDate(value) {
  if (value == null) return 0;

  const asNumber =
    typeof value === 'number' ? value
      : (typeof value === 'string' && /^\d+$/.test(value.trim())) ? Number(value)
        : null;

  if (asNumber !== null) {
    if (!Number.isFinite(asNumber) || asNumber <= 0) return 0;
    // A real date in seconds is ~1.7e9; in milliseconds ~1.7e12. Nothing
    // plausible sits near the 1e11 line, so it separates them cleanly.
    return asNumber < 1e11 ? asNumber * 1000 : asNumber;
  }

  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** When the customer actually walked away: last activity, not cart creation. */
export function abandonedAt(cart) {
  if (!cart) return 0;

  for (const field of DATE_FIELDS) {
    const t = parseDate(cart[field]);
    if (t) return t;
  }

  // Last resort: any top-level key that looks like a date and parses. Prefer
  // the most recent, since abandonment is the last thing that happened.
  let best = 0;
  for (const [key, value] of Object.entries(cart)) {
    if (!/date|modified|created|time/i.test(key)) continue;
    const t = parseDate(value);
    if (t > best) best = t;
  }
  return best;
}

/**
 * The key names on one cart, so a payload mismatch is a one-run diagnosis
 * instead of a guessing game. Names only, never values — this goes to a log.
 */
export function cartShape(cart) {
  return cart ? Object.keys(cart).sort() : [];
}

/**
 * Old enough to be worth an email, young enough that it isn't archaeology, and
 * addressed to a real person.
 */
export function dueReason(cart, now) {
  const at = abandonedAt(cart);
  if (!at) return 'no-date';

  const ageHours = (now - at) / HOUR;
  if (ageHours < SEND_AFTER_HOURS) return 'too-recent';
  if (ageHours > MAX_AGE_HOURS) return 'too-old';

  const email = String(cart.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return 'no-email';
  if (TEST_EMAILS.has(email)) return 'test-email';

  // An empty cart has nothing to come back to.
  if (!Array.isArray(cart.items) || cart.items.length === 0) return 'no-items';

  return 'due';
}

export function isDue(cart, now) {
  return dueReason(cart, now) === 'due';
}

export function cartUrl(cart) {
  return `${STORE_URL}?snipcart_token=${encodeURIComponent(cart.token || cart.id)}#!/cart`;
}

/* -------------------------------------------------------------- discounts */

/**
 * One code, one cart, one use, expiring seven days from right now.
 *
 * `combinable` is explicitly false. Snipcart defaults it to true, which would
 * let this stack on top of any sitewide rule that happens to be running and
 * quietly hand out more than 15%.
 */
export async function createDiscount(env, cart, code, now) {
  const expires = new Date(now + CODE_TTL_DAYS * 24 * HOUR);

  const discount = await postJson(env, '/discounts', {
    name: `Cart recovery ${DISCOUNT_RATE}% - ${cart.email}`,
    trigger: 'Code',
    code,
    type: 'Rate',
    rate: DISCOUNT_RATE,
    maxNumberOfUsages: 1,
    combinable: false,
    expires: expires.toISOString(),
  });

  return { id: discount?.id || '', expiresAt: expires.toISOString() };
}

/* ------------------------------------------------------------------ email */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function money(amount) {
  return '$' + (Number(amount) || 0).toFixed(2);
}

/** "August 24" — how the deadline reads in the email. */
export function prettyDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

function firstName(cart) {
  const full = cart?.billingAddress?.fullName || cart?.shippingAddress?.fullName || '';
  return String(full).trim().split(/\s+/)[0] || '';
}

/**
 * Both halves of the message. Plain text is not optional — some clients only
 * render it, and a missing text part reads as spam to the filters.
 *
 * `postalAddress` is not decoration. This email's purpose is a discount offer,
 * which makes it commercial mail under CAN-SPAM, and commercial mail has to
 * carry a working opt-out and a real physical mailing address. A PO box counts;
 * the home shop address does not have to be published. It comes from a secret
 * rather than a constant here because nobody should be inventing it.
 */
export function renderRecoveryEmail(cart, code, expiresAt, postalAddress) {
  const name = firstName(cart);
  const greeting = name ? `Hey ${name},` : 'Hey,';
  const deadline = prettyDate(expiresAt);
  const link = cartUrl(cart);
  const items = Array.isArray(cart.items) ? cart.items : [];

  const subject = `${DISCOUNT_RATE}% off your cart, through ${deadline}`;

  const text = [
    greeting,
    '',
    `Your cart is still sitting here. Here is ${DISCOUNT_RATE} percent off to get it finished.`,
    '',
    `Code: ${code}`,
    `Good through ${deadline}. It only works once, and only on this cart.`,
    '',
    ...items.map((i) => `  ${i.name}${i.quantity > 1 ? ` x ${i.quantity}` : ''}  ${money(i.totalPrice)}`),
    items.length ? '' : null,
    'Free shipping on orders over $85.',
    '',
    `Finish your order: ${link}`,
    '',
    'Every piece we build carries a career warranty. If workmanship or materials',
    'ever fail you, we repair it.',
    '',
    'This is the last we will email you about this cart.',
    '',
    '"We do not cut corners. We cut leather."',
    '',
    'Rawhide City Leather - Firefighter Owned - Est. 2024',
    postalAddress,
    `${STORE_URL}/shop`,
    '',
    `Do not want these? Reply with "unsubscribe" or email ${UNSUBSCRIBE_TO} and`,
    'we will take you off the list.',
  ].filter((line) => line !== null).join('\n');

  const rows = items.map((i) => `
                    <tr>
                      <td style="padding:0 20px 10px 20px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                          <tr>
                            <td style="font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.5;color:#0F0F0F;">${escapeHtml(i.name)}${i.quantity > 1 ? ` &times; ${escapeHtml(i.quantity)}` : ''}</td>
                            <td align="right" style="font-family:'Courier New',Courier,monospace;font-size:15px;color:#0F0F0F;white-space:nowrap;padding-left:12px;">${money(i.totalPrice)}</td>
                          </tr>
                        </table>
                      </td>
                    </tr>`).join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#EBE8E1;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${DISCOUNT_RATE}% off the cart you left, good through ${deadline}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EBE8E1" style="background-color:#EBE8E1;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">

        <tr>
          <td align="center" style="padding:0 0 24px 0;">
            <img src="${STORE_URL}/assets/img/logo.png" width="170" alt="Rawhide City Leather" style="display:block;width:170px;max-width:60%;height:auto;border:0;">
          </td>
        </tr>

        <tr>
          <td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #DFDBD2;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

              <tr>
                <td bgcolor="#0F0F0F" align="center" style="background-color:#0F0F0F;padding:26px 24px;">
                  <p style="margin:0 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#A9A59B;">Firefighter Owned &middot; Est. 2024</p>
                  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:26px;line-height:1.15;letter-spacing:2px;text-transform:uppercase;color:#EBE8E1;">${DISCOUNT_RATE}% off your cart</p>
                </td>
              </tr>

              <tr>
                <td style="padding:32px 36px 8px 36px;">
                  <p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.6;color:#0F0F0F;">${escapeHtml(greeting)}</p>
                  <p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:#3A3833;">Your cart is still sitting here. Here is ${DISCOUNT_RATE} percent off to get it finished.</p>
                </td>
              </tr>

              <tr>
                <td style="padding:8px 36px 8px 36px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td bgcolor="#0F0F0F" align="center" style="background-color:#0F0F0F;padding:24px 22px;">
                        <p style="margin:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#A9A59B;">Your code</p>
                        <p style="margin:0 0 10px 0;font-family:'Courier New',Courier,monospace;font-weight:bold;font-size:28px;letter-spacing:4px;color:#EBE8E1;">${escapeHtml(code)}</p>
                        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#A9A59B;">Good through ${escapeHtml(deadline)}</p>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:12px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.6;color:#6B6358;">Yours alone. It works once, on this cart, and then it is done.</p>
                </td>
              </tr>
${items.length ? `
              <tr>
                <td style="padding:16px 36px 8px 36px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EBE8E1" style="background-color:#EBE8E1;border:1px dashed #6B6358;">
                    <tr>
                      <td style="padding:20px 20px 0 20px;">
                        <p style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#6B6358;">In your cart</p>
                      </td>
                    </tr>${rows}
                    <tr>
                      <td style="padding:2px 20px 20px 20px;">
                        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6B6358;">Free shipping on orders over $85</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>` : ''}

              <tr>
                <td align="center" style="padding:24px 36px 8px 36px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="#0F0F0F" style="background-color:#0F0F0F;">
                        <a href="${escapeHtml(link)}" target="_blank" style="display:inline-block;padding:15px 42px;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#EBE8E1;text-decoration:none;">Finish Your Order</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <tr>
                <td style="padding:24px 36px 0 36px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr><td style="border-top:1px solid #E5E1D8;font-size:0;line-height:0;">&nbsp;</td></tr>
                  </table>
                </td>
              </tr>

              <tr>
                <td style="padding:20px 36px 8px 36px;">
                  <p style="margin:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#0F0F0F;">Career warranty</p>
                  <p style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.65;color:#3A3833;">Every piece we build carries it. If workmanship or materials ever fail you, we repair it. That is the whole point of buying from someone who has worn the gear. <a href="${STORE_URL}/shipping#warranty" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Read the warranty</a>.</p>
                  <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.65;color:#3A3833;">This is the last we will email you about this cart.</p>
                </td>
              </tr>

              <tr>
                <td align="center" style="padding:12px 36px 32px 36px;">
                  <p style="margin:0;font-family:'Courier New',Courier,monospace;font-style:italic;font-size:14px;color:#6B6358;">"We do not cut corners. We cut leather."</p>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:28px 24px 8px 24px;">
            <p style="margin:0 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:14px;letter-spacing:3px;text-transform:uppercase;color:#0F0F0F;">Rawhide City Leather</p>
            <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6B6358;">Firefighter Owned &middot; Est. 2024</p>
            <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#6B6358;">${escapeHtml(postalAddress)}</p>
            <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1px;">
              <a href="${STORE_URL}/shop" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Shop</a>
              &nbsp;&middot;&nbsp;
              <a href="${STORE_URL}/crews" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Crew Orders</a>
              &nbsp;&middot;&nbsp;
              <a href="${STORE_URL}/contact" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Contact</a>
            </p>
            <p style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#6B6358;">Questions? Just reply to this email and we will get you squared away.</p>
            <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#6B6358;">Do not want these? <a href="mailto:${UNSUBSCRIBE_TO}?subject=Unsubscribe" style="color:#6B6358;text-decoration:underline;">Unsubscribe</a> and we will take you off the list.</p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body></html>`;

  return { subject, html, text };
}

/* ------------------------------------------------------------- the KV log */

export function recordKey(token) {
  return KEY_PREFIX + token;
}

export async function getRecord(env, token) {
  const raw = await env.RECOVERY.get(recordKey(token));
  return raw ? JSON.parse(raw) : null;
}

export async function putRecord(env, record) {
  await env.RECOVERY.put(recordKey(record.token), JSON.stringify(record), {
    metadata: {
      email: record.email,
      code: record.code,
      sentAt: record.sentAt || '',
      attempts: record.attempts || 0,
    },
    // Long enough to outlive the code and answer "did this person already get
    // one?" for a while afterward. The order itself lives in Snipcart.
    expirationTtl: 90 * 24 * 3600,
  });
  return record;
}

/** Newest first, for the dashboard. Summaries only. */
export async function listRecoveries(env, limit = 200) {
  const { keys } = await env.RECOVERY.list({ prefix: KEY_PREFIX, limit });
  return keys
    .map((key) => ({ token: key.name.slice(KEY_PREFIX.length), ...(key.metadata || {}) }))
    .sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
}

/* --------------------------------------------------------------- the run */

/**
 * One cart, end to end. Split out from runRecovery so a single cart can be
 * driven by hand from the dashboard without waiting for the cron.
 *
 * The order matters. The discount is created and written to KV *before* the
 * send, so a send that fails leaves a record holding the code — the retry
 * reuses it instead of minting a second discount for the same person.
 */
export async function recoverCart(env, cart, now) {
  // Checked before anything is minted. Creating the discount first and
  // discovering the mailer is unconfigured second would leave a trail of live
  // 15% codes in Snipcart that nobody was ever told about.
  if (!mailerConfigured(env)) throw new MailError('Email is not configured.');

  const token = cart.token || cart.id;
  let record = await getRecord(env, token);

  if (record?.sentAt) return { token, status: 'already-sent' };
  if (record && record.attempts >= MAX_ATTEMPTS) return { token, status: 'given-up' };

  if (!record?.code) {
    const code = makeCode();
    const { id, expiresAt } = await createDiscount(env, cart, code, now);
    record = {
      token,
      email: cart.email,
      code,
      discountId: id,
      expiresAt,
      createdAt: new Date(now).toISOString(),
      sentAt: '',
      attempts: 0,
      lastError: '',
    };
    await putRecord(env, record);
  }

  const { subject, html, text } = renderRecoveryEmail(
    cart,
    record.code,
    record.expiresAt,
    env.RECOVERY_POSTAL_ADDRESS
  );

  try {
    await sendMail(env, { to: cart.email, subject, html, text });
  } catch (err) {
    record.attempts = (record.attempts || 0) + 1;
    record.lastError = String(err?.message || err).slice(0, 300);
    await putRecord(env, record);
    return { token, status: 'send-failed', error: record.lastError };
  }

  record.sentAt = new Date(now).toISOString();
  await putRecord(env, record);
  return { token, status: 'sent', code: record.code };
}

/**
 * The cron entry point. Returns a report rather than throwing on individual
 * failures — one bad cart must not stop the rest of the batch.
 */
export async function runRecovery(env, now = Date.now()) {
  if (!mailerConfigured(env)) {
    return { scanned: 0, due: 0, counts: {}, results: [], skipped: 'mailer-not-configured' };
  }

  const carts = await listAbandonedCarts(env);

  // Tally why each cart was skipped. "due=0" on its own is unactionable — it
  // could mean the window is genuinely empty, or that a field this code reads
  // is not in the payload at all, and those need very different fixes.
  const reasons = {};
  const due = [];
  const ages = [];
  let usingCreationDate = 0;
  for (const cart of carts) {
    const reason = dueReason(cart, now);
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (reason === 'due' && due.length < MAX_PER_RUN) due.push(cart);

    // Which field the age actually came from, and what it worked out to. If
    // modificationDate turns out to be a record-touched timestamp rather than
    // when the customer walked away, every cart reads as brand new and the
    // whole window is wrong — this is what distinguishes that from an empty
    // window. Ages only, no addresses: this goes to a log.
    if (!cart?.modificationDate) usingCreationDate++;
    const at = abandonedAt(cart);
    if (at) ages.push(Math.round((now - at) / HOUR));
  }

  // Only useful while the payload shape is still in doubt; drop it once the
  // real date field is confirmed and DATE_FIELDS is cut back to that one name.
  if (carts.length && (!ages.length || ages[0] > MAX_AGE_HOURS)) {
    const c = carts[0];
    console.log('cart recovery: dates look wrong. keys =',
      JSON.stringify(cartShape(c)),
      'rawDates =', JSON.stringify({
        modificationDate: c?.modificationDate,
        creationDate: c?.creationDate,
      }));
  }

  ages.sort((a, b) => a - b);
  const ageSpread = ages.length
    ? { youngestHours: ages[0], oldestHours: ages[ages.length - 1], usingCreationDate }
    : null;

  const results = [];
  for (const cart of due) {
    try {
      results.push(await recoverCart(env, cart, now));
    } catch (err) {
      results.push({
        token: cart.token || cart.id,
        status: 'error',
        error: String(err?.message || err).slice(0, 300),
      });
    }
  }

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  return { scanned: carts.length, due: due.length, reasons, ageSpread, counts, results };
}
