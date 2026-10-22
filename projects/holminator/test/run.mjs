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

srv.close(); fake.close();
for (const tm of plugin._st.timers) clearInterval(tm);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
