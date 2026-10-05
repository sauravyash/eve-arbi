// Contracts › Corp buyback page: the buyback calculator and contract window (buyback-calc.js),
// with the section bar and EVE login.

import { formatIsk } from './arbitrage.js';
import { buildGraph } from './galaxy.js';
import { createShortcuts } from './shortcuts.js';
import { createMe } from './me.js';
import { mountSectionNav } from './nav.js';
import { createBuyback } from './buyback-calc.js';

let types = null, stations = null, typeByName = null, meCtl = null, bb = null;
const sc = createShortcuts({ onChange: () => bb?.render() });
const sysName = (id) => sc.sysName(id);
const isk = (v) => formatIsk(v);

function init() {
  mountSectionNav();
  meCtl = createMe({
    el: document.getElementById('me'), returnTo: location.pathname, systemName: sysName, isk,
    shipInfo: (id) => (types?.[id] ? { name: types[id][0], cargo: types[id][2] === 6 ? types[id][3] ?? null : null } : null),
    onFollow: () => {}, onStatus: () => bb?.statusChanged(),
  });
  bb = createBuyback({ types: () => types, typeByName: () => typeByName, stations: () => stations, sysName, me: () => meCtl });

  fetch('data/universe.json').then(r => r.json()).then(u => { sc.setBase(buildGraph(u)); meCtl.reapply(); bb.render(); }).catch(() => {});
  fetch('data/stations.json').then(r => (r.ok ? r.json() : {})).then(s => { stations = s; bb.render(); }).catch(() => {});
  fetch('data/types.json').then(r => r.json()).then(t => {
    types = t;
    typeByName = new Map(Object.entries(t).map(([id, v]) => [v[0].toLowerCase(), Number(id)]));
    meCtl.reapply(); bb.typesLoaded();
  }).catch(() => {});
}

init();
