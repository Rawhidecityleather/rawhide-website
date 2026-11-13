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
 *
 * The same rows also print. "Print list" on the card opens the build sheet at
 * BUILD_PRINT_PATH: one arrangement, drawn for a letter page, to carry to the
 * bench. It is the only place a piece gets a box to tick — one beside every
 * piece that goes out with a holster and a sway strap, so making them is
 * something that gets marked off rather than remembered. The box is ink on
 * paper. Nothing is saved from it, and the card on the dashboard stays a list
 * that only reads.
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

/** The build list on paper. Routed in index.js, linked from the card. */
export const BUILD_PRINT_PATH = '/dashboard/build-print';

/** Florida. The sheet says when it was printed, on the shop's own clock. */
const SHOP_TIME_ZONE = 'America/New_York';

// Function declarations, so they are in reach up here.
const VIEWS = [
  { key: 'product', label: 'By product', draw: drawByProduct },
  { key: 'date', label: 'By ship date', draw: drawByDate },
];

/**
 * What goes out with a holster and a sway strap, and so gets the box to tick
 * on the printed sheet. Every radio strap does: the bucket and the sway strap
 * are in its price. So does a bucket bought by itself, which is the holster
 * and still ships with its sway strap.
 *
 * Read off the id and the name, the way lib.js finds a strap's six weeks, and
 * off a quote job's title and lines, which are all a crew job has. `radio`
 * stays in the pattern for the same reason it does there: a glove strap and a
 * chin strap are straps, and neither has a holster.
 */
const HOLSTER_SET = /radio.?(strap|bucket|holster|holder)|sway.?strap/i;

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

/**
 * Whether a piece goes out with a holster and a sway strap. See HOLSTER_SET.
 *
 * A quote job says what it is in its title and on its lines; the lines are
 * only in hand when the record was read, and the title is always there. So a
 * strap job still gets its box on a day the record could not be read.
 */
