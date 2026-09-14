/**
 * /dashboard/products — the page that edits a product's photos and its wording.
 *
 * One row per product. Open it and you get the photo strip, then the four
 * wording fields, then one Save for the lot. The wording boxes are filled in
 * with what the site says right now, override or repo alike: retyping five
 * sentences to change one is not editing, and nobody does it twice.
 *
 * That prefill is also what keeps the record small. On save, any field still
 * matching the repo word for word is dropped rather than stored, so a product
 * where one sentence changed carries one sentence, and everything else keeps
 * coming out of `product-<id>.html` — including later edits to it.
 *
 * Routes (wired in index.js)
 *   GET  /dashboard/products     the page
 *   POST /dashboard/api/photos   save one product: photos, wording, or both
 */

import { esc, json } from './lib.js';
import { PRODUCTS } from './promo.js';
import { renderRail } from './dashboard.js';
import {
  photosFor, photoUrl, builtInPhoto, buildPhotoSet, idsInRecord, deletePhoto,
  PhotoError, MAX_PHOTOS, ALT_MAX,
} from './photos.js';
import {
  buildCopy, copyFor, effectiveCopy, extractCopy, extractFeedDescription,
  contentWarnings, CopyError, CONTENT_CHECKS, HAT_IDS,
  DESCRIPTION_MAX, DETAIL_MAX, DETAILS_MAX, SUMMARY_MAX, SUMMARY_IDEAL, FEED_MAX,
} from './product-copy.js';
import {
  getCatalog, putCatalog, withProduct, productName, PRODUCT_IDS, touchedProducts,
} from './catalog.js';

/* ------------------------------------------------------- the repo's wording */

/**
 * What every product page and the feed say in the repo, so the editor opens on
 * real text. Fifteen asset reads, all in flight at once, none of them leaving
 * the colo. A page that cannot be read comes back empty rather than taking the
 * dashboard down with it.
 */
async function fetchText(env, origin, path) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(path, origin)));
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

export async function readBuiltIn(env, origin) {
  const [feedXml, ...pages] = await Promise.all([
    fetchText(env, origin, '/google-merchant-feed.xml'),
    ...PRODUCTS.map(([id]) => fetchText(env, origin, `/product-${id}`)),
  ]);

  const builtIn = {};
  PRODUCTS.forEach(([id], i) => {
    builtIn[id] = {
      ...extractCopy(pages[i]),
      feed: extractFeedDescription(feedXml, id),
    };
  });
  return builtIn;
}

/** One product's, for a save. No reason to read the other thirteen pages. */
export async function readBuiltInFor(env, origin, product) {
  const [page, feedXml] = await Promise.all([
    fetchText(env, origin, `/product-${product}`),
    fetchText(env, origin, '/google-merchant-feed.xml'),
  ]);
  return { ...extractCopy(page), feed: extractFeedDescription(feedXml, product) };
}

/* --------------------------------------------------------------- the page */

function statusOf(photos, copy) {
  const bits = [];
  if (photos.length) bits.push(`${photos.length} photo${photos.length === 1 ? '' : 's'}`);
  if (copy) bits.push('wording');
  if (!bits.length) return { pill: 'done', label: 'Built-in', note: 'Showing what is in the repo.' };
  return {
    pill: 'good',
    label: bits.join(' + '),
    note: `Changed here: ${bits.join(' and ')}. Everything else comes from the repo.`,
  };
}

function field(id, name, label, hint, value, { rows = 3, max } = {}) {
  return `<label class="pfield">
        <span class="plabel">${esc(label)}</span>
        <textarea data-copy="${esc(name)}" data-for="${esc(id)}" rows="${rows}"
          maxlength="${max}" spellcheck="true">${esc(value)}</textarea>
        <span class="phint">${hint}</span>
        <span class="pwarn" data-warn="${esc(id)}-${esc(name)}" hidden></span>
      </label>`;
}

