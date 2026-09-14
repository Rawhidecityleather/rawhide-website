/**
 * A stand-in for the Workers HTMLRewriter, for the tests and the Node preview.
 *
 * Node has no HTMLRewriter, and two features now depend on one: the sale banner
 * swaps the announcement bar, and product photos swap a gallery, a handful of
 * meta and data attributes, a JSON-LD block and the cards in the shop grid.
 * Testing either against a copy of its own logic would prove nothing, so this
 * runs the real applyPromoBanner and applyPhotos over real page markup.
 *
 * It is small but it is not a toy: it tokenises tags, counts nesting to find an
 * element's contents, and understands the selector shapes this Worker uses —
 * `.class`, `tag`, `tag.class`, `tag[attr]`, `tag[attr="value"]`, and a
 * descendant chain of those. What it is NOT is a compliant HTML parser. It
 * assumes well-formed markup with quoted attributes, which is what this repo's
 * pages are, and it runs each handler in its own pass rather than one streaming
 * pass — the same result only while the selectors do not overlap.
 *
 * Text handlers get their element's contents in TWO chunks, deliberately. The
 * real one splits text on buffer boundaries, so a handler that forgets to
 * accumulate works on short input and mangles long input. Always splitting here
 * means that bug fails a test instead of reaching a product page.
 */
export function installHTMLRewriterShim() {
  if (typeof globalThis.HTMLRewriter !== 'undefined' && globalThis.HTMLRewriter.__shim) return;

  class Shim {
    constructor() { this.handlers = []; }

    on(selector, handler) {
      this.handlers.push({ selector, handler });
      return this;
    }

    transform(response) {
      const work = response.text().then((html) => {
        let out = html;
        for (const { selector, handler } of this.handlers) {
          out = apply(out, selector, handler);
        }
        return new Response(out, { status: response.status, headers: response.headers });
      });
      // The real one returns a Response synchronously with a streaming body.
      // Callers here only ever await it, and awaiting a Promise<Response> is
      // the same to them.
      return work;
    }
  }
  Shim.__shim = true;
  globalThis.HTMLRewriter = Shim;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Elements with no contents, so with no closing tag to go looking for. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const OPEN_TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'=<>`/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;

/* ------------------------------------------------------------- attributes */

function parseAttrs(raw) {
  const attrs = [];
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw || ''))) {
    attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? null });
  }
  return attrs;
}

/**
 * Only values the handler SET are escaped. An attribute read back off the page
 * still holds its source text — `3&quot; Leather Velcro Patch` — and escaping
 * that again on the way out would turn it into `3&amp;quot;` and corrupt a
 * page this never meant to touch.
 */
