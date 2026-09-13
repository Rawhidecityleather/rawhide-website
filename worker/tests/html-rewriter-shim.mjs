/**
 * A stand-in for the Workers HTMLRewriter, wide enough for the sale banner and
 * no wider. Node has no HTMLRewriter, and the banner is the only place the
 * Worker uses one, so this covers exactly the two selectors promo.js registers:
 * an element by class, and a <p> directly inside it.
 *
 * It exists so the tests and the Node preview run the real applyPromoBanner
 * rather than a copy of its logic. It is not a general HTML rewriter — if a
 * second feature ever needs one, reach for a real parser instead of growing this.
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

function apply(html, selector, handler) {
  const byClass = selector.match(/^\.([\w-]+)(?:\s+p)?$/);
  if (!byClass) throw new Error(`shim cannot handle selector ${selector}`);
  const cls = byClass[1];
  const wantsP = /\s+p$/.test(selector);

  const open = new RegExp(`<div\\s+class="([^"]*\\b${cls}\\b[^"]*)"([^>]*)>`);
  const m = open.exec(html);
  if (!m) return html;

  if (!wantsP) {
    let classes = m[1];
    const el = {
      getAttribute: (n) => (n === 'class' ? classes : null),
      setAttribute: (n, v) => { if (n === 'class') classes = v; },
    };
    handler.element?.(el);
    return html.slice(0, m.index) + `<div class="${classes}"${m[2]}>` + html.slice(m.index + m[0].length);
  }

  const after = html.slice(m.index);
  const p = /<p>([\s\S]*?)<\/p>/.exec(after);
  if (!p) return html;
  let inner = p[1];
  const el = {
    setInnerContent: (text, opts) => { inner = opts?.html ? text : esc(text); },
  };
  handler.element?.(el);
  const start = m.index + p.index;
  return html.slice(0, start) + `<p>${inner}</p>` + html.slice(start + p[0].length);
}
