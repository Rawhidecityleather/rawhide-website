/**
 * Custom build / crew order inquiries from the contact page.
 *
 * Route (wired in index.js)
 *   POST /api/inquiry   PUBLIC — customers are not logged in.
 *
 * This used to post into a Kit form, which was the wrong shape twice over: a
 * Kit form endpoint subscribes the sender to the newsletter, which nobody asked
 * for when they were writing in about an order, and it buried the details of a
 * custom build in a subscriber record instead of putting them in the inbox
 * where they actually get answered. It also shipped with an unreplaced
 * `KIT_FORM_ID` placeholder from 2026-07-26 to 2026-08-18, which the front end
 * papered over by falling back to a `mailto:` — workable, but it needed the
 * visitor to have a mail client that opened and to then press send themselves.
 *
 * So the inquiry comes here and gets emailed to the shop directly.
 *
 * Secrets: the same three the cart recovery cron uses. See worker/mailer.js.
 * With any of them unset this returns 503 and the page falls back to mailto,
 * exactly as it does today — so this is safe to deploy before they are set.
 */

import { json } from './lib.js';
import { sendMail, mailerConfigured, UNSUBSCRIBE_TO } from './mailer.js';

/** Long enough for a detailed custom build, short enough to bound abuse. */
const MAX_FIELD = 4000;

/** Plenty for a real inquiry; a bot pasting a payload gets cut off. */
const MAX_BODY_BYTES = 32 * 1024;

/** What the contact form's "What's this about?" dropdown can legitimately say. */
const INQUIRY_TYPES = new Set([
  'Custom build',
  'Crew or bulk order',
  'Question about an existing order',
  'Leave a review',
  'Something else',
]);

export function clean(value, max = MAX_FIELD) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

/**
 * Deliberately loose. This gates who we can reply to, not who may write in —
 * rejecting a real customer over an unusual address is the worse error.
 */
export function looksLikeEmail(value) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(value || '').trim());
}

/**
 * Header injection guard. The reply-to is built from customer input, and a
 * newline in it could add headers of its own.
 */
export function safeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim();
}

export function parseInquiry(form) {
  const get = (k) => clean(form.get(k));

  const inquiry = {
    type: get('fields[inquiry_type]'),
    name: clean(form.get('fields[first_name]'), 120),
    email: clean(form.get('email_address'), 200),
    department: clean(form.get('fields[department]'), 200),
    neededBy: clean(form.get('fields[needed_by]'), 200),
    details: get('fields[details]'),
  };

  const errors = [];
  if (!inquiry.name) errors.push('name');
  if (!looksLikeEmail(inquiry.email)) errors.push('email');
  if (!inquiry.details) errors.push('details');
  // An unrecognised value means the markup and this list have drifted apart, or
  // something is posting by hand. Keep the inquiry, drop the claim.
  if (inquiry.type && !INQUIRY_TYPES.has(inquiry.type)) inquiry.type = 'Something else';

  return { inquiry, errors };
}

export function renderInquiryEmail(inquiry) {
  const subject = `${inquiry.type || 'Website inquiry'} — ${inquiry.name}`;

  const rows = [
    ['About', inquiry.type],
    ['Name', inquiry.name],
    ['Email', inquiry.email],
    ['Department or station', inquiry.department],
    ['Need it by', inquiry.neededBy],
  ].filter(([, v]) => v);

  const text = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'Details:',
    inquiry.details,
    '',
    '--',
    'Sent from the contact form on rawhidecityleather.com.',
    'Reply straight to this email and it goes to them.',
  ].join('\n');

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px;background:#EBE8E1;font-family:Arial,Helvetica,sans-serif;color:#0F0F0F;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#fff;border:1px solid #DFDBD2;">
<tr><td style="background:#0F0F0F;padding:18px 22px;">
<p style="margin:0;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#A9A59B;">Website inquiry</p>
<p style="margin:4px 0 0 0;font-weight:bold;font-size:20px;color:#EBE8E1;">${esc(inquiry.type || 'Something else')}</p>
</td></tr>
<tr><td style="padding:22px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;line-height:1.6;">
${rows.map(([k, v]) => `<tr>
<td style="padding:4px 12px 4px 0;color:#6B6358;white-space:nowrap;vertical-align:top;">${esc(k)}</td>
<td style="padding:4px 0;color:#0F0F0F;">${esc(v)}</td>
</tr>`).join('')}
</table>
<p style="margin:18px 0 6px 0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6B6358;">Details</p>
<div style="background:#EBE8E1;border-left:3px solid #0F0F0F;padding:14px 16px;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.65;white-space:pre-wrap;">${esc(inquiry.details)}</div>
<p style="margin:18px 0 0 0;font-size:12px;color:#6B6358;">Reply straight to this email and it goes to them.</p>
</td></tr>
</table>
</body></html>`;

  return { subject, html, text };
}

export async function handleInquiry(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ error: 'That is too long to send.' }, 413);

  const form = new URLSearchParams(body);

  // Honeypot. A real person never sees this field, so anything in it is a bot.
  // Answer 200 so the bot has nothing to tune against.
  if (clean(form.get('company'))) return json({ ok: true });

  const { inquiry, errors } = parseInquiry(form);
  if (errors.length) {
    return json({ error: 'Please fill in your name, a valid email, and the details.', fields: errors }, 400);
  }

  // Falls back to the mailto path on the page rather than losing the inquiry.
  if (!mailerConfigured(env)) {
    return json({ error: 'Email is not configured.', fallback: 'mailto' }, 503);
  }

  const { subject, html, text } = renderInquiryEmail(inquiry);

  await sendMail(env, {
    to: UNSUBSCRIBE_TO,
    subject,
    html,
    text,
    replyTo: { email: safeHeaderValue(inquiry.email), name: safeHeaderValue(inquiry.name) },
    transactional: true,
  });

  return json({ ok: true });
}
