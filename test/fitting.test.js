import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEft, hullCargoBonus, fittedCargo, loadFit } from '../public/js/fitting.js';

const FRIGGA = `[Iteron Mark V, frigga]
Warp Core Stabilizer I
[Empty Low slot]
Expanded Cargohold I
Expanded Cargohold I
Expanded Cargohold I

10MN Afterburner I
Enduring Multispectrum Shield Hardener
Medium Shield Extender I
Medium Shield Extender I


Medium Cargohold Optimization I
Medium Cargohold Optimization I
`;
// ESI, trimmed.
const ITERON_V = { capacity: 5800, dogma_attributes: [{ attribute_id: 38, value: 5800 }, { attribute_id: 496, value: 5 }],
  dogma_effects: [{ effect_id: 726 }, { effect_id: 729 }] };
const EFFECTS = {
  726: { modifiers: [{ domain: 'shipID', func: 'ItemModifier', modified_attribute_id: 38, modifying_attribute_id: 496, operator: 6 }] },
  729: { modifiers: [{ domain: 'shipID', func: 'ItemModifier', modified_attribute_id: 37, modifying_attribute_id: 496, operator: 6 }] },
};
const EXPANDER = [{ attribute_id: 38, value: 0 }, { attribute_id: 149, value: 1.175 }];
const RIG = [{ attribute_id: 614, value: 15 }, { attribute_id: 1138, value: -10 }];
const TYPES = { 657: ['Iteron Mark V', 20000, 6, 5800], 1317: ['Expanded Cargohold I', 5, 7, 765], 31119: ['Medium Cargohold Optimization I', 10, 7, 782],
  10002: ['Warp Core Stabilizer I', 5, 7, 315] };

test('parseEft reads the ship and fitted modules, skipping empty slots', () => {
  const fit = parseEft(FRIGGA);
  assert.equal(fit.ship, 'Iteron Mark V');
  assert.equal(fit.name, 'frigga');
  assert.equal(fit.modules.length, 10);
  assert.equal(fit.modules.filter(m => m === 'Expanded Cargohold I').length, 3);
  assert.deepEqual(parseEft('[Rifter, x]\n125mm Gatling AutoCannon I, EMP S\nHobgoblin I x5\nDamage Control I /offline').modules,
    ['125mm Gatling AutoCannon I', 'Hobgoblin I', 'Damage Control I']);
  assert.equal(parseEft('Veldspar 100'), null);
});

test('hullCargoBonus counts only effects on the ship\'s own capacity', () => {
  assert.equal(hullCargoBonus(ITERON_V.dogma_attributes, Object.values(EFFECTS)), 5);
  assert.equal(hullCargoBonus(ITERON_V.dogma_attributes, [null]), 0);
});

test('fittedCargo multiplies expanders, rigs and the hull bonus without stacking penalties', () => {
  const modules = [EXPANDER, EXPANDER, EXPANDER, RIG, RIG, []];
  const r = fittedCargo({ base: 5800, hullBonus: 5, skill: 5, modules });
  assert.equal(r.expanders, 3);
  assert.equal(r.rigs, 2);
  assert.ok(Math.abs(r.m3 - 5800 * 1.175 ** 3 * 1.15 ** 2 * 1.25) < 1e-6);
  assert.equal(Math.round(r.m3), 15554);
  assert.equal(fittedCargo({ base: 5800 }).m3, 5800);
});

test('loadFit resolves names and pulls dogma from ESI', async () => {
  const esi = async (path) => {
    const [, kind, id] = path.match(/^(universe\/types|dogma\/effects)\/(\d+)\/$/);
    if (kind === 'dogma/effects') return EFFECTS[id];
    return { 657: ITERON_V, 1317: { dogma_attributes: EXPANDER }, 31119: { dogma_attributes: RIG }, 10002: { dogma_attributes: [] } }[id];
  };
  const fit = await loadFit(FRIGGA, { types: TYPES, esi });
  assert.equal(fit.shipId, 657);
  assert.equal(fit.base, 5800);
  assert.equal(fit.hullBonus, 5);
  assert.deepEqual(fit.unknown, ['10MN Afterburner I', 'Enduring Multispectrum Shield Hardener', 'Medium Shield Extender I', 'Medium Shield Extender I']);
  assert.equal(Math.round(fittedCargo({ ...fit, skill: 5 }).m3), 15554);
  await assert.rejects(loadFit('[Nope, x]', { types: TYPES, esi }), /Unknown ship/);
});
