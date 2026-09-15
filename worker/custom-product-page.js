/**
 * The half of /dashboard/products that adds a product rather than edits one.
 *
 * The card below the existing rows: a name, a price, which part of the shop it
 * goes in, photos, wording, and as many dropdowns as the order form needs.
 * Press Save and there is a page at /product-<address>, a card in the shop
 * grid, a line in the sitemap and — if the box is ticked — an item in the
 * Google Shopping feed. No deploy, no seven files edited by hand.
 *
 * worker/custom-product.js is the model and the markup, and it is pure. This
 * file is the form over it and the two writes behind it, and nothing more.
 *
 * Routes (wired in index.js)
 *   POST /dashboard/api/product-new      create one, or save an edit to one
 *   POST /dashboard/api/product-delete   take one off the site for good
 */

import { esc, json } from './lib.js';
import { contentWarnings, CONTENT_CHECKS, SUMMARY_IDEAL } from './product-copy.js';
import { MAX_PHOTOS, ALT_MAX, deletePhoto, photoUrl, PhotoError } from './photos.js';
import { OptionError, choicesToText } from './product-options.js';
import { getCatalog, putCatalog, PRODUCT_IDS, allPhotoIds } from './catalog.js';
import {
  CATEGORIES, LEAD_TIMES, DEFAULT_EYEBROW, CustomProductError, buildCustomProduct,
  categoryFor, customFor, customIds, customProducts, priceLabel,
  withCustomProduct, withoutCustomProduct,
  NAME_MAX, TITLE_MAX, SUMMARY_MAX, DESCRIPTION_MAX, DETAIL_MAX, DETAILS_MAX, FEED_MAX,
  LABEL_MAX, EYEBROW_MAX, FIELDS_MAX,
} from './custom-product.js';

/** The key the blank row goes by. No product can have it — ids have no capitals. */
const NEW = 'NEW';

/* ------------------------------------------------------------------ photos */

async function sweep(env, known, record) {
  const stillUsed = allPhotoIds(record);
  for (const id of known) {
    if (stillUsed.has(id)) continue;
    try {
      await deletePhoto(env, id);
    } catch (err) {
      // A dropped photo with bytes left behind is untidy, not broken.
      console.error('photo delete failed', err?.message || err);
    }
  }
}

/* -------------------------------------------------------------- the markup */

function textField(key, name, label, hint, value, { rows = 0, max = 0, placeholder = '' } = {}) {
  const attrs = `data-cp="${esc(name)}" data-for="${esc(key)}"${max ? ` maxlength="${max}"` : ''}` +
    `${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}`;

  return `<label class="pfield">
        <span class="plabel">${label}</span>
        ${rows
          ? `<textarea ${attrs} rows="${rows}" spellcheck="true">${esc(value)}</textarea>`
          : `<input type="text" ${attrs} value="${esc(value)}">`}
        <span class="phint">${hint}</span>
        <span class="pwarn" data-cpwarn="${esc(key)}-${esc(name)}" hidden></span>
      </label>`;
}

function pickField(key, name, label, hint, options, value) {
  return `<label class="pfield">
        <span class="plabel">${esc(label)}</span>
        <select data-cp="${esc(name)}" data-for="${esc(key)}">
          ${options.map((o) => `<option value="${esc(o.key)}"${o.key === value ? ' selected' : ''}>${
            esc(o.label)
          }</option>`).join('')}
        </select>
        <span class="phint">${hint}</span>
      </label>`;
}

function tick(key, name, label, hint, on) {
  return `<label class="cptick">
        <input type="checkbox" data-cp="${esc(name)}" data-for="${esc(key)}"${on ? ' checked' : ''}>
        <span><b>${esc(label)}</b> ${hint}</span>
      </label>`;
}

function statusOf(product) {
  if (!product) return { pill: 'done', label: 'New', note: '' };
  if (!product.published) {
    return {
      pill: 'done',
      label: 'Draft',
      note: 'Not on the site. The page answers so you can look at it, and tells Google to skip it.',
    };
  }
  return {
    pill: 'good',
    label: product.inFeed ? 'Live + Google' : 'Live',
    note: `${priceLabel(product)} · ${categoryFor(product.category).label}` +
      (product.inFeed ? ' · in the Shopping feed' : ' · site only'),
  };
}

/**
 * One editor. The same one whether it is blank or holding a product, because
 * adding and editing are the same job and a second form would be a second
 * place to forget a field.
 */
