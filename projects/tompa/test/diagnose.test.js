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
