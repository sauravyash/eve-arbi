// Who controls each low- and null-sec system, from killmails: the server's control crawler
// (control-crawler.js) adds up EVE Ref's daily archives, the zKillboard R2Z2 feed and zKillboard's
// per-system top lists with these functions, and the Warfare page blends the result with sov.
// Pure: no DOM, no fetch.
//
// Per system and side (alliance, else corporation, else NPC faction: war-data.js sideOf), five
// counts, each telling something different about who is there:
//   k  kills scored there: force projected into the system
//   l  ships lost there: present, if not winning
//   r  "resident" losses: mining hulls, or ships killed by NPCs alone (ratting, mining, hauling)
//   s  structures of theirs destroyed there: they had built in the system
//   x  structures they destroyed there: sieging someone's space
// plus z, kills on zKillboard's own top list for the system (its recent window), when crawled.

import { sideOf, playerSides } from './war-data.js';

export const SIGNALS = ['k', 'l', 'r', 's', 'x', 'z'];
// z is low: zKillboard's top lists mostly count the same kills again; they add coverage, not weight.
export const WEIGHTS = { k: 3, l: 1, r: 2, s: 6, x: 3, z: 0.5 };
// The sov holder's claim, per point of ADM (1–6): a fully used system counts like 8 kills a day.
export const SOV_WEIGHT = 4;
// Score at which a system's owner is taken as certain; below it the hold is drawn fainter.
export const CONFIDENT_SCORE = 40;
export const HALF_LIFE_DAYS = 3;

// Upwell and sov structures (and their faction variants): a loss shows whose infrastructure was there.
export const STRUCTURE_TYPES = new Set([
  32226, 32458, 35825, 35826, 35827, 35832, 35833, 35834, 35835, 35836, 35840, 35841, 37534, 40340,
  47512, 47513, 47514, 47515, 47516, 81080, 81826,
]);
// Mining hulls, from the Venture to the Rorqual: someone working the system, not passing through.
export const MINING_HULLS = new Set([32880, 17480, 17478, 17476, 22546, 22548, 22544, 33697, 37135, 42244, 28606, 28352, 89240, 89607]);

const zero = () => [0, 0, 0, 0, 0, 0];
const IDX = Object.fromEntries(SIGNALS.map((s, i) => [s, i]));

/**
 * Adds one ESI-shaped killmail ({victim, attackers, solar_system_id}) to a day's tally.
 * @param {object} day  {systems: {systemId: {side: [k, l, r, s, x, z]}}, kills}
 * @param {(systemId) => boolean} inSpace  only low- and null-sec systems are tallied
 * @returns {boolean} whether it counted
 */
export function addKillmail(day, km, inSpace) {
  const sys = km?.solar_system_id;
  if (!sys || !inSpace(sys)) return false;
  const victim = sideOf(km.victim);
  const attackers = playerSides(km.attackers);
  const npcOnly = attackers.size === 0;
  if (victim) attackers.delete(victim);
  const ship = km.victim?.ship_type_id;
  const structure = STRUCTURE_TYPES.has(ship);
  const at = (day.systems[sys] ||= {});
  if (victim) {
    const v = (at[victim] ||= zero());
    v[IDX.l]++;
    if (npcOnly || MINING_HULLS.has(ship)) v[IDX.r]++;
    if (structure) v[IDX.s]++;
  }
  for (const a of attackers) {
    const c = (at[a] ||= zero());
    c[IDX.k]++;
    if (structure) c[IDX.x]++;
  }
  day.kills = (day.kills || 0) + 1;
  return true;
}

export const newDay = (date) => ({ date, systems: {}, kills: 0 });

/** How much a day counts, `age` days back: halves every HALF_LIFE_DAYS. */
export const decay = (age, halfLife = HALF_LIFE_DAYS) => 0.5 ** (Math.max(0, age) / halfLife);

/**
 * Days of tallies added up with older days counting less.
 * @param {{date: string, systems}[]} days  date as YYYY-MM-DD (UTC)
 * @param {number} now  ms
 * @returns {Map<number, Map<string, number[]>>} systemId → side → decayed [k, l, r, s, x, z]
 */
