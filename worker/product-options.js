/**
 * The choices a customer picks from, changed from the dashboard.
 *
 * Photos went in first, then the wording. This is the dropdowns: leather
 * colours, stitch colours, hardware finishes, hat colours, strap lengths. The
 * lists that move whenever the bench does — a colour runs out, a new hide
 * arrives, brown comes back once there are photos of it. Restoring one colour
 * used to mean editing six places and deploying.
 *
 * A choice is a value and, sometimes, a price. `White` is free; `White +10.00`
 * adds ten dollars to the order. That is the whole syntax, and it is written
 * that way on purpose: the upcharge sits next to the colour it belongs to, so
 * adding a stitch colour without its ten dollars takes a deliberate omission
 * rather than a forgotten step.
 *
 * A priced list reaches Snipcart twice and both have to agree. The `<select>`
 * carries `data-options`, which assets/js/main.js copies onto the hidden buy
 * button when the customer adds to cart; the button carries its own static
 * copy, which Snipcart's crawler reads off the page to check the price it was
 * handed. Rewrite one and not the other and the cart is refused at checkout.
 *
 * What this does NOT do is change the shape of a form. Fields are not added,
 * removed, renamed or retyped here, and the two "Custom stamps" dropdowns are
 * left alone entirely: those drive how many artwork upload slots appear, by
 * reading a number off the front of the chosen value, and a renamed choice
 * would quietly stop asking for the artwork it charged for.
 */

import { esc } from './lib.js';

export const CHOICES_MAX = 40;
export const CHOICE_MAX = 80;
/** Above this a modifier is far more likely a typo than an upcharge. */
export const PRICE_MAX = 500;

export class OptionError extends Error {}

/* ------------------------------------------------------------------ model */

/** What a choice says when it is shown but cannot be picked. */
export const DEFAULT_NOTE = 'out of stock';

/**
 * `White +10.00` -> { value: 'White', price: '10.00' }
 * `Brown -- out of stock` -> { value: 'Brown', note: 'out of stock' }
 *
 * A note makes the choice unavailable: still on the list, greyed out, saying
 * why. That is how the radio bucket carries brown while there are no photos of
 * it — a colour taken off the list entirely tells a customer nothing, and a
 * colour left on it takes an order the bench cannot fill.
 */
export function parseChoice(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let rest = text;
  let note = '';
  const marked = /^(.*?)\s*(?:--|—)\s*(.*)$/.exec(text);
  if (marked) {
    rest = marked[1].trim();
    note = marked[2].trim().slice(0, CHOICE_MAX) || DEFAULT_NOTE;
  }

  const priced = /^(.*?)\s*\+\s*\$?\s*(\d+(?:\.\d{1,2})?)$/.exec(rest);
  const value = (priced ? priced[1] : rest).trim();
  if (!value) throw new OptionError('A choice needs a name, not just a price.');
  if (value.length > CHOICE_MAX) {
    throw new OptionError(`"${value.slice(0, 30)}…" is too long for a dropdown.`);
  }

  if (!priced) return { value, price: '', note };

  const amount = Number(priced[2]);
  if (!Number.isFinite(amount) || amount <= 0 || amount > PRICE_MAX) {
    throw new OptionError(`${priced[2]} is not a price this would charge. Use 1 to ${PRICE_MAX}.`);
  }
  return { value, price: amount.toFixed(2), note };
}

/** The textarea's text, back out of the stored choices. */
export function choicesToText(choices) {
  const lines = [];
  let group = '';

  for (const c of choices || []) {
    if ((c.group || '') !== group) {
      group = c.group || '';
      if (group) lines.push(`## ${group}`);
    }
    let line = c.value;
    if (c.price) line += ` +${c.price}`;
    if (c.note) line += ` -- ${c.note}`;
    lines.push(line);
  }

  return lines.join('\n');
}

