// Run: node --test projects/tompa/test/plugin.test.js
// Drives the tompa plugin over HTTP against an in-process stub NRF + SMSF, so it runs offline.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const sms = require('../../../board/plugins/tompa/sms');

const hex = b => Buffer.from(b).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mtRpData(rpMr, from, text) {
  const ud = sms.pack7(text);
  const tpdu = [0x04, from.length, 0x91, ...sms.bcd(from), 0, 0, 0x62, 0x10, 0x22, 0x01, 0, 0, 0x40, ud.septets, ...ud.bytes];
  const sc = sms.bcd('46700000100');
  return { tpdu: hex(tpdu), rp: hex([0x01, rpMr, sc.length + 1, 0x91, ...sc, 0x00, tpdu.length, ...tpdu]) };
}

const seen = []; // requests the stub SMSF received
let stub; let amf; let plugin;

function listen(handler) {
  return new Promise(resolve => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function body(req) {
  const c = [];
  for await (const x of req) c.push(x);
  const t = Buffer.concat(c).toString();
  return t ? JSON.parse(t) : null;
}

test.before(async () => {
  stub = await listen(async (req, res) => {
    const b = await body(req);
    const out = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(j ? JSON.stringify(j) : ''); };
    const origin = `http://127.0.0.1:${stub.address().port}`;
    if (req.url.startsWith('/t/smsf-hao/nnrf-disc/')) {
      return out(200, { nfInstances: [{ nfType: 'SMSF', nfServices: [{ serviceName: 'nsmsf-sms', apiRoot: `${origin}/smsf` }] }] });
    }
    if (req.url.startsWith('/t/smsf-hao/nnrf-nfm/')) return out(201, b);
    seen.push({ method: req.method, url: req.url, body: b });
    if (req.method === 'PUT' && req.url.endsWith('imsi-001010000000003')) return out(403, { status: 403, cause: 'SMS_NOT_ALLOWED' });
    if (req.method === 'PUT') return out(201, b);
    if (req.method === 'DELETE') return out(204);
    if (req.url.endsWith('/sendsms')) return out(200, {});
    return out(404, {});
  });
  process.env.TOMPA_BOARD_URL = `http://127.0.0.1:${stub.address().port}`;
  plugin = require('../../../board/plugins/tompa/index.js');
  amf = await listen(async (req, res) => {
    const path = req.url.replace(/^\/t\/tompa/, '').split('?')[0];
    if (!(await plugin.handle(req, res, { path }))) { res.writeHead(404); res.end(); }
  });
});

test.after(() => { stub.close(); amf.close(); });

async function api(method, path, b) {
  const r = await fetch(`http://127.0.0.1:${amf.address().port}/t/tompa${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b),
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

const UE1 = 'imsi-001010000000001';
const UE3 = 'imsi-001010000000003';
const n1n2 = (supi, hexPayload, smsRecordId = 'mt-1') => api('POST', `/namf-comm/v1/ue-contexts/${supi}/n1-n2-messages`,
  { n1MessageContainer: { n1MessageClass: 'SMS' }, smsRecordId, smsPayload: { hex: hexPayload } });

test('register activates SMS via the discovered SMSF; a refusal still registers the UE', async () => {
  const ok = await api('POST', `/ue/${UE1}/register`);
  assert.strictEqual(ok.body.state, 'REGISTERED');
  assert.strictEqual(ok.body.smsActive, true);
  assert.deepStrictEqual(seen.at(-1).body.supi, UE1);

  const refused = await api('POST', `/ue/${UE3}/register`);
  assert.strictEqual(refused.body.state, 'REGISTERED');
  assert.strictEqual(refused.body.smsActive, false);

  const k = (await api('GET', '/kpi')).body.registration;
  assert.strictEqual(k.smsActivationSuccessPct, 50);
  assert.deepStrictEqual(k.causes, { SMS_NOT_ALLOWED: 1 });
});

test('MO SMS sends RP-DATA uplink; refused when SMS is not active', async () => {
  const r = await api('POST', `/ue/${UE1}/sms`, { to: 'msisdn-46700000002', text: 'Hello' });
  assert.strictEqual(r.status, 200);
  const up = seen.at(-1);
  assert.match(up.url, /\/smsf\/nsmsf-sms\/v2\/ue-contexts\/imsi-001010000000001\/sendsms$/);
  assert.strictEqual(parseInt(up.body.jsonData.smsPayload.hex.slice(0, 2), 16), sms.RP.DATA_MS);
  assert.strictEqual(up.body.jsonData.smsPayload.text, 'Hello');

  assert.strictEqual((await api('POST', `/ue/${UE3}/sms`, { to: 'msisdn-46700000002', text: 'x' })).status, 409);
  assert.strictEqual((await api('POST', `/ue/${UE1}/sms`, { text: 'x' })).status, 400);
});

test('MT RP-DATA is delivered to the inbox and answered with RP-ACK on the uplink', async () => {
  const r = await n1n2(UE1, mtRpData(9, '46700000002', 'Hi UE1').rp, 'mt-ack');
  assert.deepStrictEqual(r, { status: 200, body: { cause: 'N1_N2_TRANSFER_INITIATED' } });
  await sleep(200);
  const up = seen.find(s => s.body && s.body.jsonData && s.body.jsonData.smsRecordId === 'mt-ack');
  assert.strictEqual(up.body.jsonData.smsPayload.hex.toUpperCase(), sms.rpAck(9));
  assert.strictEqual((await api('GET', `/ue/${UE1}/inbox`)).body[0].text, 'Hi UE1');
});

test('MT bare TPDU (no RP layer) is answered with RP-ERROR cause 111', async () => {
  await n1n2(UE1, mtRpData(9, '46700000002', 'Hi').tpdu, 'mt-bare');
  await sleep(200);
  const up = seen.find(s => s.body && s.body.jsonData && s.body.jsonData.smsRecordId === 'mt-bare');
  const b = Buffer.from(up.body.jsonData.smsPayload.hex, 'hex');
  assert.strictEqual(b[0] & 7, 4);
  assert.strictEqual(b.at(-1), 111);
});

test('boundary decoder flags the bare TPDU as a krilju fault and drafts a report; good MT stays ok', async () => {
  const faults = (await api('GET', '/faults')).body;
  assert.strictEqual(faults.length, 1);
  assert.strictEqual(faults[0].owner, 'krilju');
  assert.strictEqual(faults[0].hop, 'SMSF→AMF');
  assert.match(faults[0].finding, /bare SMS-DELIVER TPDU/);
  assert.match(faults[0].report, /^@krilju fault on SMSF→AMF/);
  const mtIn = (await api('GET', '/log')).body.filter(e => e.dir === 'in' && e.path.endsWith('/n1-n2-messages'));
  assert.deepStrictEqual(mtIn.map(e => e.diag.verdict), ['fault', 'ok']);
  const reg3 = (await api('GET', '/log')).body.find(e => e.dir === 'in' && e.method === 'PUT' && e.path.endsWith(UE3));
  assert.strictEqual(reg3.diag.verdict, 'expected');
  assert.deepStrictEqual((await api('GET', '/kpi')).body.peerFaults, { distinct: 1, byOwner: { krilju: 1 } });
});

test('N1N2 error causes: 400 missing IE, 404 no context, 504 unreachable', async () => {
  const rp = mtRpData(1, '46700000002', 'x').rp;
  const bad = await api('POST', `/namf-comm/v1/ue-contexts/${UE1}/n1-n2-messages`, { smsPayload: { hex: rp } });
  assert.strictEqual(bad.body.cause, 'MANDATORY_IE_MISSING');
  assert.strictEqual((await n1n2('imsi-001010000000002', rp)).body.cause, 'CONTEXT_NOT_FOUND');
  await api('POST', `/ue/${UE1}/reachable`, { reachable: false });
  assert.strictEqual((await n1n2(UE1, rp)).status, 504);
  const mt = (await api('GET', '/kpi')).body.mtSms;
  assert.strictEqual(mt.badRequest, 1);
  assert.strictEqual(mt.notFound, 1);
  assert.strictEqual(mt.notReachable, 1);
});

test('reachable again re-activates SMS at the SMSF (MWD alert trigger); deregister deactivates', async () => {
  const before = seen.length;
  const r = await api('POST', `/ue/${UE1}/reachable`, { reachable: true });
  assert.strictEqual(r.body.smsf.status, 201);
  assert.ok(seen.slice(before).some(s => s.method === 'PUT' && s.url.endsWith(UE1)));

  const d = await api('POST', `/ue/${UE1}/deregister`);
  assert.strictEqual(d.body.smsf.status, 204);
  assert.strictEqual(d.body.state, 'DEREGISTERED');
});
