/**
 * Tracking, back from Pirate Ship on its own.
 *
 * Pirate Ship has no API and never will for us — so nothing here asks it for
 * anything. It is the other direction that is automatable: Pirate Ship already
 * emails the customer a tracking number an hour after a label is bought, and
 * Settings > Tracking Emails > Edit Template has a BCC field. Point that BCC at
 * this Worker and every label bought reports itself back, with no paste and no
 * spreadsheet.
 *
 * What arrives is a copy of the customer's own tracking email, which is why
 * matching works at all: the To: header on that copy is the customer's address,
 * and the shop's orders are keyed by the same address. The tracking number
 * comes off the body.
 *
 * Nothing here throws. A tracking email that can't be matched is forwarded to
 * the shop like anything else and shipped by hand — the paste box in the
 * dashboard is still there, and still the fallback.
 *
 * Config:
 *   TRACKING_INBOX   — the address Pirate Ship BCCs. A message addressed here
 *                      is a tracking email, not a receipt. A SECRET, not a var
 *                      in wrangler.jsonc: the repo is public and this is a
 *                      private address of ours.
 *                        wrangler secret put TRACKING_INBOX
 *                      Unset means the feature is simply off — mail to the
 *                      Worker all goes down the receipts path, as before.
 *   TRACKING_SENDERS — who may report a shipment, matched against the From:
 *                      HEADER. Comma-separated; a bare "@domain.com" allows the
 *                      domain. Nothing private in it, so it lives in
 *                      wrangler.jsonc.
 *
 *                      Note it is usually not @pirateship.com that shows up:
 *                      Pirate Ship sends a tracking email as whatever Sender
 *                      Email the template carries, once that address is verified
 *                      in Postmark. Change the sender on the template and this
 *                      list has to change with it, or every shipment is refused.
 *                      @pirateship.com still belongs in the list as the fallback
 *                      for an UNVERIFIED sender, which Postmark sends as
 *                      ship@pirateship.com with the real address as reply-to.
 */

import { parseEmail, htmlToText } from './mime.js';
import { findTrackingNumber } from './pirateship.js';
import { getAllOrders, putJson, trackingUrlFor, isShipped, isCancelled } from './snipcart.js';

/** Pirate Ship's own mail. Overridable, because senders get renamed. */
const DEFAULT_SENDERS = 'shipping@rawhidecityleather.com,orders@rawhidecitylthr.com,@pirateship.com';

/**
 * Whether this message is a tracking report rather than a forwarded receipt.
 *
 * Both features share one `email` handler, and they must never file each
 * other's mail: a receipt run through here marks a random order shipped, and a
 * tracking email run through the receipt path books postage twice.
 */
export function isTrackingAddress(message, env) {
  const inbox = String(env?.TRACKING_INBOX || '').trim().toLowerCase();
  if (!inbox) return false;

  // `to` is the envelope recipient Email Routing delivered on, which is this
  // address even when the header To: is the customer — the whole point of a BCC.
  return String(message?.to || '').trim().toLowerCase() === inbox;
}

