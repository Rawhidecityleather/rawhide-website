/**
 * Receipt capture — the file half of the expense ledger.
 *
 * The shop photographs a receipt on a phone, it lands in R2, and a model reads
 * the vendor, date and total off it so the row arrives mostly filled in. Two
 * ways in: a photo goes to the vision model as an image, while a PDF invoice
 * has its text layer pulled out first and is read as text. A HEIC off an iPhone
 * is turned into a JPEG before either, since nothing downstream can use one.
 * Nothing here is trusted: every extracted field is a suggestion the shop
 * confirms on the expenses page before the row counts as reviewed. A model that
 * misreads a crumpled thermal receipt costs a correction, never a wrong number
 * in the year-end report.
 *
 * The ledger record itself lives in KV — see expenses.js. This module owns the
 * bytes and the reading of them.
 *
 * A receipt does not have to be photographed to get here. One forwarded to the
 * shop's filing address comes down the same path — `storeReceipt` for an
 * attachment, `readText` and `storeBody` for a receipt that is the email
 * itself. See email-in.js; everything below is shared with it deliberately, so
 * there is one type check, one conversion and one reader, not two that drift.
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

/** Photographs. These go to the vision model as an image. */
const READABLE_IMAGES = new Set(['png', 'jpg', 'webp', 'gif']);

/**
 * Documents. A PDF is not a picture of a receipt, it is a receipt with the text
 * already in it — the ad platforms, the software subscriptions and the tanneries
 * all invoice this way — so it gets its text pulled out and read as text. Much
 * more accurate than photographing a screen, when the text layer is there.
 */
const READABLE_DOCS = new Set(['pdf']);

/**
 * Past this the base64 payload is bigger than the model will take, and a
 * rejected call costs the same wait as a successful one. Phone photos land
 * well under it; a scanned multi-page invoice may not, and types it in.
 */
const EXTRACT_MAX_BYTES = 6 * 1024 * 1024;

/**
 * Enough of an invoice to hold the header, the total and the tax line. Past
 * this is line items, terms and boilerplate, and the numbers we want have
 * already gone by.
 */
const MAX_DOC_CHARS = 8000;

/**
 * Below this there is nothing to read. A PDF with no text layer comes back
 * near-empty, and an email whose whole body is "see attached" is not a receipt
 * — both are worth saying so about rather than sending to the model.
 */
const MIN_TEXT_CHARS = 20;

/**
 * The reader. Swappable — everything downstream treats the output as untrusted
 * text and re-validates it, so a different model id here changes accuracy and
 * nothing else.
 *
 * One id for both jobs: the same model answers with or without an image
 * attached, so the PDF path is the identical prompt over extracted text.
 */
export const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const FIELDS = `Return ONLY a JSON object, no explanation, no markdown fence, with these keys:
"vendor": the store or supplier name as printed, or ""
"date": the purchase date as YYYY-MM-DD, or ""
"total": the grand total actually paid, as a number, or null
"tax": the sales tax amount, as a number, or null
"category": one of ${CATEGORIES.map((c) => c.key).join(', ')}
"summary": at most 8 words on what was bought
Use the total paid, not the subtotal. Do not guess a date that is not printed.`;

const PROMPT = `You are reading a purchase receipt for a small leather goods shop.
${FIELDS}`;

const DOC_PROMPT = `Below is the text of a purchase receipt or invoice for a small
leather goods shop. ${FIELDS}

The text may be an invoice from an advertising platform, a software subscription
or a supplier. The vendor is the company charging, not the shop being charged —
Rawhide City Leather is the customer on every one of these, never the vendor.

RECEIPT TEXT:
`;

const SYSTEM = 'You extract structured data from receipts. You reply with JSON only.';

/**
 * `html` is the odd one out. It is not a file anybody uploaded — it is the body
 * of an emailed receipt that arrived with no attachment (see email-in.js),
 * stored so the row still has an original behind it when the CPA asks. It is
 * served back under the same sandboxed, script-free headers as the rest.
 */
