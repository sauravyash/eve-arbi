// Specialised ship holds (ore, mineral, PI, fuel bay, fleet hangar, …) — no DOM, no fetch.
//
// A ship's holds come from its dogma attributes (ESI /universe/types/{id}/). An item fits a
// hold by its category or group, from types.json: [name, m³, categoryId, groupId] (ships
// instead have [name, m³, 6, base cargo m³]). An item can fill every hold it fits in plus the
// cargo hold, so its capacity is the sum. Base sizes only: skills and modules aren't counted.

// Ship-only holds (maintenance bay, frigate/cruiser/… holds) take assembled ships, and market
// ships are packaged, so they're left out.
export const HOLDS = [
  { attr: 912, name: 'Fleet hangar', fits: () => true },
  { attr: 1556, name: 'Mining hold', fits: (c, g) => c === 25 || g === 711 },   // ore, moon ore, ice, gas
  { attr: 3227, name: 'Asteroid hold', fits: (c, g) => c === 25 && g !== 465 },  // ore without ice
  { attr: 3136, name: 'Ice hold', fits: (c, g) => g === 465 },
  { attr: 1557, name: 'Gas hold', fits: (c, g) => g === 711 },
  { attr: 1558, name: 'Mineral hold', fits: (c, g) => g === 18 },
  { attr: 1559, name: 'Salvage hold', fits: (c, g) => g === 754 || g === 966 },
  { attr: 1573, name: 'Ammo hold', fits: (c) => c === 8 },
  { attr: 1646, name: 'Command center hold', fits: (c, g) => g === 1027 },
  { attr: 1653, name: 'Planetary commodities hold', fits: (c) => c === 42 || c === 43 },
  { attr: 1549, name: 'Fuel bay', fits: (c, g) => g === 423 || g === 1136 },    // ice products, fuel blocks
  { attr: 2657, name: 'Booster hold', fits: (c, g) => g === 303 },
  { attr: 2675, name: 'Subsystem hold', fits: (c) => c === 32 },
  { attr: 5325, name: 'Mobile depot hold', fits: (c, g) => g === 1246 },
];
const SHIP_CATEGORY = 6;

/**
 * The special holds a ship has.
 * @param {{attribute_id: number, value: number}[]} dogma  ESI dogma_attributes
 * @returns {{attr, name, m3}[]}
 */
export function shipHolds(dogma = []) {
  const byAttr = new Map(dogma.map(a => [a.attribute_id, a.value]));
  return HOLDS.filter(h => byAttr.get(h.attr) > 0).map(h => ({ attr: h.attr, name: h.name, m3: byAttr.get(h.attr) }));
}

/**
 * Room for one item: the cargo hold plus every special hold it fits in.
 * @param {{attr, name, m3}[]} holds   from shipHolds
 * @param {number} cargo                cargo hold m³ (Infinity = unlimited)
 * @param {Array} [info]                the item's types.json entry
 * @returns {{m3: number, holds: {name, m3}[]}}  holds = the special holds used
 */
export function capacityFor(holds, cargo, info) {
  const cat = info?.[2], group = cat === SHIP_CATEGORY ? undefined : info?.[3];
  const used = holds.filter(h => HOLDS.find(d => d.attr === h.attr)?.fits(cat, group));
  return { m3: used.reduce((s, h) => s + h.m3, cargo), holds: used };
}
