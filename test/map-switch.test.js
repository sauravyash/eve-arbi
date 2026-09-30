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
  assert.ok(e.spaceEls.every((el) => el.hidden));
});

test('migrateMapLayout moves the old default to the new one, once', () => {
  assert.deepEqual(migrateMapLayout({ mapLayout: '3d', x: 1 }), { x: 1, mapV: 1 });
  assert.deepEqual(migrateMapLayout({ mapLayout: '2d' }), { mapLayout: '2d', mapV: 1 });
  assert.deepEqual(migrateMapLayout({ mapLayout: '3d', mapV: 1 }), { mapLayout: '3d', mapV: 1 });
  assert.deepEqual(migrateMapLayout({}), { mapV: 1 });
});

test('if 3D replay throws, fallback runs and error is reported', async () => {
  const flat = stubMap(), e = els();
  let reported = null;
  const throwingSpace = {
    setSecurityColors: () => {},
    setUniverse: () => { throw new Error('replay failed'); },
    update: () => {},
    setTrip: () => {},
  };
  const map = createMapSwitch({
    flat,
    create3d: async () => throwingSpace,
    ...e,
    onUnavailable: (err) => { reported = err.message; },
  });
  map.setUniverse('U');
  assert.equal(await map.setLayout('space'), '3d');
  assert.equal(reported, 'replay failed');
  assert.equal(e.flatEl.hidden, false);
  assert.ok(e.spaceEls.every((el) => el.hidden));
  assert.deepEqual(flat.calls.at(-1), ['setLayout', '3d']);
});

test('setUniverse, setTrip and setSecurityColors reach both maps when 3D is live', async () => {
  const flat = stubMap(), space = stubMap();
  const map = createMapSwitch({ flat, create3d: async () => space, ...els() });
  await map.setLayout('space');
  space.calls.length = 0; flat.calls.length = 0;
  map.setUniverse('U2');
  assert.deepEqual(flat.calls.filter(([n]) => n === 'setUniverse'), [['setUniverse', 'U2']]);
  assert.deepEqual(space.calls.filter(([n]) => n === 'setUniverse'), [['setUniverse', 'U2']]);
  space.calls.length = 0; flat.calls.length = 0;
  map.setTrip('T2');
  assert.deepEqual(flat.calls.filter(([n]) => n === 'setTrip'), [['setTrip', 'T2']]);
  assert.deepEqual(space.calls.filter(([n]) => n === 'setTrip'), [['setTrip', 'T2']]);
  space.calls.length = 0; flat.calls.length = 0;
  map.setTrip(null);
  assert.deepEqual(flat.calls.filter(([n]) => n === 'setTrip'), [['setTrip', null]]);
  assert.deepEqual(space.calls.filter(([n]) => n === 'setTrip'), [['setTrip', null]]);
  space.calls.length = 0; flat.calls.length = 0;
  map.setSecurityColors(true);
  assert.deepEqual(flat.calls.filter(([n]) => n === 'setSecurityColors'),
    [['setSecurityColors', true]]);
  assert.deepEqual(space.calls.filter(([n]) => n === 'setSecurityColors'),
    [['setSecurityColors', true]]);
});

test('fitHubs, fitAll, fitPath go to flat in 2d mode', async () => {
  const flat = stubMap(), space = stubMap();
  const map = createMapSwitch({ flat, create3d: async () => space, ...els() });
  await map.setLayout('space');
  await map.setLayout('2d');
  flat.calls.length = 0; space.calls.length = 0;
  map.fitHubs();
  assert.deepEqual(flat.calls.filter(([n]) => n === 'fitHubs'), [['fitHubs']]);
  assert.ok(!space.calls.some(([n]) => n === 'fitHubs'));
  flat.calls.length = 0; space.calls.length = 0;
  map.fitAll();
  assert.deepEqual(flat.calls.filter(([n]) => n === 'fitAll'), [['fitAll']]);
  assert.ok(!space.calls.some(([n]) => n === 'fitAll'));
  flat.calls.length = 0; space.calls.length = 0;
  map.fitPath([1, 2]);
  assert.deepEqual(flat.calls.filter(([n]) => n === 'fitPath'), [['fitPath', [1, 2]]]);
  assert.ok(!space.calls.some(([n]) => n === 'fitPath'));
});

test('view commands go to flat after failed 3D start', async () => {
  const flat = stubMap(), e = els();
  const map = createMapSwitch({
    flat,
    create3d: async () => { throw new Error('no WebGL'); },
    ...e,
    onUnavailable: () => {},
  });
  await map.setLayout('space');
  flat.calls.length = 0;
  map.zoomBy(2);
  assert.deepEqual(flat.calls.filter(([n]) => n === 'zoomBy'), [['zoomBy', 2]]);
  flat.calls.length = 0;
  map.fitHubs();
  assert.deepEqual(flat.calls.filter(([n]) => n === 'fitHubs'), [['fitHubs']]);
});