export function isReceiptKey(key) {
  return /^[0-9a-f]{32}\.(png|jpg|gif|pdf|webp|heic|html)$/.test(String(key || ''));
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

/**
 * The object the model meant to send, however it chose to send it.
 *
 * When the reply is valid JSON the runtime parses it for us and `response` is
 * an object, not a string — asking a model for JSON and getting JSON is the
 * normal case, not the exceptional one. This cost a full round of "the reader
 * is broken": every field was read correctly and then dropped on the floor by
 * a `typeof === 'string'` check one layer up.
 */
function replyJson(result) {
  const direct = result && typeof result === 'object' ? result.response : null;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  return parseExtraction(replyText(result));
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
/**
 * Receipts are printed 08/14/2026 and models hand that straight back however
 * firmly the prompt asks for ISO, so the slashed form is normalised rather than
 * thrown away — dropping it meant retyping the date on nearly every receipt.
 *
 * Read as month-first. This is a Florida shop buying from US suppliers, and
 * that is what the paper says. The one case where the reading is decidable is
 * handled: a first number above 12 cannot be a month, so it is the day. The
 * rest — 05/06/2026 — are genuinely ambiguous on their face, and the shop is
 * looking at the row and the photograph side by side before it counts.
 */
function toIsoDate(text) {
  const slashed = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!slashed) return text;

  let [, a, b, year] = slashed;
  let month = Number(a);
  let day = Number(b);
  if (month > 12 && day <= 12) [month, day] = [day, month];

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function cleanDate(value, now = new Date()) {
  const text = toIsoDate(String(value || '').trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';

  // Rejects 2026-13-45: Date rolls overflow forward, so a round trip catches it.
  const parsed = new Date(text + 'T00:00:00Z');
  if (!isNaN(parsed) && parsed.toISOString().slice(0, 10) !== text) return '';
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

const BLANK = { vendor: '', date: '', amount: null, tax: null, category: 'other', summary: '' };

function unread(why) {
  return { ...BLANK, read: false, why };
}

/**
 * Reads one receipt. Never throws: extraction is a convenience on top of a
 * stored file, and losing it must not lose the upload.
 *
 * Returns the draft fields plus `read`, which the page uses to say whether the
 * numbers were suggested or are waiting to be typed.
 */
export async function extract(env, bytes, ext) {
  if (!env.AI) return unread('no AI binding');
  if (bytes.length > EXTRACT_MAX_BYTES) return unread('file too big to read');

  try {
    if (READABLE_IMAGES.has(ext)) return await readImage(env, bytes, ext);
    if (READABLE_DOCS.has(ext)) return await readDocument(env, bytes);
    return unread(`cannot read a ${ext}`);
  } catch (err) {
    // Model outage, rate limit, oversized payload — all the same to the shop:
    // the file is saved, the fields are empty, type them in.
    console.error('receipt extraction failed', err?.message || err);
    return unread('reader unavailable');
  }
}

/** A photograph of a receipt, straight to the vision model. */
async function readImage(env, bytes, ext) {
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

  const result = await env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: PROMPT },
    ],
    image: `data:${mime};base64,${toBase64(bytes)}`,
    // Enough for the object and no room to start narrating.
    max_tokens: 300,
    // The number on the receipt is not a creative choice.
    temperature: 0.1,
  });

  return finish(result, 'could not read the receipt');
}

/**
 * A PDF invoice: pull its text out, then read the text.
 *
 * Two steps rather than one because a PDF is not an image — the vision endpoint
 * can't decode it at all, which is why these used to come back blank. The
 * platforms that bill this shop monthly (ads, hosting, software) all invoice as
 * a PDF with a real text layer, and reading that text beats reading a photo of
 * it.
 *
 * A scanned paper invoice has no text layer and nothing comes back. That is a
 * clean miss with a message saying so, not a wrong number — and photographing
 * that same page instead puts it back on the image path, which does work.
 */
