/**
 * "Your gear is in your hands", for an order handed over in person.
 *
 * The shipped email's twin. Same layout and voice — a customer should not be
 * able to tell the two came from different places — but no tracking box and no
 * Track button, because there is no package. What's left is the part worth
 * sending anyway: the thank-you, the care note, the warranty, and the review
 * ask, which lands best on someone who has the piece in their hands today.
 *
 * Not automatic. It goes out when the shop ticks "email them a thank-you"
 * beside the Hand delivered button: plenty of handovers are a crewmate at the
 * station, and an email about a strap you just watched them put on is noise.
 *
 * Transactional, so no List-Unsubscribe. See shipped-mail.js for why.
 */

import { esc } from './lib.js';
import { sendMail, mailerConfigured, MailError, UNSUBSCRIBE_TO } from './mailer.js';
import { firstName, shipDate, REVIEW_URL } from './shipped-mail.js';

const SITE = 'https://rawhidecityleather.com';

export const DELIVERED_SUBJECT = 'Your Rawhide City Leather gear is in your hands';

/** "RCL-1042", or nothing — the email reads fine without an order number. */
function orderLabel(order) {
  return String(order?.invoiceNumber || '').trim();
}

export function deliveredText(order, now) {
  const name = firstName(order);
  const label = orderLabel(order);
  return [
    name ? `Hey ${name},` : 'Hey,',
    '',
    'Thanks for letting us hand your order over in person. It was cut, stitched,',
    'and finished by hand in Lakeland, Florida, and now it is yours.',
    '',
    label ? `Order ${label}, handed over ${shipDate(now)}` : `Handed over ${shipDate(now)}`,
    '',
    'Leather is a natural material, and yours was built to earn character. An',
    `occasional pass of Leather Butter will keep it strong: ${SITE}/product-leather-butter`,
    '',
    'Every piece carries our career warranty: if workmanship or materials ever',
    `fail you, we will make it right. ${SITE}/shipping#warranty`,
    '',
    'Once it has been on the job a few shifts, tell us how it is holding up,',
    'good or bad. It helps the next firefighter decide, and it is how a small',
    `shop gets found. Leave a review: ${REVIEW_URL}`,
    '',
    '"We do not cut corners. We cut leather."',
    '',
    'Rawhide City Leather — Firefighter Owned, Est. 2024, Lakeland, FL',
    'Questions about your order? Just reply to this email.',
  ].join('\n');
}

export function deliveredHtml(order, now) {
  const name = esc(firstName(order));
  const label = orderLabel(order);

  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Thanks for picking up your handmade leather gear. A few notes on keeping it strong.</div>
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
                  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:26px;line-height:1.15;letter-spacing:2px;text-transform:uppercase;color:#EBE8E1;">Your gear is in your hands</p>
                </td>
              </tr>
              <tr>
                <td style="padding:32px 36px 8px 36px;">
                  <p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.6;color:#0F0F0F;">Hey${name ? ' ' + name : ''},</p>
                  <p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:#3A3833;">Thanks for letting us hand your order over in person. It was cut, stitched, and finished by hand in Lakeland, Florida, and now it is yours.</p>
                </td>
              </tr>
              <tr>
                <td style="padding:8px 36px 8px 36px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="#EBE8E1" style="background-color:#EBE8E1;border:1px dashed #6B6358;padding:20px 16px;">${label ? `
                        <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#6B6358;">Order</p>
                        <p style="margin:0 0 10px 0;font-family:'Courier New',Courier,monospace;font-weight:bold;font-size:19px;letter-spacing:2px;color:#0F0F0F;word-break:break-all;">${esc(label)}</p>` : ''}
                        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6B6358;">Handed over ${esc(shipDate(now))}</p>
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
                  <p style="margin:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#0F0F0F;">Built for the long haul</p>
                  <p style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.65;color:#3A3833;">Leather is a natural material, and yours was built to earn character. An occasional pass of <a href="${SITE}/product-leather-butter" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Leather Butter</a> will keep it strong shift after shift. Every piece carries our career warranty: if workmanship or materials ever fail you, we will make it right. <a href="${SITE}/shipping#warranty" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Read the warranty</a>.</p>
                </td>
              </tr>
              <tr>
                <td style="padding:12px 36px 8px 36px;">
                  <p style="margin:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#0F0F0F;">Once it has been on the job</p>
                  <p style="margin:0 0 14px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.65;color:#3A3833;">Give it a few shifts. Then tell us how it is holding up, good or bad. It helps the next firefighter decide, and it is how a small shop gets found.</p>
                  <a href="${REVIEW_URL}" target="_blank" style="display:inline-block;padding:12px 26px;border:2px solid #0F0F0F;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#0F0F0F;text-decoration:none;">Leave a Review</a>
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

const NOT_CONFIGURED =
  'Email is not configured. Set RESEND_API_KEY (or BREVO_KEY), RECOVERY_FROM and ' +
  'RECOVERY_POSTAL_ADDRESS with `wrangler secret put`.';

/**
 * Mails one customer the hand-delivered thank-you. Throws MailError, which the
 * caller reports without undoing the delivery — the customer has the piece
 * whether or not the email went out.
 */
export async function sendDeliveredEmail(env, order, now = Date.now()) {
  const to = String(order?.email || '').trim();
  if (!to) throw new MailError('That order has no email address on it.');
  if (!mailerConfigured(env)) throw new MailError(NOT_CONFIGURED);

  return sendMail(env, {
    to,
    subject: DELIVERED_SUBJECT,
    html: deliveredHtml(order, now),
    text: deliveredText(order, now),
    transactional: true,
  });
}

/** A made-up order, so a test never touches a real customer's record. */
const SAMPLE_ORDER = {
  email: '',
  invoiceNumber: 'RCL-1042',
  shippingAddress: { fullName: 'Sample Customer' },
};

/**
 * The thank-you, to the shop's own inbox. Like the shipped test, the recipient
 * is not a parameter: it goes to the shop or nowhere.
 */
export async function sendTestDeliveredEmail(env, now = Date.now()) {
  if (!mailerConfigured(env)) throw new MailError(NOT_CONFIGURED);

  const result = await sendMail(env, {
    to: UNSUBSCRIBE_TO,
    subject: '[test] ' + DELIVERED_SUBJECT,
    html: deliveredHtml(SAMPLE_ORDER, now),
    text: deliveredText(SAMPLE_ORDER, now),
    transactional: true,
  });

  return { ...result, to: UNSUBSCRIBE_TO };
}
