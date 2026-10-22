// Run: node --test projects/tompa/test/scenario.test.js
// Scenario runner against stubbed UE simulator deps: no network, virtual clock.
const test = require('node:test');
const assert = require('node:assert');
const { createRunner } = require('../../../board/plugins/tompa/scenario');

const REFUSE = {
  'imsi-001010000000003': { status: 403, body: { cause: 'SMS_NOT_ALLOWED' } },
  'imsi-001019999999999': { status: 404, body: { cause: 'USER_UNKNOWN' } },
};

// A well-behaved core: MO to an active, reachable UE lands in its inbox; UE5 is MO-barred; UE4 is MT-barred.
function core(over = {}) {
  const inbox = {}; const reachable = {}; const pending = [];
  const supiOf = msisdn => `imsi-00101000000000${msisdn.slice(-1)}`;
  const deliver = (to, text) => { (inbox[to] = inbox[to] || []).unshift({ text, from: '46700000001' }); };
  const deps = {
    register: async supi => {
      const smsf = over.activate ? over.activate(supi) : (REFUSE[supi] || { status: 201, body: {} });
      return { supi, state: 'REGISTERED', smsActive: smsf.status === 201 || smsf.status === 200, smsf };
    },
    sendSms: async (supi, to, text) => {
      if (supi === 'imsi-001010000000005') return { status: 502, body: { delivered: false, smsf: { status: 403, body: { cause: 'MO_SMS_BARRED' } } } };
      const r = over.sendSms && over.sendSms(supi, to, text);
      if (r) return r;
      const dest = supiOf(to);
      if (reachable[dest] === false) pending.push([dest, text]);
      else if (dest !== 'imsi-001010000000004' && !over.dropMt) deliver(dest, text);
      return { status: 200, body: { delivered: true, smsf: { status: 200, body: {} } } };
    },
    setReachable: async (supi, v) => {
      reachable[supi] = v;
      if (v && over.alert) while (pending.length) deliver(...pending.shift());
      return { supi, reachable: v };
    },
    inbox: supi => inbox[supi] || [],
  };
  return deps;
}

function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async ms => { t += ms; } };
}

