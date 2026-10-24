/**
 * Phone alerts through Pushover.
 *
 * Two things push today, both the moments that are worth a buzz in a pocket:
 *
 *   a new order       from the Snipcart order.completed webhook, live orders
 *                     only. Snipcart's own "You received a new order!" email
 *                     still comes; this is the faster, louder copy.
 *   a new inquiry     from the contact form. Custom builds and crew orders are
 *                     the biggest tickets the site takes, and the first shop to
 *                     answer usually gets the job. If the inquiry email fails
 *                     to send, the push says so and carries the customer's
 *                     address, so the lead still is not lost.
 *
 * A push is never load-bearing. push() never throws, and nothing that calls it
 * changes what it returns because a push did or did not go out — an order
 * webhook that 500s over a phone alert would make Snipcart retry the whole
 * order.
 *
 * Quiet hours are set in the Pushover app on the phone, not here.
 *
 * Secrets:
 *   PUSHOVER_TOKEN  the API token of the application made for the site at
 *                   pushover.net/apps/build.
 *   PUSHOVER_USER   the user key from the top of the pushover.net dashboard.
 * Either unset: nothing pushes, and nothing else changes.
 */

import { money } from './lib.js';
import { grandTotal } from './snipcart.js';

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';
const DASHBOARD = 'https://rawhidecityleather.com/dashboard';

/** Pushover's own limits. Past them it refuses the whole message. */
const MAX_TITLE = 250;
const MAX_MESSAGE = 1024;
const MAX_URL_TITLE = 100;

export function pushConfigured(env) {
  return Boolean(env.PUSHOVER_TOKEN && env.PUSHOVER_USER);
}

/** Cuts by characters, not UTF-16 units, so an emoji is never split in half. */
export function clip(value, max) {
  const chars = [...String(value ?? '').trim()];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

/**
 * Sends one push. Resolves to { sent: true, id } or { sent: false, reason };
 * never throws.
 */
export async function push(env, { title, message, url, urlTitle, sound, priority } = {}) {
  if (!pushConfigured(env)) return { sent: false, reason: 'not configured' };

  const form = new URLSearchParams({
    token: env.PUSHOVER_TOKEN,
    user: env.PUSHOVER_USER,
    // An empty message is refused outright.
    message: clip(message, MAX_MESSAGE) || '(no details)',
  });
  if (title) form.set('title', clip(title, MAX_TITLE));
  if (url) form.set('url', url);
  if (url && urlTitle) form.set('url_title', clip(urlTitle, MAX_URL_TITLE));
  if (sound) form.set('sound', sound);
  if (priority) form.set('priority', String(priority));

  try {
    const res = await fetch(PUSHOVER_API, {
      method: 'POST',
      body: form,
      // A slow Pushover must not hold up a customer's form or Snipcart's hook.
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 1) {
      const reason = (data.errors || []).join('; ') || `Pushover returned ${res.status}`;
      console.error('pushover', reason);
      return { sent: false, reason };
    }
    return { sent: true, id: data.request || '' };
  } catch (err) {
    console.error('pushover', err.message);
    return { sent: false, reason: err.message };
  }
}

/* ------------------------------------------------------------- the pushes */

/**
 * "SNIP-1040 · $165.00", then one line per item and who it ships to. Name,
 * city and state only — the full address is on the dashboard.
 */
export function orderPush(order = {}) {
  const items = (order.items || []).map((i) =>
    `${Number(i.quantity) || 1} × ${i.name || i.id || 'Custom build'}`);
  const to = order.shippingAddress || order.billingAddress || {};
  const place = [to.city, to.province].filter(Boolean).join(', ');
  const who = [to.fullName || to.name, place].filter(Boolean).join(' · ');
  const total = money(Number(grandTotal(order)), order.currency);

  return {
    title: ['New order', order.invoiceNumber, total].filter(Boolean).join(' · '),
    message: [...items, who].filter(Boolean).join('\n'),
    url: DASHBOARD + '#queue',
    urlTitle: 'Open the ship queue',
    sound: 'cashregister',
  };
}

/**
 * The inquiry, short enough to read on a lock screen. `emailed: false` means
 * the email to the shop inbox failed, so this push is the only copy the shop
 * has — it says so and leads with the customer's address.
 */
export function inquiryPush(inquiry = {}, { emailed = true } = {}) {
  const about = inquiry.type || 'Website inquiry';
  const lines = [
    emailed ? '' : `EMAIL TO THE SHOP FAILED. Reply to ${inquiry.email}`,
    [inquiry.department, inquiry.neededBy ? 'need by ' + inquiry.neededBy : ''].filter(Boolean).join(' · '),
    clip(inquiry.details, 600),
    inquiry.photo ? 'Photo attached — open the email to see it.' : '',
  ].filter(Boolean);

  return {
    title: `${emailed ? 'New inquiry' : 'Inquiry NOT emailed'}: ${about} — ${inquiry.name || 'no name'}`,
    message: lines.join('\n'),
    // Loud on a failure; it is the only copy.
    priority: emailed ? 0 : 1,
  };
}

/** The dashboard's "Send a test push". */
export function testPush(now = new Date()) {
  const time = now.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric',
  });
  return {
    title: 'Rawhide City Leather',
    message: `Test from the dashboard, ${time} ET. New orders and contact-form inquiries will land here.`,
    url: DASHBOARD,
    urlTitle: 'Open the dashboard',
  };
}
