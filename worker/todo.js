/**
 * The LWFD to-do list, on the dashboard.
 *
 * Rob's fire-department job throws off small things with dates on them — the
 * newsletter items due on the 25th, a form somebody needs, a call to make — and
 * none of them live anywhere he already looks every day. The dashboard is the
 * page he does look at, so the list lives here: a card at the top of it, with
 * boxes to tick, and a copy of what is still open emailed to him every morning
 * so a quiet week cannot bury it.
 *
 * What it is: text, an optional due date, done or not. Nothing else. It is a
 * list on a wall, not a project tool, and a list on a wall gets used.
 *
 * Storage is one JSON record in the TODOS KV namespace. The whole list is small
 * enough to read and write as one thing, and one record means the card, the
 * email and the API can never disagree about what is open.
 *
 * The email rides the hourly cron: once the clock in Florida reaches the hour
 * on the card, and not more than once a day. Nothing open means no email —
 * an empty reminder is the kind of mail that teaches you to ignore the sender.
 */

import { esc, json } from './lib.js';
import { sendMail, mailerConfigured, UNSUBSCRIBE_TO } from './mailer.js';
import { localDate } from './promo.js';

export const TODO_KEY = 'lwfd';
export const TIME_ZONE = 'America/New_York';
export const TEXT_MAX = 200;
export const ITEMS_MAX = 100;
export const DEFAULT_HOUR = 7;
export const DASHBOARD_URL = 'https://rawhidecityleather.com/dashboard#todo';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class TodoError extends Error {}

/* ---------------------------------------------------------------- record */

export function emptyTodos() {
  return {
    items: [],
    email: { to: UNSUBSCRIBE_TO, hour: DEFAULT_HOUR, enabled: true },
    lastEmailedOn: '',
    updatedAt: '',
  };
}

/** Fills in anything an older record is missing. Never throws. */
export function normalise(record) {
  const base = emptyTodos();
  if (!record || typeof record !== 'object') return base;
  const email = record.email && typeof record.email === 'object' ? record.email : {};
  return {
    items: Array.isArray(record.items)
      ? record.items.filter((i) => i && typeof i === 'object' && i.id && i.text).map((i) => ({
          id: String(i.id),
          text: String(i.text),
          due: DATE_RE.test(i.due || '') ? i.due : '',
          done: Boolean(i.done),
          createdAt: i.createdAt || '',
          doneAt: i.doneAt || '',
        }))
      : [],
    email: {
      to: EMAIL_RE.test(email.to || '') ? email.to : base.email.to,
      hour: Number.isInteger(email.hour) && email.hour >= 0 && email.hour <= 23
        ? email.hour : base.email.hour,
      enabled: email.enabled !== false,
    },
    lastEmailedOn: DATE_RE.test(record.lastEmailedOn || '') ? record.lastEmailedOn : '',
    updatedAt: record.updatedAt || '',
  };
}

export async function getTodos(env) {
  if (!env.TODOS) return emptyTodos();
  try {
    return normalise(await env.TODOS.get(TODO_KEY, { type: 'json' }));
  } catch {
    return emptyTodos();
  }
}

export async function putTodos(env, record) {
  await env.TODOS.put(TODO_KEY, JSON.stringify(record));
}

/* --------------------------------------------------------------- actions */

