// Cargo hold of a fitted ship, from an EFT fitting (Ctrl+C in the in-game fitting window).
//
// Capacity = hull cargo × every cargo expander (attribute 149, a multiplier) × every rig
// (attribute 614, +%) × the hull's cargo bonus per skill level. Cargo modules and rigs aren't
// stacking-penalised in EVE, so they simply multiply. Only the cargo hold changes; special holds
// keep their base size.

const CAPACITY = 38;              // cargo hold m³
const CARGO_MULTIPLIER = 149;     // Expanded Cargohold
const CARGO_BONUS = 614;          // Cargohold Optimization rigs, %
const REQUIRED_SKILL = 182;       // the hull's primary skill, which its bonuses scale with
const ITEM_MODIFIER = 'ItemModifier', POST_PERCENT = 6;

/**
 * Ship and module names from an EFT fitting. Empty slots, charges (", Nanite Repair Paste"),
 * stacks ("Hobgoblin I x5") and "/offline" are dropped.
 * @param {string} text
 * @returns {{ship: string, name: string, modules: string[]}|null}  null without a [Ship, name] line
 */
export function parseEft(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim());
  const at = lines.findIndex(l => /^\[[^\]]+\]$/.test(l) && !/^\[empty /i.test(l));
  if (at < 0) return null;
  const [ship, ...rest] = lines[at].slice(1, -1).split(',');
  const modules = [];
  for (const l of lines.slice(at + 1)) {
    if (!l || /^\[empty /i.test(l)) continue;
    const name = l.replace(/\s*\/offline$/i, '').replace(/,.*$/, '').replace(/\s+x\d+$/i, '').trim();
    if (name) modules.push(name);
  }
  return { ship: ship.trim(), name: rest.join(',').trim(), modules };
}

/**
 * The hull's cargo bonus: % per level of its skill, from the ship's dogma effects that raise its
 * own capacity (e.g. shipBonusCargo2GI: attribute 496 = 5 % per level of Gallente Industrial).
 * @param {{attribute_id, value}[]} attrs      the ship's dogma_attributes
 * @param {{modifiers?: object[]}[]} effects   its dogma effects (ESI /dogma/effects/{id}/)
 */
export function hullCargoBonus(attrs = [], effects = []) {
  const byAttr = new Map(attrs.map(a => [a.attribute_id, a.value]));
  let pct = 0;
  for (const e of effects) {
    for (const m of e?.modifiers || []) {
      if (m.func === ITEM_MODIFIER && m.domain === 'shipID' && m.modified_attribute_id === CAPACITY && m.operator === POST_PERCENT) {
        pct += byAttr.get(m.modifying_attribute_id) || 0;
      }
    }
  }
  return pct;
}

/**
 * @param {object} o
 * @param {number} o.base            hull cargo m³
 * @param {number} [o.hullBonus=0]   % per skill level (hullCargoBonus)
 * @param {number} [o.skill=0]       level of the hull's skill, 0–5
 * @param {{attribute_id, value}[][]} [o.modules]  each fitted module's dogma_attributes
 * @returns {{m3: number, factor: number, expanders: number, rigs: number}}
 */
export function fittedCargo({ base, hullBonus = 0, skill = 0, modules = [] }) {
  let factor = 1 + hullBonus * skill / 100, expanders = 0, rigs = 0;
  for (const attrs of modules) {
    for (const a of attrs || []) {
      if (a.attribute_id === CARGO_MULTIPLIER && a.value !== 1) { factor *= a.value; expanders++; }
      if (a.attribute_id === CARGO_BONUS && a.value) { factor *= 1 + a.value / 100; rigs++; }
    }
  }
  return { m3: base * factor, factor, expanders, rigs };
}

/**
 * Parse a fitting and look up what it needs from ESI.
 * @param {string} text                             EFT fitting
 * @param {object} o
 * @param {Record<string, Array>} o.types           types.json ([name, m³, categoryId, …])
 * @param {(path: string) => Promise<object>} o.esi  GET an ESI path (e.g. 'universe/types/657/')
 * @returns {Promise<{shipId, ship, name, base, hullBonus, skill: string|null, modules: {attribute_id, value}[][], unknown: string[], failed: string[]}>}
 *   unknown: names not in types.json; failed: modules ESI couldn't return (left out)
 */
export async function loadFit(text, { types, esi }) {
  const fit = parseEft(text);
  if (!fit) throw new Error('No [Ship, name] line — paste a fitting copied from the game');
  const idByName = new Map();
  for (const [id, t] of Object.entries(types || {})) idByName.set(t[0].toLowerCase(), Number(id));
  const shipId = idByName.get(fit.ship.toLowerCase());
  if (!shipId || types[shipId][2] !== 6) throw new Error(`Unknown ship “${fit.ship}”`);

  const cache = new Map();
  const typeOf = (id) => { if (!cache.has(id)) cache.set(id, esi(`universe/types/${id}/`)); return cache.get(id); };
  const unknown = fit.modules.filter(n => !idByName.has(n.toLowerCase())), failed = [];
  const hull = await typeOf(shipId).catch(e => { throw new Error(`Couldn't look up the ${types[shipId][0]} (${e.message}); try again in a moment`); });
  const [effects, modules] = await Promise.all([
    Promise.all((hull.dogma_effects || []).map(e => esi(`dogma/effects/${e.effect_id}/`).catch(() => null))),
    // One module ESI can't answer for shouldn't sink the whole fitting: it's left out and listed.
    Promise.all(fit.modules.filter(n => idByName.has(n.toLowerCase())).map(n => typeOf(idByName.get(n.toLowerCase()))
      .then(t => t.dogma_attributes || [], () => { failed.push(n); return []; }))),
  ]);
  const attr = (id) => (hull.dogma_attributes || []).find(a => a.attribute_id === id)?.value;
  const skillId = attr(REQUIRED_SKILL);
  return { shipId, ship: types[shipId][0], name: fit.name, base: attr(CAPACITY) ?? hull.capacity ?? 0,
    hullBonus: hullCargoBonus(hull.dogma_attributes, effects), skill: skillId ? types[skillId]?.[0] || null : null, modules, unknown, failed };
}
