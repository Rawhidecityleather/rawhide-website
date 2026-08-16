/**
 * Customer artwork uploads, for the custom stamp options on the radio strap.
 *
 * Snipcart has six custom-field types and none of them is a file, so artwork
 * cannot ride along in the cart. The product page uploads the file here first,
 * gets a URL back, and puts that URL into an ordinary readonly custom field.
 * The order carries a link; the bytes live in R2.
 *
 * Routes (wired in index.js)
 *   POST /api/logo-upload   PUBLIC — customers are not logged in.
 *   GET  /logo/<key>        Behind the same Basic auth as the dashboard.
 *
 * Binding:
 *   LOGOS — R2 bucket. Create it once with
 *           `wrangler r2 bucket create rawhide-logo-uploads`.
 */

import { json } from './lib.js';

/** Big enough for a phone photo of a patch, small enough to bound abuse. */
export const MAX_BYTES = 8 * 1024 * 1024;

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']);

/**
 * A declared content-type is the browser guessing from a file extension, so
 * the first bytes decide instead.
 *
 * SVG is deliberately absent. It is XML that can carry script, and these files
 * are served back from our own origin — an SVG here would be a stored XSS on
 * the packing slip.
 */
const SIGNATURES = [
  { ext: 'png', mime: 'image/png', at: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', mime: 'image/jpeg', at: 0, bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', mime: 'image/gif', at: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'pdf', mime: 'application/pdf', at: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: 'webp', mime: 'image/webp', at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { ext: 'heic', mime: 'image/heic', at: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

/** What the file actually is, or null. `head` is the first 16 bytes. */
export function detect(head) {
  const b = head || [];
  for (const sig of SIGNATURES) {
    if (!sig.bytes.every((byte, i) => b[sig.at + i] === byte)) continue;

    // 'ftyp' at offset 4 is the whole ISO base media family — .mp4 and .mov
    // carry it too. Only the still-image brands are pictures.
    if (sig.ext === 'heic') {
      let brand = '';
      for (let i = 8; i < 12; i++) brand += String.fromCharCode(b[i] || 0);
      return HEIC_BRANDS.has(brand) ? sig : null;
    }

    return sig;
  }
  return null;
}

/**
 * The customer's filename, kept only to show them and print on the slip. It
 * never becomes part of a path — the stored key is random — so this just has
 * to be safe to display.
 */
export function safeName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop() || 'artwork';
  const clean = base.replace(/[^A-Za-z0-9._ -]+/g, '').replace(/\s+/g, ' ').trim();
  return (clean || 'artwork').slice(0, 60);
}

/** Random, so a stored key can't be walked or guessed from a neighbouring one. */
function newKey(ext) {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  let hex = '';
  for (const byte of raw) hex += byte.toString(16).padStart(2, '0');
  return `${hex}.${ext}`;
}

export function isLogoKey(key) {
  return /^[0-9a-f]{32}\.(png|jpg|gif|pdf|webp|heic)$/.test(String(key || ''));
}

/**
 * Cross-site posts get nothing. Not a security boundary on its own — the size
 * cap and the type check are — but it keeps the endpoint from being a free
 * file host for anyone who finds it.
 *
 * Real volume control belongs in a Cloudflare rate-limiting rule on this path;
 * a Worker has no cheap way to count requests per IP.
 */
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // Same-origin form posts may omit it entirely.
  try {
    return new URL(origin).hostname === new URL(request.url).hostname;
  } catch {
    return false;
  }
}

export async function handleLogoUpload(request, env) {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!env.LOGOS) {
    return json({ error: 'Uploads are not set up. Add the LOGOS R2 binding.' }, 500);
  }
  if (!sameOrigin(request)) return json({ error: 'Bad request.' }, 403);

  // Cheap rejection before reading a body we already know is too big.
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BYTES + 4096) return json({ error: 'That file is too big.' }, 413);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Could not read that upload.' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'No file was attached.' }, 400);
  }
  if (!file.size) return json({ error: 'That file is empty.' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'That file is too big.' }, 413);

  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = detect(head);
  if (!kind) {
    return json({
      error: 'That file type is not supported. Send a PNG, JPG, WEBP, GIF, HEIC, or PDF.',
    }, 415);
  }

  const name = safeName(file.name);
  const key = newKey(kind.ext);

  await env.LOGOS.put(key, file.stream(), {
    httpMetadata: { contentType: kind.mime },
    customMetadata: { originalName: name, uploaded: new Date().toISOString() },
  });

  return json({
    ok: true,
    name,
    size: file.size,
    url: new URL('/logo/' + key, request.url).toString(),
  });
}

/**
 * Serving is behind the dashboard's Basic auth: customer artwork is somebody
 * else's property and there is no reason for it to be public. The browser
 * re-sends those credentials for same-origin subresources, so a link on the
 * packing slip still opens in one click once the shop is logged in.
 */
export async function handleLogoFetch(path, env) {
  const key = path.slice('/logo/'.length);
  if (!env.LOGOS || !isLogoKey(key)) return new Response('Not found.', { status: 404 });

  const object = await env.LOGOS.get(key);
  if (!object) return new Response('Not found.', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
      // The allowed types are all inert, but the browser should not be the one
      // deciding that — nosniff keeps it from re-guessing into something active.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
