/**
 * The dashboard's "Build list" card: every piece still owed, one row per
 * product, with the options the customer picked written out beside it.
 *
 * The ship queue answers "which box goes out next" and lists an order as
 * "1× Fully Custom Radio Strap". What that strap actually is — the leather, the
 * stitch, the name stamped into it — was a click away on each order's packing
 * slip. This is those build sheets laid end to end, so a day at the bench can
 * be planned off one list instead of a stack of slips.
 *
 * Two arrangements of the same rows, and a pair of chips to pick between them:
 *
 *   by product    every helmet band together, then every strap — for cutting
 *                 and dyeing in batches. Products run in the order their most
 *                 urgent piece is due, and each product's rows run soonest
 *                 first.
 *   by ship date  one list straight down, soonest first. The ship queue's own
 *                 order, with each order opened up into its pieces.
 *
 * Both are drawn on the server and the chips only swap which one shows, so the
 * list reads the same with or without the script.
 *
 * The date on a piece is its ORDER's ship-by date — the one the ship queue
 * prints for that order. The box ships as one box (see orderShipBy in lib.js),
 * so a strap riding along with a helmet band is owed when the band is. Its own
 * six weeks still print on the packing slip.
 *
 * A job billed off a quote carries nothing on its Snipcart item but the quote's
 * id; what was actually agreed sits in the quote record. loadBuildQuotes reads
 * those records for the jobs still on the bench so their lines and build notes
 * can be written out here too.
 */

import { esc, tinyDate, orderShipBy, dueCountdown } from './lib.js';
import { itemFields, calloutLabel, linkify } from './slip.js';
import { QUOTE_ITEM_PREFIX, isQuoteId, getQuote } from './quote.js';

/**
 * Quote records read per page load, at most. Each one is a KV read, and more
 * crew jobs than this on the bench at once is not a week this shop has had.
 * Past the cap a job still gets its row; it links to its sheet instead.
 */
const QUOTE_READS = 12;

/** Where the browser remembers which arrangement was last picked. */
export const BUILD_VIEW_KEY = 'rawhide:build-view';

const VIEWS = [
  { key: 'product', label: 'By product' },
  { key: 'date', label: 'By ship date' },
];

/* ------------------------------------------------------------------ pieces */

/** The quote a line item was billed from, or '' for a catalog item. */
function quoteIdOf(item) {
  const id = String(item?.id || '');
  if (!id.startsWith(QUOTE_ITEM_PREFIX)) return '';
  const rest = id.slice(QUOTE_ITEM_PREFIX.length);
  return isQuoteId(rest) ? rest : '';
}

/** Never less than one: a line with a mangled quantity is still a piece owed. */
function quantityOf(value) {
  const n = Math.floor(Number(value));
  return n >= 1 ? n : 1;
}

/**
 * How many things a quote's lines add up to. Zero when the lines aren't in
 * hand — the record wasn't read, so there is a job but no honest count of it.
 */
function quoteCount(quote) {
  const lines = Array.isArray(quote?.lines) ? quote.lines : [];
  return lines.reduce((n, line) => n + quantityOf(line?.quantity), 0);
}

/**
 * One entry per thing to make, soonest first.
 *
 * `queue` has to arrive the way analyze() sorts it. This deliberately does not
 * sort again: one definition of "next" is what keeps this card and the ship
 * queue from ever disagreeing about it.
 *
 * `cashJobs` are paid cash quotes not yet handed over. They never reach
 * Snipcart and have no lead time to date them by, so they ride at the bottom,
 * the same place the ship queue puts them.
 *
 * `quotes` is a Map of full quote records by id — see loadBuildQuotes.
 */
