/**
 * Packing slip rendering.
 *
 * The plain no-quote slip is checked first on purpose. That case shipped broken
 * on 2026-08-06 — renderTotals was handed a `quote` argument it never declared,
 * so every slip threw ReferenceError and the Worker reported it as "Could not
 * reach Snipcart". renderSlip is exported precisely so this can be driven from
 * a fixture without a Snipcart key. Keep it that way.
 */

import { suite, check } from './harness.mjs';
import { renderSlip } from '../slip.js';
import { buildQuote } from '../quote.js';

const order = {
  token: '305e2604-cacf-4ddd-8520-07bd0b9dc8c2',
  invoiceNumber: 'RCL-1042',
  creationDate: '2026-08-01T12:00:00Z',
  status: 'Processed',
  currency: 'usd',
  email: 'buyer@example.com',
  itemsTotal: 165, savedAmount: 33, shippingFees: 0, taxesTotal: 9.24,
  grandTotal: 141.24,
  shippingAddress: {
    fullName: 'Mike Doyle', address1: '12 Main St',
    city: 'Tampa', province: 'FL', postalCode: '33601',
  },
  items: [{
    id: 'fully-custom-radio-strap', name: 'Fully Custom Radio Strap',
    quantity: 1, totalPrice: 165,
    customFields: [
      { name: 'Leather color', value: 'Black' },
      { name: 'Stamped text', value: 'DOYLE 42' },
    ],
  }],
};

export default function run() {
  suite('slip — the ordinary order');

  check('renders with no second argument at all', () => renderSlip(order).length > 0);
  check('renders with an empty options object', () => renderSlip(order, {}).includes('RCL-1042'));
  check('renders with quote explicitly null', () => renderSlip(order, { quote: null }).includes('RCL-1042'));

  const plain = renderSlip(order);
  check('shows the tax that was charged', plain.includes('$9.24'));
  check('shows the discount row', plain.includes('Discount'));
  check('keeps the build sheet detail', plain.includes('DOYLE 42'));
  check('keeps the shipping address', plain.includes('Mike Doyle'));
  check('claims no exemption', !plain.includes('Sales tax exempt'));

  suite('slip — tax-exempt quote order');

  const exempt = buildQuote({
    title: 'Station 4 promotion set', customer: 'Chief Alvarez',
    taxExempt: true, exemptEntity: 'City of Lakeland Fire Department',
    exemptCertNumber: '85-8012345678C-9', exemptExpires: '2027-12-31',
    lines: [{ description: 'Helmet band', quantity: 6, unitPrice: 50 }],
  });
  const exemptSlip = renderSlip({ ...order, taxesTotal: 0, savedAmount: 0, grandTotal: 300 },
    { quote: exempt });

  check('prints a tax row reading Exempt', exemptSlip.includes('Exempt'));
  check('names the entity on the certificate', exemptSlip.includes('City of Lakeland Fire Department'));
  check('prints the certificate number', exemptSlip.includes('85-8012345678C-9'));
  check('prints the certificate expiry', exemptSlip.includes('2027-12-31'));
  check('references the quote it came from', exemptSlip.includes(exempt.id));

  suite('slip — quote order that is not exempt');

  const taxable = buildQuote({
    title: 'Retirement set', customer: 'Sarah Whitfield',
    lines: [{ description: 'Helmet band', quantity: 1, unitPrice: 50 }],
  });
  const taxableSlip = renderSlip({ ...order, taxesTotal: 3.5 }, { quote: taxable });

  check('claims no exemption', !taxableSlip.includes('Sales tax exempt'));
  check('still shows the real tax', taxableSlip.includes('$3.50'));

  suite('slip — ship-by dates');

  // Dates are relative to today, so the fixture's fixed creationDate is no use
  // here — these orders are placed a known number of days back from now.
  const placed = (daysAgo) =>
    new Date(Date.now() - daysAgo * 86400000).toISOString();

  const strap = renderSlip({ ...order, creationDate: placed(7) });
  check('dates a radio strap six weeks out', strap.includes('Ship by'));
  check('counts the days a radio strap has left', strap.includes('35 days left'));
  check('names the lead time it came from', strap.includes('6 weeks from order'));

  const band = renderSlip({
    ...order, creationDate: placed(7),
    items: [{ id: 'helmet-band', name: 'Helmet Band', quantity: 1, totalPrice: 50 }],
  });
  check('puts a helmet band in the three-week bucket', band.includes('14 days left'));
  check('labels the short lead time', band.includes('1–3 weeks from order'));

  // Everything with "strap" in the name is not a six-week build.
  const glove = renderSlip({
    ...order, creationDate: placed(7),
    items: [{ id: 'glove-strap', name: 'Glove Strap', quantity: 1, totalPrice: 30 }],
  });
  check('keeps glove straps out of the radio-strap bucket', glove.includes('14 days left'));

  const butter = renderSlip({
    ...order, creationDate: placed(1),
    items: [{ id: 'leather-butter', name: 'Leather Butter', quantity: 1, totalPrice: 8 }],
  });
  check('holds leather butter to business days', butter.includes('1–3 business days from order'));

  const late = renderSlip({ ...order, creationDate: placed(45) });
  check('says how late an overdue strap is', late.includes('3 days late'));
  check('marks the overdue row', late.includes('due late'));

  const due = renderSlip({ ...order, creationDate: placed(42) });
  check('calls the deadline day due today', due.includes('due today'));

  const gone = renderSlip({ ...order, creationDate: placed(45), status: 'Shipped' });
  check('drops the countdown once the order shipped', !gone.includes('days late'));
  check('still prints the date it was owed', gone.includes('Ship by'));

  // A zero-tax order is not the same thing as an exempt one — an out-of-state
  // order has no Florida tax and must not print paperwork saying it was exempt.
  check('zero tax with no quote stays silent rather than claiming exemption',
    () => {
      const s = renderSlip({ ...order, taxesTotal: 0 });
      return !s.includes('Exempt') && !s.includes('Sales tax exempt');
    });
}
