// Control crawler: who holds each low- and null-sec system in practice, for the Warfare page's
// control map (GET /api/control). Three community sources, tallied with public/js/control.js:
//
//   EVE Ref daily killmail archives (data.everef.net/killmails/YYYY/killmails-YYYY-MM-DD.tar.bz2):
//     every killmail of a finished day, ~2 MB each. The last CONTROL_DAYS days (default 7) are fetched
//     once, tallied in a worker thread (control-worker.js) and kept in .cache/control/days/.
//   zKillboard R2Z2 (r2z2.zkillboard.com/ephemeral/{sequence}.json): killmails as they happen, one
//     file each, for the hours since the last archive. Replaced by the archive once that day is out.
//   zKillboard stats (zkillboard.com/api/stats/solarSystemID/{id}/): each system's top alliances on
//     zKillboard, refreshed every 12 hours, busiest systems first, at most one call a second.
//
// It only works while someone is looking: each request to /api/control keeps it going for
// ACTIVE_MS (CONTROL_ALWAYS=1 keeps it running, for a hosted scan server). Archives are checked
// hourly; EVE Ref publishes a day some hours after it ends, so the newest hours come from R2Z2 alone.

import { Worker } from 'node:worker_threads';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { addKillmail, newDay, mergeDays, addZkillStats, snapshotSystems, HALF_LIFE_DAYS } from './public/js/control.js';

const DAY_MS = 864e5;
const ACTIVE_MS = 30 * 60_000;
const ARCHIVE_RETRY_MS = 60 * 60_000;     // a day EVE Ref hasn't published yet is asked about again after this
const STATS_MAX_AGE = 12 * 3600_000;      // zKillboard top lists are refreshed this often per system
const STATS_KEEP = 2 * DAY_MS;            // and stop counting when older than this
const LIVE_IDLE_MS = 6_000;               // R2Z2 is polled this often once caught up
const SAVE_AFTER_MS = 30_000;             // state is saved this long after it first changes
const SNAPSHOT_TTL = 60_000;
const EVEREF = 'https://data.everef.net/killmails/';
const R2Z2 = 'https://r2z2.zkillboard.com/ephemeral/';
const ZKILL_STATS = 'https://zkillboard.com/api/stats/solarSystemID/';

export const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());

/**
 * @param {object} o
 * @param {(upstream: string, url: string) => Promise<{status, body: Buffer}>} o.fetchUpstream  server.js's gated fetch
 * @param {(name: string) => Promise<object>} o.data  public/data loader (universe.json)
 * @param {string} o.dir  where to keep state (.cache/control)
 */
