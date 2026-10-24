/**
 * The dashboard's "Alerts & email" card: is the phone hooked up, who is sending
 * the site's email, and a button to prove each one from here.
 *
 * Routes (wired in index.js, behind the login)
 *   POST /dashboard/api/alerts/push-test   one test push to the shop's phone
 *   POST /dashboard/api/alerts/mail-test   one test email to the shop inbox
 *
 * The test email says which service carried it. That is the point of it:
 * while Resend's domain is still verifying, every send quietly falls through
 * to Brevo, and nothing else on the site would show that.
 */

import { esc, json } from './lib.js';
import { sendMail, mailerConfigured, mailProvider, UNSUBSCRIBE_TO } from './mailer.js';
import { push, pushConfigured, testPush } from './pushover.js';

/** What the card needs to know, read off the Worker's secrets. */
export function alertsState(env) {
  return {
    push: pushConfigured(env),
    mail: mailerConfigured(env) ? mailProvider(env) : '',
    backup: Boolean(env.RESEND_API_KEY && env.BREVO_KEY),
  };
}

export function renderAlertsCard({ push: pushOn = false, mail = '', backup = false } = {}) {
  const pushPill = pushOn
    ? '<span class="pill good">on</span>'
    : '<span class="pill warn">not set up</span>';
  const pushHint = pushOn
    ? 'Pushover. New orders and contact-form inquiries buzz your phone. Quiet hours are set in the Pushover app.'
    : 'Pushover. Set PUSHOVER_TOKEN and PUSHOVER_USER on the Worker and new orders and inquiries will buzz your phone.';

  const mailPill = mail === 'Resend'
    ? '<span class="pill good">Resend</span>'
    : mail === 'Brevo'
      ? '<span class="pill done">Brevo</span>'
      : '<span class="pill bad">off</span>';
  const mailHint = !mail
    ? 'Nothing can send. See worker/mailer.js for the secrets it needs.'
    : (mail === 'Resend'
      ? (backup ? 'Brevo takes over if Resend refuses one. ' : '')
      : 'Resend is not set up yet; set RESEND_API_KEY to switch. ') +
      'Sign-in codes, inquiries, cart recovery, the shipped email and the to-do list. ' +
      'Snipcart&rsquo;s own order emails are separate and do not change.';

  return `<section id="alerts" class="card">
    <div class="cardhead">
      <h2>Alerts &amp; email</h2>
      <span class="cardnote">how the site reaches you</span>
    </div>
    <div class="alertrow">
      <div>
        <b>Phone alerts</b> ${pushPill}
        <p class="hint">${pushHint}</p>
      </div>
      <button type="button" class="btn ghost" id="pushtest"${pushOn ? '' : ' disabled'}>Send a test push</button>
    </div>
    <div class="alertrow">
      <div>
        <b>Site email</b> ${mailPill}
        <p class="hint">${mailHint}</p>
      </div>
      <button type="button" class="btn ghost" id="mailtest"${mail ? '' : ' disabled'}>Send a test email</button>
    </div>
  </section>`;
}

export async function handlePushTest(env, now = new Date()) {
  if (!pushConfigured(env)) {
    return json({ error: 'Pushover is not set up. Set PUSHOVER_TOKEN and PUSHOVER_USER on the Worker.' }, 400);
  }
  const result = await push(env, testPush(now));
  if (!result.sent) return json({ error: 'Pushover would not take it: ' + result.reason }, 502);
  return json({ ok: true });
}

export async function handleMailTest(env, now = new Date()) {
  if (!mailerConfigured(env)) return json({ error: 'Email is not set up on the Worker.' }, 400);

  const when = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const said = `Test from the dashboard, ${when} ET. If this landed, the website can email you and your customers.`;
  try {
    const result = await sendMail(env, {
      to: UNSUBSCRIBE_TO,
      subject: 'Test email from the website',
      html: `<p>${esc(said)}</p>`,
      text: said,
      transactional: true,
    });
    return json({
      ok: true,
      to: UNSUBSCRIBE_TO,
      provider: result.provider || '',
      resendError: result.resendError || '',
    });
  } catch (err) {
    return json({ error: 'It would not send: ' + err.message }, 502);
  }
}

/* ----------------------------------------------------------------- client */

export const ALERTS_STYLES = `
.alertrow{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;
  padding:12px 0;border-bottom:1px solid var(--line)}
.alertrow:last-child{border-bottom:0;padding-bottom:0}
.alertrow .hint{margin:6px 0 0}
.alertrow .btn{flex:none}
@media (max-width:640px){.alertrow{flex-direction:column;gap:10px}}
`;

export const ALERTS_SCRIPT = `
(function(){
  var pushBtn = document.getElementById('pushtest');
  var mailBtn = document.getElementById('mailtest');
  if (!pushBtn && !mailBtn) return;

  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg, bad){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, 8000);
  }
  function post(path){
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
      body: '{}'
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }
  function wire(btn, path, done){
    if (!btn) return;
    btn.addEventListener('click', function(){
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending\\u2026';
      post(path).then(done).catch(function(err){
        toast(err.message, true);
      }).finally(function(){ btn.disabled = false; btn.textContent = label; });
    });
  }

  wire(pushBtn, '/dashboard/api/alerts/push-test', function(){
    toast('Sent. Check your phone.');
  });
  wire(mailBtn, '/dashboard/api/alerts/mail-test', function(data){
    if (data.resendError) {
      toast('Resend refused it, so Brevo sent it to ' + data.to + '. Resend said: ' + data.resendError, true);
    } else {
      toast('Sent through ' + (data.provider || 'the mailer') + ' to ' + data.to + '.');
    }
  });
})();
`;
