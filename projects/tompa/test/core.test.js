'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseProm, fromAdapter, fromCommon, totals } = require('../../../board/public/colony/tompa/core.js');

test('prometheus text adapter (SMSC) sums peers and keeps non-NRF results', () => {
  const text = [
    'smsc_up 1', 'smsc_nrf_registered 1', 'smsc_uptime_seconds 10',
    'smsc_results_total{operation="NFRegister",result="200"} 1',
    'smsc_results_total{operation="MO-Forward",result="501"} 2',
    'smsc_peer_requests_in_total{peer="nrf"} 4', 'smsc_peer_requests_in_total{peer="smsf"} 2',
    'smsc_peer_requests_out_total{peer="nrf"} 4', 'smsc_peer_errors_total{peer="smsf"} 2',
    'smsc_peer_latency_ms_sum{peer="nrf"} 40',
  ].join('\n');
  assert.strictEqual(parseProm(text).length, 10);
  const r = fromAdapter('holminator', text);
  assert.deepStrictEqual([r.nf, r.up, r.nrfRegistered, r.requests, r.errors, r.errorPct, r.latencyMs], ['SMSC', true, true, 10, 2, 20, 10]);
  assert.strictEqual(r.extra['MO-Forward 501'], 2);
  assert.ok(!('NFRegister 200' in r.extra));
});

test('SMSF adapter counts inbound and outbound, latency from inbound only', () => {
  const r = fromAdapter('krilju', { registeredInNrf: true, ueContexts: 1, inbound: { Activate: { count: 2, errors: 1, ms: 60 } }, outbound: { udm: { count: 6, errors: 0, ms: 48 } } });
  assert.deepStrictEqual([r.requests, r.errors, r.errorPct, r.latencyMs, r.extra.Activate], [8, 1, 12.5, 30, '1/2 ok']);
});

test('common /kpi shape is used as-is and totals skip down NFs', () => {
  const a = fromCommon('krilju', { nf: 'SMSF', up: true, nrfRegistered: true, requests: 10, errors: 1, latencyMs: 5 });
  const b = fromAdapter('smsf-hao', { counters: { update: 4, discover: 1, rejected: 1 }, instances: [{ nfStatus: 'REGISTERED' }] });
  const down = { ...a, team: 'x', up: false, requests: 99, errors: 99 };
  assert.strictEqual(a.errorPct, 10);
  assert.deepStrictEqual(totals([a, b, down]), { nfsUp: 2, nfs: 3, nrfRegistered: 1, requests: 16, errors: 2, errorPct: 12.5 });
});
