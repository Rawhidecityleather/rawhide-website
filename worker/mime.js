/**
 * Just enough MIME to read a forwarded receipt.
 *
 * An email arriving at the Worker is a stream of bytes in a format from 1982:
 * headers folded across lines, a tree of parts separated by boundary strings,
 * and every interesting piece encoded so it survives a 7-bit wire. Pulling a
 * PDF invoice back out of that is the whole job of this file.
 *
 * Hand-written rather than an npm parser on purpose. This repo has no
 * dependencies and no install step — `node worker/tests/run.mjs` is the entire
 * setup — and that is the only reason any of it still gets run in a year. The
 * parse surface here is genuinely small: walk the tree, decode base64 and
 * quoted-printable, hand back the text and the attachments. What it cannot
 * read it fails at cleanly, and the message is forwarded to the shop inbox
 * either way, so a receipt this chokes on is a row typed in by hand rather
 * than a receipt lost.
 *
 * Nothing here trusts a declared type. The bytes go to `detect()` in
 * uploads.js, which reads the file's own signature — so a vendor that labels
 * its invoice application/octet-stream still files correctly, and a .pdf that
 * is actually something else never gets stored as one.
 *
 * Everything works on a "binary string": one character per byte, which is what
 * `binaryFrom` produces. That keeps base64 decoding exact — decoding to real
 * text first would have already mangled the bytes by guessing a charset.
 */

/* ------------------------------------------------------------------ bytes */

/**
 * Bytes to a one-character-per-byte string.
 *
 * Chunked because `String.fromCharCode(...bytes)` spreads a megabyte of
 * arguments onto the stack and throws — the same trap as toBase64 in
 * receipts.js, hit for the same reason.
 */
export function binaryFrom(bytes) {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** And back. */
export function bytesFrom(binary) {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Bytes to readable text, in whatever charset the part declared.
 *
 * Almost everything says utf-8. The fallback is latin1 — not a guess, but the
 * one decoding that never throws and never drops a byte, so a receipt in an
 * odd charset still comes out readable enough to find a total in.
 */
export function textFrom(binary, charset) {
  const label = String(charset || 'utf-8').toLowerCase();
  if (label === 'latin1' || label === 'iso-8859-1' || label === 'us-ascii') return binary;

  try {
    return new TextDecoder(label, { fatal: false }).decode(bytesFrom(binary));
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytesFrom(binary));
    } catch {
      return binary;
    }
  }
}

/* ---------------------------------------------------------------- headers */

/** Splits a message or a part into its header block and its body. */
export function splitHead(raw) {
  const text = String(raw || '');
  const blank = text.search(/\r?\n\r?\n/);
  if (blank < 0) return { head: text, body: '' };
  const gap = text.slice(blank).match(/^\r?\n\r?\n/)[0].length;
  return { head: text.slice(0, blank), body: text.slice(blank + gap) };
}

/**
 * Header lines as [name, value] pairs, name lowercased.
 *
 * A long header is folded across several lines with the continuations
 * indented — a Content-Type carrying a boundary almost always is — so those
 * get put back together before anything tries to read them.
 */
export function parseHeaders(head) {
  const out = [];
  for (const line of String(head || '').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1][1] += ' ' + line.trim();
      continue;
    }
    const at = line.indexOf(':');
    if (at < 1) continue;
    out.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
  }
  return out;
}

export function headerValue(headers, name) {
  const hit = (headers || []).find(([key]) => key === name);
  return hit ? hit[1] : '';
}

/**
 * A Content-Type or Content-Disposition, split into its value and parameters.
 *
 * RFC 2231 continuations (`filename*0=`, `filename*=utf-8''…`) are folded back
 * into the plain name, because a long attachment filename is exactly where
 * they turn up and the caller should not have to know that.
 */
