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
  assert.equal(m.text, 'Hello'); assert.equal(m.mr, 10); assert.equal(m.history[0].event, 'ACCEPTED'); assert.equal(m.status, 'FORWARDED'); assert.equal(m.history.at(-1).detail, 'simulated onward delivery to 46700000002'); assert.equal(m.smsRecordId, 'r1');
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
  assert.equal(d('mo_forwarded'), 1); assert.equal(d('mt_originated'), 0, 'an MO without SRR originates no MT');
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
await t('codec: decodeAny reads RP-ACK/RP-ERROR and SUBMIT-/DELIVER-REPORT (live samples)', () => {
  const sr = tpdu.decodeAny('010062012280055500').tpdu; // SMSC deliveryReport.hex, bare SUBMIT-REPORT for RP-ACK
  assert.deepEqual([sr.type, sr.variant, sr.pi, sr.scts, sr.fcs], ['SMS-SUBMIT-REPORT', 'RP-ACK', 0, '2026-10-22T08:50:55.000Z', undefined]);
  const ack = tpdu.decodeAny('03014109010062012280055500'); // SMSF->UE smsPayload: RP-ACK N->MS, MR 1, RP-User-Data
  assert.deepEqual(ack.rp, { rpMessage: 'RP-ACK (N->MS)', rpRef: 1 });
  assert.equal(ack.tpdu.type, 'SMS-SUBMIT-REPORT'); assert.equal(ack.tpdu.hex, '010062012280055500');
  assert.deepEqual(tpdu.decodeAny('0301'), { rp: { rpMessage: 'RP-ACK (N->MS)', rpRef: 1 }, tpdu: null });
  const date = new Date('2026-10-22T08:50:55Z');
  const se = tpdu.decodeAny(tpdu.bytesToHex(tpdu.encodeSubmitReportError(tpdu.FCS.SC_BUSY, date))).tpdu;
  assert.deepEqual([se.type, se.variant, se.fcs, se.fcsName, se.scts], ['SMS-SUBMIT-REPORT', 'RP-ERROR', 0xc0, 'SC_BUSY', date.toISOString()]);
  assert.equal(tpdu.decodeAny(tpdu.bytesToHex(tpdu.encodeSubmitReportAck(date))).tpdu.variant, 'RP-ACK');
  // RP-ERROR MS->N, MR 5, cause 22 + DELIVER-REPORT for RP-ERROR with FCS D0 and TP-PI=0.
  const de = tpdu.decodeAny('04050116410300D000');
  assert.deepEqual(de.rp, { rpMessage: 'RP-ERROR (MS->N)', rpRef: 5, rpCause: 22, rpCauseName: 'Memory capacity exceeded' });
  assert.deepEqual([de.tpdu.type, de.tpdu.variant, de.tpdu.fcs, de.tpdu.pi], ['SMS-DELIVER-REPORT', 'RP-ERROR', 0xd0, 0]);
  // RP-ERROR N->MS with diagnostic, no user data.
  assert.deepEqual(tpdu.decodeAny('05090229FF').rp, { rpMessage: 'RP-ERROR (N->MS)', rpRef: 9, rpCause: 41, rpCauseName: 'Temporary failure', rpDiagnostic: 0xff });
  // DELIVER-REPORT for RP-ACK with PID, DCS and 7-bit UD (TP-PI=07).
  const dr = tpdu.decodeAny('0207410A0007000005C8329BFD06').tpdu;
  assert.deepEqual([dr.type, dr.variant, dr.pid, dr.dcs, dr.udl, dr.text], ['SMS-DELIVER-REPORT', 'RP-ACK', 0, 0, 5, 'Hello']);
  // Hints: kind forces the report reading, direction orders the attempts; plain SUBMIT/DELIVER still win without one.
  assert.equal(tpdu.decodeAny('0000', { kind: 'deliver-report' }).tpdu.type, 'SMS-DELIVER-REPORT');
  assert.equal(tpdu.decodeAny('010062012280055500', { direction: 'SC->MS' }).tpdu.type, 'SMS-SUBMIT-REPORT');
  assert.equal(tpdu.decodeAny('01010B916407000000F2000005C8329BFD06').tpdu.type, 'SMS-SUBMIT');
  const dl = tpdu.bytesToHex(tpdu.encodeDeliver({ from: '46700000001', text: 'Hi', date }));
  assert.equal(dl.slice(0, 2), '04', 'DELIVER FO 0x04 looks like RP-ERROR MS->N by its low bits');
  assert.equal(tpdu.decodeAny(dl).tpdu.type, 'SMS-DELIVER');
  assert.throws(() => tpdu.decodeAny('0401'), /./);
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
await t('MO terminates at the SMSC (FORWARDED, no MT to TP-DA); TP-SRR gives a status report back with TP-ST 00, same MR, RA and SCTS as the SUBMIT-REPORT', async () => {
  const hex = tpdu.bytesToHex(tpdu.encodeSubmit({ mr: 77, to: '46700000114', text: 'with report', srr: true }));
  const mo = await j('POST', '/smsc/mo-forward-short-message', { msisdn: '46700000115', scAddress: '46700000100', sms: { hex } });
  assert.equal(mo.status, 200);
  const m = await waitFor(async () => { const x = await msg(mo.body.messageId); return x.status === 'FORWARDED' && x.statusReportId && x; });
  assert.equal(callsFor('46700000114', '').length, 0, 'no SRI and no MT-Forward towards TP-DA');
  const sr = await waitFor(async () => { const x = await msg(m.statusReportId); return x.status === 'DELIVERED' && x; });
  assert.deepEqual([sr.direction, sr.kind], ['MT', 'STATUS_REPORT']);
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
  smsfRules['46700000119'] = [502, { result: 'FAILURE', deliveryReport: { hex: '04050115' } }]; // cause 21: permanent
  assert.equal((await j('POST', '/api/mt?wait=1', { to: '46700000119', text: 'x' })).body.result, 'FAILED');
  for (const [n, res, st] of [['46700000120', 'UNKNOWN_SUBSCRIBER', 404], ['46700000121', 'CALL_BARRED', 403], ['46700000122', 'TELESERVICE_NOT_PROVISIONED', 403]]) {
    udmRules[n] = [st, { result: res }];
    const r = await j('POST', '/api/mt?wait=1', { to: n, text: 'x' });
    assert.equal(r.body.result, 'FAILED', res);
    assert.equal(callsFor(n, 'mt-forward').length, 0);
  }
});
await t('MO with TP-SRR to an unknown subscriber: no SRI for TP-DA, FORWARDED, status report TP-ST 00 to the originator', async () => {
  udmRules['46799999999'] = [404, { result: 'UNKNOWN_SUBSCRIBER' }];
  const hex = tpdu.bytesToHex(tpdu.encodeSubmit({ mr: 5, to: '46799999999', text: 'nobody', srr: true }));
  const mo = await j('POST', '/smsc/mo-forward-short-message', { msisdn: '46700000123', sms: { hex } });
  const m = await waitFor(async () => { const x = await msg(mo.body.messageId); return x.status === 'FORWARDED' && x.statusReportId && x; });
  await waitFor(async () => (await msg(m.statusReportId)).status === 'DELIVERED');
  delete udmRules['46799999999'];
  assert.equal(callsFor('46799999999', '').length, 0, 'the MO never looks up TP-DA');
  const rep = tpdu.decodeStatusReport(tpdu.hexToBytes(callsFor('46700000123', 'mt-forward')[0].body.sms.hex));
  assert.deepEqual([rep.st, rep.mr, rep.ra], [0x00, 5, '46799999999']);
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
// ---------- observability: /kpi, /api/messages?limit&since, tile-marked /test/decode ----------
await t('GET /kpi: common shape, requests and errors derived from answers and peer errors, extra from counters and store', async () => {
  const k0 = (await j('GET', '/kpi')).body;
  for (const f of ['nf', 'up', 'requests', 'errors', 'latencyMs', 'extra']) assert.ok(f in k0, `field ${f}`);
  assert.equal(k0.nf, 'SMSC'); assert.equal(k0.up, true);
  for (const f of ['requests', 'errors', 'latencyMs']) assert.equal(typeof k0[f], 'number', f);
  assert.deepEqual(Object.keys(k0.extra).sort(), ['alerts_received', 'consistent', 'mo_accepted', 'mt_delivered', 'mt_failed', 'pdus_in', 'pdus_out', 'registeredInNrf', 'status_reports_sent', 'waiting']);
  const m = (await j('GET', '/api/metrics')).body;
  for (const f of ['mo_accepted', 'mt_delivered', 'mt_failed', 'status_reports_sent', 'alerts_received']) assert.equal(k0.extra[f], m.counters[f] || 0, f);
  assert.equal(k0.extra.registeredInNrf, m.nrf.registered);
  assert.equal(k0.extra.waiting, plugin._st.messages.filter(x => x.status === 'WAITING').length);
  const ps = Object.values(m.peers);
  const calls = ps.reduce((s, p) => s + p.calls, 0);
  assert.ok(calls > 0);
  assert.ok(Math.abs(k0.latencyMs - ps.reduce((s, p) => s + p.latencyMsSum, 0) / calls) <= 1, 'average outbound latency');
  assert.ok(k0.errors >= ps.reduce((s, p) => s + p.errors, 0), 'outbound peer errors are included');
  // one 200 answer and one 403 answer: requests +2, errors +1 (at least: background MT may add peer errors)
  assert.equal((await j('POST', '/smsc/alert-service-centre', { msisdn: '46700000198', scAddress: SC })).status, 200);
  assert.equal((await j('POST', '/smsc/mo-forward-short-message', moBody({ scAddress: '46799999999' }))).status, 403);
  const k1 = (await j('GET', '/kpi')).body;
  assert.equal(k1.requests - k0.requests, 2, 'inbound requests');
  assert.ok(k1.errors - k0.errors >= 1, 'a 403 answer is an error');
  const c1 = (await j('GET', '/api/metrics')).body.counters;
  assert.equal(c1.answers_error - (m.counters.answers_error || 0), 1, 'only the 403 is an answer error');
});
await t('GET /api/messages: ?limit=N newest N oldest first, ?since=id and ?since=ISO, bad values are 400', async () => {
  const ids = xs => xs.map(x => x.id);
  const T = new Date().toISOString();
  await new Promise(r => setTimeout(r, 5));
  const mo = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 77, to: '46700000197' }) } }));
  assert.equal(mo.status, 200);
  const all = await j('GET', '/api/messages');
  assert.equal(all.status, 200); assert.ok(all.body.length >= 3);
  assert.deepEqual(ids(all.body), ids(plugin._st.messages), 'no params: the whole store, oldest first');
  const two = (await j('GET', '/api/messages?limit=2')).body;
  assert.deepEqual(ids(two), ids(plugin._st.messages.slice(-2)), 'newest 2, oldest first');
  const pivot = plugin._st.messages[plugin._st.messages.length - 3].id;
  const after = (await j('GET', `/api/messages?since=${pivot}`)).body;
  const seq = id => Number(id.replace('smsc-', ''));
  assert.ok(after.length >= 2 && after.every(x => seq(x.id) > seq(pivot)), 'since=id: only newer ids');
  assert.deepEqual(ids((await j('GET', `/api/messages?since=${seq(pivot)}`)).body), ids(after), 'bare number works too');
  const upd = (await j('GET', `/api/messages?since=${encodeURIComponent(T)}`)).body;
  assert.ok(upd.some(x => x.id === mo.body.messageId), 'the message accepted after T');
  assert.ok(upd.every(x => x.history[x.history.length - 1].ts > T), 'every one updated after T');
  assert.ok(upd.length < all.body.length, 'older untouched messages are left out');
  assert.deepEqual((await j('GET', '/api/messages?since=2999-01-01T00:00:00Z')).body, []);
  const comb = (await j('GET', '/api/messages?since=1970-01-01T00:00:00Z&limit=1')).body;
  assert.deepEqual(ids(comb), ids(plugin._st.messages.slice(-1)));
  for (const q of ['limit=0', 'limit=abc', 'limit=1.5', 'since=yesterday']) {
    const r = await j('GET', `/api/messages?${q}`);
    assert.equal(r.status, 400, q); assert.ok(r.body.error, q);
  }
});
await t('POST /test/decode: tile calls (x-holminator-tile: 1) are not counted in test_requests, others are', async () => {
  const count = async () => (await j('GET', '/api/metrics')).body.counters.test_requests || 0;
  const hex = subHex();
  const dec = headers => fetch(`${base}/test/decode`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ hex }) });
  const c0 = await count();
  assert.equal((await dec({ 'x-holminator-tile': '1' })).status, 200);
  assert.equal(await count(), c0, 'tile call not counted');
  assert.equal((await dec({})).status, 200);
  assert.equal(await count(), c0 + 1, 'external call counted');
});
await t('GET /test lists /kpi and the /api/messages params; the tile polls with ?limit= and marks its calls', async () => {
  const c = (await j('GET', '/test')).body;
  const kp = c.endpoints.find(e => e.path.endsWith('/kpi'));
  assert.ok(kp && kp.method === 'GET');
  assert.equal((await j('GET', kp.path.replace('/t/holminator', ''))).body.nf, 'SMSC');
  const ms = c.endpoints.find(e => /\/api\/messages\?limit=/.test(e.path));
  assert.ok(ms && /since/.test(ms.what));
  assert.equal((await j('GET', ms.path.replace('/t/holminator', ''))).status, 200);
  const app = fs.readFileSync(path.join(root, 'board/public/colony/holminator/app.js'), 'utf8');
  assert.ok(/\/api\/messages\?limit=/.test(app), 'tile poll is bounded');
  assert.ok(/'x-holminator-tile': '1'/.test(app), 'tile marks its calls');
  assert.ok(!/innerHTML/.test(app.replace(/^\/\/.*$/gm, '')), 'no innerHTML in the tile');
});
// The tile's flow model and KPI cards are a pure block in app.js (between two marker comments): evaluate it alone.
await t('tile: MO flow ends at the SMSC, MT flow runs SMSC->UDM->SMSF->AMF->UE with the absent path, KPIs split MO/MT', async () => {
  const vm = await import('node:vm');
  const app = fs.readFileSync(path.join(root, 'board/public/colony/holminator/app.js'), 'utf8');
  const a = app.indexOf('// ---------- flow model (pure'), b = app.indexOf('// ---------- end flow model');
  assert.ok(a >= 0 && b > a, 'pure flow model block present');
  const ctx = vm.createContext({});
  vm.runInContext(`${app.slice(a, b)};this.api={flowModel,kpiCards,srIdOf,flowKind};`, ctx);
  const { flowModel, kpiCards, srIdOf } = ctx.api;
  const names = f => f.nodes.map(n => n.nm).join('>');
  const labels = f => f.nodes.map(n => `${n.edge || ''}|${n.back || ''}`).join(' ');

  const mo = flowModel({ id: 'smsc-1', direction: 'MO', kind: 'SMS', status: 'FORWARDED', from: '46700000001', to: '46700000002', statusReportId: 'smsc-2', history: [{ event: 'ACCEPTED' }, { event: 'FORWARDED' }] });
  assert.equal(mo.kind, 'MO');
  assert.equal(names(mo), 'UE>AMF>SMSF>SMSC>onward', 'MO stops at the SMSC, no UDM/SRI');
  assert.ok(!/SRI|MT-Forward/.test(labels(mo)), 'no SRI or MT-Forward on an MO');
  assert.ok(/MO-Forward-SM/.test(labels(mo)) && /RP-ACK/.test(labels(mo)) && /SUBMIT-REPORT/.test(labels(mo)));
  const end = mo.nodes[mo.nodes.length - 1];
  assert.equal(end.end, true); assert.equal(end.st, 'done'); assert.match(end.edge, /simulated onward/);
  assert.equal(mo.side, null);
  assert.equal(flowModel({ direction: 'MO', kind: 'SMS', status: 'ACCEPTED' }).nodes.at(-1).st, 'active');
  const moExp = flowModel({ direction: 'MO', kind: 'SMS', status: 'EXPIRED' }).nodes.at(-1);
  assert.equal(moExp.st, 'fail'); assert.match(moExp.sub, /expired/);
  assert.equal(srIdOf({ direction: 'MO', statusReportId: 'smsc-2' }), 'smsc-2');
  assert.equal(srIdOf({ direction: 'MO', sr: { id: 'smsc-9' } }), 'smsc-9');

  const h = (...ev) => ev.map(([event, detail]) => ({ event, detail }));
  const ok = flowModel({ direction: 'MT', kind: 'SMS', status: 'DELIVERED', to: '46700000002',
    history: h(['ACCEPTED'], ['DELIVERING'], ['SRI-for-SM', '200, imsi-1, serving SMSF x'], ['MT-Forward-Short-Message', '200 SUCCESS'], ['DELIVERED']) });
  assert.equal(ok.kind, 'MT');
  assert.equal(names(ok), 'SMSC>NRF>UDM>SMSF>AMF>UE');
  assert.ok(ok.nodes.every(n => n.st === 'done'));
  assert.equal(ok.nodes.at(-1).edge, 'SMS-DELIVER'); assert.match(ok.nodes.at(-1).back, /RP-ACK/);
  assert.equal(ok.side.taken, false);

  const rpErr = flowModel({ direction: 'MT', kind: 'SMS', status: 'FAILED', deliveryReportHex: '04', history: h(['DELIVERING'], ['SRI-for-SM', '200, x'], ['MT-Forward-Short-Message', '502 RP_ERROR'], ['FAILED']) });
  assert.equal(rpErr.nodes.at(-1).back, 'RP-ERROR'); assert.equal(rpErr.nodes.at(-1).backSt, 'fail'); assert.equal(rpErr.nodes.at(-1).st, 'fail');

  const absent = flowModel({ direction: 'MT', kind: 'SMS', status: 'PENDING', mwd: true,
    history: h(['DELIVERING'], ['SRI-for-SM', '200, x'], ['MT-Forward-Short-Message', '404 ABSENT_SUBSCRIBER'], ['Report-SM-Delivery-Status', 'ABSENT_SUBSCRIBER: 200'], ['WAITING'], ['ALERT', 'Alert-Service-Centre UE_PRESENT'], ['PENDING']) });
  assert.equal(absent.side.taken, true);
  assert.equal(absent.side.nodes.slice(1).map(n => n.edge.split(' ')[0]).join(), 'ReportSM-DeliveryStatus,Alert-SC');
  assert.equal(absent.side.nodes[2].est, 'done', 'Alert-SC received');
  assert.equal(absent.side.nodes[2].st, 'active', 'redelivery due');

  const sr = flowModel({ direction: 'MT', kind: 'STATUS_REPORT', status: 'PENDING', reportFor: 'smsc-1', history: [] });
  assert.equal(sr.kind, 'MT'); assert.equal(sr.nodes.at(-1).edge, 'SMS-STATUS-REPORT');

  const card = (cards, label) => cards.find(c => c.label === label);
  const msgs = [{ direction: 'MO', kind: 'SMS', status: 'FORWARDED' }, { direction: 'MO', kind: 'SMS', status: 'FORWARDED' }, { direction: 'MT', kind: 'STATUS_REPORT', status: 'DELIVERED' }];
  const old = kpiCards({ counters: { mo_accepted: 3, mt_originated: 5 } }, msgs);
  assert.equal(card(old, 'MO received').v, 3, 'falls back to mo_accepted'); assert.ok(card(old, 'MO received').est);
  assert.equal(card(old, 'MO forwarded').v, 2, 'falls back to the message window'); assert.ok(card(old, 'MO forwarded').est);
  const cur = kpiCards({ counters: { mo_received: 4, mo_forwarded: 7, mt_originated: 1 }, messages: { total: 3 } }, msgs);
  assert.equal(card(cur, 'MO received').v, 4); assert.equal(card(cur, 'MO forwarded').v, 7); assert.ok(!card(cur, 'MO forwarded').est);
  assert.equal(card(cur, 'MT originated').v, 1); assert.equal(card(cur, 'MT originated').grp, 'MT');
  assert.ok(cur.filter(c => c.grp === 'MT').every(c => !/^MO/.test(c.label)) && cur.filter(c => c.grp === 'MO').length === 2);
  assert.doesNotThrow(() => kpiCards({}, null), 'missing metrics do not throw');
  const subOf = (cards, label, what) => card(cards, label).subs.find(s => s[1] === what)[0];
  const exact = kpiCards({ counters: { mo_received: 1, mo_forwarded: 1, mo_expired: 2, mt_attempts_exhausted: 3, mt_alert_fast_retries: 4 } }, []);
  assert.equal(subOf(exact, 'MO forwarded', 'expired'), 2, 'mo_expired shown with MO');
  assert.equal(subOf(exact, 'MT failed', 'attempts exhausted'), 3);
  assert.equal(subOf(exact, 'MT waiting', 'fast retries'), 4);
  const html = fs.readFileSync(path.join(root, 'board/public/colony/holminator/index.html'), 'utf8');
  assert.match(html, /<form id="mtform"[\s\S]*name="singleShot"[\s\S]*<\/form>/, 'MT form offers singleShot');
  assert.match(app, /singleShot: f\.singleShot\.checked/, 'POST /api/mt sends singleShot');
});
await t('tile: PDU, RP-Cause, status report, SGd and consistency panels read /api/metrics defensively ("–" when missing)', async () => {
  const vm = await import('node:vm');
  const app = fs.readFileSync(path.join(root, 'board/public/colony/holminator/app.js'), 'utf8');
  const a = app.indexOf('// ---------- flow model (pure'), b = app.indexOf('// ---------- end flow model');
  const ctx = vm.createContext({});
  vm.runInContext(`${app.slice(a, b)};this.api={pduTable,rpCauses,srPanel,sgdOps,consistencyBadge,countersSince,stInfo,DASH};`, ctx);
  const { pduTable, rpCauses, srPanel, sgdOps, consistencyBadge, countersSince, stInfo, DASH } = ctx.api;
  assert.equal(DASH, '–');
  const cells = t => t.groups.flatMap(g => g.rows.flatMap(r => [r.in, r.out].filter(Boolean)));

  // Older backend: every panel shows "–", nothing is a made-up 0.
  const old = { counters: {}, messages: {} };
  assert.equal(pduTable(old).known, false);
  assert.ok(cells(pduTable(old)).length >= 9 && cells(pduTable(old)).every(c => c.v === '–'));
  assert.equal(rpCauses(old).in, null); assert.equal(rpCauses(old).out, null);
  assert.ok(srPanel(old).fields.every(f => f.v === '–')); assert.equal(srPanel(old).byTpSt, null);
  assert.ok(sgdOps(old).out.every(o => o.v === '–') && sgdOps(old).in.length === 2);
  assert.equal(consistencyBadge(old).state, 'unknown'); assert.match(consistencyBadge(old).text, /–/);
  assert.equal(countersSince(old), null);

  const m = {
    since: '2026-10-22T08:00:00.000Z',
    pdus: { in: { 'RP-DATA/SMS-SUBMIT': 5, 'RP-ACK/SMS-DELIVER-REPORT': 3, 'none/no-report': 1, 'RP-DATA/SMMA': 2 },
      out: { 'RP-ACK/SMS-SUBMIT-REPORT': 4, 'RP-ERROR/SMS-SUBMIT-REPORT': 0, 'RP-DATA/SMS-DELIVER': 4, 'RP-DATA/SMS-STATUS-REPORT': 1 } },
    rpCauses: { in: { '22 MEMORY_CAPACITY_EXCEEDED': 1, '111 PROTOCOL_ERROR': 2, '41 TEMPORARY_FAILURE': 0 }, out: { '42 CONGESTION': 0 } },
    statusReports: { generated: 2, sent: 1, delivered: 1, failed: 0, expired: 0, byTpSt: { '0x00': 1, '0x46': 2, '0x9a': 1 } },
    sgd: { operationsOut: { 'SRI-for-SM': 4, 'MT-Forward-SM': 4, NFRegister: 1 }, operationsIn: { 'MO-Forward-SM': 5, 'Alert-SC': 0 } },
    consistency: [{ name: 'pdus-match-counters', ok: true }, { name: 'sr-sum', ok: false, detail: 'generated 2 != sent+failed+expired+waiting 1' }],
  };
  const pt = pduTable(m);
  const find = label => cells(pt).find(c => c.label === label);
  assert.equal(pt.known, true);
  assert.equal(pt.groups[0].grp, 'MO'); assert.equal(pt.groups[1].grp, 'MT');
  assert.equal(pt.groups[0].rows[0].in.label, 'RP-DATA / SMS-SUBMIT'); assert.equal(pt.groups[0].rows[0].in.v, 5);
  assert.equal(pt.groups[0].rows[0].out.v, 4, 'MO row pairs SUBMIT in with SUBMIT-REPORT ack out');
  assert.equal(find('RP-ERROR / SMS-SUBMIT-REPORT').v, 0, 'a real 0 stays 0');
  assert.equal(find('RP-ACK / STATUS-REPORT-ACK').v, '–', 'a missing key is "–"');
  assert.equal(find('none / no-report').v, 1);
  assert.equal(find('RP-DATA / SMMA').v, 2, 'unknown backend keys still show, as other');
  const rc = rpCauses(m);
  assert.equal(rc.in.map(c => c.cause).join('|'), '111 PROTOCOL_ERROR|22 MEMORY_CAPACITY_EXCEEDED', 'most frequent first, pre-seeded zeros hidden');
  assert.equal(rc.out.length, 0);
  const sp = srPanel(m);
  assert.equal(sp.fields.map(f => f.k).join(), 'generated,sent,delivered,failed,expired,waiting');
  assert.equal(sp.fields.find(f => f.k === 'waiting').v, '–'); assert.equal(sp.fields.find(f => f.k === 'failed').v, 0);
  assert.equal(sp.byTpSt.map(r => `${r.code} ${r.name} ${r.n}`).join('|'),
    '0x46 SM validity period expired 2|0x00 received by SME 1|0x9a permanent (reserved/SC specific) 1');
  assert.equal(sp.byTpSt[1].cls, 'ok'); assert.equal(sp.byTpSt[0].cls, 'bad');
  assert.equal(stInfo('0x22').cls, 'warn'); assert.equal(stInfo(0).code, '0x00');
  // The tile's TP-ST names cover every value the SC codec can send.
  for (const [k, v] of Object.entries(tpdu.ST)) assert.ok(!/reserved/.test(stInfo(v).name), `TP-ST ${k} has a name on the tile`);
  const so = sgdOps(m);
  assert.equal(so.out.map(o => `${o.op}=${o.v}`).join(), 'SRI-for-SM=4,MT-Forward-SM=4,Report-SM-Delivery-Status=–,NFDiscover=–,NFRegister=1,NFUpdate=–');
  assert.equal(so.in.map(o => `${o.op}=${o.v}`).join(), 'MO-Forward-SM=5,Alert-SC=0');
  const cb = consistencyBadge(m);
  assert.equal(cb.state, 'bad'); assert.equal(cb.failed.length, 1); assert.match(cb.text, /sr-sum/); assert.match(cb.failed[0].detail, /generated 2/);
  assert.equal(consistencyBadge({ consistency: [{ name: 'x', ok: true }] }).state, 'ok');
  assert.equal(countersSince(m), '2026-10-22T08:00:00.000Z');
  assert.equal(countersSince({ metrics: { since: 'T' } }), 'T', 'metrics.since also read');
  const html = fs.readFileSync(path.join(root, 'board/public/colony/holminator/index.html'), 'utf8');
  for (const id of ['pdus', 'causesin', 'causesout', 'srstats', 'tpst', 'sgdops', 'consistency', 'consfail', 'since'])
    assert.ok(html.includes(`id="${id}"`), `tile has #${id}`);
});
await t('POST /test/decode decodes RP-ACK with SUBMIT-REPORT and honours kind/direction hints', async () => {
  const r = await j('POST', '/test/decode', { hex: '03014109010062012280055500' });
  assert.equal(r.status, 200); assert.equal(r.body.rp.rpMessage, 'RP-ACK (N->MS)'); assert.equal(r.body.rp.rpRef, 1);
  assert.equal(r.body.tpdu.type, 'SMS-SUBMIT-REPORT'); assert.equal(r.body.tpdu.scts, '2026-10-22T08:50:55.000Z');
  const k = await j('POST', '/test/decode', { hex: '00D000', kind: 'SMS-DELIVER-REPORT' });
  assert.equal(k.status, 200); assert.equal(k.body.tpdu.type, 'SMS-DELIVER-REPORT'); assert.equal(k.body.tpdu.fcs, 0xd0);
  const e = await j('POST', '/test/decode', { hex: '0501011B' });
  assert.equal(e.body.rp.rpCause, 27); assert.equal(e.body.rp.rpCauseName, 'Destination out of order'); assert.equal(e.body.tpdu, null);
});
// ---------- TP-VP absolute and enhanced (TS 23.040 9.2.3.12.2-3), stored submitHex ----------
await t('codec: absolute TP-VP round trip with time zone, invalid digits give vpError', () => {
  const time = '2030-01-02T03:04:05.000Z';
  for (const tzMinutes of [0, 120, -180, 345]) {
    const b = tpdu.encodeSubmit({ to: '1', text: 'x', vp: { type: 'absolute', time, tzMinutes } });
    assert.equal((b[0] >> 3) & 3, 3, 'TP-VPF 11');
    const s = tpdu.decodeSubmit(b);
    assert.deepEqual([s.vpFormat, s.validUntil, s.vpError], ['absolute', time, undefined], `tz ${tzMinutes}`);
  }
  // 2030-01-02 03:04:05 at +02:00 is 01:04:05 UTC; TZ octet 0x80 = 8 quarter hours
  assert.equal(tpdu.decodeSubmit(tpdu.encodeSubmit({ to: '1', text: 'x', vp: { type: 'raw', vpf: 3, hex: '03102030405080' } })).validUntil, '2030-01-02T01:04:05.000Z');
  assert.ok(tpdu.decodeSubmit(tpdu.encodeSubmit({ to: '1', text: 'x', vp: { type: 'raw', vpf: 3, hex: '03F02030405000' } })).vpError, 'month F0');
  assert.ok(tpdu.decodeSubmit(tpdu.encodeSubmit({ to: '1', text: 'x', vp: { type: 'raw', vpf: 3, hex: '03201330405000' } })).vpError, '31 Feb');
});
await t('codec: enhanced TP-VP formats, single-shot and extension bits; reserved values give vpError', () => {
  const dec = vp => tpdu.decodeSubmit(tpdu.encodeSubmit({ to: '1', text: 'x', vp }));
  assert.equal((tpdu.encodeSubmit({ to: '1', text: 'x', vp: { type: 'enhanced', format: 'seconds', value: 1 } })[0] >> 3) & 3, 1, 'TP-VPF 01');
  assert.equal(dec({ type: 'enhanced', format: 'none' }).validityMs, null);
  assert.equal(dec({ type: 'enhanced', format: 'relative', value: 0xa7 }).validityMs, 24 * 3600 * 1000);
  assert.equal(dec({ type: 'enhanced', format: 'seconds', value: 30 }).validityMs, 30000);
  assert.equal(dec({ type: 'enhanced', format: 'hhmmss', value: '01:02:03' }).validityMs, 3723000);
  const ss = dec({ type: 'enhanced', format: 'seconds', value: 5, singleShot: true });
  assert.deepEqual([ss.singleShot, ss.vpFormat, ss.vpError], [true, 'enhanced-seconds', undefined]);
  assert.equal(dec({ type: 'enhanced', format: 'seconds', value: 5 }).singleShot, false);
  for (const f of [4, 5, 6, 7]) assert.match(dec({ type: 'enhanced', format: f }).vpError, /reserved/, `format ${f}`);
  assert.match(dec({ type: 'enhanced', format: 'seconds', value: 0 }).vpError, /0 seconds/);
  assert.match(dec({ type: 'raw', vpf: 1, hex: '03109900000000' }).vpError, /HH:MM:SS/, '99 minutes');
  // b7 extension: an all-zero extension octet is skipped, the value follows it; a set bit in it is reserved
  assert.equal(dec({ type: 'raw', vpf: 1, hex: '82001E00000000' }).validityMs, 30000);
  assert.match(dec({ type: 'raw', vpf: 1, hex: '82011E00000000' }).vpError, /extension/);
});
await t('MO: absolute TP-VP in the future sets expiresAt; submitHex is the original SMS-SUBMIT (bare and RP-wrapped)', async () => {
  const time = new Date(Date.now() + 3 * 3600 * 1000); time.setUTCMilliseconds(0);
  const hex = subHex({ mr: 150, to: '46700000250', vp: { type: 'absolute', time: time.toISOString(), tzMinutes: 60 } });
  const r = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex } }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = await msg(r.body.messageId);
  assert.equal(m.expiresAt, time.toISOString()); assert.equal(m.submitHex, hex); assert.equal(m.vpFormat, 'absolute');
  const sub = tpdu.encodeSubmit({ mr: 151, to: '46700000250', text: 'wrapped' });
  const r2 = await j('POST', '/smsc/mo-forward-short-message', moBody({ scAddress: undefined, sms: { hex: tpdu.bytesToHex(tpdu.wrapRpDataToNetwork({ ref: 9, scAddress: SC, tpdu: sub })) } }));
  assert.equal((await msg(r2.body.messageId)).submitHex, tpdu.bytesToHex(sub), 'TPDU only, not the RP-DATA');
});
await t('MO: absolute TP-VP in the past and reserved enhanced TP-VP are 5555 + SUBMIT-REPORT FCS C7, nothing stored', async () => {
  const before = (await j('GET', '/api/messages')).body.length;
  const past = subHex({ mr: 152, to: '46700000251', vp: { type: 'absolute', time: new Date(Date.now() - 60000).toISOString() } });
  const reserved = subHex({ mr: 153, to: '46700000251', vp: { type: 'enhanced', format: 5 } });
  const zeroSecs = subHex({ mr: 154, to: '46700000251', vp: { type: 'enhanced', format: 'seconds', value: 0 } });
  for (const hex of [past, reserved, zeroSecs]) {
    for (const q of ['', '?dryRun=1']) {
      const r = await j('POST', `/smsc/mo-forward-short-message${q}`, moBody({ sms: { hex } }));
      assert.equal(r.status, 403, `${hex}${q}`); assert.equal(r.body.diameterResultCode, 5555);
      assert.equal(r.body.smDeliveryFailureCause.smEnumeratedDeliveryFailureCause, 'EQUIPMENT_PROTOCOL_ERROR');
      const rep = report(r.body.deliveryReport.hex);
      assert.equal(rep[0], 0x01); assert.equal(rep[1], 0xc7, 'TP-FCS TP-VP not supported');
      assert.match(r.body.detail, /TP-VP not supported/);
    }
  }
  assert.equal((await j('GET', '/api/messages')).body.length, before);
});
await t('MO: enhanced TP-VP seconds sets expiresAt on the FORWARDED MO; an /api/mt with that validity expires on the next attempt', async () => {
  const hex = subHex({ mr: 155, to: '46700000252', vp: { type: 'enhanced', format: 'seconds', value: 1 } });
  const r0 = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex } }));
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const mo = await msg(r0.body.messageId);
  assert.equal(mo.status, 'FORWARDED'); assert.equal(Date.parse(mo.expiresAt) - Date.parse(mo.submittedAt), 1000);
  udmRules['46700000252'] = [404, { result: 'ABSENT_SUBSCRIBER_SM', diameterResultCode: 5550 }];
  const r = await j('POST', '/api/mt?wait=1', { to: '46700000252', text: 'x', validitySeconds: 1 });
  const m = await waitFor(async () => { const x = await msg(r.body.messageId); return x.status === 'WAITING' && x; });
  assert.equal(Date.parse(m.expiresAt) - Date.parse(m.submittedAt), 1000);
  delete udmRules['46700000252'];
  await new Promise(res => setTimeout(res, 1100));
  await j('POST', '/smsc/alert-service-centre', { msisdn: '46700000252', scAddress: SC, alertReason: 'UE_PRESENT' });
  await waitFor(async () => (await msg(r.body.messageId)).status === 'EXPIRED');
  assert.equal(callsFor('46700000252', 'mt-forward').length, 0, 'never forwarded after expiry');
});
await t('single-shot: the MO keeps the TP-VP b6 flag; an /api/mt with singleShot gets one attempt, then FAILED instead of WAITING', async () => {
  const hex = subHex({ mr: 156, to: '46700000253', vp: { type: 'enhanced', format: 'hhmmss', value: '01:00:00', singleShot: true } });
  const r0 = await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex } }));
  assert.equal(r0.status, 200, JSON.stringify(r0.body));
  const mo = await msg(r0.body.messageId);
  assert.equal(mo.singleShot, true); assert.equal(mo.status, 'FORWARDED');
  assert.equal(Date.parse(mo.expiresAt) - Date.parse(mo.submittedAt), 3600 * 1000);
  udmRules['46700000253'] = [404, { result: 'ABSENT_SUBSCRIBER_SM', diameterResultCode: 5550 }];
  const r = await j('POST', '/api/mt?wait=1', { to: '46700000253', text: 'x', singleShot: true });
  const m = await waitFor(async () => { const x = await msg(r.body.messageId); return ['FAILED', 'WAITING'].includes(x.status) && x; });
  delete udmRules['46700000253'];
  assert.equal(m.status, 'FAILED'); assert.equal(m.singleShot, true); assert.equal(m.attempts, 1);
  assert.match(m.failure, /single-shot/);
});
await t('POST /test/encode builds SMS-SUBMIT with absolute and enhanced TP-VP; bad vp is 400', async () => {
  const time = '2031-05-06T07:08:09.000Z';
  const a = await j('POST', '/test/encode', { type: 'SUBMIT', to: '46700000002', text: 'Hi', vp: { type: 'absolute', time, tzMinutes: -60 } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(tpdu.decodeSubmit(tpdu.hexToBytes(a.body.tpduHex)).validUntil, time);
  const e = await j('POST', '/test/encode', { type: 'SUBMIT', to: '46700000002', text: 'Hi', vp: { type: 'enhanced', format: 'seconds', value: 90, singleShot: true } });
  const s = tpdu.decodeSubmit(tpdu.hexToBytes(e.body.tpduHex));
  assert.deepEqual([s.vpf, s.validityMs, s.singleShot], [1, 90000, true]);
  assert.equal((await j('POST', '/test/encode', { type: 'SUBMIT', to: '1', text: 'x', vp: 167 })).status, 200);
  assert.equal((await j('POST', '/test/encode', { type: 'SUBMIT', to: '1', text: 'x', vp: { type: 'weird' } })).status, 400);
});

// ---------- Alert grace delay and one fast retry (alert raced the SMSF's UECM registration) ----------
{
  const T = plugin._internals.TIMING;
  const saved = { ...T };
  T.ALERT_GRACE_MS = 300; T.ALERT_FAST_RETRY_MS = 400;
  const parkWaiting = async to => {
    udmRules[to] = [404, { result: 'ABSENT_SUBSCRIBER_SM', diameterResultCode: 5550 }];
    const r = await j('POST', '/api/mt?wait=1', { to, text: 'after alert' });
    assert.equal(r.body.result, 'WAITING');
    delete udmRules[to];
    return r.body.messageId;
  };
  await t('alert: redelivery waits for the grace delay, the 200 comes right away', async () => {
    const to = '46700000261', id = await parkWaiting(to);
    const t0 = Date.now();
    const a = await j('POST', '/smsc/alert-service-centre', { msisdn: to, scAddress: SC, alertReason: 'UE_PRESENT' });
    assert.equal(a.status, 200); assert.deepEqual(a.body.redelivering, [id]);
    assert.ok(Date.now() - t0 < 250, 'alert answer must not wait for the grace delay');
    assert.equal((await msg(id)).status, 'WAITING');
    await waitFor(async () => (await msg(id)).status === 'DELIVERED');
    const fwd = callsFor(to, 'mt-forward');
    assert.equal(fwd.length, 1);
    assert.ok(fwd[0].at - t0 >= 300, `MT-Forward ${fwd[0].at - t0} ms after the alert, grace is 300 ms`);
  });
  await t('alert: SMSF 404 UNKNOWN_SUBSCRIBER once, then 200 -> DELIVERED via one fast retry', async () => {
    const to = '46700000262', id = await parkWaiting(to);
    let n = 0;
    smsfRules[to] = async () => (++n === 1 ? [404, { result: 'UNKNOWN_SUBSCRIBER' }] : [200, { result: 'SUCCESS' }]);
    await j('POST', '/smsc/alert-service-centre', { msisdn: to, scAddress: SC, alertReason: 'UE_PRESENT' });
    const m = await waitFor(async () => { const x = await msg(id); return x.status === 'DELIVERED' && x; });
    delete smsfRules[to];
    const fwd = callsFor(to, 'mt-forward');
    assert.equal(fwd.length, 2);
    assert.ok(fwd[1].at - fwd[0].at >= 400, 'the fast retry waits ALERT_FAST_RETRY_MS');
    assert.ok(m.history.some(h => /fast retry/.test(h.detail || '')), 'history must say why');
    const reps = callsFor(to, 'report-sm-delivery-status').map(c => c.body.deliveryOutcome);
    assert.ok(!reps.includes('ABSENT_SUBSCRIBER'), 'no ABSENT_SUBSCRIBER report when the fast retry succeeds');
  });
  await t('alert: SMSF stays absent -> exactly one fast retry, then ABSENT_SUBSCRIBER and WAITING, no loop', async () => {
    const to = '46700000263', id = await parkWaiting(to);
    smsfRules[to] = [504, { result: 'ABSENT_SUBSCRIBER' }];
    await j('POST', '/smsc/alert-service-centre', { msisdn: to, scAddress: SC, alertReason: 'UE_PRESENT' });
    await waitFor(() => callsFor(to, 'report-sm-delivery-status').some(c => c.body.deliveryOutcome === 'ABSENT_SUBSCRIBER'));
    await new Promise(r => setTimeout(r, 1200)); // three more fast-retry periods: a loop would show here
    const m = await msg(id);
    delete smsfRules[to];
    assert.equal(m.status, 'WAITING');
    assert.equal(callsFor(to, 'mt-forward').length, 2, 'one alert-triggered attempt plus exactly one fast retry');
    assert.equal(callsFor(to, 'report-sm-delivery-status').filter(c => c.body.deliveryOutcome === 'ABSENT_SUBSCRIBER').length, 1);
    assert.ok(Date.parse(m.nextRetryAt) - Date.now() > 60000, 'back to the slow fallback, waiting for the next alert');
  });
  await t('non-alert attempt: SMSF absent reports ABSENT_SUBSCRIBER at once, no fast retry', async () => {
    const to = '46700000264';
    smsfRules[to] = [404, { result: 'UNKNOWN_SUBSCRIBER' }];
    const r = await j('POST', '/api/mt?wait=1', { to, text: 'x' });
    await new Promise(res => setTimeout(res, 600));
    delete smsfRules[to];
    assert.equal(r.body.result, 'WAITING');
    assert.equal(callsFor(to, 'mt-forward').length, 1);
    assert.equal(callsFor(to, 'report-sm-delivery-status')[0].body.deliveryOutcome, 'ABSENT_SUBSCRIBER');
  });
  Object.assign(T, saved);
}

// ---------- Store-and-forward: restart requeue, temporary RP-ERROR causes, attempt cap ----------
{
  const forceDue = id => {
    const m = plugin._st.messages.find(x => x.id === id);
    m.nextRetryAt = new Date(Date.now() - 1).toISOString();
    plugin._internals.sweep();
  };
  const rpErr = cause => [502, { result: 'FAILURE', cause: 'UE answered RP-ERROR', deliveryReport: { hex: `040501${cause.toString(16).padStart(2, '0')}` } }];

  await t('RP-ERROR temporary causes 41, 42, 47, 111 -> WAITING with backoff, not FAILED; then delivered on retry', async () => {
    for (const [i, cause] of [[1, 41], [2, 42], [3, 47], [4, 111]]) {
      const to = `4670000028${i}`;
      smsfRules[to] = rpErr(cause);
      const r = await j('POST', '/api/mt?wait=1', { to, text: 'x' });
      assert.equal(r.body.result, 'WAITING', `cause ${cause}`);
      const m = await msg(r.body.messageId);
      assert.ok(Date.parse(m.nextRetryAt) - Date.now() > 20000, `cause ${cause}: backoff, not immediate`);
      assert.match(m.history.at(-1).detail, new RegExp(`cause ${cause} \\(temporary\\)`));
      delete smsfRules[to];
      forceDue(r.body.messageId);
      await waitFor(async () => (await msg(r.body.messageId)).status === 'DELIVERED');
    }
  });
  await t('RP-ERROR permanent causes 21, 95, 96, 97, 98, 99 -> FAILED at once', async () => {
    for (const cause of [21, 95, 96, 97, 98, 99]) {
      const to = `467000002${90 + (cause % 10)}`;
      smsfRules[to] = rpErr(cause);
      const r = await j('POST', '/api/mt?wait=1', { to, text: 'x' });
      delete smsfRules[to];
      assert.equal(r.body.result, 'FAILED', `cause ${cause}`);
      assert.equal(callsFor(to, 'mt-forward').length, 1);
    }
  });
  await t('attempt cap: temporary RP-ERROR forever -> FAILED after MAX_ATTEMPTS', async () => {
    const L = plugin._internals.MT_LIMITS, saved = L.MAX_ATTEMPTS;
    L.MAX_ATTEMPTS = 3;
    try {
      const to = '46700000301';
      smsfRules[to] = rpErr(111);
      const id = (await j('POST', '/api/mt', { to, text: 'garbled' })).body.messageId;
      for (let n = 1; n < 3; n++) {
        await waitFor(async () => { const x = await msg(id); return x.status === 'WAITING' && x.attempts === n; });
        forceDue(id);
      }
      const m = await waitFor(async () => { const x = await msg(id); return x.status === 'FAILED' && x; });
      delete smsfRules[to];
      assert.equal(m.attempts, 3); assert.equal(callsFor(to, 'mt-forward').length, 3);
      assert.match(m.failure, /giving up after 3 attempts/);
      assert.equal(m.statusReportId, undefined, 'an /api/mt has no originator to report to');
    } finally { L.MAX_ATTEMPTS = saved; }
  });
  await t('502 FAILURE without a deliveryReport keeps the backoff, even after an earlier RP-ERROR 22', async () => {
    const to = '46700000302';
    let n = 0;
    smsfRules[to] = async () => (++n === 1 ? rpErr(22) : [502, { result: 'FAILURE', cause: 'no answer from the UE' }]);
    const r = await j('POST', '/api/mt?wait=1', { to, text: 'x' });
    assert.equal(r.body.result, 'WAITING');
    forceDue(r.body.messageId);
    const m = await waitFor(async () => { const x = await msg(r.body.messageId); return x.status === 'WAITING' && x.attempts === 2 && x; });
    delete smsfRules[to];
    assert.match(m.history.at(-1).detail, /MT-Forward failed \(502 FAILURE\); retry in/);
    assert.equal(callsFor(to, 'report-sm-delivery-status').filter(c => c.body.deliveryOutcome === 'MEMORY_CAPACITY_EXCEEDED').length, 1);
  });

  await t('restart: MO ACCEPTED -> FORWARDED (+ status report if SRR), never MT; MT ACCEPTED/PENDING delivered once; expired EXPIRE; WAITING waits', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'holminator-restart-'));
    const now = Date.now(), iso = ms => new Date(now + ms).toISOString();
    const base = (id, direction, status, to, extra = {}) => ({
      id, direction, kind: 'SMS', status, from: direction === 'MO' ? '46700000310' : SC, to, text: `restart ${id}`, mr: 40 + Number(id.slice(5)),
      srr: false, submittedAt: iso(-60000), expiresAt: iso(3600000), history: [{ ts: iso(-60000), event: status }], ...extra,
    });
    fs.writeFileSync(path.join(dir2, 'store.json'), JSON.stringify({ msgSeq: 8, messages: [
      base('smsc-1', 'MO', 'ACCEPTED', '46700000311'),
      base('smsc-2', 'MT', 'PENDING', '46700000312'),
      base('smsc-3', 'MO', 'ACCEPTED', '46700000313', { from: '46700000314', srr: true, expiresAt: iso(-1000) }),
      base('smsc-4', 'MT', 'WAITING', '46700000315', { attempts: 1, nextRetryAt: iso(600000), mwd: true }),
      base('smsc-5', 'MT', 'WAITING', '46700000316', { attempts: 1, nextRetryAt: iso(-1000) }),
      base('smsc-6', 'MO', 'ACCEPTED', '46700000318', { from: '46700000317', srr: true }),
      base('smsc-7', 'MO', 'WAITING', '46700000319', { attempts: 1, nextRetryAt: iso(-1000) }), // left by the old MO-to-MT relay
      base('smsc-8', 'MT', 'ACCEPTED', '46700000320'),
    ] }));
    const modPath = path.join(root, 'board/plugins/holminator/index.js');
    const cached = require.cache[require.resolve(modPath)];
    delete require.cache[require.resolve(modPath)];
    const p2 = require(modPath); // a fresh instance with its own state, like a restarted process
    require.cache[require.resolve(modPath)] = cached;
    try {
      p2.init({ dataDir: dir2 });
      const get = id => p2._st.messages.find(m => m.id === id);
      assert.equal(get('smsc-1').status, 'FORWARDED'); assert.equal(get('smsc-1').history.at(-1).detail, 'simulated onward delivery to 46700000311');
      assert.equal(get('smsc-7').status, 'FORWARDED', 'an old relay MO is not delivered as MT');
      await waitFor(() => get('smsc-2').status === 'DELIVERED' && get('smsc-8').status === 'DELIVERED');
      assert.equal(get('smsc-3').status, 'EXPIRED');
      const sr = await waitFor(() => { const x = get(get('smsc-3').statusReportId || ''); return x && x.status === 'DELIVERED' && x; });
      assert.equal(tpdu.decodeStatusReport(tpdu.hexToBytes(callsFor('46700000314', 'mt-forward')[0].body.sms.hex)).st, 0x46);
      assert.equal(sr.to, '46700000314');
      const sr6 = await waitFor(() => { const x = get(get('smsc-6').statusReportId || ''); return x && x.status === 'DELIVERED' && x; });
      assert.deepEqual([sr6.direction, sr6.kind, sr6.to, sr6.st], ['MT', 'STATUS_REPORT', '46700000317', 0x00]);
      await new Promise(r => setTimeout(r, 300));
      for (const to of ['46700000311', '46700000313', '46700000318', '46700000319']) assert.equal(callsFor(to, '').length, 0, `MO to ${to}: no SRI, no MT-Forward`);
      assert.equal(callsFor('46700000317', 'mt-forward').length, 1, 'exactly one status report');
      assert.equal(callsFor('46700000312', 'mt-forward').length, 1, 'PENDING MT: exactly one MT-Forward');
      assert.equal(callsFor('46700000320', 'mt-forward').length, 1, 'ACCEPTED MT: exactly one MT-Forward');
      assert.equal(get('smsc-4').status, 'WAITING'); assert.equal(callsFor('46700000315', '').length, 0, 'WAITING waits for the alert');
      assert.equal(get('smsc-5').status, 'WAITING', 'due fallback goes on the sweep, not at init');
      p2._internals.sweep();
      await waitFor(() => get('smsc-5').status === 'DELIVERED');
      assert.equal(get('smsc-4').status, 'WAITING', 'fallback not yet due');
      const saved = JSON.parse(fs.readFileSync(path.join(dir2, 'store.json'), 'utf8'));
      assert.equal(saved.messages.find(m => m.id === 'smsc-4').nextRetryAt, get('smsc-4').nextRetryAt, 'fallback timer is in the store');
      assert.ok(p2._st.messages.every(m => m.direction === 'MO' || m.direction === 'MT'), 'every record has a direction');
    } finally {
      for (const tm of p2._st.timers) clearInterval(tm);
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
}

// ---------- MO terminates at the SMSC; MT only from /api/mt and status reports ----------
await t('MO: no SRI and no MT-Forward for any MO, status FORWARDED with direction MO', async () => {
  const before = peerCalls.length;
  const r = await j('POST', '/smsc/mo-forward-short-message', moBody({ msisdn: '46700000330', sms: { hex: subHex({ mr: 201, to: '46700000331' }) } }));
  assert.equal(r.status, 200); assert.equal(r.body.result, 'SUCCESS');
  assert.equal(report(r.body.deliveryReport.hex)[0], 0x01, 'RP-ACK SUBMIT-REPORT');
  await new Promise(res => setTimeout(res, 300));
  const m = await msg(r.body.messageId);
  assert.deepEqual([m.direction, m.kind, m.status], ['MO', 'SMS', 'FORWARDED']);
  assert.ok(m.forwardedAt);
  assert.equal(m.history.at(-1).detail, 'simulated onward delivery to 46700000331');
  const mine = peerCalls.slice(before).filter(c => ['46700000330', '46700000331'].includes(c.body.msisdn));
  assert.deepEqual(mine.map(c => c.path), [], 'no UDM or SMSF call for an MO without SRR');
  assert.equal(m.attempts, undefined, 'never attempted as MT');
});
await t('MO + TP-SRR: exactly one STATUS_REPORT MT record, delivered over SRI + MT-Forward to the originator', async () => {
  const r = await j('POST', '/smsc/mo-forward-short-message', moBody({ msisdn: '46700000332', sms: { hex: subHex({ mr: 202, to: '46700000333', srr: true }) } }));
  const m = await waitFor(async () => { const x = await msg(r.body.messageId); return x.statusReportId && x; });
  await waitFor(async () => (await msg(m.statusReportId)).status === 'DELIVERED');
  await new Promise(res => setTimeout(res, 300));
  const srs = plugin._st.messages.filter(x => x.reportFor === m.id);
  assert.equal(srs.length, 1, 'one status report record');
  assert.deepEqual([srs[0].direction, srs[0].kind, srs[0].to, srs[0].st], ['MT', 'STATUS_REPORT', '46700000332', 0x00]);
  assert.equal(callsFor('46700000332', 'send-routing-info').length, 1);
  assert.equal(callsFor('46700000332', 'mt-forward').length, 1);
  assert.equal(callsFor('46700000333', '').length, 0, 'nothing towards TP-DA');
});
await t('metrics: MO counted as mo_received/mo_accepted/mo_forwarded; mt_originated only for /api/mt and status reports', async () => {
  const c0 = (await j('GET', '/api/metrics')).body.counters;
  await j('POST', '/smsc/mo-forward-short-message', moBody({ sms: { hex: subHex({ mr: 203, to: '46700000334' }) } }));
  await j('POST', '/smsc/mo-forward-short-message', moBody({ msisdn: '46700000335', sms: { hex: subHex({ mr: 204, to: '46700000336', srr: true }) } }));
  await j('POST', '/api/mt?wait=1', { to: '46700000337', text: 'generator' });
  await waitFor(() => callsFor('46700000335', 'mt-forward').length === 1);
  const c1 = (await j('GET', '/api/metrics')).body.counters;
  const d = k => (c1[k] || 0) - (c0[k] || 0);
  assert.deepEqual([d('mo_received'), d('mo_accepted'), d('mo_forwarded')], [2, 2, 2]);
  assert.equal(d('status_reports_generated'), 1);
  assert.equal(d('mt_originated'), 2, 'one /api/mt plus one status report, no MT for the MOs');
  const all = (await j('GET', '/api/messages')).body;
  assert.ok(all.every(x => x.direction === 'MO' || x.direction === 'MT'), 'every record has an explicit direction');
  assert.ok(all.filter(x => x.direction === 'MT').every(x => x.kind === 'STATUS_REPORT' || x.history[0].detail.startsWith('originated by the SC API')), 'MT only from /api/mt or status reports');
  assert.ok(all.filter(x => x.direction === 'MO').every(x => !x.attempts), 'no MO was ever attempted as MT');
});

// ---------- metrics: complete (every PDU, RP-Cause, status report, SGd operation), consistent, persisted ----------
{
  // A fresh module instance on its own dataDir and HTTP port, like a restarted process.
  const modPath = path.join(root, 'board/plugins/holminator/index.js');
  const fresh = async dir => {
    const cached = require.cache[require.resolve(modPath)];
    delete require.cache[require.resolve(modPath)];
    const p = require(modPath);
    require.cache[require.resolve(modPath)] = cached;
    p.init({ dataDir: dir });
    const s = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const handled = await p.handle(req, res, { path: url.pathname.replace(/^\/t\/holminator/, '') || '/', url });
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
    await new Promise(r => s.listen(0, r));
    const b = `http://127.0.0.1:${s.address().port}/t/holminator`;
    const jj = async (method, p2, body) => {
      const r = await fetch(b + p2, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => r.status) };
    };
    const close = () => { for (const tm of p._st.timers) clearInterval(tm); s.close(); };
    return { p, j: jj, close };
  };
  const PIN = ['RP-DATA/SMS-SUBMIT', 'RP-ACK/SMS-DELIVER-REPORT', 'RP-ACK/STATUS-REPORT-ACK', 'RP-ERROR/SMS-DELIVER-REPORT', 'none/no-report'];
  const POUT = ['RP-ACK/SMS-SUBMIT-REPORT', 'RP-ERROR/SMS-SUBMIT-REPORT', 'RP-DATA/SMS-DELIVER', 'RP-DATA/SMS-STATUS-REPORT'];
  const OUT_OPS = ['SRI-for-SM', 'MT-Forward-SM', 'Report-SM-Delivery-Status', 'NFDiscover', 'NFRegister', 'NFUpdate'];
  const zeroed = keys => Object.fromEntries(keys.map(k => [k, 0]));
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'holminator-metrics-'));

  await t('metrics: on a fresh start every counter, PDU, RP-Cause, status report and SGd key is present and 0', async () => {
    const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'holminator-metrics0-'));
    const f = await fresh(dir0);
    try {
      const m = (await f.j('GET', '/api/metrics')).body;
      assert.ok(!Number.isNaN(Date.parse(m.since)), 'since is an ISO time');
      for (const k of ['mo_received', 'mo_accepted', 'mo_rejected', 'mo_forwarded', 'mo_dry_runs', 'mt_originated', 'mt_attempts', 'mt_forward_not_sent',
        'mt_delivered', 'mt_failed', 'mt_expired', 'status_reports_generated', 'status_reports_sent', 'status_reports_failed', 'status_reports_expired',
        'alerts_received', 'sri_requests', 'udm_delivery_reports', 'store_evicted', 'requests_in', 'answers_error']) assert.equal(m.counters[k], 0, k);
      assert.ok(Object.values(m.counters).every(v => v === 0), 'every pre-seeded counter is 0');
      assert.deepEqual(m.pdus, { in: zeroed(PIN), out: zeroed(POUT) });
      for (const d of ['in', 'out']) {
        assert.equal(m.rpCauses[d]['22 MEMORY_CAPACITY_EXCEEDED'], 0);
        assert.equal(m.rpCauses[d]['111 PROTOCOL_ERROR_UNSPECIFIED'], 0);
        assert.equal(Object.keys(m.rpCauses[d]).length, Object.keys(tpdu.RP_CAUSE).length);
        assert.ok(Object.values(m.rpCauses[d]).every(v => v === 0));
      }
      const { byTpSt, ...sr } = m.statusReports;
      assert.deepEqual(sr, { generated: 0, sent: 0, delivered: 0, failed: 0, expired: 0, waiting: 0 });
      for (const k of ['0x00', '0x46', '0x60', '0x62', '0x65']) assert.equal(byTpSt[k], 0, k);
      assert.ok(Object.values(byTpSt).every(v => v === 0));
      assert.deepEqual(m.sgd.operationsOut, zeroed(OUT_OPS));
      assert.deepEqual(m.sgd.operationsIn, { 'MO-Forward-SM': 0, 'Alert-SC': 0 });
      assert.deepEqual(m.sgd.results, m.results);
      assert.deepEqual(m.consistency.map(c => c.name), ['mo_pdus', 'mt_attempts_forwarded', 'mt_attempts_answered', 'status_reports', 'mo_store']);
      assert.ok(m.consistency.every(c => c.ok && typeof c.detail === 'string'), JSON.stringify(m.consistency));
      const text = f.p._internals.metricsText();
      assert.match(text, /smsc_pdus_total\{dir="in",type="RP-DATA\/SMS-SUBMIT"\} 0/);
      assert.match(text, /smsc_rp_causes_total\{dir="in",cause="22 MEMORY_CAPACITY_EXCEEDED"\} 0/);
      assert.match(text, /smsc_sgd_operations_total\{dir="out",operation="MT-Forward-SM"\} 0/);
      assert.match(text, /smsc_consistency_ok\{check="mo_pdus"\} 1/);
      assert.match(text, /smsc_store_evicted_total 0/);
    } finally { f.close(); fs.rmSync(dir0, { recursive: true, force: true }); }
  });

  let after = null;
  await t('metrics: MO+SRR, MO rejected, MT delivered, MT RP-ERROR 22, MT no report -> exact PDUs, causes, status reports, all consistent', async () => {
    const f = await fresh(dir3);
    try {
      smsfRules['46700000343'] = [502, { result: 'FAILURE', cause: 'UE answered RP-ERROR', deliveryReport: { hex: '04050116' } }];
      smsfRules['46700000344'] = [502, { result: 'FAILURE', cause: 'no answer from the UE' }];
      const mo = await f.j('POST', '/smsc/mo-forward-short-message', moBody({ msisdn: '46700000340', sms: { hex: subHex({ mr: 210, to: '46700000341', srr: true }) } }));
      assert.equal(mo.status, 200);
      const rej = await f.j('POST', '/smsc/mo-forward-short-message', moBody({ msisdn: '46700000345', scAddress: '46700000999', sms: { hex: subHex({ mr: 211, to: '46700000341' }) } }));
      assert.equal(rej.status, 403);
      for (const to of ['46700000342', '46700000343', '46700000344']) assert.equal((await f.j('POST', '/api/mt?wait=1', { to, text: `metrics ${to}` })).status, 200);
      const get = id => f.p._st.messages.find(x => x.id === id);
      await waitFor(() => { const x = get(get(mo.body.messageId).statusReportId || ''); return x && x.status === 'DELIVERED'; });
      await waitFor(() => f.p._st.messages.filter(x => x.direction === 'MT').every(x => ['DELIVERED', 'WAITING'].includes(x.status)));
      const m = (await f.j('GET', '/api/metrics')).body;
      assert.deepEqual(m.pdus.in, { 'RP-DATA/SMS-SUBMIT': 2, 'RP-ACK/SMS-DELIVER-REPORT': 1, 'RP-ACK/STATUS-REPORT-ACK': 1, 'RP-ERROR/SMS-DELIVER-REPORT': 1, 'none/no-report': 1 });
      assert.deepEqual(m.pdus.out, { 'RP-ACK/SMS-SUBMIT-REPORT': 1, 'RP-ERROR/SMS-SUBMIT-REPORT': 1, 'RP-DATA/SMS-DELIVER': 3, 'RP-DATA/SMS-STATUS-REPORT': 1 });
      assert.deepEqual(Object.entries(m.rpCauses.in).filter(([, v]) => v), [['22 MEMORY_CAPACITY_EXCEEDED', 1]]);
      assert.deepEqual(Object.entries(m.rpCauses.out).filter(([, v]) => v), [['21 SHORT_MESSAGE_TRANSFER_REJECTED', 1]]);
      const { byTpSt, ...sr } = m.statusReports;
      assert.deepEqual(sr, { generated: 1, sent: 1, delivered: 1, failed: 0, expired: 0, waiting: 0 });
      assert.deepEqual(Object.entries(byTpSt).filter(([, v]) => v), [['0x00', 1]]);
      const c = m.counters;
      assert.deepEqual([c.mo_received, c.mo_accepted, c.mo_rejected, c.mo_forwarded], [2, 1, 1, 1]);
      assert.deepEqual([c.mt_originated, c.mt_attempts, c.mt_forward_not_sent, c.mt_delivered, c.status_reports_sent], [4, 4, 0, 1, 1]);
      for (const k of ['SRI-for-SM', 'MT-Forward-SM']) assert.equal(m.sgd.operationsOut[k], 4, k);
      assert.equal(m.sgd.operationsOut['Report-SM-Delivery-Status'], 1, 'only RP-ERROR 22 is reported to the UDM');
      assert.ok(m.sgd.operationsOut.NFDiscover >= 1);
      assert.deepEqual(m.sgd.operationsIn, { 'MO-Forward-SM': 2, 'Alert-SC': 0 });
      assert.ok(m.consistency.every(x => x.ok), JSON.stringify(m.consistency, null, 1));
      const k = (await f.j('GET', '/kpi')).body.extra;
      assert.deepEqual([k.pdus_in, k.pdus_out, k.consistent], [6, 6, true]);
      after = m;
    } finally {
      f.close();
      delete smsfRules['46700000343']; delete smsfRules['46700000344'];
    }
  });

  await t('metrics: counters, PDUs, causes, TP-ST and SGd operations survive a restart (store.json), since is kept', async () => {
    assert.ok(after, 'needs the previous test');
    const saved = JSON.parse(fs.readFileSync(path.join(dir3, 'store.json'), 'utf8'));
    assert.ok(saved.metrics && saved.metrics.pdus, 'metrics are in store.json');
    const f = await fresh(dir3);
    try {
      const m = (await f.j('GET', '/api/metrics')).body;
      assert.equal(m.since, after.since);
      assert.deepEqual(m.pdus, after.pdus);
      assert.deepEqual(m.rpCauses, after.rpCauses);
      assert.deepEqual(m.statusReports.byTpSt, after.statusReports.byTpSt);
      assert.deepEqual(m.sgd.operationsIn, after.sgd.operationsIn);
      for (const k of ['mo_received', 'mo_accepted', 'mo_rejected', 'mo_forwarded', 'mt_originated', 'mt_attempts', 'mt_delivered', 'status_reports_generated', 'status_reports_sent']) {
        assert.equal(m.counters[k], after.counters[k], k);
      }
      assert.deepEqual(m.sgd.results['SRI-for-SM'], after.sgd.results['SRI-for-SM']);
      assert.ok(m.consistency.every(x => x.ok), JSON.stringify(m.consistency, null, 1));
    } finally { f.close(); fs.rmSync(dir3, { recursive: true, force: true }); }
  });
}

