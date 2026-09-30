// Pure gate-graph helpers over public/data/universe.json — no DOM, no fetch.
// Jump counts are computed locally with BFS, so any station-to-station pair can be priced
// without an ESI /route call per pair.

// A system counts as high-sec when its security rounds to 0.5 or more.
export const isHighSec = (sec) => sec >= 0.45;
// Null-sec: security 0.0 or below (anything above 0.0 shows as at least 0.1 in game).
export const isNullSec = (sec) => sec <= 0;

// Which systems a route flag may fly through: 'secure' high-sec only, 'nonull' high- and
// low-sec, anything else every system.
const allowedBy = (flag) => (flag === 'secure' ? isHighSec : flag === 'nonull' ? (sec) => !isNullSec(sec) : null);

export function buildGraph(u) {
  const s = u.systems, n = s.id.length;
  const deg = new Uint32Array(n);
  for (let k = 0; k < u.jumps.length; k += 2) { deg[u.jumps[k]]++; deg[u.jumps[k + 1]]++; }
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const adj = new Uint32Array(start[n]), fill = start.slice(0, n);
  for (let k = 0; k < u.jumps.length; k += 2) {
    const a = u.jumps[k], b = u.jumps[k + 1];
    adj[fill[a]++] = b; adj[fill[b]++] = a;
  }
  const regionName = new Map(u.regions.map(r => [r.id, r.name]));
  return {
    n, start, adj, id: s.id, name: s.name, sec: s.sec,
    regionId: s.region.map(i => u.regions[i]?.id), regionName,
    indexOf: new Map(s.id.map((id, i) => [id, i])),
    cache: new Map(),
  };
}

/**
 * Jumps from one system to every other, as an Int16Array indexed like `g.id` (-1 = unreachable).
 * @param {'secure'|'nonull'|'shortest'} flag  secure only walks through (and ends in) high-sec
 *   systems, nonull through high- and low-sec (never null-sec). From outside the allowed space it
 *   first leaves by the fewest jumps to the nearest allowed systems, like the in-game "prefer safer"
 *   autopilot; only the systems on those ways out get a count.
 */
export function jumpsFrom(g, systemId, flag = 'shortest') {
  const key = `${systemId}:${flag}`;
  if (g.cache.has(key)) return g.cache.get(key);
  const dist = new Int16Array(g.n).fill(-1);
  const from = g.indexOf.get(systemId);
  if (from != null) {
    const ok = allowedBy(flag);
    const q = new Uint32Array(g.n);
    let head = 0, tail = 0;
    if (ok && !ok(g.sec[from])) {
      tail = leaveTo(g, from, dist, q, ok);
    } else {
      q[tail++] = from; dist[from] = 0;
    }
    while (head < tail) {
      const v = q[head++];
      for (let k = g.start[v]; k < g.start[v + 1]; k++) {
        const w = g.adj[k];
        if (dist[w] !== -1 || (ok && !ok(g.sec[w]))) continue;
        dist[w] = dist[v] + 1;
        q[tail++] = w;
      }
    }
  }
  if (g.cache.size > 4000) g.cache.delete(g.cache.keys().next().value);
  g.cache.set(key, dist);
  return dist;
}

// Restricted routing from outside the allowed space (`ok`, e.g. high-sec): BFS through the other
// systems to the nearest allowed ones (all at the same, smallest distance). Fills `dist` for the
// start, those systems and the others on a shortest way to them (so pathBetween can walk back),
// and queues the allowed ones in `q`. Returns the queue length.
function leaveTo(g, from, dist, q, ok) {
  const seen = new Int16Array(g.n).fill(-1);
  const order = [from];
  seen[from] = 0;
  let exit = -1;
  for (let h = 0; h < order.length; h++) {
    const v = order[h];
    if (exit >= 0 && seen[v] >= exit) break; // every way into the ring at `exit` has been seen
    for (let k = g.start[v]; k < g.start[v + 1]; k++) {
      const w = g.adj[k];
      if (seen[w] !== -1) continue;
      seen[w] = seen[v] + 1;
      if (ok(g.sec[w])) { if (exit < 0) exit = seen[w]; } else order.push(w);
    }
  }
  dist[from] = 0;
  if (exit < 0) return 0;
  let tail = 0;
  for (let i = 0; i < g.n; i++) if (seen[i] === exit && ok(g.sec[i])) { dist[i] = exit; q[tail++] = i; }
  // Keep the other systems that lead to that ring, farthest first.
  for (let h = order.length - 1; h > 0; h--) {
    const v = order[h];
    for (let k = g.start[v]; k < g.start[v + 1]; k++) {
      if (dist[g.adj[k]] === seen[v] + 1 && seen[g.adj[k]] === seen[v] + 1) { dist[v] = seen[v]; break; }
    }
  }
  return tail;
}

// Jumps between two systems, or null when unreachable (or unknown, e.g. wormhole space).
export function jumpsBetween(g, a, b, flag = 'shortest') {
  const i = g.indexOf.get(b);
  if (i == null) return null;
  const d = jumpsFrom(g, a, flag)[i];
  return d < 0 ? null : d;
}

// Gate-by-gate system IDs from a to b (inclusive), or null when unreachable.
export function pathBetween(g, a, b, flag = 'shortest') {
  const ia = g.indexOf.get(a), ib = g.indexOf.get(b);
  if (ia == null || ib == null) return null;
  const d = jumpsFrom(g, a, flag);
  if (d[ib] < 0) return null;
  const path = [ib];
  // Walk back from b: each step goes to a neighbour one jump closer to a.
  for (let i = ib; d[i] > 0;) {
    let next = -1;
    for (let k = g.start[i]; k < g.start[i + 1]; k++) if (d[g.adj[k]] === d[i] - 1) { next = g.adj[k]; break; }
    if (next < 0) return null;
    path.push(i = next);
  }
  return path.reverse().map(i => g.id[i]);
}

export function systemInfo(g, systemId) {
  const i = g.indexOf.get(systemId);
  if (i == null) return null;
  return { id: systemId, name: g.name[i], sec: g.sec[i], regionId: g.regionId[i], region: g.regionName.get(g.regionId[i]) };
}