async function readDocument(env, bytes) {
  if (typeof env.AI.toMarkdown !== 'function') return unread('this account cannot read PDFs');

  const converted = await env.AI.toMarkdown({
    name: 'receipt.pdf',
    blob: new Blob([bytes], { type: 'application/pdf' }),
  });

  // Documented as taking one document or many, and answering in kind.
  const doc = Array.isArray(converted) ? converted[0] : converted;
  const text = doc && doc.format !== 'error' ? String(doc.data || '') : '';

  if (text.trim().length < MIN_TEXT_CHARS) return unread('no text in that PDF — type it in');

  return await readText(env, text, 'could not read that PDF');
}

/**
 * A receipt that is already text: a PDF's text layer, or the body of an
 * emailed receipt that never had an attachment. Same prompt either way — the
 * platforms that bill this shop send the identical document as a PDF to some
 * customers and as an HTML email to others.
 *
 * Public because email-in.js reads bodies with it. Never throws, same contract
 * as `extract`: a reading is a convenience, and losing it must not lose the
 * receipt.
 */
export async function readText(env, text, failureReason = 'could not read that receipt') {
  if (!env.AI) return unread('no AI binding');

  const body = String(text || '').trim();
  if (body.length < MIN_TEXT_CHARS) return unread('not enough text to read');

  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: DOC_PROMPT + body.slice(0, MAX_DOC_CHARS) },
      ],
      max_tokens: 300,
      temperature: 0.1,
    });

    return finish(result, failureReason);
  } catch (err) {
    console.error('receipt text extraction failed', err?.message || err);
    return unread('reader unavailable');
  }
}

function finish(result, failureReason) {
  const parsed = replyJson(result);

  if (!parsed) {
    // The one failure that used to leave no trace: the model answered, the
    // answer was unusable, and the row just came back empty with nothing in the
    // logs to say why. Truncated, because a receipt's whole text is not worth
    // keeping in a log line.
    console.error('receipt reply not understood',
      JSON.stringify(result === undefined ? null : result).slice(0, 300));
    return unread(failureReason);
  }

  return { ...draftFromExtraction(parsed), read: true, why: '' };
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
  return await storeReceipt(env, new Uint8Array(await file.arrayBuffer()), file.name);
}

/**
 * Stores one receipt's bytes and reads them.
 *
 * The half of an upload that has nothing to do with HTTP, so an attachment
 * pulled out of an emailed receipt takes the identical path — same type
 * sniffing, same HEIC conversion, same reading — instead of a second
 * almost-the-same one that drifts.
 *
 * The caller writes the ledger record, so that a stored object and its row are
 * created in one place.
 */
export async function storeReceipt(env, original, rawName) {
  if (!env.RECEIPTS) {
    return { error: 'Receipt storage is not set up. Add the RECEIPTS R2 binding.', status: 500 };
  }
  if (!original || !original.length) return { error: 'That file is empty.', status: 400 };
  if (original.length > MAX_BYTES) return { error: 'That file is too big.', status: 413 };

  const kind = detect(original.subarray(0, 16));
  if (!kind) {
    return {
      error: 'That file type is not supported. Send a PNG, JPG, WEBP, GIF, HEIC, or PDF.',
      status: 415,
    };
  }

  let bytes = original;
  let ext = kind.ext;
  let mime = kind.mime;
  let converted = false;

  // An iPhone's default format, turned into one everything downstream can use.
  // Done before anything is stored, so what lands in the bucket is the JPEG and
  // there is never a second copy to keep straight.
  if (ext === 'heic') {
    const jpeg = await heicToJpeg(env, original);
    if (jpeg) {
      bytes = jpeg;
      ext = 'jpg';
      mime = 'image/jpeg';
      converted = true;
    }
  }

  const name = safeName(rawName);
  const key = newKey(ext);

  await env.RECEIPTS.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: {
      originalName: name,
      uploaded: new Date().toISOString(),
      ...(converted ? { convertedFrom: 'heic' } : {}),
    },
  });

  const draft = await extract(env, bytes, ext);

  return {
    key,
    // The name stays the one off the phone — it is what the shop searches for
    // in a folder — while the extension records what is actually in the bucket.
    file: { name, ext, mime, size: bytes.length, converted },
    draft,
  };
}

