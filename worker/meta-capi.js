/**
 * Meta Conversions API — the server-side copy of the pixel's Purchase event.
 *
 * The pixel only counts a sale when the buyer's browser fires it, and ad
 * blockers and iPhone tracking protection stop a share of those. This sends
 * the same sale from the Snipcart order.completed webhook, so Meta sees it
 * either way. Both copies carry the same event id (the invoice number), and
 * Meta keeps one and drops the other, so nothing is counted twice.
 *
 * Config:
 *   META_CAPI_TOKEN      secret — Events Manager > the pixel > Settings >
 *                        Conversions API > Generate access token. Unset means
 *                        this does nothing, so it is safe to deploy first.
 *   META_TEST_EVENT_CODE optional — the TEST12345 code from Events Manager's
 *                        Test events tab. While set, every event lands there
 *                        instead of counting. Delete it once verified.
 *
 * Buyer details go to Meta hashed (SHA-256), never in the clear, which is
 * what Meta requires. The browser stores the pixel's _fbp/_fbc cookies and its
 * user agent on the cart as metadata when checkout opens (assets/js/main.js),
 * and those ride through to the order — they are what ties the sale back to
 * the ad click.
 */

import { grandTotal } from './snipcart.js';

/** Public: it's in every page's <head> already. */
export const PIXEL_ID = '1579558768885977';
const GRAPH_VERSION = 'v23.0';
const SITE = 'https://rawhidecityleather.com/';

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashed(value) {
  return value ? [await sha256(value)] : undefined;
}

/** Meta's normalisation rules, one per field. */
export const normalize = {
  email: (v) => String(v || '').trim().toLowerCase(),
  name: (v) => String(v || '').toLowerCase().replace(/[^\p{L}]/gu, ''),
  city: (v) => String(v || '').toLowerCase().replace(/[^\p{L}]/gu, ''),
  state: (v) => {
    const s = String(v || '').trim().toLowerCase();
    return /^[a-z]{2}$/.test(s) ? s : '';
  },
  zip: (v, country) => {
    const s = String(v || '').trim().toLowerCase();
    return country === 'us' ? (s.match(/^\d{5}/) || [''])[0] : s.replace(/[\s-]/g, '');
  },
  country: (v) => {
    const s = String(v || '').trim().toLowerCase();
    return /^[a-z]{2}$/.test(s) ? s : '';
  },
  phone: (v) => {
    const d = String(v || '').replace(/\D/g, '');
    return d.length === 10 ? '1' + d : d;
  },
};

/** The same id the browser passes as eventID — see cart.confirmed in main.js. */
export function purchaseEventId(order) {
  return String(order?.invoiceNumber || order?.token || '');
}

/**
 * Builds the event, or returns { skip } saying why not. Pure apart from the
 * hashing, so the tests can drive it from a fixture.
 */
export async function buildPurchaseEvent(order, now = Date.now()) {
  const eventId = purchaseEventId(order);
  if (!eventId) return { skip: 'no invoice number' };

  const meta = order.metadata || {};
  // Meta requires the buyer's user agent on a website event. An order that
  // never went through a storefront page (a quote paid off its own link has
  // no pixel) has none, and there is no honest value to put in its place.
  if (!meta.ua) return { skip: 'no browser details on the order' };

  const addr = order.billingAddress || order.shippingAddress || {};
  const parts = String(addr.fullName || '').trim().split(/\s+/).filter(Boolean);
  const country = normalize.country(addr.country);

  const userData = {
    em: await hashed(normalize.email(order.email)),
    fn: await hashed(normalize.name(parts[0])),
    ln: await hashed(parts.length > 1 ? normalize.name(parts[parts.length - 1]) : ''),
    ct: await hashed(normalize.city(addr.city)),
    st: await hashed(normalize.state(addr.province)),
    zp: await hashed(normalize.zip(addr.postalCode, country)),
    country: await hashed(country),
    ph: await hashed(normalize.phone(addr.phone)),
    client_user_agent: String(meta.ua),
    fbp: meta.fbp || undefined,
    fbc: meta.fbc || undefined,
  };
  for (const k of Object.keys(userData)) if (userData[k] === undefined) delete userData[k];

  const items = order.items || [];
  const placed = Date.parse(order.completionDate || order.creationDate || '');
  const nowSec = Math.floor(now / 1000);
  const eventTime = Number.isFinite(placed) ? Math.min(Math.floor(placed / 1000), nowSec) : nowSec;

  return {
    event: {
      event_name: 'Purchase',
      event_time: eventTime,
      event_id: eventId,
      action_source: 'website',
      event_source_url: meta.url || SITE,
      user_data: userData,
      custom_data: {
        currency: String(order.currency || 'usd').toUpperCase(),
        value: Math.round(grandTotal(order) * 100) / 100,
        content_type: 'product',
        content_ids: items.map((i) => i.id),
        num_items: items.reduce((n, i) => n + (i.quantity || 1), 0),
        order_id: eventId,
      },
    },
  };
}

/**
 * Sends one order's Purchase to Meta. Never throws: a failure here must not
 * make Snipcart retry the whole webhook, and the pixel still has its copy.
 */
export async function sendPurchase(env, order, { mode } = {}) {
  if (!env.META_CAPI_TOKEN) return { sent: false, reason: 'not configured' };
  if (mode && mode !== 'Live') return { sent: false, reason: 'test-mode order' };

  try {
    const built = await buildPurchaseEvent(order);
    if (built.skip) return { sent: false, reason: built.skip };

    const body = { data: [built.event] };
    if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;

    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('meta capi', res.status, text.slice(0, 500));
      return { sent: false, reason: 'meta said ' + res.status };
    }
    return { sent: true, id: built.event.event_id };
  } catch (err) {
    console.error('meta capi', err.message);
    return { sent: false, reason: err.message };
  }
}
