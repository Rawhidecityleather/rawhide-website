/**
 * Keeps Snipcart's discount rule in step with the sale banner.
 *
 * The banner record (worker/promo.js) is the source of truth. This file reads
 * it and makes Snipcart match: while the sale is live and has a deal, exactly
 * one discount of ours is active over there; the rest of the time, none. It
 * runs after every save and once an hour from the cron, so a sale scheduled
 * for next Friday goes up on Friday without anyone touching anything, and
 * comes down again on the hour after it ends.
 *
 * It never trusts its own memory over Snipcart's. Before creating a rule it
 * looks for one it made earlier, by the name prefix, and reuses it. That
 * covers a stale KV read, a redeploy, or a second save arriving before the
 * first has finished — none of which may leave two live rules taking two cuts.
 *
 * Errors are recorded on the record, not thrown. The banner still saves; the
 * card shows what Snipcart said; the cron retries on the hour.
 */

import { getJson, postJson, putJson } from './snipcart.js';
import { isLive, putPromo, endOfDayUtc, dealSentence } from './promo.js';

/** Every rule this file creates is named with this. It is how it finds them again. */
export const RULE_PREFIX = 'Sale banner: ';

/**
 * The Snipcart discount that matches a record. Field names are Snipcart's.
 *
 * trigger  Code  — the buyer types it
 *          Total — automatic; `totalToReach` is the order minimum. 1 rather
 *                  than 0 so it is unarguably an amount; nothing sells for
 *                  under a dollar. A dollar-off-the-order rule needs the
 *                  order to be at least that amount, or the total goes below
 *                  zero.
 * type     Rate / FixedAmount            — on the order
 *          RateOnItems / FixedAmountOnItems — on the named products only
 * combinable false — a storewide sale must not stack with a cart-recovery
 *                    coupon, which is also non-combinable for the same reason.
 * expires  — the last minute of the end date in Florida, as a backstop. The
 *            cron archives the rule on the hour after; this is for the day
 *            the cron does not fire.
 */
export function discountBody(promo) {
  const deal = promo.deal;
  const onProducts = deal.scope === 'products';
  const body = {
    name: `${RULE_PREFIX}${dealSentence(deal)}${promo.kind === 'code' ? ` (${promo.code})` : ''}`.slice(0, 100),
    trigger: promo.kind === 'code' ? 'Code' : 'Total',
    combinable: false,
    maxNumberOfUsages: null,
    expires: promo.ends ? endOfDayUtc(promo.ends) : null,
  };
  if (promo.kind === 'code') {
    body.code = promo.code;
  } else {
    body.totalToReach = deal.type === 'amount' && !onProducts ? deal.value : 1;
  }
  if (deal.type === 'percent') {
    body.type = onProducts ? 'RateOnItems' : 'Rate';
    body.rate = deal.value;
  } else {
    body.type = onProducts ? 'FixedAmountOnItems' : 'FixedAmount';
    body.amount = deal.value;
  }
  if (onProducts) body.productIds = deal.productIds.join(',');
  return body;
}

/** Our active rules on Snipcart, newest first. Usually zero or one. */
export async function findOurRules(env) {
  const list = await getJson(env, '/discounts');
  const rules = Array.isArray(list) ? list : (list?.items || []);
  return rules
    .filter((r) => r && !r.archived && typeof r.name === 'string' && r.name.startsWith(RULE_PREFIX))
    .sort((a, b) => String(b.creationDate || '').localeCompare(String(a.creationDate || '')));
}

/**
 * The best rate a buyer already gets for doing nothing: the highest live,
 * storewide, automatic percentage on the store right now, or 0.
 *
 * Cart recovery asks this before offering anybody a discount. A 15% coupon sent
 * while an automatic 15% is already coming off the cart is not an offer — both
 * are non-combinable, so typing the code swaps one 15% for an identical one and
 * the buyer saves nothing. Not a theory: the Labor Day rule ran automatically
 * from 2026-09-03, and every recovery code minted underneath it went unused
 * while the automatic rule itself was redeemed again and again.
 *
 * Deliberately narrow, because the question is not "is there a sale on" but
 * "does this buyer already have this". Only `Rate` counts — `RateOnItems` is
 * scoped to named products and may not touch this cart at all. Only a rule with
 * no code, because one the buyer has to type is not something they have. And
 * only one with no real order minimum: "15% over $100" is not something the
 * owner of an $80 cart already has, and there is no cart in hand here to check
 * it against. `totalToReach` is 1 on the rules this repo writes — an amount
 * nothing sells under — so our own sales still count.
 *
 * Never throws. A failed read must not quietly stop recovery for good, so it
 * comes back 0, which sends the coupon: the safe side of the mistake.
 */