export function choicesFromText(text) {
  const lines = String(text ?? '').split('\n');
  const choices = [];
  let group = '';

  for (const line of lines) {
    // `## Waterproof` starts a heading in the dropdown. The hat colours come
    // in two of them, one per blank the shop buys, and a customer scrolling
    // twenty-six of them ungrouped is a customer picking the wrong blank.
    const heading = /^\s*##\s*(.*)$/.exec(line);
    if (heading) {
      group = heading[1].trim().slice(0, CHOICE_MAX);
      continue;
    }
    const choice = parseChoice(line);
    if (choice) choices.push(group ? { ...choice, group } : choice);
  }

  if (choices.length > CHOICES_MAX) {
    throw new OptionError(`That is more than ${CHOICES_MAX} choices in one dropdown.`);
  }

  const seen = new Set();
  for (const c of choices) {
    const key = c.value.toLowerCase();
    if (seen.has(key)) throw new OptionError(`"${c.value}" is in that list twice.`);
    seen.add(key);
  }

  return choices;
}

/**
 * One product's dropdowns, cleaned. `fields` is what the repo's page declares,
 * so a name the page does not have cannot be invented here and a locked field
 * cannot be written to. Returns null when nothing differs from the page.
 */
export function buildOptions(input = {}, fields = []) {
  const known = new Map(fields.map((f) => [f.name, f]));
  const out = {};

  for (const [name, text] of Object.entries(input || {})) {
    const field = known.get(name);
    if (!field || field.locked) continue;

    const choices = choicesFromText(text);
    if (!choices.length) {
      throw new OptionError(`${field.label} has no choices left. A dropdown needs at least one.`);
    }
    // `snipcartName` and `priced` are copied in rather than looked up later:
    // the storefront rewrite has the record and the page it is streaming, and
    // no chance to go and read the page's own form first.
    out[name] = {
      choices,
      placeholder: field.placeholder,
      snipcartName: field.snipcartName,
      priced: field.priced,
    };
  }

  return Object.keys(out).length ? out : null;
}

export function optionsFor(record, product) {
  const options = record?.products?.[product]?.options;
  return options && typeof options === 'object' ? options : null;
}

/** What the dropdown is showing today: the override, or the page's own list. */
export function effectiveChoices(options, field) {
  return options?.[field.name]?.choices || field.choices;
}

/**
 * Drops any dropdown whose list still says exactly what the page says. Keeps
 * "no override" and "an override that changes nothing" the same thing, and
 * keeps a field that was never touched following the repo.
 */
export function withoutBuiltInOptions(options, fields = []) {
  if (!options) return null;
  const known = new Map(fields.map((f) => [f.name, f]));
  const kept = {};

  for (const [name, set] of Object.entries(options)) {
    const field = known.get(name);
    if (!field) continue;
    if (choicesToText(set.choices) === choicesToText(field.choices)) continue;
    kept[name] = set;
  }

  return Object.keys(kept).length ? kept : null;
}

/* ----------------------------------------------------------------- markup */

/**
 * The `<option>` children, in the shape the repo's pages use: an explicit
 * value, the price shown in the label where there is one, and the first choice
 * selected unless the field makes you choose.
 */
export function optionsHtml(choices, { placeholder = null } = {}) {
  // Three shapes in the repo and all three are kept exactly:
  //   required — "Select..." greyed out and unpickable; the customer must choose
  //   optional — a plain empty row, "Select..." or "No preference", which
  //              leaves the field blank and is a legitimate answer
  //   neither  — no empty row at all, and the dropdown opens on a real choice
  const head = placeholder
    ? (placeholder.required
      ? `<option value="" disabled selected hidden>${esc(placeholder.text)}</option>`
      : `<option value="">${esc(placeholder.text)}</option>`)
    : '';

  // Whatever the dropdown opens on has to be something a customer can actually
  // pick. An unavailable choice at the top of the list would sit there selected
  // and greyed, and the order would carry a colour the bench cannot cut.
  const first = choices.findIndex((c) => !c.note);

  let out = head;
  let group = '';

  choices.forEach((c, i) => {
    const want = c.group || '';
    if (want !== group) {
      if (group) out += '</optgroup>';
      if (want) out += `<optgroup label="${esc(want)}">`;
      group = want;
    }

    const selected = !placeholder && i === first ? ' selected' : '';
    const priced = c.price ? `${c.value} (+$${c.price})` : c.value;
    out += c.note
      ? `<option value="${esc(c.value)}" disabled>${text(priced)} &mdash; ${text(c.note)}</option>`
      : `<option value="${esc(c.value)}"${selected}>${text(priced)}</option>`;
  });

  return group ? out + '</optgroup>' : out;
}

