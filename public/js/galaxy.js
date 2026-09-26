// Pure gate-graph helpers over public/data/universe.json — no DOM, no fetch.
// Jump counts are computed locally with BFS, so any station-to-station pair can be priced
// without an ESI /route call per pair.

// A system counts as high-sec when its security rounds to 0.5 or more.
export const isHighSec = (sec) => sec >= 0.45;

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
 * @param {'secure'|'shortest'} flag  secure only walks through (and ends in) high-sec systems
 */
export function jumpsFrom(g, systemId, flag = 'shortest') {
  const key = `${systemId}:${flag}`;
  if (g.cache.has(key)) return g.cache.get(key);
  const dist = new Int16Array(g.n).fill(-1);
  const from = g.indexOf.get(systemId);
  if (from != null && (flag !== 'secure' || isHighSec(g.sec[from]))) {
    const q = new Uint32Array(g.n);
    let head = 0, tail = 0;
    q[tail++] = from; dist[from] = 0;
    while (head < tail) {
      const v = q[head++];
      for (let k = g.start[v]; k < g.start[v + 1]; k++) {
        const w = g.adj[k];
        if (dist[w] !== -1 || (flag === 'secure' && !isHighSec(g.sec[w]))) continue;
        dist[w] = dist[v] + 1;
        q[tail++] = w;
      }
    }
  }
  if (g.cache.size > 4000) g.cache.delete(g.cache.keys().next().value);
  g.cache.set(key, dist);
  return dist;
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