function renderRow(id, record, builtIn) {
  const photos = photosFor(record, id);
  const copy = copyFor(record, id);
  const showing = effectiveCopy(copy, builtIn[id] || {});
  const status = statusOf(photos, copy);
  const preview = photos.length ? photoUrl(photos[0].id, 't') : builtInPhoto(id);

  return `<section class="prow" data-row="${esc(id)}">
    <button type="button" class="prowhead" data-toggle="${esc(id)}" aria-expanded="false">
      <span class="prowthumb"><img src="${esc(preview)}" alt="" loading="lazy" onerror="this.style.opacity=0"></span>
      <span class="prowname">${esc(productName(id))}</span>
      <span class="pill ${status.pill}" data-pill="${esc(id)}">${esc(status.label)}</span>
      <span class="soft prownote" data-note="${esc(id)}">${esc(status.note)}</span>
      <span class="prowchev" aria-hidden="true">&rsaquo;</span>
    </button>
    <div class="prowbody" data-body="${esc(id)}" hidden>

      <h3 class="psub">Photos</h3>
      <div class="pstrip" data-strip="${esc(id)}"></div>
      <p class="hint pempty" data-empty="${esc(id)}">
        No photos uploaded for this one. The page is showing what is in the repo.
        Add one below and it takes over &mdash; every photo, not just the first,
        so upload the whole set you want the page to have.
      </p>
      <div class="pactions">
        <label class="btn ghost pfile">
          Add photos
          <input type="file" accept="image/*" multiple data-add="${esc(id)}" hidden>
        </label>
      </div>

      <h3 class="psub">Wording</h3>
      <div class="pfields">
        ${field(id, 'description', 'On the page',
          'The paragraphs under the price. Leave a blank line to start a new one. ' +
          '<b>**Two stars**</b> makes a highlight, and nothing else is markup.',
          showing.description, { rows: 7, max: DESCRIPTION_MAX })}
        ${field(id, 'details', 'The bullets',
          `One per line, no dashes &mdash; the list adds those. Up to ${DETAILS_MAX}. ` +
          'This is where the lead time lives.',
          (showing.details || []).join('\n'), { rows: 6, max: DETAIL_MAX * DETAILS_MAX })}
        ${field(id, 'summary', 'Search summary',
          `The line under the title in Google, and the one that shows when somebody shares the link. ` +
          `Around ${SUMMARY_IDEAL} characters before Google cuts it off.`,
          showing.summary, { rows: 3, max: SUMMARY_MAX })}
        ${field(id, 'feed', 'Google Shopping',
          'The description in the Shopping feed. Longer and more literal than the one on the page ' +
          '&mdash; materials, sizes, colours, lead time. Changing it sends the product back for review.',
          showing.feed, { rows: 6, max: FEED_MAX })}
      </div>

      <div class="pactions">
        <button type="button" class="btn" data-save="${esc(id)}">Save</button>
        <button type="button" class="btn ghost" data-reset="${esc(id)}">Use the built-in photos</button>
        <button type="button" class="btn ghost" data-resetcopy="${esc(id)}">Use the built-in wording</button>
        <a class="btn ghost" href="/product-${esc(id)}" target="_blank" rel="noopener">Open the page &nearr;</a>
        <span class="soft" data-said="${esc(id)}"></span>
      </div>
    </div>
  </section>`;
}

/**
 * `ready` is whether both bindings exist. Without them the page says how to
 * finish the setup rather than offering an editor that cannot save.
 */