export async function automaticStoreRate(env, now = Date.now()) {
  if (!env.SNIPCART_SECRET) return 0;

  let list;
  try {
    list = await getJson(env, '/discounts');
  } catch {
    return 0;
  }

  const rules = Array.isArray(list) ? list : (list?.items || []);
  let best = 0;
  for (const rule of rules) {
    if (!rule || rule.archived) continue;
    if (rule.trigger === 'Code' || rule.code) continue;
    if (rule.type !== 'Rate') continue;
    if (Number(rule.totalToReach) > 1) continue;
    if (rule.expires && Date.parse(rule.expires) <= now) continue;
    const rate = Number(rule.rate);
    if (Number.isFinite(rate) && rate > best) best = rate;
  }
  return best;
}

/** Snipcart's copy of the rule the record points at, or null. For the card. */
export async function fetchRule(env, promo) {
  const id = promo?.snipcart?.id;
  if (!id || !env.SNIPCART_SECRET) return null;
  try {
    return await getJson(env, `/discounts/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

async function archive(env, rule) {
  await putJson(env, `/discounts/${encodeURIComponent(rule.id)}`, { ...rule, archived: true });
}

/**
 * Make Snipcart match the record, then write what happened back onto it.
 *
 * Returns { changed, snipcart } — `snipcart` is the block now on the record:
 *   id     the Snipcart discount id while a rule is live, else ''
 *   state  'on' while a rule is live, else 'off'
 *   hash   the body last pushed, so an unchanged sale costs no API calls
 *   at     when this last did anything
 *   error  Snipcart's complaint from the last attempt, or ''
 */
export async function syncPromo(env, promo, now = new Date()) {
  if (!promo) return { changed: false, snipcart: null };
  if (!env.SNIPCART_SECRET) {
    return { changed: false, snipcart: promo.snipcart || null, skipped: 'no Snipcart key' };
  }

  const sc = { id: '', state: 'off', hash: '', at: '', error: '', ...(promo.snipcart || {}) };
  const wantRule = isLive(promo, now) && promo.deal && promo.deal.type !== 'none';
  let changed = false;

  try {
    if (wantRule) {
      const body = discountBody(promo);
      const hash = JSON.stringify(body);
      if (sc.state === 'on' && sc.id && sc.hash === hash && !sc.error) {
        return { changed: false, snipcart: sc };
      }

      // Reuse before create. The record's id first; failing that, anything of
      // ours still active over there. Extras get archived — one sale, one rule.
      const ours = await findOurRules(env);
      let keep = ours.find((r) => r.id === sc.id) || ours[0] || null;
      for (const extra of ours) {
        if (keep && extra.id !== keep.id) await archive(env, extra);
      }

      if (keep) {
        await putJson(env, `/discounts/${encodeURIComponent(keep.id)}`, { ...keep, ...body, archived: false });
        sc.id = keep.id;
      } else {
        const created = await postJson(env, '/discounts', body);
        if (!created || !created.id) throw new Error('Snipcart created the rule but returned no id.');
        sc.id = created.id;
      }
      sc.state = 'on';
      sc.hash = hash;
      changed = true;
    } else {
      // Nothing should be live. Archive whatever of ours is, by id or by name.
      const ours = await (sc.id || sc.state === 'on' ? findOurRules(env) : Promise.resolve([]));
      for (const rule of ours) await archive(env, rule);
      if (ours.length || sc.state === 'on' || sc.id) changed = true;
      else if (!sc.error) return { changed: false, snipcart: sc };
      sc.id = '';
      sc.state = 'off';
      sc.hash = '';
    }
    sc.error = '';
  } catch (err) {
    sc.error = String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 300);
    changed = true;
  }

  sc.at = now.toISOString();
  promo.snipcart = sc;
  await putPromo(env, promo);
  return { changed, snipcart: sc };
}