function newId(now) {
  return 't' + now.toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * One change to the list, applied to a copy. Pure, so the whole surface is
 * testable without KV, and so a bad request leaves the stored record alone.
 *
 *   add        { text, due? }
 *   toggle     { id, done }
 *   edit       { id, text?, due? }
 *   remove     { id }
 *   clear-done {}
 *   settings   { to?, hour?, enabled? }
 */
export function applyAction(record, body = {}, now = Date.now()) {
  const next = normalise(record);
  const action = String(body.action || '');
  const stamp = new Date(now).toISOString();

  const find = () => {
    const item = next.items.find((i) => i.id === String(body.id || ''));
    if (!item) throw new TodoError('That item is not on the list any more.');
    return item;
  };

  switch (action) {
    case 'add': {
      const text = cleanText(body.text);
      if (next.items.length >= ITEMS_MAX) {
        throw new TodoError(`The list is full at ${ITEMS_MAX} items. Clear some done ones first.`);
      }
      next.items.push({
        id: newId(now), text, due: cleanDue(body.due), done: false, createdAt: stamp, doneAt: '',
      });
      break;
    }
    case 'toggle': {
      const item = find();
      item.done = body.done !== false;
      item.doneAt = item.done ? stamp : '';
      break;
    }
    case 'edit': {
      const item = find();
      if (body.text !== undefined) item.text = cleanText(body.text);
      if (body.due !== undefined) item.due = cleanDue(body.due);
      break;
    }
    case 'remove': {
      const item = find();
      next.items = next.items.filter((i) => i !== item);
      break;
    }
    case 'clear-done':
      next.items = next.items.filter((i) => !i.done);
      break;
    case 'settings': {
      if (body.to !== undefined) {
        const to = String(body.to || '').trim();
        if (!EMAIL_RE.test(to)) throw new TodoError('That does not look like an email address.');
        next.email.to = to;
      }
      if (body.hour !== undefined) {
        const hour = Number(body.hour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          throw new TodoError('Pick an hour between 0 and 23.');
        }
        next.email.hour = hour;
      }
      if (body.enabled !== undefined) next.email.enabled = Boolean(body.enabled);
      break;
    }
    default:
      throw new TodoError('Unknown action.');
  }

  next.updatedAt = stamp;
  return next;
}

function cleanText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new TodoError('Write what needs doing.');
  if (text.length > TEXT_MAX) throw new TodoError(`Keep it under ${TEXT_MAX} characters.`);
  return text;
}

function cleanDue(value) {
  const due = String(value ?? '').trim();
  if (!due) return '';
  if (!DATE_RE.test(due) || Number.isNaN(Date.parse(due + 'T12:00:00Z'))) {
    throw new TodoError('The due date is not a real date.');
  }
  return due;
}

/* ------------------------------------------------------------------ views */

/** Open first, dated before undated, nearest date first, then oldest first. */
export function sortItems(items) {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.due !== b.due) {
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    }
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

export function openItems(record) {
  return sortItems(normalise(record).items.filter((i) => !i.done));
}

/** 'overdue' | 'today' | 'soon' (within 3 days) | '' for an open item. */
export function dueState(item, today) {
  if (!item.due || item.done) return '';
  if (item.due < today) return 'overdue';
  if (item.due === today) return 'today';
  const days = daysBetween(today, item.due);
  return days <= 3 ? 'soon' : '';
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

/** "Oct 25" — or "Oct 25, 2027" when it is not this year. */
export function dueLabel(due, today) {
  if (!due) return '';
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const sameYear = due.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC',
  });
}

/** "Due Oct 25", "Due today", "3 days overdue" — the words beside an item. */
export function dueWords(item, today) {
  const state = dueState(item, today);
  if (!item.due) return '';
  if (state === 'today') return 'Due today';
  if (state === 'overdue') {
    const days = daysBetween(item.due, today);
    return days === 1 ? '1 day overdue' : `${days} days overdue`;
  }
  return 'Due ' + dueLabel(item.due, today);
}