export function renderProductsPage(record, { ready = true, builtIn = {}, railCounts = {} } = {}) {
  const changed = touchedProducts(record).length;
  const rows = PRODUCTS.map(([id]) => renderRow(id, record, builtIn)).join('');
  const saved = record?.updatedAt
    ? 'Last changed ' + new Date(record.updatedAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
      })
    : 'Nothing changed here yet';

  return `<div class="shell">
  ${renderRail({ ...railCounts, active: 'products' })}
  <main class="main">
    <header class="topbar">
      <div class="topleft">
        <h1>Products</h1>
        <p class="sub">${PRODUCTS.length} products &middot; ${
          changed ? `${changed} changed here` : 'all on the built-in photos and wording'
        }</p>
      </div>
      <div class="topright">
        <span class="soft">${esc(saved)}</span>
      </div>
    </header>
    <div class="pad">
      ${ready ? '' : `<p class="banner">
        Product storage is not set up. Create the KV namespace and the R2 bucket and add the
        <code>CATALOG</code> and <code>PHOTOS</code> bindings to <code>wrangler.jsonc</code>
        &mdash; see the README. Nothing uploads or saves until then.
      </p>`}

      <section class="card">
        <div class="cardhead">
          <h2>Photos and wording</h2>
          <span class="cardnote">what the site shows, without a deploy</span>
        </div>
        <p class="hint">
          Every box below is filled in with what the site says right now. Change what you
          want and press Save; anything you leave exactly as it is keeps coming out of the
          repo, so it still follows along if the page is edited there later. Changes reach
          the site within a minute.
        </p>
        <p class="hint">
          A photo replaces the built-in one everywhere that product appears: the page
          gallery, the card in the shop grid, the cart thumbnail, the link preview, and the
          Google Shopping feed. The photo at the front of the row is the main one.
        </p>
        <p class="hint">
          <b>Google reads the words printed in a photo</b> as well as the ones you type. A
          worksheet, a price list or a brand name in the frame can get a product disapproved
          in Merchant Center &mdash; that is what happened to the glove strap.
        </p>
        <div class="plist">${rows}</div>
      </section>
    </div>
  </main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>`;
}

export const PRODUCTS_STYLES = `
.plist{display:flex;flex-direction:column;gap:8px;margin-top:16px}
.prow{border:1px solid var(--line);border-radius:3px;background:var(--paper);overflow:hidden}
.prow.open{border-color:var(--ink)}
.prowhead{display:flex;align-items:center;gap:12px;width:100%;padding:10px 14px;border:0;
  background:none;text-align:left;cursor:pointer;font:inherit;color:inherit}
.prowhead:hover{background:rgba(0,0,0,.03)}
.prowthumb{flex:none;width:44px;height:44px;border:1px solid var(--line);border-radius:2px;
  overflow:hidden;background:#EBE8E1}
.prowthumb img{width:100%;height:100%;object-fit:cover;display:block}
.prowname{flex:none;min-width:210px;font-weight:600;font-size:13.5px}
.prownote{flex:1;font-size:12.5px}
.prowchev{flex:none;font-size:20px;line-height:1;transition:transform .12s}
.prow.open .prowchev{transform:rotate(90deg)}
.prowbody{padding:4px 14px 16px;border-top:1px solid var(--line)}
.prowbody[hidden]{display:none}
.psub{margin:16px 0 0;font-size:11px;letter-spacing:.2em;text-transform:uppercase;
  font-weight:700;color:var(--soft,#6b6b6b)}
.pstrip{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.pcard{width:168px;border:1px solid var(--line);border-radius:2px;background:#fff;
  display:flex;flex-direction:column}
.pcard.first{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.pcard img{width:100%;height:126px;object-fit:cover;display:block;background:#EBE8E1}
.pcardmain{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;
  padding:4px 6px;background:var(--ink);color:var(--paper);text-align:center}
.pcardbody{padding:6px;display:flex;flex-direction:column;gap:6px}
.pcard input[type=text]{width:100%;font:inherit;font-size:11.5px;padding:4px 6px;
  border:1px solid var(--line);border-radius:2px;background:var(--paper);color:inherit}
.pcardbtns{display:flex;gap:4px}
.pcardbtns button{flex:1;font:inherit;font-size:11px;padding:3px 0;cursor:pointer;
  border:1px solid var(--line);border-radius:2px;background:var(--paper);color:inherit}
.pcardbtns button:hover:not(:disabled){border-color:var(--ink)}
.pcardbtns button:disabled{opacity:.35;cursor:default}
.pcardbtns button.rm:hover{border-color:#8B2E2E;color:#8B2E2E}
.pfields{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px}
.pfield{display:flex;flex-direction:column;gap:5px}
.plabel{font-size:12px;font-weight:700;letter-spacing:.04em}
.pfield textarea{width:100%;font:inherit;font-size:13px;line-height:1.5;padding:8px 10px;
  border:1px solid var(--line);border-radius:2px;background:#fff;color:inherit;resize:vertical}
.pfield textarea:focus{outline:none;border-color:var(--ink)}
.phint{font-size:11.5px;color:var(--soft,#6b6b6b);line-height:1.45}
.pcount{font-variant-numeric:tabular-nums}
.pcount.over{color:#8B2E2E;font-weight:700}
.pwarn{font-size:12px;line-height:1.45;color:#8B2E2E;border-left:2px solid #8B2E2E;
  padding:4px 0 4px 8px;background:rgba(139,46,46,.05)}
.pwarn[hidden]{display:none}
.pactions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.pfile{cursor:pointer}
.pempty{margin:10px 0 0}
.pempty[hidden]{display:none}
.prow.dirty .prowname::after{content:' · unsaved';font-weight:400;color:#8B2E2E;font-size:12px}
@media (max-width:900px){ .pfields{grid-template-columns:1fr} }
@media (max-width:720px){
  .prowname{min-width:0}
  .prownote{display:none}
  .pcard{width:calc(50% - 5px)}
}
`;