export function trackingSenders(env) {
  return String(env?.TRACKING_SENDERS || DEFAULT_SENDERS)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function senderAllowed(from, allowed) {
  const address = String(from || '').trim().toLowerCase();
  if (!address || !allowed.length) return false;
  return allowed.some((entry) => (
    entry.startsWith('@') ? address.endsWith(entry) : address === entry
  ));
}

/**
 * Whether the message can prove it came from where it says.
 *
 * From: is a claim anyone can write, and this one moves orders — a forged
 * "Pirate Ship" could mark a piece shipped and put a junk tracking number in
 * front of the customer. Email Routing checks SPF, DKIM and DMARC at the edge
 * and writes the verdict into Authentication-Results; this reads it.
 *
 * Stricter than the receipt path, which lets a message with no such header
 * through. There, an unauthenticated forgery is a junk row nobody has to act
 * on. Here it reaches a customer, so no header is no shipment — and the cost of
 * being wrong is small, because the mail is still forwarded to the shop and the
 * paste box is still there.
 */
export function authStrict(message) {
  let results = '';
  try {
    results = String(message?.headers?.get('authentication-results') || '').toLowerCase();
  } catch {
    return false;
  }

  if (!results) return false;
  if (/dmarc=pass/.test(results)) return true;
  return /spf=pass/.test(results) && /dkim=pass/.test(results);
}

/**
 * The order a tracking email belongs to.
 *
 * The customer's address is the key, and it is a good one — Snipcart keys
 * orders by the same string the label was addressed to. Where it goes wrong is
 * a repeat customer with two open orders, so ties break toward the oldest
 * unshipped order: that is the one whose turn it was on the bench.
 *
 * Cancelled orders are never matched. Already-shipped ones are only matched
 * when nothing open is left, so a second label on a replacement package still
 * lands somewhere sensible instead of nowhere.
 */
export function matchOrder(email, orders) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;

  const mine = (orders || []).filter((order) => (
    String(order.email || '').trim().toLowerCase() === wanted && !isCancelled(order)
  ));
  if (!mine.length) return null;

  const oldestFirst = (a, b) =>
    new Date(a.creationDate || 0) - new Date(b.creationDate || 0);

  const open = mine.filter((order) => !isShipped(order)).sort(oldestFirst);
  if (open.length) return open[0];

  return mine.sort(oldestFirst)[0];
}

/**
 * Reads one Pirate Ship tracking email and ships the order it belongs to.
 *
 * Returns a report rather than throwing, because the caller forwards the
 * message to the shop either way and a bounced tracking email helps nobody.
 */
export async function handleTrackingEmail(message, env, readRaw, limit) {
  const report = { from: String(message?.from || '').toLowerCase(), shipped: false, why: '' };

  if (!authStrict(message)) {
    report.why = 'could not prove who sent it';
    return report;
  }

  const raw = await readRaw(message, limit);
  if (!raw) {
    report.why = 'too big to read';
    return report;
  }

  const parsed = parseEmail(raw);

  /*
   * The From: HEADER, not message.from.
   *
   * message.from is the envelope sender, and on this mail it is a Postmark
   * bounce address — Pirate Ship sends through Postmark and the template's
   * Return Path is unverified, so the envelope says nothing about the shop.
   * The From: header is `orders@rawhidecitylthr.com`, and that is also the
   * domain DKIM signs and DMARC aligns against, so it is the half the check
   * above actually proved. Allowlisting the envelope while authenticating the
   * header would be checking two different things and calling it one.
   */
  const allowed = trackingSenders(env);
  report.from = parsed.from;
  if (!senderAllowed(parsed.from, allowed)) {
    report.why = allowed.length ? 'sender not on the list' : 'TRACKING_SENDERS is not set';
    return report;
  }
  const body = [parsed.text, htmlToText(parsed.html), parsed.subject]
    .filter(Boolean)
    .join('\n');

  const trackingNumber = findTrackingNumber(body);
  if (!trackingNumber) {
    report.why = 'no tracking number in it';
    return report;
  }
  report.trackingNumber = trackingNumber;

  // The customer is the To: on the copy, not the envelope recipient — that one
  // is the shop's own BCC address.
  const customer = parsed.to;
  report.customer = customer;

  const { orders } = await getAllOrders(env);
  const order = matchOrder(customer, orders);
  if (!order) {
    report.why = 'no open order for that address';
    return report;
  }
  report.invoiceNumber = order.invoiceNumber || order.token;

  // Already carrying this exact number: Pirate Ship sends a second mail when
  // the carrier first scans the package, and that is not a new shipment.
  if (String(order.trackingNumber || '').toUpperCase() === trackingNumber) {
    report.why = 'already on the order';
    return report;
  }

  await putJson(env, '/orders/' + encodeURIComponent(order.token), {
    status: 'Shipped',
    trackingNumber,
    trackingUrl: trackingUrlFor(trackingNumber),
  });

  report.shipped = true;
  return report;
}
