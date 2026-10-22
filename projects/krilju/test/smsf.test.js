// Run: node --test projects/krilju/test/   (plain Node, no dependencies, peers are faked)
process.env.SMSF_BOARD_URL = 'http://board.test';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const rp = require('../../../board/plugins/krilju/rp');
const plugin = require('../../../board/plugins/krilju/index');

const TPDU = '01010B916407000000F100000005E8329BFD06'; // bare SMS-SUBMIT, content is irrelevant to the SMSF
const SC = '07916407000001F0'; // RP address element for SC 46700000100
const lenHex = h => (h.length / 2).toString(16).padStart(2, '0');

test('rp: parse RP-DATA from the UE and extract the bare TPDU and SC address', () => {
  const r = rp.parseFromUe(`0005${'00'}${SC}${lenHex(TPDU)}${TPDU}`);
  assert.strictEqual(r.type, 'DATA');
  assert.strictEqual(r.rpMr, 5);
  assert.strictEqual(r.scAddress, '46700000100');
  assert.strictEqual(r.tpdu, TPDU);
});

test('rp: parse RP-ACK and RP-ERROR from the UE', () => {
  assert.deepStrictEqual(rp.parseFromUe('0207'), { type: 'ACK', rpMr: 7, cause: null, tpdu: null });
  const e = rp.parseFromUe('04090111');
  assert.strictEqual(e.type, 'ERROR');
  assert.strictEqual(e.cause, 0x11);
  assert.strictEqual(e.rpMr, 9);
});

test('rp: malformed input gives null', () => {
  assert.strictEqual(rp.parseFromUe(''), null);
  assert.strictEqual(rp.parseFromUe('0F01'), null);
  assert.strictEqual(rp.parseFromUe('0001000000'), null); // empty user data
});

test('rp: network to MS builders', () => {
  assert.strictEqual(rp.rpAck(3), '0303');
  assert.strictEqual(rp.rpAck(3, 'AABB'), '03034102AABB');
  assert.strictEqual(rp.rpError(4, 21), '05040115');
  assert.strictEqual(rp.rpError(4, 21, 'AA'), '050401154101AA');
  assert.strictEqual(rp.rpAck(0x1ff), '03FF', 'RP-MR wraps to one byte');
});

test('rp: RP-DATA to the UE carries the SC address as RP-OA and an empty RP-DA', () => {
  assert.strictEqual(rp.rpDataToUe(9, '46700000100', 'AABBCC'), `0109${SC}0003AABBCC`);
});

// ---- SMSF behaviour against faked peers ----
const calls = [];
let smscReply, amfReply, udmData;
const json = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

// The plugin runs on this faked global fetch; the tests talk to the local server through http.request.
global.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ method, url: u, body });
  if (u.includes('nf-instances?target-nf-type=')) {
    const t = u.match(/target-nf-type=(\w+)/)[1];
    return json(200, { nfInstances: [{ nfServices: [{ apiRoot: `http://peer.test/${t.toLowerCase()}` }] }] });
  }
  if (u.includes('/nudm-uecm/')) return json(method === 'DELETE' ? 204 : (udmData.uecm || 201), {});
  if (u.includes('/sms-mng-data')) return json(200, udmData.mng || {});
  if (u.includes('/sms-data')) return json(udmData.sms.status || 200, udmData.sms.body);
  if (u.includes('/mo-forward-short-message')) return smscReply(body);
  if (u.includes('/n1-n2-messages')) return amfReply(body);
  return json(404, {});
};

let server, base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    Promise.resolve(plugin.handle(req, res, { path })).then(h => { if (!h) { res.statusCode = 404; res.end(); } });
  });
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const raw = (method, path, payload) => new Promise((resolve, reject) => {
  const q = http.request(base + path, { method, headers: { 'content-type': 'application/json' } }, res => {
    const c = []; res.on('data', d => c.push(d));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString() }));
  });
  q.on('error', reject); if (payload !== undefined) q.write(payload); q.end();
});
const req = async (method, path, body) => {
  const r = await raw(method, path, body === undefined ? undefined : JSON.stringify(body));
  return { status: r.status, body: r.text && r.text.startsWith('{') || r.text.startsWith('[') ? JSON.parse(r.text) : null, text: r.text };
};

