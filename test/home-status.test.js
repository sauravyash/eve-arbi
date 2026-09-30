import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eveTime, ago, describeScan } from '../public/js/home-status.js';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const MIN = 60_000;

test('eveTime is the UTC clock, zero-padded', () => {
  assert.equal(eveTime(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '03:04:05');
  assert.equal(eveTime(new Date(Date.UTC(2026, 0, 2, 23, 59, 59))), '23:59:59');
});

test('ago rounds to minutes, then hours, then days', () => {
  assert.equal(ago(NOW - 20_000, NOW), 'just now');
  assert.equal(ago(NOW - 45 * MIN, NOW), '45m ago');
  assert.equal(ago(NOW - 125 * MIN, NOW), '2h ago');
  assert.equal(ago(NOW - 47 * 60 * MIN, NOW), '47h ago');
  assert.equal(ago(NOW - 72 * 60 * MIN, NOW), '3d ago');
});

test('describeScan: a finished scan reads as scanned, however old', () => {
  const st = { state: 'done', result: { finishedAt: NOW - 120 * MIN, expiresAt: NOW - 60 * MIN } };
  assert.deepEqual(describeScan(st, NOW), { state: 'scanned', chip: '2h ago', row: 'Scanned · 2h ago' });
});

test('describeScan: running or computing, even with an older result', () => {
  const want = { state: 'running', chip: 'scanning now', row: 'Scanning now' };
  assert.deepEqual(describeScan({ state: 'running' }, NOW), want);
  assert.deepEqual(describeScan({ state: 'computing', result: { finishedAt: NOW - MIN } }, NOW), want);
});

test('describeScan: never scanned, or the only scan failed, needs a scan', () => {
  assert.deepEqual(describeScan({ state: 'idle' }, NOW), { state: 'none', chip: 'not yet', row: 'Needs a scan' });
  assert.deepEqual(describeScan({ state: 'error' }, NOW), { state: 'none', chip: 'last scan failed', row: 'Needs a scan' });
});

test('describeScan: an unreadable status shows no row label', () => {
  assert.deepEqual(describeScan(null, NOW), { state: 'error', chip: 'unavailable', row: '' });
});
