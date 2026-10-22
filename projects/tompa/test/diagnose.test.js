// Run: node --test projects/tompa/test/diagnose.test.js
const test = require('node:test');
const assert = require('node:assert');
const d = require('../../../board/plugins/tompa/diagnose');

test('SMSF errors are blamed on the hop named in the detail', () => {
  const smsc = d.smsfResponse('sendsms', 'imsi-001010000000001', 502, { cause: 'FAILURE', detail: 'SMSC answered 501' });
  assert.deepStrictEqual([smsc.verdict, smsc.hop, smsc.owner], ['fault', 'SMSF→SMSC', 'holminator']);
  const udm = d.smsfResponse('activate', 'imsi-001010000000001', 504, { cause: 'UDM_UNREACHABLE' });
  assert.deepStrictEqual([udm.hop, udm.owner], ['SMSF→UDM', 'hetoteam']);
  assert.strictEqual(d.smsfResponse('activate', 'imsi-001010000000001', 0, null).owner, 'krilju');
});

test('negative test-data cases are expected, and the wrong cause for them is a fault', () => {
  assert.strictEqual(d.smsfResponse('activate', 'imsi-001010000000003', 403, { cause: 'SMS_NOT_ALLOWED' }).verdict, 'expected');
  assert.strictEqual(d.smsfResponse('sendsms', 'imsi-001010000000005', 403, { cause: 'MO_SMS_BARRED' }).verdict, 'expected');
  assert.strictEqual(d.smsfResponse('activate', 'imsi-001010000000003', 201, {}).verdict, 'fault');
});

test('discovery flags an NF type mismatch and an uncallable profile', () => {
  const mismatch = d.discovery('SMSF', 200, { nfInstances: [{ nfType: 'AMF', nfServices: [{ apiRoot: 'https://x' }] }] });
  assert.deepStrictEqual([mismatch.verdict, mismatch.owner], ['fault', 'smsf-hao']);
  const noAddr = d.discovery('SMSF', 200, { nfInstances: [{ nfType: 'SMSF', nfServices: [{ apiPrefix: '/t/krilju' }] }] });
  assert.match(noAddr.finding, /no apiRoot/);
  assert.strictEqual(d.discovery('SMSF', 200, { nfInstances: [{ nfType: 'SMSF', nfServices: [{ apiRoot: 'https://x' }] }] }).verdict, 'ok');
});

test('a malformed-request error from the SMSC or UDM is the SMSF\'s fault, a discovery failure too', () => {
  // Fault 2 once the SMSC decodes MO: the SMSF forwards our whole RP-DATA and the SMSC rejects it as data.
  const rpLayering = d.smsfResponse('sendsms', 'imsi-001010000000001', 502, { cause: 'UNEXPECTED_DATA_VALUE', detail: 'SMSC answered 400' });
  assert.deepStrictEqual([rpLayering.hop, rpLayering.owner], ['SMSF→SMSC', 'krilju']);
  const udm400 = d.smsfResponse('activate', 'imsi-001010000000001', 502, { cause: 'UDM_REGISTRATION_FAILED', detail: 'UDM answered 400' });
  assert.deepStrictEqual([udm400.hop, udm400.owner], ['SMSF→UDM', 'krilju']);
  // Fault 3: the SMSF asked the NRF for the wrong NF type, so "no SMSC found" is not holminator's.
  const disc = d.smsfResponse('sendsms', 'imsi-001010000000001', 503, { cause: 'NF_DISCOVERY_FAILED', detail: 'no SMSC found in NRF' });
  assert.deepStrictEqual([disc.hop, disc.owner], ['SMSF→NRF', 'krilju']);
});

test('the UplinkSMS answer must carry RP-ACK/RP-ERROR network to MS with our RP-MR', () => {
  const sentHex = '000700079164070000F0'; // RP-DATA MS→N, RP-MR 7 (only the header matters here)
  const sendsms = (status, hex) => d.smsfResponse('sendsms', 'imsi-001010000000001', status, { smsPayload: { hex } }, { sentHex });
  assert.strictEqual(sendsms(200, '0307').verdict, 'ok');
  assert.match(sendsms(200, '0308').finding, /RP-MR 8 .* we sent 7/);
  const bare = sendsms(200, '01006280228140');
  assert.deepStrictEqual([bare.verdict, bare.hop, bare.owner], ['fault', 'SMSF→AMF', 'krilju']);
  // An SMSC-side error stays on the SMSC, with a wrong RP layer towards the UE reported alongside.
  const err = d.smsfResponse('sendsms', 'imsi-001010000000001', 502, { cause: 'FAILURE', detail: 'SMSC answered 501', smsPayload: { hex: '0307' } }, { sentHex });
  assert.deepStrictEqual([err.owner, err.also && err.also.owner], ['holminator', 'krilju']);
});

test('a cause the test forced on purpose is expected, not a fault', () => {
  const body = { cause: 'SC_CONGESTION', detail: 'SMSC answered 403' };
  assert.strictEqual(d.smsfResponse('sendsms', 'imsi-001010000000001', 502, body, { expectCause: 'SC_CONGESTION' }).verdict, 'expected');
  assert.strictEqual(d.smsfResponse('sendsms', 'imsi-001010000000001', 502, body).owner, 'holminator');
});
