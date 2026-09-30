// Home page: the list of tools, your character, EVE time, and how fresh each market scan is.
import { createMe } from './me.js';
import { scanClient } from './scan-client.js';
import { buildGraph, systemInfo } from './galaxy.js';
import { formatIsk } from './arbitrage.js';
import { eveTime, describeScan } from './home-status.js';

let graph = null;
const me = createMe({
  el: document.getElementById('me'), returnTo: location.pathname, isk: formatIsk, onFollow: () => {}, line: 'ship',
  systemName: (id) => (graph ? systemInfo(graph, id)?.name : null) || `System ${id}`,
});
fetch('data/universe.json').then(r => r.json()).then(u => { graph = buildGraph(u); me.reapply(); }).catch(() => {});

const clock = document.getElementById('eveTime');
const tick = () => { const now = new Date(); clock.textContent = eveTime(now); clock.dateTime = now.toISOString(); };
tick();
setInterval(tick, 1000);

async function showScan(kind) {
  let st = null;
  try { st = await scanClient(kind).status(); } catch { /* shown as unavailable */ }
  const d = describeScan(st);
  const chip = document.querySelector(`[data-scan="${kind}"]`);
  chip.dataset.state = d.state;
  chip.querySelector('small').textContent = d.chip;
  for (const el of document.querySelectorAll(`[data-live="${kind}"]`)) {
    el.dataset.state = d.state;
    el.textContent = d.row;
  }
}
for (const kind of ['scan', 'uscan', 'cscan']) showScan(kind);