function renderEditor(product) {
  const key = product ? product.id : NEW;
  const value = (name, fallback = '') => (product ? (product[name] ?? fallback) : fallback);
  const status = statusOf(product);
  const address = product ? product.id : '';

  return `<section class="prow cprow" data-cprow="${esc(key)}">
    <button type="button" class="prowhead" data-cptoggle="${esc(key)}" aria-expanded="false">
      <span class="prowthumb"><img${
        product?.photos?.length ? ` src="${esc(photoUrl(product.photos[0].id, 't'))}"` : ''
      } alt="" loading="lazy" onerror="this.style.opacity=0"></span>
      <span class="prowname">${product ? esc(product.name) : 'Add a product'}</span>
      <span class="pill ${status.pill}" data-cppill="${esc(key)}">${esc(status.label)}</span>
      <span class="soft prownote" data-cpnote="${esc(key)}">${
        product ? esc(status.note) : 'Something new off the bench, with its own page.'
      }</span>
      <span class="prowchev" aria-hidden="true">&rsaquo;</span>
    </button>
    <div class="prowbody" data-cpbody="${esc(key)}" hidden>

      <h3 class="psub">What it is</h3>
      <div class="pfields cpgrid">
        ${textField(key, 'name', 'Name<span class="req">*</span>',
          'The heading on the page and the name in the cart.',
          value('name'), { max: NAME_MAX, placeholder: 'Shop Apron' })}
        ${textField(key, 'price', 'Price<span class="req">*</span>',
          'Dollars. Upcharges on the dropdowns are added on top, and the card then says "From".',
          value('price'), { max: 10, placeholder: '85.00' })}
        ${pickField(key, 'category', 'Where it goes',
          'Which part of the shop grid the card lands in.',
          CATEGORIES, value('category', 'accessories'))}
        ${pickField(key, 'lead', 'Lead time',
          'What Google is told, in days. Say it in the bullets as well &mdash; that is where a customer reads it.',
          LEAD_TIMES, value('lead', '1-3-weeks'))}
      </div>

      <label class="pfield">
        <span class="plabel">Web address</span>
        <span class="cpaddr">rawhidecityleather.com/product-<input type="text"
          data-cp="id" data-for="${esc(key)}" value="${esc(address)}"
          ${product ? 'readonly' : ''} spellcheck="false" placeholder="shop-apron"></span>
        <span class="phint">${product
          ? 'This one is set. It is the id every order for this product was written against, ' +
            'and renaming it would point those orders at something that no longer exists.'
          : 'Made from the name, and you can change it before you save. After that it is fixed &mdash; ' +
            'it is the id the orders are written against.'}</span>
      </label>

      <h3 class="psub">Photos</h3>
      <div class="pstrip" data-cpstrip="${esc(key)}"></div>
      <p class="hint cpempty" data-cpempty="${esc(key)}">
        No photos yet. The first one is the main one &mdash; the big picture on the page,
        the card in the grid, and what shows when somebody shares the link.
      </p>
      <div class="pactions">
        <label class="btn ghost pfile">
          Add photos
          <input type="file" accept="image/*" multiple data-cpadd="${esc(key)}" hidden>
        </label>
      </div>

      <h3 class="psub">Wording</h3>
      <div class="pfields">
        ${textField(key, 'description', 'On the page',
          'The paragraphs under the price. Leave a blank line to start a new one. ' +
          '<b>**Two stars**</b> makes a highlight, and nothing else is markup.',
          value('description'), { rows: 7, max: DESCRIPTION_MAX })}
        ${textField(key, 'details', 'The bullets',
          `One per line, no dashes &mdash; the list adds those. Up to ${DETAILS_MAX}. ` +
          'This is where the lead time lives.',
          (product?.details || []).join('\n'), { rows: 6, max: DETAIL_MAX * DETAILS_MAX })}
        ${textField(key, 'summary', 'Search summary',
          'The line under the title in Google, and the one that shows when somebody shares the link. ' +
          `Around ${SUMMARY_IDEAL} characters before Google cuts it off.`,
          value('summary'), { rows: 3, max: SUMMARY_MAX })}
        ${textField(key, 'title', 'Title in Google',
          'The blue line in the search result. Leave it empty and it is just the name.',
          product && product.title !== product.name ? product.title : '',
          { max: TITLE_MAX, placeholder: value('name') || 'Shop Apron' })}
        ${textField(key, 'feed', 'Google Shopping',
          'The description in the Shopping feed. Longer and more literal than the one on the page ' +
          '&mdash; materials, sizes, colours, lead time.',
          value('feed'), { rows: 6, max: FEED_MAX })}
        ${textField(key, 'eyebrow', 'The small line above the name',
          'Set in capitals above the heading. The repo\u2019s pages say HANDMADE LEATHER, LEATHER CARE.',
          value('eyebrow', DEFAULT_EYEBROW), { max: EYEBROW_MAX, placeholder: DEFAULT_EYEBROW })}
      </div>

      <h3 class="psub">The order form</h3>
      <p class="hint">
        One box per dropdown, one choice per line, in the order the customer sees them.
        <b>An upcharge goes on the end of a line</b> &mdash; <code>White +10.00</code> adds ten
        dollars when that colour is picked. Two dashes and a reason &mdash;
        <code>Brown -- out of stock</code> &mdash; greys a choice out and leaves it on the list
        saying why. <code>## Richardson 112</code> starts a heading.
      </p>
      <p class="hint">
        A dropdown nobody has to answer opens on its first line, so put the
        do-nothing choice at the top and name it: <code>No stitching</code>, not a blank row.
        Blank rows shift the numbering Snipcart checks the price against.
      </p>
      <div class="cpfields" data-cpfields="${esc(key)}"></div>
      <div class="pactions">
        <button type="button" class="btn ghost" data-cpaddfield="${esc(key)}">Add a dropdown</button>
      </div>

      <div class="cpnotes">
        ${tick(key, 'notes', 'A notes box at the bottom of the form',
          'A free-text box for anything the dropdowns do not cover &mdash; a radio model, a spelling.',
          Boolean(product?.notes))}
        <div class="pfields cpgrid">
          ${textField(key, 'notesLabel', 'What it is called',
            'Shows above the box, and on the packing slip.',
            product?.notes?.label || '', { max: LABEL_MAX, placeholder: 'Additional Notes' })}
          ${textField(key, 'notesPlaceholder', 'The grey hint inside it',
            'What a good answer looks like. Optional.',
            product?.notes?.placeholder || '',
            { max: 120, placeholder: 'Radio model, or anything else we should know' })}
        </div>
        ${tick(key, 'notesRequired', 'They have to fill it in',
          'Leave this off unless the build genuinely cannot start without it.',
          Boolean(product?.notes?.required))}
      </div>

      <h3 class="psub">Before it goes up</h3>
      <div class="cpticks">
        ${tick(key, 'disclaimer', 'Show the not-PPE line',
          'Accessory use only, not NFPA certified, linked to the Use Disclaimer. ' +
          'Every page in the repo that sells gear carries it.',
          product ? product.disclaimer !== false : true)}
        ${tick(key, 'published', 'Put it on the site',
          'Off, it is a draft: the page answers so you can look at it and tells Google to skip it, ' +
          'and there is no card in the grid.',
          Boolean(product?.published))}
        ${tick(key, 'inFeed', 'List it in Google Shopping',
          'Leave it off while the photos or the wording are still rough. ' +
          'A product joins the feed the moment you tick it, and Google reviews it then.',
          product ? Boolean(product.inFeed) : true)}
      </div>

      <div class="pactions">
        <button type="button" class="btn" data-cpsave="${esc(key)}">${
          product ? 'Save' : 'Add it'
        }</button>
        ${product ? `<a class="btn ghost" href="/product-${esc(product.id)}" target="_blank" rel="noopener">Open the page &nearr;</a>
        <button type="button" class="btn ghost cpdanger" data-cpdelete="${esc(product.id)}">Delete</button>` : ''}
        <span class="soft" data-cpsaid="${esc(key)}"></span>
      </div>
      ${product ? confirmPanel(product) : ''}
    </div>
  </section>`;
}

