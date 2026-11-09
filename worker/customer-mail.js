/**
 * A note to one customer, written on the dashboard and sent from the shop.
 *
 * Every other email the Worker sends is a form letter: the shipped notice, a
 * sign-in code, the cart reminder. This one is whatever the shop types — an
 * update on a build that is running long, a question before leather gets cut,
 * an answer to "did my order go through". Until now that meant leaving the
 * dashboard for Gmail and carrying the address across by hand.
 *
 * Two rules, and both are about where the mail can go:
 *
 * - The recipient is never taken from the request. The dashboard sends an
 *   order token; the Worker fetches that order from Snipcart and mails the
 *   address on it. A logged-in session that could post `{to: anyone}` would
 *   turn the shop's verified sending domain into a relay for whoever held the
 *   password.
 * - A copy goes to the shop inbox, as a BCC. The message leaves through Resend
 *   or Brevo rather than Gmail, so nothing lands in Sent on its own; the BCC is
 *   the record. It also carries the same Message-ID as the customer's copy, so
 *   when they hit reply, Gmail threads their answer under it.
 *
 * Transactional, so no List-Unsubscribe — a note about an order someone placed
 * is not marketing, and an unsubscribe click on one would have the provider
 * suppress that address for the shipped email too.
 *
 * Routes (wired in index.js, behind the login)
 *   POST /dashboard/api/customer-mail        { token, subject, message }
 *   POST /dashboard/api/customer-mail-test   same body; goes to the shop inbox, never the customer
 */

import { esc, shortDate } from './lib.js';
import { sendMail, mailerConfigured, MailError, UNSUBSCRIBE_TO } from './mailer.js';
import { firstName, REVIEW_URL } from './shipped-mail.js';

const SITE = 'https://rawhidecityleather.com';

/** Caps on what the form takes. Mirrored as maxlength on the fields. */
export const SUBJECT_MAX = 150;
export const MESSAGE_MAX = 4000;

/**
 * Openers. `{first}` is the customer's first name and `{order}` the invoice
 * number; the dashboard fills both in, and a space before either placeholder
 * goes with it when the value is empty, so a nameless order greets with "Hey,"
 * rather than "Hey ,".
 *
 * Square brackets mark the part only the shop can write — the reason a build
 * is late, the question that needs answering. The form refuses to send while
 * any are left, so a starter can never go out half filled.
 *
 * The voice is the shop's: plain, first person, no "we regret to inform you".
 */
export const STARTERS = [
  {
    key: 'blank',
    label: 'Blank',
    subject: 'Your Rawhide City Leather order {order}',
    body: 'Hey {first},\n\n',
  },
  {
    key: 'update',
    label: 'Order update',
    subject: 'Your Rawhide City Leather order {order}',
    body: [
      'Hey {first},',
      '',
      'Quick update on your order. It is on the bench and coming along, and you will get a tracking number by email the moment it ships.',
      '',
      'Anything you need in the meantime, just reply to this email.',
      '',
      'Thanks,',
      'Rawhide City Leather',
    ].join('\n'),
  },
  {
    key: 'behind',
    label: 'Running behind',
    subject: 'An update on your Rawhide City Leather order {order}',
    body: [
      'Hey {first},',
      '',
      'I want to be straight with you: your order is running behind where I said it would be. [Why, and the new date you can count on.]',
      '',
      'I am sorry for the wait. You will get a tracking number by email the moment it ships, and if the new date does not work for you, reply here and we will sort it out.',
      '',
      'Thanks for your patience,',
      'Rawhide City Leather',
    ].join('\n'),
  },
  {
    key: 'question',
    label: 'Question before we build',
    subject: 'Quick question about your Rawhide City Leather order {order}',
    body: [
      'Hey {first},',
      '',
      'Before I cut leather on your order, one quick question:',
      '',
      '[Your question.]',
      '',
      'Reply here and I will get right back on it. Nothing moves until I hear from you, so the sooner the better.',
      '',
      'Thanks,',
      'Rawhide City Leather',
    ].join('\n'),
  },
  {
    key: 'soon',
    label: 'Finished, ships soon',
    subject: 'Your Rawhide City Leather order {order} ships soon',
    body: [
      'Hey {first},',
      '',
      'Good news: your order is finished and will ship in the next day or two. You will get a tracking number by email as soon as the label is printed.',
      '',
      'Thanks for your patience, and for your business.',
      '',
      'Rawhide City Leather',
    ].join('\n'),
  },
  {
    key: 'holding',
    label: "How's it holding up?",
    subject: "How's your Rawhide City Leather gear holding up?",
    body: [
      'Hey {first},',
      '',
      'Your order should have a few shifts on it by now. How is it holding up?',
      '',
      'If anything is not right, reply here and I will make it right; every piece carries our career warranty. ' +
        'If it is doing its job, a quick review helps the next firefighter decide: ' + REVIEW_URL,
      '',
      'Thanks,',
      'Rawhide City Leather',
    ].join('\n'),
  },
];

