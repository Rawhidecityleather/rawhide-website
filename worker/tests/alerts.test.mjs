/**
 * Resend, Pushover, and the dashboard card that tests them.
 *
 * The checks lean on the two promises these make: an email never gets lost
 * because one provider said no (Brevo carries it), and a push never breaks the
 * thing that sent it (an order webhook, a customer's inquiry).
 */

import { suite, check } from './harness.mjs';
import { sendMail, mailerConfigured, mailProvider, MailError } from '../mailer.js';
import { push, pushConfigured, orderPush, inquiryPush, clip } from '../pushover.js';
import { handleInquiry } from '../inquiry.js';
import { renderAlertsCard, alertsState, handlePushTest, handleMailTest } from '../alerts-card.js';
import worker from '../index.js';

const BASE = {
  RECOVERY_FROM: 'orders@rawhidecityleather.com',
  RECOVERY_POSTAL_ADDRESS: 'PO Box 1234, Lakeland, FL 33801',
};
const PUSH = { PUSHOVER_TOKEN: 'app-token-never-used', PUSHOVER_USER: 'user-key-never-used' };

const MESSAGE = { to: 'dana@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

/**
 * One fake for every outside service. `answers` maps a host to a function
 * returning that host's Response; every call is recorded with its parsed body.
 */
function fakeNet(answers = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const host = new URL(String(url)).hostname;
    let body = init.body;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    else if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* leave it */ } }
    calls.push({ host, url: String(url), headers: init.headers || {}, body });
    const answer = answers[host];
    if (!answer) throw new Error('unexpected fetch: ' + url);
    return answer();
  };
  return { fetch, calls, to: (host) => calls.filter((c) => c.host === host) };
}

const resendOk = () => new Response(JSON.stringify({ id: 're_123' }), { status: 200 });
const brevoOk = () => new Response(JSON.stringify({ messageId: '<x@relay.brevo.com>' }), { status: 201 });
const pushOk = () => new Response(JSON.stringify({ status: 1, request: 'req-1' }), { status: 200 });

async function withFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

async function rejects(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}

