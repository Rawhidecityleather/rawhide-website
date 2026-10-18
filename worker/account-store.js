/**
 * Where a customer account lives, and the few helpers every account file
 * shares. Kept apart so accounts.js, account-coupons.js and account-cards.js
 * can all read and write an account without importing each other.
 *
 * See worker/accounts.js for the whole picture and the key layout.
 */

import { mailerConfigured } from './mailer.js';

export function accountsConfigured(env) {
  return !!(env && env.ACCOUNTS && env.ACCOUNT_SECRET && env.SNIPCART_SECRET && mailerConfigured(env));
}

export function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : '';
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getAccount(env, email) {
  if (!email) return null;
  return env.ACCOUNTS.get('acct:' + email, { type: 'json' });
}

export async function putAccount(env, account) {
  account.updatedAt = new Date().toISOString();
  await env.ACCOUNTS.put('acct:' + account.email, JSON.stringify(account));
}

export async function deleteAccount(env, account) {
  await env.ACCOUNTS.delete('acct:' + account.email);
}

/** The birthday cron lists one prefix a day: every account born on MM-DD. */
export const BIRTHDAY_PREFIX = 'bday:';

export function birthdayKey(account) {
  return `${BIRTHDAY_PREFIX}${account.dob.slice(5)}:${account.email}`;
}

/* ------------------------------------------------------------ Eastern dates */

/**
 * Today in the shop's own time zone, plus the hour. Birthdays, expiry dates
 * and the "18 or older" check all run on Lakeland's calendar, not UTC's —
 * otherwise a birthday code lands at 8pm the night before.
 */
export function todayEastern(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, year: Number(parts.year), md: date.slice(5), hour: Number(parts.hour) % 24 };
}

export function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The instant a code dated `ymd` stops working: midnight Eastern at the end of
 * that day. Snipcart takes a full timestamp through the API, so a code can be
 * good "through" a date and mean the whole of it.
 */
export function endOfEasternDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d + 1, 5, 0, 0); // midnight EST
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(guess))) % 24;
  // In daylight time 05:00 UTC is 1am Eastern, so step back the hour.
  return new Date(guess - hour * 3600 * 1000).toISOString();
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
