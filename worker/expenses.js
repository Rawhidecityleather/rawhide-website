/**
 * Expense ledger — every business receipt the shop keeps, and the one report
 * the CPA gets at the end of the year.
 *
 * A row starts life as a photo (see receipts.js), arrives with the vendor, date
 * and total already suggested by a vision model, and stays flagged "check" until
 * the shop confirms it. Only confirmed rows are counted as finished; unchecked
 * ones still appear in every total, because a receipt that exists is money that
 * was spent whether or not anyone has looked at it yet.
 *
 * Storage is KV, one record per receipt, with a summary in the key's metadata.
 * That is what makes the year page a single list call instead of one read per
 * receipt — the same trick the quotes card uses.
 *
 * Money here is dollars, not cents, and is rounded at every boundary.
 *
 * What this is not: tax advice. The categories below are the shop's own
 * buckets, chosen because they match how the money actually goes out the door.
 * Mapping them onto a Schedule C is the CPA's job, and the report says so.
 */

import { esc, money, shortDate } from './lib.js';
import { renderRail, DASHBOARD_STYLES } from './dashboard.js';

const KEY_PREFIX = 'receipt:';

/** KV list ceiling per call. More than this and we page with the cursor. */
const PAGE_SIZE = 1000;

/** A single receipt over this is a typo, not a purchase. */
const MAX_AMOUNT = 100000;

/**
 * The shop's spending buckets, in the order they show up on the report.
 *
 * `match` is only used to guess at a category from the vendor name when the
 * model doesn't name one. A wrong guess is cheap — it lands in a row the shop
 * is already reading before it counts as checked.
 */
export const CATEGORIES = [
  { key: 'leather', label: 'Leather & hides', match: /hide|leather|tannery|tandy|weaver|springfield/i },
  { key: 'hardware', label: 'Hardware & buckles', match: /buckle|rivet|snap|hardware|dee ring|chicago screw/i },
  { key: 'tools', label: 'Tools & equipment', match: /tool|machine|cobra|tippmann|press|laser|blade|knife/i },
  { key: 'shipping', label: 'Shipping & postage', match: /usps|post ?office|pirate ?ship|ups|fedex|postage|stamps\.com/i },
  { key: 'packaging', label: 'Packaging & boxes', match: /uline|box|packag|mailer|poly bag|tissue|tape/i },
  { key: 'advertising', label: 'Advertising & marketing', match: /meta|facebook|instagram|google ads|print(ing)?|sign|banner|sponsor/i },
  { key: 'software', label: 'Software & web services', match: /snipcart|cloudflare|adobe|canva|domain|hosting|subscription|godaddy|brevo/i },
  { key: 'fees', label: 'Payment & platform fees', match: /stripe|paypal|square|processing fee|merchant fee/i },
  { key: 'supplies', label: 'Shop supplies', match: /dye|thread|glue|cement|edge|finish|sandpaper|home depot|lowe|harbor freight/i },
  { key: 'vehicle', label: 'Vehicle & fuel', match: /fuel|gas|shell|chevron|wawa|racetrac|circle k|tire|oil change/i },
  { key: 'travel', label: 'Travel, shows & booths', match: /hotel|motel|inn|booth|vendor fee|expo|convention|conference|airline|flight/i },
  { key: 'meals', label: 'Meals', match: /restaurant|cafe|coffee|diner|grill|pizza|bbq/i },
  { key: 'education', label: 'Dues, books & training', match: /dues|membership|course|class|book|training|association/i },
  { key: 'other', label: 'Other — ask the CPA', match: /$^/ },
];

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

export function isCategory(key) {
  return CATEGORY_KEYS.has(String(key || ''));
}

export function categoryLabel(key) {
  return (CATEGORIES.find((c) => c.key === key) || CATEGORIES[CATEGORIES.length - 1]).label;
}

/** Vendor name in, bucket out. Falls back to `other`, never to nothing. */
export function guessCategory(text) {
  const haystack = String(text || '');
  if (!haystack.trim()) return 'other';
  const hit = CATEGORIES.find((c) => c.key !== 'other' && c.match.test(haystack));
  return hit ? hit.key : 'other';
}

/* --------------------------------------------------------------- records */

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz023456789';

function newId(length = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export function isExpenseId(id) {
  return /^[a-z0-9]{12}$/.test(String(id || ''));
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export class ExpenseError extends Error {}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** '' is allowed — a row can be saved half-finished and come back to. */
function cleanDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ExpenseError('Date must be YYYY-MM-DD.');
  const parsed = new Date(text + 'T00:00:00Z');
  if (isNaN(parsed)) throw new ExpenseError('That date is not a real date.');
  return text;
}

function cleanAmount(value, label) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!isFinite(n)) throw new ExpenseError(`${label} has to be a number.`);
  if (n < 0) throw new ExpenseError(`${label} cannot be negative.`);
  if (n > MAX_AMOUNT) throw new ExpenseError(`${label} looks like a typo.`);
  return round2(n);
}

/**
 * A row is only "checked" once it carries the three things the CPA needs to
 * book it: when, who, how much. The shop can flip the switch, but not past
 * this — a confirmed row with no total is worse than an unconfirmed one,
 * because nothing on the page flags it again.
 */
