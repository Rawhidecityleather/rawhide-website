/**
 * The emails a customer account sends: the code that confirms a new
 * account's email, the password-reset code, the "you already have an account"
 * and "no account under this address" replies, the welcome with the sign-up
 * code, and the birthday code.
 *
 * One layout for all of them, in the same stone-and-ink look as the cart
 * recovery email, so a customer sees one shop no matter which system wrote to
 * them.
 *
 * Which ones are marketing: only the birthday email. It is a discount nobody
 * asked for that day, so it carries the postal address and the unsubscribe
 * line (CAN-SPAM), and it goes out only while the customer has the birthday
 * email box ticked on their account. The rest are things the customer just
 * asked for and go out transactional, with no List-Unsubscribe. An
 * unsubscribe click on a password code would lock that customer out of their
 * own account.
 */

const STORE_URL = 'https://rawhidecityleather.com';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "Nov 17, 2026", in the shop's own time zone. */
export function prettyDate(iso) {
  const at = new Date(iso);
  if (isNaN(at)) return '';
  return at.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
}

/**
 * The last day a code works, for a code whose expiry is an instant. Snipcart
 * stops taking it AT that instant, so the day to promise is the one the
 * instant falls in, a minute earlier — an expiry of midnight Eastern is good
 * through the day before, not the day of.
 */
export function goodThrough(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return prettyDate(new Date(at - 60 * 1000).toISOString());
}

/**
 * Builds one message. `blocks` are plain-text paragraphs; nothing in them is
 * trusted as HTML. `code` is the big box in the middle, if there is one.
 */
export function renderShopEmail({
  subject, preheader = '', headline, greeting = 'Hey,', blocks = [],
  code = '', codeLabel = 'Your code', codeNote = '',
  button = null, marketing = false, postalAddress = '', unsubscribeTo = '',
}) {
  const text = [
    greeting,
    '',
    ...blocks.flatMap((b) => [b, '']),
    code ? `${codeLabel}: ${code}` : null,
    code && codeNote ? codeNote : null,
    code ? '' : null,
    button ? `${button.label}: ${button.href}` : null,
    button ? '' : null,
    '"We do not cut corners. We cut leather."',
    '',
    'Rawhide City Leather - Firefighter Owned - Est. 2024',
    marketing ? postalAddress : null,
    `${STORE_URL}/shop`,
    marketing ? '' : null,
    marketing
      ? `Do not want these? Untick "birthday email" on your account at ${STORE_URL}/account, or email ${unsubscribeTo}.`
      : null,
  ].filter((line) => line !== null).join('\n');

  const paragraphs = blocks.map((b) =>
    `<p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:#3A3833;">${escapeHtml(b)}</p>`
  ).join('\n                  ');

  const codeBox = code ? `
              <tr>
                <td style="padding:8px 36px 8px 36px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td bgcolor="#0F0F0F" align="center" style="background-color:#0F0F0F;padding:24px 22px;">
                        <p style="margin:0 0 10px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#A9A59B;">${escapeHtml(codeLabel)}</p>
                        <p style="margin:0;font-family:'Courier New',Courier,monospace;font-weight:bold;font-size:28px;letter-spacing:4px;color:#EBE8E1;">${escapeHtml(code)}</p>
                      </td>
                    </tr>
                  </table>
                  ${codeNote ? `<p style="margin:12px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:14px;line-height:1.6;color:#6B6358;">${escapeHtml(codeNote)}</p>` : ''}
                </td>
              </tr>` : '';

  const buttonRow = button ? `
              <tr>
                <td align="center" style="padding:24px 36px 8px 36px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="#0F0F0F" style="background-color:#0F0F0F;">
                        <a href="${escapeHtml(button.href)}" target="_blank" style="display:inline-block;padding:15px 42px;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#EBE8E1;text-decoration:none;">${escapeHtml(button.label)}</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>` : '';

  const footerExtra = marketing ? `
            <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#6B6358;">${escapeHtml(postalAddress)}</p>
            <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#6B6358;">Do not want these? Untick "birthday email" on <a href="${STORE_URL}/account" style="color:#6B6358;text-decoration:underline;">your account</a>, or <a href="mailto:${escapeHtml(unsubscribeTo)}?subject=Unsubscribe" style="color:#6B6358;text-decoration:underline;">unsubscribe</a>.</p>` : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#EBE8E1;">
${preheader ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EBE8E1" style="background-color:#EBE8E1;">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">

        <tr>
          <td align="center" style="padding:0 0 24px 0;">
            <img src="${STORE_URL}/assets/img/logo.png" width="170" alt="Rawhide City Leather" style="display:block;width:170px;max-width:60%;height:auto;border:0;">
          </td>
        </tr>

        <tr>
          <td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid #DFDBD2;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

              <tr>
                <td bgcolor="#0F0F0F" align="center" style="background-color:#0F0F0F;padding:26px 24px;">
                  <p style="margin:0 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#A9A59B;">Firefighter Owned &middot; Est. 2024</p>
                  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:26px;line-height:1.15;letter-spacing:2px;text-transform:uppercase;color:#EBE8E1;">${escapeHtml(headline)}</p>
                </td>
              </tr>

              <tr>
                <td style="padding:32px 36px 8px 36px;">
                  <p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.6;color:#0F0F0F;">${escapeHtml(greeting)}</p>
                  ${paragraphs}
                </td>
              </tr>
${codeBox}${buttonRow}
              <tr>
                <td align="center" style="padding:24px 36px 32px 36px;">
                  <p style="margin:0;font-family:'Courier New',Courier,monospace;font-style:italic;font-size:14px;color:#6B6358;">"We do not cut corners. We cut leather."</p>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:28px 24px 8px 24px;">
            <p style="margin:0 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:14px;letter-spacing:3px;text-transform:uppercase;color:#0F0F0F;">Rawhide City Leather</p>
            <p style="margin:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6B6358;">Firefighter Owned &middot; Est. 2024</p>
            <p style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#6B6358;">Questions? Just reply to this email.</p>${footerExtra}
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body></html>`;

  return { subject, html, text };
}

/* ------------------------------------------------------------ the four */

export function resetCodeEmail(code) {
  return renderShopEmail({
    subject: `${code} is your Rawhide City Leather password code`,
    preheader: 'Your code to set a new password. It works for 15 minutes.',
    headline: 'Set a new password',
    blocks: ['Here is your code to set a new password on your account.'],
    code,
    codeLabel: 'Password code',
    codeNote: 'It works for 15 minutes. If you did not ask for this, ignore it and your password stays the same.',
  });
}

export function existingAccountEmail() {
  return renderShopEmail({
    subject: 'You already have a Rawhide City Leather account',
    preheader: 'Somebody tried to make a new account with this email.',
    headline: 'You already have an account',
    blocks: [
      'Somebody tried to make a new account with this email, and there is already one under it. Nothing new was made.',
      'Sign in with your password. If you forgot it, tap "Forgot your password?" on the sign-in page and we will send a code to set a new one.',
    ],
    button: { label: 'Sign In', href: `${STORE_URL}/account` },
  });
}

export function signUpCodeEmail(code, firstName) {
  return renderShopEmail({
    subject: `${code} is your Rawhide City Leather code`,
    preheader: 'One step left to finish your account.',
    headline: 'Finish your account',
    greeting: firstName ? `Hey ${firstName},` : 'Hey,',
    blocks: ['Type this code on the sign-up page to finish your account. Your 20% off code comes right after.'],
    code,
    codeLabel: 'Your code',
    codeNote: 'It works for 15 minutes. If you did not sign up, ignore it and nothing is made.',
  });
}

export function noAccountEmail() {
  return renderShopEmail({
    subject: 'No Rawhide City Leather account under this email',
    preheader: 'Somebody asked to reset a password with this email.',
    headline: 'No account here yet',
    blocks: [
      'Somebody asked to reset the password on a Rawhide City Leather account with this email, and there is no account under it.',
      'If that was you, make one. It takes a minute, and your first order gets 20% off.',
      'If it was not you, ignore this. Nothing was made.',
    ],
    button: { label: 'Make an Account', href: `${STORE_URL}/account#create` },
  });
}