export function buildPieces(queue = [], { cashJobs = [], quotes = new Map() } = {}) {
  const pieces = [];

  for (const order of queue) {
    if (!order) continue;
    const items = Array.isArray(order.items) ? order.items : [];
    // The order's own date: orderShipBy over the same items the queue dated
    // it by, so the two cards print the same day for the same order.
    const due = orderShipBy({ creationDate: order.creationDate, items });
    const a = order.shippingAddress || order.billingAddress || {};
    const customer = a.fullName || a.name || order.email || '';

    for (const item of items) {
      if (!item) continue;
      const quoteId = quoteIdOf(item);
      const quote = quoteId ? quotes.get(quoteId) || null : null;
      const name = String(item.name || item.id || 'Custom build').trim();

      pieces.push({
        // The catalog id where there is one — a product renamed between two
        // orders is still one product on the bench.
        key: String(item.id || '').trim() || 'name:' + name.toLowerCase(),
        name,
        // A quote job is one line in Snipcart whatever it holds. Its real
        // quantities are on its lines, so it gets no "1×" of its own.
        quantity: quoteId ? 0 : quantityOf(item.quantity),
        // What it adds to the tallies. A quote job nobody could read the
        // lines of still counts as one thing owed, just not as a known number.
        count: quoteId ? quoteCount(quote) || 1 : quantityOf(item.quantity),
        counted: !quoteId || quoteCount(quote) > 0,
        due,
        order,
        customer,
        item,
        quoteId,
        quote,
      });
    }
  }

  for (const job of cashJobs) {
    if (!job) continue;
    const quote = quotes.get(job.id) || null;
    pieces.push({
      key: 'quote:' + job.id,
      // The summary's title is clipped to fit KV metadata; the record's isn't.
      name: String(quote?.title || job.title || 'Custom build').trim(),
      quantity: 0,
      count: quoteCount(quote) || 1,
      counted: quoteCount(quote) > 0,
      due: null,
      job,
      customer: job.customer || '',
      quoteId: isQuoteId(job.id) ? job.id : '',
      quote,
    });
  }

  return pieces;
}

/**
 * The same pieces gathered by product. A Map keeps the order things were first
 * seen in, and the pieces arrive soonest first — so the products come out in
 * the order their most urgent piece is due, with no second sort to disagree
 * with the first.
 */
export function groupPieces(pieces = []) {
  const groups = new Map();
  for (const piece of pieces) {
    let group = groups.get(piece.key);
    if (!group) {
      group = { key: piece.key, name: piece.name, pieces: [], count: 0, counted: true };
      groups.set(piece.key, group);
    }
    group.pieces.push(piece);
    group.count += piece.count;
    // One piece with no known quantity and the heading can't state a total.
    group.counted = group.counted && piece.counted;
  }
  return [...groups.values()];
}

/* ----------------------------------------------------------- quote records */

/**
 * Which quote records the list wants: every quote job still on the bench,
 * most urgent first, so the cap cuts off the ones furthest out.
 */
export function buildQuoteIds(queue = [], cashJobs = []) {
  const ids = [];
  for (const order of queue) {
    for (const item of order?.items || []) {
      const id = quoteIdOf(item);
      if (id) ids.push(id);
    }
  }
  for (const job of cashJobs) {
    if (isQuoteId(job?.id)) ids.push(job.id);
  }
  return [...new Set(ids)].slice(0, QUOTE_READS);
}

/**
 * Full quote records for the jobs on the bench, as a Map by id.
 *
 * Never throws and never rejects. This runs on the dashboard's own request,
 * and a build list missing a crew job's notes is a far smaller problem than a
 * dashboard that won't load: anything it couldn't read is simply absent, and
 * that job's row falls back to a link to its printed sheet.
 */
export async function loadBuildQuotes(env, queue = [], cashJobs = []) {
  const out = new Map();
  try {
    if (!env?.QUOTES) return out;
    const found = await Promise.all(
      buildQuoteIds(queue, cashJobs).map((id) => getQuote(env, id).catch(() => null))
    );
    for (const quote of found) if (quote?.id) out.set(quote.id, quote);
  } catch {
    // Whatever was read before it went wrong still counts.
  }
  return out;
}

