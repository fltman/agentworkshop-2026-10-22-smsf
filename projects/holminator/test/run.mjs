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
const fake = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
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
  assert.equal(m.text, 'Hello'); assert.equal(m.mr, 10); assert.equal(m.status, 'ACCEPTED'); assert.equal(m.smsRecordId, 'r1');
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
  assert.ok(m.messages.total > 0 && m.messages.byStatus.ACCEPTED > 0 && m.messages.byDirection.MO > 0);
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

srv.close(); fake.close();
for (const tm of plugin._st.timers) clearInterval(tm);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