function readyToFile(record) {
  return Boolean(record.date && record.vendor && record.amount > 0);
}

/** The record a fresh upload becomes. `draft` is whatever the model read. */
export function buildExpense({ key, file, draft = {}, now = new Date() }) {
  const record = {
    id: newId(),
    key: key || '',
    file: {
      name: cleanText(file?.name, 60) || 'receipt',
      ext: String(file?.ext || ''),
      size: Number(file?.size) || 0,
    },
    date: draft.date || '',
    vendor: cleanText(draft.vendor, 60),
    amount: draft.amount ?? null,
    tax: draft.tax ?? null,
    category: isCategory(draft.category) ? draft.category : 'other',
    payment: '',
    note: cleanText(draft.summary, 200),
    // Always starts unchecked, however confident the model was. The whole
    // safety of this feature is that a person looked at every number.
    checked: false,
    read: Boolean(draft.read),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return record;
}

/** Applies an edit from the page. Throws ExpenseError on anything unusable. */
export function applyEdit(record, patch, now = new Date()) {
  const next = { ...record };

  if ('date' in patch) next.date = cleanDate(patch.date);
  if ('vendor' in patch) next.vendor = cleanText(patch.vendor, 60);
  if ('amount' in patch) next.amount = cleanAmount(patch.amount, 'Amount');
  if ('tax' in patch) next.tax = cleanAmount(patch.tax, 'Sales tax');
  if ('payment' in patch) next.payment = cleanText(patch.payment, 40);
  if ('note' in patch) next.note = cleanText(patch.note, 200);

  if ('category' in patch) {
    const category = String(patch.category || '').trim();
    if (!isCategory(category)) throw new ExpenseError('Pick a category from the list.');
    next.category = category;
  }

  if (patch.checked === true && !readyToFile(next)) {
    throw new ExpenseError('Needs a date, a vendor and an amount before it can be checked off.');
  }
  if ('checked' in patch) next.checked = patch.checked === true;

  next.updatedAt = now.toISOString();
  return next;
}

/**
 * What rides in the KV key's metadata so a year lists in one call.
 *
 * This is every field the ledger table and the CPA report draw, which is what
 * makes both of them one list call instead of one read per receipt. It fits:
 * metadata is capped at 1,024 bytes per key, and the three free-text fields are
 * clipped on the way in at 60, 40 and 200 characters — under 400 bytes of JSON
 * with everything full. The stored record stays the book of record; this is a
 * copy of it, rewritten on every save.
 */
function summarize(record) {
  return {
    id: record.id,
    date: record.date,
    vendor: record.vendor,
    amount: record.amount,
    tax: record.tax,
    category: record.category,
    payment: record.payment,
    note: record.note,
    checked: record.checked,
    key: record.key,
    ext: record.file?.ext || '',
    // The name the shop's phone gave it. Worth carrying because it is the one
    // column the CPA can use to find the original file in a folder of them.
    fileName: record.file?.name || '',
  };
}

/* --------------------------------------------------------------- storage */

export async function putExpense(env, record) {
  await env.EXPENSES.put(KEY_PREFIX + record.id, JSON.stringify(record), {
    metadata: summarize(record),
  });
  return record;
}

export async function getExpense(env, id) {
  if (!isExpenseId(id)) return null;
  const raw = await env.EXPENSES.get(KEY_PREFIX + id);
  return raw ? JSON.parse(raw) : null;
}

export async function deleteExpense(env, id) {
  if (!isExpenseId(id)) return null;
  const record = await getExpense(env, id);
  if (!record) return null;
  await env.EXPENSES.delete(KEY_PREFIX + id);
  return record;
}

/**
 * Every receipt on file, newest first, as summaries.
 *
 * Reads the whole ledger rather than a year at a time. The key can't carry the
 * date — the shop corrects a misread date often enough that keying on it would
 * mean deleting and re-writing the record on an ordinary edit, and a crash
 * between the two loses the receipt. A few hundred receipts a year is one list
 * call; the cursor loop is there for the year this shop gets big.
 */
export async function listExpenses(env) {
  const out = [];
  let cursor;

  do {
    const result = await env.EXPENSES.list({ prefix: KEY_PREFIX, limit: PAGE_SIZE, cursor });
    for (const key of result.keys) {
      if (key.metadata) out.push(key.metadata);
    }
    cursor = result.list_complete ? null : result.cursor;
  } while (cursor);

  return out.sort(byDateDesc);
}

/**
 * Undated rows sort to the top, not the bottom. They are the ones still waiting
 * on somebody, and the point of the page is to surface exactly those.
 */
function byDateDesc(a, b) {
  if (!a.date && !b.date) return 0;
  if (!a.date) return -1;
  if (!b.date) return 1;
  return String(b.date).localeCompare(String(a.date));
}

/* ---------------------------------------------------------------- totals */

export function yearOf(record) {
  return String(record?.date || '').slice(0, 4);
}

/** Every year with a receipt in it, newest first, always including this one. */
export function yearsPresent(records, now = new Date()) {
  const years = new Set(records.map(yearOf).filter(Boolean));
  years.add(String(now.getUTCFullYear()));
  return [...years].sort().reverse();
}

/**
 * Undated receipts belong to no year, so they would vanish from every year page
 * — which is the one thing that must not happen to a receipt nobody has
 * finished. They ride along with whichever year is being shown instead, and the
 * page counts them separately so they can't be mistaken for filed spending.
 */
export function forYear(records, year) {
  const wanted = String(year);
  return records.filter((r) => yearOf(r) === wanted || !r.date);
}

export function totals(records) {
  const dated = records.filter((r) => r.date);
  const undated = records.filter((r) => !r.date);

  const byCategory = new Map();
  const byMonth = new Map();
  let total = 0;
  let tax = 0;

  for (const r of dated) {
    const amount = Number(r.amount) || 0;
    total += amount;
    tax += Number(r.tax) || 0;
    byCategory.set(r.category, (byCategory.get(r.category) || 0) + amount);
    const month = String(r.date).slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + amount);
  }

  const categories = CATEGORIES
    .map((c) => ({ key: c.key, label: c.label, amount: round2(byCategory.get(c.key) || 0) }))
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const months = [...byMonth.entries()]
    .map(([month, amount]) => ({ month, amount: round2(amount) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    total: round2(total),
    tax: round2(tax),
    count: dated.length,
    categories,
    months,
    undated: undated.length,
    unchecked: records.filter((r) => !r.checked).length,
    missingAmount: dated.filter((r) => !(Number(r.amount) > 0)).length,
  };
}

/* ------------------------------------------------------------------- csv */

/**
 * A leading =, +, - or @ makes Excel treat a cell as a formula, and these open
 * on the CPA's machine. Quoting alone doesn't stop it — the apostrophe does.
 */
function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_COLUMNS = [
  'Date', 'Vendor', 'Category', 'Amount', 'Sales tax', 'Paid with', 'Note',
  'Checked', 'Receipt file', 'Receipt id',
];

/** Chronological, because that is the order a set of books gets read in. */
export function expensesCsv(records) {
  const rows = [...records].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([
      r.date || '',
      r.vendor || '',
      categoryLabel(r.category),
      r.amount === null || r.amount === undefined ? '' : Number(r.amount).toFixed(2),
      r.tax === null || r.tax === undefined ? '' : Number(r.tax).toFixed(2),
      r.payment || '',
      r.note || '',
      r.checked ? 'yes' : 'NEEDS CHECKING',
      // Listed rows carry the name flat; a whole record nests it under file.
      r.fileName || r.file?.name || '',
      r.id,
    ].map(csvCell).join(','));
  }

  // \r\n and a trailing newline: Excel is the reader here, not a parser.
  return lines.join('\r\n') + '\r\n';
}

/* --------------------------------------------------------------- the page */

export function renderExpensesPage(records, { year, years, sums, railCounts = {} } = {}) {
  const rows = forYear(records, year);

  return `<div class="shell">
  ${renderRail({ ...railCounts, active: 'expenses' })}
  <main class="main">
    <header class="topbar">
      <div class="topleft">
        <h1>Receipts</h1>
        <p class="sub">${esc(String(year))} &middot; ${sums.count} filed${
          sums.undated ? ` &middot; ${sums.undated} undated` : ''
        }</p>
      </div>
      <div class="topright">
        <div class="chips">${
          years.map((y) => `<a class="chip${String(y) === String(year) ? ' on' : ''}" href="?year=${esc(y)}">${esc(y)}</a>`).join('')
        }</div>
        <a class="btn ghost" href="/dashboard/expenses.csv?year=${esc(String(year))}">CSV</a>
        <a class="btn" href="/dashboard/expenses/report?year=${esc(String(year))}" target="_blank" rel="noopener">CPA report</a>
      </div>
    </header>
    <div class="pad">
      ${renderKpis(sums, year)}
      ${renderUpload()}
      ${renderLedger(rows)}
    </div>
  </main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`;
}

function renderKpis(sums, year) {
  const top = sums.categories[0];

  const tiles = [
    {
      label: `Spent in ${year}`,
      value: money(sums.total, 'usd'),
      note: `${sums.count} receipt${sums.count === 1 ? '' : 's'}`,
      accent: true,
    },
    {
      label: 'Sales tax paid',
      value: money(sums.tax, 'usd'),
      note: 'Where it was written on the receipt',
    },
    {
      label: 'Biggest bucket',
      value: top ? money(top.amount, 'usd') : '—',
      note: top ? top.label : 'Nothing filed yet',
    },
    {
      label: 'Needs checking',
      value: String(sums.unchecked),
      note: sums.unchecked ? 'Confirm before the report goes out' : 'All confirmed',
      flag: sums.unchecked > 0,
    },
  ];

  return `<section class="kpis">${tiles.map((t) => `
    <div class="kpi${t.accent ? ' accent' : ''}">
      <p class="kpilabel">${esc(t.label)}</p>
      <p class="kpivalue">${esc(t.value)}</p>
      <p class="kpinote${t.flag ? ' flag' : ''}">${esc(t.note)}</p>
    </div>`).join('')}</section>`;
}

function renderUpload() {
  return `<section class="card" id="capture">
    <div class="cardhead">
      <h2>Add receipts</h2>
      <span class="cardnote">JPG, PNG, WEBP, GIF, HEIC or PDF &middot; up to 10 MB each</span>
    </div>
    <p class="hint">Photograph the receipt and drop it here, or drop in a PDF invoice.
      The reader fills in the vendor, date and total where it can — check every one of
      them before it counts. A scanned PDF with no text in it, and any HEIC, gets stored
      but not read; type those in.</p>
    <label class="drop" id="drop">
      <input type="file" id="files" accept="image/*,application/pdf" multiple capture="environment" hidden>
      <span class="dropmain">Choose files or drag them here</span>
      <span class="dropsub">One receipt per file</span>
    </label>
    <ul class="uploads" id="uploads"></ul>
  </section>`;
}

function renderLedger(rows) {
  return `<section class="card" id="ledger">
    <div class="cardhead">
      <h2>The ledger</h2>
      <span class="cardnote">Edit any cell, then Save</span>
    </div>
    ${rows.length ? '' : '<p class="empty">No receipts for this year yet.</p>'}
    <div class="scroll">
      <table class="grid ledger">
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Date</th>
            <th>Vendor</th>
            <th>Category</th>
            <th class="num">Amount</th>
            <th class="num">Tax</th>
            <th>Paid with</th>
            <th>Note</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="rows">${rows.map((r) => renderRow(r)).join('')}</tbody>
      </table>
    </div>
    ${/* The shape a just-uploaded row is cloned from. Empty on purpose — the
          script fills it in through .value and .textContent, so nothing the
          model read off a receipt is ever parsed as markup. */ ''}
    <template id="rowtemplate">${renderRow(BLANK_ROW, { template: true })}</template>
  </section>`;
}

const BLANK_ROW = {
  id: '', key: '', ext: '', date: '', vendor: '', category: 'other',
  amount: null, tax: null, payment: '', note: '', checked: false,
};

function categoryOptions(selected) {
  return CATEGORIES.map((c) =>
    `<option value="${c.key}"${c.key === selected ? ' selected' : ''}>${esc(c.label)}</option>`
  ).join('');
}

function renderRow(r, { template = false } = {}) {
  const amount = r.amount === null || r.amount === undefined ? '' : Number(r.amount).toFixed(2);
  const tax = r.tax === null || r.tax === undefined ? '' : Number(r.tax).toFixed(2);

  const thumb = r.key
    ? `<a href="/receipt/${esc(r.key)}" target="_blank" rel="noopener" class="thumb">${
      r.ext === 'pdf' ? '<span class="pdf">PDF</span>' : `<img src="/receipt/${esc(r.key)}" alt="" loading="lazy">`
    }</a>`
    // The template's link is built by the script; a placeholder here would be
    // left behind beside it.
    : (template ? '' : '<span class="pdf">—</span>');

  return `<tr data-id="${esc(r.id)}" class="${r.checked ? 'done' : 'review'}">
    <td class="c-file" data-label="Receipt">
      ${thumb}
      <label class="checkoff" title="Checked and correct">
        <input type="checkbox" data-field="checked"${r.checked ? ' checked' : ''}>
        <span>${r.checked ? 'Checked' : 'Check'}</span>
      </label>
    </td>
    <td data-label="Date"><input type="date" data-field="date" value="${esc(r.date || '')}"></td>
    <td data-label="Vendor"><input type="text" data-field="vendor" value="${esc(r.vendor || '')}" maxlength="60" placeholder="Who you paid"></td>
    <td data-label="Category"><select data-field="category">${categoryOptions(r.category)}</select></td>
    <td class="num" data-label="Amount"><input type="text" inputmode="decimal" class="num" data-field="amount" value="${esc(amount)}" placeholder="0.00"></td>
    <td class="num" data-label="Tax"><input type="text" inputmode="decimal" class="num" data-field="tax" value="${esc(tax)}" placeholder=""></td>
    <td data-label="Paid with"><input type="text" data-field="payment" value="${esc(r.payment || '')}" maxlength="40" placeholder="Card, cash"></td>
    <td data-label="Note"><input type="text" data-field="note" value="${esc(r.note || '')}" maxlength="200"></td>
    <td class="rowacts">
      <button type="button" class="btn tiny save" data-act="save">Save</button>
      <button type="button" class="qdrop" data-act="delete" title="Delete this receipt">&times;</button>
    </td>
  </tr>`;
}

/* ------------------------------------------------------------- the report */

/**
 * The year-end packet. One page the shop prints to PDF and sends: what was
 * spent, split the way the shop spends it, then every receipt line by line, and
 * optionally the receipt images themselves behind it.
 *
 * Spending only, and it says so on its face. It is not a profit and loss and
 * must never read like one — no sales, no margin, nothing subtracted from
 * anything. Every number on this page comes off a receipt somebody photographed.
 */
export function renderExpenseReport(records, { year, sums, images = false } = {}) {
  const rows = [...forYear(records, year)]
    .filter((r) => r.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const pct = (amount) => (sums.total > 0 ? Math.round((amount / sums.total) * 1000) / 10 : 0);

  const warnings = [];
  if (sums.unchecked) warnings.push(`${sums.unchecked} receipt${sums.unchecked === 1 ? ' has' : 's have'} not been checked off yet.`);
  if (sums.undated) warnings.push(`${sums.undated} receipt${sums.undated === 1 ? '' : 's'} still ${sums.undated === 1 ? 'has' : 'have'} no date and ${sums.undated === 1 ? 'is' : 'are'} not counted below.`);
  if (sums.missingAmount) warnings.push(`${sums.missingAmount} dated receipt${sums.missingAmount === 1 ? '' : 's'} ${sums.missingAmount === 1 ? 'has' : 'have'} no amount on ${sums.missingAmount === 1 ? 'it' : 'them'}.`);

  return `<div class="sheet">
  <div class="noprint bar">
    <button type="button" class="btn" onclick="window.print()">Print / save as PDF</button>
    <a class="btn ghost" href="/dashboard/expenses.csv?year=${esc(String(year))}">Download CSV</a>
    <a class="btn ghost" href="/dashboard/expenses/report?year=${esc(String(year))}${images ? '' : '&images=1'}">${
      images ? 'Without receipt images' : 'With receipt images'
    }</a>
    <a class="btn ghost" href="/dashboard/expenses?year=${esc(String(year))}">Back to receipts</a>
  </div>

  <header class="rhead">
    <div>
      <h1>Business expenses &middot; ${esc(String(year))}</h1>
      <p class="rsub">Rawhide City Leather &middot; prepared ${esc(shortDate(new Date().toISOString()))}</p>
    </div>
    <div class="rtotal">
      <span>Total receipts on file</span>
      <strong>${esc(money(sums.total, 'usd'))}</strong>
      <span>${sums.count} receipt${sums.count === 1 ? '' : 's'}</span>
    </div>
  </header>

  <p class="rnote">Money out only — this is not a profit and loss, and there are no
    sales figures in it. The buckets are the shop's own, taken from the receipts
    themselves; they are not tax categories, and which line each one belongs on is the
    accountant's call. Sales tax shown is what was printed on the receipt.</p>

  ${warnings.length ? `<div class="rwarn"><strong>Before you send this:</strong><ul>${
    warnings.map((w) => `<li>${esc(w)}</li>`).join('')
  }</ul></div>` : ''}

  <section>
    <h2>By category</h2>
    <table class="rtable">
      <thead><tr><th>Category</th><th class="num">Amount</th><th class="num">Share</th></tr></thead>
      <tbody>${sums.categories.map((c) => `<tr>
        <td>${esc(c.label)}</td>
        <td class="num">${esc(money(c.amount, 'usd'))}</td>
        <td class="num">${pct(c.amount).toFixed(1)}%</td>
      </tr>`).join('')}</tbody>
      <tfoot><tr>
        <td>Total</td>
        <td class="num">${esc(money(sums.total, 'usd'))}</td>
        <td class="num">100%</td>
      </tr></tfoot>
    </table>
  </section>

  ${sums.months.length ? `<section>
    <h2>By month</h2>
    <table class="rtable">
      <thead><tr><th>Month</th><th class="num">Amount</th></tr></thead>
      <tbody>${sums.months.map((m) => `<tr>
        <td>${esc(monthName(m.month))}</td>
        <td class="num">${esc(money(m.amount, 'usd'))}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>` : ''}

  <section class="rbreak">
    <h2>Every receipt</h2>
    <table class="rtable rows">
      <thead><tr>
        <th>Date</th><th>Vendor</th><th>Category</th>
        <th class="num">Amount</th><th class="num">Tax</th><th>Paid with</th><th>Note</th>
      </tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="nowrap">${esc(r.date)}</td>
        <td>${esc(r.vendor || '—')}</td>
        <td>${esc(categoryLabel(r.category))}</td>
        <td class="num">${r.amount ? esc(money(r.amount, 'usd')) : '—'}</td>
        <td class="num">${r.tax ? esc(money(r.tax, 'usd')) : ''}</td>
        <td>${esc(r.payment || '')}</td>
        <td class="rnotecell">${esc(r.note || '')}</td>
      </tr>`).join('')}</tbody>
    </table>
  </section>

  ${images ? renderImageSheet(rows) : ''}
</div>`;
}

function monthName(key) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return String(key);
  return new Date(Date.UTC(y, m - 1, 1))
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The images ride at the back of the same document on purpose: printed to PDF
 * from a logged-in browser, the summary and the proof travel as one file. A PDF
 * receipt has no thumbnail to print, so it is listed rather than shown.
 */
function renderImageSheet(rows) {
  const shown = rows.filter((r) => r.key && r.ext !== 'pdf');
  const pdfs = rows.filter((r) => r.key && r.ext === 'pdf');

  return `<section class="rbreak">
    <h2>The receipts</h2>
    <div class="shots">${shown.map((r) => `<figure>
      <img src="/receipt/${esc(r.key)}" alt="Receipt from ${esc(r.vendor || 'unknown vendor')}" loading="lazy">
      <figcaption>${esc(r.date)} &middot; ${esc(r.vendor || '—')} &middot; ${
        r.amount ? esc(money(r.amount, 'usd')) : '—'
      }</figcaption>
    </figure>`).join('')}</div>
    ${pdfs.length ? `<p class="rfine">${pdfs.length} receipt${pdfs.length === 1 ? ' is a PDF and is' : 's are PDFs and are'} not
      shown here: ${pdfs.map((r) => esc(`${r.date} ${r.vendor || ''}`.trim())).join('; ')}.</p>` : ''}
  </section>`;
}

/* ------------------------------------------------------------------ styles */

export const EXPENSE_STYLES = DASHBOARD_STYLES + `
.drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;
  padding:26px 20px;border:1.5px dashed var(--line-2);border-radius:3px;background:#FBFAF7;
  cursor:pointer;text-align:center}
.drop:hover,.drop.over{border-color:var(--ink);background:var(--bg)}
.dropmain{font-family:var(--display);text-transform:uppercase;letter-spacing:.14em;font-size:11.5px}
.dropsub{font-size:12px;color:var(--soft)}

.uploads{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.uploads li{display:flex;align-items:center;gap:10px;font-size:12.5px;padding:7px 10px;
  border:1px solid var(--line);border-radius:2px;background:var(--paper)}
.uploads li .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:22rem}
.uploads li .state{color:var(--soft);margin-left:auto}
.uploads li.err{background:var(--bad-bg);color:var(--bad);border-color:var(--bad)}
.uploads li.ok .state{color:var(--good)}

table.ledger td{vertical-align:middle}
table.ledger input,table.ledger select{font:inherit;font-size:12.5px;padding:6px 8px;
  border:1px solid var(--line-2);border-radius:2px;background:var(--paper);color:var(--ink);
  width:100%;min-width:0}
table.ledger input:focus,table.ledger select:focus{outline:2px solid var(--ink);outline-offset:-1px}
table.ledger input.num{text-align:right;font-variant-numeric:tabular-nums}
/* Nine columns of form controls have to fit the main area beside the rail —
   about 950px on a 1280 laptop. These add up to just under that, so the row
   reads without the horizontal scrollbar; the .scroll wrapper is still there
   for anything narrower that hasn't yet reached the stacked layout below.
   A date input needs ~8rem before the browser's own picker starts clipping. */
table.ledger td[data-label="Date"]{width:8rem}
table.ledger td[data-label="Vendor"]{width:8rem}
table.ledger td[data-label="Category"]{width:9rem}
table.ledger td[data-label="Amount"]{width:5.5rem}
table.ledger td[data-label="Tax"]{width:4.75rem}
table.ledger td[data-label="Paid with"]{width:6.5rem}
table.ledger td[data-label="Note"]{min-width:8rem}
table.ledger tr.review{background:#FDFBF3}
table.ledger tr.review:hover{background:#FAF6E9}
table.ledger tr.dirty td{box-shadow:inset 0 -2px 0 var(--warn)}
.c-file{width:4.5rem}
.thumb{display:block;width:60px;height:52px;border:1px solid var(--line-2);border-radius:2px;
  overflow:hidden;background:var(--bg)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.pdf{display:flex;align-items:center;justify-content:center;width:60px;height:52px;
  border:1px solid var(--line-2);border-radius:2px;background:var(--bg);color:var(--soft);
  font-family:var(--display);font-size:11px;letter-spacing:.1em}
.checkoff{display:flex;align-items:center;gap:5px;margin-top:6px;cursor:pointer;
  font-family:var(--display);text-transform:uppercase;letter-spacing:.1em;font-size:9px;color:var(--soft)}
.checkoff input{width:14px;height:14px;accent-color:#0F0F0F;cursor:pointer;flex:0 0 auto}
tr.done .checkoff{color:var(--good)}
.rowacts{white-space:nowrap;width:5rem}
.rowacts .qdrop{vertical-align:middle}

/* Below this the row stops being a table row and becomes a card. Set at 1040px
   rather than a phone width on purpose: nine inputs are unusable long before
   the screen is small, and squeezing a vendor field down to four characters is
   how a receipt gets filed against the wrong shop. */
@media screen and (max-width:1040px){
  #ledger .scroll{overflow-x:visible}
  table.ledger,table.ledger tbody{display:block}
  table.ledger thead{display:none}
  table.ledger tr{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px 12px;
    padding:12px;margin-bottom:12px;border:1px solid var(--line);border-radius:2px}
  table.ledger td{display:block;border:0;padding:0;width:auto!important;min-width:0}
  table.ledger td.c-file{grid-row:1/4}
  table.ledger td[data-label]::before{content:attr(data-label);display:block;
    font-family:var(--display);font-size:9px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--soft);margin-bottom:2px}
  table.ledger td.rowacts{grid-column:1/-1;display:flex;gap:8px;align-items:center;
    padding-top:4px;border-top:1px solid var(--line)}
}
`;

/** The printed packet. Deliberately not the dashboard's chrome. */
export const REPORT_STYLES = `
@page{margin:16mm}
:root{--ink:#0F0F0F;--soft:#5C574E;--line:rgba(15,15,15,.16);
  --display:'Oswald','Arial Narrow',sans-serif;
  --body:'Segoe UI',system-ui,-apple-system,sans-serif;
  --warn:#7A5C14;--warn-bg:#F5EDD8}
*{box-sizing:border-box}
body{margin:0;background:#EFEDE7;color:var(--ink);font-family:var(--body);font-size:13px;line-height:1.5}
.sheet{max-width:8.5in;margin:0 auto;background:#fff;padding:30px 34px 44px}
h1,h2{font-family:var(--display);text-transform:uppercase;margin:0;font-weight:600}
h1{font-size:22px;letter-spacing:.09em}
h2{font-size:12px;letter-spacing:.2em;margin:26px 0 9px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.nowrap{white-space:nowrap}

.bar{display:flex;gap:8px;flex-wrap:wrap;max-width:8.5in;margin:0 auto 14px;padding:14px 0 0}
.btn{font-family:var(--display);text-transform:uppercase;letter-spacing:.14em;font-size:10.5px;
  padding:9px 16px;border:1.5px solid var(--ink);background:var(--ink);color:#EBE8E1;
  cursor:pointer;border-radius:2px;text-decoration:none;display:inline-block}
.btn.ghost{background:#fff;color:var(--ink)}

.rhead{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
  padding-bottom:14px;border-bottom:2px solid var(--ink)}
.rsub{margin:5px 0 0;color:var(--soft);font-size:12px}
.rtotal{text-align:right;display:flex;flex-direction:column;gap:2px}
.rtotal span{font-size:10.5px;color:var(--soft);font-family:var(--display);
  text-transform:uppercase;letter-spacing:.14em}
.rtotal strong{font-family:var(--display);font-size:27px;font-variant-numeric:tabular-nums}
.rnote{color:var(--soft);font-size:12px;margin:12px 0 0;max-width:70ch}
.rfine{color:var(--soft);font-size:11.5px;margin:7px 0 0;max-width:70ch}
.rwarn{margin:14px 0 0;padding:10px 13px;background:var(--warn-bg);color:var(--warn);
  border-left:3px solid var(--warn);font-size:12px}
.rwarn ul{margin:5px 0 0;padding-left:18px}

.rtable{width:100%;border-collapse:collapse;margin-top:4px}
.rtable th,.rtable td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
.rtable thead th{font-family:var(--display);text-transform:uppercase;letter-spacing:.13em;
  font-size:9px;color:var(--soft)}
.rtable tfoot td{font-weight:700;border-top:1.5px solid var(--ink);border-bottom:0}
.rtable.rows{font-size:12px}
.rnotecell{color:var(--soft)}

.shots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:10px}
.shots figure{margin:0;border:1px solid var(--line);border-radius:2px;overflow:hidden;
  break-inside:avoid;page-break-inside:avoid}
.shots img{width:100%;display:block;background:#EFEDE7}
.shots figcaption{font-size:11px;padding:6px 8px;color:var(--soft);border-top:1px solid var(--line)}

@media print{
  body{background:#fff}
  .sheet{max-width:none;padding:0}
  .noprint{display:none}
  .rbreak{break-before:page;page-break-before:always}
  .rtable tr{break-inside:avoid;page-break-inside:avoid}
  thead{display:table-header-group}
}
`;

/* ------------------------------------------------------------------ client */

export const EXPENSES_SCRIPT = `
const rowsBody = document.getElementById('rows');
const uploads = document.getElementById('uploads');
const drop = document.getElementById('drop');
const filesInput = document.getElementById('files');
const toastBox = document.getElementById('toast');
let toastTimer;

function toast(message, bad) {
  toastBox.textContent = message;
  toastBox.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastBox.className = 'toast'; }, 4200);
}

function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rawhide-dashboard': '1' },
    body: JSON.stringify(body),
  }).then(function (res) { return res.json().then(function (data) { return { res: res, data: data }; }); });
}

/* ------------------------------------------------------------------ upload */

drop.addEventListener('click', function () { filesInput.click(); });
filesInput.addEventListener('change', function () {
  send(Array.from(filesInput.files || []));
  filesInput.value = '';
});

['dragenter', 'dragover'].forEach(function (name) {
  drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.add('over'); });
});
['dragleave', 'drop'].forEach(function (name) {
  drop.addEventListener(name, function (e) { e.preventDefault(); drop.classList.remove('over'); });
});
drop.addEventListener('drop', function (e) {
  send(Array.from((e.dataTransfer && e.dataTransfer.files) || []));
});

/**
 * One at a time, not all at once. Each upload holds a whole image in the
 * Worker's memory and waits on the model; a dozen fired together is how you
 * find that ceiling on the day of the year the receipts get done.
 */
async function send(files) {
  for (const file of files) {
    const line = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name;
    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = 'Reading…';
    line.appendChild(name);
    line.appendChild(state);
    uploads.prepend(line);

    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/dashboard/api/receipt', {
        method: 'POST',
        headers: { 'x-rawhide-dashboard': '1' },
        body: form,
      });
      const data = await res.json();

      if (!res.ok || !data.record) {
        line.className = 'err';
        state.textContent = data.error || 'Upload failed';
        continue;
      }

      line.className = 'ok';
      state.textContent = data.record.read ? 'Read — check it' : 'Stored — fill it in';
      addRow(data.record);
      retotal();
    } catch (err) {
      line.className = 'err';
      state.textContent = 'Upload failed';
    }
  }
}

/**
 * Built from the same empty markup for every row, with the values assigned
 * afterwards rather than pasted into a string — a vendor name the model read
 * off a receipt is untrusted text, and it is about to sit in our own page.
 */
function addRow(record) {
  const template = document.querySelector('#rowtemplate');
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.id = record.id;
  row.className = record.checked ? 'done' : 'review';

  const cell = row.querySelector('.c-file');
  if (record.key) {
    const link = document.createElement('a');
    link.className = 'thumb';
    link.href = '/receipt/' + record.key;
    link.target = '_blank';
    link.rel = 'noopener';
    if (record.file && record.file.ext === 'pdf') {
      const tag = document.createElement('span');
      tag.className = 'pdf';
      tag.textContent = 'PDF';
      link.appendChild(tag);
    } else {
      const img = document.createElement('img');
      img.src = '/receipt/' + record.key;
      img.alt = '';
      link.appendChild(img);
    }
    cell.prepend(link);
  }

  set(row, 'date', record.date || '');
  set(row, 'vendor', record.vendor || '');
  set(row, 'category', record.category || 'other');
  set(row, 'amount', record.amount == null ? '' : Number(record.amount).toFixed(2));
  set(row, 'tax', record.tax == null ? '' : Number(record.tax).toFixed(2));
  set(row, 'payment', record.payment || '');
  set(row, 'note', record.note || '');

  rowsBody.prepend(row);
  const empty = document.querySelector('#ledger .empty');
  if (empty) empty.remove();
}

function set(row, field, value) {
  const input = row.querySelector('[data-field="' + field + '"]');
  if (input) input.value = value;
}

/* -------------------------------------------------------------- edit + save */

rowsBody.addEventListener('input', function (e) {
  const row = e.target.closest('tr');
  if (row) row.classList.add('dirty');
});

rowsBody.addEventListener('click', function (e) {
  const button = e.target.closest('[data-act]');
  if (!button) return;
  const row = button.closest('tr');
  if (button.dataset.act === 'save') save(row, button);
  if (button.dataset.act === 'delete') remove(row, button);
});

function fields(row) {
  const out = {};
  row.querySelectorAll('[data-field]').forEach(function (input) {
    out[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
  });
  return out;
}

async function save(row, button) {
  const body = fields(row);
  body.id = row.dataset.id;
  button.disabled = true;

  try {
    const { res, data } = await post('/dashboard/api/expense', body);
    if (!res.ok) {
      toast(data.error || 'Could not save that.', true);
      return;
    }
    row.classList.remove('dirty');
    row.className = data.record.checked ? 'done' : 'review';
    const label = row.querySelector('.checkoff span');
    if (label) label.textContent = data.record.checked ? 'Checked' : 'Check';
    retotal();
    toast('Saved.');
  } catch (err) {
    toast('Could not reach the server.', true);
  } finally {
    button.disabled = false;
  }
}

async function remove(row, button) {
  if (!confirm('Delete this receipt and its photo? This cannot be undone.')) return;
  button.disabled = true;

  try {
    const { res, data } = await post('/dashboard/api/expense/delete', { id: row.dataset.id });
    if (!res.ok) {
      toast(data.error || 'Could not delete that.', true);
      button.disabled = false;
      return;
    }
    row.remove();
    retotal();
    toast('Deleted.');
  } catch (err) {
    toast('Could not reach the server.', true);
    button.disabled = false;
  }
}

/**
 * Keeps the tiles honest between saves. Only what is on screen is counted, and
 * only rows carrying a date — the same rule the server applies, so a refresh
 * shows the same numbers this does.
 */
function retotal() {
  let total = 0;
  let tax = 0;
  let filed = 0;
  let unchecked = 0;

  rowsBody.querySelectorAll('tr').forEach(function (row) {
    const values = fields(row);
    const amount = parseFloat(String(values.amount).replace(/[$,\\s]/g, ''));
    if (!values.checked) unchecked++;
    if (!values.date) return;
    filed++;
    if (isFinite(amount)) total += amount;
    const t = parseFloat(String(values.tax).replace(/[$,\\s]/g, ''));
    if (isFinite(t)) tax += t;
  });

  const tiles = document.querySelectorAll('.kpi');
  if (tiles[0]) {
    tiles[0].querySelector('.kpivalue').textContent = usd(total);
    tiles[0].querySelector('.kpinote').textContent = filed + (filed === 1 ? ' receipt' : ' receipts');
  }
  if (tiles[1]) tiles[1].querySelector('.kpivalue').textContent = usd(tax);
  if (tiles[3]) {
    tiles[3].querySelector('.kpivalue').textContent = String(unchecked);
    const note = tiles[3].querySelector('.kpinote');
    note.textContent = unchecked ? 'Confirm before the report goes out' : 'All confirmed';
    note.className = 'kpinote' + (unchecked ? ' flag' : '');
  }
}

function usd(value) {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
`;
