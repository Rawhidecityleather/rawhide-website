/**
 * Quote building, pricing and the page the crew sees.
 *
 * The pricing checks are the ones that matter most: a quote that collects the
 * wrong amount is a bill sent to a fire department for the wrong number.
 */

import { suite, check } from './harness.mjs';
import {
  buildQuote, listPriceFor, renderQuotePage, quoteStatus, quoteWarnings,
  isQuoteId, QuoteError, CHECKOUT_DISCOUNT,
} from '../quote.js';

const base = {
  title: '12 Memorial Radio Straps — Station 4',
  customer: 'Lt. Dana Reyes',
  department: 'Lakeland Fire Department',
  notes: 'Black bridle, white stitch.\nStamped with last name and badge no.',
  lines: [{ description: 'Fully custom radio strap', quantity: 12, unitPrice: 150 }],
};

export default function run() {
  const quote = buildQuote(base);

  suite('quote — pricing');

  check('total is the sum of the lines', quote.total === 1800, `total=${quote.total}`);
  check('the crew pays exactly what was quoted, after Snipcart takes its cut',
    Math.round(quote.listPrice * (1 - CHECKOUT_DISCOUNT) * 100) / 100 === quote.total,
    `button=${quote.listPrice}`);
  check('with no sale configured there is no gross-up', listPriceFor(1800, 0) === 1800);

  // Awkward totals must not drift more than a cent once the discount lands.
  for (const total of [33.33, 99.99, 1234.56, 7.77, 19.95]) {
    const paid = Math.round(listPriceFor(total) * (1 - CHECKOUT_DISCOUNT) * 100) / 100;
    check(`rounding holds at $${total}`, Math.abs(paid - total) <= 0.01, `pays ${paid}`);
  }

  suite('quote — identity');

  check('id passes the route guard', isQuoteId(quote.id), quote.id);
  check('item id is unique to this quote', quote.itemId === 'quote-' + quote.id);
  check('two quotes never share an id', buildQuote(base).id !== quote.id);

  suite('quote — validation');

  const rejects = (label, over) => check(label, () => {
    try {
      buildQuote({ ...base, ...over });
      return false;
    } catch (err) {
      return err instanceof QuoteError;
    }
  });

  rejects('no line items', { lines: [] });
  rejects('missing title', { title: '' });
  rejects('missing contact name', { customer: '' });
  rejects('a line priced at zero', { lines: [{ description: 'd', quantity: 1, unitPrice: 0 }] });
  rejects('a negative quantity', { lines: [{ description: 'd', quantity: -3, unitPrice: 5 }] });
  rejects('a line with no description', { lines: [{ description: '', quantity: 2, unitPrice: 5 }] });
  rejects('exempt with no certificate number', { taxExempt: true, exemptEntity: 'Dept' });

  check('blank form rows are dropped rather than rejected', () => {
    const q = buildQuote({ ...base, lines: [
      { description: 'Real line', quantity: 2, unitPrice: 40 },
      { description: '', quantity: 0, unitPrice: 0 },
    ] });
    return q.lines.length === 1;
  });

  suite('quote — tax exemption');

  const exempt = buildQuote({
    ...base, taxExempt: true,
    exemptEntity: 'City of Lakeland Fire Department',
    exemptCertNumber: '85-8012345678C-9', exemptExpires: '2027-12-31',
  });
  const exemptPage = renderQuotePage(exempt, { status: 'open' });

  check('exemption is recorded', exempt.exemption.certNumber === '85-8012345678C-9');
  check('checkout is told not to tax it', exemptPage.includes('data-item-taxable="false"'));
  check('certificate shows on the quote', exemptPage.includes('85-8012345678C-9'));
  check('a normal quote is marked taxable',
    renderQuotePage(quote, { status: 'open' }).includes('data-item-taxable="true"'));

  const summary = (over) => ({
    taxExempt: true,
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    ...over,
  });
  check('an expired certificate is flagged',
    quoteWarnings(summary({ exemptExpires: '2020-01-01' })).length === 1);
  check('a certificate lapsing before the quote does is flagged',
    quoteWarnings(summary({ exemptExpires: new Date(Date.now() + 5 * 86400000).toISOString() })).length === 1);
  check('a good certificate is quiet',
    quoteWarnings(summary({ exemptExpires: '2030-01-01' })).length === 0);

  suite('quote — status');

  const orders = [{ token: 'abc', invoiceNumber: 'RCL-1042', items: [{ id: quote.itemId }] }];
  check('open by default', quoteStatus(quote) === 'open');
  check('paid when a real order carries the item id', quoteStatus(quote, orders) === 'paid');
  check('voided reads as void',
    quoteStatus({ ...quote, voidedAt: new Date().toISOString() }) === 'void');
  check('past its date reads as expired',
    quoteStatus({ ...quote, expiresAt: new Date(Date.now() - 1000).toISOString() }) === 'expired');
  check('paid beats expired',
    quoteStatus({ ...quote, expiresAt: new Date(Date.now() - 1000).toISOString() }, orders) === 'paid');

  suite('quote — the page Snipcart has to be able to read');

  const page = renderQuotePage(quote, { status: 'open' });
  check('the crawler can find the add-item button', page.includes('snipcart-add-item'));
  check('item id matches the record', page.includes(`data-item-id="${quote.itemId}"`));
  check('price on the page is the grossed-up one', page.includes('data-item-price="2250.00"'));
  check('item url points back at this page', page.includes(`data-item-url="/quote/${quote.id}"`));
  check('page is noindex', page.includes('noindex'));

  // The customer must never see the grossed-up figure — it would not reconcile
  // against the line items directly above it and reads as an arithmetic error.
  check('the crew sees the quoted number', page.includes('$1,800.00'));
  check('the grossed-up figure is never shown', !page.includes('$2,250.00'));
  check('the checkout surprise is pre-empted', page.includes('Checkout shows the shop sale applied'));

  check('a paid page drops the buy button',
    !renderQuotePage(quote, { status: 'paid' }).includes('snipcart-add-item'));
  check('an expired page drops the buy button',
    !renderQuotePage(quote, { status: 'expired' }).includes('snipcart-add-item'));
  check('an unknown status still renders rather than throwing',
    () => renderQuotePage(quote, { status: 'nonsense' }).length > 0);

  suite('quote — escaping');

  const nasty = buildQuote({
    ...base,
    title: '<script>alert(1)</script>',
    customer: 'Reyes & "Co"',
    lines: [{ description: '<img src=x onerror=alert(1)>', quantity: 1, unitPrice: 10 }],
  });
  const nastyPage = renderQuotePage(nasty, { status: 'open' });

  check('script tags are escaped', !nastyPage.includes('<script>alert(1)</script>'));
  check('image handlers are escaped', !nastyPage.includes('<img src=x onerror'));
  check('ampersands and quotes survive as entities',
    nastyPage.includes('Reyes &amp; &quot;Co&quot;'));
}