export function parseContentType(raw) {
  const text = String(raw || '');
  const semi = text.indexOf(';');
  const type = (semi < 0 ? text : text.slice(0, semi)).trim().toLowerCase();
  const params = {};
  const pieces = {};

  const PARAM = /;[ \t]*([\w!#$%&'*+.^`|~-]+?)(\*\d+)?(\*)?[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|[^;]*)/g;
  let match;
  while ((match = PARAM.exec(text)) !== null) {
    const [, name, index, extended, rawValue] = match;
    let value = rawValue.trim();
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\(.)/g, '$1');

    // utf-8''Receipt%20August.pdf — charset, language, then percent-encoding.
    if (extended) {
      const parts = value.split("'");
      const encoded = parts.length >= 3 ? parts.slice(2).join("'") : value;
      try {
        value = decodeURIComponent(encoded);
      } catch {
        value = encoded;
      }
    }

    const key = name.toLowerCase();
    if (index) {
      pieces[key] = pieces[key] || [];
      pieces[key][Number(index.slice(1))] = value;
    } else {
      params[key] = value;
    }
  }

  for (const [key, parts] of Object.entries(pieces)) {
    if (params[key] === undefined) params[key] = parts.filter((p) => p !== undefined).join('');
  }

  return { type, params };
}

/**
 * RFC 2047 encoded words in a header: `=?utf-8?B?…?=`.
 *
 * Subjects carry them constantly, and the subject is what a receipt with no
 * attachment ends up filed under — worth reading properly rather than showing
 * the shop a row of question marks.
 */
export function decodeWords(text) {
  return String(text || '')
    // Whitespace between two adjacent encoded words is a separator the sender
    // had to insert, not part of the text. Dropped before decoding either.
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, kind, payload) => {
      try {
        const binary = kind.toUpperCase() === 'B'
          ? decodeBase64(payload)
          : decodeQuotedPrintable(payload.replace(/_/g, ' '));
        // Nothing out of something in is a payload that was never valid. Show
        // the shop the raw header rather than silently deleting the subject.
        if (payload && !binary) return whole;
        return textFrom(binary, charset);
      } catch {
        return whole;
      }
    });
}

/* --------------------------------------------------------------- decoding */

