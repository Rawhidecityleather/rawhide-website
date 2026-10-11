/**
 * Receipts by email.
 *
 * The shop forwards a receipt to a private address and it lands on the expenses
 * page like a photographed one. Half the shop's spending never arrives on paper
 * to photograph in the first place — the ad platforms, the tanneries, the
 * software, the marketplaces all email an invoice — and forwarding one takes
 * two taps at the moment it arrives, which is the only moment it is ever going
 * to get filed.
 *
 * Cloudflare Email Routing already holds MX for the domain, so the address
 * points at this Worker's `email` handler instead of forwarding to Gmail. See
 * the README for the routing rule; there is no wrangler setting for it.
 *
 * What happens to one message:
 *   1. It is forwarded to the shop inbox, whatever else goes right or wrong.
 *      Nothing here is allowed to be the only copy of a receipt.
 *   2. The From: header is checked against RECEIPT_SENDERS, and Cloudflare's
 *      DMARC verdict must pass for it. Anything else is forwarded and dropped —
 *      this address files rows into the shop's books.
 *   3. Real attachments — a PDF invoice, a photographed receipt — are stored
 *      and read, one ledger row each.
 *   4. With no attachment worth filing, the body is the receipt: it gets
 *      stored as HTML and read as text.
 *
 * Every row lands unchecked, the same as an upload. A model reading a
 * marketplace's HTML is a suggestion, never a number in the year-end report.
 *
 * Config (plain vars in wrangler.jsonc, not secrets — both are addresses that
 * are already on the live site):
 *   RECEIPT_SENDERS    — comma-separated addresses allowed to file. A bare
 *                        `@domain.com` entry allows the whole domain.
 *   RECEIPT_FORWARD_TO — where every message is forwarded. Must be a verified
 *                        Email Routing destination address.
 */

import { parseEmail, binaryFrom, htmlToText, dmarcPassFor, edgeVerdict } from './mime.js';
import { detect } from './uploads.js';
import { storeReceipt, storeBody, readText, cleanDate, cleanVendor } from './receipts.js';
import { buildExpense, putExpense, guessCategory } from './expenses.js';

/**
 * Email Routing will not hand over anything larger, so past this the message
 * on the wire was truncated and its last attachment is half a file. Filing
 * half a PDF is worse than filing nothing: it stores an unreadable original
 * under a row that looks complete.
 */
export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

/** One forwarded email is a receipt or two, not a folder. */
const MAX_FILED = 5;

/**
 * Under this an attachment is not a receipt. A phone photo is megabytes and
 * the smallest real PDF invoice runs 15-20KB; what sits below is the sender's
 * letterhead, a social icon or a tracking pixel.
 */
const MIN_ATTACHMENT_BYTES = 6 * 1024;

/** An inline image has to be this big before it beats a proper attachment. */
const MIN_INLINE_BYTES = 40 * 1024;

/** Below this a message body is not a receipt — see fileBody. */
const MIN_BODY_CHARS = 20;

/* ----------------------------------------------------------------- senders */

