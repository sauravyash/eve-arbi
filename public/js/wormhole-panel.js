// The "Wormhole shortcuts" panel (route-planner.html#wormholes): every shortcut shortcuts.js knows,
// its sources (your jumps, EVE Scout, Wanderer, pasted bookmarks, ones added by hand) and a switch per connection.
// The settings are shared with every page; each page's Wormholes switch links here.

import { whSummary } from './wormholes.js';
import { SOURCE_LABEL } from './shortcuts.js';

const HOUR = 3_600_000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function left(ms) {
  if (!ms) return '—';
  const d = ms - Date.now();
  if (d <= 0) return 'expired';
  return d >= HOUR ? `${Math.floor(d / HOUR)}h ${Math.floor((d % HOUR) / 60_000)}m` : `${Math.ceil(d / 60_000)}m`;
}

/**
 * Wires the panel's inputs to `sc` (createShortcuts). `secTag(id)` gives a system's security badge,
 * `signedIn()` whether a character is signed in (for the empty-table hint).
 * @returns {() => void} render: call it from the shortcuts' onChange.
 */
export function mountWormholePanel(sc, { secTag = () => '', signedIn = () => false } = {}) {
  const $ = (id) => document.getElementById(id);
  const w0 = sc.settings;
  $('whOn').checked = w0.on;
  $('whTrail').checked = w0.trail;
  $('whScout').checked = w0.scout;
  $('whHours').value = w0.hours;
  $('whWanderer').checked = w0.wanderer.on;
  $('whWUrl').value = w0.wanderer.url;
  $('whWMap').value = w0.wanderer.map;
  $('whWToken').value = w0.wanderer.token;
  $('whOn').addEventListener('change', () => sc.update({ on: $('whOn').checked }));
  $('whTrail').addEventListener('change', () => sc.update({ trail: $('whTrail').checked }));
  $('whScout').addEventListener('change', () => sc.update({ scout: $('whScout').checked }));
  $('whHours').addEventListener('input', () => {
    const h = Number($('whHours').value);
    if (h >= 1 && h <= 48) sc.update({ hours: h });
  });
  const wanderer = () => sc.update({ wanderer: {
    on: $('whWanderer').checked, url: $('whWUrl').value.trim(), map: $('whWMap').value.trim(), token: $('whWToken').value.trim(),
  } });
  for (const id of ['whWanderer', 'whWUrl', 'whWMap', 'whWToken']) $(id).addEventListener('change', wanderer);
  $('whAdd').addEventListener('click', async () => {
    const [a, b] = await Promise.all([sc.systemByName($('whFrom').value), sc.systemByName($('whTo').value)].map(p => p.catch(() => null)));
    const type = $('whType').value.trim(), typeOk = !type || !!sc.whInfo(type);
    $('whFrom').classList.toggle('bad', !a);
    $('whTo').classList.toggle('bad', !b);
    $('whType').classList.toggle('bad', !typeOk);
    if (!a || !b || a === b || !typeOk) return;
    sc.addManual(a, b, type);
    $('whFrom').value = ''; $('whTo').value = ''; $('whType').value = '';
  });
  $('whBmAdd').addEventListener('click', async () => {
    const text = $('whBmText').value;
    if (!text.trim()) return;
    $('whBmMsg').textContent = 'Looking up systems…';
    try {
      const r = await sc.importBookmarks(text);
      if (!r.rows) { $('whBmMsg').textContent = 'No bookmarks found: paste rows copied from the Locations window (they are tab-separated).'; return; }
      const s = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      $('whBmMsg').textContent = `${s(r.rows, 'bookmark')} read: ${s(r.added, 'new shortcut')}${r.updated ? `, ${r.updated} updated` : ''}`
        + `${r.expired ? `, ${r.expired} already expired` : ''}${r.noDest ? `, ${r.noDest} with no system to go to (safes, "> LOWSEC", …)` : ''}`
        + `${r.unknown.length ? `; systems not found: ${r.unknown.join(', ')}` : ''}.`;
      $('whBmText').value = '';
    } catch (e) { $('whBmMsg').textContent = `Couldn't look up the systems: ${e.message}`; }
  });
  $('whBmClear').addEventListener('click', () => {
    const n = sc.bookmarkCount();
    if (n && confirm(`Forget all ${n} shortcuts from pasted bookmarks?`)) sc.removeBookmark(null);
  });
  $('whBody').addEventListener('change', (e) => {
    const key = e.target.dataset.use;
    if (key) sc.setUse(key, e.target.checked, Number(e.target.dataset.at));
  });
  $('whBody').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]')?.dataset;
    if (del?.del) (del.src === 'bookmark' ? sc.removeBookmark : sc.removeManual)(del.del);
  });

  return function render() {
    const w = sc.settings, links = sc.links();
    sc.resolveNames(links.flatMap(l => [l.a, l.b]));
    // Another control on the page (or another tab) may have changed these.
    $('whOn').checked = w.on;
    $('whScout').checked = w.scout;
    const used = links.filter(l => l.use).length;
    const bm = sc.bookmarkCount();
    $('whBmCount').textContent = bm ? `· ${bm} live` : '';
    $('whCount').textContent = !w.on ? '· off' : links.length ? `· ${used} in use on every page` : '';
    const feed = (name, label) => {
      const f = sc.feeds[name];
      return f.error ? `${label}: ${f.error}` : f.loading && !f.at ? `${label}: loading…` : f.at ? `${label}: ${f.links.length} connection${f.links.length === 1 ? '' : 's'}, ${ago(f.at)}` : '';
    };
    $('whFeeds').textContent = [w.scout && feed('evescout', 'EVE Scout'), w.wanderer.on && feed('wanderer', 'Wanderer')].filter(Boolean).join(' · ');
    $('whFeeds').classList.toggle('warn', !!((w.scout && sc.feeds.evescout.error) || (w.wanderer.on && sc.feeds.wanderer.error)));
    $('whBody').innerHTML = links.map(l => {
      const expires = l.expiresAt || (l.src === 'trail' ? l.at + w.hours * HOUR : null);
      const info = sc.whInfo(l.type);
      const what = l.kind === 'jump' ? '<span class="badge stale" title="No stargate joins these systems: a wormhole, a jump bridge or a cyno. Untick it if you can\'t fly it again.">no gate</span>' : '';
      return `<tr class="static${l.use && (w.on || l.src === 'bridge') ? '' : ' off'}">
        <td class="l">${esc(sc.sysName(l.a))} ${secTag(l.a)} ↔ ${esc(sc.sysName(l.b))} ${secTag(l.b)}${what}</td>
        <td class="l"${l.by ? ` title="Bookmarked by ${esc(l.by)}"` : ''}>${SOURCE_LABEL[l.src] || l.src}${l.note ? ` <small class="muted"${info ? ` title="${esc(whSummary(info))} (ellatha.com wormhole database)"` : ''}>${esc(l.note)}</small>` : ''}</td>
        <td>${ago(l.at)}</td>
        <td>${l.src === 'wanderer' ? '<span class="muted" title="Wanderer drops a connection when it collapses">mapped</span>' : l.src === 'bridge' ? '<span class="muted">permanent</span>' : left(expires)}</td>
        <td><input type="checkbox" data-use="${l.key}" data-at="${l.at}"${l.use ? ' checked' : ''} aria-label="Use this connection"></td>
        <td>${l.src === 'manual' || l.src === 'bookmark' ? `<button class="btn small ghost" type="button" data-del="${l.key}" data-src="${l.src}">Remove</button>`
          : l.src === 'bridge' ? '<a class="muted" href="#bridges" title="Jump bridges are managed in the Jump bridges panel">Manage</a>' : ''}</td>
      </tr>`;
    }).join('') || `<tr class="empty"><td colspan="6" class="l muted">${!w.trail ? 'No shortcuts.'
      : signedIn() ? 'No wormhole jumps recorded yet. Keep this app open (any page) while you fly and they\'ll show up here.'
        : 'Sign in with EVE to record your wormhole jumps, or use one of the sources above.'}</td></tr>`;
  };
}