/**
 * Runs inside the dashboard page. Holds one product's photos and wording in
 * memory, redraws the photo strip from it, flags wording against the same
 * checks the server uses, and posts the lot on save.
 *
 * The photo strip is built with createElement rather than innerHTML: the
 * description under each photo is typed by hand and goes straight back into
 * the page, and this is the one place in the dashboard where that happens.
 */
export const PRODUCTS_SCRIPT = `
(function(){
  var list = document.querySelector('.plist');
  if (!list) return;

  var STATE = __STATE__;
  var NAMES = __NAMES__;
  var CHECKS = __CHECKS__.map(function(c){
    return { re: new RegExp(c.pattern, 'i'), message: c.message, hatsOnly: !!c.hatsOnly };
  });
  var HATS = __HATS__;
  var MAX = __MAX__;
  var IDEAL = __IDEAL__;

  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(msg, bad){
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.className = 'toast'; }, 6000);
  }

  function q(sel){ return document.querySelector(sel); }
  function photos(id){ return STATE[id].photos; }
  function row(id){ return q('[data-row="' + id + '"]'); }
  function said(id, text){ var el = q('[data-said="' + id + '"]'); if (el) el.textContent = text || ''; }
  function dirty(id, on){ var el = row(id); if (el) el.classList.toggle('dirty', !!on); }
  function url(photoId, size){ return '/photo/' + photoId + '-' + size + '.webp'; }

  /* --------------------------------------------------------------- photos */

  function button(label, title, cls, onClick, disabled){
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (cls) b.className = cls;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function paint(id){
    var strip = q('[data-strip="' + id + '"]');
    var empty = q('[data-empty="' + id + '"]');
    var set = photos(id);
    if (!strip) return;

    strip.textContent = '';
    set.forEach(function(photo, i){
      var card = document.createElement('div');
      card.className = 'pcard' + (i === 0 ? ' first' : '');

      var img = document.createElement('img');
      img.src = url(photo.id, 't');
      img.alt = '';
      img.loading = 'lazy';
      card.appendChild(img);

      if (i === 0) {
        var flag = document.createElement('div');
        flag.className = 'pcardmain';
        flag.textContent = 'Main photo';
        card.appendChild(flag);
      }

      var body = document.createElement('div');
      body.className = 'pcardbody';

      var alt = document.createElement('input');
      alt.type = 'text';
      alt.value = photo.alt || '';
      alt.maxLength = __ALTMAX__;
      alt.placeholder = 'Describe it';
      alt.title = 'What is in the photo. Read out to anyone who cannot see it, and read by Google.';
      alt.addEventListener('input', function(){ photo.alt = alt.value; dirty(id, true); });
      body.appendChild(alt);

      var btns = document.createElement('div');
      btns.className = 'pcardbtns';
      btns.appendChild(button('\\u2190', 'Move earlier', '', function(){ move(id, i, -1); }, i === 0));
      btns.appendChild(button('\\u2192', 'Move later', '', function(){ move(id, i, 1); }, i === set.length - 1));
      btns.appendChild(button('Remove', 'Take this photo off the page', 'rm', function(){ drop(id, i); }));
      body.appendChild(btns);

      card.appendChild(body);
      strip.appendChild(card);
    });

    if (empty) empty.hidden = set.length > 0;
    status(id);

    var thumb = row(id) && row(id).querySelector('.prowthumb img');
    if (thumb) thumb.src = set.length ? url(set[0].id, 't') : '/assets/img/products/' + id + '.webp';
  }

  function move(id, index, by){
    var set = photos(id);
    var to = index + by;
    if (to < 0 || to >= set.length) return;
    set.splice(to, 0, set.splice(index, 1)[0]);
    dirty(id, true);
    paint(id);
  }

  function drop(id, index){
    photos(id).splice(index, 1);
    dirty(id, true);
    paint(id);
  }

  /* -------------------------------------------------------------- wording */

  function boxes(id){
    return [].slice.call(document.querySelectorAll('[data-copy][data-for="' + id + '"]'));
  }

  function copyOf(id){
    var out = {};
    boxes(id).forEach(function(box){
      var name = box.getAttribute('data-copy');
      out[name] = name === 'details'
        ? box.value.split('\\n').map(function(l){ return l.trim(); }).filter(Boolean)
        : box.value;
    });
    return out;
  }

  // What the row differs from the repo by. Empty means this product is saying
  // exactly what the repo says and nothing needs storing.
  function changedFields(id){
    var copy = copyOf(id), base = STATE[id].builtIn || {}, changed = {};
    ['description','summary','feed'].forEach(function(k){
      if ((copy[k] || '').trim() !== (base[k] || '').trim()) changed[k] = true;
    });
    if ((copy.details || []).join('\\n') !== (base.details || []).join('\\n')) changed.details = true;
    return changed;
  }

  function warn(id){
    var copy = copyOf(id);
    var isHat = HATS.indexOf(id) >= 0;
    var any = false;

    boxes(id).forEach(function(box){
      var name = box.getAttribute('data-copy');
      var value = name === 'details' ? (copy.details || []).join('\\n') : (copy[name] || '');
      var slot = q('[data-warn="' + id + '-' + name + '"]');
      var hits = [];
      CHECKS.forEach(function(c){
        if (c.hatsOnly && !isHat) return;
        if (value && c.re.test(value)) hits.push(c.message);
      });
      if (slot) {
        slot.textContent = hits.join(' ');
        slot.hidden = !hits.length;
      }
      if (hits.length) any = true;
    });

    // The search summary is the one with a length that matters.
    var sum = document.querySelector('[data-copy="summary"][data-for="' + id + '"]');
    if (sum) {
      var hint = sum.parentElement.querySelector('.phint');
      var n = sum.value.trim().length;
      var count = hint.querySelector('.pcount');
      if (!count) {
        count = document.createElement('span');
        count.className = 'pcount';
        hint.appendChild(document.createTextNode(' '));
        hint.appendChild(count);
      }
      count.textContent = n + '/' + IDEAL;
      count.className = 'pcount' + (n > IDEAL ? ' over' : '');
    }
    return any;
  }

  function status(id){
    var pill = q('[data-pill="' + id + '"]');
    var note = q('[data-note="' + id + '"]');
    var bits = [];
    if (photos(id).length) bits.push(photos(id).length + (photos(id).length === 1 ? ' photo' : ' photos'));
    if (Object.keys(changedFields(id)).length) bits.push('wording');
    if (pill) {
      pill.className = 'pill ' + (bits.length ? 'good' : 'done');
      pill.textContent = bits.length ? bits.join(' + ') : 'Built-in';
    }
    if (note) {
      note.textContent = bits.length
        ? 'Changed here: ' + bits.join(' and ') + '. Everything else comes from the repo.'
        : 'Showing what is in the repo.';
    }
  }

  /* ------------------------------------------------------------ the wires */

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

  function upload(file){
    var body = new FormData();
    body.append('file', file);
    return fetch('/dashboard/api/photo-upload', {
      method: 'POST', headers: { 'x-rawhide-dashboard': '1' }, body: body
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if (!res.ok || data.error) throw new Error(data.error || ('Upload failed (' + res.status + ')'));
        return data.photo;
      });
    });
  }

  // One at a time on purpose. Six phone photos posted at once is 40 MB in
  // flight and a conversion queue; one after another is slower to watch and
  // finishes more often.
  function addFiles(id, files){
    var queue = [].slice.call(files);
    if (!queue.length) return;
    var room = MAX - photos(id).length;
    if (queue.length > room) {
      toast('Room for ' + room + ' more on this one. Taking the first ' + room + '.', true);
      queue = queue.slice(0, Math.max(0, room));
    }
    if (!queue.length) return;

    var done = 0;
    function next(){
      if (!queue.length) {
        said(id, done ? 'Added ' + done + '. Not saved yet.' : '');
        if (done) { dirty(id, true); toast('Uploaded. Press Save to put ' + (done === 1 ? 'it' : 'them') + ' on the site.'); }
        return;
      }
      var file = queue.shift();
      said(id, 'Uploading ' + file.name + '\\u2026');
      upload(file).then(function(photo){
        photo.alt = '';
        photos(id).push(photo);
        done++;
        paint(id);
      }).catch(function(err){
        toast(file.name + ': ' + err.message, true);
      }).then(next);
    }
    next();
  }

  function fill(id, copy){
    boxes(id).forEach(function(box){
      var name = box.getAttribute('data-copy');
      box.value = name === 'details' ? (copy.details || []).join('\\n') : (copy[name] || '');
    });
  }

  function save(id, button){
    var label = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Saving\\u2026'; }

    post('/dashboard/api/photos', {
      productId: id,
      photos: photos(id).map(function(p){
        return { id: p.id, alt: p.alt || '', w: p.w, h: p.h, tw: p.tw, th: p.th };
      }),
      copy: copyOf(id)
    }).then(function(data){
      STATE[id].photos = data.photos || [];
      fill(id, data.showing || {});
      dirty(id, false);
      paint(id);
      warn(id);
      said(id, 'Saved.');
      if (data.warnings && data.warnings.length) {
        toast('Saved, with ' + data.warnings.length + ' thing' +
          (data.warnings.length === 1 ? '' : 's') + ' to look at below.', true);
      } else {
        toast('Saved. ' + NAMES[id] + ' shows this within a minute.');
      }
    }).catch(function(err){
      toast(err.message, true);
    }).then(function(){
      if (button) { button.disabled = false; button.textContent = label; }
    });
  }

  list.addEventListener('click', function(e){
    var el = e.target.closest && e.target.closest('[data-toggle],[data-save],[data-reset],[data-resetcopy]');
    if (!el) return;

    var id = el.getAttribute('data-toggle');
    if (id) {
      var body = q('[data-body="' + id + '"]');
      var open = body.hidden;
      body.hidden = !open;
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
      row(id).classList.toggle('open', open);
      if (open) { paint(id); warn(id); }
      return;
    }

    id = el.getAttribute('data-save');
    if (id) { save(id, el); return; }

    id = el.getAttribute('data-reset');
    if (id) {
      if (photos(id).length && !confirm('Put ' + NAMES[id] +
        ' back on the photos in the repo? The ones uploaded here are deleted.')) return;
      STATE[id].photos = [];
      paint(id);
      save(id, el);
      return;
    }

    id = el.getAttribute('data-resetcopy');
    if (id) {
      if (!confirm('Put the wording for ' + NAMES[id] + ' back to what the repo says?')) return;
      fill(id, STATE[id].builtIn || {});
      warn(id);
      save(id, el);
    }
  });

  list.addEventListener('input', function(e){
    var id = e.target.getAttribute && e.target.getAttribute('data-for');
    if (!id || !e.target.hasAttribute('data-copy')) return;
    dirty(id, true);
    warn(id);
    status(id);
  });

  list.addEventListener('change', function(e){
    var id = e.target.getAttribute && e.target.getAttribute('data-add');
    if (!id) return;
    addFiles(id, e.target.files);
    e.target.value = '';
  });
})();
`;

