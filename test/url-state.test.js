import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUrl, queryFor } from '../public/js/url-state.js';

const DEFAULTS = { flag: 'secure', tax: 0, home: 30000142, selected: null, hide: false, scan: { min: '5m', rank: 'ppj' } };
const FIELDS = [['flag', ['secure', 'shortest']], ['tax', v => v >= 0 && v <= 100], 'home', 'selected', 'hide', 'scan.min', 'scan.rank'];
const fresh = (over = {}) => ({ ...structuredClone(DEFAULTS), ...over });

test('readUrl leaves saved settings alone when the URL has none of its parameters', () => {
  const s = fresh({ flag: 'shortest', tax: 3 });
  assert.equal(readUrl(s, DEFAULTS, FIELDS, '?utm=x'), false);
  assert.deepEqual([s.flag, s.tax], ['shortest', 3]);
});

test('readUrl types values by their defaults and resets unlisted fields to defaults', () => {
  const s = fresh({ flag: 'shortest', scan: { min: '1b', rank: 'profit' } });
  assert.equal(readUrl(s, DEFAULTS, FIELDS, '?tax=2.5&home=30002187&selected=587&hide=1&scan.min=10m'), true);
  assert.deepEqual(s, { flag: 'secure', tax: 2.5, home: 30002187, selected: 587, hide: true, scan: { min: '10m', rank: 'ppj' } });
});

test('readUrl ignores values that are malformed or not allowed', () => {
  const s = fresh();
  readUrl(s, DEFAULTS, FIELDS, '?flag=nope&tax=500&home=abc&selected=&hide=maybe');
  assert.deepEqual(s, fresh());
});

test('queryFor writes only non-default values and keeps unrelated parameters', () => {
  assert.equal(queryFor(fresh(), DEFAULTS, FIELDS, '?utm=x&flag=shortest'), 'utm=x');
  const s = fresh({ flag: 'shortest', tax: '2', hide: true, selected: 587, scan: { min: '10m', rank: 'ppj' } });
  assert.equal(queryFor(s, DEFAULTS, FIELDS), 'flag=shortest&tax=2&selected=587&hide=1&scan.min=10m');
});

test('queryFor output reads back to the same settings', () => {
  const s = fresh({ flag: 'shortest', tax: 4, hide: true, scan: { min: '', rank: 'profit' } });
  const back = fresh({ tax: 9 });
  readUrl(back, DEFAULTS, FIELDS, queryFor(s, DEFAULTS, FIELDS));
  assert.deepEqual(back, s);
});