/* --------------------------------------------------------------- rendering */

/** A value a customer typed: escaped, web addresses clickable, line breaks kept. */
function shown(value) {
  return linkify(esc(String(value ?? '').trim()))
    // The artwork link opens beside the list rather than on top of it.
    .replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=')
    .replace(/\r?\n/g, '<br>');
}

function qtyTag(quantity) {
  // More than one is the number that gets missed, so it is the loud one.
  return `<span class="pc-qty${quantity > 1 ? ' many' : ''}">${esc(String(quantity))}&times;</span>`;
}

/** How the money came in on a cash job — the same pill the ship queue hangs on it. */
function cashPill(job) {
  return `<span class="pill cash">${job.paidMethod === 'check' ? 'Check' : 'Cash'}</span>`;
}

function dueCell(piece) {
  if (piece.job) {
    return piece.job.paidAt
      ? `<span class="soft">paid ${esc(tinyDate(piece.job.paidAt))}</span>`
      : '<span class="soft">&mdash;</span>';
  }
  if (!piece.due) return '<span class="soft">&mdash;</span>';
  const { label, tone } = dueCountdown(piece.due);
  return `${esc(tinyDate(piece.due))}
      <span class="due${tone ? ' ' + tone : ''}">${esc(label)}</span>`;
}

function sheetLink(quoteId, label) {
  return `<a href="/dashboard/quote-print?id=${esc(quoteId)}" target="_blank" rel="noopener noreferrer"${
    label ? '' : ' class="mono"'
  }>${label || esc(quoteId)}</a>`;
}

function orderCell(piece) {
  if (piece.job) {
    return `${sheetLink(piece.job.id)}
      <span class="soft block">${esc(piece.customer)}</span>${
        piece.job.department ? `<span class="soft block">${esc(piece.job.department)}</span>` : ''
      }`;
  }
  const order = piece.order;
  return `<a class="mono" href="/packing-slip?token=${esc(order.token)}">${esc(order.invoiceNumber || order.token)}</a>
      <span class="soft block">${esc(piece.customer)}</span>${
        piece.quoteId ? `<span class="block pc-sheet">${sheetLink(piece.quoteId, 'Quote sheet &nearr;')}</span>` : ''
      }`;
}

/**
 * Everything about one piece that has to be right before leather gets cut.
 *
 * Split the way the packing slip splits it, by the same test: what is stamped
 * or painted into the piece goes in the callout, the rest in the grid. Nothing
 * a customer picked is dropped or dimmed — "Stitch color: None" is a build
 * instruction, not an empty field.
 */
function renderOptions(piece) {
  const fields = piece.item ? itemFields(piece.item) : { critical: [], specs: [] };

  // The quote's id is all a quote job's item carries. It is already the link
  // beside the row, and the lines below say what the job actually is.
  const specs = fields.specs.filter((f) => !(piece.quoteId
    && String(f.name || '').trim().toLowerCase() === 'quote'
    && String(f.value).trim() === piece.quoteId));

  const grid = specs.map((f) => {
    const value = String(f.value).trim();
    const wide = value.length > 40 || value.includes('\n');
    return `<div class="pc-opt${wide ? ' wide' : ''}"><dt>${esc(f.name || '')}</dt><dd>${shown(value)}</dd></div>`;
  }).join('');

  const lines = (Array.isArray(piece.quote?.lines) ? piece.quote.lines : [])
    .filter((line) => line && String(line.description || '').trim())
    .map((line) => `<li>${qtyTag(quantityOf(line.quantity))} ${esc(String(line.description).trim())}</li>`)
    .join('');

  // Notes typed against the whole order belong to every piece in it — the
  // rows of one order end up under different products.
  const order = piece.order || {};
  const callout = [
    ...fields.critical.map((f) => [calloutLabel(f.name), f.value]),
    ...(piece.quote?.notes ? [['Build notes', piece.quote.notes]] : []),
    ...(order.notes ? [['Order note', order.notes]] : []),
    ...(Array.isArray(order.customFields) ? order.customFields : [])
      .filter((f) => f && String(f.value || '').trim())
      .map((f) => [f.name || 'Order note', f.value]),
  ].map(([label, value]) => `<div class="pc-callrow">
        <span class="pc-calllabel">${esc(label)}</span>
        <span class="pc-callvalue">${shown(value)}</span>
      </div>`).join('');

  if (!grid && !lines && !callout) {
    return piece.quoteId
      ? '<p class="soft pc-none">The lines and build notes are on the quote sheet.</p>'
      : '<p class="soft pc-none">No options on this one.</p>';
  }

  return `${grid ? `<dl class="pc-opts">${grid}</dl>` : ''}${
    lines ? `<ul class="pc-lines">${lines}</ul>` : ''}${
    callout ? `<div class="pc-call">${callout}</div>` : ''}`;
}