const activate = (supi, gpsi) => req('PUT', `/nsmsf-sms/v2/ue-contexts/${supi}`, { supi, gpsi });
const okUdm = () => { udmData = { sms: { body: { smsSubscribed: true } }, mng: {} }; };
const mo = (supi, rpMr, id) => req('POST', `/nsmsf-sms/v2/ue-contexts/${supi}/sendsms`, {
  jsonData: { smsRecordId: id, smsPayload: { contentType: 'application/vnd.3gpp.sms', hex: `00${rpMr.toString(16).padStart(2, '0')}00${SC}${lenHex(TPDU)}${TPDU}` } },
});
const wait = ms => new Promise(r => setTimeout(r, ms));

test('activation: success, not allowed, unknown subscriber, bad supi', async () => {
  okUdm();
  assert.strictEqual((await activate('imsi-001010000000001', 'msisdn-46700000001')).status, 201);
  udmData = { sms: { body: { smsSubscribed: false } } };
  const no = await activate('imsi-001010000000003');
  assert.strictEqual(no.status, 403);
  assert.strictEqual(no.body.cause, 'SMS_NOT_ALLOWED');
  udmData = { uecm: 404, sms: { status: 404, body: {} } };
  assert.strictEqual((await activate('imsi-001019999999999')).body.cause, 'USER_UNKNOWN');
  assert.strictEqual((await activate('bogus')).body.cause, 'INVALID_SUPI');
});

test('MO: strips RP-DATA, forwards the bare TPDU with the SC address, answers RP-ACK with the same RP-MR', async () => {
  okUdm();
  await activate('imsi-001010000000001', 'msisdn-46700000001');
  smscReply = () => json(200, { result: 'SUCCESS', deliveryReport: { hex: '0100' } });
  const r = await mo('imsi-001010000000001', 0x2a, 'mo-test-1');
  assert.strictEqual(r.status, 200);
  const sent = calls.filter(c => c.url.includes('/mo-forward-short-message')).pop().body;
  assert.strictEqual(sent.sms.hex, TPDU);
  assert.strictEqual(sent.scAddress, '46700000100');
  assert.strictEqual(sent.smsRecordId, 'mo-test-1');
  assert.match(r.body.smsPayload.hex, /^032A/, 'RP-ACK (MTI 3) with RP-MR 0x2A');
});

test('MO: SMSC rejection gives 502 and an RP-ERROR to the UE', async () => {
  smscReply = () => json(403, { result: 'SM_DELIVERY_FAILURE' });
  const r = await mo('imsi-001010000000001', 7, 'mo-test-2');
  assert.strictEqual(r.status, 502);
  assert.match(r.body.smsPayload.hex, /^0507/);
});

test('MO: barred subscriber is refused before the SMSC is called', async () => {
  udmData = { sms: { body: { smsSubscribed: true } }, mng: { moSmsBarringAll: true } };
  await activate('imsi-001010000000005', 'msisdn-46700000005');
  const before = calls.filter(c => c.url.includes('/mo-forward')).length;
  const r = await mo('imsi-001010000000005', 1, 'mo-test-3');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.cause, 'MO_SMS_BARRED');
  assert.strictEqual(calls.filter(c => c.url.includes('/mo-forward')).length, before);
});

test('MO: no context gives 404, invalid JSON gives 400', async () => {
  assert.strictEqual((await mo('imsi-001010000000009', 1, 'x')).status, 404);
  assert.strictEqual((await raw('POST', '/nsmsf-sms/v2/ue-contexts/imsi-001010000000001/sendsms', '{nope')).status, 400);
});

test('MT: wraps the bare TPDU in RP-DATA and completes when the UE answers with RP-ACK', async () => {
  okUdm();
  await activate('imsi-001010000000002', 'msisdn-46700000002');
  let rpHex;
  amfReply = body => { rpHex = body.smsPayload.hex; return json(200, { cause: 'N1_N2_TRANSFER_INITIATED' }); };
  const pending = req('POST', '/smsc/mt-forward-short-message', { supi: 'imsi-001010000000002', smsRecordId: 'mt-test-1', scAddress: '46700000100', sms: { hex: 'AABBCC' } });
  await wait(100);
  assert.strictEqual(rpHex.slice(0, 2), '01', 'RP-DATA network to MS');
  assert.ok(rpHex.endsWith('03AABBCC'));
  const ack = await req('POST', '/nsmsf-sms/v2/ue-contexts/imsi-001010000000002/sendsms', { jsonData: { smsRecordId: 'mt-test-1', smsPayload: { hex: `02${rpHex.slice(2, 4)}` } } });
  assert.strictEqual(ack.status, 200);
  assert.strictEqual((await pending).status, 200);
});