export function mergeDays(days, now = Date.now(), halfLife = HALF_LIFE_DAYS) {
  const out = new Map();
  for (const d of days) {
    // A day counts from its middle, so today's partial day isn't weighted above yesterday's whole one.
    const age = (now - (Date.parse(`${d.date}T12:00:00Z`))) / 864e5;
    const w = decay(age, halfLife);
    for (const [sys, sides] of Object.entries(d.systems)) {
      const id = Number(sys);
      let m = out.get(id);
      if (!m) out.set(id, m = new Map());
      for (const [side, c] of Object.entries(sides)) {
        let t = m.get(side);
        if (!t) m.set(side, t = zero());
        for (let i = 0; i < 5; i++) t[i] += c[i] * w;
      }
    }
  }
  return out;
}

/**
 * zKillboard's per-system top lists folded in as z: alliances only (its corporation list overlaps them).
 * @param {Map} merged  mergeDays()
 * @param {{[systemId]: {alliances: [allianceId, kills][]}}} zstats
 */
export function addZkillStats(merged, zstats) {
  for (const [sys, z] of Object.entries(zstats || {})) {
    const id = Number(sys);
    let m = merged.get(id);
    for (const [allianceId, kills] of z.alliances || []) {
      if (!(kills > 0)) continue;
      if (!m) merged.set(id, m = new Map());
      const side = `a:${allianceId}`;
      let t = m.get(side);
      if (!t) m.set(side, t = zero());
      t[IDX.z] += kills;
    }
  }
  return merged;
}

export const score = (c) => SIGNALS.reduce((t, s, i) => t + WEIGHTS[s] * (c[i] || 0), 0);

/**
 * The compact form the server sends: per system its strongest sides, with score and counts rounded.
 * @returns {{[systemId]: [side, score, k, l, r, s, x, z][]}}
 */
export function snapshotSystems(merged, top = 5) {
  const out = {};
  const r1 = (v) => Math.round(v * 10) / 10;
  for (const [sys, sides] of merged) {
    const rows = [...sides].map(([side, c]) => [side, r1(score(c)), ...c.map(r1)]).filter(r => r[1] > 0);
    if (!rows.length) continue;
    rows.sort((a, b) => b[1] - a[1]);
    out[sys] = rows.slice(0, top);
  }
  return out;
}

/**
 * Who controls one system: the crawler's sides plus the sov holder's claim (SOV_WEIGHT × ADM).
 * @param {[side, score, ...counts][]|undefined} rows  snapshotSystems() entry
 * @param {{alliance?: number, adm?: number|null}} sov
 * @returns {{side, score, share, total, evidence, confidence, contested, sides: {side, score, counts}[]}|null}
 *   evidence: how much is known (0–1, from the leader's score); confidence: evidence × share
 */
export function controlOf(rows, sov = {}) {
  const sides = (rows || []).map(([side, sc, ...counts]) => ({ side, score: sc, counts }));
  if (sov.alliance) {
    const key = `a:${sov.alliance}`;
    const bonus = SOV_WEIGHT * (sov.adm || 1);
    const s = sides.find(x => x.side === key);
    if (s) s.score += bonus; else sides.push({ side: key, score: bonus, counts: null, sovOnly: true });
  }
  if (!sides.length) return null;
  sides.sort((a, b) => b.score - a.score);
  const total = sides.reduce((t, s) => t + s.score, 0);
  const lead = sides[0];
  const share = total > 0 ? lead.score / total : 0;
  const evidence = Math.min(1, lead.score / CONFIDENT_SCORE);
  return {
    side: lead.side, score: lead.score, share, total, sides, evidence,
    confidence: evidence * share,
    contested: share < 0.5,
  };
}

/** Per side, the systems it controls (not contested), most first. */
export function controlBySide(controls) {
  const by = new Map();
  for (const [sys, c] of controls) {
    if (!c) continue;
    let r = by.get(c.side);
    if (!r) by.set(c.side, r = { side: c.side, held: [], contested: [], score: 0 });
    (c.contested ? r.contested : r.held).push(sys);
    r.score += c.score;
  }
  return [...by.values()].sort((a, b) => b.held.length - a.held.length || b.score - a.score);
}