export function holsterSet(piece) {
  const lines = Array.isArray(piece?.quote?.lines) ? piece.quote.lines : [];
  return [piece?.item?.id, piece?.name, ...lines.map((line) => line?.description)]
    .some((said) => HOLSTER_SET.test(String(said ?? '')));
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
 * The box on the printed sheet, ticked with a pen once a piece's holster and
 * sway strap are made. Nothing for a piece that has neither.
 *
 * A catalog line of two straps is two holsters, and says so. A quote job's
 * quantities are on its lines, which can name the strap and its holster
 * separately — so a job gets the box and no number this could get wrong.
 */
function tickBox(piece) {
  if (!holsterSet(piece)) return '';
  return `<span class="pc-tick">${
    piece.quantity > 1 ? qtyTag(piece.quantity) + ' ' : ''}Holster / sway strap</span>`;
}

/**
 * `titled` is the by-date list, where the row has to say what it is. Under a
 * product heading the name is already above it, so it only comes back when
 * there is a quantity worth repeating it for.
 *
 * `sheet` is the printed build sheet, the one place a row carries a box to
 * tick. It sits under the order number, down the right edge of the page.
 */
function renderPiece(piece, { titled, sheet = false }) {
  const head = titled
    ? `<p class="pc-name">${piece.quantity ? qtyTag(piece.quantity) + ' ' : ''}${esc(piece.name)}${
        piece.job ? cashPill(piece.job) : ''}</p>`
    : piece.quantity > 1
      ? `<p class="pc-name">${qtyTag(piece.quantity)} ${esc(piece.name)}</p>`
      : '';

  return `<li class="piece">
      <div class="pc-due">${dueCell(piece)}</div>
      <div class="pc-what">${head}${renderOptions(piece)}</div>
      <div class="pc-order">${orderCell(piece)}${sheet ? tickBox(piece) : ''}</div>
    </li>`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How much is on the list, in words: "7 pieces · 5 orders · 1 cash job".
 *
 * Counted off the rows, not off what was handed in, so a heading can only
 * ever promise what is actually listed under it. One function for the card
 * and the sheet, so the paper never states a different total from the screen.
 */
function tally(pieces) {
  const total = pieces.reduce((n, piece) => n + piece.count, 0);
  const orderCount = new Set(pieces.filter((p) => p.order).map((p) => p.order)).size;
  const jobCount = pieces.filter((p) => p.job).length;
  return {
    pieces: plural(total, 'piece'),
    note: [
      plural(total, 'piece'),
      orderCount ? plural(orderCount, 'order') : '',
      jobCount ? plural(jobCount, 'cash job') : '',
    ].filter(Boolean).join(' &middot; '),
  };
}

const colhead = (what) => `<div class="pieces-head" aria-hidden="true">
        <span>Ship by</span><span>${what}</span><span>Order</span>
      </div>`;

/** Every helmet band together, then every strap. See groupPieces for the order. */
function drawByProduct(pieces, { sheet = false } = {}) {
  return `${colhead('Options')}
      ${groupPieces(pieces).map((group) => `<div class="bgroup">
        <h3 class="bgroup-head"><span>${esc(group.name)}</span>${
          // A cash job is its own heading, so the pill that explains why it
          // has no date and no slip rides up here with the name.
          group.pieces[0].job ? cashPill(group.pieces[0].job) : ''
        }${
          group.counted ? `<span class="bgroup-count">${plural(group.count, 'piece')}</span>` : ''
        }</h3>
        <ul class="pieces">${group.pieces.map((piece) => renderPiece(piece, { titled: false, sheet })).join('')}</ul>
      </div>`).join('')}`;
}

/** One list straight down, soonest first. */
function drawByDate(pieces, { sheet = false } = {}) {
  return `${colhead('Product &amp; options')}
      <ul class="pieces">${pieces.map((piece) => renderPiece(piece, { titled: true, sheet })).join('')}</ul>`;
}

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

  return `<section id="build" class="card">
    <div class="cardhead">
      <h2>Build list</h2>
      <span class="cardnote">${tally(pieces).note}</span>
    </div>
    <p class="hint">
      Everything still owed, with the options picked at checkout. Ship-by is the
      order's date, the same one the Ship queue shows. An order number opens its
      packing slip. <em>Print list</em> opens the same rows as a sheet for the
      bench, with a box to tick beside each holster and sway strap.
    </p>
    <div class="buildbar">
      <div class="filters" id="buildview" role="group" aria-label="Arrange the build list">
        ${VIEWS.map((view, i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-view="${view.key}"
          aria-pressed="${i === 0 ? 'true' : 'false'}">${esc(view.label)}</button>`).join('')}
      </div>
      <a class="btn ghost" id="buildprint" href="${BUILD_PRINT_PATH}?view=${VIEWS[0].key}"
        target="_blank" rel="noopener noreferrer">Print list</a>
    </div>
    ${VIEWS.map((view, i) => `<div class="bview" data-buildview="${view.key}"${i === 0 ? '' : ' hidden'}>
      ${view.draw(pieces)}
    </div>`).join('')}
  </section>`;
}

/* ------------------------------------------------------- the printed sheet */

/**
 * The build list on paper: the card's rows, one arrangement, laid out for a
 * letter page, with a box to tick beside every piece that goes out with a
 * holster and a sway strap.
 *
 * `view` is which arrangement — whatever the card was showing when Print list
 * was pressed. Anything else, a hand-typed address included, gets the first.
 *
 * The same backstop as the card, for the same reason: this reads every field
 * of records somebody else wrote, and a throw under the dashboard route comes
 * out as "Could not reach Snipcart". A sheet that cannot be drawn says so,
 * and says where the same information still is.
 */
export function renderBuildSheet(queue = [], cashJobs = [], options = {}) {
  try {
    return drawBuildSheet(queue, cashJobs, options);
  } catch (err) {
    console.error('build list sheet could not be drawn:', err);
    return `<div class="wrap sheet">
    <div class="toolbar">
      <a class="back" href="/dashboard#build">&larr; Dashboard</a>
    </div>
    <div class="notice">
      <h1>Build list</h1>
      <p>
        The build list could not be drawn this time. Every order is still in the
        Ship queue on the dashboard, and its order number opens the packing slip
        with the options on it.
        <code>${esc(err && err.message ? err.message : 'Unexpected error')}</code>
      </p>
    </div>
  </div>`;
  }
}

function drawBuildSheet(queue, cashJobs, { quotes = new Map(), view: asked = '', now = new Date() } = {}) {
  const view = VIEWS.find((v) => v.key === asked) || VIEWS[0];
  const pieces = buildPieces(queue, { cashJobs, quotes });
  const counts = tally(pieces);
  const printed = new Date(now).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: SHOP_TIME_ZONE,
  });

  return `<div class="wrap sheet">
    <div class="toolbar">
      <button type="button" onclick="window.print()">Print</button>
      <a class="back" href="/dashboard#build">&larr; Dashboard</a>
      <nav class="sheet-views" aria-label="Arrange the build list">
        ${VIEWS.map((v) => `<a href="${BUILD_PRINT_PATH}?view=${v.key}"${
          v === view ? ' aria-current="true"' : ''}>${esc(v.label)}</a>`).join('')}
      </nav>
    </div>

    <header class="head">
      <div class="brand">
        <img src="/assets/img/logo.png" alt="Rawhide City Leather" onerror="this.remove()">
        <p class="tagline">We do not cut corners. We cut leather.</p>
      </div>
      <div class="meta">
        <h1>Build list</h1>
        <dl>
          <dt>Printed</dt><dd>${esc(printed)}</dd>
          <dt>Arranged</dt><dd>${esc(view.label)}</dd>
          <dt>Owed</dt><dd class="strong">${pieces.length ? counts.note : 'Nothing'}</dd>
        </dl>
      </div>
    </header>

    ${pieces.length ? `<div class="sheet-list bview">
      ${view.draw(pieces, { sheet: true })}
    </div>

    <footer class="foot">
      <span>End of the list &middot; ${counts.pieces}</span>
      <span>Printed ${esc(printed)}</span>
    </footer>` : '<p class="sheet-empty">Nothing to build. Every paid order is out the door.</p>'}
  </div>`;
}

/* ------------------------------------------------------------------ client */

export const BUILD_STYLES = `
/* ------------------------------------------------------------ build list */
/* The arrangement chips and Print list share a line, and wrap on a phone. */
.buildbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px;margin-bottom:12px}
.buildbar .filters{margin-bottom:0}
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

