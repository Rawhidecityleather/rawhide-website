/**
 * The two codes an account earns.
 *
 *   Sign-up    20% off one order, good for 30 days from the day the account is
 *              made. One per email and one per street address, ever.
 *   Birthday   15% off one order, good for 30 days from the birthday. One a
 *              year, made by the hourly cron on the morning of the day.
 *
 * Both are real Snipcart discount codes, made one at a time for one person:
 * maxNumberOfUsages 1, and combinable false like every other rule this repo
 * writes. That is the whole of "they don't stack" — Snipcart will not hold two
 * non-combinable discounts on one cart, so a buyer holding both codes uses one
 * per order, and against a store sale they get one or the other (Snipcart asks
 * "Use this discount instead?" and the buyer taps Yes for the bigger one).
 *
 * Why one per address as well as one per email: an email costs nothing to
 * make, and 20% of a $165 strap is $33. A second account at the same street
 * address still works — it just does not get a second sign-up code. A deleted
 * account keeps both marks (one-way hashes, no address readable from them), or
 * delete-and-sign-up-again would mint a fresh 20% every time.
 *
 * Snipcart is the record of whether a code was used; the account only keeps
 * the code, its id and its dates.
 */

import { postJson, getJson } from './snipcart.js';
import { makeCode } from './recovery.js';
import { sendMail, mailerConfigured, UNSUBSCRIBE_TO } from './mailer.js';
import { birthdayEmail } from './account-mail.js';
import { getPromo, quoteDiscountRate } from './promo.js';
import {
  accountsConfigured, sha256, getAccount, putAccount, BIRTHDAY_PREFIX,
  todayEastern, addDays, endOfEasternDay, isLeapYear,
} from './account-store.js';

export const WELCOME_RATE = 20;
export const WELCOME_DAYS = 30;
export const BIRTHDAY_RATE = 15;
export const BIRTHDAY_DAYS = 30;

/** Not before 9am Eastern — a birthday email at midnight reads like a bot. */
export const BIRTHDAY_HOUR = 9;

/**
 * Codes made per cron run. The hourly run shares one invocation's subrequest
 * budget with cart recovery and the sale rule, and each birthday is two calls
 * out (Snipcart, Brevo). The rest wait for the next hour, which is safe: a
 * birthday that already has its code is skipped.
 */
export const BIRTHDAYS_PER_RUN = 10;

/** Every code made here is named with one of these, for Rob's Snipcart list. */
export const WELCOME_NAME = 'Account welcome: ';
export const BIRTHDAY_NAME = 'Account birthday ';

/* --------------------------------------------------------------- the codes */

/** WELCOME7KQ2M9XP, BDAY4HNC8RTE. Same alphabet as every other code here. */
export function accountCode(prefix) {
  return prefix + makeCode().slice(3);
}

function holder(account) {
  return `${account.firstName} ${String(account.lastName || '').slice(0, 1)}. (${account.id})`;
}

export function welcomeDiscount(account, code, now = Date.now()) {
  const expiresAt = endOfEasternDay(addDays(todayEastern(now).date, WELCOME_DAYS));
  return {
    expiresAt,
    body: {
      name: `${WELCOME_NAME}${holder(account)}`.slice(0, 100),
      trigger: 'Code',
      code,
      type: 'Rate',
      rate: WELCOME_RATE,
      maxNumberOfUsages: 1,
      combinable: false,
      expires: expiresAt,
    },
  };
}

/** `birthday` is this year's YYYY-MM-DD of it — the day the code is made for. */
export function birthdayDiscount(account, code, birthday) {
  const expiresAt = endOfEasternDay(addDays(birthday, BIRTHDAY_DAYS));
  return {
    expiresAt,
    body: {
      name: `${BIRTHDAY_NAME}${birthday.slice(0, 4)}: ${holder(account)}`.slice(0, 100),
      trigger: 'Code',
      code,
      type: 'Rate',
      rate: BIRTHDAY_RATE,
      maxNumberOfUsages: 1,
      combinable: false,
      expires: expiresAt,
    },
  };
}

