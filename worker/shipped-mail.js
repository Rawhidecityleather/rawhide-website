/**
 * "Your gear is on the way", sent by us.
 *
 * Every other path already has someone telling the customer. A Pirate Ship
 * label mails them an hour after it is bought. What has nobody is the package
 * that goes out without one — handed over at the station, dropped at the post
 * office on a counter label, a replacement sent at our own cost. Mark one of
 * those shipped and, before this, every screen agreed the order was done while
 * the customer had been told nothing at all. Snipcart will not send it: it
 * offers a tracking email only from its own order screen, and everything here
 * writes through the REST API.
 *
 * So this is deliberately NOT automatic. It goes out when the shop ticks
 * "email the customer" on the ship form, because the common case — a Pirate
 * Ship label — already mailed them, and a second copy from us is exactly the
 * duplicate we spent the afternoon establishing does not exist.
 *
 * The design is `email/pirate-ship-tracking-email.html` rebuilt with real
 * values in place of Pirate Ship's [Bracketed] tokens. Same layout on purpose:
 * a customer should not be able to tell which system mailed them, and there is
 * only one template to keep looking right.
 *
 * Transactional, so no List-Unsubscribe — a shipping notice is not marketing,
 * and an unsubscribe click on one would have Brevo suppress that address and
 * silently drop the next customer's.
 */

import { esc } from './lib.js';
import { sendMail, mailerConfigured, MailError, UNSUBSCRIBE_TO } from './mailer.js';

const SITE = 'https://rawhidecityleather.com';

export const SHIPPED_SUBJECT = 'Your Rawhide City Leather gear has shipped';

/** Matches the Pirate Ship template's greeting, which uses a first name only. */
export function firstName(order) {
  const a = order?.shippingAddress || order?.billingAddress || {};
  const full = String(a.fullName || a.name || '').trim();
  const first = full.split(/\s+/)[0] || '';

  // An empty greeting reads better than "Hey ,". ALL-CAPS names get title-cased
  // — a label printed in caps is normal, a shout in an email is not.
  if (!first) return '';
  return first === first.toUpperCase()
    ? first.charAt(0) + first.slice(1).toLowerCase()
    : first;
}

/** "August 19, 2026", in the shop's own timezone rather than UTC. */
export function shipDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date(now));
}

export function shippedText(order, trackingNumber, now) {
  const name = firstName(order);
  return [
    name ? `Hey ${name},` : 'Hey,',
    '',
    'Your order just left the bench. It was cut, stitched, and finished by hand',
    'in Lakeland, Florida, and it is now headed to your door.',
    '',
    `Tracking number: ${trackingNumber}`,
    `Shipped ${shipDate(now)}`,
    `Track it: ${SITE}/track?num=${encodeURIComponent(trackingNumber)}`,
    '',
    'Fresh tracking numbers can take up to 24 hours to show movement, so check',
    'back if it looks quiet at first.',
    '',
    'Every piece carries our career warranty: if workmanship or materials ever',
    `fail you, we will make it right. ${SITE}/shipping#warranty`,
    '',
    '"We do not cut corners. We cut leather."',
    '',
    'Rawhide City Leather — Firefighter Owned, Est. 2024, Lakeland, FL',
    'Questions about your order? Just reply to this email.',
  ].join('\n');
}

