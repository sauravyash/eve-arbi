// Jump clones for the route planner. Pure: no DOM, no fetch.
//
// /api/me/clones (sso.js clones()) gives where each clone sits and the assembled items in the
// hangar there; this places them in a system, keeps the ships (types.json), sorts them into the
// route planner's ship sizes, and says which clone a route is best flown from.

const SHIP_CATEGORY = 6;
export const CLONE_COOLDOWN_H = 24;   // less 1 h per level of Infomorph Synchronizing (not readable here)
// Freighters and jump freighters share the capitals' packaged volume; they're told apart by their hold.
const FREIGHTER_HOLD = 100_000;
const BOWHEAD = 34328;                // a freighter with a ship bay instead of a big hold

/**
 * A ship's size, as wormholes and the route planner count them: from its packaged volume
 * (types.json [name, m³, categoryId, cargo]). null when it isn't a ship.
 * @returns {'small'|'medium'|'large'|'xlarge'|'capital'|null}
 */
export function shipSize(typeId, info) {
  if (!info || info[2] !== SHIP_CATEGORY) return null;
  const vol = info[1];
  if (vol <= 5_000) return 'small';        // shuttles, frigates, destroyers
  if (vol <= 20_000) return 'medium';      // cruisers, battlecruisers, industrials
  if (vol <= 50_000) return 'large';       // battleships
  if (vol <= 500_000) return 'xlarge';     // Orca
  if (vol <= 1_300_000 && ((info[3] ?? 0) >= FREIGHTER_HOLD || typeId === BOWHEAD)) return 'xlarge';
  return 'capital';
}

/**
 * Where each clone is, and the ships waiting there.
 * @param {object} data      /api/me/clones
 * @param {object} types     types.json
 * @param {object} stations  stations.json ({stationId: [name, systemId]})
 * @returns {{kind: 'jump'|'home', cloneId, name, locationId, locationName, systemId, implants: number[],
 *   ships: {typeId, name, size, cargo, count}[]}[]}  systemId null when the structure can't be seen
 */
export function clonePlaces(data, types = {}, stations = {}) {
  if (!data) return [];
  const shipsAt = new Map();
  for (const s of data.ships || []) {
    const info = types[s.typeId];
    const size = shipSize(s.typeId, info);
    if (!size) continue;
    const list = shipsAt.get(s.locationId) || [];
    const same = list.find(x => x.typeId === s.typeId);
    if (same) same.count++;
    else list.push({ typeId: s.typeId, name: info[0], size, cargo: info[3] || 0, count: 1 });
    shipsAt.set(s.locationId, list);
  }
  const place = (kind, c) => {
    const st = stations[c.locationId], loc = data.locations?.[c.locationId];
    return {
      kind, cloneId: c.cloneId ?? null, name: c.name ?? null, locationId: c.locationId,
      locationName: st?.[0] ?? loc?.name ?? (c.locationType === 'structure' ? 'Structure (no docking access)' : `Station ${c.locationId}`),
      systemId: st?.[1] ?? loc?.systemId ?? null, implants: c.implants || [],
      ships: (shipsAt.get(c.locationId) || []).sort((a, b) => b.cargo - a.cargo),
    };
  };
  return [
    ...(data.jumpClones || []).map(c => place('jump', c)),
    ...(data.home ? [place('home', data.home)] : []),
  ];
}

/** The ships at a place you could fly for this route: any ship, or only ones of `size` when set. */
export function usableShips(place, size = '') {
  return place.ships.filter(s => !size || s.size === size);
}

/** Milliseconds until the next clone jump (0 when ready), assuming the base cooldown. */
export function cloneCooldownLeft(lastJumpAt, now = Date.now(), hours = CLONE_COOLDOWN_H) {
  return lastJumpAt ? Math.max(0, lastJumpAt + hours * 3_600_000 - now) : 0;
}

/**
 * Jump clones ranked by the jumps the route flies from each, fewest first. `jumpsFrom(systemId)`
 * prices the route started there (null when there's no route). With `needShip`, a clone counts
 * only when a usable ship (usableShips) waits there. The medical clone is left out: you reach it
 * by losing your pod.
 * @returns {{place, jumps: number|null, ships, usable: boolean}[]}
 */
export function rankClones(places, jumpsFrom, { size = '', needShip = true } = {}) {
  return places.filter(p => p.kind === 'jump').map((place) => {
    const ships = usableShips(place, size);
    const usable = place.systemId != null && (!needShip || ships.length > 0);
    return { place, ships, usable, jumps: place.systemId != null ? jumpsFrom(place.systemId) : null };
  }).sort((a, b) => (b.usable - a.usable) || ((a.jumps ?? Infinity) - (b.jumps ?? Infinity)));
}

/**
 * The clone worth jumping to: the usable one with fewest jumps, when it beats starting where you
 * are by at least `minSaved` jumps.
 * @returns {{place, jumps, ships, usable, saved: number}|null}
 */
export function bestClone(ranked, currentJumps, minSaved = 1) {
  const top = ranked.find(r => r.usable && r.jumps != null);
  if (!top) return null;
  const saved = currentJumps == null ? Infinity : currentJumps - top.jumps;
  return saved >= minSaved ? { ...top, saved } : null;
}