/**
 * Lower case, punctuation and unit words gone, the usual street words
 * shortened, plus the 5-digit ZIP. "123 N. Main Street, Apt #4" and
 * "123 north main st 4" are the same front door.
 */
const STREET_WORDS = new Map([
  ['street', 'st'], ['avenue', 'ave'], ['road', 'rd'], ['drive', 'dr'], ['lane', 'ln'],
  ['court', 'ct'], ['boulevard', 'blvd'], ['circle', 'cir'], ['place', 'pl'], ['terrace', 'ter'],
  ['highway', 'hwy'], ['parkway', 'pkwy'], ['trail', 'trl'], ['north', 'n'], ['south', 's'],
  ['east', 'e'], ['west', 'w'],
]);
const UNIT_WORDS = new Set(['apt', 'apartment', 'unit', 'suite', 'ste', 'no', 'number', 'lot']);

export function addressKey(address = {}) {
  const words = `${address.line1 || ''} ${address.line2 || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !UNIT_WORDS.has(w))
    .map((w) => STREET_WORDS.get(w) || w);
  return `${words.join(' ')}|${String(address.zip || '').slice(0, 5)}`;
}

/**
 * Makes the sign-up code for a new account, or records why it gets none.
 * Never throws: a Snipcart hiccup must not fail the sign-up. A code that
 * could not be made is marked pending and tried again the next time the
 * customer opens their account page.
 */
export async function grantWelcome(env, account, now = Date.now()) {
  if (account.welcome && (account.welcome.code || account.welcome.skipped)) return account;

  try {
    const emailMark = 'welcomed:' + await sha256(account.email);
    const addressMark = 'addr:' + await sha256(addressKey(account.address));
    const [byEmail, byAddress] = await Promise.all([
      env.ACCOUNTS.get(emailMark), env.ACCOUNTS.get(addressMark),
    ]);
    if (byEmail && byEmail !== account.id) {
      account.welcome = { skipped: 'email' };
    } else if (byAddress && byAddress !== account.id) {
      account.welcome = { skipped: 'address' };
    } else {
      const code = accountCode('WELCOME');
      const plan = welcomeDiscount(account, code, now);
      const made = await postJson(env, '/discounts', plan.body);
      account.welcome = {
        code, discountId: (made && made.id) || '', rate: WELCOME_RATE, expiresAt: plan.expiresAt,
      };
      await Promise.all([
        env.ACCOUNTS.put(emailMark, account.id),
        env.ACCOUNTS.put(addressMark, account.id),
      ]);
    }
  } catch (err) {
    console.error('account welcome code failed', err?.message || err);
    account.welcome = { pending: true };
  }
  await putAccount(env, account);
  return account;
}

/* ---------------------------------------------------------- the page's view */

/**
 * The codes to show: the sign-up code whatever its state, and any birthday
 * code that has not run out. `usage` maps a discount id to how many times
 * Snipcart says it was used; a missing entry means unknown, shown as ready.
 */
export function couponList(account, usage = {}, now = Date.now()) {
  const out = [];
  const state = (c) => {
    if (usage[c.discountId] > 0) return 'used';
    if (Date.parse(c.expiresAt) <= now) return 'expired';
    return 'ready';
  };
  const w = account.welcome;
  if (w && w.code) {
    out.push({ kind: 'welcome', label: 'Sign-up code', code: w.code, rate: w.rate, expiresAt: w.expiresAt, status: state(w) });
  }
  for (const [year, b] of Object.entries(account.birthdays || {}).sort((a, b) => b[0].localeCompare(a[0]))) {
    if (!b || !b.code) continue;
    const status = state(b);
    if (status === 'expired') continue;
    out.push({ kind: 'birthday', label: `Birthday code ${year}`, code: b.code, rate: b.rate, expiresAt: b.expiresAt, status });
  }
  return out;
}

/** Whether each live code was used, straight from Snipcart. Soft on failure. */
export async function couponUsage(env, account, now = Date.now()) {
  const live = [account.welcome, ...Object.values(account.birthdays || {})]
    .filter((c) => c && c.code && c.discountId && Date.parse(c.expiresAt) > now);
  const usage = {};
  await Promise.all(live.map(async (c) => {
    try {
      const rule = await getJson(env, '/discounts/' + encodeURIComponent(c.discountId));
      usage[c.discountId] = Number(rule && rule.numberOfUsages) || 0;
    } catch {
      // Unknown. The page shows it as ready and Snipcart says no if it is not.
    }
  }));
  return usage;
}

/**
 * The storewide automatic sale, if one is on, so the page can say what a code
 * does against it. Read from the sale banner's own record — the same thing the
 * bar at the top of the page says.
 */
export async function saleNote(env, now = Date.now()) {
  const promo = await getPromo(env).catch(() => null);
  const rate = Math.round(quoteDiscountRate(promo, new Date(now)) * 100);
  return rate > 0 ? { live: true, rate } : { live: false };
}

/* ----------------------------------------------------------------- the cron */

/**
 * Today's birthdays. Runs every hour; does nothing before 9am Eastern, and
 * nothing for an account that already has this year's code. A February 29
 * birthday is kept on February 28 in a year without one.
 *
 * The code is saved to the account before the email goes, so a mail failure
 * never makes a second code — the email is retried on the next runs that day,
 * up to three tries, and the code is on the account page regardless.
 */
export async function runBirthdays(env, now = Date.now(), limit = BIRTHDAYS_PER_RUN) {
  const report = { minted: 0, emailed: 0, already: 0, failed: 0, stale: 0, more: false };
  if (!accountsConfigured(env)) return { ...report, skipped: 'off' };

  const today = todayEastern(now);
  if (today.hour < BIRTHDAY_HOUR) return { ...report, skipped: 'before-9am' };

  const days = [today.md];
  if (today.md === '02-28' && !isLeapYear(today.year)) days.push('02-29');

  const canMail = mailerConfigured(env) && !!env.RECOVERY_POSTAL_ADDRESS;
  const year = String(today.year);
  let work = 0;

  for (const md of days) {
    const prefix = `${BIRTHDAY_PREFIX}${md}:`;
    let cursor;
    do {
      const page = await env.ACCOUNTS.list({ prefix, cursor });
      for (const key of page.keys) {
        if (work >= limit) { report.more = true; return report; }
        const email = key.name.slice(prefix.length);
        const account = await getAccount(env, email).catch(() => null);
        if (!account) {
          await env.ACCOUNTS.delete(key.name).catch(() => {});
          report.stale++;
          continue;
        }
        account.birthdays = account.birthdays || {};
        let rec = account.birthdays[year];

        if (!rec) {
          work++;
          const code = accountCode('BDAY');
          const plan = birthdayDiscount(account, code, today.date);
          try {
            const made = await postJson(env, '/discounts', plan.body);
            rec = { code, discountId: (made && made.id) || '', rate: BIRTHDAY_RATE, expiresAt: plan.expiresAt, mailTries: 0 };
            account.birthdays[year] = rec;
            await putAccount(env, account);
            report.minted++;
          } catch (err) {
            console.error('birthday code failed', account.id, err?.message || err);
            report.failed++;
            continue;
          }
        } else if (rec.emailedAt || account.birthdayEmails === false || (rec.mailTries || 0) >= 3) {
          report.already++;
          continue;
        } else {
          work++;
        }

        if (account.birthdayEmails === false || !canMail || rec.emailedAt) continue;
        const message = birthdayEmail(account.firstName, rec, {
          postalAddress: env.RECOVERY_POSTAL_ADDRESS, unsubscribeTo: UNSUBSCRIBE_TO,
        });
        try {
          await sendMail(env, { to: account.email, subject: message.subject, html: message.html, text: message.text });
          rec.emailedAt = new Date(now).toISOString();
          report.emailed++;
        } catch (err) {
          console.error('birthday email failed', account.id, err?.message || err);
          rec.mailTries = (rec.mailTries || 0) + 1;
        }
        await putAccount(env, account);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  return report;
}