export function shippedHtml(order, trackingNumber, now) {
  const name = esc(firstName(order));
  const num = esc(trackingNumber);
  const track = `${SITE}/track?num=${encodeURIComponent(trackingNumber)}`;

  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Tracking inside. Your handmade leather gear is on its way to your door.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EBE8E1" style="background-color:#EBE8E1;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">
        <tr>
          <td align="center" style="padding:0 0 24px 0;">
            <img src="${SITE}/assets/img/logo.png" width="170" alt="Rawhide City Leather" style="display:block;width:170px;max-width:60%;height:auto;border:0;">
          </td>
        </tr>
        <tr>
          <td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #DFDBD2;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#0F0F0F" align="center" style="background-color:#0F0F0F;padding:26px 24px;">
                  <p style="margin:0 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#A9A59B;">Handmade in Lakeland, FL</p>
                  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:26px;line-height:1.15;letter-spacing:2px;text-transform:uppercase;color:#EBE8E1;">Your gear is on the way</p>
                </td>
              </tr>
              <tr>
                <td style="padding:32px 36px 8px 36px;">
                  <p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.6;color:#0F0F0F;">Hey${name ? ' ' + name : ''},</p>
                  <p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:#3A3833;">Your order just left the bench. It was cut, stitched, and finished by hand in Lakeland, Florida, and it is now headed to your door. Here is everything you need to follow it home:</p>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 36px 8px 36px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="#EBE8E1" style="background-color:#EBE8E1;border:1px dashed #6B6358;padding:20px 16px;">
                        <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#6B6358;">Tracking Number</p>
                        <p style="margin:0 0 10px 0;font-family:'Courier New',Courier,monospace;font-weight:bold;font-size:19px;letter-spacing:2px;color:#0F0F0F;word-break:break-all;">${num}</p>
                        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6B6358;">Shipped ${esc(shipDate(now))}</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:20px 36px 8px 36px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="#0F0F0F" style="background-color:#0F0F0F;">
                        <a href="${esc(track)}" target="_blank" style="display:inline-block;padding:15px 42px;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#EBE8E1;text-decoration:none;">Track Your Shipment</a>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:14px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.5;color:#6B6358;">Fresh tracking numbers can take up to 24 hours to show movement, so check back if it looks quiet at first.</p>
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
                  <p style="margin:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#0F0F0F;">Built for the long haul</p>
                  <p style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.65;color:#3A3833;">Leather is a natural material, and yours was built to earn character. An occasional pass of leather balm will keep it strong shift after shift. Every piece carries our career warranty: if workmanship or materials ever fail you, we will make it right. <a href="${SITE}/shipping#warranty" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Read the warranty</a>.</p>
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
            <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6B6358;">Firefighter Owned &middot; Est. 2024 &middot; Lakeland, FL</p>
            <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1px;">
              <a href="${SITE}/shop" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Shop</a>
              &nbsp;&middot;&nbsp;
              <a href="${SITE}/shipping#warranty" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Warranty</a>
              &nbsp;&middot;&nbsp;
              <a href="${SITE}/contact" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Contact</a>
            </p>
            <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#6B6358;">Questions about your order? Just reply to this email and we will get you squared away.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

/**
 * Mails one customer that their order shipped.
 *
 * Throws MailError, which the caller reports without failing the shipment —
 * the order really did ship, and unwinding that because an email bounced would
 * be the wrong half to undo.
 */
export async function sendShippedEmail(env, order, trackingNumber, now = Date.now()) {
  const to = String(order?.email || '').trim();
  if (!to) throw new MailError('That order has no email address on it.');
  if (!mailerConfigured(env)) {
    throw new MailError(
      'Email is not configured. Set BREVO_KEY, RECOVERY_FROM and ' +
        'RECOVERY_POSTAL_ADDRESS with `wrangler secret put`.'
    );
  }

  return sendMail(env, {
    to,
    subject: SHIPPED_SUBJECT,
    html: shippedHtml(order, trackingNumber, now),
    text: shippedText(order, trackingNumber, now),
    transactional: true,
  });
}

/* --------------------------------------------------------------- test send */

/** A made-up order, so a test never touches a real customer's record. */
const SAMPLE_ORDER = {
  email: '',
  shippingAddress: { fullName: 'Sample Customer' },
};

const SAMPLE_TRACKING = '9400111899223197428490';

/**
 * Mails the shipped email to the shop's own inbox, to see how it lands.
 *
 * The recipient is NOT a parameter, and that is the point: this endpoint sends
 * email, so the one thing it must never be able to do is send to an address
 * someone hands it. It goes to the shop inbox or nowhere.
 */
export async function sendTestShippedEmail(env, now = Date.now()) {
  if (!mailerConfigured(env)) {
    throw new MailError(
      'Email is not configured. Set BREVO_KEY, RECOVERY_FROM and ' +
        'RECOVERY_POSTAL_ADDRESS with `wrangler secret put`.'
    );
  }

  const result = await sendMail(env, {
    to: UNSUBSCRIBE_TO,
    subject: '[test] ' + SHIPPED_SUBJECT,
    html: shippedHtml(SAMPLE_ORDER, SAMPLE_TRACKING, now),
    text: shippedText(SAMPLE_ORDER, SAMPLE_TRACKING, now),
    transactional: true,
  });

  return { ...result, to: UNSUBSCRIBE_TO };
}
