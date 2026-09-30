// Home page: the list of tools, your character, and how fresh each market scan is.
import { createMe } from './me.js';
import { scanClient } from './scan-client.js';
import { buildGraph, systemInfo } from './galaxy.js';
import { formatIsk } from './arbitrage.js';

let graph = null;
const me = createMe({
  el: document.getElementById('me'), returnTo: location.pathname, isk: formatIsk, onFollow: () => {},
  systemName: (id) => (graph ? systemInfo(graph, id)?.name : null) || `System ${id}`,
});
fetch('data/universe.json').then(r => r.json()).then(u => { graph = buildGraph(u); me.reapply(); }).catch(() => {});

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// state: fresh (ESI hasn't published newer data), old, running, none (never scanned), error.
function describe(st) {
  if (!st) return { state: 'error', text: 'unavailable' };
  if (st.state === 'running' || st.state === 'computing') return { state: 'running', text: 'scanning now…' };
  const r = st.result;
  if (!r?.finishedAt) return { state: 'none', text: st.state === 'error' ? 'last scan failed' : 'not scanned yet' };
  return { state: r.expiresAt > Date.now() ? 'fresh' : 'old', text: `scanned ${ago(r.finishedAt)}` };
}

async function showScan(kind) {
  let st = null;
  try { st = await scanClient(kind).status(); } catch { /* shown as unavailable */ }
  const d = describe(st);
  const chip = document.querySelector(`[data-scan="${kind}"]`);
  chip.dataset.state = d.state;
  chip.querySelector('small').textContent = d.text;
  for (const el of document.querySelectorAll(`[data-live="${kind}"]`)) {
    el.dataset.state = d.state;
    el.textContent = { none: 'Needs a scan', error: '' }[d.state] ?? `Scan: ${d.text}`;
  }
}
for (const kind of ['scan', 'uscan', 'cscan']) showScan(kind);