/**
 * Escaping for what a label says, rather than for an attribute. A quote inside
 * element text is not dangerous and the repo writes it plainly — `50"-56"` —
 * so escaping it here would change every strap length for no reason.
 */
function text(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The `data-options` string Snipcart parses.
 *
 * A list with no prices in it still matters. `Waterproof|Richardson 112` costs
 * nothing either way, and it is what makes Snipcart show the field as a
 * dropdown in the cart and check the value came off it. Four fields on the
 * hats are exactly that, so this never decides for itself whether the string
 * is worth having — the caller does, from whether the page declared one.
 */
export function dataOptionsString(choices) {
  // An unavailable choice is left out. Snipcart checks the value it is handed
  // against this list, and a colour nobody can select should not be one it
  // would accept if it arrived some other way.
  return choices
    .filter((c) => !c.note)
    .map((c) => (c.price ? `${c.value}[+${c.price}]` : c.value))
    .join('|');
}

/** Whether this field should carry one at all: it had one, or it costs money now. */
export function needsDataOptions(set) {
  return Boolean(set?.priced) || (set?.choices || []).some((c) => c.price);
}

/* ------------------------------------------------- reading the repo's page */

const SELECT_RE = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
/** An opening optgroup, a closing one, or an option — in document order. */
const PART_RE = /<optgroup\b[^>]*label="([^"]*)"[^>]*>|<\/optgroup\s*>|<option\b([^>]*)>([\s\S]*?)<\/option>/gi;

function attr(tag, name) {
  const found = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return found ? found[1] : null;
}

function hasAttr(tag, name) {
  return new RegExp(`\\b${name}\\b`, 'i').test(tag);
}