export function createControlCrawler({ fetchUpstream, data, dir, days: windowDays = 7, always = false, log = console.log, now = Date.now }) {
  const DAYS_DIR = path.join(dir, 'days');
  const STATE_FILE = path.join(dir, 'state.json.gz');
  const archives = new Map();   // date → day tally (complete days from EVE Ref)
  const live = new Map();       // date → {day, ids: Set} from R2Z2, for days without an archive yet
  const missing = new Map();    // date → when EVE Ref last answered 404
  const zstats = {};            // systemId → {at, alliances: [[allianceId, kills]]}
  const names = {};             // allianceId → [name, ticker], from zKillboard's top lists
  const st = {
    seq: null, liveAt: 0, liveKills: 0, liveError: null, archiveError: null, statsError: null, statsAt: 0,
    archiving: null, lastSeen: 0, loops: 0,
  };
  let space = null, spaceList = null, ready = null, dirty = false, saveTimer = null, snap = null, snapAt = 0;

  const active = () => always || now() - st.lastSeen < ACTIVE_MS;
  const changed = () => { snap = null; markDirty(); };
  function markDirty() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save().catch(e => log(`[control] not saved: ${e.message}`));
    }, SAVE_AFTER_MS);
    saveTimer.unref?.();
  }

  async function init() {
    const u = await data('universe');
    spaceList = u.systems.id.filter((id, i) => u.systems.sec[i] < 0.45);
    space = new Set(spaceList);
    await mkdir(DAYS_DIR, { recursive: true });
    for (const f of await readdir(DAYS_DIR)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json\.gz$/);
      if (!m) continue;
      try { archives.set(m[1], JSON.parse(gunzipSync(await readFile(path.join(DAYS_DIR, f))))); } catch { /* re-fetched */ }
    }
    try {
      const s = JSON.parse(gunzipSync(await readFile(STATE_FILE)));
      st.seq = s.seq ?? null;
      for (const [date, l] of Object.entries(s.live || {})) live.set(date, { day: l.day, ids: new Set(l.ids) });
      Object.assign(zstats, s.zstats || {});
      Object.assign(names, s.names || {});
    } catch { /* first start */ }
    prune();
  }

  const stateBytes = () => {
    const liveOut = Object.fromEntries([...live].map(([d, l]) => [d, { day: l.day, ids: [...l.ids] }]));
    return gzipSync(JSON.stringify({ seq: st.seq, live: liveOut, zstats, names }));
  };
  async function save() { dirty = false; await writeFile(STATE_FILE, stateBytes()); }
  /** For shutdown: writes unsaved state now. */
  function saveSync() { if (dirty && space) { dirty = false; writeFileSync(STATE_FILE, stateBytes()); } }

  const inWindow = (date) => Date.parse(`${date}T00:00:00Z`) >= Date.parse(`${utcDate(now() - windowDays * DAY_MS)}T00:00:00Z`);

  function prune() {
    for (const date of [...archives.keys()]) if (!inWindow(date)) { archives.delete(date); unlink(path.join(DAYS_DIR, `${date}.json.gz`)).catch(() => {}); }
    for (const date of [...live.keys()]) if (!inWindow(date) || archives.has(date)) live.delete(date);
    const cutoff = now() - STATS_KEEP * 3;
    for (const [id, z] of Object.entries(zstats)) if (z.at < cutoff) delete zstats[id];
  }

  // --- EVE Ref archives ------------------------------------------------------
  function tally(bytes, date) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./control-worker.js', import.meta.url), { workerData: { bytes, date, space: spaceList } });
      w.once('message', resolve);
      w.once('error', reject);
      w.once('exit', (code) => { if (code) reject(new Error(`worker exited with ${code}`)); });
    });
  }

  async function syncArchives() {
    for (let back = 1; back <= windowDays; back++) {
      const date = utcDate(now() - back * DAY_MS);
      if (archives.has(date) || now() - (missing.get(date) || 0) < ARCHIVE_RETRY_MS) continue;
      st.archiving = date;
      try {
        const r = await fetchUpstream('everef', `${EVEREF}${date.slice(0, 4)}/killmails-${date}.tar.bz2`);
        if (r.status === 404) { missing.set(date, now()); continue; }
        if (r.status !== 200) throw new Error(`EVE Ref HTTP ${r.status}`);
        const t0 = now();
        const day = await tally(new Uint8Array(r.body), date);
        archives.set(date, { date, systems: day.systems, kills: day.kills, files: day.files });
        live.delete(date);
        await writeFile(path.join(DAYS_DIR, `${date}.json.gz`), gzipSync(JSON.stringify(archives.get(date))));
        log(`[control] ${date}: ${day.kills} of ${day.files} killmails in low/null-sec (${((now() - t0) / 1000).toFixed(1)} s)`);
        st.archiveError = null;
        changed();
      } catch (e) { st.archiveError = `${date}: ${e.message}`; missing.set(date, now()); }
    }
    st.archiving = null;
    prune();
  }

  // --- R2Z2 live feed ----------------------------------------------------------
  async function getJson(upstream, url) {
    const r = await fetchUpstream(upstream, url);
    return { status: r.status, json: r.status === 200 ? JSON.parse(r.body) : null };
  }

  function addLive(item) {
    const km = item?.esi;
    if (!km?.killmail_time || !item.killmail_id) return;
    const date = km.killmail_time.slice(0, 10);
    if (archives.has(date) || !inWindow(date)) return;
    let l = live.get(date);
    if (!l) live.set(date, l = { day: newDay(date), ids: new Set() });
    if (l.ids.has(item.killmail_id)) return;
    l.ids.add(item.killmail_id);
    if (addKillmail(l.day, km, (id) => space.has(id))) { st.liveKills++; changed(); }
    else markDirty();
  }

  async function liveLoop() {
    while (active()) {
      try {
        if (st.seq == null) {
          const s = await getJson('r2z2', `${R2Z2}sequence.json`);
          if (!s.json?.sequence) throw new Error(`sequence HTTP ${s.status}`);
          st.seq = s.json.sequence;
        }
        const r = await getJson('r2z2', `${R2Z2}${st.seq}.json`);
        if (r.status === 200) { addLive(r.json); st.seq++; st.liveAt = now(); st.liveError = null; continue; }
        if (r.status !== 404) throw new Error(`HTTP ${r.status}`);
        // Not there: either not written yet, or long gone (we were away). Skip ahead in the second case.
        const s = await getJson('r2z2', `${R2Z2}sequence.json`);
        const latest = s.json?.sequence;
        if (latest != null && latest > st.seq + 1000) st.seq = latest;
        else if (latest != null && latest > st.seq) st.seq++;
        else await sleep(LIVE_IDLE_MS);
      } catch (e) { st.liveError = e.message; await sleep(30_000); }
    }
  }

  // --- zKillboard per-system top lists ---------------------------------------
  function nextStatsSystem() {
    const cutoff = now() - STATS_MAX_AGE;
    // Busiest systems first (by killmails in the window), then the rest of low/null-sec.
    const activity = new Map();
    for (const d of [...archives.values(), ...[...live.values()].map(l => l.day)]) {
      for (const [sys, sides] of Object.entries(d.systems)) {
        let n = activity.get(sys) || 0;
        for (const c of Object.values(sides)) n += c[0] + c[1];
        activity.set(sys, n);
      }
    }
    let best = null, bestN = -1;
    for (const id of spaceList) {
      if ((zstats[id]?.at || 0) > cutoff) continue;
      const n = activity.get(String(id)) || 0;
      if (n > bestN) { best = id; bestN = n; }
    }
    return best;
  }

  async function statsLoop() {
    while (active()) {
      const id = nextStatsSystem();
      if (id == null) { await sleep(10 * 60_000); continue; }
      try {
        const r = await getJson('zkill', `${ZKILL_STATS}${id}/`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const list = (r.json?.topLists || []).find(t => t.type === 'alliance')?.values || [];
        zstats[id] = { at: now(), alliances: list.filter(v => v.allianceID).map(v => [v.allianceID, v.kills || 0]) };
        for (const v of list) if (v.allianceID) names[v.allianceID] = [v.allianceName, v.aticker];
        st.statsAt = now(); st.statsError = null;
        changed();
      } catch (e) {
        st.statsError = e.message;
        zstats[id] = { at: now() - STATS_MAX_AGE + 3600_000, alliances: zstats[id]?.alliances || [] };   // retry in an hour
        await sleep(30_000);
      }
    }
  }

  // --- running -----------------------------------------------------------------
  async function run() {
    st.loops++;
    try {
      await Promise.all([
        liveLoop(),
        statsLoop(),
        (async () => { while (active()) { await syncArchives(); await sleep(ARCHIVE_RETRY_MS / 4); } })(),
      ]);
    } finally { st.loops--; }
  }

  /** Marks the control map as being looked at, starting the crawl if it had stopped. */
  async function touch() {
    st.lastSeen = now();
    ready ||= init().catch(e => { ready = null; throw e; });
    await ready;
    if (!st.loops) run().catch(e => log(`[control] stopped: ${e.message}`));
  }

  function status() {
    const crawled = Object.values(zstats).filter(z => z.at > now() - STATS_MAX_AGE).length;
    return {
      windowDays, halfLifeDays: HALF_LIFE_DAYS,
      days: [...archives.values()].map(d => ({ date: d.date, kills: d.kills, source: 'archive' }))
        .concat([...live].filter(([d]) => !archives.has(d)).map(([date, l]) => ({ date, kills: l.day.kills, source: 'live' })))
        .sort((a, b) => b.date.localeCompare(a.date)),
      archiving: st.archiving, archiveError: st.archiveError,
      live: { seq: st.seq, at: st.liveAt || null, kills: st.liveKills, error: st.liveError },
      zkill: { crawled, total: spaceList?.length || 0, at: st.statsAt || null, error: st.statsError },
    };
  }

  /** The control map: per low/null-sec system its strongest sides (control.js snapshotSystems). */
  async function snapshot() {
    await touch();
    return build();
  }

  function build() {
    if (snap && now() - snapAt < SNAPSHOT_TTL) return snap;
    const days = [...archives.values(), ...[...live].filter(([d]) => !archives.has(d) && inWindow(d)).map(([, l]) => l.day)];
    const merged = mergeDays(days, now());
    const fresh = Object.fromEntries(Object.entries(zstats).filter(([, z]) => z.at > now() - STATS_KEEP));
    addZkillStats(merged, fresh);
    const systems = snapshotSystems(merged);
    const used = new Set();
    for (const rows of Object.values(systems)) for (const r of rows) if (r[0].startsWith('a:')) used.add(r[0].slice(2));
    snap = {
      builtAt: now(), ...status(), systems,
      names: Object.fromEntries(Object.entries(names).filter(([id]) => used.has(id))),
    };
    snapAt = now();
    return snap;
  }

  // build, addLive and syncArchives are for tests: they skip the crawl loops.
  return { touch, snapshot, status, build, addLive, syncArchives, saveSync, init: () => (ready ||= init()) };
}