/**
 * The are-you-sure, in the page rather than in a browser dialog.
 *
 * A native confirm() blocks the tab it is on, which means nobody working
 * through the page — including this assistant — can get past it, and the only
 * way out is a human hand on the mouse. It also cannot say what is about to
 * happen in more than one flat line of text.
 *
 * What it says depends on what the product actually is right now. A draft is
 * nothing to a customer and clicking through it should be quick; a live one
 * takes its page, its card, its sitemap line, its feed entry and its
 * photographs with it, so that one asks for the name to be typed. Making both
 * cases equally laborious just teaches the habit of typing without reading.
 */
function confirmPanel(product) {
  const live = Boolean(product.published);

  const what = live
    ? 'It is on the site. The page stops answering, the card comes off the shop grid, ' +
      `and the sitemap line${product.inFeed ? ' and the Shopping feed entry go' : ' goes'} ` +
      'with it. The photographs are deleted out of storage.'
    : 'It is a draft, so nothing a customer can see changes. The page stops answering ' +
      'and the record goes.';

  return `<div class="cpconfirm" data-cpconfirm="${esc(product.id)}" hidden>
        <p class="cpconfirmhead">Delete ${esc(product.name)}?</p>
        <p class="cpconfirmwhat">${what} Orders already placed keep their own record and are
        not touched. <b>This cannot be undone.</b></p>
        ${live ? `<label class="pfield cpconfirmtype">
          <span class="plabel">Type <b>${esc(product.name)}</b> to confirm</span>
          <input type="text" data-cpconfirmtype="${esc(product.id)}" spellcheck="false"
            autocomplete="off" placeholder="${esc(product.name)}">
        </label>` : ''}
        <div class="pactions">
          <button type="button" class="btn cpdanger" data-cpconfirmgo="${esc(product.id)}"${
            live ? ' disabled' : ''
          }>Delete it</button>
          <button type="button" class="btn ghost" data-cpconfirmno="${esc(product.id)}">Keep it</button>
        </div>
      </div>`;
}

