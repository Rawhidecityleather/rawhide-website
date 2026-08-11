/**
 * Shared helpers — the lead-time table and the dates that come off it.
 *
 * These drive two things that cost real money when they're wrong: the ship-by
 * date printed on the slip that goes in the box, and the deadline the ship
 * queue sorts the bench work by.
 */

import { suite, check } from './harness.mjs';
import { leadTime, shipBy, orderShipBy, daysUntil } from '../lib.js';
import { analyze } from '../dashboard.js';

// One clock for the whole file. Two calls to Date.now() a millisecond apart
// would stop the tie-break case below from actually tying.
const NOW = Date.now();
const placed = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();

export default function run() {
  suite('lib — lead times');

  check('a fully custom radio strap is the six-week build',
    leadTime({ id: 'fully-custom-radio-strap', name: 'Fully Custom Radio Strap' }).days === 42);
  check('so is the basic adjustable one',
    leadTime({ id: 'basic-radio-strap', name: 'Basic Adjustable Radio Strap' }).days === 42);

  // The trap: three catalog items have "strap" in the name and only two of
  // them are radio straps.
  check('a glove strap is not a radio strap',
    leadTime({ id: 'glove-strap', name: 'Glove Strap' }).days === 21);
  check('a chin strap is not a radio strap',
    leadTime({ id: 'chin-strap', name: 'Chin Strap' }).days === 21);

  check('belts take the three-week bucket',
    leadTime({ id: 'heavy-duty-belt', name: 'Heavy Duty Belt' }).days === 21);
  check('leather butter ships from stock',
    leadTime({ id: 'leather-butter', name: 'Leather Butter' }).days === 5);

  // A one-off build off a quote has a description, no catalog id.
  check('a custom build is matched on its name alone',
    leadTime({ name: 'Custom radio strap, Station 4 memorial' }).days === 42);
  check('an unrecognised item falls to the short bucket',
    leadTime({ name: 'Something new' }).days === 21);
  check('an item with nothing on it still gets a lead time',
    leadTime({}).days === 21 && leadTime(null).days === 21);

  suite('lib — ship-by dates');

  check('a strap placed today is owed in 42 days',
    daysUntil(shipBy({ id: 'basic-radio-strap' }, placed(0)).due) === 42);
  check('a week in, 35 days are left',
    daysUntil(shipBy({ id: 'basic-radio-strap' }, placed(7)).due) === 35);
  check('past the deadline the count goes negative',
    daysUntil(shipBy({ id: 'basic-radio-strap' }, placed(45)).due) === -3);
  check('a junk order date yields no date at all',
    shipBy({ id: 'basic-radio-strap' }, 'not a date') === null);

  suite('lib — the order deadline');

  // The whole box ships at once, so the band going late at three weeks is the
  // date that matters, not the strap's six.
  const mixed = {
    creationDate: placed(0),
    items: [
      { id: 'fully-custom-radio-strap', name: 'Fully Custom Radio Strap' },
      { id: 'helmet-band', name: 'Helmet Band' },
    ],
  };
  check('a mixed order takes its earliest item deadline',
    daysUntil(orderShipBy(mixed)) === 21);

  check('order of the items does not change the answer',
    daysUntil(orderShipBy({ ...mixed, items: [...mixed.items].reverse() })) === 21);

  check('an all-strap order gets the full six weeks',
    daysUntil(orderShipBy({
      creationDate: placed(0),
      items: [{ id: 'basic-radio-strap' }, { id: 'fully-custom-radio-strap' }],
    })) === 42);

  check('an order with no items has no deadline',
    orderShipBy({ creationDate: placed(0), items: [] }) === null);
  check('an order with no date has no deadline',
    orderShipBy({ items: [{ id: 'helmet-band' }] }) === null);

  suite('dashboard — queue order');

  // Deliberately handed over newest-first, the order Snipcart lists them in,
  // so a queue that came back in the same order proves nothing happened.
  const waiting = (invoice, daysAgo, items) => ({
    token: invoice, invoiceNumber: invoice, creationDate: placed(daysAgo),
    status: 'Processed', paymentStatus: 'Paid', currency: 'usd',
    grandTotal: 100, items,
  });
  const strap = [{ id: 'fully-custom-radio-strap', name: 'Fully Custom Radio Strap' }];
  const band = [{ id: 'helmet-band', name: 'Helmet Band' }];

  const q = analyze([
    waiting('NEW-STRAP', 2, strap),      // due in 40
    waiting('LATE-BAND', 30, band),      // due 9 days ago
    waiting('SOON-BAND', 18, band),      // due in 3
    waiting('OLD-STRAP', 30, strap),     // due in 12
  ], 'all').queue.map((o) => o.invoiceNumber);

  check('the most overdue order is first', q[0] === 'LATE-BAND');
  check('then the one due soonest', q[1] === 'SOON-BAND');
  check('an old strap still outranks a new one', q[2] === 'OLD-STRAP');
  check('the furthest-out order is last', q[3] === 'NEW-STRAP');

  // Age alone would have put the two 30-day-old orders side by side; the
  // deadline is what splits them, and the band is the one on fire.
  check('age is not what drives the order', q.indexOf('LATE-BAND') < q.indexOf('SOON-BAND'));

  check('nothing to date an order by sorts it last',
    analyze([
      waiting('NO-ITEMS', 5, []),
      waiting('HAS-BAND', 1, band),
    ], 'all').queue.map((o) => o.invoiceNumber)[1] === 'NO-ITEMS');

  // A three-week-old strap and a band ordered this morning are both owed on
  // the same day. The strap has been on the bench longer, so it goes first.
  suite('dashboard — awaiting shipment tile');

  const tile = (orders) => {
    const s = analyze(orders, 'all');
    return { overdue: s.overdue, next: s.nextDue && daysUntil(s.nextDue) };
  };

  check('an empty queue has nothing overdue',
    tile([]).overdue === 0 && tile([]).next === null);
  check('a queue on schedule counts none overdue and dates the next one',
    (() => {
      const t = tile([waiting('A', 2, band), waiting('B', 1, strap)]);
      return t.overdue === 0 && t.next === 19;
    })());
  check('missed dates are counted',
    tile([waiting('A', 30, band), waiting('B', 25, band), waiting('C', 1, strap)]).overdue === 2);
  check('an order with no date is not counted as overdue',
    tile([waiting('A', 99, [])]).overdue === 0);

  const tied = analyze([
    waiting('TODAYS-BAND', 0, band),
    waiting('AGED-STRAP', 21, strap),
  ], 'all').queue.map((o) => o.invoiceNumber);
  check('the longer wait breaks a tie', tied[0] === 'AGED-STRAP' && tied[1] === 'TODAYS-BAND');
}