/**
 * `titled` is the by-date list, where the row has to say what it is. Under a
 * product heading the name is already above it, so it only comes back when
 * there is a quantity worth repeating it for.
 */
function renderPiece(piece, { titled }) {
  const head = titled
    ? `<p class="pc-name">${piece.quantity ? qtyTag(piece.quantity) + ' ' : ''}${esc(piece.name)}${
        piece.job ? cashPill(piece.job) : ''}</p>`
    : piece.quantity > 1
      ? `<p class="pc-name">${qtyTag(piece.quantity)} ${esc(piece.name)}</p>`
      : '';

  return `<li class="piece">
      <div class="pc-due">${dueCell(piece)}</div>
      <div class="pc-what">${head}${renderOptions(piece)}</div>
      <div class="pc-order">${orderCell(piece)}</div>
    </li>`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The card, or a plain apology in its place.
 *
 * Every other card reads a handful of fields off an order. This one reads all
 * of them — every option, every note — off records somebody else wrote, and a
 * shape it did not expect has to cost this card and nothing else. A throw
 * anywhere under the dashboard route comes out as "Could not reach Snipcart"
 * with the ship queue gone along with it, which is the wrong price for a list
 * that only reads.
 */
export function renderBuildCard(queue = [], cashJobs = [], options = {}) {
  try {
    return drawBuildCard(queue, cashJobs, options);
  } catch (err) {
    console.error('build list could not be drawn:', err);
    return `<section id="build" class="card">
      <div class="cardhead"><h2>Build list</h2></div>
      <p class="banner">
        The build list could not be drawn this time. Nothing else on this page is
        affected: every order is still in the Ship queue below, and its order number
        opens the packing slip with the options on it.
        <code>${esc(err && err.message ? err.message : 'Unexpected error')}</code>
      </p>
    </section>`;
  }
}

function drawBuildCard(queue, cashJobs, { quotes = new Map() } = {}) {
  const pieces = buildPieces(queue, { cashJobs, quotes });

  if (!pieces.length) {
    return `<section id="build" class="card">
      <div class="cardhead"><h2>Build list</h2></div>
      <p class="empty">Nothing to build. Every paid order is out the door.</p>
    </section>`;
  }

  const groups = groupPieces(pieces);
  const total = pieces.reduce((n, piece) => n + piece.count, 0);
  // Counted off the rows, not off what was handed in, so the heading can only
  // ever promise what is actually listed under it.
  const orderCount = new Set(pieces.filter((p) => p.order).map((p) => p.order)).size;
  const jobCount = pieces.filter((p) => p.job).length;
  const note = [
    plural(total, 'piece'),
    orderCount ? plural(orderCount, 'order') : '',
    jobCount ? plural(jobCount, 'cash job') : '',
  ].filter(Boolean).join(' &middot; ');

  const colhead = (what) => `<div class="pieces-head" aria-hidden="true">
        <span>Ship by</span><span>${what}</span><span>Order</span>
      </div>`;

  const byProduct = `${colhead('Options')}
      ${groups.map((group) => `<div class="bgroup">
        <h3 class="bgroup-head"><span>${esc(group.name)}</span>${
          // A cash job is its own heading, so the pill that explains why it
          // has no date and no slip rides up here with the name.
          group.pieces[0].job ? cashPill(group.pieces[0].job) : ''
        }${
          group.counted ? `<span class="bgroup-count">${plural(group.count, 'piece')}</span>` : ''
        }</h3>
        <ul class="pieces">${group.pieces.map((piece) => renderPiece(piece, { titled: false })).join('')}</ul>
      </div>`).join('')}`;

  const byDate = `${colhead('Product &amp; options')}
      <ul class="pieces">${pieces.map((piece) => renderPiece(piece, { titled: true })).join('')}</ul>`;

  const bodies = { product: byProduct, date: byDate };

  return `<section id="build" class="card">
    <div class="cardhead">
      <h2>Build list</h2>
      <span class="cardnote">${note}</span>
    </div>
    <p class="hint">
      Everything still owed, with the options picked at checkout. Ship-by is the
      order's date, the same one the Ship queue shows. An order number opens its
      packing slip.
    </p>
    <div class="filters" id="buildview" role="group" aria-label="Arrange the build list">
      ${VIEWS.map((view, i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-view="${view.key}"
        aria-pressed="${i === 0 ? 'true' : 'false'}">${esc(view.label)}</button>`).join('')}
    </div>
    ${VIEWS.map((view, i) => `<div class="bview" data-buildview="${view.key}"${i === 0 ? '' : ' hidden'}>
      ${bodies[view.key]}
    </div>`).join('')}
  </section>`;
}

/* ------------------------------------------------------------------ client */

export const BUILD_STYLES = `
/* ------------------------------------------------------------ build list */
.pieces{list-style:none;margin:0;padding:0}
.pieces-head,.piece{display:grid;grid-template-columns:8.5rem minmax(0,1fr) 10.5rem;
  grid-template-areas:"due what order";gap:4px 18px;padding-left:11px;padding-right:11px}