/**
 * The card. `ready` is whether both bindings exist — without them there is
 * nowhere to put a product, and saying so beats a form that cannot save.
 */
export function renderCustomCard(record, { ready = true } = {}) {
  const made = customProducts(record);
  const live = made.filter((p) => p.published).length;

  return `<section class="card" id="add">
    <div class="cardhead">
      <h2>Add a product</h2>
      <span class="cardnote">${
        made.length
          ? `${made.length} added here &middot; ${live} on the site`
          : 'a page, a card and a feed entry, with no deploy'
      }</span>
    </div>
    ${ready ? '' : `<p class="banner">
      Product storage is not set up. Create the KV namespace and the R2 bucket and add the
      <code>CATALOG</code> and <code>PHOTOS</code> bindings to <code>wrangler.jsonc</code>
      &mdash; see the README. Nothing saves until then.
    </p>`}
    <p class="hint">
      Everything a new product needs, in one form. Saving it builds the page at
      <code>/product-&lt;address&gt;</code>, puts a card in the shop grid under the category you
      pick, and adds the line to the sitemap. It reaches the site within a minute.
    </p>
    <p class="hint">
      <b>Add it as a draft first.</b> Leave "Put it on the site" off, save, and open the page
      &mdash; that is the only way to see what the dropdowns and the wording actually look like.
      Tick it when it reads right.
    </p>
    <p class="hint">
      <b>The two dropdowns on the fully custom straps are not something to copy here.</b> Those
      drive the artwork upload slots by reading a number off the chosen value, and that wiring
      lives in the HTML. A product added here has dropdowns and a notes box, and no file upload.
    </p>
    <div class="plist cplist">
      ${made.map((product) => renderEditor(product)).join('')}
      ${renderEditor(null)}
    </div>
  </section>`;
}

export const CUSTOM_STYLES = `
.cprow .prowthumb img[src=""]{opacity:0}
.cpgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.cpaddr{display:flex;align-items:center;gap:0;font-size:12.5px;color:var(--soft,#6b6b6b);
  border:1px solid var(--line);border-radius:2px;background:var(--paper);padding:0 0 0 8px}
.cpaddr input{flex:1;min-width:80px;font:inherit;font-size:13px;color:inherit;padding:6px 8px;
  border:0;background:none;outline:none}
.cpaddr input[readonly]{color:var(--soft,#6b6b6b)}
.cpfields{display:flex;flex-direction:column;gap:10px;margin:12px 0}
.cpfield{border:1px solid var(--line);border-radius:2px;padding:10px 12px;background:var(--paper)}
.cpfieldtop{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:8px}
.cpfieldtop input[type=text]{flex:1;min-width:160px;font:inherit;font-size:13px;padding:5px 8px;
  border:1px solid var(--line);border-radius:2px;background:var(--paper);color:inherit}
.cpfield textarea{width:100%;font:inherit;font-size:13px;line-height:1.55;padding:6px 8px;
  border:1px solid var(--line);border-radius:2px;background:var(--paper);color:inherit;resize:vertical}
.cpfield .rm{font:inherit;font-size:11.5px;padding:4px 8px;cursor:pointer;border:1px solid var(--line);
  border-radius:2px;background:var(--paper);color:inherit}
.cpfield .rm:hover{border-color:#8B2E2E;color:#8B2E2E}
.cptick,.cpsmall{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.55;
  margin:8px 0;cursor:pointer}
.cptick input{margin-top:2px;flex:none}
.cptick b{font-weight:600}
.cpticks,.cpnotes{border-top:1px solid var(--line);margin-top:14px;padding-top:6px}
.cpdanger:hover:not(:disabled){border-color:#8B2E2E;color:#8B2E2E}
.cpdanger:disabled{opacity:.4;cursor:default}
.cpconfirm{border:1px solid #8B2E2E;border-radius:2px;padding:14px 16px;margin:12px 0 4px;
  background:rgba(139,46,46,.04)}
.cpconfirm[hidden]{display:none}
.cpconfirmhead{margin:0 0 6px;font-weight:600;font-size:13.5px;color:#8B2E2E}
.cpconfirmwhat{margin:0;font-size:12.5px;line-height:1.6;color:var(--soft,#6b6b6b)}
.cpconfirmtype{margin-top:12px;max-width:340px}
.cpconfirmtype input{width:100%;font:inherit;font-size:13px;padding:6px 8px;
  border:1px solid var(--line);border-radius:2px;background:var(--paper);color:inherit}
.cpempty[hidden]{display:none}
`;

