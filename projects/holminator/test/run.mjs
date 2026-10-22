// Tests for the holminator SMSC plugin: node projects/holminator/test/run.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const tpdu = require(path.join(root, 'board/plugins/holminator/tpdu.js'));

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
}

// ---------- codec ----------
await t('GSM7 "Hello" packs to the well-known C8329BFD06', () => {
  const b = tpdu.encodeSubmit({ mr: 1, to: '46700000002', text: 'Hello' });
  assert.equal(tpdu.bytesToHex(b), '01010B916407000000F20000' + '05C8329BFD06');
});
await t('SMS-SUBMIT round trip, GSM7 and UCS2', () => {
  for (const text of ['Hello', 'Hej på dig!', 'Привет 👋', 'x'.repeat(160)]) {
    const s = tpdu.decodeSubmit(tpdu.encodeSubmit({ mr: 7, to: 'msisdn-46700000002', text, srr: true }));
    assert.equal(s.text, text); assert.equal(s.da, '46700000002'); assert.equal(s.mr, 7); assert.equal(s.srr, true);
  }
});
await t('SMS-DELIVER round trip', () => {
  const d = tpdu.decodeDeliver(tpdu.encodeDeliver({ from: '46700000001', text: 'Hi there' }));
  assert.equal(d.oa, '46700000001'); assert.equal(d.text, 'Hi there');
});
await t('decodeMo accepts a bare SMS-SUBMIT and an RP-DATA MS->N', () => {
  const sub = tpdu.encodeSubmit({ mr: 3, to: '46700000002', text: 'abc' });
  assert.equal(tpdu.decodeMo(tpdu.bytesToHex(sub)).submit.text, 'abc');
  const rp = [0x00, 0x05, 0x00, 0x07, 0x91, ...[0x64, 0x07, 0x00, 0x00, 0x00, 0xf0].slice(0, 6), sub.length, ...sub];
  const m = tpdu.decodeMo(tpdu.bytesToHex(rp));
  assert.equal(m.submit.text, 'abc'); assert.equal(m.rp.ref, 5);
});
await t('decodeMo rejects garbage', () => {
  assert.throws(() => tpdu.decodeMo('zz'));
  assert.throws(() => tpdu.decodeMo('02'));
});

