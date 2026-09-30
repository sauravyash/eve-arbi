import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitPrice, appraise, brokerFee, eveDate, contractIsk, receiveAmount, byLocation, itemsText, contractItems,
  summaryText, harvestable, minedTypes } from '../public/js/buyback.js';
import { rootAssets } from '../sso.js';
import { parsePaste } from '../public/js/mining-value.js';

test('unitPrice: split is the midpoint, falling back to whichever side exists', () => {
  assert.equal(unitPrice({ buy: 10, sell: 14 }, 'split'), 12);
  assert.equal(unitPrice({ buy: 10, sell: null }, 'split'), 10);
  assert.equal(unitPrice({ buy: null, sell: 14 }, 'split'), 14);
  assert.equal(unitPrice({ buy: null, sell: 14 }, 'buy'), null);
  assert.equal(unitPrice({ buy: 10, sell: 14 }, 'sell'), 14);
  assert.equal(unitPrice(null, 'split'), null);
});

test('appraise totals every basis and applies the buyback rate', () => {
  const a = appraise(
    [{ typeId: 1, qty: 100, volume: 0.1 }, { typeId: 2, qty: 10, volume: 1 }, { typeId: 3, qty: 5 }, { typeId: 4, qty: 0 }],
    { 1: { buy: 10, sell: 20 }, 2: { buy: 100, sell: null }, 3: null },
    { basis: 'split', rate: 90 },
  );
  assert.equal(a.lines.length, 3);
  assert.equal(a.buy, 100 * 10 + 10 * 100);
  assert.equal(a.sell, 100 * 20);
  assert.equal(a.split, 100 * 15 + 10 * 100);
  assert.equal(a.value, 2500);
  assert.equal(a.payout, 2250);
  assert.equal(a.m3, 20);
  assert.deepEqual(a.missing, [3]);
  assert.equal(a.lines[0].payout, 1350);
});

test('brokerFee: flat for private and corp contracts, 0.4% clamped for public', () => {
  assert.equal(brokerFee('private', 5e9), 10_000);
  assert.equal(brokerFee('corp', 0), 10_000);
  assert.equal(brokerFee('public', 1e6), 10_000);
  assert.equal(brokerFee('public', 1e8), 400_000);
  assert.equal(brokerFee('public', 1e12), 10_000_000);
});

test('contract formatting matches the game window', () => {
  assert.equal(eveDate(Date.UTC(2026, 9, 28, 12, 40, 59)), '2026.10.28 12:40');
  assert.equal(contractIsk(10_000), '10,000 ISK');
  assert.equal(contractIsk(0), '0 ISK');
  assert.equal(contractIsk(1234.5), '1,234.50 ISK');
  assert.equal(receiveAmount(1999.99), 1999);
  assert.equal(receiveAmount(-5), 0);
  const name = (t) => ({ 483: 'Miner I', 1230: 'Veldspar' }[t]);
  assert.deepEqual(contractItems([{ typeId: 483, qty: 8 }, { typeId: 1230, qty: 12345 }], name), ['Miner I x 8', 'Veldspar x 12,345']);
  assert.equal(itemsText([{ typeId: 1230, qty: 12345 }], name), 'Veldspar\t12345');
});

test('itemsText round-trips through the paste parser', () => {
  const ids = { veldspar: 1230, 'miner i': 483 };
  const name = (t) => ({ 483: 'Miner I', 1230: 'Veldspar' }[t]);
  const text = itemsText([{ typeId: 1230, qty: 12345 }, { typeId: 483, qty: 8 }], name);
  assert.deepEqual(parsePaste(text, (n) => ids[n.toLowerCase()] ?? null).items, [{ typeId: 1230, qty: 12345 }, { typeId: 483, qty: 8 }]);
  // EVE's inventory copy (details view): name, qty, group, …, volume, est. price.
  const eve = 'Veldspar\t12,345\tVeldspar\t\t\t1,234.50 m3\t123,456.00 ISK\nMiner I\t8\tMining Laser\t\t\t40 m3';
  assert.deepEqual(parsePaste(eve, (n) => ids[n.toLowerCase()] ?? null).items, [{ typeId: 1230, qty: 12345 }, { typeId: 483, qty: 8 }]);
});

