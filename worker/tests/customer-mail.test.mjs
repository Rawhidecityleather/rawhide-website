/**
 * A note to one customer, from the order's row on the dashboard.
 *
 * The checks that matter most are the two promises in customer-mail.js: the
 * address comes off the order and nowhere else, and a copy reaches the shop
 * inbox. After that, the form's own guards — a blank note, a subject with a
 * line break in it — and that whatever the shop types cannot break out of the
 * email's HTML.
 */

import { suite, check } from './harness.mjs';
import {
  STARTERS, starterFor, fillStarter, itemList, mailContext, checkDraft, messageHtml,
  customerHtml, customerText, sendCustomerEmail, sendTestCustomerEmail, mailButton, renderMailDialog,
  CUSTOMER_MAIL_SCRIPT, SUBJECT_MAX, MESSAGE_MAX,
} from '../customer-mail.js';
import { analyze, renderDashboard } from '../dashboard.js';
import { REVIEW_URL, sendShippedEmail } from '../shipped-mail.js';
import worker from '../index.js';

function order(over = {}) {
  return {
    token: 'tok-aaaaaaaa',
    invoiceNumber: 'RCL-1042',
    email: 'jane@example.com',
    creationDate: '2026-08-04T14:00:00Z',
    status: 'Processed',
    paymentStatus: 'Paid',
    grandTotal: 162,
    currency: 'usd',
    shippingAddress: { fullName: 'Jane Doe', city: 'Lakeland', province: 'FL' },
    items: [
      { id: 'basic-radio-strap', name: 'Basic Radio Strap', quantity: 1, totalPrice: 120 },
      { id: 'helmet-band', name: 'Helmet Band', quantity: 2, totalPrice: 42 },
    ],
    ...over,
  };
}

const DRAFT = {
  subject: 'Your Rawhide City Leather order RCL-1042',
  message: 'Hey Jane,\n\nQuick update on your order.\nIt ships Friday.\n\nThanks,\nRawhide City Leather',
};

const BASE = {
  RECOVERY_FROM: 'orders@rawhidecityleather.com',
  RECOVERY_POSTAL_ADDRESS: 'PO Box 1, Lakeland FL',
};

/** One fake for every outside service, recording each call with its parsed body. */
function fakeNet(answers = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const host = new URL(String(url)).hostname;
    let body = init.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* leave it */ } }
    calls.push({ host, url: String(url), method: init.method || 'GET', headers: init.headers || {}, body });
    const answer = answers[host];
    if (!answer) throw new Error('unexpected fetch: ' + url);
    return answer();
  };
  return { fetch, calls, to: (host) => calls.filter((c) => c.host === host) };
}

const brevoOk = () => new Response('{"messageId":"<abc@brevo>"}', { status: 201 });
const resendOk = () => new Response('{"id":"re_123"}', { status: 200 });

async function withFetch(fake, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}

async function rejects(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}