export function hourLabel(hour) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? 'am' : 'pm'}`;
}

/* ------------------------------------------------------------------- card */

/** The list itself. Separate so a save can send back just this and the page swaps it in. */
export function renderTodoList(record, now = new Date()) {
  const today = localDate(now, TIME_ZONE);
  const items = sortItems(normalise(record).items);
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);

  if (!items.length) {
    return `<p class="empty">Nothing on the list. Add the first thing above.</p>`;
  }

  const row = (item) => {
    const state = dueState(item, today);
    const words = dueWords(item, today);
    return `<li class="todoitem${item.done ? ' isdone' : ''}${state ? ' ' + state : ''}" data-id="${esc(item.id)}">
      <label class="todocheck">
        <input type="checkbox" class="todobox" data-id="${esc(item.id)}"${item.done ? ' checked' : ''}>
        <span class="todotext">${esc(item.text)}</span>
      </label>
      ${words ? `<span class="tododue">${esc(words)}</span>` : ''}
      <button type="button" class="todoremove" data-remove="${esc(item.id)}" title="Take it off the list" aria-label="Remove">&times;</button>
    </li>`;
  };

  return `${open.length
    ? `<ul class="todolist">${open.map(row).join('')}</ul>`
    : `<p class="empty">All done. Nothing open.</p>`}
  ${done.length ? `<details class="tododone"${done.length && !open.length ? ' open' : ''}>
    <summary>${done.length} done <span class="soft">&middot; ticked items stay here until you clear them</span></summary>
    <ul class="todolist">${done.map(row).join('')}</ul>
    <button type="button" class="btn tiny ghost" id="todoclear">Clear done</button>
  </details>` : ''}`;
}

/** The one line under "Daily email" that says what will happen. */
export function renderMailState(record, mailReady, today) {
  const r = normalise(record);
  if (!mailReady) {
    return '<span class="pill bad">Email off</span> <span class="soft">Email is not set up on the Worker, so nothing can send. See the README.</span>';
  }
  if (!r.email.enabled) {
    return '<span class="pill done">Email off</span> <span class="soft">Nothing is sent. Turn it on below.</span>';
  }
  return `<span class="pill good">Emails daily</span> <span class="soft">${esc(hourLabel(r.email.hour))} Eastern to ${esc(r.email.to)}, only while something is open${
    r.lastEmailedOn ? `. Last sent ${esc(dueLabel(r.lastEmailedOn, today))}` : ''}.</span>`;
}

export function renderTodoCard(record, { ready = true, mailReady = true, now = new Date() } = {}) {
  const r = normalise(record);
  const today = localDate(now, TIME_ZONE);
  const open = r.items.filter((i) => !i.done);
  const overdue = open.filter((i) => dueState(i, today) === 'overdue').length;
  const note = !open.length ? 'nothing open'
    : `${open.length} open${overdue ? `, ${overdue} overdue` : ''}`;

  const hours = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}"${h === r.email.hour ? ' selected' : ''}>${hourLabel(h)}</option>`).join('');


  return `<section id="todo" class="card todocard">
    <div class="cardhead">
      <h2>LWFD to-do</h2>
      <span class="cardnote" id="todonote">${esc(note)}</span>
    </div>

    ${ready ? '' : `<p class="banner">
      List storage is not set up. Create the KV namespace and add the
      <code>TODOS</code> binding to <code>wrangler.jsonc</code> &mdash; see the README.
      Nothing saves until then.
    </p>`}

    <form id="todoform" class="todoadd"${ready ? '' : ' hidden'}>
      <input type="text" name="text" id="todonew" maxlength="${TEXT_MAX}" required
        placeholder="What needs doing? e.g. Newsletter items to B. Patterson" autocomplete="off">
      <input type="date" name="due" id="todowhen" title="Due date (optional)">
      <button type="submit" class="btn">Add</button>
    </form>

    <div id="todolist">${renderTodoList(r, now)}</div>

    <details class="todomail">
      <summary>Daily email <span id="todomailstate">${renderMailState(r, mailReady, today)}</span></summary>
      <form id="todomailform" class="qform">
        <div class="qgrid">
          <label class="qfield">
            <span>Send to</span>
            <input type="email" name="to" value="${esc(r.email.to)}" required>
          </label>
          <label class="qfield qnarrow">
            <span>At <em>(Eastern)</em></span>
            <select name="hour">${hours}</select>
          </label>
          <label class="qcheck todoenabled">
            <input type="checkbox" name="enabled"${r.email.enabled ? ' checked' : ''}>
            <span>Send it every day there is something open</span>
          </label>
        </div>
        <div class="todomailbtns">
          <button type="submit" class="btn">Save</button>
          <button type="button" class="btn ghost" id="todosendnow"${mailReady ? '' : ' disabled'}>Send me a copy now</button>
        </div>
        <p class="hint">
          The email lists what is open, oldest due first, with a link back here.
          Nothing open, no email. Rides the same hourly clock as the cart
          recovery, so it lands within the hour you pick.
        </p>
      </form>
    </details>
  </section>`;
}

/* ------------------------------------------------------------------ email */