test('summaryText lists items, totals and payout', () => {
  const a = appraise([{ typeId: 1, qty: 2, volume: 1 }], { 1: { buy: 100, sell: 200 } }, { basis: 'buy', rate: 90 });
  const s = summaryText(a, { name: () => 'Veldspar', basis: 'buy', rate: 90, corp: 'Eagle Wing Industries' });
  assert.match(s, /^Buyback for Eagle Wing Industries: 90% of Jita buy/);
  assert.match(s, /Veldspar x 2 = 200 ISK/);
  assert.match(s, /Payout \(90%\): 180 ISK$/);
});

test('byLocation keeps unknown locations together', () => {
  const g = byLocation([{ typeId: 1, locationId: 60003760 }, { typeId: 2 }, { typeId: 3, locationId: 60003760 }]);
  assert.deepEqual([...g.keys()], [60003760, 0]);
  assert.equal(g.get(60003760).length, 2);
});

test('rootAssets rolls items in ships and containers up to their station', () => {
  const out = rootAssets([
    { item_id: 1, type_id: 32880, quantity: 1, location_id: 60003760, location_type: 'station', location_flag: 'Hangar' }, // ship
    { item_id: 2, type_id: 1230, quantity: 500, location_id: 1, location_type: 'item', location_flag: 'SpecializedOreHold' },
    { item_id: 3, type_id: 1230, quantity: 100, location_id: 60003760, location_type: 'station', location_flag: 'Hangar' },
    { item_id: 4, type_id: 1230, quantity: 7, location_id: 1_035_000_000_000, location_type: 'item', location_flag: 'Hangar' },
    { item_id: 5, type_id: 1230, quantity: 9, location_id: 30000142, location_type: 'solar_system', location_flag: 'AutoFit' },
  ]);
  assert.deepEqual(out, [
    { typeId: 32880, qty: 1, locationId: 60003760, locationType: 'station' },
    { typeId: 1230, qty: 600, locationId: 60003760, locationType: 'station' },
    { typeId: 1230, qty: 7, locationId: 1_035_000_000_000, locationType: 'structure' },
    { typeId: 1230, qty: 9, locationId: 30000142, locationType: 'system' },
  ]);
});

test('harvestable and minedTypes', () => {
  const types = { 1230: ['Veldspar', 0.1, 25, 462, 'ore'], 483: ['Miner I', 5, 7, 54] };
  assert.deepEqual(harvestable([{ typeId: 1230, qty: 5 }, { typeId: 483, qty: 1 }, { typeId: 1230, qty: 0 }], types), [{ typeId: 1230, qty: 5 }]);
  assert.deepEqual(minedTypes([{ typeId: 1, qty: 5 }, { typeId: 2, qty: 50 }, { typeId: 1, qty: 10 }]), [{ typeId: 2, qty: 50 }, { typeId: 1, qty: 15 }]);
});

test('parsePaste takes "name x qty" with a space after the x', () => {
  const ids = { 'fullerite-c50': 30370, veldspar: 1230 };
  const r = parsePaste('Fullerite-C50 x 3,000\nVeldspar x12\n5 x Veldspar', (n) => ids[n.toLowerCase()] ?? null);
  assert.deepEqual(r.items, [{ typeId: 30370, qty: 3000 }, { typeId: 1230, qty: 17 }]);
  assert.deepEqual(r.unknown, []);
});

test('parsePaste reads EVE rich-text copies with <t> and <right> markup', () => {
  const ids = { 'arkonor iv-grade': 46678, veldspar: 1230 };
  const text = 'Arkonor IV-Grade<t><right>866<t>Arkonor<t><t><t><right>13,856 m3<t><right>1,992,631.36 ISK\n'
    + 'Veldspar<t><right>1,000<t>Veldspar<t><t><t><right>100 m3<t><right>12,000.00 ISK';
  const r = parsePaste(text, (n) => ids[n.toLowerCase()] ?? null);
  assert.deepEqual(r.items, [{ typeId: 46678, qty: 866 }, { typeId: 1230, qty: 1000 }]);
  assert.deepEqual(r.unknown, []);
});
