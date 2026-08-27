/**
 * Quote building, pricing and the page the crew sees.
 *
 * The pricing checks are the ones that matter most: a quote that collects the
 * wrong amount is a bill sent to a fire department for the wrong number.
 */

import { suite, check } from './harness.mjs';
import { money } from '../lib.js';
import {
  buildQuote, listPriceFor, renderQuotePage, quoteStatus, quoteWarnings,
  isQuoteId, QuoteError, CHECKOUT_DISCOUNT, quotePayment, quoteGrandTotal,
} from '../quote.js';
import { renderQuoteSheet } from '../quote-sheet.js';

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
  check('price on the page is what the cart will charge',
    page.includes(`data-item-price="${quote.listPrice.toFixed(2)}"`),
    `button=${quote.listPrice}`);
  check('item url points back at this page', page.includes(`data-item-url="/quote/${quote.id}"`));
  check('page is noindex', page.includes('noindex'));

  // The crew always sees the number it was quoted. Under a sitewide sale the
  // button carries a grossed-up figure instead, and that figure must never
  // reach the page — it would not reconcile against the line items directly
  // above it and reads as an arithmetic error.
  check('the crew sees the quoted number', page.includes('$1,800.00'));
  if (CHECKOUT_DISCOUNT) {
    check('the grossed-up figure is never shown',
      !page.includes(money(quote.listPrice, 'usd')));
    check('the checkout surprise is pre-empted',
      page.includes('Checkout shows the shop sale applied'));
  } else {
    check('no sale note when no sale is running',
      !page.includes('Checkout shows the shop sale applied'));
  }

  check('a paid page drops the buy button',
    !renderQuotePage(quote, { status: 'paid' }).includes('snipcart-add-item'));
  check('an expired page drops the buy button',
    !renderQuotePage(quote, { status: 'expired' }).includes('snipcart-add-item'));
  check('an unknown status still renders rather than throwing',
    () => renderQuotePage(quote, { status: 'nonsense' }).length > 0);

  suite('quote — cash jobs');

  const cash = buildQuote({ ...base, payment: 'cash', taxRatePercent: '7' });

  check('the method is recorded', cash.payment === 'cash' && quotePayment(cash) === 'cash');
  check('tax is worked out on the subtotal', cash.taxAmount === 126, `tax=${cash.taxAmount}`);
  check('the total collected includes it', cash.grandTotal === 1926, `grand=${cash.grandTotal}`);
  check('a card quote carries no rate of its own',
    quote.taxRatePercent === 0 && quote.grandTotal === quote.total);
  check('a card quote ignores a rate typed in anyway',
    buildQuote({ ...base, payment: 'card', taxRatePercent: '7' }).taxAmount === 0);
  check('an exempt cash job is charged none either way',
    buildQuote({
      ...base, payment: 'cash', taxRatePercent: '7', taxExempt: true,
      exemptEntity: 'City of Lakeland', exemptCertNumber: '85-8012345678C-9',
    }).grandTotal === 1800);
  check('a blank rate is not an error', buildQuote({ ...base, payment: 'cash' }).grandTotal === 1800);
  check('an anything-else method is treated as card',
    quotePayment(buildQuote({ ...base, payment: 'venmo' })) === 'card');

  rejects('a tax rate past the ceiling', { payment: 'cash', taxRatePercent: '70' });
  rejects('a negative tax rate', { payment: 'cash', taxRatePercent: '-1' });
  rejects('a tax rate that is not a number', { payment: 'cash', taxRatePercent: 'seven' });

  // Quotes written before cash existed are still in KV and have neither field.
  const legacy = { total: 500, lines: [], taxExempt: false };
  check('an older stored quote reads as card', quotePayment(legacy) === 'card');
  check('an older stored quote falls back to its total', quoteGrandTotal(legacy) === 500);

  suite('quote — the cash page');

  const cashPage = renderQuotePage(cash, { status: 'open' });

  check('no buy button on a cash job', !cashPage.includes('snipcart-add-item'));
  // Nothing on the page can be paid, so loading a cart would only be weight.
  check('the cart is not loaded at all', !/snipcart/i.test(cashPage));
  check('it says what to bring', cashPage.includes('$1,926.00'));
  check('the tax is shown as its own line', cashPage.includes('Sales tax (7%)'));
  check('the checkout tax note is dropped', !cashPage.includes('Florida sales tax is added at'));
  check('a card quote still gets its button',
    renderQuotePage(quote, { status: 'open' }).includes('snipcart-add-item'));

  suite('quote — the printable sheet');

  const cashSheet = renderQuoteSheet(cash, { status: 'open', origin: 'https://rawhidecityleather.com' });

  check('a cash job prints as an invoice', cashSheet.includes('<h1>Invoice</h1>'));
  check('the amount to collect is on it', cashSheet.includes('$1,926.00'));
  check('there is a line for who took the money', cashSheet.includes('Received by'));
  check('and for what it came in as', cashSheet.includes('Check no.'));
  check('no pay link on a cash sheet', !cashSheet.includes('/quote/' + cash.id));

  const paidSheet = renderQuoteSheet(
    { ...cash, paidAt: '2026-08-19T12:00:00.000Z', paidMethod: 'check' }, { status: 'paid' });

  check('once paid it prints as a receipt', paidSheet.includes('<h1>Receipt</h1>'));
  check('it names how the money arrived', paidSheet.includes('by check'));
  // "Received by check on ..." contains those two words, so match the block.
  check('the sign-off block is gone', !paidSheet.includes('qs-sign'));

  const cardSheet = renderQuoteSheet(quote, { status: 'open', origin: 'https://rawhidecityleather.com' });

  check('a card job prints as a quote', cardSheet.includes('<h1>Quote</h1>'));
  check('it carries the link to pay',
    cardSheet.includes('https://rawhidecityleather.com/quote/' + quote.id));
  // The sheet cannot know either figure — checkout works both out from the
  // address. Printing a total that then grows is worse than saying so.
  check('tax is left to checkout', cardSheet.includes('Added at checkout'));
  check('shipping is named rather than left off', cardSheet.includes('Free'));
  check('under the free-shipping line it says what gets added',
    renderQuoteSheet(buildQuote({
      ...base, lines: [{ description: 'Glove strap', quantity: 1, unitPrice: 30 }],
    }), { status: 'open' }).includes('$10.00 at checkout'));

  check('an expired sheet still prints for the file',
    () => renderQuoteSheet(quote, { status: 'expired' }).includes('past its date'));
  check('an unknown status still renders rather than throwing',
    () => renderQuoteSheet(quote, { status: 'nonsense' }).length > 0);

  suite('quote — escaping');

  const nasty = buildQuote({
    ...base,
    title: '<script>alert(1)</script>',
    customer: 'Reyes & "Co"',
    lines: [{ description: '<img src=x onerror=alert(1)>', quantity: 1, unitPrice: 10 }],
  });
  const nastyPage = renderQuotePage(nasty, { status: 'open' });

  const nastySheet = renderQuoteSheet(nasty, { status: 'open' });

  check('script tags are escaped', !nastyPage.includes('<script>alert(1)</script>'));
  check('the printed sheet escapes them too',
    !nastySheet.includes('<script>alert(1)</script>') &&
    !nastySheet.includes('<img src=x onerror'));
  check('image handlers are escaped', !nastyPage.includes('<img src=x onerror'));
  check('ampersands and quotes survive as entities',
    nastyPage.includes('Reyes &amp; &quot;Co&quot;'));
}
