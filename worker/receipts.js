/**
 * Receipt capture — the file half of the expense ledger.
 *
 * The shop photographs a receipt on a phone, it lands in R2, and a vision model
 * reads the vendor, date and total off it so the row arrives mostly filled in.
 * Nothing here is trusted: every extracted field is a suggestion the shop
 * confirms on the expenses page before the row counts as reviewed. A model that
 * misreads a crumpled thermal receipt costs a correction, never a wrong number
 * in the year-end report.
 *
 * The ledger record itself lives in KV — see expenses.js. This module owns the
 * bytes and the reading of them.
 *
 * Routes (wired in index.js, all behind the dashboard login)
 *   POST /dashboard/api/receipt   upload one file, get a draft row back
 *   GET  /receipt/<key>           the stored image
 *
 * Bindings:
 *   RECEIPTS — R2 bucket. Create it once with
 *              `wrangler r2 bucket create rawhide-receipts`.
 *   AI       — Workers AI, for the extraction. Optional: with no binding, or
 *              with a model that fails, the upload still stores and the row
 *              comes back blank for typing in by hand.
 */

import { detect, safeName } from './uploads.js';
import { CATEGORIES, guessCategory, isCategory } from './expenses.js';

/** A phone photo of a receipt, with room for a multi-page PDF invoice. */
export const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Only these reach the model. PDF and HEIC are stored and listed like anything
 * else, they just arrive with empty fields — the vision endpoint takes an
 * image, and neither of those is one it can decode.
 */
const EXTRACTABLE = new Set(['png', 'jpg', 'webp', 'gif']);

/**
 * Past this the base64 payload is bigger than the model will take, and a
 * rejected call costs the same wait as a successful one. Phone photos land
 * well under it; a scanned multi-page invoice may not, and types it in.
 */
const EXTRACT_MAX_BYTES = 6 * 1024 * 1024;

/**
 * Vision model doing the reading. Swappable — everything downstream treats the
 * output as untrusted text and re-validates it, so a different model id here
 * changes accuracy and nothing else.
 */
export const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const PROMPT = `You are reading a purchase receipt for a small leather goods shop.
Return ONLY a JSON object, no explanation, no markdown fence, with these keys:
"vendor": the store or supplier name as printed, or ""
"date": the purchase date as YYYY-MM-DD, or ""
"total": the grand total actually paid, as a number, or null
"tax": the sales tax amount, as a number, or null
"category": one of ${CATEGORIES.map((c) => c.key).join(', ')}
"summary": at most 8 words on what was bought
Use the total paid, not the subtotal. Do not guess a date that is not printed.`;

export function isReceiptKey(key) {
  return /^[0-9a-f]{32}\.(png|jpg|gif|pdf|webp|heic)$/.test(String(key || ''));
}

function newKey(ext) {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  let hex = '';
  for (const byte of raw) hex += byte.toString(16).padStart(2, '0');
  return `${hex}.${ext}`;
}

/* -------------------------------------------------------------- extraction */

/**
 * btoa takes a string, and a receipt is a couple of megabytes of bytes.
 * Converting it in one `String.fromCharCode(...bytes)` spreads a million
 * arguments onto the stack and throws; this walks it in chunks instead.
 */
export function toBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Pulls the JSON object out of whatever the model said.
 *
 * Instruction-tuned models wrap JSON in prose or a code fence however firmly
 * the prompt asks them not to, and one that returns nothing usable is a normal
 * outcome here, not an error — the caller falls back to an empty row.
 */
export function parseExtraction(text) {
  if (!text || typeof text !== 'string') return null;

  const fenced = text.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The text of a Workers AI reply, whichever shape the model returns it in. */
function replyText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  if (typeof result.response === 'string') return result.response;
  // OpenAI-shaped models answer here instead.
  const choice = result.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  return '';
}

const MONEY_CEILING = 100000;

/** A number the model may have written as "$1,240.50" or handed over as a string. */
function toAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n <= 0 || n > MONEY_CEILING) return null;
  return Math.round(n * 100) / 100;
}

/**
 * A printed date the model read, or nothing.
 *
 * The far bound is tomorrow rather than today: a receipt bought tonight in a
 * timezone ahead of UTC is legitimately dated "tomorrow" as far as this Worker
 * is concerned. Anything past that, or before the shop existed, is a misread
 * (a phone number, an expiry date, a loyalty barcode) and is dropped rather
 * than filed under a year that would quietly land in the wrong tax return.
 */
export function cleanDate(value, now = new Date()) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';

  const parsed = new Date(text + 'T00:00:00Z');
  if (isNaN(parsed)) return '';
  if (parsed.getUTCFullYear() < 2024) return '';
  if (parsed.getTime() > now.getTime() + 86400000) return '';

  return text;
}