// ---------- plugin over HTTP, with a fake NRF ----------
const nrfCalls = [];
let fakeStatus = 201;
// peers: set by the MT tests. Then the fake also answers NRF discovery and plays the UDM and the SMSF.
let peers = null;
const peerCalls = [];
const fake = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const u = new URL(req.url, 'http://x');
  if (peers) {
    const out = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname.includes('/nnrf-disc/')) return out(200, { nfInstances: peers.instances[u.searchParams.get('target-nf-type')] || [] });
    const m = u.pathname.match(/^\/(udm|smsf[A-Z])\/(.*)$/);
    if (m) {
      const call = { peer: m[1], path: '/' + m[2], body: JSON.parse(body || '{}'), at: Date.now() };
      peerCalls.push(call);
      const [status, b] = await peers[m[1].startsWith('smsf') ? 'smsf' : 'udm'](call);
      return out(status, b);
    }
  }
  nrfCalls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
  const status = req.method === 'PATCH' && fakeStatus === 201 ? 204 : req.method === 'PATCH' ? fakeStatus : 201;
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 204 ? '' : body || '{}');
});
await new Promise(r => fake.listen(0, r));
const fakeBase = `http://127.0.0.1:${fake.address().port}`;
// fake serves /t/<NRF_TEAM>/nnrf-nfm/v1/... on any path
process.env.SMSF_BOARD_URL = fakeBase;
process.env.NRF_TEAM = 'nrf';
const plugin = require(path.join(root, 'board/plugins/holminator/index.js'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holminator-'));
plugin.init({ dataDir });

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/t\/holminator/, '') || '/';
  const handled = await plugin.handle(req, res, { path: p, url });
  if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
});
await new Promise(r => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}/t/holminator`;
const j = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

await t('registers in the NRF as CUSTOM_SMSC with apiPrefix', async () => {
  await new Promise(r => setTimeout(r, 3500));
  const put = nrfCalls.find(c => c.method === 'PUT');
  assert.ok(put, 'no PUT to NRF');
  assert.equal(put.url, `/t/nrf/nnrf-nfm/v1/nf-instances/${plugin._internals.NF_ID}`);
  assert.equal(put.body.nfType, 'CUSTOM_SMSC');
  assert.equal(put.body.nfServices[0].apiPrefix, '/t/holminator');
  assert.equal(put.body.nfServices[0].apiRoot, `${fakeBase}/t/holminator`);
  assert.equal(put.body.fqdn, '127.0.0.1');
  assert.equal(put.body.heartBeatTimer, 30);
});
await t('heartbeat PATCHes [] and re-registers on 404', async () => {
  nrfCalls.length = 0;
  await plugin._internals.heartbeat();
  assert.equal(nrfCalls[0].method, 'PATCH'); assert.deepEqual(nrfCalls[0].body, []);
  nrfCalls.length = 0; fakeStatus = 404;
  await plugin._internals.heartbeat();
  fakeStatus = 201;
  assert.deepEqual(nrfCalls.map(c => c.method), ['PATCH', 'PUT']);
});
await t('baseOf prefers apiRoot, then absolute, then relative apiPrefix', () => {
  const b = plugin._internals.baseOf;
  assert.equal(b({ nfServices: [{ apiPrefix: 'https://h.example/t/tompa', apiRoot: 'https://h.examplehttps://h.example/t/tompa' }] }), 'https://h.example/t/tompa', 'a doubled apiRoot falls back to the absolute apiPrefix');
  assert.equal(b({ nfServices: [{ apiRoot: 'https://a/t/x/', apiPrefix: '/t/y' }] }), 'https://a/t/x');
  assert.equal(b({ nfServices: [{ apiPrefix: 'https://h/t/krilju' }] }), 'https://h/t/krilju');
  assert.equal(b({ nfServices: [{ apiPrefix: '/t/udm' }] }), `${fakeBase}/t/udm`);
  assert.equal(b({ nfServices: [{}] }), null);
});
await t('GET /status reports registration', async () => {
  const r = await j('GET', '/status');
  assert.equal(r.status, 200); assert.equal(r.body.registeredInNrf, true); assert.equal(r.body.scAddress, '46700000100');
});
await t('GET /api/messages and /api/log answer JSON arrays', async () => {
  assert.deepEqual((await j('GET', '/api/messages')).body, []);
  const log = (await j('GET', '/api/log')).body;
  assert.ok(Array.isArray(log) && log.some(e => e.peer === 'nrf'));
  const last = log[log.length - 1].id;
  assert.deepEqual((await j('GET', `/api/log?since=${last}`)).body, []);
});
await t('unknown route is 404', async () => { assert.equal((await j('GET', '/nope')).status, 404); });

// ---------- MO-Forward-Short-Message ----------
const SC = '46700000100';
const subHex = (o = {}) => tpdu.bytesToHex(tpdu.encodeSubmit({ mr: 1, to: '46700000002', text: 'Hello', ...o }));
const moBody = (o = {}) => ({ supi: 'imsi-001010000000001', msisdn: '46700000001', scAddress: SC, sms: { hex: subHex() }, smsRecordId: 'r1', ...o });
const report = hex => tpdu.hexToBytes(hex);

await t('MO: valid SMS-SUBMIT is accepted, stored and answered with an RP-ACK SUBMIT-REPORT', async () => {
  const r = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 10 }) } }));
  assert.equal(r.status, 200); assert.equal(r.body.result, 'SUCCESS'); assert.equal(r.body.diameterResultCode, 2001);
  const rep = report(r.body.deliveryReport.hex);
  assert.equal(rep[0], 0x01, 'SMS-SUBMIT-REPORT MTI'); assert.equal(rep[1], 0x00, 'TP-PI'); assert.equal(rep.length, 9, 'FO+PI+SCTS');
  const m = (await j('GET', '/api/messages')).body.find(x => x.id === r.body.messageId);
  assert.ok(m, 'not stored');
  assert.equal(m.direction, 'MO'); assert.equal(m.from, '46700000001'); assert.equal(m.to, '46700000002');
  assert.equal(m.text, 'Hello'); assert.equal(m.mr, 10); assert.equal(m.history[0].event, 'ACCEPTED'); assert.ok(['PENDING', 'DELIVERING', 'WAITING'].includes(m.status), m.status); assert.equal(m.smsRecordId, 'r1');
  const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  assert.ok(store.messages.some(x => x.id === m.id), 'not persisted');
});
await t('MO: RP-DATA MS->N wrapped SMS-SUBMIT is accepted, RP-DA checked', async () => {
  const sub = tpdu.encodeSubmit({ mr: 11, to: '46700000003', text: 'Wrapped' });
  const ok = tpdu.bytesToHex(tpdu.wrapRpDataToNetwork({ ref: 4, scAddress: SC, tpdu: sub }));
  const r = await j('POST', '/smsc/mo-forward-short-message', moBody({ scAddress: undefined, sms: { hex: ok } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const other = tpdu.bytesToHex(tpdu.wrapRpDataToNetwork({ ref: 5, scAddress: '46799999000', tpdu: sub }));
  const r2 = await j('POST', '/smsc/mo-forward-short-message', moBody({ scAddress: undefined, sms: { hex: other } }));
  assert.equal(r2.status, 403); assert.equal(r2.body.smDeliveryFailureCause.smEnumeratedDeliveryFailureCause, 'UNKNOWN_SERVICE_CENTRE');
});
await t('MO: wrong SC address is 5555 UNKNOWN_SERVICE_CENTRE (value 3), nothing stored', async () => {
  const before = (await j('GET', '/api/messages')).body.length;
  const r = await j('POST', '/smsc/mo-forward-short-message', moBody({ scAddress: '46711111111' }));
  assert.equal(r.status, 403); assert.equal(r.body.result, 'SM_DELIVERY_FAILURE'); assert.equal(r.body.diameterResultCode, 5555);
  assert.equal(r.body.smDeliveryFailureCause.value, 3);
  assert.equal((await j('GET', '/api/messages')).body.length, before);
});
await t('MO: missing sms.hex or user identity is 400 MISSING_AVP', async () => {
  for (const b of [moBody({ sms: undefined }), moBody({ supi: undefined, msisdn: undefined })]) {
    const r = await j('POST', '/smsc/mo-forward-short-message', b);
    assert.equal(r.status, 400); assert.equal(r.body.result, 'MISSING_AVP'); assert.equal(r.body.diameterResultCode, 5005);
  }
});
await t('MO: undecodable hex and non-JSON body are 400 UNEXPECTED_DATA_VALUE', async () => {
  const r = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: 'ZZ01' } }));
  assert.equal(r.status, 400); assert.equal(r.body.result, 'UNEXPECTED_DATA_VALUE');
  const raw = await fetch(base + '/smsc/mo-forward-short-message', { method: 'POST', body: '{not json' });
  assert.equal(raw.status, 400); assert.equal((await raw.json()).diameterResultCode, 5004);
});
await t('MO: duplicate with TP-RD=1 is rejected with TP-FCS C5, TP-RD=0 is accepted (TS 23.040 9.2.3.25)', async () => {
  const first = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 42 }) } }));
  assert.equal(first.status, 200);
  const dupRd = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 42, rd: true }) } }));
  assert.equal(dupRd.status, 403);
  assert.equal(dupRd.body.smDeliveryFailureCause.smEnumeratedDeliveryFailureCause, 'EQUIPMENT_PROTOCOL_ERROR');
  const rep = report(dupRd.body.deliveryReport.hex);
  assert.equal(rep[0], 0x01); assert.equal(rep[1], 0xc5, 'TP-FCS SM Rejected-Duplicate SM');
  const dupNoRd = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 42 }) } }));
  assert.equal(dupNoRd.status, 200);
  const m = (await j('GET', '/api/messages')).body.find(x => x.id === dupNoRd.body.messageId);
  assert.equal(m.duplicateOf, first.body.messageId);
  const otherDest = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 42, rd: true, to: '46700000004' }) } }));
  assert.equal(otherDest.status, 200, 'same MR to another TP-DA is not a duplicate');
});
await t('MO: relative TP-VP sets expiresAt (TS 23.040 9.2.3.12.1)', async () => {
  const r = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 50, vp: 0xa7 }) } }));
  const m = (await j('GET', '/api/messages')).body.find(x => x.id === r.body.messageId);
  const ms = Date.parse(m.expiresAt) - Date.parse(m.submittedAt);
  assert.equal(ms, 24 * 3600 * 1000, '0xA7 is 24 h');
  assert.equal(tpdu.decodeSubmit(tpdu.encodeSubmit({ to: '1', text: 'x', vp: 0 })).validityMs, 5 * 60000);
  assert.equal(tpdu.decodeSubmit(tpdu.encodeSubmit({ to: '1', text: 'x', vp: 0xad })).validityMs, 7 * 24 * 3600 * 1000);
  assert.equal(tpdu.decodeSubmit(tpdu.encodeSubmit({ to: '1', text: 'x', vp: 0xff })).validityMs, 63 * 7 * 24 * 3600 * 1000);
});
await t('MO: ?dryRun=1 validates and decodes but stores nothing', async () => {
  const before = (await j('GET', '/api/messages')).body.length;
  const r = await j('POST', '/smsc/mo-forward-short-message?dryRun=1', moBody({ sms: { hex: subHex({ mr: 77, srr: true }) } }));
  assert.equal(r.status, 200); assert.equal(r.body.dryRun, true); assert.equal(r.body.messageId, null);
  assert.equal(r.body.decoded.text, 'Hello'); assert.equal(r.body.decoded.srr, true); assert.equal(r.body.decoded.mr, 77);
  assert.equal((await j('GET', '/api/messages')).body.length, before);
  const bad = await j('POST', '/smsc/mo-forward-short-message?dryRun=1', moBody({ scAddress: '1' }));
  assert.equal(bad.status, 403, 'dry run still validates');
});
await t('MO: every forced scenario answers what /test says (fast ones)', async () => {
  const want = {
    UNKNOWN_SERVICE_CENTRE: [403, 5555, null], INVALID_SME_ADDRESS: [403, 5555, 0xc3], DUPLICATE: [403, 5555, 0xc5],
    SC_CONGESTION: [403, 5555, 0xc0], USER_NOT_SC_USER: [403, 5555, 0xc1], DESTINATION_BARRED: [403, 5555, 0xc4],
    SYSTEM_FAILURE: [403, 5555, 0xc2], FACILITY_NOT_SUPPORTED: [403, 5552, null], SERVER_ERROR: [500, 5012, null],
    SUCCESS: [200, 2001, null],
  };
  const listed = Object.keys((await j('GET', '/test')).body.moScenarios);
  for (const s of listed.filter(x => !['SLOW', 'NO_ANSWER'].includes(x))) assert.ok(want[s], `scenario ${s} has no test`);
  for (const [s, [status, code, fcs]] of Object.entries(want)) {
    const r = await j('POST', `/smsc/mo-forward-short-message?dryRun=1&scenario=${s.toLowerCase()}`, moBody());
    assert.equal(r.status, status, s); assert.equal(r.body.diameterResultCode, code, s);
    if (fcs === null && status !== 200) assert.equal(r.body.deliveryReport, undefined, `${s} must not carry a SUBMIT-REPORT`);
    else if (fcs !== null) assert.equal(report(r.body.deliveryReport.hex)[1], fcs, `${s} TP-FCS`);
  }
  const unknown = await j('POST', '/smsc/mo-forward-short-message?scenario=NOPE', moBody());
  assert.equal(unknown.status, 400);
});

// ---------- test endpoints ----------
await t('GET /test lists endpoints, and every MO example in it actually works (dry run)', async () => {
  const c = (await j('GET', '/test')).body;
  assert.equal(c.scAddress, SC);
  const mos = c.endpoints.filter(e => e.path.includes('mo-forward-short-message') && e.example);
  assert.ok(mos.length >= 2);
  for (const e of mos) {
    const r = await j('POST', '/smsc/mo-forward-short-message?dryRun=1', e.example);
    assert.equal(r.status, 200, `${e.what}: ${JSON.stringify(r.body)}`);
  }
  const dec = c.endpoints.find(e => e.path.endsWith('/test/decode'));
  assert.equal((await j('POST', '/test/decode', dec.example)).status, 200);
  const enc = c.endpoints.find(e => e.path.endsWith('/test/encode'));
  assert.equal((await j('POST', '/test/encode', enc.example)).status, 200);
});
await t('POST /test/encode and /test/decode round trip SUBMIT, DELIVER and RP-DATA', async () => {
  const e = (await j('POST', '/test/encode', { type: 'SUBMIT', to: '46700000002', text: 'Hello', mr: 1 })).body;
  assert.equal(e.tpduHex, '01010B916407000000F2000005C8329BFD06');
  const d = (await j('POST', '/test/decode', { hex: e.tpduHex })).body;
  assert.equal(d.tpdu.type, 'SMS-SUBMIT'); assert.equal(d.tpdu.text, 'Hello'); assert.equal(d.rp, null);
  const w = (await j('POST', '/test/encode', { type: 'DELIVER', from: '46700000001', text: 'Hej på dig', rp: true })).body;
  const dw = (await j('POST', '/test/decode', { hex: w.rpDataHex })).body;
  assert.equal(dw.rp.rpMessage, 'RP-DATA (N->MS)'); assert.equal(dw.rp.rpOa, SC);
  assert.equal(dw.tpdu.text, 'Hej på dig'); assert.equal(dw.tpdu.oa, '46700000001');
  const sw = (await j('POST', '/test/encode', { type: 'SUBMIT', to: '46700000002', text: 'x', rp: true })).body;
  assert.equal((await j('POST', '/test/decode', { hex: sw.rpDataHex })).body.rp.rpDa, SC);
  assert.equal((await j('POST', '/test/decode', { hex: 'nothex' })).status, 400);
  assert.equal((await j('POST', '/test/encode', { type: 'SUBMIT', text: 'no to' })).status, 400);
  assert.equal((await j('POST', '/test/encode', { type: 'BOGUS', to: '1', text: 'x' })).status, 400);
});

// ---------- metrics ----------
await t('metrics count MO accepted/rejected, results per cause, per-peer traffic and NRF heartbeats', async () => {
  const before = (await j('GET', '/api/metrics')).body;
  await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 90 }) } }));
  await j('POST', '/smsc/mo-forward-short-message', moBody({ scAddress: '1' }));
  await plugin._internals.heartbeat();
  const m = (await j('GET', '/api/metrics')).body;
  const d = k => (m.counters[k] || 0) - (before.counters[k] || 0);
  assert.equal(d('mo_received'), 2); assert.equal(d('mo_accepted'), 1); assert.equal(d('mo_rejected'), 1);
  assert.equal(d('nrf_heartbeats_ok'), 1);
  const res = m.results['MO-Forward-Short-Message'];
  assert.ok(res.SUCCESS >= 1); assert.ok(res['SM_DELIVERY_FAILURE/UNKNOWN_SERVICE_CENTRE'] >= 1);
  assert.equal(m.peers.smsf.in - before.peers.smsf.in, 2); assert.equal(m.peers.smsf.out - before.peers.smsf.out, 2);
  assert.ok(m.peers.nrf.calls > 0 && m.peers.nrf.latencyMsAvg !== null);
  assert.equal(m.nrf.registered, true); assert.equal(m.nrf.lastHeartbeatStatus, 204);
  assert.ok(m.messages.total > 0 && m.messages.byDirection.MO > 0 && Object.keys(m.messages.byStatus).length > 0);
  assert.ok(m.uptimeS >= 0);
});
await t('GET /metrics is Prometheus text with escaped labels', async () => {
  const r = await fetch(base + '/metrics');
  assert.match(r.headers.get('content-type'), /text\/plain/);
  const txt = await r.text();
  assert.match(txt, /^smsc_up 1$/m);
  assert.match(txt, /^smsc_mo_received_total \d+$/m);
  assert.match(txt, /^smsc_results_total\{operation="MO-Forward-Short-Message",result="SUCCESS"\} \d+$/m);
  assert.match(txt, /^smsc_peer_requests_in_total\{peer="smsf"\} \d+$/m);
  for (const line of txt.trim().split('\n')) assert.match(line, /^smsc_[a-z_]+(\{[^}]*\})? \d+$/, line);
});
await t('log entries carry direction, peer and latency for outgoing calls', async () => {
  const log = (await j('GET', '/api/log?since=0')).body;
  assert.ok(log.some(e => e.dir === 'in' && e.peer === 'smsf' && e.what.includes('mo-forward')));
  assert.ok(log.some(e => e.dir === 'out' && e.peer === 'smsf' && e.status === 200));
  assert.ok(log.some(e => e.dir === 'in' && e.peer === 'nrf' && typeof e.ms === 'number'));
});

// ---------- MT: SRI-for-SM, MT-Forward, MWD, alert, status reports (fake UDM, SMSF and NRF discovery) ----------
await t('codec: SMS-STATUS-REPORT round trip with SCTS, DT and TP-ST', () => {
  const sc = new Date('2026-10-22T08:15:30Z'), dt = new Date('2026-10-22T08:16:01Z');
  const b = tpdu.encodeStatusReport({ mr: 42, ra: '46700000002', sctsDate: sc, dtDate: dt, st: 0x46 });
  assert.equal(b[0] & 3, 2); assert.equal(b[0] & 0x20, 0, 'TP-SRQ must be 0 (result of an SMS-SUBMIT)');
  const d = tpdu.decodeStatusReport(b);
  assert.deepEqual([d.mr, d.ra, d.scts, d.dt, d.st, d.moreToSend], [42, '46700000002', sc.toISOString(), dt.toISOString(), 0x46, false]);
  assert.equal(tpdu.decodeAny(tpdu.bytesToHex(b)).tpdu.type, 'SMS-STATUS-REPORT');
});
await t('codec: SMS-DELIVER carries TP-MMS (inverted), TP-SRI and SCTS', () => {
  const date = new Date('2026-10-22T08:15:30Z');
  const more = tpdu.decodeDeliver(tpdu.encodeDeliver({ from: '46700000001', text: 'a', sri: true, date, moreToSend: true }));
  assert.equal(more.moreToSend, true); assert.equal(more.sri, true); assert.equal(more.scts, date.toISOString());
  const last = tpdu.encodeDeliver({ from: '46700000001', text: 'a', date });
  assert.equal(last[0] & 0x04, 0x04, 'TP-MMS=1 means no more messages'); assert.equal(tpdu.decodeDeliver(last).sri, false);
});
await t('codec: RP-ERROR cause is read, anything else gives null', () => {
  assert.equal(tpdu.rpErrorCause('04050116'), 22);
  assert.equal(tpdu.rpErrorCause('0305'), null);
  assert.equal(tpdu.rpErrorCause('zz'), null);
});

const udmRules = {}; // msisdn -> [status, body] for SRI-for-SM
const smsfRules = {}; // msisdn -> [status, body] or async fn for MT-Forward
let smsfInFlight = 0, smsfMaxInFlight = 0;
peers = {
  instances: {
    UDM: [{ nfInstanceId: 'udm-1', nfServices: [{ apiRoot: `${fakeBase}/udm` }] }],
    SMSF: [{ nfInstanceId: 'smsf-other', nfServices: [{ apiRoot: `${fakeBase}/smsfX` }] },
      { nfInstanceId: 'smsf-A', nfServices: [{ apiRoot: `${fakeBase}/smsfA` }] }],
  },
  async udm(c) {
    if (c.path.endsWith('send-routing-info-for-sm')) {
      return udmRules[c.body.msisdn] || [200, { imsi: `00101${c.body.msisdn}`, supi: `imsi-00101${c.body.msisdn}`, servingNode: { nodeType: 'SMSF', smsfInstanceId: 'smsf-A' }, mwdStatus: [] }];
    }
    return [200, { storedMsisdn: c.body.msisdn }];
  },
  async smsf(c) {
    smsfInFlight++; smsfMaxInFlight = Math.max(smsfMaxInFlight, smsfInFlight);
    try {
      const r = smsfRules[c.body.msisdn];
      if (typeof r === 'function') return await r(c);
      return r || [200, { result: 'SUCCESS', deliveryReport: { hex: '02050000' } }];
    } finally { smsfInFlight--; }
  },
};
const waitFor = async (fn, ms = 5000) => {
  const until = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 50)); }
};
const msg = async id => (await j('GET', `/api/messages/${id}`)).body;
const callsFor = (msisdn, pathPart) => peerCalls.filter(c => c.body.msisdn === msisdn && c.path.includes(pathPart));

await t('MT dry run builds the SMS-DELIVER and stores nothing', async () => {
  const before = (await j('GET', '/api/messages')).body.length;
  const r = await j('POST', '/api/mt?dryRun=1', { to: '46700000111', text: 'dry' });
  assert.equal(r.status, 200); assert.equal(r.body.decoded.text, 'dry'); assert.equal(r.body.decoded.oa, '46700000100');
  assert.equal((await j('GET', '/api/messages')).body.length, before);
  assert.equal(callsFor('46700000111', '').length, 0);
});
await t('MT: SRI-for-SM to the UDM, MT-Forward to the serving SMSF by instance id, DELIVERED', async () => {
  const r = await j('POST', '/api/mt?wait=1', { from: '12345', to: '46700000112', text: 'Hello MT' });
  assert.equal(r.status, 200); assert.equal(r.body.result, 'DELIVERED', JSON.stringify(r.body.message && r.body.message.history));
  const [sri] = callsFor('46700000112', 'send-routing-info-for-sm');
  assert.deepEqual([sri.body.scAddress, sri.body.smRpMti, sri.body.smRpPri], ['46700000100', 0, false]);
  const fwd = callsFor('46700000112', 'mt-forward-short-message');
  assert.equal(fwd.length, 1); assert.equal(fwd[0].peer, 'smsfA', 'must use the SMSF the UDM named, not the first one');
  assert.equal(fwd[0].body.supi, 'imsi-0010146700000112'); assert.equal(fwd[0].body.smsRecordId, `${r.body.messageId}-1`);
  const d = tpdu.decodeDeliver(tpdu.hexToBytes(fwd[0].body.sms.hex));
  assert.deepEqual([d.oa, d.text, d.moreToSend], ['12345', 'Hello MT', false]);
  assert.equal(callsFor('46700000112', 'report-sm-delivery-status').length, 0, 'no MWD report when nothing was absent');
});
await t('MT: missing to or text is 400, text over one SM is 400', async () => {
  assert.equal((await j('POST', '/api/mt', { text: 'x' })).status, 400);
  assert.equal((await j('POST', '/api/mt', { to: '46700000113' })).status, 400);
  assert.equal((await j('POST', '/api/mt', { to: '46700000113', text: 'x'.repeat(161) })).status, 400);
});
await t('MO is delivered as MT; TP-SRR gives a status report back with TP-ST 00, same MR, RA and SCTS as the SUBMIT-REPORT', async () => {
  const hex = tpdu.bytesToHex(tpdu.encodeSubmit({ mr: 77, to: '46700000114', text: 'with report', srr: true }));
  const mo = await j('POST', '/smsc/mo-forward-short-message', { msisdn: '46700000115', scAddress: '46700000100', sms: { hex } });
  assert.equal(mo.status, 200);
  const m = await waitFor(async () => { const x = await msg(mo.body.messageId); return x.status === 'DELIVERED' && x.statusReportId && x; });
  const deliver = tpdu.decodeDeliver(tpdu.hexToBytes(callsFor('46700000114', 'mt-forward')[0].body.sms.hex));
  assert.deepEqual([deliver.oa, deliver.text, deliver.sri], ['46700000115', 'with report', true]);
  const sr = await waitFor(async () => { const x = await msg(m.statusReportId); return x.status === 'DELIVERED' && x; });
  const fwd = callsFor('46700000115', 'mt-forward');
  assert.equal(fwd.length, 1, 'the status report goes to the originator');
  assert.equal(callsFor('46700000115', 'send-routing-info')[0].body.smRpMti, 1, 'SRI for a status report has SM-RP-MTI 1');
  const rep = tpdu.decodeStatusReport(tpdu.hexToBytes(fwd[0].body.sms.hex));
  const ackScts = tpdu.decodeDeliver([0x00, 0x00, 0x80, 0x00, 0x00, ...tpdu.hexToBytes(mo.body.deliveryReport.hex).slice(2, 9), 0]).scts;
  assert.deepEqual([rep.mr, rep.ra, rep.st, rep.scts], [77, '46700000114', 0x00, ackScts]);
  assert.equal(sr.reportFor, m.id);
});
await t('MT: absent at SRI (UDM keeps us in MWD) -> WAITING; Alert-Service-Centre -> delivered, SUCCESSFUL_TRANSFER reported', async () => {
  udmRules['46700000116'] = [404, { result: 'ABSENT_SUBSCRIBER_SM', diameterResultCode: 5550 }];
  const r = await j('POST', '/api/mt?wait=1', { to: '46700000116', text: 'later' });
  assert.equal(r.body.result, 'WAITING');
  delete udmRules['46700000116'];
  const a = await j('POST', '/smsc/alert-service-centre', { msisdn: '46700000116', scAddress: '46700000100', alertReason: 'UE_PRESENT' });
  assert.equal(a.status, 200); assert.deepEqual(a.body.redelivering, [r.body.messageId]);
  await waitFor(async () => (await msg(r.body.messageId)).status === 'DELIVERED');
  const rep = await waitFor(() => callsFor('46700000116', 'report-sm-delivery-status')[0]);
  assert.equal(rep.body.deliveryOutcome, 'SUCCESSFUL_TRANSFER');
});
await t('MT: absent at the SMSF -> Report-SM-Delivery-Status ABSENT_SUBSCRIBER, WAITING', async () => {
  smsfRules['46700000117'] = [504, { result: 'ABSENT_SUBSCRIBER', cause: 'UE not reachable' }];
  const r = await j('POST', '/api/mt?wait=1', { to: '46700000117', text: 'x' });
  assert.equal(r.body.result, 'WAITING');
  const rep = await waitFor(() => callsFor('46700000117', 'report-sm-delivery-status')[0]);
  assert.deepEqual([rep.body.deliveryOutcome, rep.body.scAddress], ['ABSENT_SUBSCRIBER', '46700000100']);
});
await t('MT: UE answers RP-ERROR memory capacity exceeded -> MEMORY_CAPACITY_EXCEEDED to the UDM, WAITING', async () => {
  smsfRules['46700000118'] = [502, { result: 'FAILURE', cause: 'UE answered RP-ERROR', deliveryReport: { hex: '04050116' } }];
  const r = await j('POST', '/api/mt?wait=1', { to: '46700000118', text: 'x' });
  assert.equal(r.body.result, 'WAITING');
  assert.equal((await waitFor(() => callsFor('46700000118', 'report-sm-delivery-status')[0])).body.deliveryOutcome, 'MEMORY_CAPACITY_EXCEEDED');
});
await t('MT: other RP-ERROR -> FAILED; unknown, barred and not provisioned subscribers -> FAILED', async () => {
  smsfRules['46700000119'] = [502, { result: 'FAILURE', deliveryReport: { hex: '0405016F' } }];
  assert.equal((await j('POST', '/api/mt?wait=1', { to: '46700000119', text: 'x' })).body.result, 'FAILED');
  for (const [n, res, st] of [['46700000120', 'UNKNOWN_SUBSCRIBER', 404], ['46700000121', 'CALL_BARRED', 403], ['46700000122', 'TELESERVICE_NOT_PROVISIONED', 403]]) {
    udmRules[n] = [st, { result: res }];
    const r = await j('POST', '/api/mt?wait=1', { to: n, text: 'x' });
    assert.equal(r.body.result, 'FAILED', res);
    assert.equal(callsFor(n, 'mt-forward').length, 0);
  }
});
await t('MO with TP-SRR to an unknown subscriber -> status report TP-ST 43 (not obtainable) to the originator', async () => {
  udmRules['46799999999'] = [404, { result: 'UNKNOWN_SUBSCRIBER' }];
  const hex = tpdu.bytesToHex(tpdu.encodeSubmit({ mr: 5, to: '46799999999', text: 'nobody', srr: true }));
  const mo = await j('POST', '/smsc/mo-forward-short-message', { msisdn: '46700000123', sms: { hex } });
  const m = await waitFor(async () => { const x = await msg(mo.body.messageId); return x.status === 'FAILED' && x.statusReportId && x; });
  await waitFor(async () => (await msg(m.statusReportId)).status === 'DELIVERED');
  const rep = tpdu.decodeStatusReport(tpdu.hexToBytes(callsFor('46700000123', 'mt-forward')[0].body.sms.hex));
  assert.deepEqual([rep.st, rep.mr, rep.ra], [0x43, 5, '46799999999']);
});
await t('MT: only one SMS-DELIVER outstanding per MS; TP-MMS says more are waiting; SCTS unique per MS', async () => {
  smsfRules['46700000124'] = async () => { await new Promise(r => setTimeout(r, 200)); return [200, { result: 'SUCCESS' }]; };
  smsfMaxInFlight = 0;
  const ids = [];
  for (const text of ['one', 'two', 'three']) ids.push((await j('POST', '/api/mt', { to: '46700000124', text })).body.messageId);
  await waitFor(async () => (await Promise.all(ids.map(msg))).every(x => x.status === 'DELIVERED'));
  assert.equal(smsfMaxInFlight, 1);
  const delivers = callsFor('46700000124', 'mt-forward').map(c => tpdu.decodeDeliver(tpdu.hexToBytes(c.body.sms.hex)));
  assert.deepEqual(delivers.map(d => d.text), ['one', 'two', 'three'], 'in order');
  assert.equal(delivers[0].moreToSend, true); assert.equal(delivers[2].moreToSend, false);
  assert.equal(new Set(delivers.map(d => d.scts)).size, 3);
});
await t('MT: SMSF not in the NRF under the named instance id -> no MT-Forward to another SMSF, retry later', async () => {
  udmRules['46700000125'] = [200, { supi: 'imsi-001010000000125', servingNode: { smsfInstanceId: 'smsf-gone' } }];
  const r = await j('POST', '/api/mt?wait=1', { to: '46700000125', text: 'x' });
  assert.equal(r.body.result, 'WAITING'); assert.ok(r.body.message.nextRetryAt);
  assert.equal(callsFor('46700000125', 'mt-forward').length, 0);
});
await t('MT: UDM failure -> WAITING with backoff; the sweep retries when due and delivers', async () => {
  udmRules['46700000126'] = [500, { result: 'SYSTEM_FAILURE' }];
  const r = await j('POST', '/api/mt?wait=1', { to: '46700000126', text: 'retry me' });
  assert.equal(r.body.result, 'WAITING');
  assert.ok(Date.parse(r.body.message.nextRetryAt) - Date.now() > 20000, 'first retry about 30 s out');
  delete udmRules['46700000126'];
  plugin._st.messages.find(x => x.id === r.body.messageId).nextRetryAt = new Date(Date.now() - 1).toISOString();
  plugin._internals.sweep();
  await waitFor(async () => (await msg(r.body.messageId)).status === 'DELIVERED');
});
await t('MT: validity period ends while WAITING -> EXPIRED, never sent', async () => {
  udmRules['46700000127'] = [404, { result: 'ABSENT_SUBSCRIBER_SM' }];
  const r = await j('POST', '/api/mt?wait=1', { to: '46700000127', text: 'x', validitySeconds: 1 });
  assert.equal(r.body.result, 'WAITING');
  await new Promise(res => setTimeout(res, 1100));
  plugin._internals.sweep();
  assert.equal((await msg(r.body.messageId)).status, 'EXPIRED');
  assert.equal(callsFor('46700000127', 'mt-forward').length, 0);
});
await t('Alert-Service-Centre: msisdn missing is 400 MISSING_AVP, another SC address is 400, nothing waiting is 200 with no ids', async () => {
  assert.equal((await j('POST', '/smsc/alert-service-centre', { scAddress: '46700000100' })).body.diameterResultCode, 5005);
  assert.equal((await j('POST', '/smsc/alert-service-centre', { msisdn: '46700000116', scAddress: '4699' })).status, 400);
  const r = await j('POST', '/smsc/alert-service-centre', { msisdn: '46700000199', scAddress: '46700000100' });
  assert.equal(r.status, 200); assert.deepEqual(r.body.redelivering, []);
});
await t('MT metrics: originated, delivered, failed, absent, SRI, status reports, alerts', async () => {
  const c = (await j('GET', '/api/metrics')).body.counters;
  for (const k of ['mt_originated', 'mt_delivered', 'mt_failed', 'mt_absent', 'sri_requests', 'status_reports_sent', 'status_reports_generated', 'alerts_received', 'udm_delivery_reports', 'mt_expired', 'mt_retries_scheduled']) {
    assert.ok(c[k] > 0, `${k} is ${c[k]}`);
  }
  const res = (await j('GET', '/api/metrics')).body.results;
  assert.ok(res['SRI-for-SM'] && res['MT-Forward-Short-Message'] && res['Alert-Service-Centre']);
});

await t('GET /log: shared call-flow shape, newest first, paths without origin', async () => {
  const r = await j('GET', '/log');
  assert.equal(r.status, 200);
  const log = r.body;
  assert.ok(Array.isArray(log) && log.length > 2);
  for (let i = 1; i < log.length; i++) assert.ok(log[i - 1].ts >= log[i].ts && log[i - 1].id > log[i].id, 'newest first');
  for (const e of log) for (const k of ['ts', 'dir', 'peer', 'method', 'path', 'status', 'body']) assert.ok(k in e, `field ${k}`);
  const call = log.find(e => e.dir === 'out' && e.peer === 'udm' && e.method === 'POST');
  assert.ok(call && call.path.startsWith('/') && !call.path.includes('://'), 'outbound path is a pathname');
  const mo = log.find(e => e.dir === 'in' && e.peer === 'smsf' && e.path === '/smsc/mo-forward-short-message');
  assert.ok(mo && mo.method === 'POST' && mo.body, 'inbound MO request');
  const ans = log.find(e => e.dir === 'out' && e.method === null && e.status === 200);
  assert.ok(ans && !ans.path.startsWith('answer'), 'answers carry the operation as path');
  assert.equal((await j('GET', '/log?limit=2')).body.length, 2);
});
srv.close(); fake.close();
for (const tm of plugin._st.timers) clearInterval(tm);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