/**
 * The printed sheet's own rules. It rides on SLIP_STYLES for the sheet itself
 * — the paper, the toolbar, the header — and on BUILD_STYLES for the rows, so
 * the list on paper is the list on screen. What is here is what the
 * dashboard's stylesheet would have supplied, and what paper changes.
 */
export const BUILD_SHEET_STYLES = `
/* ------------------------------------------------------ build list sheet */
:root{--line-2:rgba(15,15,15,.3)}
.block{display:block}
.mono{font-family:ui-monospace,'Cascadia Mono','Consolas',monospace;font-size:12px;font-weight:700}

/* Which arrangement prints. Outlined, so Print stays the one solid button. */
.sheet-views{margin-left:auto;display:flex;align-items:center;gap:6px}
.sheet-views a{font-family:var(--display);text-transform:uppercase;letter-spacing:.14em;font-size:10px;
  padding:6px 11px;border:1px solid var(--line);border-radius:2px;color:var(--soft);
  text-decoration:none;white-space:nowrap}
.sheet-views a:hover,.sheet-views a[aria-current]{border-color:var(--ink);color:var(--ink)}

/* The slip's sheet is a little narrower than the paper it prints on. This one
   is cut to the printed width, so a line that wraps on screen is a line that
   wraps on the page. */
.wrap.sheet{max-width:calc(7.6in + 64px)}
/* A browser's own blue comes out of a laser as grey. */
.sheet a{color:inherit}
.sheet-list{margin-top:14px}
.sheet-empty{margin:26px 0 8px;color:var(--soft);font-style:italic}
.sheet .foot{margin-top:14px}
.sheet .piece:hover{background:none}

/* The packing slip's .due is a ship-by row with a rule over it. On this sheet
   the same class is the dashboard's countdown badge, so every property the
   slip sets is set back. Border and weight carry how close it is, not colour:
   this prints on a B&W laser. Whole pixels throughout — Chrome draws a 1.5px
   border as 1px, on screen and on paper, so "a little heavier" is no heavier. */
.sheet .pc-due .due{display:inline-block;margin:0 0 0 5px;padding:0 4px;border:1px solid transparent;
  border-radius:2px;font-size:10px;font-weight:700;color:var(--soft)}
.sheet .pc-due .due.soon{border-color:var(--line-2);color:var(--ink)}
.sheet .pc-due .due.hot{border:2px solid var(--ink);padding:0 3px;color:var(--ink)}

.sheet .pill{display:inline-block;margin-left:6px;padding:1px 6px;border:1px solid var(--ink);
  border-radius:2px;font-family:var(--display);font-size:9px;font-weight:600;letter-spacing:.11em;
  text-transform:uppercase;white-space:nowrap;vertical-align:middle}

/* A filled bar and a reversed-out tag both vanish when the browser leaves
   background graphics off, which is its default — and the tag is the
   quantity. Rules and outlines print either way. */
.sheet .bgroup-head{background:none;border-radius:0;border-bottom:1px solid var(--ink);padding:0 0 4px}
.sheet .pc-qty.many{background:none;color:var(--ink);border:2px solid var(--ink);padding:0 5px}

/* The box to tick. An empty square drawn in CSS, like the invoice's, so
   nothing depends on a glyph the printer may not have — and big enough for a
   pen at the bench. The square hangs in the label's left margin, so a label
   that opens with a quantity still reads as one run of words. */
.pc-tick{display:inline-block;position:relative;margin-top:9px;padding-left:23px;min-height:16px;
  font-size:11.5px;font-weight:600;line-height:16px;text-align:left}
.pc-tick::before{content:'';position:absolute;left:0;top:0;box-sizing:border-box;width:16px;height:16px;
  border:2px solid var(--ink);border-radius:1px;background:#fff}
.pc-tick .pc-qty{white-space:nowrap}

/* Letter paper is one width, so the columns are cut for it. Not on a phone's
   screen: BUILD_STYLES stacks the row there, and three fixed columns would
   fight it. Print is never "screen", so a phone prints the full sheet. */
@media print, screen and (min-width:701px){
  .sheet .pieces-head,.sheet .piece{grid-template-columns:1.15in minmax(0,1fr) 1.85in;gap:3px 14px;
    padding-left:0;padding-right:0}
  .sheet .pc-opts{grid-template-columns:1fr 1fr;gap:1px 22px}

  /* The card's spacing is for a screen that scrolls. A piece is never cut
     across two pages, so on paper a row's height is paid for twice: once by
     the row, and again in the gap left when the next piece will not fit.
     Same type, same sizes, less air. Measured on a test print of fourteen
     rows, 2026-11-13: a strap came out about a seventh shorter, and four
     pages became three. */
  .sheet .piece{padding-top:8px;padding-bottom:8px}
  .sheet .pc-opt{line-height:1.35}
  .sheet .pc-call{margin-top:6px;padding:4px 10px}
  .sheet .pc-callrow + .pc-callrow{margin-top:2px;padding-top:2px}
  .sheet .pc-callvalue{line-height:1.25}
  .sheet .bgroup{margin-top:10px}
}
/* A phone's screen. The row is stacked, with the order at the right of its
   top line: the box takes the line under it, still at the right. And the
   header's block goes under the logo, where the count has room to be read. */
@media screen and (max-width:700px){
  .pc-tick{display:block;width:max-content;max-width:100%;margin-left:auto}
  .sheet .head{flex-wrap:wrap;gap:12px}
  .sheet .meta{flex:1 1 100%;text-align:left}
  .sheet .meta dl{justify-content:start}
  .sheet .meta dd{text-align:left}
}

@media print{
  /* A piece is read as one block, so it is never cut across two pages, and a
     heading is never left at the foot of one with its rows on the next. */
  .piece{break-inside:avoid;page-break-inside:avoid}
  .bgroup-head,.pieces-head{break-after:avoid;page-break-after:avoid}
  /* A link is no use on paper. The order number stays; "Quote sheet" goes. */
  .pc-sheet{display:none}
  .sheet .pc-order a.mono{border-bottom:0}
}
`;

export const BUILD_SCRIPT = `
(function(){
  var strip = document.getElementById('buildview');
  if (!strip) return;
  var KEY = ${JSON.stringify(BUILD_VIEW_KEY)};
  var PRINT = ${JSON.stringify(BUILD_PRINT_PATH)};
  var views = [].slice.call(document.querySelectorAll('#build [data-buildview]'));
  var printLink = document.getElementById('buildprint');

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
    // What prints is what is on screen: the sheet opens in this arrangement.
    if (printLink) printLink.href = PRINT + '?view=' + encodeURIComponent(name);
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