export function welcomeEmail(firstName, welcome) {
  const blocks = ['Your account is set. Your orders and tracking are all in one place now, and you can keep a card on file for next time.'];
  if (welcome && welcome.code) {
    return renderShopEmail({
      subject: `Your account is set. Here is 20% off, good through ${goodThrough(welcome.expiresAt)}`,
      preheader: '20% off one order, good for a month.',
      headline: 'Welcome to the shop',
      greeting: firstName ? `Hey ${firstName},` : 'Hey,',
      blocks: [...blocks, 'Here is 20% off one order for signing up.'],
      code: welcome.code,
      codeLabel: '20% off one order',
      codeNote: `Good through ${goodThrough(welcome.expiresAt)}. One use, and it does not stack with another code or a store sale.`,
      button: { label: 'Shop the Gear', href: `${STORE_URL}/shop` },
    });
  }
  return renderShopEmail({
    subject: 'Your Rawhide City Leather account is set',
    preheader: 'Your orders and tracking, in one place.',
    headline: 'Welcome to the shop',
    greeting: firstName ? `Hey ${firstName},` : 'Hey,',
    blocks,
    button: { label: 'Your Account', href: `${STORE_URL}/account` },
  });
}

export function birthdayEmail(firstName, birthday, { postalAddress, unsubscribeTo }) {
  const through = goodThrough(birthday.expiresAt);
  return renderShopEmail({
    subject: `Happy birthday. 15% off, good through ${through}`,
    preheader: 'A birthday code from the shop, good for a month.',
    headline: 'Happy birthday',
    greeting: firstName ? `Hey ${firstName},` : 'Hey,',
    blocks: ['Happy birthday from the shop. Here is 15% off one order, on us.'],
    code: birthday.code,
    codeLabel: '15% off one order',
    codeNote: `Good through ${through}. One use, and it does not stack with another code or a store sale.`,
    button: { label: 'Shop the Gear', href: `${STORE_URL}/shop` },
    marketing: true,
    postalAddress,
    unsubscribeTo,
  });
}