export function starterFor(key) {
  return STARTERS.find((s) => s.key === key) || STARTERS[0];
}

/** The two placeholders, filled. Mirrored in CUSTOMER_MAIL_SCRIPT below. */
export function fillStarter(starter, { first = '', order = '' } = {}) {
  const fill = (text) => String(text)
    .replace(/ ?\{first\}/g, first ? ' ' + first : '')
    .replace(/ ?\{order\}/g, order ? ' ' + order : '');
  return { subject: fill(starter.subject).trim(), body: fill(starter.body) };
}

/** "Basic Radio Strap, 2 × Helmet Band" — what the order holds, in one line. */
export function itemList(order) {
  return (order?.items || [])
    .map((item) => {
      const name = String(item?.name || item?.id || '').trim();
      if (!name) return '';
      const qty = Number(item?.quantity) || 1;
      return qty > 1 ? `${qty} × ${name}` : name;
    })
    .filter(Boolean)
    .join(', ');
}

/** Everything the form needs to know about who it is writing to. */
export function mailContext(order) {
  const a = order?.shippingAddress || order?.billingAddress || {};
  return {
    token: String(order?.token || ''),
    email: String(order?.email || '').trim(),
    name: String(a.fullName || a.name || '').trim(),
    first: firstName(order),
    order: String(order?.invoiceNumber || order?.token || ''),
    items: itemList(order),
  };
}

/* ------------------------------------------------------------------- draft */

/**
 * What the form posted, cleaned up — or the one reason it cannot go.
 *
 * The subject loses its line breaks: a provider takes it as a JSON string, so
 * it cannot inject a header, but a two-line subject still reads as garbage in
 * an inbox. Returns `{ subject, message }` or `{ error }`.
 */