export function todoEmail(record, now = new Date()) {
  const today = localDate(now, TIME_ZONE);
  const open = openItems(record);
  const overdue = open.filter((i) => dueState(i, today) === 'overdue').length;
  const dateWords = new Date(now).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: TIME_ZONE,
  });

  const subject = `LWFD to-do: ${open.length} open${overdue ? `, ${overdue} overdue` : ''} (${dateWords})`;

  const lines = open.map((i) => {
    const words = dueWords(i, today);
    return `- ${i.text}${words ? ` (${words})` : ''}`;
  });
  const text = [
    `LWFD to-do for ${dateWords}`,
    '',
    ...lines,
    '',
    `Tick them off: ${DASHBOARD_URL}`,
  ].join('\n');

  const rows = open.map((i) => {
    const state = dueState(i, today);
    const words = dueWords(i, today);
    const color = state === 'overdue' ? '#8B2E2E' : state === 'today' ? '#7A5C14' : '#6B6358';
    return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #e6e2d8;font-size:15px;line-height:1.4">${esc(i.text)}</td>
      <td style="padding:8px 0 8px 14px;border-bottom:1px solid #e6e2d8;font-size:12px;white-space:nowrap;color:${color};text-align:right">${esc(words)}</td>
    </tr>`;
  }).join('');

  const html = `<!doctype html><html><body style="margin:0;background:#EFEDE7;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#0F0F0F">
<div style="max-width:560px;margin:0 auto;padding:28px 18px">
  <p style="margin:0 0 4px;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#6B6358">LWFD to-do</p>
  <h1 style="margin:0 0 18px;font-size:22px;font-weight:600">${esc(dateWords)} &middot; ${open.length} open${overdue ? `, ${overdue} overdue` : ''}</h1>
  <div style="background:#fff;border:1px solid #e6e2d8;border-radius:3px;padding:4px 16px">
    <table style="width:100%;border-collapse:collapse" cellpadding="0" cellspacing="0">${rows}</table>
  </div>
  <p style="margin:20px 0 0;font-size:14px"><a href="${DASHBOARD_URL}" style="color:#0F0F0F;font-weight:600">Tick them off on the dashboard &rarr;</a></p>
  <p style="margin:18px 0 0;font-size:11px;color:#6B6358">Sent every morning there is something open. Turn it off or change the hour on the dashboard card.</p>
</div></body></html>`;

  return { subject, text, html };
}

/** The hour of the day in Florida, 0–23. */
export function localHour(now = new Date(), timeZone = TIME_ZONE) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', hourCycle: 'h23',
  }).format(now)) % 24;
}

/**
 * The cron entry point. Decides whether this is the hour, whether today has
 * had its email, and whether there is anything worth saying — then sends.
 * Returns a report rather than throwing, so the scheduled handler can log it
 * next to the other jobs.
 *
 * `lastEmailedOn` is written before the send so a slow Brevo cannot produce
 * two emails from two overlapping runs. A failed send clears it again, and
 * the next hour's run has another go.
 */
export async function runTodoMail(env, now = Date.now(), { force = false } = {}) {
  if (!env.TODOS) return { sent: false, why: 'no-storage' };
  const record = await getTodos(env);
  const today = localDate(new Date(now), TIME_ZONE);
  const open = openItems(record);

  if (!force) {
    if (!record.email.enabled) return { sent: false, why: 'off' };
    if (localHour(new Date(now)) !== record.email.hour) return { sent: false, why: 'not-the-hour' };
    if (record.lastEmailedOn === today) return { sent: false, why: 'already-today' };
  }
  if (!open.length) return { sent: false, why: 'nothing-open' };
  if (!mailerConfigured(env)) return { sent: false, why: 'mail-not-configured' };

  if (!force) await putTodos(env, { ...record, lastEmailedOn: today });

  const { subject, text, html } = todoEmail(record, new Date(now));
  try {
    await sendMail(env, { to: record.email.to, subject, html, text, transactional: true });
  } catch (err) {
    if (!force) await putTodos(env, { ...record, lastEmailedOn: record.lastEmailedOn });
    return { sent: false, why: 'send-failed', error: String(err?.message || err).slice(0, 300) };
  }
  return { sent: true, to: record.email.to, open: open.length };
}

/* ----------------------------------------------------------------- routes */

export async function handleTodoChange(request, env, now = Date.now()) {
  if (!env.TODOS) {
    return json({
      error: 'List storage is not set up. Create the KV namespace and add the ' +
        'TODOS binding to wrangler.jsonc — see the README.',
    }, 500);
  }
  const body = await request.json().catch(() => ({}));

  let next;
  try {
    next = applyAction(await getTodos(env), body, now);
  } catch (err) {
    if (err instanceof TodoError) return json({ error: err.message }, 400);
    throw err;
  }
  await putTodos(env, next);

  const open = openItems(next);
  const today = localDate(new Date(now), TIME_ZONE);
  const overdue = open.filter((i) => dueState(i, today) === 'overdue').length;
  return json({
    ok: true,
    open: open.length,
    overdue,
    note: !open.length ? 'nothing open' : `${open.length} open${overdue ? `, ${overdue} overdue` : ''}`,
    list: renderTodoList(next, new Date(now)),
    email: next.email,
    mailState: renderMailState(next, mailerConfigured(env), today),
  });
}

/** "Send me a copy now": the same email the cron sends, whatever the clock says. */
export async function handleTodoSendNow(request, env, now = Date.now()) {
  const report = await runTodoMail(env, now, { force: true });
  if (report.sent) return json({ ok: true, to: report.to, open: report.open });
  const said = {
    'no-storage': 'List storage is not set up.',
    'nothing-open': 'Nothing is open, so there is nothing to send.',
    'mail-not-configured': 'Email is not set up on the Worker. See the README.',
    'send-failed': 'The email would not send: ' + (report.error || 'unknown error'),
  };
  return json({ error: said[report.why] || report.why }, report.why === 'nothing-open' ? 400 : 502);
}

/* ----------------------------------------------------------------- client */

export const TODO_STYLES = `
.todocard{border-left:3px solid var(--ink)}
.todoadd{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}
.todoadd input{font:inherit;font-size:13.5px;padding:9px 11px;border:1px solid var(--line-2);
  border-radius:2px;background:var(--paper);color:var(--ink)}
.todoadd input[type=text]{flex:1 1 260px;min-width:0}
.todoadd input:focus{outline:none;border-color:var(--ink)}
.todolist{list-style:none;margin:0;padding:0}
.todoitem{display:flex;align-items:center;gap:12px;padding:9px 6px;border-bottom:1px solid var(--line)}
.todoitem:last-child{border-bottom:0}
.todocheck{display:flex;align-items:center;gap:12px;flex:1;min-width:0;cursor:pointer;font-size:14.5px;line-height:1.4}
.todocheck input{width:18px;height:18px;flex:0 0 18px;accent-color:#0F0F0F;cursor:pointer;margin:0}
.todotext{overflow-wrap:anywhere}
.isdone .todotext{text-decoration:line-through;color:var(--soft)}
.tododue{font-family:var(--display);text-transform:uppercase;letter-spacing:.12em;font-size:10px;
  font-weight:600;white-space:nowrap;color:var(--soft);padding:3px 8px;border-radius:9px;background:var(--stone)}
.todoitem.soon .tododue{background:var(--warn-bg);color:var(--warn)}
.todoitem.today .tododue{background:var(--warn-bg);color:var(--warn)}
.todoitem.overdue .tododue{background:var(--bad-bg);color:var(--bad)}
.isdone .tododue{background:none;color:var(--soft);opacity:.6}
.todoremove{font:inherit;font-size:18px;line-height:1;width:28px;height:28px;border:0;border-radius:2px;
  background:none;color:var(--soft);cursor:pointer;opacity:.45}
.todoremove:hover{opacity:1;background:var(--stone);color:var(--ink)}
.tododone{margin-top:12px;padding-top:8px;border-top:1px solid var(--line)}
.tododone summary,.todomail summary{cursor:pointer;font-size:12.5px;color:var(--soft);padding:4px 0;list-style:none}
.tododone summary::-webkit-details-marker,.todomail summary::-webkit-details-marker{display:none}
.tododone summary::before,.todomail summary::before{content:'\\25B8';display:inline-block;margin-right:7px;transition:transform .15s}
.tododone[open]>summary::before,.todomail[open]>summary::before{transform:rotate(90deg)}
.tododone .todolist{opacity:.75}
.tododone .btn{margin-top:8px}
.todomail{margin-top:14px;padding-top:10px;border-top:1px solid var(--line)}
.todomail summary .pill{margin:0 6px 0 4px;vertical-align:middle}
.todomail .qform{margin-top:10px}
.todoenabled{align-self:end;padding-bottom:8px;font-size:13px}
.todomailbtns{display:flex;gap:8px;margin:12px 0 10px;flex-wrap:wrap}
`;

export const TODO_SCRIPT = `
(function(){
  var card = document.getElementById('todo');
  if (!card) return;

  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg, bad){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, 5000);
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

  var list = document.getElementById('todolist');
  var note = document.getElementById('todonote');
  var form = document.getElementById('todoform');
  var text = document.getElementById('todonew');
  var when = document.getElementById('todowhen');
  var railBadge = document.querySelector('.railnav a[href$="#todo"] .railbadge');
  var railLink = document.querySelector('.railnav a[href$="#todo"]');
  var mailState = document.getElementById('todomailstate');

  function apply(data){
    list.innerHTML = data.list;
    note.textContent = data.note;
    if (mailState && data.mailState) mailState.innerHTML = data.mailState;
    if (railLink) {
      if (data.open) {
        if (!railBadge) {
          railBadge = document.createElement('span');
          railBadge.className = 'railbadge';
          railLink.appendChild(railBadge);
        }
        railBadge.textContent = String(data.open);
      } else if (railBadge) {
        railBadge.remove();
        railBadge = null;
      }
    }
  }
  function change(body){
    return post('/dashboard/api/todo', body).then(apply).catch(function(err){ toast(err.message, true); });
  }

  if (form) form.addEventListener('submit', function(e){
    e.preventDefault();
    var value = text.value.trim();
    if (!value) { text.focus(); return; }
    var btn = form.querySelector('button');
    btn.disabled = true;
    change({ action: 'add', text: value, due: when.value }).then(function(){
      text.value = ''; when.value = ''; text.focus();
    }).finally(function(){ btn.disabled = false; });
  });

  list.addEventListener('change', function(e){
    var box = e.target.closest && e.target.closest('.todobox');
    if (!box) return;
    var row = box.closest('.todoitem');
    if (row) row.classList.toggle('isdone', box.checked);
    change({ action: 'toggle', id: box.getAttribute('data-id'), done: box.checked });
  });

  list.addEventListener('click', function(e){
    var remove = e.target.closest && e.target.closest('[data-remove]');
    if (remove) {
      var row = remove.closest('.todoitem');
      var what = row ? (row.querySelector('.todotext').textContent || 'this').trim() : 'this';
      if (!confirm('Take "' + what + '" off the list?')) return;
      change({ action: 'remove', id: remove.getAttribute('data-remove') });
      return;
    }
    if (e.target.id === 'todoclear') {
      change({ action: 'clear-done' }).then(function(){ toast('Cleared.'); });
    }
  });

  var mail = document.getElementById('todomailform');
  if (mail) mail.addEventListener('submit', function(e){
    e.preventDefault();
    var fd = new FormData(mail);
    change({
      action: 'settings',
      to: fd.get('to'),
      hour: Number(fd.get('hour')),
      enabled: fd.get('enabled') === 'on'
    }).then(function(){ toast('Saved.'); });
  });

  var sendNow = document.getElementById('todosendnow');
  if (sendNow) sendNow.addEventListener('click', function(){
    sendNow.disabled = true;
    var label = sendNow.textContent;
    sendNow.textContent = 'Sending\\u2026';
    post('/dashboard/api/todo/send', {}).then(function(data){
      toast('Sent to ' + data.to + '.');
    }).catch(function(err){
      toast(err.message, true);
    }).finally(function(){ sendNow.disabled = false; sendNow.textContent = label; });
  });
})();
`;