export const CUSTOM_SCRIPT = `
(function(){
  var list = document.querySelector('.cplist');
  if (!list) return;

  var STATE = __CSTATE__;
  var NAMES = __CNAMES__;
  var NEW = __NEW__;
  var MAX = __MAX__;
  var IDEAL = __IDEAL__;
  var FIELDS_MAX = __FIELDSMAX__;
  var CHECKS = __CHECKS__.map(function(c){
    return { re: new RegExp(c.pattern, 'i'), message: c.message, hatsOnly: !!c.hatsOnly };
  });

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
  function row(key){ return q('[data-cprow="' + key + '"]'); }
  function said(key, text){ var el = q('[data-cpsaid="' + key + '"]'); if (el) el.textContent = text || ''; }
  function field(key, name){ return q('[data-cp="' + name + '"][data-for="' + key + '"]'); }
  function val(key, name){ var el = field(key, name); return el ? el.value : ''; }
  function on(key, name){ var el = field(key, name); return !!(el && el.checked); }
  function url(id, size){ return '/photo/' + id + '-' + size + '.webp'; }

  /* --------------------------------------------------------------- photos */

  function button(label, title, cls, click, off){
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = title;
    if (cls) b.className = cls;
    b.disabled = !!off;
    b.addEventListener('click', click);
    return b;
  }

  function paint(key){
    var strip = q('[data-cpstrip="' + key + '"]');
    var empty = q('[data-cpempty="' + key + '"]');
    var set = STATE[key].photos;
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
      alt.addEventListener('input', function(){ photo.alt = alt.value; });
      body.appendChild(alt);

      var btns = document.createElement('div');
      btns.className = 'pcardbtns';
      btns.appendChild(button('\\u2190', 'Move earlier', '', function(){ move(key, i, -1); }, i === 0));
      btns.appendChild(button('\\u2192', 'Move later', '', function(){ move(key, i, 1); }, i === set.length - 1));
      btns.appendChild(button('Remove', 'Take this photo off the page', 'rm', function(){
        set.splice(i, 1); paint(key);
      }));
      body.appendChild(btns);

      card.appendChild(body);
      strip.appendChild(card);
    });

    if (empty) empty.hidden = set.length > 0;

    var thumb = row(key) && row(key).querySelector('.prowthumb img');
    if (thumb && set.length) thumb.src = url(set[0].id, 't');
  }

  function move(key, index, by){
    var set = STATE[key].photos;
    var to = index + by;
    if (to < 0 || to >= set.length) return;
    set.splice(to, 0, set.splice(index, 1)[0]);
    paint(key);
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

  // One at a time, the same as the rows above: six phone photos at once is
  // 40 MB in flight, and one after another finishes more often.
  function addFiles(key, files){
    var queue = [].slice.call(files);
    var room = MAX - STATE[key].photos.length;
    if (queue.length > room) {
      toast('Room for ' + room + ' more on this one. Taking the first ' + room + '.', true);
      queue = queue.slice(0, Math.max(0, room));
    }
    if (!queue.length) return;

    var done = 0;
    function next(){
      if (!queue.length) {
        said(key, done ? 'Added ' + done + '. Not saved yet.' : '');
        return;
      }
      var file = queue.shift();
      said(key, 'Uploading ' + file.name + '\\u2026');
      upload(file).then(function(photo){
        photo.alt = '';
        STATE[key].photos.push(photo);
        done++;
        paint(key);
      }).catch(function(err){
        toast(file.name + ': ' + err.message, true);
      }).then(next);
    }
    next();
  }

  /* ------------------------------------------------------------ dropdowns */

  function paintFields(key){
    var host = q('[data-cpfields="' + key + '"]');
    if (!host) return;
    host.textContent = '';

    STATE[key].fields.forEach(function(f, i){
      var box = document.createElement('div');
      box.className = 'cpfield';

      var top = document.createElement('div');
      top.className = 'cpfieldtop';

      var label = document.createElement('input');
      label.type = 'text';
      label.value = f.label || '';
      label.maxLength = __LABELMAX__;
      label.placeholder = 'Leather Color';
      label.addEventListener('input', function(){ f.label = label.value; });
      top.appendChild(label);

      var req = document.createElement('label');
      req.className = 'cpsmall';
      var reqBox = document.createElement('input');
      reqBox.type = 'checkbox';
      reqBox.checked = !!f.required;
      reqBox.addEventListener('change', function(){ f.required = reqBox.checked; });
      req.appendChild(reqBox);
      req.appendChild(document.createTextNode(' They have to pick one'));
      top.appendChild(req);

      top.appendChild(button('Remove', 'Take this dropdown off the form', 'rm', function(){
        STATE[key].fields.splice(i, 1);
        paintFields(key);
      }));

      box.appendChild(top);

      var choices = document.createElement('textarea');
      choices.rows = Math.min(Math.max((f.choices || '').split('\\n').length + 1, 4), 14);
      choices.spellcheck = false;
      choices.value = f.choices || '';
      choices.placeholder = 'Black\\nBrown\\nChestnut';
      choices.addEventListener('input', function(){ f.choices = choices.value; });
      box.appendChild(choices);

      host.appendChild(box);
    });
  }

  /* -------------------------------------------------------------- the copy */

  function warn(key){
    var isHat = (val(key, 'category') === 'hats');
    ['description','details','summary','feed'].forEach(function(name){
      var el = field(key, name);
      var slot = q('[data-cpwarn="' + key + '-' + name + '"]');
      if (!el || !slot) return;
      var hits = [];
      CHECKS.forEach(function(c){
        if (c.hatsOnly && !isHat) return;
        if (el.value && c.re.test(el.value)) hits.push(c.message);
      });
      slot.textContent = hits.join(' ');
      slot.hidden = !hits.length;
    });

    var sum = field(key, 'summary');
    if (sum) {
      var hint = sum.parentElement.querySelector('.phint');
      var count = hint.querySelector('.pcount');
      if (!count) {
        count = document.createElement('span');
        count.className = 'pcount';
        hint.appendChild(document.createTextNode(' '));
        hint.appendChild(count);
      }
      var n = sum.value.trim().length;
      count.textContent = n + '/' + IDEAL;
      count.className = 'pcount' + (n > IDEAL ? ' over' : '');
    }
  }

  function slug(text){
    return String(text || '').toLowerCase()
      .replace(/['\\u2019]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /* ------------------------------------------------------------- the wires */

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

  function payload(key){
    return {
      productId: key === NEW ? '' : key,
      id: val(key, 'id'),
      name: val(key, 'name'),
      price: val(key, 'price'),
      category: val(key, 'category'),
      lead: val(key, 'lead'),
      eyebrow: val(key, 'eyebrow'),
      title: val(key, 'title'),
      summary: val(key, 'summary'),
      description: val(key, 'description'),
      details: val(key, 'details').split('\\n').map(function(l){ return l.trim(); }).filter(Boolean),
      feed: val(key, 'feed'),
      photos: STATE[key].photos.map(function(p){
        return { id: p.id, alt: p.alt || '', w: p.w, h: p.h, tw: p.tw, th: p.th };
      }),
      fields: STATE[key].fields,
      notes: on(key, 'notes'),
      notesLabel: val(key, 'notesLabel'),
      notesPlaceholder: val(key, 'notesPlaceholder'),
      notesRequired: on(key, 'notesRequired'),
      disclaimer: on(key, 'disclaimer'),
      published: on(key, 'published'),
      inFeed: on(key, 'inFeed')
    };
  }

  function save(key, el){
    var label = el.textContent;
    el.disabled = true;
    el.textContent = 'Saving\\u2026';

    post('/dashboard/api/product-new', payload(key)).then(function(data){
      // A product that has just been created needs the row the server renders
      // for it — its address is fixed now, it has a Delete button and a link
      // to its page, and none of that is worth rebuilding here.
      if (data.created) {
        toast('Added. ' + data.product.name + ' is at /product-' + data.product.id + '.');
        setTimeout(function(){ location.reload(); }, 700);
        return;
      }
      said(key, 'Saved.');
      if (data.warnings && data.warnings.length) {
        toast('Saved, with ' + data.warnings.length + ' thing' +
          (data.warnings.length === 1 ? '' : 's') + ' to look at below.', true);
      } else {
        toast('Saved. The site shows this within a minute.');
      }
    }).catch(function(err){
      toast(err.message, true);
      said(key, '');
    }).then(function(){
      el.disabled = false;
      el.textContent = label;
    });
  }

  list.addEventListener('click', function(e){
    var el = e.target.closest && e.target.closest(
      '[data-cptoggle],[data-cpsave],[data-cpdelete],[data-cpaddfield],' +
      '[data-cpconfirmgo],[data-cpconfirmno]');
    if (!el) return;

    var key = el.getAttribute('data-cptoggle');
    if (key) {
      var body = q('[data-cpbody="' + key + '"]');
      var open = body.hidden;
      body.hidden = !open;
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
      row(key).classList.toggle('open', open);
      if (open) { paint(key); paintFields(key); warn(key); }
      return;
    }

    key = el.getAttribute('data-cpaddfield');
    if (key) {
      if (STATE[key].fields.length >= FIELDS_MAX) {
        toast('That is already ' + FIELDS_MAX + ' dropdowns on one form.', true);
        return;
      }
      STATE[key].fields.push({ label: '', required: true, choices: '' });
      paintFields(key);
      return;
    }

    key = el.getAttribute('data-cpsave');
    if (key) { save(key, el); return; }

    // Delete opens the panel underneath rather than doing anything. Nothing is
    // sent until the panel's own button is pressed.
    key = el.getAttribute('data-cpdelete');
    if (key) {
      var panel = q('[data-cpconfirm="' + key + '"]');
      if (!panel) return;
      panel.hidden = false;
      var typed = q('[data-cpconfirmtype="' + key + '"]');
      if (typed) { typed.value = ''; typed.focus(); }
      var go = q('[data-cpconfirmgo="' + key + '"]');
      if (go && typed) go.disabled = true;
      panel.scrollIntoView({ block: 'nearest' });
      return;
    }

    key = el.getAttribute('data-cpconfirmno');
    if (key) {
      var shut = q('[data-cpconfirm="' + key + '"]');
      if (shut) shut.hidden = true;
      return;
    }

    key = el.getAttribute('data-cpconfirmgo');
    if (key) {
      el.disabled = true;
      el.textContent = 'Deleting\\u2026';
      post('/dashboard/api/product-delete', { productId: key }).then(function(){
        toast('Deleted.');
        setTimeout(function(){ location.reload(); }, 700);
      }).catch(function(err){
        toast(err.message, true);
        el.disabled = false;
        el.textContent = 'Delete it';
      });
    }
  });

  // The name has to be typed out on a product that is live. Case and stray
  // spaces are forgiven — the point is to have read which product this is, not
  // to be caught out by a capital letter.
  list.addEventListener('input', function(e){
    var key = e.target.getAttribute && e.target.getAttribute('data-cpconfirmtype');
    if (!key) return;
    var go = q('[data-cpconfirmgo="' + key + '"]');
    var want = (NAMES[key] || '').trim().toLowerCase();
    if (go) go.disabled = e.target.value.trim().toLowerCase() !== want;
  });

  list.addEventListener('input', function(e){
    var key = e.target.getAttribute && e.target.getAttribute('data-for');
    if (!key || !e.target.hasAttribute('data-cp')) return;

    // The address writes itself from the name until the address is touched,
    // and then it stops. Only ever on the blank row: an address in use is
    // fixed, and the input is read-only there anyway.
    if (key === NEW && e.target.getAttribute('data-cp') === 'name') {
      var addr = field(NEW, 'id');
      if (addr && !addr.dataset.touched) addr.value = slug(e.target.value);
    }
    if (e.target.getAttribute('data-cp') === 'id') e.target.dataset.touched = '1';

    warn(key);
  });

  list.addEventListener('change', function(e){
    var key = e.target.getAttribute && e.target.getAttribute('data-cpadd');
    if (!key) return;
    addFiles(key, e.target.files);
    e.target.value = '';
  });
})();
`;

