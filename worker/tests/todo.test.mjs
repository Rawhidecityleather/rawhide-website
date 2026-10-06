/**
 * The LWFD to-do list: the record and every action on it, the due-date words,
 * the email, the cron step's every reason not to send, the card, and both
 * routes through the real Worker with a KV shim and a stubbed Brevo.
 */

import { suite, check, throws } from './harness.mjs';
import worker from '../index.js';
import {
  emptyTodos, normalise, applyAction, openItems, sortItems, dueState, dueWords, dueLabel,
  hourLabel, localHour, todoEmail, runTodoMail, renderTodoCard, renderTodoList,
  renderMailState, TodoError, TEXT_MAX, ITEMS_MAX, DEFAULT_HOUR, TODO_KEY,
} from '../todo.js';
import { renderDashboard, analyze } from '../dashboard.js';
import { UNSUBSCRIBE_TO } from '../mailer.js';

// Tue Oct 6 2026, 11:00Z = 7:00 am Eastern (EDT).
const NOW = Date.parse('2026-10-06T11:00:00Z');
const TODAY = '2026-10-06';

function makeKV() {
  const store = new Map();
  return {
    async put(key, value) { store.set(key, value); },
    async get(key, opts) {
      const v = store.get(key) ?? null;
      return v !== null && opts?.type === 'json' ? JSON.parse(v) : v;
    },
    _store: store,
  };
}

/** Brevo, as far as mailer.js uses it. Records every send; `fail` makes it 500. */
function stubBrevo() {
  const real = globalThis.fetch;
  const api = { sent: [], fail: false };
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).includes('api.brevo.com')) return real(url, init);
    const body = JSON.parse(init.body);
    if (api.fail) return new Response('nope', { status: 500, statusText: 'Server Error' });
    api.sent.push(body);
    return new Response(JSON.stringify({ messageId: 'm' + api.sent.length }), {
      status: 201, headers: { 'content-type': 'application/json' },
    });
  };
  api.restore = () => { globalThis.fetch = real; };
  return api;
}

const MAIL = { BREVO_KEY: 'k', RECOVERY_FROM: 'shop@rawhidecityleather.com', RECOVERY_POSTAL_ADDRESS: 'PO Box 1' };

