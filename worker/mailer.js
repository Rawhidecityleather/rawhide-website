/**
 * The one place this Worker hands a message to an email provider.
 *
 * Kept deliberately thin. Everything else in recovery.js is provider-agnostic,
 * so swapping SendGrid for something else is this file and two secrets.
 *
 * Why SendGrid and not Cloudflare Email Sending, which we could bind with no
 * API key at all: Cloudflare's Email Service is **transactional only** and its
 * terms exclude marketing and bulk campaigns. A discount offer chasing an
 * abandoned cart is marketing however you frame it, and the account it would
 * put at risk is the one hosting the entire site. Not worth it.
 *
 * SendGrid also happens to be the provider Snipcart's own settings page takes,
 * so one account fixes order-confirmation deliverability at the same time.
 * See email/SENDGRID-SETUP.md.
 *
 * Secrets:
 *   SENDGRID_KEY   Restricted-access key, "Mail Send" and nothing else.
 *   RECOVERY_FROM  Sending address on an authenticated domain.
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

const SENDGRID_API = 'https://api.sendgrid.com/v3/mail/send';

/** Where an unsubscribe request lands. A real, monitored inbox. */
export const UNSUBSCRIBE_TO = 'rawhidecityleather@gmail.com';

export class MailError extends Error {}

export function mailerConfigured(env) {
  return Boolean(env.SENDGRID_KEY && env.RECOVERY_FROM && env.RECOVERY_POSTAL_ADDRESS);
}

/**
 * Sends one message. Throws MailError on anything but a 2xx so the caller can
 * record the failure against the cart and retry it on the next run.
 */
export async function sendMail(env, { to, subject, html, text }) {
  if (!mailerConfigured(env)) {
    throw new MailError(
      'Email is not configured. Set SENDGRID_KEY, RECOVERY_FROM and ' +
        'RECOVERY_POSTAL_ADDRESS with `wrangler secret put`.'
    );
  }

  const unsubscribe = `mailto:${UNSUBSCRIBE_TO}?subject=Unsubscribe`;

  const res = await fetch(SENDGRID_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SENDGRID_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.RECOVERY_FROM, name: 'Rawhide City Leather' },
      reply_to: { email: UNSUBSCRIBE_TO, name: 'Rawhide City Leather' },
      subject,
      // Plain text first. Order matters to the spec: the last part is the one
      // clients prefer, so HTML has to come second or nobody sees it.
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
      headers: { 'List-Unsubscribe': `<${unsubscribe}>` },
      // Recovery mail is commercial, so it must honour SendGrid's unsubscribe
      // state rather than bypassing it the way a receipt would.
      mail_settings: { bypass_list_management: { enable: false } },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new MailError(
      `SendGrid returned ${res.status} ${res.statusText}${detail ? ': ' + detail.slice(0, 300) : ''}`
    );
  }

  return { messageId: res.headers.get('x-message-id') || '' };
}
