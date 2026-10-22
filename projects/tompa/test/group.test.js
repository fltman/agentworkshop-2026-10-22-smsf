'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../../../board/public/colony/tompa/group.js');

test('group app: node colour and SMSC message status', () => {
  assert.equal(g.nodeClass({ up: false }), 'bad');
  assert.equal(g.nodeClass({ nf: 'SMSF', up: true, nrfRegistered: false }), 'warn');
  assert.equal(g.nodeClass({ nf: 'NRF', up: true, nrfRegistered: null, errorPct: 0 }), 'ok');
  assert.equal(g.statusClass('DELIVERED'), 's-ok');
  assert.equal(g.statusClass('FAILED'), 's-bad');
  assert.equal(g.statusClass('WAITING'), 's-warn');
});

test('group app: latest messages first, MO/MT step outcomes', () => {
  const r = g.recent([{ id: 'a', submittedAt: '2026-10-22T09:00:00Z' }, { id: 'b', submittedAt: '2026-10-22T09:05:00Z' }], 1);
  assert.deepEqual(r.map((m) => m.id), ['b']);
  assert.deepEqual(g.recent({ messages: [{ id: 'x' }] }).map((m) => m.id), ['x']);
  assert.equal(g.moStep(200, {}).cls, 's-ok');
  assert.match(g.moStep(403, { cause: 'MO_SMS_BARRED' }).text, /MO_SMS_BARRED/);
  assert.equal(g.mtStep({ result: 'done', message: { status: 'DELIVERED' } }).status, 'DELIVERED');
  assert.equal(g.mtStep({ status: 'WAITING' }).cls, 's-warn');
});