/** Who may file. Empty means nobody: an unset allowlist fails closed. */
export function allowedSenders(env) {
  return String(env?.RECEIPT_SENDERS || '')
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
 * Whether the message really comes from the From address it shows.
 *
 * The allowlist is checked against the From: header, the address a person
 * reads, and this proves that header: Cloudflare's own DMARC verdict has to be
 * a pass for that address's domain. Gmail signs everything the shop sends, so
 * a receipt forwarded from the shop's Gmail passes. A stranger can put the
 * shop's Gmail address on a message but cannot get Gmail to sign it.
 *
 * Until Oct 2026 this checked the envelope sender instead, accepted a DMARC
 * pass for any domain, and let a message with no verdict through on the
 * strength of the address being private. The address turned out to be in the
 * public repo's tests, and the envelope sender is something any mail server
 * can set, so none of that held. No verdict now files nothing; the message is
 * still forwarded to the shop, so nothing is lost but the automatic row.
 */
export function authPassed(message, fromAddress) {
  return dmarcPassFor(authResults(message), fromAddress);
}

/** The joined Authentication-Results, or '' when there is none to read. */
export function authResults(message) {
  try {
    return String(message?.headers?.get('authentication-results') || '');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------- attachments */

/**
 * The attachments worth filing, best first.
 *
 * Sorted so that a genuine attachment outranks anything inline, and the larger
 * of two attachments outranks the smaller — an invoice PDF beats the signature
 * image pinned under it in the same message.
 */
export function pickAttachments(attachments) {
  return (attachments || [])
    .filter((file) => {
      if (!file?.bytes?.length) return false;
      if (!detect(file.bytes.subarray(0, 16))) return false;
      const floor = file.inline ? MIN_INLINE_BYTES : MIN_ATTACHMENT_BYTES;
      return file.bytes.length >= floor;
    })
    .sort((a, b) => (a.inline === b.inline ? b.bytes.length - a.bytes.length : a.inline ? 1 : -1))
    .slice(0, MAX_FILED);
}

/* ------------------------------------------------------------------ fields */

/** The date the message was sent, as a date the ledger will take. */
export function emailDate(raw) {
  const sent = new Date(String(raw || ''));
  if (isNaN(sent)) return '';
  return cleanDate(sent.toISOString().slice(0, 10));
}

/**
 * Who to file it under when the model read no vendor off the receipt.
 *
 * The sender is a good answer and a bad one: "Tandy Leather" is exactly right,
 * while a forward from the shop's own Gmail is worth nothing. So a display
 * name is used when there is one, the sending domain when there isn't, and
 * neither is used at all on a message the shop forwarded to itself — there the
 * subject line is closer to the truth than "gmail.com".
 */
export function senderVendor(parsed, allowed) {
  const from = String(parsed?.from || '').toLowerCase();
  if (allowed.some((entry) => !entry.startsWith('@') && entry === from)) return '';

  const name = cleanVendor(parsed?.fromName);
  if (name && !name.includes('@')) return name;

  const domain = from.split('@')[1] || '';
  return cleanVendor(domain.replace(/^(mail|email|no-?reply|billing|invoices?)\./, ''));
}

/**
 * Whether this message is a forward rather than the receipt's own delivery.
 *
 * The distinction decides whether the send date can stand in for a purchase
 * date. A vendor billing this address sent the receipt the day it was written;
 * a forward was sent whenever the shop got round to it, which may be months
 * later. The first real receipt through here was a LightBurn order from May,
 * forwarded in August, and it filed under August — the trap this closes.
 */
export function looksForwarded(subject, text) {
  if (/^\s*(fwd?|tr|wg|rv)\s*:/i.test(String(subject || ''))) return true;
  return /-{2,}\s*forwarded message|begin forwarded message/i.test(String(text || ''));
}

/**
 * Fills the gaps the reader left, from what the email itself says.
 *
 * `useDate` is only true for a receipt that arrived under its own steam and
 * has no date the reader could find. On an attachment, or on anything
 * forwarded, the date is printed on the document instead, and the day the
 * message was sent says nothing about when the thing was bought.
 *
 * Left blank rather than guessed. An undated row sorts to the top of the
 * ledger and stays there until somebody fills it in, which is the whole point
 * — a blank waiting to be filled beats a wrong date that looks finished.
 */
export function withFallbacks(draft, parsed, { allowed = [], useDate = false } = {}) {
  const next = { ...draft };

  if (!next.vendor) next.vendor = senderVendor(parsed, allowed);
  if (!next.summary) next.summary = cleanVendor(parsed?.subject).slice(0, 80);
  if (useDate && !next.date) next.date = emailDate(parsed?.date);
  if (next.category === 'other') next.category = guessCategory(`${next.vendor} ${next.summary}`);

  return next;
}

/* ------------------------------------------------------------------ filing */

async function fileAttachment(env, file, parsed, allowed) {
  const stored = await storeReceipt(env, file.bytes, file.name || parsed.subject);
  if (stored.error) {
    console.error('emailed receipt not stored', stored.error);
    return null;
  }

  const record = buildExpense({
    key: stored.key,
    file: stored.file,
    draft: withFallbacks(stored.draft, parsed, { allowed }),
  });

  await putExpense(env, record);
  return record;
}

/**
 * The message itself as the receipt. Reads the plain-text part when there is
 * one and flattens the HTML when there isn't — then keeps the HTML as the
 * stored original either way, because that is the version that looks like a
 * receipt when somebody opens it.
 */
async function fileBody(env, parsed, allowed) {
  const text = parsed.text || htmlToText(parsed.html);

  // Nothing worth a row: an empty message, or a one-line "see attached" whose
  // attachment was the logo we already threw out. Filing it would put a blank
  // line on the expenses page that nobody can ever complete.
  if (text.trim().length < MIN_BODY_CHARS) return null;

  const draft = await readText(env, text, 'could not read that email');

  const stored = await storeBody(env, {
    html: parsed.html,
    text,
    subject: parsed.subject,
  });
  if (stored.error) {
    console.error('emailed receipt body not stored', stored.error);
    return null;
  }

  const record = buildExpense({
    key: stored.key,
    file: stored.file,
    draft: withFallbacks(draft, parsed, {
      allowed,
      useDate: !looksForwarded(parsed.subject, text),
    }),
  });

  await putExpense(env, record);
  return record;
}

/* ------------------------------------------------------------------ handler */

/**
 * Everything on the wire, as a binary string. Returns null past the cap rather
 * than a truncated message — see MAX_EMAIL_BYTES.
 */
export async function readRaw(message, limit) {
  if (Number(message.rawSize) > limit) return null;

  const reader = message.raw.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return binaryFrom(all);
}

/**
 * One inbound message. Never throws: a thrown error here bounces the mail back
 * to whoever sent it, and a receipt the shop forwarded is not something to
 * bounce. Every failure is a log line and a forwarded copy.
 *
 * Returns a small report — what it did and why — which the tests read and
 * which shows up in the Worker's logs.
 */
export async function handleEmail(message, env) {
  const report = { from: String(message?.from || '').toLowerCase(), filed: 0, why: '' };

  try {
    report.filed = await file(message, env, report);
  } catch (err) {
    report.why = 'crashed';
    console.error('emailed receipt failed', err?.message || err);
  }

  // Last, and outside the work above: the shop gets its copy even when nothing
  // could be filed from it, which is the case where it most needs to see it.
  if (env.RECEIPT_FORWARD_TO) {
    try {
      await message.forward(env.RECEIPT_FORWARD_TO);
    } catch (err) {
      console.error('emailed receipt not forwarded', err?.message || err);
    }
  }

  console.log('receipt email', JSON.stringify(report));
  return report;
}

async function file(message, env, report) {
  const allowed = allowedSenders(env);
  if (!allowed.length) {
    report.why = 'RECEIPT_SENDERS is not set';
    return 0;
  }

  // Which proof arrived, without anything personal, so a receipt that did not
  // file can be explained from the log alone.
  report.auth = edgeVerdict(authResults(message)) || 'no cloudflare verdict';

  const raw = await readRaw(message, MAX_EMAIL_BYTES);
  if (!raw) {
    report.why = 'too big to read';
    return 0;
  }

  // The From: header, not message.from. message.from is the envelope sender,
  // which any mail server can set to anything and nothing checks; the header
  // is what DMARC proves.
  const parsed = parseEmail(raw);
  report.from = String(parsed.from || '').toLowerCase();
  if (!senderAllowed(parsed.from, allowed)) {
    report.why = 'sender not on the list';
    return 0;
  }
  if (!authPassed(message, parsed.from)) {
    report.why = 'DMARC did not pass for the From address';
    return 0;
  }

  report.subject = parsed.subject;

  let filed = 0;
  for (const attachment of pickAttachments(parsed.attachments)) {
    if (await fileAttachment(env, attachment, parsed, allowed)) filed++;
  }
  if (filed) return filed;

  // No attachment worth filing. The receipt is the email.
  const record = await fileBody(env, parsed, allowed);
  if (record) return 1;

  report.why = report.why || 'nothing in it to file';
  return 0;
}