/** The script with this record baked into it, so the page opens ready to use. */
export function productsScript(record, builtIn = {}) {
  const state = {};
  for (const [id] of PRODUCTS) {
    state[id] = {
      photos: photosFor(record, id),
      builtIn: builtIn[id] || { description: '', details: [], summary: '', feed: '' },
    };
  }

  return PRODUCTS_SCRIPT
    .replace('__STATE__', JSON.stringify(state))
    .replace('__NAMES__', JSON.stringify(Object.fromEntries(PRODUCTS)))
    .replace('__CHECKS__', JSON.stringify(CONTENT_CHECKS))
    .replace('__HATS__', JSON.stringify(HAT_IDS))
    .replace('__MAX__', String(MAX_PHOTOS))
    .replace('__IDEAL__', String(SUMMARY_IDEAL))
    .replace('__ALTMAX__', String(ALT_MAX));
}

/* ------------------------------------------------------------------- save */

/**
 * Saves one product: its photos, its wording, or both.
 *
 * Wording that still matches the repo word for word is dropped rather than
 * stored. That is what makes pressing Save on a row nobody edited a no-op, and
 * it is what keeps a one-sentence change to one sentence — everything else
 * stays the repo's, and follows a later edit there.
 *
 * Bytes for photos no longer pointed at anywhere in the record are deleted. A
 * photo uploaded and never saved is left in the bucket: it costs a fraction of
 * a cent and nothing can see it.
 */