export default async function run() {
  suite('alerts — choosing the mailer');

  check('Resend alone is enough to send', mailerConfigured({ ...BASE, RESEND_API_KEY: 'k' }));
  check('Brevo alone still is', mailerConfigured({ ...BASE, BREVO_KEY: 'k' }));
  check('neither key means nothing sends', !mailerConfigured({ ...BASE }));
  check('Resend goes first when both are set',
    mailProvider({ RESEND_API_KEY: 'k', BREVO_KEY: 'k' }) === 'Resend');
  check('Brevo when it is the only one', mailProvider({ BREVO_KEY: 'k' }) === 'Brevo');

  suite('alerts — sending through Resend');

  {
    const net = fakeNet({ 'api.resend.com': resendOk });
    const result = await withFetch(net.fetch, () =>
      sendMail({ ...BASE, RESEND_API_KEY: 're_key', BREVO_KEY: 'b' }, { ...MESSAGE, transactional: true }));
    const call = net.to('api.resend.com')[0];
    check('a send goes to Resend and nowhere else',
      net.calls.length === 1 && Boolean(call), net.calls.map((c) => c.host).join());
    check('with the key as a Bearer token', call.headers.authorization === 'Bearer re_key');
    check('from the shop, by name',
      call.body.from === 'Rawhide City Leather <orders@rawhidecityleather.com>', call.body.from);
    check('to the customer', call.body.to[0] === 'dana@example.com');
    check('replies come back to the shop by default',
      call.body.reply_to === 'rawhidecityleather@gmail.com', call.body.reply_to);
    check('both the html and the text part go', call.body.html === '<p>Hi</p>' && call.body.text === 'Hi');
    check('no List-Unsubscribe on transactional mail', !call.body.headers);
    check('it says Resend carried it',
      result.provider === 'Resend' && result.messageId === 're_123' && !result.resendError);
  }

  {
    const net = fakeNet({ 'api.resend.com': resendOk });
    await withFetch(net.fetch, () => sendMail({ ...BASE, RESEND_API_KEY: 'k' }, MESSAGE));
    check('marketing mail carries List-Unsubscribe',
      /Unsubscribe/.test(net.calls[0].body.headers?.['List-Unsubscribe'] || ''));
  }

  {
    const net = fakeNet({ 'api.resend.com': resendOk });
    await withFetch(net.fetch, () => sendMail({ ...BASE, RESEND_API_KEY: 'k' },
      { ...MESSAGE, replyTo: { email: 'dana@example.com', name: 'Reyes, Dana' } }));
    check('a reply-to is the bare address, so a comma in a name cannot split it',
      net.calls[0].body.reply_to === 'dana@example.com', net.calls[0].body.reply_to);
  }

  suite('alerts — Brevo as the backup');

  {
    const net = fakeNet({
      'api.resend.com': () => new Response('{"message":"domain is not verified"}', { status: 403, statusText: 'Forbidden' }),
      'api.brevo.com': brevoOk,
    });
    const result = await withFetch(net.fetch, () =>
      sendMail({ ...BASE, RESEND_API_KEY: 'k', BREVO_KEY: 'b' }, MESSAGE));
    check('Resend refusing it sends it through Brevo instead',
      net.to('api.resend.com').length === 1 && net.to('api.brevo.com').length === 1);
    check('and says so', result.provider === 'Brevo' && /403/.test(result.resendError), result.resendError);
  }

  {
    const net = fakeNet({
      'api.resend.com': () => { throw new TypeError('network down'); },
      'api.brevo.com': brevoOk,
    });
    const result = await withFetch(net.fetch, () =>
      sendMail({ ...BASE, RESEND_API_KEY: 'k', BREVO_KEY: 'b' }, MESSAGE));
    check('Resend unreachable falls through too', result.provider === 'Brevo', JSON.stringify(result));
  }

  {
    const net = fakeNet({ 'api.resend.com': () => new Response('nope', { status: 500 }) });
    const err = await rejects(() => withFetch(net.fetch, () =>
      sendMail({ ...BASE, RESEND_API_KEY: 'k' }, MESSAGE)));
    check('with no Brevo key a Resend failure is a MailError the caller sees',
      err instanceof MailError && /500/.test(err.message), err?.message);
  }

  {
    const net = fakeNet({ 'api.brevo.com': brevoOk });
    const result = await withFetch(net.fetch, () => sendMail({ ...BASE, BREVO_KEY: 'b' }, MESSAGE));
    check('without a Resend key nothing changes: Brevo, as before',
      net.calls.length === 1 && net.calls[0].host === 'api.brevo.com' && result.provider === 'Brevo');
  }

  suite('alerts — Pushover');

  check('both secrets are needed', pushConfigured(PUSH) && !pushConfigured({ PUSHOVER_TOKEN: 'x' }));

  {
    const net = fakeNet({});
    const result = await withFetch(net.fetch, () => push({}, { message: 'hi' }));
    check('unset, nothing is called', net.calls.length === 0 && result.reason === 'not configured');
  }

  {
    const net = fakeNet({ 'api.pushover.net': pushOk });
    const result = await withFetch(net.fetch, () =>
      push(PUSH, { title: 'T', message: 'M', url: 'https://x.test/', urlTitle: 'Go', sound: 'cashregister' }));
    const sent = net.calls[0].body;
    check('a push goes out', result.sent === true && result.id === 'req-1');
    check('carrying the token and user key',
      sent.token === 'app-token-never-used' && sent.user === 'user-key-never-used');
    check('and the title, message, link and sound',
      sent.title === 'T' && sent.message === 'M' && sent.url === 'https://x.test/'
        && sent.url_title === 'Go' && sent.sound === 'cashregister', JSON.stringify(sent));
  }

  {
    const net = fakeNet({ 'api.pushover.net': pushOk });
    await withFetch(net.fetch, () => push(PUSH, { message: 'x'.repeat(5000), title: 'y'.repeat(900) }));
    const sent = net.calls[0].body;
    check('an over-long message is cut to Pushover\'s limit, not refused',
      [...sent.message].length === 1024 && [...sent.title].length === 250);
  }

  {
    const net = fakeNet({ 'api.pushover.net': pushOk });
    await withFetch(net.fetch, () => push(PUSH, { message: '   ' }));
    check('an empty message still says something', net.calls[0].body.message === '(no details)');
  }

  check('clip never splits an emoji', clip('🔥🔥🔥', 2) === '🔥…');

  {
    const net = fakeNet({
      'api.pushover.net': () => new Response(JSON.stringify({ status: 0, errors: ['user identifier is invalid'] }), { status: 400 }),
    });
    const result = await withFetch(net.fetch, () => push(PUSH, { message: 'hi' }));
    check('a refusal is reported, not thrown',
      result.sent === false && /user identifier/.test(result.reason), result.reason);
  }

  {
    const net = fakeNet({ 'api.pushover.net': () => { throw new TypeError('offline'); } });
    const result = await withFetch(net.fetch, () => push(PUSH, { message: 'hi' }));
    check('an outage is reported, not thrown', result.sent === false && result.reason === 'offline');
  }

  suite('alerts — what the pushes say');

  const ORDER = {
    invoiceNumber: 'SNIP-1040',
    grandTotal: 180,
    currency: 'usd',
    items: [{ name: 'Custom Radio Strap', quantity: 1 }, { name: 'Leather Butter', quantity: 2 }],
    shippingAddress: { fullName: 'Dana Reyes', address1: '12 Engine Way', city: 'Tampa', province: 'FL' },
  };
  const op = orderPush(ORDER);
  check('an order push leads with the invoice and the total',
    op.title === 'New order · SNIP-1040 · $180.00', op.title);
  check('one line per item, with the count',
    op.message.includes('1 × Custom Radio Strap') && op.message.includes('2 × Leather Butter'), op.message);
  check('who and where, without the street address',
    op.message.includes('Dana Reyes · Tampa, FL') && !op.message.includes('Engine Way'));
  check('it opens the ship queue', op.url.endsWith('/dashboard#queue'));
  check('an order with nothing on it still builds', typeof orderPush({}).title === 'string');

  const INQ = {
    type: 'Custom build', name: 'Dana Reyes', email: 'dana@example.com',
    department: 'Station 12', neededBy: 'Oct 3', details: 'Fully custom strap.', photo: null,
  };
  const ip = inquiryPush(INQ);
  check('an inquiry push names the kind and the person',
    ip.title === 'New inquiry: Custom build — Dana Reyes', ip.title);
  check('with the details', ip.message.includes('Station 12 · need by Oct 3') && ip.message.includes('Fully custom strap.'));
  const failedPush = inquiryPush(INQ, { emailed: false });
  check('a failed email says so and carries the reply address',
    /NOT emailed/.test(failedPush.title) && failedPush.message.includes('dana@example.com'));
  check('and it is louder', failedPush.priority === 1 && !ip.priority);

  suite('alerts — the contact form pushes');

  const FORM = new URLSearchParams({
    'fields[inquiry_type]': 'Custom build',
    'fields[first_name]': 'Dana Reyes',
    email_address: 'dana@example.com',
    'fields[details]': 'Fully custom strap, black, red stitch.',
  }).toString();
  const inquiryRequest = () => new Request('https://rawhidecityleather.com/api/inquiry', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: FORM,
  });

  {
    const net = fakeNet({ 'api.resend.com': resendOk, 'api.pushover.net': pushOk });
    const res = await withFetch(net.fetch, () =>
      handleInquiry(inquiryRequest(), { ...BASE, RESEND_API_KEY: 'k', ...PUSH }));
    check('a good inquiry is emailed and pushed',
      res.status === 200 && net.to('api.resend.com').length === 1 && net.to('api.pushover.net').length === 1);
    check('the push is the good-news one', /^New inquiry/.test(net.to('api.pushover.net')[0].body.title));
  }

  {
    const net = fakeNet({
      'api.resend.com': () => new Response('down', { status: 503 }),
      'api.pushover.net': pushOk,
    });
    const err = await rejects(() => withFetch(net.fetch, () =>
      handleInquiry(inquiryRequest(), { ...BASE, RESEND_API_KEY: 'k', ...PUSH })));
    const sent = net.to('api.pushover.net')[0]?.body || {};
    check('when the email fails the push still goes, and says it failed',
      /NOT emailed/.test(sent.title || '') && sent.message.includes('dana@example.com'), sent.title);
    check('and the page still hears about the failure, so it offers mailto', err instanceof MailError);
  }

  {
    const net = fakeNet({
      'api.resend.com': resendOk,
      'api.pushover.net': () => new Response('{"status":0}', { status: 500 }),
    });
    const res = await withFetch(net.fetch, () =>
      handleInquiry(inquiryRequest(), { ...BASE, RESEND_API_KEY: 'k', ...PUSH }));
    check('a push failure never fails the customer\'s inquiry', res.status === 200);
  }

  suite('alerts — the order webhook pushes');

  const hook = (event) => new Request('https://rawhidecityleather.com/dashboard/hooks/snipcart', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Snipcart-RequestToken': 'tok' },
    body: JSON.stringify(event),
  });
  const hookEnv = { SNIPCART_SECRET: 'never-used', ...PUSH };
  const snipcartOk = () => new Response('{}', { status: 200 });

  {
    const net = fakeNet({ 'app.snipcart.com': snipcartOk, 'api.pushover.net': pushOk });
    const res = await withFetch(net.fetch, () =>
      worker.fetch(hook({ eventName: 'order.completed', mode: 'Live', content: ORDER }), hookEnv));
    const sent = net.to('api.pushover.net')[0]?.body || {};
    check('a live order pushes', res.status === 200 && /SNIP-1040/.test(sent.title || ''), sent.title);
    check('with the register sound', sent.sound === 'cashregister');
  }

  {
    const net = fakeNet({ 'app.snipcart.com': snipcartOk, 'api.pushover.net': pushOk });
    await withFetch(net.fetch, () =>
      worker.fetch(hook({ eventName: 'order.completed', mode: 'Test', content: ORDER }), hookEnv));
    check('a test-mode order does not', net.to('api.pushover.net').length === 0);
  }

  {
    const net = fakeNet({
      'app.snipcart.com': snipcartOk,
      'api.pushover.net': () => new Response('{"status":0,"errors":["bad"]}', { status: 400 }),
    });
    const res = await withFetch(net.fetch, () =>
      worker.fetch(hook({ eventName: 'order.completed', mode: 'Live', content: ORDER }), hookEnv));
    check('a push failure never makes Snipcart retry the order', res.status === 200, String(res.status));
  }

  {
    const net = fakeNet({ 'app.snipcart.com': snipcartOk, 'api.pushover.net': pushOk });
    await withFetch(net.fetch, () => worker.fetch(hook({
      eventName: 'order.trackingNumber.changed', content: { token: 't', status: 'Shipped' },
    }), hookEnv));
    check('a tracking update does not push', net.to('api.pushover.net').length === 0);
  }

  suite('alerts — the dashboard card');

  const on = renderAlertsCard(alertsState({ ...BASE, RESEND_API_KEY: 'k', BREVO_KEY: 'b', ...PUSH }));
  check('all set: phone on, Resend sending, Brevo named as the backup',
    on.includes('pill good">on') && on.includes('pill good">Resend') && on.includes('Brevo takes over'));
  check('both test buttons live', !/id="pushtest" disabled/.test(on) && !/id="mailtest" disabled/.test(on));

  const brevoOnly = renderAlertsCard(alertsState({ ...BASE, BREVO_KEY: 'b' }));
  check('before the switch it says Brevo and how to move',
    brevoOnly.includes('pill done">Brevo') && brevoOnly.includes('RESEND_API_KEY'));
  check('and the push button is off until Pushover is set up', /id="pushtest" disabled/.test(brevoOnly));

  const nothing = renderAlertsCard(alertsState({}));
  check('with no mail secrets it says off and the email button is dead',
    nothing.includes('pill bad">off') && /id="mailtest" disabled/.test(nothing));

  {
    const net = fakeNet({ 'api.pushover.net': pushOk });
    const res = await withFetch(net.fetch, () => handlePushTest(PUSH));
    check('the test push button sends one push', res.status === 200 && net.calls.length === 1);
  }

  {
    const res = await handlePushTest({});
    check('and explains itself when Pushover is not set up', res.status === 400);
  }

  {
    const net = fakeNet({
      'api.resend.com': () => new Response('{"message":"domain is not verified"}', { status: 403 }),
      'api.brevo.com': brevoOk,
    });
    const res = await withFetch(net.fetch, () =>
      handleMailTest({ ...BASE, RESEND_API_KEY: 'k', BREVO_KEY: 'b' }));
    const data = await res.json();
    check('the test email says Brevo carried it and why Resend did not',
      data.ok && data.provider === 'Brevo' && /not verified/.test(data.resendError), JSON.stringify(data));
    check('and it went to the shop inbox, not a customer',
      net.to('api.brevo.com')[0].body.to[0].email === 'rawhidecityleather@gmail.com');
  }

  {
    const net = fakeNet({ 'api.resend.com': () => new Response('no', { status: 401 }) });
    const res = await withFetch(net.fetch, () => handleMailTest({ ...BASE, RESEND_API_KEY: 'k' }));
    check('a test email nobody would carry is a 502 with the reason', res.status === 502);
  }

  {
    const res = await worker.fetch(new Request('https://rawhidecityleather.com/dashboard/api/alerts/push-test', {
      method: 'POST', body: '{}',
    }), { SNIPCART_SECRET: 'x', SLIP_USER: 'u', SLIP_PASS: 'p', ...PUSH });
    check('the test routes sit behind the dashboard login', res.status === 401, String(res.status));
  }
}
