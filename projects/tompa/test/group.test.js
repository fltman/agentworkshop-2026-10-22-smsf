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

const ev = require('../../../board/public/colony/tompa/events.js');
const gui = require('../../../board/public/colony/tompa/gui.js');
const arcade = require('../../../board/public/colony/tompa/arcade.js');

test('events: caller is decided by whose API the path targets, not by log direction', () => {
  const smsc = { team: 'holminator', node: 'SMSC' };
  // holminator logs the UDM's answer to its own call as dir "in"
  assert.deepEqual(ev.normalize(smsc, { dir: 'in', peer: 'udm', method: 'POST', path: '/t/hetoteam/sms-routing/v1/x', status: 404 }),
    { ts: undefined, from: 'SMSC', to: 'UDM', status: 404, ok: false, label: 'POST /sms-routing/v1/x' });
  const amf = { team: 'tompa', node: 'AMF' };
  assert.equal(ev.normalize(amf, { dir: 'in', peer: 'smsf', method: 'POST', path: '/namf-comm/v1/ue-contexts/imsi-1/n1-n2-messages', status: 200 }).from, 'SMSF');
  assert.equal(ev.normalize(amf, { dir: 'out', peer: 'nrf', method: 'PATCH', path: '/t/smsf-hao/x', status: null }), null);
  const smsf = { team: 'krilju', node: 'SMSF' };
  assert.deepEqual(ev.normalize(smsf, { dir: 'in', peer: 'amf', what: '502 N1N2 RP-ERROR' }).ok, false);
  assert.equal(ev.normalize(smsf, { dir: 'out', peer: 'amf', what: '200 UplinkSMS' }).from, 'AMF');
});

test('events: the same call seen in two logs is drawn once', () => {
  const a = { ts: '2026-10-22T10:00:00.100Z', peer: 'udm', dir: 'in', path: '/t/hetoteam/r', status: 200 };
  const b = { ts: '2026-10-22T10:00:00.300Z', peer: 'smsc', dir: 'in', path: '/t/hetoteam/r', status: 200 };
  const out = ev.collect([{ feed: { team: 'holminator', node: 'SMSC' }, list: [a] }, { feed: { team: 'hetoteam', node: 'UDM' }, list: [b] }]);
  assert.equal(out.length, 1);
});

test('looks: flip order, hash pinning and arcade scoring', () => {
  assert.equal(gui.nextView('arcade'), 'classic');
  assert.equal(gui.fromHash('#map'), 'map');
  assert.equal(gui.fromHash('#nope'), null);
  let s = { score: 0, combo: 0, best: 0, hi: 0, landed: 0, lost: 0 };
  for (let k = 0; k < 10; k++) s = arcade.scoreHit(s, true);
  assert.equal(s.score, 9 * 10 + 20); // the 10th landing doubles
  s = arcade.scoreHit(s, false);
  assert.equal(s.combo, 0); assert.equal(s.best, 10); assert.equal(s.lost, 1);
});

test('events: NRF log lines become calls from the requesting NF', () => {
  const nrf = { team: 'smsf-hao', node: 'NRF' };
  assert.deepEqual(ev.normalize(nrf, { dir: 'out', text: '200 SearchResult', detail: '1 instance(s) of CUSTOM_SMSC for SMSF' }),
    { ts: undefined, from: 'SMSF', to: 'NRF', status: 200, ok: true, label: 'discovery CUSTOM_SMSC' });
  assert.equal(ev.normalize(nrf, { dir: 'out', text: '204 heartbeat CUSTOM_SMSC 6f1c2c1e-0000-4000-8000-0000686f6c6d' }).from, 'SMSC');
  assert.equal(ev.normalize(nrf, { dir: 'in', text: 'GET nnrf-disc nf-instances' }), null);
});

test('events: calls touching UDM or NRF are signalling, the SMS chain is sms', () => {
  assert.equal(ev.kindOf({ from: 'SMSF', to: 'UDM' }), 'signal');
  assert.equal(ev.kindOf({ from: 'AMF', to: 'NRF' }), 'signal');
  assert.equal(ev.kindOf({ from: 'SMSF', to: 'SMSC' }), 'sms');
  assert.equal(ev.kindOf({ from: 'AMF', to: 'SMSF' }), 'sms');
});