export function cleanVendor(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Turns the model's answer into the fields the ledger holds. Every one of them
 * can come back empty — that is a row to finish by hand, not a failure.
 */
export function draftFromExtraction(raw) {
  const draft = { vendor: '', date: '', amount: null, tax: null, category: 'other', summary: '' };
  if (!raw) return draft;

  draft.vendor = cleanVendor(raw.vendor);
  draft.date = cleanDate(raw.date);
  draft.amount = toAmount(raw.total ?? raw.amount);
  draft.tax = toAmount(raw.tax);
  draft.summary = cleanVendor(raw.summary).slice(0, 80);

  // The model's own pick only stands if it named a real bucket. Otherwise fall
  // back to reading the vendor, which is right more often than "other".
  const named = String(raw.category || '').trim().toLowerCase();
  draft.category = isCategory(named)
    ? named
    : guessCategory(`${draft.vendor} ${draft.summary}`);

  return draft;
}

/**
 * Reads one receipt. Never throws: extraction is a convenience on top of a
 * stored file, and losing it must not lose the upload.
 *
 * Returns the draft fields plus `read`, which the page uses to say whether the
 * numbers were suggested or are waiting to be typed.
 */
export async function extract(env, bytes, ext) {
  const blank = { vendor: '', date: '', amount: null, tax: null, category: 'other', summary: '' };

  if (!env.AI) return { ...blank, read: false, why: 'no AI binding' };
  if (!EXTRACTABLE.has(ext)) return { ...blank, read: false, why: `cannot read a ${ext}` };
  if (bytes.length > EXTRACT_MAX_BYTES) return { ...blank, read: false, why: 'file too big to read' };

  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: 'You extract structured data from receipt photos. You reply with JSON only.' },
        { role: 'user', content: PROMPT },
      ],
      image: `data:${mime};base64,${toBase64(bytes)}`,
      // Enough for the object and no room to start narrating.
      max_tokens: 300,
      // The number on the receipt is not a creative choice.
      temperature: 0.1,
    });

    const parsed = parseExtraction(replyText(result));
    if (!parsed) return { ...blank, read: false, why: 'could not read the receipt' };

    return { ...draftFromExtraction(parsed), read: true, why: '' };
  } catch (err) {
    // Model outage, rate limit, oversized payload — all the same to the shop:
    // the file is saved, the fields are empty, type them in.
    console.error('receipt extraction failed', err?.message || err);
    return { ...blank, read: false, why: 'reader unavailable' };
  }
}

/* ------------------------------------------------------------------ upload */

/**
 * Stores one file and reads it. The caller (index.js) writes the ledger record,
 * so that a stored object and its row are created in one place.
 */
export async function storeUpload(request, env) {
  if (!env.RECEIPTS) {
    return { error: 'Receipt storage is not set up. Add the RECEIPTS R2 binding.', status: 500 };
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BYTES + 4096) return { error: 'That file is too big.', status: 413 };

  let form;
  try {
    form = await request.formData();
  } catch {
    return { error: 'Could not read that upload.', status: 400 };
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    return { error: 'No file was attached.', status: 400 };
  }
  if (!file.size) return { error: 'That file is empty.', status: 400 };
  if (file.size > MAX_BYTES) return { error: 'That file is too big.', status: 413 };

  // Read once, into memory: the same bytes get stored and sent to the model,
  // and a stream can only be walked one time.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = detect(bytes.subarray(0, 16));
  if (!kind) {
    return {
      error: 'That file type is not supported. Send a PNG, JPG, WEBP, GIF, HEIC, or PDF.',
      status: 415,
    };
  }

  const name = safeName(file.name);
  const key = newKey(kind.ext);

  await env.RECEIPTS.put(key, bytes, {
    httpMetadata: { contentType: kind.mime },
    customMetadata: { originalName: name, uploaded: new Date().toISOString() },
  });

  const draft = await extract(env, bytes, kind.ext);

  return {
    key,
    file: { name, ext: kind.ext, mime: kind.mime, size: file.size },
    draft,
  };
}

/**
 * Serving is behind the dashboard login, same as customer artwork: these are
 * the shop's books. The browser re-sends Basic credentials for same-origin
 * subresources, so the thumbnails on the expenses page and the images in the
 * printed CPA packet both load with no extra step.
 */
export async function handleReceiptFetch(path, env) {
  const key = path.slice('/receipt/'.length);
  if (!env.RECEIPTS || !isReceiptKey(key)) return new Response('Not found.', { status: 404 });

  const object = await env.RECEIPTS.get(key);
  if (!object) return new Response('Not found.', { status: 404 });

  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export async function deleteReceipt(env, key) {
  if (!env.RECEIPTS || !isReceiptKey(key)) return false;
  await env.RECEIPTS.delete(key);
  return true;
}