test('MT: UE answer without smsRecordId is matched on supi and RP-MR', async () => {
  let rpHex;
  amfReply = body => { rpHex = body.smsPayload.hex; return json(200, {}); };
  const pending = req('POST', '/smsc/mt-forward-short-message', { supi: 'imsi-001010000000002', smsRecordId: 'mt-test-2', sms: { hex: 'AA' } });
  await wait(100);
  await req('POST', '/nsmsf-sms/v2/ue-contexts/imsi-001010000000002/sendsms', { jsonData: { smsPayload: { hex: `02${rpHex.slice(2, 4)}` } } });
  assert.strictEqual((await pending).status, 200);
});

test('MT: UE RP-ERROR is reported to the SMSC as a failure', async () => {
  let rpHex;
  amfReply = body => { rpHex = body.smsPayload.hex; return json(200, {}); };
  const pending = req('POST', '/smsc/mt-forward-short-message', { supi: 'imsi-001010000000002', smsRecordId: 'mt-test-3', sms: { hex: 'AA' } });
  await wait(100);
  await req('POST', '/nsmsf-sms/v2/ue-contexts/imsi-001010000000002/sendsms', { jsonData: { smsRecordId: 'mt-test-3', smsPayload: { hex: `04${rpHex.slice(2, 4)}0116` } } });
  const r = await pending;
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.result, 'FAILURE');
  assert.strictEqual(r.body.rpCause, 0x16);
  assert.strictEqual(typeof r.body.rpCause, 'number', 'contract: rpCause is an integer, always present');
  assert.strictEqual(r.body.deliveryReport, undefined, 'no TPDU from the UE, so no deliveryReport');
});

test('MT: unreachable UE gives 504 ABSENT_SUBSCRIBER, unknown subscriber 404, missing body 400', async () => {
  amfReply = () => json(504, { cause: 'UE_NOT_REACHABLE' });
  const a = await req('POST', '/smsc/mt-forward-short-message', { supi: 'imsi-001010000000002', smsRecordId: 'mt-test-4', sms: { hex: 'AA' } });
  assert.strictEqual(a.status, 504);
  assert.strictEqual(a.body.result, 'ABSENT_SUBSCRIBER');
  assert.strictEqual((await req('POST', '/smsc/mt-forward-short-message', { supi: 'imsi-009', sms: { hex: 'AA' } })).status, 404);
  assert.strictEqual((await req('POST', '/smsc/mt-forward-short-message', {})).status, 400);
});

test('log: entries are grouped per SMS with flow and kind, the UE answer joins the MT flow', async () => {
  const log = (await req('GET', '/log?limit=500')).body;
  const mt1 = log.filter(e => e.flow === 'mt-test-1');
  assert.ok(mt1.length >= 4, 'MT request, AMF call, UE answer and replies share one flow');
  assert.ok(mt1.every(e => e.kind === 'MT'));
  assert.ok(mt1.some(e => e.what.includes('sendsms')), 'the UE RP-ACK is part of the MT flow');
  const mo1 = log.filter(e => e.flow === 'mo-test-1');
  assert.ok(mo1.length >= 3 && mo1.every(e => e.kind === 'MO'));
});

test('metrics: counters and Prometheus text', async () => {
  const m = (await req('GET', '/metrics')).body;
  assert.ok(m.inbound.UplinkSMS.count >= 4);
  assert.ok(m.outbound.smsc.count >= 2);
  assert.match((await raw('GET', '/metrics.prom')).text, /smsf_inbound_total\{route="UplinkSMS",status="200"\}/);
});

test('deactivate: removes the context and unregisters at the UDM', async () => {
  assert.strictEqual((await req('DELETE', '/nsmsf-sms/v2/ue-contexts/imsi-001010000000002')).status, 204);
  assert.strictEqual((await req('DELETE', '/nsmsf-sms/v2/ue-contexts/imsi-001010000000002')).status, 404);
  assert.ok(calls.some(c => c.method === 'DELETE' && c.url.includes('/nudm-uecm/')));
});