/** The script with this record baked into it, so the page opens ready to use. */
export function customScript(record) {
  const state = { [NEW]: { photos: [], fields: [] } };
  const names = {};

  for (const product of customProducts(record)) {
    names[product.id] = product.name;
    state[product.id] = {
      photos: product.photos || [],
      // The dropdowns go to the browser as the text the box shows, not as the
      // parsed choices: the box is what the shop edits, and turning choices
      // back into lines is already a solved problem next door.
      fields: (product.fields || []).map((f) => ({
        label: f.label,
        required: Boolean(f.required),
        choices: choicesToText(f.choices),
      })),
    };
  }

  return CUSTOM_SCRIPT
    .replace('__CSTATE__', JSON.stringify(state))
    // The STORED name, not whatever is in the name box. Somebody may have
    // retyped that without saving, and the panel above it shows the stored one.
    .replace('__CNAMES__', JSON.stringify(names))
    .replace('__NEW__', JSON.stringify(NEW))
    .replace('__CHECKS__', JSON.stringify(CONTENT_CHECKS))
    .replace('__MAX__', String(MAX_PHOTOS))
    .replace('__IDEAL__', String(SUMMARY_IDEAL))
    .replace('__FIELDSMAX__', String(FIELDS_MAX))
    .replace('__LABELMAX__', String(LABEL_MAX))
    .replace('__ALTMAX__', String(ALT_MAX));
}

