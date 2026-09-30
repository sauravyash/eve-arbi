// Chooses between the flat star map (map.js) and the in-game style 3D one (map3d.js), which needs WebGL and three.js
// (vendored, public/vendor/three). Both get every data update, so switching layouts is instant; if 3D can't start, the
// flat map stays.

// three.js r170 (MIT), served from this origin rather than a CDN; relative to this module.
export const THREE_URL = new URL('../vendor/three/three.module.min.js', import.meta.url).href;
export const loadThree = () => import(THREE_URL);

// Settings saved before the 3D map: '3d' (the old default, now "Top-down") becomes the new default, once (mapV).
export function migrateMapLayout(stored) {
  if (stored.mapV) return stored;
  const { mapLayout, ...rest } = stored;
  return mapLayout && mapLayout !== '3d' ? { ...rest, mapLayout, mapV: 1 } : { ...rest, mapV: 1 };
}

export function createMapSwitch({ flat, create3d, flatEl, spaceEls, onUnavailable, timeoutMs = 15000 }) {
  const state = { universe: null, model: null, trip: null, secColors: true };
  let space = null, loading = null, layout = null;

  const active = () => (layout === 'space' && space ? space : flat);
  const show = (isSpace) => {
    flatEl.hidden = isSpace;
    for (const el of spaceEls) el.hidden = !isSpace;
  };
  // A CDN that hangs counts as unavailable too.
  const withTimeout = (p) => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out loading the 3D map')), timeoutMs); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };
  const start3d = () => (loading ??= withTimeout(create3d()).then((m) => {
    try {
      m.setSecurityColors(state.secColors);
      if (state.universe) m.setUniverse(state.universe);
      if (state.model) m.update(state.model);
      if (state.trip) m.setTrip(state.trip);
    } catch (err) { m.dispose?.(); throw err; } // don't leave a half-built map holding a WebGL context
    space = m;
    return m;
  }).catch((err) => { onUnavailable?.(err); return null; }));

  return {
    async setLayout(next) {
      layout = next;
      if (next !== 'space') { show(false); flat.setLayout(next); return next; }
      const m = await start3d();
      if (layout !== 'space') return layout; // changed while three.js loaded
      if (!m) { layout = '3d'; show(false); flat.setLayout('3d'); return '3d'; }
      show(true);
      return 'space';
    },
    setUniverse(u) { state.universe = u; flat.setUniverse(u); space?.setUniverse(u); },
    update(model) { state.model = model; flat.update(model); space?.update(model); },
    setTrip(trip) { state.trip = trip; flat.setTrip(trip); space?.setTrip(trip); },
    setSecurityColors(on) { state.secColors = on; flat.setSecurityColors(on); space?.setSecurityColors(on); },
    zoomBy: (factor) => active().zoomBy(factor),
    fitHubs: () => active().fitHubs(),
    fitAll: () => active().fitAll(),
    fitPath: (ids) => active().fitPath(ids),
  };
}