export default async function run() {
  suite('customer mail — the starters');

  check('every starter has a key, a label, a subject and a body',
    STARTERS.length >= 4 && STARTERS.every((s) => s.key && s.label && s.subject && s.body));
  check('and no two share a key', new Set(STARTERS.map((s) => s.key)).size === STARTERS.length);
  check('the first one is the blank, so the form opens on it', STARTERS[0].key === 'blank');

  const blank = fillStarter(starterFor('blank'), { first: 'Jane', order: 'RCL-1042' });
  check('blank greets by first name and leaves the rest to the shop',
    blank.body === 'Hey Jane,\n\n', JSON.stringify(blank.body));
  check('with the order number in the subject',
    blank.subject === 'Your Rawhide City Leather order RCL-1042', blank.subject);

  const nameless = fillStarter(starterFor('update'), { first: '', order: 'RCL-1042' });
  check('no first name reads "Hey," not "Hey ,"',
    nameless.body.startsWith('Hey,\n') && !nameless.body.includes('Hey ,'), JSON.stringify(nameless.body.slice(0, 12)));
  const unnumbered = fillStarter(starterFor('blank'), { first: 'Jane', order: '' });
  check('no order number leaves no trailing space in the subject',
    unnumbered.subject === 'Your Rawhide City Leather order', JSON.stringify(unnumbered.subject));
  check('nothing unfilled survives', () => {
    const all = STARTERS.map((s) => fillStarter(s, { first: 'Jane', order: 'RCL-1' }));
    return all.every((f) => !/\{(first|order)\}/.test(f.subject + f.body));
  });
  check("the ones that need the shop's own words say so in brackets",
    /\[[^\]]+\]/.test(starterFor('behind').body) && /\[[^\]]+\]/.test(starterFor('question').body));
  check('and the ones that do not can go as they are',
    ['update', 'soon', 'holding'].every((k) => !/\[/.test(starterFor(k).body)));
  check('the follow-up asks for a review at the form that knows why they came',
    starterFor('holding').body.includes(REVIEW_URL));
  check('an unknown key falls back to blank', starterFor('nope').key === 'blank');

  suite('customer mail — who it is to');

  const ctx = mailContext(order());
  check('token, address, name and number come off the order',
    ctx.token === 'tok-aaaaaaaa' && ctx.email === 'jane@example.com' && ctx.name === 'Jane Doe'
    && ctx.first === 'Jane' && ctx.order === 'RCL-1042', JSON.stringify(ctx));
  check('the items read as one line, quantities only when above one',
    ctx.items === 'Basic Radio Strap, 2 × Helmet Band', ctx.items);
  check('an order with no items has an empty line, not "undefined"', itemList({}) === '');
  check('a padded address is trimmed',
    mailContext(order({ email: '  jane@example.com ' })).email === 'jane@example.com');
  check('with no name the billing address is tried before giving up', () => {
    const c = mailContext(order({ shippingAddress: null, billingAddress: { fullName: 'J Doe' } }));
    return c.name === 'J Doe' && c.first === 'J';
  });

  suite('customer mail — the draft');

  check('no subject is refused', /subject/i.test(checkDraft({ subject: ' ', message: 'x' }).error || ''));
  check('no message is refused', /message/i.test(checkDraft({ subject: 'Hi', message: '  \n ' }).error || ''));
  check('a subject cannot carry a line break',
    checkDraft({ subject: 'Hi\r\nBcc: x', message: 'x' }).subject === 'Hi Bcc: x',
    JSON.stringify(checkDraft({ subject: 'Hi\r\nBcc: x', message: 'x' }).subject));
  check('an over-long subject is refused',
    Boolean(checkDraft({ subject: 'x'.repeat(SUBJECT_MAX + 1), message: 'x' }).error));
  check('an over-long message is refused, and says how long is allowed', () => {
    const r = checkDraft({ subject: 'Hi', message: 'x'.repeat(MESSAGE_MAX + 1) });
    return Boolean(r.error) && r.error.includes(String(MESSAGE_MAX));
  });
  check('one at the cap still goes',
    !checkDraft({ subject: 'Hi', message: 'x'.repeat(MESSAGE_MAX) }).error);
  check('Windows line endings are normalised and the ends trimmed',
    checkDraft({ subject: ' Hi ', message: '\r\nline one\r\nline two\r\n' }).message === 'line one\nline two');
  check('a missing body does not crash it', Boolean(checkDraft(undefined).error));

  suite('customer mail — what the customer sees');

  const html = customerHtml(order(), DRAFT);
  check('the note is in it', html.includes('Quick update on your order.'));
  check('a blank line starts a new paragraph, a single newline breaks the line',
    (html.match(/<p /g) || []).length >= 4 && html.includes('order.<br>It ships Friday.'));
  check('the order number and the items are shown back',
    html.includes('Order RCL-1042') && html.includes('Basic Radio Strap') && html.includes('2 × Helmet Band'));
  check('and the day it was placed', html.includes('Placed Aug 4, 2026'));
  check('no tracking line when there is no tracking', !/track\?num=/.test(html));
  check('the tracking link appears once there is a number',
    customerHtml(order({ trackingNumber: '9400111899223197428490' }), DRAFT)
      .includes('rawhidecityleather.com/track?num=9400111899223197428490'));
  check('replies are pointed back at the shop', /reply to this email/i.test(html));
  check('it carries no unsubscribe link — this is not marketing', !/unsubscribe/i.test(html));
  check('the inbox preview is the note itself, not boilerplate',
    html.includes('Hey Jane, Quick update on your order.'));

  check('what the shop types cannot break out of the page', () => {
    const nasty = customerHtml(order(), { ...DRAFT, message: 'Hi <script>alert(1)</script> & <b>bold</b>' });
    return !nasty.includes('<script>') && nasty.includes('&lt;script&gt;') && nasty.includes('&amp; &lt;b&gt;');
  });
  check('a name with HTML in it cannot either', () => {
    const nasty = customerHtml(order({ shippingAddress: { fullName: '<img src=x onerror=alert(1)>' } }), DRAFT);
    return !nasty.includes('<img src=x');
  });
  check('an item name with HTML in it cannot either', () => {
    const nasty = customerHtml(order({ items: [{ name: '<script>x</script>', quantity: 1 }] }), DRAFT);
    return !nasty.includes('<script>x');
  });
  check('a web address becomes a link, with the full stop left outside it', () => {
    const out = messageHtml('Track it at https://rawhidecityleather.com/track?num=1&x=2.');
    return out.includes('href="https://rawhidecityleather.com/track?num=1&amp;x=2"')
      && out.includes('</a>.');
  });
  check('but a javascript: address does not', !messageHtml('javascript:alert(1)').includes('href'));
  check('a quote inside a link cannot escape the attribute', () => {
    const out = messageHtml('https://x.com/a"onmouseover="alert(1)');
    return !out.includes('"onmouseover') && !out.includes('href="https://x.com/a"onmouseover');
  });

  const text = customerText(order(), DRAFT);
  check('the plain-text copy is the note as typed', text.startsWith(DRAFT.message));
  check('followed by the order line and the items',
    text.includes('Order RCL-1042, placed Aug 4, 2026') && text.includes('2 × Helmet Band'));
  check('and the reply line', /reply to this email/i.test(text));
  check('with no HTML in it', !/<[a-z]/i.test(text));
  check('the tracking line rides in the text copy too',
    customerText(order({ trackingNumber: '9400111899223197428490' }), DRAFT)
      .includes('Tracking 9400111899223197428490: https://rawhidecityleather.com/track?num=9400111899223197428490'));

  suite('customer mail — sending');

  {
    const net = fakeNet({ 'api.brevo.com': brevoOk });
    const result = await withFetch(net.fetch, () =>
      sendCustomerEmail({ ...BASE, BREVO_KEY: 'b' }, order(), DRAFT));
    const call = net.to('api.brevo.com')[0];
    check('it goes out once, through the mailer', net.calls.length === 1 && Boolean(call));
    check('to the address on the order', call.body.to[0].email === 'jane@example.com');
    check("with a copy BCC'd to the shop inbox",
      call.body.bcc?.[0]?.email === 'rawhidecityleather@gmail.com', JSON.stringify(call.body.bcc));
    check('from the storefront domain', call.body.sender.email === 'orders@rawhidecityleather.com');
    check('replies land in the shop inbox', call.body.replyTo.email === 'rawhidecityleather@gmail.com');
    check('with the subject as typed', call.body.subject === DRAFT.subject);
    check('both the html and the text part go',
      (call.body.htmlContent || '').includes('A note about your order') && call.body.textContent.startsWith(DRAFT.message));
    check('and no List-Unsubscribe header, because it is transactional', !call.body.headers);
    check('the result says where it went and where the copy is',
      result.to === 'jane@example.com' && result.copy === 'rawhidecityleather@gmail.com' && result.provider === 'Brevo');
  }

  {
    const net = fakeNet({ 'api.resend.com': resendOk });
    await withFetch(net.fetch, () =>
      sendCustomerEmail({ ...BASE, RESEND_API_KEY: 'k' }, order(), DRAFT));
    const call = net.to('api.resend.com')[0];
    check('through Resend the copy rides as bcc too',
      Array.isArray(call.body.bcc) && call.body.bcc[0] === 'rawhidecityleather@gmail.com'
      && call.body.to[0] === 'jane@example.com', JSON.stringify(call.body.bcc));
  }

  {
    // The bcc only goes when a caller asks for it: the shipped email, the
    // sign-in code and the rest must not start copying the inbox on every send.
    const net = fakeNet({ 'api.resend.com': resendOk, 'api.brevo.com': brevoOk });
    await withFetch(net.fetch, () => sendShippedEmail({ ...BASE, RESEND_API_KEY: 'k' }, order(), '9400111899223197428490'));
    await withFetch(net.fetch, () => sendShippedEmail({ ...BASE, BREVO_KEY: 'b' }, order(), '9400111899223197428490'));
    check('mail that asks for no copy gets none, on either provider',
      net.calls.length === 2 && net.calls.every((c) => !('bcc' in c.body)),
      net.calls.map((c) => Object.keys(c.body).join('+')).join(' | '));
  }

  {
    const net = fakeNet({ 'api.brevo.com': brevoOk });
    const err = await rejects(() => withFetch(net.fetch, () =>
      sendCustomerEmail({ ...BASE, BREVO_KEY: 'b' }, order({ email: '' }), DRAFT)));
    check('an order with no address is refused, not sent to nobody',
      /no email address/i.test(err?.message || '') && net.calls.length === 0, err?.message);
  }

  {
    const net = fakeNet({ 'api.brevo.com': brevoOk });
    const err = await rejects(() => withFetch(net.fetch, () =>
      sendCustomerEmail({ ...BASE }, order(), DRAFT)));
    check('with no mail credentials it says so instead of pretending',
      /not configured/i.test(err?.message || ''), err?.message);
  }

  {
    const net = fakeNet({ 'api.brevo.com': brevoOk });
    const err = await rejects(() => withFetch(net.fetch, () =>
      sendCustomerEmail({ ...BASE, BREVO_KEY: 'b' }, order(), { subject: 'Hi', message: '   ' })));
    check('a blank note never reaches the provider',
      /no message/i.test(err?.message || '') && net.calls.length === 0, err?.message);
  }

  {
    const net = fakeNet({
      'api.brevo.com': () => new Response('{"message":"nope"}', { status: 400, statusText: 'Bad Request' }),
    });
    const err = await rejects(() => withFetch(net.fetch, () =>
      sendCustomerEmail({ ...BASE, BREVO_KEY: 'b' }, order(), DRAFT)));
    check("a provider error is surfaced, carrying the provider's own words",
      /400/.test(err?.message || '') && /nope/.test(err?.message || ''), err?.message);
  }

  suite('customer mail — the test copy');

  {
    const net = fakeNet({ 'api.brevo.com': brevoOk });
    const result = await withFetch(net.fetch, () =>
      sendTestCustomerEmail({ ...BASE, BREVO_KEY: 'b' }, order(), DRAFT));
    const call = net.to('api.brevo.com')[0];
    check('it goes to the shop, never the customer',
      call.body.to.length === 1 && call.body.to[0].email === 'rawhidecityleather@gmail.com'
      && !JSON.stringify(call.body.to).includes('jane@'), JSON.stringify(call.body.to));
    check('and says it is a test in the subject', call.body.subject === '[test] ' + DRAFT.subject, call.body.subject);
    check('with no bcc, the inbox being the recipient already', !('bcc' in call.body));
    check('but the full note as the customer would see it, order and all',
      (call.body.htmlContent || '').includes('Quick update on your order.')
      && call.body.htmlContent.includes('Order RCL-1042') && call.body.textContent.startsWith(DRAFT.message));
    check('the result names the shop inbox', result.to === 'rawhidecityleather@gmail.com' && !result.copy);
  }
  {
    const net = fakeNet({ 'api.brevo.com': brevoOk });
    const err = await rejects(() => withFetch(net.fetch, () =>
      sendTestCustomerEmail({ ...BASE, BREVO_KEY: 'b' }, order(), { subject: 'Hi', message: '' })));
    check('a blank test copy is refused the same way', /no message/i.test(err?.message || '') && net.calls.length === 0);
  }

  suite('customer mail — on the dashboard');

  const btn = mailButton(order());
  check('the button carries everything the form shows',
    btn.includes('data-token="tok-aaaaaaaa"') && btn.includes('data-email="jane@example.com"')
    && btn.includes('data-name="Jane Doe"') && btn.includes('data-first="Jane"')
    && btn.includes('data-order="RCL-1042"')
    && btn.includes('data-items="Basic Radio Strap, 2 × Helmet Band"'), btn);
  check('and is a plain button, not a mailto link', btn.startsWith('<button') && !btn.includes('mailto:'));
  check('an order with no email gets no button', mailButton(order({ email: '' })) === '');
  check('a name with a quote in it cannot break the attribute',
    !mailButton(order({ shippingAddress: { fullName: 'Jane "JD" Doe' } })).includes('"JD"'));
  check('with no mailer the button is there but dead, and says why',
    /<button[^>]* disabled/.test(mailButton(order(), { ready: false }))
    && /Alerts/.test(mailButton(order(), { ready: false })));

  const dialog = renderMailDialog();
  check('the dialog offers every starter',
    STARTERS.every((s) => dialog.includes(`<option value="${s.key}">`)));
  check('its fields carry the same caps the Worker enforces',
    dialog.includes(`maxlength="${SUBJECT_MAX}"`) && dialog.includes(`maxlength="${MESSAGE_MAX}"`));
  check('it says where the copy goes', /copy lands in the shop inbox/i.test(dialog));
  check('and offers a test copy to the shop inbox', dialog.includes('id="mailtestcopy"'));
  check('every field has a label', () => {
    const labelled = (dialog.match(/<label class="qfield">\s*<span>[^<]+<\/span>\s*<(select|input|textarea)/g) || []).length;
    return labelled === 3;
  });

  const board = renderDashboard(analyze([order()], 'all'), {});
  check('the queue row has the button', () => {
    const queue = board.split('<section id="queue"')[1].split('</section>')[0];
    return queue.includes('class="btn tiny ghost cmail"') && queue.includes('data-token="tok-aaaaaaaa"');
  });
  check('so does the All orders row', () => {
    const orders = board.split('<section id="orders"')[1].split('</section>')[0];
    return orders.includes('class="btn tiny ghost cmail"');
  });
  check('and the dialog is on the page once', (board.match(/<dialog id="maildlg"/g) || []).length === 1);
  check('with the mailer off every button is dead', () => {
    const off = renderDashboard(analyze([order()], 'all'), { mailReady: false });
    const buttons = off.match(/<button[^>]*class="btn tiny ghost cmail"[^>]*>/g) || [];
    return buttons.length === 2 && buttons.every((b) => / disabled/.test(b));
  });
  check('a shipped order keeps its button in All orders — a note is not only for open work', () => {
    const done = renderDashboard(analyze([order({ status: 'Shipped' })], 'all'), {});
    const orders = done.split('<section id="orders"')[1].split('</section>')[0];
    return orders.includes('class="btn tiny ghost cmail"');
  });

  let scriptOk = true;
  try { new Function(CUSTOMER_MAIL_SCRIPT); } catch (err) { scriptOk = err.message; }
  check('the dialog script parses', scriptOk === true, String(scriptOk));
  check('and the starters ride inside it without a closing script tag',
    CUSTOMER_MAIL_SCRIPT.includes('"key":"blank"') && !/<\/script/i.test(CUSTOMER_MAIL_SCRIPT));
  check('the script posts to the routes the Worker answers',
    CUSTOMER_MAIL_SCRIPT.includes("'/dashboard/api/customer-mail'")
    && CUSTOMER_MAIL_SCRIPT.includes("'/dashboard/api/customer-mail-test'"));

  suite('customer mail — through the Worker');

  const env = {
    SNIPCART_SECRET: 'test-key-never-used',
    SLIP_USER: 'dev',
    SLIP_PASS: 'dev',
    BREVO_KEY: 'b',
    ...BASE,
    ASSETS: { fetch: async () => new Response('the 404 page', { status: 404 }) },
  };
  const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
  const DASH = { Authorization: AUTH, 'x-rawhide-dashboard': '1' };
  const ORIGIN = 'https://rawhidecityleather.com';
  const postTo = (path, body, headers = {}) => worker.fetch(new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), env);
  const post = (body, headers = {}) => postTo('/dashboard/api/customer-mail', body, headers);
  const GOOD = { token: 'tok-aaaaaaaa', ...DRAFT };

  check('it demands a login', (await post(GOOD)).status === 401);
  check('a logged-in POST without the dashboard header is refused',
    (await post(GOOD, { Authorization: AUTH })).status === 403);

  {
    const net = fakeNet({});
    const res = await withFetch(net.fetch, () => post({ ...GOOD, token: 'nope' }, DASH));
    check('a bad token is refused before anything is fetched',
      res.status === 400 && net.calls.length === 0);
  }
  {
    const net = fakeNet({});
    const res = await withFetch(net.fetch, () => post({ ...GOOD, message: '' }, DASH));
    const data = await res.json();
    check('so is a blank note',
      res.status === 400 && /message/i.test(data.error || '') && net.calls.length === 0, JSON.stringify(data));
  }
  {
    const net = fakeNet({
      'app.snipcart.com': () => new Response(JSON.stringify(order()), { status: 200 }),
      'api.brevo.com': brevoOk,
    });
    const res = await withFetch(net.fetch, () => post({ ...GOOD, to: 'attacker@example.com' }, DASH));
    const data = await res.json();
    const sent = net.to('api.brevo.com')[0];
    check('a good note is sent to the address on the order, fetched fresh from Snipcart',
      res.status === 200 && data.ok === true && data.to === 'jane@example.com'
      && (net.to('app.snipcart.com')[0]?.url || '').includes('/orders/tok-aaaaaaaa'), JSON.stringify(data));
    check('a "to" smuggled into the body is ignored',
      sent?.body.to[0].email === 'jane@example.com' && !JSON.stringify(sent?.body).includes('attacker'));
    check('and the copy is on it', sent?.body.bcc?.[0]?.email === 'rawhidecityleather@gmail.com');
    check('the answer names the copy and the carrier',
      data.copy === 'rawhidecityleather@gmail.com' && data.provider === 'Brevo');
  }
  {
    const net = fakeNet({
      'app.snipcart.com': () => new Response('', { status: 404, statusText: 'Not Found' }),
    });
    const res = await withFetch(net.fetch, () => post(GOOD, DASH));
    const data = await res.json();
    check('an order Snipcart does not know comes back as a JSON error, not a crash',
      res.status === 502 && /404/.test(data.error || ''), JSON.stringify(data));
  }
  {
    const net = fakeNet({
      'app.snipcart.com': () => new Response(JSON.stringify(order({ email: '' })), { status: 200 }),
    });
    const res = await withFetch(net.fetch, () => post(GOOD, DASH));
    const data = await res.json();
    check('an order with no address is refused and nothing is sent',
      res.status === 502 && /no email address/i.test(data.error || '') && net.to('api.brevo.com').length === 0,
      JSON.stringify(data));
  }
  {
    const net = fakeNet({
      'app.snipcart.com': () => new Response(JSON.stringify(order()), { status: 200 }),
      'api.brevo.com': brevoOk,
    });
    const res = await withFetch(net.fetch, () => postTo('/dashboard/api/customer-mail-test', GOOD, DASH));
    const data = await res.json();
    const sent = net.to('api.brevo.com')[0];
    check('the test route mails the shop inbox and not the customer, even with a real order',
      res.status === 200 && data.ok === true && data.test === true && data.to === 'rawhidecityleather@gmail.com'
      && sent?.body.to[0].email === 'rawhidecityleather@gmail.com' && !JSON.stringify(sent?.body.to).includes('jane@'),
      JSON.stringify(data));
    check('and it demands the dashboard header like the real one',
      (await postTo('/dashboard/api/customer-mail-test', GOOD, { Authorization: AUTH })).status === 403);
  }
}
