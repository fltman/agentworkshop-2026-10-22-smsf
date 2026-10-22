'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createGenerator, classify, MAX_RATE } = require('../../../board/plugins/tompa/traffic.js');

function harness(respond, rndSeq = [0.5]) {
  let t = 1_000_000, i = 0, timer = null, cleared = false;
  const g = createGenerator({
    sendSms: async (from, to) => respond(from, to),
    ensureRegistered: async supi => ({ supi, ok: true }),
    now: () => t, rnd: () => rndSeq[i++ % rndSeq.length],
    setTimer: (fn, ms) => (timer = { fn, ms }), clearTimer: () => { cleared = true; },
  });
  return { g, advance: ms => { t += ms; }, timer: () => timer, cleared: () => cleared };
}

test('rate and duration are capped, auto-stop fires after the duration', async () => {
  const h = harness(() => ({ status: 200, body: {} }));
  const s = await h.g.start({ rate: 50, durationS: 9999 });
  assert.strictEqual(s.rate, MAX_RATE);
  assert.strictEqual(h.timer().ms, 200);
  assert.strictEqual(s.durationS, 300);
  h.advance(301_000);
  await h.g.fire();
  assert.strictEqual(h.g.stats().running, false);
  assert.strictEqual(h.g.stats().stoppedBy, 'auto-stop');
  assert.ok(h.cleared());
});

test('happy path, expected barring and real failures are counted apart', async () => {
  // rnd 0.5 → happy UE1→UE2, 0.01 → UE5 MO-barred, 0.07 → to UE4 MT-barred
  const h = harness((from, to) => {
    if (from.endsWith('5')) return { status: 502, body: { smsf: { status: 403, body: { cause: 'MO_SMS_BARRED' } } } };
    if (to === '46700000004') return { status: 200, body: {} };
    return { status: 502, body: { smsf: { status: 502, body: { cause: 'SMSC_ERROR' } } } };
  }, [0.5, 0.01, 0.07]);
  await h.g.start({ rate: 1 });
  for (let k = 0; k < 3; k++) { await h.g.fire(); h.advance(1000); }
  const s = h.g.stats();
  assert.deepStrictEqual(s.totals, { sent: 3, ok: 0, expected: 2, failed: 1, skipped: 0 });
  assert.deepStrictEqual(s.causes, { 'happy: SMSC_ERROR': 1, 'mo-barred: MO_SMS_BARRED': 1 });
  assert.strictEqual(s.successPct, 66.7);
});

test('a barred sender that gets through is a failure, not expected', () => {
  assert.strictEqual(classify({ kind: 'mo-barred', expect: 'MO_SMS_BARRED' }, { status: 200, body: {} }), 'failed');
});

test('in-flight cap skips ticks instead of piling up', async () => {
  const h = harness(() => new Promise(() => {}));
  await h.g.start({ rate: 5 });
  for (let k = 0; k < 25; k++) h.g.fire();
  const s = h.g.stats();
  assert.strictEqual(s.inFlight, 20);
  assert.strictEqual(s.totals.skipped, 5);
});
