// Run: node --test projects/tompa/test/sms.test.js
const test = require('node:test');
const assert = require('node:assert');
const sms = require('../../../board/plugins/tompa/sms');

const hex = b => Buffer.from(b).toString('hex');

function mtRpData(rpMr, from, text) {
  const ud = sms.pack7(text);
  const tpdu = [0x04, from.length, 0x91, ...sms.bcd(from), 0, 0, 0x62, 0x10, 0x22, 0x01, 0, 0, 0x40, ud.septets, ...ud.bytes];
  const sc = sms.bcd('46700000100');
  return { tpdu: hex(tpdu), rp: hex([0x01, rpMr, sc.length + 1, 0x91, ...sc, 0x00, tpdu.length, ...tpdu]) };
}

test('parseMt reads RP-DATA carrying SMS-DELIVER', () => {
  const { rp } = mtRpData(7, '46700000001', 'Hi UE2 @£');
  assert.deepStrictEqual(sms.parseMt(rp), { rpMr: 7, scAddress: '46700000100', from: '46700000001', text: 'Hi UE2 @£' });
});

test('parseMt rejects a bare TPDU without the RP layer', () => {
  const { tpdu } = mtRpData(7, '46700000001', 'Hi');
  assert.throws(() => sms.parseMt(tpdu), /RP-DATA network to MS/);
});

test('moSubmit builds RP-DATA(MS to network) with RP-DA = SMSC and an SMS-SUBMIT TPDU', () => {
  const b = Buffer.from(sms.moSubmit({ rpMr: 5, tpMr: 5, scAddress: '46700000100', to: 'msisdn-46700000002', text: 'Hello' }), 'hex');
  assert.strictEqual(b[0], sms.RP.DATA_MS);
  assert.strictEqual(b[1], 5);
  assert.strictEqual(b[2], 0); // empty RP-OA
  assert.strictEqual(sms.unbcd(b.subarray(5, 4 + b[3])), '46700000100');
  const tpdu = b.subarray(5 + b[3]);
  assert.strictEqual(tpdu[0] & 0x03, 0x01); // SMS-SUBMIT
  assert.strictEqual(sms.unbcd(tpdu.subarray(4, 10)).slice(0, tpdu[2]), '46700000002');
  assert.strictEqual(sms.unpack7([...tpdu.subarray(13)], tpdu[12]), 'Hello');
});

test('pack7/unpack7 round-trip, including an 8-septet boundary', () => {
  for (const t of ['', 'a', 'abcdefgh', 'Hello world, 5G!']) {
    const p = sms.pack7(t);
    assert.strictEqual(sms.unpack7(p.bytes, p.septets), t);
  }
});

test('rpAck and rpError echo the RP message reference', () => {
  assert.strictEqual(sms.rpAck(0x2a), '022A41020000');
  assert.strictEqual(sms.rpError(0x2a, 22), '042A0116');
});
