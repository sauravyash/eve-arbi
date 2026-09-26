import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkBids, compactItems, valueAtHub, contractProfit, lpOfferValue } from '../public/js/contract-value.js';

test('walkBids fills best price first and stops at the quantity', () => {
  assert.deepEqual(walkBids([[10, 5], [8, 10]], 7), { isk: 5 * 10 + 2 * 8, filled: 7 });
  assert.deepEqual(walkBids([[10, 5]], 9), { isk: 50, filled: 5 });
  assert.deepEqual(walkBids(undefined, 3), { isk: 0, filled: 0 });
});

test('compactItems keeps type, quantity, included and BPC flags', () => {
  assert.deepEqual(compactItems([
    { type_id: 34, quantity: 100, is_included: true },
    { type_id: 999, quantity: 1, is_included: true, is_blueprint_copy: true },
    { type_id: 35, quantity: 5, is_included: false },
  ]), [[34, 100, 1, 0], [999, 1, 1, 1], [35, 5, 0, 0]]);
});

test('valueAtHub walks the book once per type, relists at the lowest ask, costs wanted items', () => {
  const book = new Map([
    [34, { b: [[5, 60], [4, 1000]], a: 6 }],
    [35, { b: [], a: 20 }],
    [36, { b: [[100, 1]], a: null }],
  ]);
  const v = valueAtHub([[34, 50, 1, 0], [34, 50, 1, 0], [36, 3, 1, 0], [35, 2, 0, 0], [777, 1, 1, 1]], (t) => book.get(t));
  assert.equal(v.instant, 60 * 5 + 40 * 4 + 100);   // both stacks of 34 walk together; 36 fills 1 of 3
  assert.equal(v.relist, 100 * 6 + 100);            // 36 has no sell order: falls back to its buy value
  assert.equal(v.need, 2 * 20);
  assert.equal(v.unpriced, 1);                      // the BPC
  assert.equal(v.thin, 1);                          // 36: buy orders absorb only 1 unit
  assert.equal(v.lines, 4);
});

test('valueAtHub counts items with no orders at all as unpriced', () => {
  const v = valueAtHub([[1, 1, 1, 0], [2, 1, 0, 0]], () => undefined);
  assert.deepEqual([v.instant, v.relist, v.need, v.unpriced], [0, 0, 0, 2]);
});

test('contractProfit applies tax to sales only and adds the reward', () => {
  const v = { instant: 1000, relist: 1200, need: 100 };
  assert.deepEqual(contractProfit({ p: 500, r: 50 }, v, { taxRate: 0.1 }), { value: 900, cost: 600, profit: 350 });
  assert.equal(contractProfit({ p: 500, r: 0 }, v, { mode: 'relist' }).profit, 600);
});

test('lpOfferValue gives ISK per LP after ISK cost and required items', () => {
  const prices = { 1: { buy: 1000, sell: 1100 }, 2: { buy: 10, sell: 12 } };
  const offer = { type_id: 1, quantity: 10, lp_cost: 2000, isk_cost: 1000, required_items: [{ type_id: 2, quantity: 50 }] };
  const v = lpOfferValue(offer, (t) => prices[t]);
  assert.equal(v.revenue, 10_000);
  assert.equal(v.reqCost, 600);
  assert.equal(v.perLp, (10_000 - 1000 - 600) / 2000);
  assert.equal(lpOfferValue(offer, (t) => prices[t], { mode: 'relist' }).revenue, 11_000);
  assert.equal(lpOfferValue({ ...offer, type_id: 3 }, (t) => prices[t]).perLp, null);
});