function decode(text) {
  return String(text || '')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

/**
 * Every dropdown in a product page's order form, with the choices it offers
 * today. This is what fills the editor in, and it is also the list of names a
 * save is allowed to write to — the page decides what exists, not the record.
 *
 * Prices come off `data-options` rather than out of the "(+$10.00)" printed in
 * the label. The attribute is what Snipcart actually charges against; the
 * label is a description of it, and if the two ever disagreed the attribute is
 * the one telling the truth.
 */
export function extractOptions(html) {
  const form = /<form\b[^>]*data-order-form[\s\S]*?<\/form>/i.exec(String(html || ''));
  if (!form) return [];

  const block = form[0];
  const fields = [];

  for (const match of block.matchAll(SELECT_RE)) {
    const tag = match[1];
    const name = attr(tag, 'name');
    if (!name) continue;

    const dataOptions = attr(tag, 'data-options');
    const prices = new Map();
    if (dataOptions) {
      for (const part of dataOptions.split('|')) {
        const priced = /^(.*?)\[\+([\d.]+)\]$/.exec(part);
        if (priced) prices.set(decode(priced[1]), Number(priced[2]).toFixed(2));
      }
    }

    let placeholder = null;
    let group = '';
    const choices = [];

    // Options and group headings in the order they appear, so a choice knows
    // which heading it sits under.
    for (const opt of match[2].matchAll(PART_RE)) {
      if (opt[1] !== undefined) { group = decode(opt[1]); continue; }
      if (opt[0].startsWith('</optgroup')) { group = ''; continue; }

      const optTag = opt[2];
      const text = decode(opt[3]);
      const value = attr(optTag, 'value') !== null ? decode(attr(optTag, 'value')) : text;

      // An empty value is never a choice, it is the absence of one — whether it
      // is the greyed "Select..." on a required field or the plain "No
      // preference" row on an optional one. Reading it as a choice would put an
      // option with no value and no label on the page.
      if (value === '') {
        placeholder = { text: text || 'Select...', required: hasAttr(optTag, 'disabled') };
        continue;
      }

      // A disabled row IS a choice — one that says why it cannot be picked.
      // The reason is whatever the label says past the value and its price:
      // "Brown &mdash; out of stock" on a row whose value is "Brown".
      let note = '';
      if (hasAttr(optTag, 'disabled')) {
        const priced = prices.get(value);
        const shown = priced ? `${value} (+$${priced})` : value;
        const tail = text.startsWith(shown) ? text.slice(shown.length) : text.slice(value.length);
        note = tail.replace(/^\s*(?:--|—|-)\s*/, '').trim() || DEFAULT_NOTE;
      }

      const choice = { value, price: prices.get(value) || '', note };
      if (group) choice.group = group;
      choices.push(choice);
    }

    const id = attr(tag, 'id');
    const labelTag = id
      ? new RegExp(`<label[^>]*for="${id}"[^>]*>([\\s\\S]*?)</label>`, 'i').exec(block)
      : null;
    // The label carries its own required marker and its own "(optional)" note.
    // Both are said again by the editor, in its own words.
    const label = labelTag
      ? decode(labelTag[1].replace(/<[^>]+>/g, ' '))
        .replace(/\(optional\)/ig, '')
        .replace(/[*\s]+$/, '')
        .replace(/\s+/g, ' ')
        .trim()
      : (attr(tag, 'data-label') || name);

    fields.push({
      name,
      label: label || name,
      snipcartName: attr(tag, 'data-label') || name,
      required: hasAttr(tag, 'required'),
      placeholder,
      priced: Boolean(dataOptions),
      // Reading a number off the front of the chosen value is how the page
      // decides to show one artwork slot or two. A renamed choice would stop
      // asking for artwork it just charged for, so this one is not edited here.
      locked: hasAttr(tag, 'data-logo-count'),
      choices,
    });
  }

  return fields;
}

/* ------------------------------------------------------------------ rules */

/**
 * Where a product's dropdowns land in its page. Two places for a priced list,
 * and they have to agree: the `<select>` the customer uses, and the hidden buy
 * button Snipcart's crawler reads to check the price.
 *
 * The button's fields are numbered, and the numbering is positional — so it is
 * resolved from the page at rewrite time by matching the name, never from a
 * number stored here. A stored index would be silently wrong the day a field
 * moved in the HTML, and the wrong upcharge would land on the wrong option.
 */
export function optionRules(options) {
  if (!options) return [];
  const rules = [];
  const byName = {};

  for (const [name, set] of Object.entries(options)) {
    const choices = set?.choices || [];
    if (!choices.length) continue;

    const dataOptions = needsDataOptions(set) ? dataOptionsString(choices) : '';
    rules.push({
      selector: `form[data-order-form] select[name="${name}"]`,
      action: 'select',
      value: optionsHtml(choices, { placeholder: set.placeholder }),
      dataOptions,
    });

    // A field the page never declared one for does not need one now. Any other
    // field does, and with the current list: leave the button holding the old
    // one and Snipcart charges an upcharge the dropdown no longer offers, or
    // refuses a colour the page now shows.
    if (dataOptions) byName[set.snipcartName || name] = dataOptions;
  }

  if (Object.keys(byName).length) {
    rules.push({ selector: 'button.snipcart-add-item', action: 'custom-options', byName });
  }

  return rules;
}