export default async function run() {
  suite('todo — the record');

  const empty = emptyTodos();
  check('starts empty, emailing the shop inbox at 7 am', empty.items.length === 0 &&
    empty.email.to === UNSUBSCRIBE_TO && empty.email.hour === DEFAULT_HOUR && empty.email.enabled === true);
  check('normalise survives garbage', () => normalise('nope').items.length === 0 &&
    normalise({ items: 'x', email: 5 }).email.hour === DEFAULT_HOUR);
  check('normalise drops a broken item and a bad date', () => {
    const r = normalise({ items: [{ id: 'a', text: 'ok', due: 'tomorrow' }, { text: 'no id' }, null] });
    return r.items.length === 1 && r.items[0].due === '';
  });
  check('normalise ignores an out-of-range hour and a bad address', () => {
    const r = normalise({ email: { hour: 30, to: 'not-an-email', enabled: false } });
    return r.email.hour === DEFAULT_HOUR && r.email.to === UNSUBSCRIBE_TO && r.email.enabled === false;
  });

  suite('todo — actions');

  let r = applyAction(empty, { action: 'add', text: '  Newsletter   items to B. Patterson ', due: '2026-10-25' }, NOW);
  check('add trims and collapses the text', r.items.length === 1 && r.items[0].text === 'Newsletter items to B. Patterson');
  check('add keeps the due date and starts open', r.items[0].due === '2026-10-25' && r.items[0].done === false);
  check('add stamps updatedAt', r.updatedAt === new Date(NOW).toISOString());
  check('the original record is untouched', empty.items.length === 0);

  r = applyAction(r, { action: 'add', text: 'Order station 2 patches' }, NOW + 1000);
  check('a second item, no date', r.items.length === 2 && r.items[1].due === '');

  const id = r.items[0].id;
  r = applyAction(r, { action: 'toggle', id, done: true }, NOW + 2000);
  check('toggle marks done with a time', r.items[0].done === true && r.items[0].doneAt !== '');
  r = applyAction(r, { action: 'toggle', id, done: false }, NOW + 3000);
  check('toggle back clears doneAt', r.items[0].done === false && r.items[0].doneAt === '');

  r = applyAction(r, { action: 'edit', id, text: 'Newsletter items to Bpatterson', due: '' }, NOW);
  check('edit changes the words and can drop the date', r.items[0].text === 'Newsletter items to Bpatterson' && r.items[0].due === '');
  r = applyAction(r, { action: 'edit', id, due: '2026-10-25' }, NOW);
  check('edit with only a date leaves the words alone', r.items[0].text === 'Newsletter items to Bpatterson' && r.items[0].due === '2026-10-25');

  r = applyAction(r, { action: 'toggle', id: r.items[1].id, done: true }, NOW);
  r = applyAction(r, { action: 'clear-done' }, NOW);
  check('clear-done keeps only the open items', r.items.length === 1 && r.items[0].id === id);

  r = applyAction(r, { action: 'remove', id }, NOW);
  check('remove takes it off', r.items.length === 0);

  r = applyAction(r, { action: 'settings', to: 'rob@example.com', hour: 6, enabled: false }, NOW);
  check('settings saves address, hour and the switch', r.email.to === 'rob@example.com' && r.email.hour === 6 && r.email.enabled === false);
  r = applyAction(r, { action: 'settings', enabled: true }, NOW);
  check('settings with one field leaves the others', r.email.to === 'rob@example.com' && r.email.hour === 6 && r.email.enabled === true);

  suite('todo — what it refuses');

  throws('empty text', () => applyAction(empty, { action: 'add', text: '   ' }), 'Write what');
  throws('text too long', () => applyAction(empty, { action: 'add', text: 'x'.repeat(TEXT_MAX + 1) }), `${TEXT_MAX}`);
  throws('a date that is not a date', () => applyAction(empty, { action: 'add', text: 'x', due: '2026-13-45' }), 'real date');
  throws('a date in the wrong shape', () => applyAction(empty, { action: 'add', text: 'x', due: '10/25/2026' }), 'real date');
  throws('toggling a missing item', () => applyAction(empty, { action: 'toggle', id: 'nope' }), 'not on the list');
  throws('removing a missing item', () => applyAction(empty, { action: 'remove', id: 'nope' }), 'not on the list');
  throws('an unknown action', () => applyAction(empty, { action: 'explode' }), 'Unknown');
  throws('a bad email address', () => applyAction(empty, { action: 'settings', to: 'rob' }), 'email address');
  throws('an hour of 24', () => applyAction(empty, { action: 'settings', hour: 24 }), 'between 0 and 23');
  throws('a fractional hour', () => applyAction(empty, { action: 'settings', hour: 7.5 }), 'between 0 and 23');
  check('refusals are TodoErrors, so the route can answer 400', () => {
    try { applyAction(empty, { action: 'add', text: '' }); } catch (e) { return e instanceof TodoError; }
    return false;
  });
  check(`the list stops at ${ITEMS_MAX}`, () => {
    let full = empty;
    for (let i = 0; i < ITEMS_MAX; i++) full = applyAction(full, { action: 'add', text: 'item ' + i }, NOW + i);
    try { applyAction(full, { action: 'add', text: 'one more' }); } catch (e) { return e.message.includes('full'); }
    return false;
  });

  suite('todo — order and due dates');

  const items = [
    { id: 'a', text: 'no date, old', due: '', done: false, createdAt: '2026-10-01T00:00:00Z' },
    { id: 'b', text: 'due later', due: '2026-10-25', done: false, createdAt: '2026-10-02T00:00:00Z' },
    { id: 'c', text: 'overdue', due: '2026-10-01', done: false, createdAt: '2026-10-03T00:00:00Z' },
    { id: 'd', text: 'done', due: '2026-09-01', done: true, createdAt: '2026-09-01T00:00:00Z' },
    { id: 'e', text: 'no date, new', due: '', done: false, createdAt: '2026-10-05T00:00:00Z' },
  ];
  check('open first, nearest date first, undated last by age, done at the end',
    sortItems(items).map((i) => i.id).join('') === 'cbaed');
  check('openItems leaves the done one out', openItems({ items }).length === 4);

  check('dueState: overdue / today / soon / nothing', dueState(items[2], TODAY) === 'overdue' &&
    dueState({ due: TODAY }, TODAY) === 'today' &&
    dueState({ due: '2026-10-09' }, TODAY) === 'soon' &&
    dueState({ due: '2026-10-10' }, TODAY) === '' &&
    dueState({ due: '' }, TODAY) === '' &&
    dueState({ due: '2026-10-01', done: true }, TODAY) === '');
  check('dueWords', dueWords({ due: '2026-10-25' }, TODAY) === 'Due Oct 25' &&
    dueWords({ due: TODAY }, TODAY) === 'Due today' &&
    dueWords({ due: '2026-10-05' }, TODAY) === '1 day overdue' &&
    dueWords({ due: '2026-10-01' }, TODAY) === '5 days overdue' &&
    dueWords({ due: '' }, TODAY) === '');
  check('dueLabel adds the year only when it differs', dueLabel('2026-10-25', TODAY) === 'Oct 25' &&
    dueLabel('2027-01-05', TODAY) === 'Jan 5, 2027');
  check('hourLabel', hourLabel(0) === '12 am' && hourLabel(7) === '7 am' && hourLabel(12) === '12 pm' && hourLabel(18) === '6 pm');
  check('localHour reads Florida, not UTC', localHour(new Date(NOW)) === 7 &&
    localHour(new Date('2026-10-06T04:30:00Z')) === 0 &&
    localHour(new Date('2026-01-06T12:00:00Z')) === 7, 'EST in January, EDT in October');

  suite('todo — the email');

  const rec = normalise({ items });
  const mail = todoEmail(rec, new Date(NOW));
  check('subject counts open and overdue with the day', mail.subject === 'LWFD to-do: 4 open, 1 overdue (Tue, Oct 6)');
  check('text lists every open item with its due words',
    mail.text.includes('- overdue (5 days overdue)') && mail.text.includes('- due later (Due Oct 25)') &&
    mail.text.includes('- no date, old') && !mail.text.includes('- done'));
  check('text links back to the card', mail.text.includes('rawhidecityleather.com/dashboard#todo'));
  check('html carries the same items and the link', mail.html.includes('overdue') && mail.html.includes('dashboard#todo') && !mail.html.includes('>done<'));
  check('html escapes the words', todoEmail(normalise({ items: [{ id: 'x', text: '<b>bold</b>' }] })).html.includes('&lt;b&gt;'));

  suite('todo — the cron step');

  async function cronEnv(record, { mail = MAIL } = {}) {
    const env = { TODOS: makeKV(), ...mail };
    await env.TODOS.put(TODO_KEY, JSON.stringify(record));
    return env;
  }
  const open = normalise({ items: [{ id: 'a', text: 'Call the chief', due: '' }] });

  check('no storage, no send', (await runTodoMail({}, NOW)).why === 'no-storage');
  check('nothing open, no send', (await runTodoMail(await cronEnv(emptyTodos()), NOW)).why === 'nothing-open');
  check('switched off, no send', (await runTodoMail(await cronEnv({ ...open, email: { ...open.email, enabled: false } }), NOW)).why === 'off');
  check('wrong hour, no send', (await runTodoMail(await cronEnv(open), NOW + 3600 * 1000)).why === 'not-the-hour');
  check('already sent today, no send', (await runTodoMail(await cronEnv({ ...open, lastEmailedOn: TODAY }), NOW)).why === 'already-today');
  {
    const env = await cronEnv(open, { mail: {} });
    const report = await runTodoMail(env, NOW);
    const after = await env.TODOS.get(TODO_KEY, { type: 'json' });
    check('mail unset: reason and the day is not marked', report.why === 'mail-not-configured' && after.lastEmailedOn === '');
  }

  {
    const brevo = stubBrevo();
    try {
      const env = await cronEnv(open);
      const report = await runTodoMail(env, NOW);
      const after = await env.TODOS.get(TODO_KEY, { type: 'json' });
      check('at 7 am with something open it sends', report.sent === true && report.to === UNSUBSCRIBE_TO && report.open === 1);
      check('one Brevo call, to the address on the card, transactional', brevo.sent.length === 1 &&
        brevo.sent[0].to[0].email === UNSUBSCRIBE_TO && !brevo.sent[0].headers);
      check('the subject is the to-do subject', brevo.sent[0].subject.startsWith('LWFD to-do: 1 open'));
      check('the day is marked', after.lastEmailedOn === TODAY);
      const again = await runTodoMail(env, NOW + 60 * 1000);
      check('a second run the same hour does nothing', again.why === 'already-today' && brevo.sent.length === 1);

      brevo.fail = true;
      const env2 = await cronEnv(open);
      const failed = await runTodoMail(env2, NOW);
      const after2 = await env2.TODOS.get(TODO_KEY, { type: 'json' });
      check('a failed send reports it and unmarks the day so the next hour retries',
        failed.why === 'send-failed' && failed.error.includes('500') && after2.lastEmailedOn === '');
      brevo.fail = false;

      const forced = await runTodoMail(await cronEnv({ ...open, lastEmailedOn: TODAY, email: { ...open.email, enabled: false } }), NOW + 5 * 3600 * 1000, { force: true });
      check('force sends whatever the clock, the switch or the mark says', forced.sent === true);
      const forcedEmpty = await runTodoMail(await cronEnv(emptyTodos()), NOW, { force: true });
      check('force still sends nothing when nothing is open', forcedEmpty.why === 'nothing-open');
    } finally {
      brevo.restore();
    }
  }

  suite('todo — the card');

  const cardRec = normalise({ items, email: { to: 'rob@example.com', hour: 6, enabled: true }, lastEmailedOn: '2026-10-05' });
  const card = renderTodoCard(cardRec, { now: new Date(NOW) });
  check('has the id the rail links to', card.includes('id="todo"'));
  check('headline note counts open and overdue', card.includes('4 open, 1 overdue'));
  check('open items come before the done fold', card.indexOf('overdue') < card.indexOf('tododone'));
  check('the overdue row is marked', card.includes('class="todoitem overdue"') && card.includes('5 days overdue'));
  check('the done item is ticked and struck', /class="todoitem isdone"[^]*?checked/.test(card));
  check('done fold offers Clear done', card.includes('id="todoclear"'));
  check('the email line says when, to whom and when it last went', card.includes('6 am Eastern to rob@example.com') && card.includes('Last sent Oct 5'));
  check('the hour picker has 24 choices with 6 am selected', (card.match(/<option /g) || []).length === 24 && card.includes('value="6" selected'));
  check('escapes an item', renderTodoList(normalise({ items: [{ id: 'x', text: '<img src=x onerror=alert(1)>' }] })).includes('&lt;img'));
  check('empty list says so', renderTodoList(emptyTodos()).includes('Nothing on the list'));
  check('all done says so and opens the fold', () => {
    const html = renderTodoList(normalise({ items: [{ id: 'x', text: 'y', done: true }] }));
    return html.includes('All done') && html.includes('<details class="tododone" open>');
  });
  check('no storage: banner, form hidden', () => {
    const html = renderTodoCard(null, { ready: false });
    return html.includes('TODOS') && html.includes('<form id="todoform" class="todoadd" hidden>');
  });
  check('mail state: unset / off / on', renderMailState(cardRec, false, TODAY).includes('not set up') &&
    renderMailState({ ...cardRec, email: { ...cardRec.email, enabled: false } }, true, TODAY).includes('Turn it on') &&
    renderMailState(cardRec, true, TODAY).includes('Emails daily'));

  const dash = renderDashboard(analyze([], '30d'), { todos: cardRec });
  check('the dashboard puts the card above the numbers', dash.indexOf('id="todo"') < dash.indexOf('id="overview"'));
  check('the rail links to it with the open count', /href="#todo"[^>]*>LWFD to-do<span class="railbadge">4<\/span>/.test(dash));
  check('no open items, no badge', !/href="#todo"[^>]*>LWFD to-do<span/.test(renderDashboard(analyze([], '30d'), { todos: emptyTodos() })));

  suite('todo — the routes');

  const env = {
    TODOS: makeKV(),
    SNIPCART_SECRET: 'test-key-never-used',
    SLIP_USER: 'dev',
    SLIP_PASS: 'dev',
    ASSETS: { fetch: async () => new Response('404', { status: 404 }) },
  };
  const AUTH = 'Basic ' + Buffer.from('dev:dev').toString('base64');
  const DASH = { Authorization: AUTH, 'x-rawhide-dashboard': '1' };
  const ORIGIN = 'https://rawhidecityleather.com';
  const post = (path, body, headers = {}, e = env) =>
    worker.fetch(new Request(ORIGIN + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }), e);

  check('needs a login', (await post('/dashboard/api/todo', { action: 'add', text: 'x' })).status === 401);
  check('needs the dashboard header', (await post('/dashboard/api/todo', { action: 'add', text: 'x' }, { Authorization: AUTH })).status === 403);
  check('send needs the header too', (await post('/dashboard/api/todo/send', {}, { Authorization: AUTH })).status === 403);

  let res = await post('/dashboard/api/todo', { action: 'add', text: 'Turn in the inspection sheet', due: '2026-10-08' }, DASH);
  let data = await res.json();
  check('add answers with the count, the note and the list', res.status === 200 && data.ok === true &&
    data.open === 1 && data.note === '1 open' && data.list.includes('Turn in the inspection sheet'));
  check('add answers with the mail state line too', typeof data.mailState === 'string' && data.mailState.includes('Email off'));
  check('it is in KV', JSON.parse(env.TODOS._store.get(TODO_KEY)).items.length === 1);

  const itemId = JSON.parse(env.TODOS._store.get(TODO_KEY)).items[0].id;
  res = await post('/dashboard/api/todo', { action: 'toggle', id: itemId, done: true }, DASH);
  data = await res.json();
  check('toggle answers nothing open', data.open === 0 && data.note === 'nothing open' && data.list.includes('All done'));

  res = await post('/dashboard/api/todo', { action: 'add', text: '' }, DASH);
  check('a refusal is a 400 with the reason', res.status === 400 && (await res.json()).error.includes('Write what'));
  res = await post('/dashboard/api/todo', { action: 'toggle', id: 'gone' }, DASH);
  check('a missing item is a 400', res.status === 400);

  res = await post('/dashboard/api/todo', { action: 'settings', to: 'rob@example.com', hour: 8, enabled: true }, DASH);
  data = await res.json();
  check('settings come back and the mail line updates', data.email.to === 'rob@example.com' && data.email.hour === 8 &&
    data.mailState.includes('not set up'), 'no Brevo secrets in this env');

  res = await post('/dashboard/api/todo/send', {}, DASH);
  check('send with nothing open is a 400 that says so', res.status === 400 && (await res.json()).error.includes('Nothing is open'));

  await post('/dashboard/api/todo', { action: 'toggle', id: itemId, done: false }, DASH);
  res = await post('/dashboard/api/todo/send', {}, DASH);
  check('send without mail secrets is a 502 that says so', res.status === 502 && (await res.json()).error.includes('not set up'));

  {
    const brevo = stubBrevo();
    try {
      const mailEnv = { ...env, ...MAIL };
      res = await post('/dashboard/api/todo/send', {}, DASH, mailEnv);
      data = await res.json();
      check('send now goes to the saved address', res.status === 200 && data.ok === true && data.to === 'rob@example.com' &&
        brevo.sent.length === 1 && brevo.sent[0].to[0].email === 'rob@example.com');
      check('send now does not mark the day, so the morning email still comes',
        JSON.parse(env.TODOS._store.get(TODO_KEY)).lastEmailedOn === '');
    } finally {
      brevo.restore();
    }
  }

  {
    const bare = { ...env, TODOS: undefined };
    res = await post('/dashboard/api/todo', { action: 'add', text: 'x' }, DASH, bare);
    check('no TODOS binding is a 500 that names the binding', res.status === 500 && (await res.json()).error.includes('TODOS'));
  }
}
