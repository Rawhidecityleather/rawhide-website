/**
 * The numbered stamp catalogue.
 *
 * Built Oct 28 2026, when the "type the numbers in the text box" system was
 * replaced with two pickers (Stamp above name, Stamp below name) that show
 * every stamp as a numbered tile — the way Box 31 does it, keeping the numbers
 * already written on the shop's sample boards.
 *
 * One list drives it all: assets/js/stamp-picker.js. These checks keep that
 * list honest (no gaps, no duplicate names, a tile for every number and no
 * stray tiles), make sure every page that offers stamps carries both pickers
 * and the script that fills them, and make sure the dashboard editor cannot
 * write over a picker's choices.
 */

import { suite, check } from './harness.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOptions } from '../product-options.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

const attrsOf = (tag) => {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? '';
  return out;
};

export default async function run() {
  // -------------------------------------------------------------------------
  suite('stamps — the catalogue is one numbered list');

  const js = read('assets/js/stamp-picker.js');
  const entries = [...js.matchAll(/^\s*\[(\d+), '((?:[^'\\]|\\.)*)'\]/gm)]
    .map((m) => [Number(m[1]), m[2]]);

  check('the catalogue parses out of stamp-picker.js', entries.length >= 51, `${entries.length} entries`);
  check('numbers run from 1 with no gaps and no repeats',
    entries.every((e, i) => e[0] === i + 1),
    entries.filter((e, i) => e[0] !== i + 1).map((e) => e[0]).join(', '));

  const names = entries.map((e) => e[1].toLowerCase());
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  check('every stamp has its own name', dupes.length === 0, dupes.join(', '));
  check('every name is short enough for a dropdown', entries.every((e) => e[1].length <= 28),
    entries.filter((e) => e[1].length > 28).map((e) => e[1]).join(', '));

  const tiles = readdirSync(resolve(ROOT, 'assets/img/stamps')).filter((f) => f.endsWith('.webp')).sort();
  const want = entries.map((e) => String(e[0]).padStart(2, '0') + '.webp');
  const missing = want.filter((f) => !tiles.includes(f));
  const stray = tiles.filter((f) => !want.includes(f));
  check('there is a tile for every number', missing.length === 0, missing.join(', '));
  check('and no tile without a number', stray.length === 0, stray.join(', '));

  // None is "" on the straps and "None" on the helmet band. A None tile that
  // hard-coded "" would put a required picker back on "Select..." and the
  // customer who tapped it could not check out.
  check('the None tile picks the value the page gave None', /tile\(NONE,/.test(js) && !/tile\('',/.test(js));

  // -------------------------------------------------------------------------
  suite('stamps — every page that offers stamps has both pickers');

  const pickerStamp = createHash('sha256').update(js.split('\r\n').join('\n')).digest('hex').slice(0, 10);
  const pages = readdirSync(ROOT).filter((f) => f.startsWith('product-') && f.endsWith('.html'));
  const withPickers = pages.filter((f) => read(f).includes('data-stamp-picker'));
  const expected = [
    'product-basic-radio-strap.html',
    'product-fully-custom-radio-strap.html',
    'product-helmet-band.html',
    'product-smokey-radio-strap.html',
  ];
  check('the two custom straps, the basic strap and the helmet band carry pickers',
    expected.every((f) => withPickers.includes(f)),
    expected.filter((f) => !withPickers.includes(f)).join(', '));

  for (const f of withPickers) {
    const html = read(f);
    check(`${f}: loads stamp-picker.js after main.js`,
      html.indexOf('assets/js/stamp-picker.js') > html.indexOf('assets/js/main.js'));

    // /assets/js is cached for an hour and served stale for a day after that.
    // The page and the script change together, so the page has to ask for the
    // script by its content: an old script against a new page left the Browse
    // button dead for Rob on Oct 28 2026.
    const have = (html.match(/assets\/js\/stamp-picker\.js\?v=([0-9a-f]+)/) || [])[1];
    check(`${f}: asks for stamp-picker.js by its current stamp`, have === pickerStamp,
      `want ?v=${pickerStamp}, page has ${have || 'none'}`);

    const selects = [...html.matchAll(/<select\b[^>]*data-stamp-pick[^>]*>([\s\S]*?)<\/select>/g)];
    check(`${f}: has exactly two pickers`, selects.length === 2, `${selects.length}`);

    for (const sel of selects) {
      const open = sel[0].slice(0, sel[0].indexOf('>') + 1);
      const a = attrsOf(open);
      const required = /\brequired\b/.test(open);

      // A picker starts on a greyed "Select..." and offers None as a real
      // value. Required with None as the empty value instead, it would refuse
      // the customer who wants no stamp in that spot.
      check(`${f}: picker "${a.name}" ships with only None on it (the script fills the rest)`,
        /^\s*<option value="" disabled selected hidden>Select\.\.\.<\/option><option value="None">None<\/option>\s*$/.test(sel[1]),
        'a hidden "Select..." row, then None with the value "None"');
      check(`${f}: picker "${a.name}" names its field for the order`, !!a['data-label'] && /^Stamp /.test(a['data-label']));
      check(`${f}: picker "${a.name}" has a browse button and a folded tile grid beside it`,
        new RegExp(`id="${a.id}"[\\s\\S]{0,700}data-stamp-browse[\\s\\S]{0,200}data-stamp-grid[^>]*\\bhidden`).test(html));

      // The shop's call, Nov 11 2026: first the helmet band, then the straps.
      // Every order says what goes in each stamp spot, None included, so
      // nothing reaches the bench with a spot nobody decided.
      check(`${f}: picker "${a.name}" is required`, required);
    }

    // The hidden Snipcart button lists the fields in the form's order, so the
    // priced ones land on the index the crawler expects. Where a page declares
    // any names at all, the two pickers must be in there, right after the text.
    const btn = html.match(/<button\b[^>]*snipcart-add-item[^>]*>/);
    const declared = btn ? [...btn[0].matchAll(/data-item-custom(\d+)-name="([^"]*)"/g)].map((m) => m[2]) : [];
    if (declared.length) {
      const formFields = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="[^"]+"[^>]*>/g)]
        .map((m) => attrsOf(m[0]))
        .filter((a) => a.type !== 'file' && a.type !== 'email')
        .map((a) => a['data-label'] || a.name);
      check(`${f}: the hidden button lists the fields in the form's order`,
        JSON.stringify(declared) === JSON.stringify(formFields),
        `button: ${declared.join(' | ')}\n        form:   ${formFields.join(' | ')}`);
    }
  }

  // -------------------------------------------------------------------------
  suite('stamps — the dashboard editor leaves the pickers alone');

  const fields = extractOptions(read('product-fully-custom-radio-strap.html'));
  const pickers = fields.filter((f) => f.stamps);
  check('the editor sees both pickers', pickers.length === 2, pickers.map((f) => f.name).join(', '));
  check('and both are locked', pickers.every((f) => f.locked === true));
  check('a colour list is still editable', fields.some((f) => f.name === 'stitch' && !f.locked && !f.stamps));

  const band = extractOptions(read('product-helmet-band.html')).filter((f) => f.stamps);
  check('the helmet band\'s two pickers are locked too', band.length === 2 && band.every((f) => f.locked === true),
    band.map((f) => f.name).join(', '));
  check('and read as required, with None as a real choice behind "Select..."',
    band.every((f) => f.required && f.placeholder?.required && f.choices.length === 1 && f.choices[0].value === 'None'),
    JSON.stringify(band.map((f) => ({ name: f.name, required: f.required, placeholder: f.placeholder, choices: f.choices }))));
}