await t('metrics: each consistency check reports ok:false with a useful detail when its own counter is skewed, the others stay ok', async () => {
  const modPath = path.join(root, 'board/plugins/holminator/index.js');
  const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'holminator-consistency-'));
  const cached = require.cache[require.resolve(modPath)];
  delete require.cache[require.resolve(modPath)];
  const p = require(modPath);
  require.cache[require.resolve(modPath)] = cached;
  try {
    p.init({ dataDir: dirC });
    const mx = p._st.metrics;
    const checks = () => Object.fromEntries(p._internals.metricsSnapshot().consistency.map(c => [c.name, c]));
    const skews = {
      mo_pdus: [mx.pdus.in, 'RP-DATA/SMS-SUBMIT', /^1 != 0: in RP-DATA\/SMS-SUBMIT/],
      mt_attempts_forwarded: [mx.pdus.out, 'RP-DATA/SMS-DELIVER', /^0 != 1: mt_attempts == out RP-DATA/],
      mt_attempts_answered: [mx.pdus.in, 'none/no-report', /^0 != 1: mt_attempts == in RP-ACK/],
      status_reports: [mx.counters, 'status_reports_generated', /^1 != 0: generated == delivered/],
      mo_store: [mx.counters, 'mo_received', /^1 != 0: mo_received == MO records/],
    };
    assert.ok(Object.values(checks()).every(c => c.ok), 'all ok before skewing');
    assert.deepEqual(Object.keys(checks()), Object.keys(skews), 'every check is exercised');
    for (const [name, [map, key, detail]] of Object.entries(skews)) {
      map[key]++;
      const cs = checks();
      assert.equal(cs[name].ok, false, `${name} must fail when ${key} is skewed`);
      assert.match(cs[name].detail, detail, `${name} detail`);
      for (const [other, c] of Object.entries(cs)) if (other !== name) assert.equal(c.ok, true, `${other} stays ok while ${name} is skewed`);
      assert.match(p._internals.metricsText(), new RegExp(`smsc_consistency_ok\\{check="${name}"\\} 0`));
      map[key]--;
    }
    assert.ok(Object.values(checks()).every(c => c.ok), 'all ok again after restoring');
  } finally {
    for (const tm of p._st.timers) clearInterval(tm);
    fs.rmSync(dirC, { recursive: true, force: true });
  }
});

srv.close(); fake.close();
for (const tm of plugin._st.timers) clearInterval(tm);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