function serialiseAttrs(attrs) {
  return attrs.map((a) => {
    if (a.value === null) return ` ${a.name}`;
    const value = a.set
      ? String(a.value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      : a.value;
    return ` ${a.name}="${value}"`;
  }).join('');
}

/* -------------------------------------------------------------- selectors */

/**
 * One step of a selector: an optional tag name followed by any number of
 * `.class` and `[attr]` / `[attr="value"]` filters.
 */
function parsePart(part) {
  const tag = /^([a-zA-Z][\w-]*)/.exec(part);
  const classes = [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const attrs = [...part.matchAll(/\[([^\]=]+)(?:=["']([^"']*)["'])?\]/g)]
    .map((m) => ({ name: m[1], value: m[2] ?? null }));
  return { tag: tag ? tag[1].toLowerCase() : '', classes, attrs };
}

function parseSelector(selector) {
  return selector.trim().split(/\s+/).map(parsePart);
}

function matches(el, part) {
  if (part.tag && part.tag !== el.tag) return false;

  if (part.classes.length) {
    const classAttr = el.attrs.find((a) => a.name === 'class');
    const have = new Set((classAttr?.value || '').split(/\s+/).filter(Boolean));
    if (!part.classes.every((c) => have.has(c))) return false;
  }

  return part.attrs.every((want) => {
    const got = el.attrs.find((a) => a.name === want.name);
    if (!got) return false;
    return want.value === null || got.value === want.value;
  });
}

/* ------------------------------------------------------------------- scan */

/** Every open tag between `from` and `to`, with its attributes parsed out. */
function scan(html, from = 0, to = html.length) {
  const found = [];
  OPEN_TAG.lastIndex = from;
  let m;
  while ((m = OPEN_TAG.exec(html))) {
    if (m.index >= to) break;
    found.push({
      tag: m[1].toLowerCase(),
      attrs: parseAttrs(m[2]),
      selfClosing: m[3] === '/',
      start: m.index,
      openEnd: m.index + m[0].length,
    });
  }
  return found;
}

/**
 * Where an element's contents end, counting nested tags of the same name so a
 * div inside a div does not close the outer one early.
 */
function contentEnd(html, el) {
  if (VOID.has(el.tag) || el.selfClosing) return el.openEnd;

  const open = new RegExp(`<${el.tag}\\b`, 'gi');
  const close = new RegExp(`</${el.tag}\\s*>`, 'gi');
  let depth = 1;
  let at = el.openEnd;

  while (depth > 0) {
    close.lastIndex = at;
    const shut = close.exec(html);
    if (!shut) return html.length;

    open.lastIndex = at;
    let nested = 0;
    let o;
    while ((o = open.exec(html)) && o.index < shut.index) nested++;

    depth += nested - 1;
    at = shut.index + shut[0].length;
    if (depth === 0) return shut.index;
  }
  return at;
}

/**
 * The elements a selector picks out. A descendant chain is resolved left to
 * right: each step searches only inside the range of the step before it.
 */
function select(html, selector) {
  const parts = parseSelector(selector);
  let scopes = [{ from: 0, to: html.length }];
  let hits = [];

  parts.forEach((part, depth) => {
    hits = [];
    for (const scope of scopes) {
      for (const el of scan(html, scope.from, scope.to)) {
        if (matches(el, part)) hits.push(el);
      }
    }
    if (depth < parts.length - 1) {
      scopes = hits.map((el) => ({ from: el.openEnd, to: contentEnd(html, el) }));
    }
  });

  return hits;
}

/* ------------------------------------------------------------------ apply */

/**
 * Handlers run in document order, the way the real one streams them, because
 * some of them count: the wording rule takes the FIRST `.product-description`
 * on a page and leaves the second alone. Editing forward moves everything
 * after the edit, so a running delta carries the later matches along.
 */
function apply(html, selector, handler) {
  const hits = select(html, selector);
  let out = html;
  let delta = 0;

  for (const found of hits) {
    const el = { ...found, start: found.start + delta, openEnd: found.openEnd + delta };

    if (handler.element) {
      const attrs = el.attrs.map((a) => ({ ...a }));
      let inner = null;

      handler.element({
        tagName: el.tag,
        // The real one exposes this as an iterator of [name, value]. The
        // Snipcart buy button is read through it: its custom fields are
        // numbered, and the number has to be found by matching a name.
        get attributes() {
          return attrs.map((a) => [a.name, a.value ?? ''])[Symbol.iterator]();
        },
        getAttribute: (name) => attrs.find((a) => a.name === name)?.value ?? null,
        hasAttribute: (name) => attrs.some((a) => a.name === name),
        setAttribute: (name, value) => {
          const target = attrs.find((a) => a.name === name);
          if (target) { target.value = String(value); target.set = true; }
          else attrs.push({ name, value: String(value), set: true });
        },
        removeAttribute: (name) => {
          const i = attrs.findIndex((a) => a.name === name);
          if (i >= 0) attrs.splice(i, 1);
        },
        setInnerContent: (content, opts) => {
          inner = opts?.html ? String(content) : esc(content);
        },
      });

      const openTag = `<${el.tag}${serialiseAttrs(attrs)}${el.selfClosing ? '/' : ''}>`;
      const oldEnd = inner === null ? el.openEnd : contentEnd(out, el);
      const replacement = inner === null ? openTag : openTag + inner;

      out = out.slice(0, el.start) + replacement + out.slice(oldEnd);
      delta += replacement.length - (oldEnd - el.start);
      el.openEnd = el.start + openTag.length;
    }

    if (handler.text && !VOID.has(el.tag)) {
      const end = contentEnd(out, el);
      const text = out.slice(el.openEnd, end);

      const split = Math.floor(text.length / 2);
      const pieces = text.length > 1 ? [text.slice(0, split), text.slice(split)] : [text];
      let rebuilt = '';

      pieces.forEach((piece, i) => {
        let replacement = null;
        let removed = false;
        handler.text({
          text: piece,
          lastInTextNode: i === pieces.length - 1,
          remove: () => { removed = true; },
          replace: (content, opts) => { replacement = opts?.html ? String(content) : esc(content); },
        });
        if (replacement !== null) rebuilt += replacement;
        else if (!removed) rebuilt += piece;
      });

      out = out.slice(0, el.openEnd) + rebuilt + out.slice(end);
      delta += rebuilt.length - (end - el.openEnd);
    }
  }

  return out;
}
