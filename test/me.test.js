import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meLine } from '../public/js/me.js';

const isk = (v) => `${(v / 1e6).toFixed(2)}M`;

test('meLine: system first by default, wallet in an .me-isk span', () => {
  assert.equal(meLine({ where: 'Rens', docked: 'docked', wallet: 168.17e6, isk }),
    'Rens · docked · <span class="me-isk">168.17M ISK</span>');
});

test('meLine: line "ship" puts the ship name first, falling back to the system', () => {
  assert.equal(meLine({ line: 'ship', where: 'Rens', docked: 'docked', shipName: 'Hulmate', wallet: null, isk }), 'Hulmate · docked');
  assert.equal(meLine({ line: 'ship', where: 'Rens', docked: 'in space', isk }), 'Rens · in space');
});

test('meLine: escapes names and leaves out missing parts', () => {
  assert.equal(meLine({ line: 'ship', shipName: '<b>&', isk }), '&lt;b&gt;&amp;');
  assert.equal(meLine({ wallet: 0, isk }), '<span class="me-isk">0.00M ISK</span>');
  assert.equal(meLine({ isk }), '');
});

test('meLine: while the location loads, no trailing separator', () => {
  assert.equal(meLine({ where: '…', docked: '', isk }), '…');
  assert.equal(meLine({ where: '…', docked: '', wallet: 1e6, isk }), '… · <span class="me-isk">1.00M ISK</span>');
});