/* -------------------------------------------------------------------- save */

function notConfigured() {
  return json({
    error: 'Product storage is not set up. Add the CATALOG KV and PHOTOS R2 bindings — see the README.',
  }, 500);
}

/**
 * Creates a product, or saves an edit to one. Which of the two it is comes off
 * `productId`: a blank one is new, and a filled one has to already be there.
 *
 * The address is only read off the form on a create. On an edit it comes from
 * the stored product and the form's copy is ignored, because it is the id every
 * order for this product carries and a renamed one orphans all of them.
 */
export async function handleCustomSave(request, env) {
  if (!env.CATALOG || !env.PHOTOS) return notConfigured();

  const body = await request.json().catch(() => ({}));
  const before = await getCatalog(env);

  const wanted = String(body.productId || '');
  const existing = wanted ? customFor(before, wanted) : null;
  if (wanted && !existing) {
    return json({ error: 'That product is not here any more. Reload the page.' }, 404);
  }

  // Every id the site already answers to: the repo's pages, the shop's own, and
  // `page` — /product-page is a dead Wix URL this Worker redirects, and it is
  // answered long before anything here, so a product at that address could
  // never be opened.
  const taken = new Set([...PRODUCT_IDS, ...customIds(before), 'page']);

  let product;
  try {
    product = buildCustomProduct(body, { existing, taken });
  } catch (err) {
    if (err instanceof CustomProductError || err instanceof OptionError || err instanceof PhotoError) {
      return json({ error: err.message }, 400);
    }
    throw err;
  }

  // Every new photo is checked against the bucket before it can go live. An id
  // that is not there means an upload that failed quietly, and a page with a
  // broken main image is worse than one that is still a draft.
  const known = allPhotoIds(before);
  for (const photo of product.photos) {
    if (known.has(photo.id)) continue;
    const head = await env.PHOTOS.head(`${photo.id}-m.webp`);
    if (!head) return json({ error: 'One of those photos is not in storage. Upload it again.' }, 400);
  }

  const record = withCustomProduct(before, product);
  await putCatalog(env, record);
  await sweep(env, known, record);

  return json({
    ok: true,
    created: !existing,
    product,
    warnings: contentWarnings(product.id, {
      description: product.description,
      details: product.details,
      summary: product.summary,
      feed: product.feed,
    }, { hats: product.category === 'hats' }),
  });
}

/**
 * Takes one off the site for good. The page stops answering, the card comes off
 * the grid, the feed entry and the sitemap line go with it, and the photographs
 * are deleted out of the bucket.
 *
 * Orders already placed are untouched — they live at Snipcart and carry their
 * own copy of what was bought.
 */
export async function handleCustomDelete(request, env) {
  if (!env.CATALOG || !env.PHOTOS) return notConfigured();

  const body = await request.json().catch(() => ({}));
  const id = String(body.productId || '');

  const before = await getCatalog(env);
  if (!customFor(before, id)) {
    return json({ error: 'That product is not here any more. Reload the page.' }, 404);
  }

  const known = allPhotoIds(before);
  const record = withoutCustomProduct(before, id);
  await putCatalog(env, record);
  await sweep(env, known, record);

  return json({ ok: true, deleted: id });
}
