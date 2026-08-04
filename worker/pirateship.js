/**
 * Pirate Ship handoff.
 *
 * Pirate Ship has no public API and no Snipcart integration, so labels can't be
 * bought from here. What it does support is uploading an address spreadsheet to
 * batch out labels, so this builds that spreadsheet. Column titles are free-form
 * on their end — you map them to Pirate Ship's fields on the first upload.
 *
 * Tracking comes back the other way: paste Pirate Ship's shipment list (or just
 * "order, tracking" lines) into the dashboard and parseTrackingPaste sorts it
 * out.
 */

/**
 * Shipping weight per item, in ounces, WITHOUT packaging.
 *
 * These are estimates, not scale readings — put a piece on a scale and correct
 * the number. They lean heavy on purpose: overpaying a few cents beats a
 * postage-due package coming back at you.
 */
const ITEM_OUNCES = {
  'fully-custom-radio-strap': 14,
  'basic-radio-strap': 11,
  'basket-weave-belt': 10,
  'heavy-duty-belt': 11,
  'helmet-band': 3,
  'glove-strap': 2,
  'chin-strap': 3,
  'leather-patch-hat': 4,
  'leather-butter': 6,
};

/** One-off custom builds have no product id to look up. */
const DEFAULT_ITEM_OUNCES = 12;

/** Mailer, tissue, card. Added once per order, not per item. */
const PACKAGING_OUNCES = 3;

/** Pirate Ship needs a box size for anything it can't rate as a flat mailer. */
const DEFAULT_BOX = { length: 12, width: 9, height: 2 };

export const PIRATE_SHIP_URL = 'https://ship.pirateship.com/';

export function orderWeightOunces(order) {
  const items = order.items || [];
  const contents = items.reduce((sum, item) => {
    const each = ITEM_OUNCES[item.id] ?? DEFAULT_ITEM_OUNCES;
    return sum + each * (Number(item.quantity) || 1);
  }, 0);
  return Math.max(1, Math.ceil(contents + PACKAGING_OUNCES));
}

const CSV_COLUMNS = [
  'Order Number',
  'Name',
  'Company',
  'Address 1',
  'Address 2',
  'City',
  'State',
  'Zip',
  'Country',
  'Phone',
  'Email',
  'Weight (oz)',
  'Length (in)',
  'Width (in)',
  'Height (in)',
  'Contents',
];

export function pirateShipCsv(orders) {
  const rows = orders.map((order) => {
    const a = order.shippingAddress || order.billingAddress || {};
    const items = (order.items || [])
      .map((i) => `${i.quantity || 1}x ${i.name || ''}`.trim())
      .join('; ');

    return [
      order.invoiceNumber || order.token,
      a.fullName || a.name || '',
      a.company || '',
      a.address1 || '',
      a.address2 || '',
      a.city || '',
      a.province || '',
      a.postalCode || '',
      a.country || 'US',
      a.phone || '',
      order.email || '',
      orderWeightOunces(order),
      DEFAULT_BOX.length,
      DEFAULT_BOX.width,
      DEFAULT_BOX.height,
      items,
    ];
  });

  // A BOM so Excel opens it as UTF-8 if he looks at the file before uploading.
  return '﻿' +
    [CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') +
    '\r\n';
}

function csvCell(value) {
  let text = String(value ?? '').replace(/\r?\n/g, ' ').trim();

  // Excel treats a leading =, +, - or @ as a formula. No real address starts
  // with one, so drop it rather than prefix a quote that would print on a label.
  text = text.replace(/^[=+\-@\t\r]+/, '');

  return /[",]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/* ------------------------------------------------------ tracking paste-back */

const TRACKING_PATTERNS = [
  /\b(1Z[0-9A-Z]{16})\b/i,       // UPS
  /\b(\d{20,22})\b/,             // USPS domestic
  /\b([A-Z]{2}\d{9}[A-Z]{2})\b/, // USPS international / registered
];

/**
 * Pulls order/tracking pairs out of whatever got pasted in — Pirate Ship's
 * shipment CSV, a spreadsheet selection, or hand-typed "1042 9400..." lines.
 * Header rows fall out on their own because they hold no tracking number.
 *
 * `orders` is the live order list, used to resolve which order each line means.
 * Returns { matched: [{token, invoiceNumber, trackingNumber}], unmatched: [] }.
 */
export function parseTrackingPaste(text, orders) {
  const matched = [];
  const unmatched = [];
  const seen = new Set();

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let trackingNumber = '';
    for (const pattern of TRACKING_PATTERNS) {
      const hit = line.match(pattern);
      if (hit) { trackingNumber = hit[1].toUpperCase(); break; }
    }
    if (!trackingNumber) continue;

    // Everything that isn't the tracking number is a candidate order reference.
    const rest = line.replace(trackingNumber, ' ').replace(/["']/g, ' ');
    const order = findOrder(rest, orders);

    if (!order) {
      unmatched.push({ line, trackingNumber });
      continue;
    }
    if (seen.has(order.token)) continue;
    seen.add(order.token);

    matched.push({
      token: order.token,
      invoiceNumber: order.invoiceNumber || order.token,
      trackingNumber,
    });
  }

  return { matched, unmatched };
}

/**
 * Matches a line against an order by invoice number, then by the digits in it
 * (so a bare "1042" still finds invoice "RCL-1042"), then by customer name.
 */
function findOrder(text, orders) {
  const haystack = ' ' + text.toLowerCase().replace(/[,;\t]+/g, ' ') + ' ';
  const tokens = haystack.split(/\s+/).filter(Boolean);

  const byInvoice = orders.find((o) => {
    const invoice = String(o.invoiceNumber || '').toLowerCase();
    return invoice && tokens.includes(invoice);
  });
  if (byInvoice) return byInvoice;

  const byDigits = orders.find((o) => {
    const digits = String(o.invoiceNumber || '').replace(/\D/g, '');
    return digits && tokens.includes(digits);
  });
  if (byDigits) return byDigits;

  const byToken = orders.find((o) => o.token && tokens.includes(String(o.token).toLowerCase()));
  if (byToken) return byToken;

  return orders.find((o) => {
    const a = o.shippingAddress || o.billingAddress || {};
    const name = String(a.fullName || a.name || '').trim().toLowerCase();
    return name.length > 3 && haystack.includes(name);
  });
}