export function checkDraft(body = {}) {
  const subject = String(body?.subject ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const message = String(body?.message ?? '').replace(/\r\n?/g, '\n').trim();

  if (!subject) return { error: 'Give it a subject.' };
  if (subject.length > SUBJECT_MAX) return { error: `Keep the subject under ${SUBJECT_MAX} characters.` };
  if (!message) return { error: 'There is no message to send.' };
  if (message.length > MESSAGE_MAX) {
    return { error: `That is over ${MESSAGE_MAX} characters. Trim it, or send it as two notes.` };
  }
  return { subject, message };
}

/* ---------------------------------------------------------------- the mail */

/**
 * One line of the note as HTML: escaped, with any web address made a link.
 * Trailing punctuation stays out of the link — "see https://x.com/track." is
 * a sentence, not an address ending in a full stop. Only http(s) qualifies, so
 * nothing typed here can become a javascript: link.
 */
function lineHtml(line) {
  const re = /https?:\/\/[^\s<>"']+/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    let url = m[0];
    const trail = url.match(/[.,;:!?)]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    out += `<a href="${esc(url)}" style="color:#0F0F0F;text-decoration:underline;">${esc(url)}</a>`;
    if (trail) out += esc(trail[0]);
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}

/** Blank lines break paragraphs; a single newline is a line break within one. */
export function messageHtml(message) {
  return String(message).split(/\n{2,}/).map((para) =>
    `<p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:#0F0F0F;">${
      para.split('\n').map(lineHtml).join('<br>')
    }</p>`
  ).join('');
}

/** The order, boiled down to what the customer should see repeated back. */
function orderFacts(order) {
  const tracking = String(order?.trackingNumber || '').replace(/\s+/g, '');
  return {
    ...mailContext(order),
    placed: shortDate(order?.creationDate),
    tracking,
    trackUrl: tracking ? `${SITE}/track?num=${encodeURIComponent(tracking)}` : '',
  };
}

const KICKER = 'margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#6B6358;';
const FACT = 'margin:0 0 4px 0;font-family:Georgia,\'Times New Roman\',serif;font-size:14px;line-height:1.5;color:#3A3833;';

/**
 * Same frame as the shipped email, so a customer who gets both sees one shop.
 * The note is the body; under it, the order repeated back so they know which
 * one this is about without digging for a receipt.
 */
export function customerHtml(order, { message }) {
  const f = orderFacts(order);
  // The inbox preview line: the start of the note itself, not boilerplate.
  const preview = esc(String(message).replace(/\s+/g, ' ').trim().slice(0, 110));

  const facts = [
    `<p style="${KICKER}">Order ${esc(f.order)}</p>`,
    f.items ? `<p style="${FACT}">${esc(f.items)}</p>` : '',
    f.placed ? `<p style="${FACT}">Placed ${esc(f.placed)}</p>` : '',
    f.tracking
      ? `<p style="${FACT}">Tracking ${esc(f.tracking)} &middot; <a href="${esc(f.trackUrl)}" target="_blank" style="color:#0F0F0F;text-decoration:underline;">Track it</a></p>`
      : '',
  ].join('');

  return `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preview}</div>
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
                <td bgcolor="#0F0F0F" align="center" style="background-color:#0F0F0F;padding:22px 24px;">
                  <p style="margin:0 0 6px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#A9A59B;">Rawhide City Leather &middot; Lakeland, FL</p>
                  <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:22px;line-height:1.15;letter-spacing:2px;text-transform:uppercase;color:#EBE8E1;">A note about your order</p>
                </td>
              </tr>
              <tr>
                <td style="padding:32px 36px 12px 36px;">
                  ${messageHtml(message)}
                </td>
              </tr>
              <tr>
                <td style="padding:8px 36px 28px 36px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td bgcolor="#EBE8E1" style="background-color:#EBE8E1;border:1px dashed #6B6358;padding:16px 18px;">
                        ${facts}
                      </td>
                    </tr>
                  </table>
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
            <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#6B6358;">Reply to this email and it comes straight to the shop.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

export function customerText(order, { message }) {
  const f = orderFacts(order);
  const lines = [
    String(message),
    '',
    `Order ${f.order}${f.placed ? ', placed ' + f.placed : ''}`,
  ];
  if (f.items) lines.push(f.items);
  if (f.tracking) lines.push(`Tracking ${f.tracking}: ${f.trackUrl}`);
  lines.push(
    '',
    'Rawhide City Leather — Firefighter Owned, Est. 2024, Lakeland, FL',
    'Reply to this email and it comes straight to the shop.',
  );
  return lines.join('\n');
}

/**
 * Mails the note to the address on the order, with a copy to the shop inbox.
 *
 * Throws MailError — for a draft that cannot go, an order with no address, a
 * mailer that is not set up, or a provider that said no. The caller shows the
 * message; nothing else has happened, so there is nothing to unwind.
 */
export async function sendCustomerEmail(env, order, draft) {
  const to = String(order?.email || '').trim();
  if (!to) throw new MailError('That order has no email address on it.');
  if (!mailerConfigured(env)) {
    throw new MailError(
      'Email is not configured. Set RESEND_API_KEY (or BREVO_KEY), RECOVERY_FROM and ' +
        'RECOVERY_POSTAL_ADDRESS with `wrangler secret put`.'
    );
  }
  const checked = checkDraft(draft);
  if (checked.error) throw new MailError(checked.error);

  const result = await sendMail(env, {
    to,
    bcc: UNSUBSCRIBE_TO,
    subject: checked.subject,
    html: customerHtml(order, checked),
    text: customerText(order, checked),
    transactional: true,
  });
  return { ...result, to, copy: UNSUBSCRIBE_TO };
}

/**
 * The same note, to the shop's own inbox instead — to see how it lands before
 * it goes to the customer, or to prove the whole path end to end without
 * emailing anyone real.
 *
 * The recipient is NOT a parameter, and that is the point: this endpoint
 * sends email, so the one thing it must never do is send to an address
 * someone hands it. It goes to the shop inbox or nowhere. No BCC either —
 * the inbox is already the recipient.
 */
export async function sendTestCustomerEmail(env, order, draft) {
  if (!mailerConfigured(env)) {
    throw new MailError(
      'Email is not configured. Set RESEND_API_KEY (or BREVO_KEY), RECOVERY_FROM and ' +
        'RECOVERY_POSTAL_ADDRESS with `wrangler secret put`.'
    );
  }
  const checked = checkDraft(draft);
  if (checked.error) throw new MailError(checked.error);

  const result = await sendMail(env, {
    to: UNSUBSCRIBE_TO,
    subject: '[test] ' + checked.subject,
    html: customerHtml(order, checked),
    text: customerText(order, checked),
    transactional: true,
  });
  return { ...result, to: UNSUBSCRIBE_TO };
}

/* -------------------------------------------------------------- dashboard */

/**
 * The button beside a customer's name. Everything the form shows rides on it
 * as data attributes, so opening the note costs no request; the one thing the
 * form later sends back is the token.
 *
 * With no mailer the button stays, greyed out, so the feature is visible and
 * the title says what is missing — a button that vanishes is one nobody knows
 * to go looking for.
 */
export function mailButton(order, { ready = true } = {}) {
  const ctx = mailContext(order);
  if (!ctx.email) return '';
  const title = ready
    ? `Email ${ctx.email}`
    : 'Email is not set up on the Worker. See Alerts & email.';
  return `<button type="button" class="btn tiny ghost cmail"${ready ? '' : ' disabled'} title="${esc(title)}"
      aria-label="Email ${esc(ctx.name || ctx.email)}"
      data-token="${esc(ctx.token)}" data-email="${esc(ctx.email)}" data-name="${esc(ctx.name)}"
      data-first="${esc(ctx.first)}" data-order="${esc(ctx.order)}" data-items="${esc(ctx.items)}">Email</button>`;
}

/** The note itself: one dialog on the page, filled in when a button is hit. */
export function renderMailDialog() {
  const options = STARTERS.map((s) =>
    `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');

  return `<dialog id="maildlg" class="maildlg" aria-labelledby="maildlg-title">
  <form id="mailform" novalidate>
    <div class="mailhead">
      <h2 id="maildlg-title">Email the customer</h2>
      <button type="button" class="mailx" id="mailcancel" aria-label="Close without sending">&times;</button>
    </div>
    <div class="mailbody">
      <p class="mailto"><span class="mailk">To</span> <span id="mailto"></span></p>
      <p class="mailto"><span class="mailk">About</span> <span id="mailabout"></span></p>
      <label class="qfield">
        <span>Start from</span>
        <select name="starter" id="mailstarter">${options}</select>
      </label>
      <label class="qfield">
        <span>Subject</span>
        <input type="text" name="subject" id="mailsubject" maxlength="${SUBJECT_MAX}" required autocomplete="off">
      </label>
      <label class="qfield">
        <span>Message</span>
        <textarea name="message" id="mailmessage" rows="12" maxlength="${MESSAGE_MAX}" required></textarea>
      </label>
      <p class="hint">Plain text; web addresses become links. Anything in [brackets] is yours to fill
        in before it goes. It is sent from the shop, a copy lands in the shop inbox, and their reply
        comes back there too. Not sure how it reads? <em>Send me a test copy</em> mails it to the
        shop inbox and nowhere else.</p>
    </div>
    <div class="mailfoot">
      <button type="submit" class="btn" id="mailsend">Send</button>
      <button type="button" class="btn ghost" id="mailclose">Cancel</button>
      <span class="soft" id="mailnote" role="status" aria-live="polite"></span>
      <button type="button" class="btn tiny ghost" id="mailtestcopy"
        title="Mails this note to the shop inbox instead of the customer">Send me a test copy</button>
    </div>
  </form>
</dialog>`;
}

/* ------------------------------------------------------------------ client */

export const CUSTOMER_MAIL_STYLES = `
/* ---------------------------------------------------------- customer note */
.cmail{margin-left:8px;vertical-align:middle}
.maildlg{border:1px solid var(--line-2);border-radius:3px;padding:0;
  width:min(620px,calc(100vw - 24px));max-height:calc(100vh - 24px);
  background:var(--paper);color:var(--ink);box-shadow:0 24px 60px rgba(15,15,15,.35)}
.maildlg::backdrop{background:rgba(15,15,15,.5)}
.maildlg form{display:flex;flex-direction:column;max-height:calc(100vh - 26px)}
.mailhead{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:14px 18px;border-bottom:1px solid var(--line)}
.mailhead h2{font-size:13px;letter-spacing:.2em}
.mailx{border:0;background:none;color:var(--soft);font-size:24px;line-height:1;
  cursor:pointer;padding:2px 7px;border-radius:2px}
.mailx:hover{background:var(--bad-bg);color:var(--bad)}
.mailbody{padding:16px 18px 6px;display:flex;flex-direction:column;gap:12px;overflow:auto}
.mailto{margin:0;font-size:13px;overflow-wrap:anywhere}
.mailk{display:inline-block;min-width:3.6rem;font-family:var(--display);text-transform:uppercase;
  letter-spacing:.15em;font-size:9.5px;color:var(--soft)}
.mailbody .hint{margin:0}
#mailmessage{font-family:var(--body);min-height:11rem}
.mailfoot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:14px 18px 16px;border-top:1px solid var(--line)}
#mailnote{font-size:12.5px;flex:1 1 10rem}
#mailtestcopy{margin-left:auto}
`;

export const CUSTOMER_MAIL_SCRIPT = `
(function(){
  var dlg = document.getElementById('maildlg');
  if (!dlg) return;

  var STARTERS = ${JSON.stringify(STARTERS).replace(/</g, '\\u003c')};

  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg, bad){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, bad ? 9000 : 6000);
  }
  function post(path, body){
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
      body: JSON.stringify(body)
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  var form = document.getElementById('mailform');
  var toEl = document.getElementById('mailto');
  var aboutEl = document.getElementById('mailabout');
  var pick = document.getElementById('mailstarter');
  var subj = document.getElementById('mailsubject');
  var msg = document.getElementById('mailmessage');
  var sendBtn = document.getElementById('mailsend');
  var testBtn = document.getElementById('mailtestcopy');
  var note = document.getElementById('mailnote');

  var ctx = null;          // who the open note is to
  var current = 'blank';   // the starter in the dropdown
  var filledBody = '';     // the body as the starter left it

  /* Same two substitutions as fillStarter in customer-mail.js. */
  function fill(text){
    return String(text)
      .replace(/ ?\\{first\\}/g, ctx.first ? ' ' + ctx.first : '')
      .replace(/ ?\\{order\\}/g, ctx.order ? ' ' + ctx.order : '');
  }
  function starter(key){
    for (var i = 0; i < STARTERS.length; i++) if (STARTERS[i].key === key) return STARTERS[i];
    return STARTERS[0];
  }
  function apply(key){
    var s = starter(key);
    current = s.key;
    pick.value = s.key;
    subj.value = fill(s.subject).trim();
    msg.value = fill(s.body);
    filledBody = msg.value;
  }
  /* Has the shop written anything a starter swap or a close would throw away? */
  function typed(){
    return msg.value.trim() !== '' && msg.value !== filledBody;
  }
  function shut(){
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  }
  function askThenShut(){
    if (typed() && !confirm('Close this note? What you typed will be lost.')) return;
    shut();
  }

  document.addEventListener('click', function(event){
    var btn = event.target.closest('.cmail');
    if (!btn || btn.disabled) return;
    ctx = {
      token: btn.getAttribute('data-token') || '',
      email: btn.getAttribute('data-email') || '',
      name: btn.getAttribute('data-name') || '',
      first: btn.getAttribute('data-first') || '',
      order: btn.getAttribute('data-order') || '',
      items: btn.getAttribute('data-items') || ''
    };
    // textContent, never innerHTML: a customer typed their own name.
    toEl.textContent = ctx.name ? ctx.name + ' <' + ctx.email + '>' : ctx.email;
    aboutEl.textContent = 'Order ' + ctx.order + (ctx.items ? ' \\u00b7 ' + ctx.items : '');
    note.textContent = '';
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    apply('blank');
    if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    msg.focus();
    msg.setSelectionRange(msg.value.length, msg.value.length);
  });

  document.getElementById('mailclose').addEventListener('click', askThenShut);
  document.getElementById('mailcancel').addEventListener('click', askThenShut);
  // Escape fires 'cancel' on the dialog; same question before it goes.
  dlg.addEventListener('cancel', function(event){
    if (!typed()) return;
    event.preventDefault();
    askThenShut();
  });

  pick.addEventListener('change', function(){
    var next = starter(pick.value);
    if (typed() && !confirm('Replace what you typed with the "' + next.label + '" starter?')) {
      pick.value = current;
      return;
    }
    apply(next.key);
    msg.focus();
  });

  form.addEventListener('submit', function(event){
    event.preventDefault();
    if (!ctx) return;
    var subject = subj.value.trim();
    var message = msg.value.trim();
    if (!subject) { note.textContent = 'Give it a subject.'; subj.focus(); return; }
    if (!message) { note.textContent = 'Nothing to send yet.'; msg.focus(); return; }

    // A starter's [bracketed] blank left in place goes out as nonsense. Put
    // the cursor on it instead.
    var blank = /\\[[^\\]\\n]{0,120}\\]/.exec(msg.value);
    if (blank) {
      note.textContent = 'Fill in the part in brackets first.';
      msg.focus();
      msg.setSelectionRange(blank.index, blank.index + blank[0].length);
      return;
    }

    note.textContent = '';
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending\\u2026';

    post('/dashboard/api/customer-mail', { token: ctx.token, subject: subject, message: message })
      .then(function(data){
        filledBody = msg.value;   // sent, so there is nothing left to lose
        shut();
        if (data.resendError) {
          toast('Resend refused it, so Brevo sent it to ' + data.to + '. Resend said: ' + data.resendError, true);
        } else {
          toast('Sent to ' + data.to + (data.provider ? ' through ' + data.provider : '') +
            '. A copy is in the shop inbox.');
        }
      })
      .catch(function(err){
        note.textContent = err.message;
        toast(err.message, true);
      })
      .then(function(){
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      });
  });

  /* The same note to the shop inbox. A preview, so a [bracket] left in is fine. */
  testBtn.addEventListener('click', function(){
    if (!ctx) return;
    var subject = subj.value.trim();
    var message = msg.value.trim();
    if (!subject) { note.textContent = 'Give it a subject.'; subj.focus(); return; }
    if (!message) { note.textContent = 'Nothing to send yet.'; msg.focus(); return; }

    note.textContent = '';
    var label = testBtn.textContent;
    testBtn.disabled = true;
    testBtn.textContent = 'Sending\\u2026';

    post('/dashboard/api/customer-mail-test', { token: ctx.token, subject: subject, message: message })
      .then(function(data){
        var said = data.resendError
          ? 'Resend refused it, so Brevo sent the test copy to ' + data.to + '. Resend said: ' + data.resendError
          : 'Test copy sent to ' + data.to + (data.provider ? ' through ' + data.provider : '') +
            '. Nothing went to the customer.';
        note.textContent = said;
        toast(said, !!data.resendError);
      })
      .catch(function(err){
        note.textContent = err.message;
        toast(err.message, true);
      })
      .then(function(){
        testBtn.disabled = false;
        testBtn.textContent = label;
      });
  });
})();
`;