/**
 * Stores the body of an emailed receipt as the receipt itself.
 *
 * Plenty of receipts have no attachment — the ad platforms, the marketplaces,
 * the subscriptions all put the whole thing in the email. Without this the row
 * would carry numbers a model read off a message nobody kept, which is exactly
 * the kind of entry an accountant asks for the original of. So the body goes in
 * the bucket beside the photographs.
 *
 * Stored as HTML and served back from /receipt/<key>, which sits behind the
 * dashboard login under `default-src 'none'; sandbox` — no scripts, no images,
 * no requests out. A remote sender's markup can't do anything from there.
 */
export async function storeBody(env, { html = '', text = '', subject = '' } = {}) {
  if (!env.RECEIPTS) {
    return { error: 'Receipt storage is not set up. Add the RECEIPTS R2 binding.', status: 500 };
  }

  const document = html.trim() ? html : plainDocument(subject, text);
  const bytes = new TextEncoder().encode(document);
  if (!bytes.length) return { error: 'That email had no body.', status: 400 };
  if (bytes.length > MAX_BYTES) return { error: 'That email is too big to file.', status: 413 };

  const key = newKey('html');
  const name = safeName(subject || 'emailed receipt');

  await env.RECEIPTS.put(key, bytes, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: { originalName: name, uploaded: new Date().toISOString(), source: 'email' },
  });

  return { key, file: { name, ext: 'html', mime: 'text/html', size: bytes.length, converted: false } };
}

/** A text-only email, wrapped so the browser shows it the way it arrived. */
function plainDocument(subject, text) {
  const escape = (value) => String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><meta charset="utf-8"><title>${escape(subject) || 'Emailed receipt'}</title>
<pre style="white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace">${escape(text)}</pre>`;
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

/* ------------------------------------------------------------------- HEIC */

/**
 * The longest edge a converted photo keeps. A receipt is legible far below a
 * modern phone's 12 megapixels, and the full-size JPEG of one can land over
 * EXTRACT_MAX_BYTES — which would mean converting the file and then still not
 * reading it.
 */
const HEIC_MAX_EDGE = 2000;

/**
 * iPhones shoot HEIC by default, and it is the one accepted format nothing
 * downstream can use: the vision model can't decode it, and no browser but
 * Safari will render it, so the thumbnail and the image in the printed CPA
 * packet would both come out broken.
 *
 * So it doesn't get stored as HEIC. Cloudflare Images decodes it and hands back
 * a JPEG, and the JPEG is what becomes the receipt — same photograph, in a
 * format the rest of this actually works with.
 *
 * Returns null if it can't be done, and the caller keeps the original. A
 * HEIC on file that nothing can read still beats a rejected upload: the
 * receipt is the thing being kept.
 */
async function heicToJpeg(env, bytes) {
  if (!env.IMAGES) return null;

  try {
    const result = await env.IMAGES
      .input(new Blob([bytes], { type: 'image/heic' }).stream())
      // scale-down, so a receipt photographed close up is never blown up.
      .transform({ width: HEIC_MAX_EDGE, height: HEIC_MAX_EDGE, fit: 'scale-down' })
      .output({ format: 'image/jpeg', quality: 90 })
      .response();

    if (!result.ok) return null;

    const converted = new Uint8Array(await result.arrayBuffer());
    // A conversion that returns nothing is a failure that didn't say so.
    return converted.length ? converted : null;
  } catch (err) {
    console.error('heic conversion failed', err?.message || err);
    return null;
  }
}

export async function deleteReceipt(env, key) {
  if (!env.RECEIPTS || !isReceiptKey(key)) return false;
  await env.RECEIPTS.delete(key);
  return true;
}
