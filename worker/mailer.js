/**
 * The one place this Worker hands a message to an email provider.
 *
 * Kept deliberately thin. Everything in recovery.js is provider-agnostic, so
 * switching providers is this file and the secret names — nothing else.
 *
 * Why Brevo, chosen 2026-08-17 after pricing the alternatives:
 *
 * - **Not Cloudflare Email Sending**, which would need no API key at all and
 *   binds straight into the Worker. Its Email Service is transactional-only and
 *   its terms exclude marketing and bulk. A discount offer chasing an abandoned
 *   cart is marketing however you frame it, and the account it would put at risk
 *   is the one hosting the whole site.
 * - **Not SendGrid**, which killed its permanent free tier in May 2025 and now
 *   starts at $19.95/mo. Worth paying only if you also want it fixing order
 *   confirmations, which is a separate problem — Snipcart's own settings field
 *   is SendGrid-specific. See email/SENDGRID-SETUP.md; that decision is still open.
 * - **Brevo** is free to 300 emails/day and permits marketing mail. Recovery
 *   volume is a handful a week, nowhere near the ceiling.
 *
 * Resend, added 2026-10-24, goes first whenever RESEND_API_KEY is set. Brevo
 * stays on as the backup: if Resend refuses a message or is down, the same
 * message goes out through Brevo instead. So a domain that has not finished
 * verifying, a revoked key or an outage never costs a customer their sign-in
 * code or the shop an inquiry. Delete BREVO_KEY to run on Resend alone.
 * Resend's free plan is 100 a day and 3,000 a month, and it permits marketing
 * mail, so cart recovery is allowed there too.
 *
 * Secrets:
 *   RESEND_API_KEY Resend API key, "Sending access" on rawhidecityleather.com.
 *                  The domain must be verified in Resend or every send falls
 *                  through to Brevo.
 *   BREVO_KEY      Brevo API key (Brevo calls these "SMTP & API" keys).
 *   RECOVERY_FROM  Sending address on a domain authenticated in Brevo.
 *                  Must be @rawhidecityleather.com — the domain customers
 *                  checked out on. Sending recovery mail from
 *                  rawhidecitylthr.com is the exact from/storefront mismatch
 *                  already suspected of putting tracking emails in the trash.
 *   RECOVERY_POSTAL_ADDRESS
 *                  Physical mailing address printed in the footer. Required by
 *                  CAN-SPAM for commercial mail, and a discount offer is
 *                  commercial mail. A PO box satisfies it — the home shop
 *                  address does not have to be published. Sending is blocked
 *                  until this is set, on purpose.
 */

const RESEND_API = 'https://api.resend.com/emails';
const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

/** Where an unsubscribe request lands. A real, monitored inbox. */
export const UNSUBSCRIBE_TO = 'rawhidecityleather@gmail.com';

export class MailError extends Error {}

export function mailerConfigured(env) {
  return Boolean((env.RESEND_API_KEY || env.BREVO_KEY) && env.RECOVERY_FROM && env.RECOVERY_POSTAL_ADDRESS);
}

/** Who gets first go at a message, for the dashboard. '' when neither is set. */
export function mailProvider(env) {
  if (env.RESEND_API_KEY) return 'Resend';
  if (env.BREVO_KEY) return 'Brevo';
  return '';
}

/**
 * Sends one message. Throws MailError on anything but a 2xx so the caller can
 * record the failure against the cart and retry it on the next run.
 *
 * Resolves to { messageId, provider } and, when Resend failed and Brevo
 * carried it, `resendError` saying why — the dashboard's test button shows it.
 */
export async function sendMail(env, message) {
  if (!mailerConfigured(env)) {
    throw new MailError(
      'Email is not configured. Set RESEND_API_KEY (or BREVO_KEY), RECOVERY_FROM and ' +
        'RECOVERY_POSTAL_ADDRESS with `wrangler secret put`.'
    );
  }

  if (!env.RESEND_API_KEY) return sendViaBrevo(env, message);

  try {
    return await sendViaResend(env, message);
  } catch (err) {
    // Any failure falls through, a 4xx included: a 403 for an unverified
    // domain is exactly the case Brevo is kept around for. The one cost is a
    // Resend 5xx that went out anyway and now goes twice — rarer than an
    // inquiry lost to an outage, and far less costly.
    if (!env.BREVO_KEY) throw err;
    console.error('resend failed, sending through brevo:', err.message);
    return { ...(await sendViaBrevo(env, message)), resendError: err.message };
  }
}

async function sendViaResend(env, { to, subject, html, text, replyTo, transactional = false }) {
  let res;
  try {
    res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: `Rawhide City Leather <${env.RECOVERY_FROM}>`,
        to: [to],
        // The bare address, no display name. A customer's name with a comma
        // in it would read as two addresses and get the whole message refused.
        reply_to: replyTo?.email || UNSUBSCRIBE_TO,
        subject,
        html,
        text,
        // Same rule as Brevo below: no List-Unsubscribe on transactional mail.
        ...(transactional ? {} : {
          headers: {
            'List-Unsubscribe': `<mailto:${UNSUBSCRIBE_TO}?subject=Unsubscribe>`,
          },
        }),
      }),
    });
  } catch (err) {
    throw new MailError(`Resend could not be reached: ${err.message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new MailError(
      `Resend returned ${res.status} ${res.statusText}${detail ? ': ' + detail.slice(0, 300) : ''}`
    );
  }

  const body = await res.json().catch(() => ({}));
  return { messageId: body.id || '', provider: 'Resend' };
}

async function sendViaBrevo(env, { to, subject, html, text, replyTo, transactional = false }) {
  const res = await fetch(BREVO_API, {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_KEY,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: env.RECOVERY_FROM, name: 'Rawhide City Leather' },
      to: [{ email: to }],
      // Cart recovery replies come back to the shop. A contact-form inquiry
      // overrides this so hitting reply answers the customer, not ourselves.
      replyTo: replyTo?.email
        ? { email: replyTo.email, name: replyTo.name || replyTo.email }
        : { email: UNSUBSCRIBE_TO, name: 'Rawhide City Leather' },
      subject,
      htmlContent: html,
      textContent: text,
      // Brevo requires custom headers in Title-Case with hyphens.
      //
      // Marketing mail carries List-Unsubscribe; transactional mail must not.
      // A contact-form inquiry is addressed to the shop's own inbox, and an
      // unsubscribe link on it is one stray click away from Brevo suppressing
      // that address — which would silently stop every inquiry notification.
      ...(transactional ? {} : {
        headers: {
          'List-Unsubscribe': `<mailto:${UNSUBSCRIBE_TO}?subject=Unsubscribe>`,
        },
      }),
    }),
  });

  // Brevo answers 201 Created on success, not 200.
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new MailError(
      `Brevo returned ${res.status} ${res.statusText}${detail ? ': ' + detail.slice(0, 300) : ''}`
    );
  }

  const body = await res.json().catch(() => ({}));
  return { messageId: body.messageId || '', provider: 'Brevo' };
}