export function decodeQuotedPrintable(binary) {
  return String(binary)
    // A soft line break: the sender split a long line, it is not in the text.
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function decodeBase64(binary) {
  try {
    return atob(String(binary).replace(/[^A-Za-z0-9+/=]/g, ''));
  } catch {
    return '';
  }
}

function decodeBody(body, encoding) {
  const how = String(encoding || '').trim().toLowerCase();
  if (how === 'base64') return decodeBase64(body);
  if (how === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

/* ------------------------------------------------------------------ parts */

/**
 * The parts of a multipart body, split on its boundary.
 *
 * A boundary only counts at the start of a line, and the run ends at the
 * closing `--boundary--`: text after that is the epilogue, which some mailers
 * fill with "this is a MIME message" boilerplate that must not become a part.
 */
export function splitParts(body, boundary) {
  const marker = '--' + boundary;
  const out = [];
  let open = -1;
  let index = 0;

  while (index <= body.length) {
    const at = index === 0 && body.startsWith(marker) ? 0 : body.indexOf('\n' + marker, index);
    if (at < 0) break;

    const lineStart = at === 0 ? 0 : at + 1;
    const after = body.slice(lineStart + marker.length);

    // Guards against a boundary that is a prefix of a longer one: what follows
    // the marker has to be the close, the end of the line, or trailing space.
    if (!(after === '' || after.startsWith('--') || /^[ \t]*\r?\n/.test(after))) {
      index = lineStart + marker.length;
      continue;
    }

    if (open >= 0) out.push(body.slice(open, lineStart).replace(/\r?\n$/, ''));
    if (after.startsWith('--')) return out;

    const eol = after.indexOf('\n');
    open = eol < 0 ? body.length : lineStart + marker.length + eol + 1;
    index = open;
  }

  if (open >= 0) out.push(body.slice(open).replace(/\r?\n$/, ''));
  return out;
}

/** How deep a message can nest before we stop following it down. */
const MAX_DEPTH = 12;

/** How many attachments to carry out of one message. */
const MAX_ATTACHMENTS = 20;

function walk(headers, body, out, depth) {
  const content = parseContentType(headerValue(headers, 'content-type') || 'text/plain');

  if (content.type.startsWith('multipart/') && content.params.boundary && depth < MAX_DEPTH) {
    for (const part of splitParts(body, content.params.boundary)) {
      const split = splitHead(part);
      walk(parseHeaders(split.head), split.body, out, depth + 1);
    }
    return;
  }

  const decoded = decodeBody(body, headerValue(headers, 'content-transfer-encoding'));

  // A message forwarded as an attachment rather than inline — Gmail's "Forward
  // as attachment", and what Outlook does by default. The receipt is in there.
  if (content.type === 'message/rfc822' && depth < MAX_DEPTH) {
    const split = splitHead(decoded);
    walk(parseHeaders(split.head), split.body, out, depth + 1);
    return;
  }

  const disposition = parseContentType(headerValue(headers, 'content-disposition'));
  const name = decodeWords(disposition.params.filename || content.params.name || '');

  if (content.type.startsWith('text/') && disposition.type !== 'attachment') {
    const text = textFrom(decoded, content.params.charset);
    if (content.type === 'text/html') out.html.push(text);
    else out.text.push(text);
    return;
  }

  if (out.attachments.length < MAX_ATTACHMENTS) {
    out.attachments.push({
      name,
      mime: content.type,
      // `inline`, or anything with a content-id, is a signature logo or a
      // tracking pixel far more often than a receipt. Kept but flagged, so the
      // caller can prefer a real attachment over the sender's letterhead.
      inline: disposition.type === 'inline' || Boolean(headerValue(headers, 'content-id')),
      bytes: bytesFrom(decoded),
    });
  }
}

/**
 * One email, opened up.
 *
 * `raw` is a binary string — see binaryFrom. Never throws: a message this
 * cannot make sense of comes back with empty text and no attachments, which
 * the caller already has to handle, because a receipt the model can't read
 * arrives the same way.
 */
export function parseEmail(raw) {
  const out = {
    headers: [], from: '', fromName: '', to: '', subject: '', date: '',
    text: '', html: '', attachments: [],
  };

  try {
    const { head, body } = splitHead(raw);
    const headers = parseHeaders(head);
    const collected = { text: [], html: [], attachments: [] };

    walk(headers, body, collected, 0);

    const from = parseAddress(headerValue(headers, 'from'));
    out.headers = headers;
    out.from = from.address;
    out.fromName = from.name;
    out.to = parseAddress(headerValue(headers, 'to')).address;
    out.subject = decodeWords(headerValue(headers, 'subject')).trim().slice(0, 200);
    out.date = headerValue(headers, 'date');
    out.text = collected.text.join('\n\n').trim();
    out.html = collected.html.join('\n').trim();
    out.attachments = collected.attachments;
  } catch (err) {
    console.error('email parse failed', err?.message || err);
  }

  return out;
}

/** `"Tandy Leather" <orders@tandy.com>` split into its two halves. */
export function parseAddress(raw) {
  const text = decodeWords(raw).trim();
  const angled = text.match(/^([\s\S]*)<([^>]*)>[\s]*$/);
  const address = (angled ? angled[2] : text).trim().toLowerCase();
  let name = angled ? angled[1].trim() : '';
  if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  return { name: name.trim(), address };
}

/* ------------------------------------------------------------------- html */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', middot: '·',
};

/**
 * An HTML receipt as plain text, for the model to read.
 *
 * Most emailed receipts — the ad platforms, the marketplaces, the software
 * subscriptions — are an HTML table and nothing else, and the vendor, date and
 * total are all in there as text. The markup is noise around them, and a table
 * flattened to lines reads well enough for the numbers to be found.
 */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n')
    // Cells run together into "Total$41.20" without something between them.
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}