test('all steps pass against a conforming core; MWD without alert is a skip, not a fail', async () => {
  const r = await createRunner(core({ alert: true }), clock()).run();
  assert.deepStrictEqual(r.steps.map(s => s.verdict), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  assert.deepStrictEqual(r.summary, { pass: 6, fail: 0, skip: 0 });
  assert.ok(r.steps.every(s => s.report === null));

  const noAlert = await createRunner(core(), clock()).run(5);
  assert.strictEqual(noAlert.steps.length, 1);
  assert.strictEqual(noAlert.steps[0].verdict, 'skip');
  assert.match(noAlert.steps[0].got, /pending/);
});

test('a wrong cause fails with the hop and owner from the decoder blame logic and a #build report', async () => {
  const deps = core({ activate: supi => (supi === 'imsi-001010000000003'
    ? { status: 500, body: { cause: 'SYSTEM_FAILURE', detail: 'UDM SDM get failed' } } : { status: 201, body: {} }) });
  const [row] = (await createRunner(deps, clock()).run(2)).steps;
  assert.strictEqual(row.verdict, 'fail');
  assert.strictEqual(row.hop, 'SMSF→UDM');
  assert.strictEqual(row.owner, 'hetoteam');
  assert.match(row.report, /^@hetoteam fault on SMSF→UDM \(tompa scenario step 2/);
  assert.match(row.report, /Sent: PUT nsmsf-sms\/v2\/ue-contexts\/imsi-001010000000003 \(Activate\)/);
  assert.match(row.report, /Expected: SMS_NOT_ALLOWED for imsi-001010000000003\. Got: got 500 SYSTEM_FAILURE/);
});

test('MT that never arrives fails step 1 on the MT leg after the timeout, and makes step 4 inconclusive', async () => {
  const c = clock();
  const r = await createRunner(core({ dropMt: true }), { ...c, mtTimeoutMs: 5000 }).run();
  const [s1, , , s4] = r.steps;
  assert.strictEqual(s1.verdict, 'fail');
  assert.strictEqual(s1.owner, 'krilju');
  assert.match(s1.got, /no N1N2 with RP-DATA for UE2 within 5 s/);
  assert.match(s1.report, /^@krilju fault on SMSC→SMSF→AMF \(MT leg\)/);
  assert.strictEqual(s4.verdict, 'skip');
});

test('MT delivered to the MT-barred UE4 is an SMSC fault; a busy runner refuses a second run', async () => {
  const deps = core();
  const send = deps.sendSms;
  const box4 = [];
  let release;
  const runner = createRunner({ ...deps,
    sendSms: async (supi, to, text) => {
      if (!to.endsWith('4')) return send(supi, to, text);
      await new Promise(r => { release = r; });
      box4.unshift({ text });
      return { status: 200, body: { delivered: true, smsf: { status: 200, body: {} } } };
    },
    inbox: supi => (supi.endsWith('4') ? box4 : deps.inbox(supi)) }, clock());
  const p = runner.run();
  while (!release) await new Promise(r => setImmediate(r));
  await assert.rejects(runner.run(), /already in progress/);
  release();
  const s4 = (await p).steps[3];
  assert.strictEqual(s4.verdict, 'fail');
  assert.strictEqual(s4.owner, 'holminator');
  assert.match(s4.report, /^@holminator fault on SMSC→UDM \(SRI-for-SM\)/);
});

test('POST /scenario/run?step=N and GET /scenario on the plugin, against an offline stub NRF + SMSF', async () => {
  const http = require('node:http');
  const listen = h => new Promise(r => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
  const stub = await listen((req, res) => {
    const out = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const origin = `http://127.0.0.1:${stub.address().port}`;
    if (req.url.includes('/nnrf-disc/')) return out(200, { nfInstances: [{ nfType: 'SMSF', nfServices: [{ serviceName: 'nsmsf-sms', apiRoot: `${origin}/smsf` }] }] });
    if (req.method === 'PUT' && req.url.endsWith('imsi-001010000000003')) return out(403, { cause: 'SMS_NOT_ALLOWED' });
    return out(201, {});
  });
  process.env.TOMPA_BOARD_URL = `http://127.0.0.1:${stub.address().port}`;
  const plugin = require('../../../board/plugins/tompa/index.js');
  const amf = await listen(async (req, res) => {
    if (!(await plugin.handle(req, res, { path: req.url.split('?')[0] }))) { res.writeHead(404); res.end(); }
  });
  const api = async (method, p) => {
    const r = await fetch(`http://127.0.0.1:${amf.address().port}${p}`, { method });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.deepStrictEqual((await api('GET', '/scenario')).body.steps, []);
    const run = await api('POST', '/scenario/run?step=2');
    assert.strictEqual(run.status, 200);
    assert.deepStrictEqual(run.body.steps.map(s => [s.step, s.verdict]), [[2, 'pass']]);
    assert.strictEqual((await api('GET', '/scenario')).body.startedAt, run.body.startedAt);
    assert.strictEqual((await api('POST', '/scenario/run?step=9')).status, 400);
  } finally { stub.close(); amf.close(); }
});

test('MO terminating at the SMSC (holminator #build 193): the MT leg comes from originateMt and all steps pass', async () => {
  const deps = core({ alert: true, dropMt: true });
  const send = deps.sendSms;
  // An SMSC that no longer relays: MO is accepted but never delivered; MT only via originateMt.
  deps.sendSms = (supi, to, text) => (supi === 'imsi-001010000000005' ? send(supi, to, text) : { status: 200, body: { delivered: true, smsf: { status: 200, body: {} } } });
  const mts = [];
  const dropless = core({ alert: true });
  deps.inbox = dropless.inbox;
  deps.setReachable = dropless.setReachable;
  deps.originateMt = async (to, text) => { mts.push(to); return dropless.sendSms('imsi-001010000000001', `msisdn-${to}`, text); };
  const r = await createRunner(deps, clock()).run();
  assert.deepStrictEqual(r.steps.map(s => s.verdict), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
  assert.deepStrictEqual(mts, ['46700000002', '46700000004', '46700000002']);
});
