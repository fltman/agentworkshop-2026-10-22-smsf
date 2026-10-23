'use strict';
const test = require('node:test');
const assert = require('node:assert');
const h = require('../../../board/plugins/tompa/health.js');

const NOW = Date.parse('2026-10-22T14:00:00Z');
const SMSF = { team: 'krilju', node: 'SMSF' };
const ID = '6f1c2c1e-0000-4000-8000-0000006b7269';
const nrfList = lastSeen => [{ nfInstanceId: ID, nfStatus: 'REGISTERED', lastSeen }];

test('health α: down, warming, degraded and up from /status plus the NRF instance list', () => {
  assert.strictEqual(h.judgeNf(SMSF, 0, null, null, NOW).verdict, 'down');
  assert.strictEqual(h.judgeNf(SMSF, 200, { nfInstanceId: ID, registeredInNrf: true, warmup: { state: 'nrf-pending' } }, nrfList(), NOW).verdict, 'warming');
  assert.strictEqual(h.judgeNf(SMSF, 200, { nfInstanceId: ID, registeredInNrf: true, started: '2026-10-22T13:59:40Z' }, nrfList('2026-10-22T13:59:50Z'), NOW).verdict, 'warming');
  const stale = h.judgeNf(SMSF, 200, { nfInstanceId: ID, registeredInNrf: true }, nrfList('2026-10-22T13:55:00Z'), NOW);
  assert.strictEqual(stale.verdict, 'degraded');
  assert.match(stale.evidence.join(), /300 s ago/);
  assert.strictEqual(h.judgeNf(SMSF, 200, { nfInstanceId: ID, registeredInNrf: true }, [], NOW).verdict, 'degraded');
  const ok = h.judgeNf(SMSF, 200, { nfInstanceId: ID, nrf: { registered: true } }, nrfList('2026-10-22T13:59:50Z'), NOW);
  assert.deepStrictEqual([ok.verdict, ok.inNrf], ['up', true]);
  // NRF unreachable: no cross-check, no false "degraded"
  assert.strictEqual(h.judgeNf(SMSF, 200, { nfInstanceId: ID, registeredInNrf: true }, null, NOW).verdict, 'up');
});

test('health summary: red on a bad NF or failed canary, amber while warming or before the canary ran', () => {
  const up = { node: 'AMF', verdict: 'up' };
  assert.strictEqual(h.summary([up], { verdict: 'pass' }).verdict, 'green');
  assert.strictEqual(h.summary([up], null).verdict, 'amber');
  assert.strictEqual(h.summary([{ node: 'UDM', verdict: 'warming' }], { verdict: 'pass' }).verdict, 'amber');
  assert.strictEqual(h.summary([up, { node: 'SMSC', verdict: 'down' }], { verdict: 'pass' }).verdict, 'red');
  assert.strictEqual(h.summary([up], { verdict: 'fail' }).verdict, 'red');
});