.pieces-head{padding-bottom:9px;border-bottom:1px solid var(--line-2);
  font-family:var(--display);text-transform:uppercase;letter-spacing:.15em;font-size:9.5px;color:var(--soft)}
.piece{padding-top:11px;padding-bottom:12px;border-bottom:1px solid var(--line)}
/* Only where there is a pointer to hover with. On a phone the tint sticks to
   the last row tapped and reads as a selection. */
@media (hover:hover){ .piece:hover{background:#FAF9F6} }
.bview>.pieces>.piece:last-child,.bgroup:last-child .piece:last-child{border-bottom:0;padding-bottom:2px}
.pc-due{grid-area:due;white-space:nowrap}
.pc-what{grid-area:what;min-width:0}
.pc-order{grid-area:order;min-width:0;overflow-wrap:anywhere}
.pc-order a.mono{text-decoration:none;border-bottom:1px solid var(--line-2)}
.pc-order a.mono:hover{border-bottom-color:var(--ink)}
.pc-sheet{font-size:11.5px;margin-top:3px}
.pc-sheet a{color:var(--soft)}
.pc-sheet a:hover{color:var(--ink)}

.bgroup{margin-top:14px}
.pieces-head + .bgroup{margin-top:10px}
.bgroup-head{display:flex;align-items:center;gap:10px;margin:0;padding:8px 11px;
  background:var(--bg);border-radius:2px;font-family:var(--display);font-weight:600;
  font-size:12.5px;letter-spacing:.11em;text-transform:uppercase;line-height:1.35}
.bgroup-count{margin-left:auto;font-family:var(--body);font-weight:400;font-size:11.5px;
  letter-spacing:0;text-transform:none;color:var(--soft);white-space:nowrap}

.pc-name{margin:0 0 6px;font-weight:600;font-size:13.5px;line-height:1.4}
.pc-qty{font-variant-numeric:tabular-nums;font-weight:700;color:var(--soft)}
.pc-qty.many{display:inline-block;background:var(--ink);color:#EBE8E1;border-radius:2px;
  padding:0 6px;margin-right:2px}
.pc-opts{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:3px 22px;margin:0}
.pc-opt{display:flex;gap:7px;align-items:baseline;min-width:0;font-size:12.5px}
.pc-opt.wide{grid-column:1/-1}
.pc-opt dt{flex:0 0 auto;color:var(--soft);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em}
.pc-opt dd{margin:0;font-weight:600;min-width:0;overflow-wrap:anywhere}
.pc-lines{list-style:none;margin:0;padding:0;font-size:12.5px;line-height:1.6}
.pc-opts + .pc-lines{margin-top:6px}
.pc-none{margin:0;font-style:italic;font-size:12.5px}
/* The slip's callout, for the same fields: what gets cut into the leather. */
.pc-call{margin-top:8px;padding:6px 11px;border-left:3px solid var(--ink);
  background:rgba(15,15,15,.045);border-radius:0 2px 2px 0}
.pc-what>.pc-call:first-child{margin-top:0}
.pc-callrow{display:flex;gap:12px;align-items:baseline}
.pc-callrow + .pc-callrow{margin-top:3px;padding-top:3px;border-top:1px solid var(--line)}
.pc-calllabel{flex:0 0 8.5rem;font-family:var(--display);font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--soft);line-height:1.7}
.pc-callvalue{min-width:0;font-weight:700;font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.pc-callvalue a{font-weight:600}

/* Phone: when it is owed and whose it is share the top line, and everything
   to build it by gets the full width underneath. */
@media screen and (max-width:700px){
  .pieces-head{display:none}
  .piece{grid-template-columns:auto minmax(0,1fr);grid-template-areas:"due order" "what what";
    gap:8px 12px;padding-left:2px;padding-right:2px}
  .pc-order{text-align:right}
  .pc-order .block{display:inline}
  .pc-order .block::before{content:" · "}
  /* The sheet link keeps a line of its own, or it breaks in half after the name. */
  .pc-order .pc-sheet{display:block}
  .pc-order .pc-sheet::before{content:none}
  .pc-opts{grid-template-columns:1fr}
  .pc-callrow{flex-direction:column;gap:0}
  .pc-callrow + .pc-callrow{margin-top:5px;padding-top:5px}
  .pc-calllabel{flex:none}
}
`;

export const BUILD_SCRIPT = `
(function(){
  var strip = document.getElementById('buildview');
  if (!strip) return;
  var KEY = ${JSON.stringify(BUILD_VIEW_KEY)};
  var views = [].slice.call(document.querySelectorAll('#build [data-buildview]'));

  // Returns false for a name no list answers to, so a stale or hand-edited
  // value in storage can't leave the card showing nothing at all.
  function show(name){
    var known = views.some(function(v){ return v.getAttribute('data-buildview') === name; });
    if (!known) return false;
    views.forEach(function(v){ v.hidden = v.getAttribute('data-buildview') !== name; });
    [].forEach.call(strip.querySelectorAll('[data-view]'), function(chip){
      var on = chip.getAttribute('data-view') === name;
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    return true;
  }

  strip.addEventListener('click', function(event){
    var chip = event.target.closest('[data-view]');
    if (!chip) return;
    var name = chip.getAttribute('data-view');
    // Remembered per browser: the bench wants it one way and keeps wanting it.
    if (show(name)) { try { localStorage.setItem(KEY, name); } catch (e) {} }
  });

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved) show(saved);
})();
`;
