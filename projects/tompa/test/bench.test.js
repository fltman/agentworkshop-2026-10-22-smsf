'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CASES, runCase } = require('../../../board/public/colony/tompa/bench.js');

// A fake core that behaves as the contracts say; `broken` flips one behaviour to prove NOK is reported.
function fakeCore(broken = {}) {
  const ues = {}; const msgs = {}; let id = 0;
  const ue = s => (ues[s] ||= { supi: s, state: 'DEREGISTERED', smsActive: false, reachable: true, inbox: [] });
  const smsfPut = s => (s.endsWith('3') ? { status: 403, body: { cause: 'SMS_NOT_ALLOWED' } }
    : s.endsWith('999') ? { status: 404, body: { cause: 'USER_UNKNOWN' } } : { status: 201, body: {} });
  const deliver = (n, text) => { const u = ue(`imsi-00101000000000${n}`); if (!u.reachable || u.state !== 'REGISTERED') return false; u.inbox.unshift({ text }); return true; };
  const tompa = async (m, path, b) => {
    const [, supi, act] = path.match(/^\/ue\/([^/]+)\/?(.*)$/);
    const u = ue(supi);
    if (m === 'GET' && !act) return { status: 200, body: u };
    if (act === 'inbox') return { status: 200, body: u.inbox };
    if (act === 'register') { u.state = 'REGISTERED'; const s = smsfPut(supi); u.smsActive = s.status === 201 && !broken.reg; return { status: 200, body: { ...u, smsf: s } }; }
    if (act === 'deregister') { const was = u.smsActive; u.state = 'DEREGISTERED'; u.smsActive = false; return { status: 200, body: { ...u, smsf: was ? { status: 204 } : null } }; }
    if (act === 'reachable') { u.reachable = b.reachable; if (b.reachable) for (const x of Object.values(msgs)) if (x.status === 'WAITING' && deliver(x.n, x.text)) x.status = 'DELIVERED'; return { status: 200, body: u }; }
    if (act === 'sms') {
      if (supi.endsWith('5') && !broken.moBarred) return { status: 502, body: { smsf: { status: 403, body: { cause: 'MO_SMS_BARRED' } } } };
      deliver(b.to.slice(-1), b.text); return { status: 200, body: { delivered: true, smsf: { status: 200 } } };
    }
  };
  const smsc = async (m, path, b) => {
    if (m === 'GET') return { status: 200, body: msgs[path.split('/').pop()] };
    const n = b.to.slice(-1); const mid = `smsc-${++id}`;
    const status = n === '4' ? 'FAILED' : deliver(n, b.text) ? 'DELIVERED' : 'WAITING';
    msgs[mid] = { id: mid, n, text: b.text, status };
    return path.includes('wait=1') ? { status: 200, body: { result: status, messageId: mid, message: msgs[mid] } } : { status: 202, body: { messageId: mid } };
  };
  return { tompa, smsc, sleep: async () => {} };
}

test('bench: every case is OK against a core that behaves as contracted', async () => {
  const c = fakeCore();
  const res = [];
  for (const cs of CASES) res.push([cs.id, (await runCase(cs, c)).ok]);
  assert.deepStrictEqual(res.filter(([, ok]) => !ok), []);
  assert.strictEqual(res.length, 9);
});

test('bench: a core that lets barred UE5 send MO, or fails activation, is reported NOK', async () => {
  const byId = id => CASES.find(x => x.id === id);
  assert.strictEqual((await runCase(byId('mo_barred'), fakeCore({ moBarred: true }))).ok, false);
  const r = await runCase(byId('reg_ok'), fakeCore({ reg: true }));
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /SMSF 201/);
});
