import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packRoute, multibuyText } from '../public/js/manifest.js';

const item = (key, vol, steps, pools = ['cargo']) => ({ key, t: key.length, name: key, vol, steps, pools });

test('fills the hold with the best ISK per m³ first, then tops up with the next item', () => {
  const dense = item('dense', 1, [[100, 10, 30]]);      // 20 ISK/m³
  const bulky = item('bulky', 10, [[100, 10, 60]]);     // 5 ISK/m³
  const load = packRoute([bulky, dense], { pools: { cargo: 250 } });
  assert.deepEqual(load.items.map(e => [e.name, e.units]), [['dense', 100], ['bulky', 15]]);
  assert.equal(load.volume, 250);
  assert.equal(load.profit, 100 * 20 + 15 * 50);
});

test('walks each order book in order and stops where the margin ends', () => {
  const a = item('a', 1, [[10, 10, 20], [10, 12, 18], [10, 15, 14]]);
  const load = packRoute([a], { pools: { cargo: Infinity } });
  assert.equal(load.items[0].units, 20);
  assert.equal(load.profit, 10 * 10 + 10 * 6);
  assert.equal(load.items[0].worstBuy, 12);
});

test('applies sales tax to the sell price', () => {
  const a = item('a', 1, [[10, 100, 105]]);   // 105 × 0.925 < 100: no profit after tax
  assert.equal(packRoute([a], { pools: { cargo: Infinity }, taxRate: 0.075 }).items.length, 0);
});

test('with a budget, cheap high-return items win over expensive ones', () => {
  const cheap = item('cheap', 1, [[100, 10, 20]]);     // 100% return
  const pricey = item('pricey', 1, [[100, 1000, 1100]]);  // 10% return
  const load = packRoute([pricey, cheap], { pools: { cargo: Infinity }, maxCost: 2000 });
  assert.deepEqual(load.items.map(e => [e.name, e.units]), [['cheap', 100], ['pricey', 1]]);
  assert.ok(load.cost <= 2000);
});

test('both limits: tries several mixes and keeps the most profitable load', () => {
  // Small hold, small budget: 'gem' is dense but pricey, 'rock' cheap but bulky.
  const gem = item('gem', 1, [[50, 100, 150]]);
  const rock = item('rock', 5, [[200, 1, 11]]);
  const load = packRoute([gem, rock], { pools: { cargo: 100 }, maxCost: 5000 });
  assert.ok(load.volume <= 100 && load.cost <= 5000);
  // Best by hand: 50 gems (50 m³, 5000 ISK) = 2500; or 20 rocks (100 m³) = 200; or mixes. Gems win.
  assert.equal(load.profit, 2500);
});

test('special holds take the items that fit them before the shared cargo hold', () => {
  const ore = item('ore', 1, [[1000, 10, 12]], ['1556', 'cargo']);
  const mods = item('mods', 1, [[100, 10, 11]]);
  const load = packRoute([ore, mods], { pools: { 1556: 500, cargo: 100 } });
  const byName = Object.fromEntries(load.items.map(e => [e.name, e]));
  assert.equal(byName.ore.units, 600);
  assert.deepEqual(byName.ore.used, { 1556: 500, cargo: 100 });
  assert.equal(byName.mods, undefined);   // ore earns 2/m³, mods 1/m³: the cargo hold went to ore
});

test('multibuy text lists each item and quantity on its own line', () => {
  assert.equal(multibuyText([{ name: 'Tritanium', units: 1000 }, { name: 'Pyerite', units: 5 }]), 'Tritanium 1000\nPyerite 5');
});