export async function handleProductSave(request, env, origin) {
  if (!env.CATALOG || !env.PHOTOS) {
    return json({
      error: 'Product storage is not set up. Add the CATALOG KV and PHOTOS R2 bindings — see the README.',
    }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const product = String(body.productId || '');
  if (!PRODUCT_IDS.has(product)) return json({ error: 'That is not a product.' }, 400);

  let photos;
  let copy;
  try {
    photos = buildPhotoSet(body.photos, product);
    copy = buildCopy(body.copy);
  } catch (err) {
    if (err instanceof PhotoError || err instanceof CopyError) {
      return json({ error: err.message }, 400);
    }
    throw err;
  }

  const builtIn = await readBuiltInFor(env, origin, product);
  copy = withoutBuiltIn(copy, builtIn);

  // Every new photo is checked against the bucket before it can go live. An id
  // that is not there means an upload that failed quietly, and a product page
  // with a broken main image on it is worse than one with an old photo.
  const before = await getCatalog(env);
  const known = idsInRecord(before);
  for (const photo of photos) {
    if (known.has(photo.id)) continue;
    const head = await env.PHOTOS.head(`${photo.id}-m.webp`);
    if (!head) return json({ error: 'One of those photos is not in storage. Upload it again.' }, 400);
  }

  const record = withProduct(before, product, { photos, copy });
  await putCatalog(env, record);

  const stillUsed = idsInRecord(record);
  for (const id of known) {
    if (stillUsed.has(id)) continue;
    try {
      await deletePhoto(env, id);
    } catch (err) {
      // A dropped photo with bytes left behind is untidy, not broken.
      console.error('photo delete failed', err?.message || err);
    }
  }

  return json({
    ok: true,
    product,
    photos,
    showing: effectiveCopy(copy, builtIn),
    warnings: contentWarnings(product, copy),
  });
}

/**
 * Drops any field that says exactly what the repo says. Returns null when
 * nothing is left, so "no override" and "an override that changes nothing"
 * stay the same thing.
 */
export function withoutBuiltIn(copy, builtIn = {}) {
  if (!copy) return null;
  const kept = {};

  for (const key of ['description', 'summary', 'feed']) {
    const value = (copy[key] || '').trim();
    if (value && value !== (builtIn[key] || '').trim()) kept[key] = copy[key];
  }

  const details = copy.details || [];
  if (details.length && details.join('\n') !== (builtIn.details || []).join('\n')) {
    kept.details = details;
  }

  return Object.keys(kept).length ? kept : null;
}
