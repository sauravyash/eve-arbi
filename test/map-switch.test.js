import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapSwitch, migrateMapLayout } from '../public/js/map-switch.js';

function stubMap() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    setUniverse: rec('setUniverse'), update: rec('update'), setTrip: rec('setTrip'),
    setSecurityColors: rec('setSecurityColors'), setLayout: rec('setLayout'), zoomBy: rec('zoomBy'),
    fitHubs: rec('fitHubs'), fitAll: rec('fitAll'), fitPath: rec('fitPath'),
  };
}
const els = () => ({ flatEl: { hidden: false }, spaceEls: [{ hidden: true }, { hidden: true }] });

test('switching to space loads 3D once and replays current state into it', async () => {
  const flat = stubMap(), space = stubMap(), e = els();
  let created = 0;
  const map = createMapSwitch({ flat, create3d: async () => { created++; return space; }, ...e });
  map.setUniverse('U'); map.update('M'); map.setTrip('T'); map.setSecurityColors(false);
  assert.equal(await map.setLayout('space'), 'space');
  assert.deepEqual(space.calls, [['setSecurityColors', false], ['setUniverse', 'U'], ['update', 'M'], ['setTrip', 'T']]);
  assert.equal(e.flatEl.hidden, true);
  assert.ok(e.spaceEls.every((el) => !el.hidden));
  await map.setLayout('2d');
  await map.setLayout('space');
  assert.equal(created, 1);
});

test('both maps get data; view commands go to the active one', async () => {
  const flat = stubMap(), space = stubMap();
  const map = createMapSwitch({ flat, create3d: async () => space, ...els() });
  await map.setLayout('space');
  space.calls.length = 0;
  map.update('M2');
  map.zoomBy(2); map.fitPath([1, 2]); map.fitHubs(); map.fitAll();
  assert.deepEqual(space.calls, [['update', 'M2'], ['zoomBy', 2], ['fitPath', [1, 2]], ['fitHubs'], ['fitAll']]);
  assert.ok(flat.calls.some(([n, v]) => n === 'update' && v === 'M2'));
  assert.ok(!flat.calls.some(([n]) => n === 'zoomBy'));
  await map.setLayout('2d');
  map.zoomBy(3);
  assert.deepEqual(flat.calls.filter(([n]) => n === 'setLayout' || n === 'zoomBy'), [['setLayout', '2d'], ['zoomBy', 3]]);
});

test('if 3D cannot start the flat top-down map stays, and the failure is reported', async () => {
  const flat = stubMap(), e = els();
  let reported = null;
  const map = createMapSwitch({
    flat, create3d: async () => { throw new Error('no WebGL'); }, ...e, onUnavailable: (err) => { reported = err.message; },
  });
  assert.equal(await map.setLayout('space'), '3d');
  assert.equal(reported, 'no WebGL');
  assert.equal(e.flatEl.hidden, false);
  assert.ok(e.spaceEls.every((el) => el.hidden));
  assert.deepEqual(flat.calls.at(-1), ['setLayout', '3d']);
});

test('a layout change while 3D loads wins', async () => {
  const flat = stubMap(), space = stubMap(), e = els();
  let resolve;
  const map = createMapSwitch({ flat, create3d: () => new Promise((r) => { resolve = r; }), ...e });
  const pending = map.setLayout('space');
  await map.setLayout('2d');
  resolve(space);
  assert.equal(await pending, '2d');
  assert.equal(e.flatEl.hidden, false);
});

test('migrateMapLayout moves the old default to the new one, once', () => {
  assert.deepEqual(migrateMapLayout({ mapLayout: '3d', x: 1 }), { x: 1, mapV: 1 });
  assert.deepEqual(migrateMapLayout({ mapLayout: '2d' }), { mapLayout: '2d', mapV: 1 });
  assert.deepEqual(migrateMapLayout({ mapLayout: '3d', mapV: 1 }), { mapLayout: '3d', mapV: 1 });
  assert.deepEqual(migrateMapLayout({}), { mapV: 1 });
});
