// Local test for the UDM plugin (board/plugins/hetoteam/index.js).
// Runs the plugin behind a tiny HTTP server together with a fake NRF and a fake SMSC, so nothing on the
// real board is touched. Run from the repo root:  node projects/hetoteam/test/udm.test.js

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PORT = 18765;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SMSF_BOARD_URL = BASE;
process.env.NRF_TEAM = 'fake-nrf';

const plugin = require('../../../board/plugins/hetoteam/index.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hetoteam-udm-'));

const nrfCalls = [];
const alerts = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const parts = url.pathname.split('/');
  if (parts[1] === 't' && parts[2] === 'hetoteam') {
    const handled = await plugin.handle(req, res, { team: 'hetoteam', path: '/' + parts.slice(3).join('/'), url, dataDir });
    if (!handled && !res.headersSent) { res.writeHead(404); res.end('{"error":"not found"}'); }
    return;
  }
  let body = '';
  for await (const c of req) body += c;
  if (url.pathname.startsWith('/t/fake-nrf/nnrf-nfm/v1/nf-instances/')) {
    nrfCalls.push({ method: req.method, body: body ? JSON.parse(body) : null, ct: req.headers['content-type'] });
    res.writeHead(req.method === 'PUT' ? 201 : 204, { 'content-type': 'application/json' });
    // heartBeatTimer 1 so the second NRF tick (13 s) sends a heartbeat during the test.
    return res.end(req.method === 'PUT' ? JSON.stringify({ ...JSON.parse(body), heartBeatTimer: 1 }) : '');
  }
  if (url.pathname === '/t/fake-nrf/nnrf-disc/v1/nf-instances') {
    const t = url.searchParams.get('target-nf-type');
    // Like smsf-hao's NRF: path-style apiPrefix plus a computed apiRoot.
    const inst = t === 'CUSTOM_SMSC' ? [{ nfType: t, fqdn: 'elsewhere.invalid', nfServices: [{ scheme: 'http', apiPrefix: '/t/fake-smsc', apiRoot: `${BASE}/t/fake-smsc` }] }] : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ validityPeriod: 60, nfInstances: inst }));
  }
  if (url.pathname === '/t/fake-smsc/smsc/alert-service-centre') {
    alerts.push(JSON.parse(body));
    res.writeHead(204); return res.end();
  }
  res.writeHead(404); res.end();
});

async function req(method, p, body) {
  const r = await fetch(`${BASE}/t/hetoteam${p}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await r.text();
  return { status: r.status, ct: r.headers.get('content-type') || '', location: r.headers.get('location'), body: text ? JSON.parse(text) : null };
}

const REG = { smsfInstanceId: '6f1c2c1e-0000-4000-8000-0000006b7269', plmnId: { mcc: '001', mnc: '01' }, smsfMAPAddress: '46700000999' };
const UECM = s => `/nudm-uecm/v1/${s}/registrations/smsf-3gpp-access`;
const SRI = '/sms-routing/v1/send-routing-info-for-sm';
const RSDS = '/sms-routing/v1/report-sm-delivery-status';
const wait = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  plugin.init({ dataDir });

  await t('NRF registration with UDM profile, fqdn, apiPrefix and apiRoot', async () => {
    await wait(3500);
    const put = nrfCalls.find(c => c.method === 'PUT');
    assert(put, 'no PUT to NRF');
    assert.strictEqual(put.body.nfType, 'UDM');
    assert.strictEqual(put.body.fqdn, '127.0.0.1');
    assert(put.body.nfServices.every(s => s.apiPrefix === '/t/hetoteam' && s.apiRoot === `${BASE}/t/hetoteam` && s.scheme === 'http'));
    assert.strictEqual((await req('GET', '/status')).body.nrf.registered, true);
  });

  await t('UECM PUT new → 201 + Location', async () => {
    const r = await req('PUT', UECM('imsi-001010000000001'), REG);
    assert.strictEqual(r.status, 201);
    assert(r.location.endsWith(UECM('imsi-001010000000001')));
    assert.strictEqual(r.body.smsfInstanceId, REG.smsfInstanceId);
  });
  await t('UECM PUT again → 200', async () => {
    assert.strictEqual((await req('PUT', UECM('imsi-001010000000001'), REG)).status, 200);
  });
  await t('UECM GET by GPSI → 200', async () => {
    const r = await req('GET', UECM('msisdn-46700000001'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.smsfMAPAddress, '46700000999');
  });
  await t('UECM PUT unknown → 404 USER_NOT_FOUND problem+json', async () => {
    const r = await req('PUT', UECM('imsi-001010000000099'), REG);
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.cause, 'USER_NOT_FOUND');
    assert(r.ct.startsWith('application/problem+json'));
  });
  await t('UECM PUT missing plmnId → 400 MANDATORY_IE_MISSING', async () => {
    const r = await req('PUT', UECM('imsi-001010000000002'), { smsfInstanceId: 'x' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.cause, 'MANDATORY_IE_MISSING');
  });
  await t('UECM PUT bad JSON → 400 INVALID_MSG_FORMAT', async () => {
    const r = await req('PUT', UECM('imsi-001010000000002'), '{nope');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.cause, 'INVALID_MSG_FORMAT');
  });
  await t('UECM GET not registered → 404 CONTEXT_NOT_FOUND', async () => {
    const r = await req('GET', UECM('imsi-001010000000002'));
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.cause, 'CONTEXT_NOT_FOUND');
  });

  await t('SDM sms-data / sms-mng-data per test subscriber', async () => {
    assert.deepStrictEqual((await req('GET', '/nudm-sdm/v2/imsi-001010000000001/sms-data')).body, { smsSubscribed: true });
    assert.strictEqual((await req('GET', '/nudm-sdm/v2/imsi-001010000000003/sms-data')).body.smsSubscribed, false);
    assert.strictEqual((await req('GET', '/nudm-sdm/v2/imsi-001010000000004/sms-mng-data')).body.mtSmsBarringAll, true);
    assert.strictEqual((await req('GET', '/nudm-sdm/v2/imsi-001010000000005/sms-mng-data')).body.moSmsBarringAll, true);
  });
  await t('SDM dataset-names=SMS_SUB,SMS_MNG', async () => {
    const r = await req('GET', '/nudm-sdm/v2/imsi-001010000000001?dataset-names=SMS_SUB,SMS_MNG');
    assert.strictEqual(r.status, 200);
    assert(r.body.smsSubsData && r.body.smsMngData);
  });
  await t('SDM unknown → 404 USER_NOT_FOUND; sm-data → 404 DATA_NOT_FOUND', async () => {
    assert.strictEqual((await req('GET', '/nudm-sdm/v2/imsi-001019999999999/sms-data')).body.cause, 'USER_NOT_FOUND');
    assert.strictEqual((await req('GET', '/nudm-sdm/v2/imsi-001010000000001/sm-data')).body.cause, 'DATA_NOT_FOUND');
  });

  await t('SRI-for-SM registered UE → 200 servingNode SMSF', async () => {
    const r = await req('POST', SRI, { msisdn: '46700000001', scAddress: '46700000100' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.supi, 'imsi-001010000000001');
    assert.strictEqual(r.body.servingNode.smsfInstanceId, REG.smsfInstanceId);
  });
  await t('SRI-for-SM unknown → 404 UNKNOWN_SUBSCRIBER 5001', async () => {
    const r = await req('POST', SRI, { msisdn: '46799999999', scAddress: '46700000100' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.result, 'UNKNOWN_SUBSCRIBER');
    assert.strictEqual(r.body.diameterResultCode, 5001);
  });
  await t('SRI-for-SM SMS not allowed → 403 TELESERVICE_NOT_PROVISIONED', async () => {
    const r = await req('POST', SRI, { msisdn: '46700000003', scAddress: '46700000100' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.result, 'TELESERVICE_NOT_PROVISIONED');
  });
  await t('SRI-for-SM MT barred → 403 CALL_BARRED', async () => {
    const r = await req('POST', SRI, { msisdn: '46700000004', scAddress: '46700000100' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.result, 'CALL_BARRED');
  });
  await t('SRI-for-SM missing scAddress → 400 UNEXPECTED_DATA_VALUE', async () => {
    assert.strictEqual((await req('POST', SRI, { msisdn: '46700000001' })).body.result, 'UNEXPECTED_DATA_VALUE');
  });

  await t('Stretch: absent UE → MWD, then SMSF registers → Alert-Service-Centre', async () => {
    const r = await req('POST', SRI, { msisdn: 'msisdn-46700000002', scAddress: '46700000100' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.result, 'ABSENT_SUBSCRIBER_SM');
    assert.strictEqual(r.body.diameterResultCode, 5550);
    assert.strictEqual(r.body.mwdStatus.mnrf, true);
    const rep = await req('POST', RSDS, { msisdn: '46700000002', scAddress: '46700000100', deliveryOutcome: 'ABSENT_SUBSCRIBER' });
    assert.strictEqual(rep.status, 200);
    assert.strictEqual(rep.body.mwdStatus.scAddressInMwd, true);
    assert.strictEqual((await req('PUT', UECM('imsi-001010000000002'), REG)).status, 201);
    await wait(1500);
    assert.deepStrictEqual(alerts, [], 'alert sent before the 2 s delay');
    await wait(1000);
    assert.deepStrictEqual(alerts, [{ msisdn: '46700000002', scAddress: '46700000100', alertReason: 'UE_PRESENT' }]);
    assert.strictEqual((await req('GET', '/registrations')).body.mwd['imsi-001010000000002'], undefined, 'MWD not cleared');
  });
  await t('Alert skipped when the SMSF deregisters within the delay; MWD kept for the next registration', async () => {
    assert.strictEqual((await req('DELETE', UECM('imsi-001010000000002'))).status, 204);
    assert.strictEqual((await req('POST', SRI, { msisdn: '46700000002', scAddress: '46700000100' })).body.result, 'ABSENT_SUBSCRIBER_SM');
    await req('PUT', UECM('imsi-001010000000002'), REG);
    await req('DELETE', UECM('imsi-001010000000002'));
    await wait(2500);
    assert.strictEqual(alerts.length, 1, 'alert sent although the UE deregistered');
    assert((await req('GET', '/registrations')).body.mwd['imsi-001010000000002'], 'MWD lost');
    await req('PUT', UECM('imsi-001010000000002'), REG);
    await wait(2500);
    assert.strictEqual(alerts.length, 2);
    assert.strictEqual((await req('GET', '/registrations')).body.mwd['imsi-001010000000002'], undefined);
  });
  await t('Report-SM-Delivery-Status SUCCESSFUL_TRANSFER clears MWD; bad outcome → 400', async () => {
    await req('POST', RSDS, { msisdn: '46700000001', scAddress: '46700000100', deliveryOutcome: 'MEMORY_CAPACITY_EXCEEDED' });
    const ok = await req('POST', RSDS, { msisdn: '46700000001', scAddress: '46700000100', deliveryOutcome: 'SUCCESSFUL_TRANSFER' });
    assert.strictEqual(ok.body.mwdStatus.scAddressInMwd, false);
    assert.strictEqual((await req('POST', RSDS, { msisdn: '46700000001', scAddress: '1', deliveryOutcome: 'X' })).status, 400);
  });

  await t('UECM DELETE → 204, then 404 CONTEXT_NOT_FOUND', async () => {
    assert.strictEqual((await req('DELETE', UECM('imsi-001010000000001'))).status, 204);
    assert.strictEqual((await req('DELETE', UECM('imsi-001010000000001'))).body.cause, 'CONTEXT_NOT_FOUND');
  });
  await t('State persisted in dataDir', async () => {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert(s.registrations['imsi-001010000000002']);
    assert(!s.registrations['imsi-001010000000001']);
  });
  await t('Log records incoming and outgoing messages; since filters', async () => {
    const l = (await req('GET', '/log')).body;
    assert(l.some(e => e.dir === 'in' && e.peer === 'smsf' && e.status === 201 && e.request && e.request.smsfInstanceId));
    assert(l.some(e => e.dir === 'out' && e.peer === 'smsc'));
    const since = l[l.length - 1].id;
    assert.strictEqual((await req('GET', `/log?since=${since}`)).body.length, 0);
  });
  await t('Unknown path → 404 from board', async () => {
    assert.strictEqual((await req('GET', '/nope')).status, 404);
  });
  await t('Log entries carry ms', async () => {
    const l = (await req('GET', '/log')).body;
    assert(l.filter(e => e.dir !== 'note').every(e => typeof e.ms === 'number'));
  });
  await t('GET /metrics: KPIs, ops and causes', async () => {
    const m = (await req('GET', '/metrics')).body;
    assert.strictEqual(m.kpi.provisionedSubscribers, 5);
    assert.strictEqual(m.kpi.activeRegistrations, 1);
    assert.strictEqual(m.kpi.nrfRegistered, true);
    assert(m.ops.uecm_register.total >= 3 && m.ops.uecm_register.ok >= 2);
    assert(m.ops.uecm_register.results.USER_NOT_FOUND >= 1);
    assert(m.ops.sri_for_sm.results.ABSENT_SUBSCRIBER_SM >= 1);
    assert.strictEqual(m.kpi.sriAbsentSubscriber, m.ops.sri_for_sm.results.ABSENT_SUBSCRIBER_SM);
    assert(m.ops.alert_service_centre.ok >= 1 && m.kpi.alertsOk >= 1);
    assert(m.ops.nrf_register.ok === 1 && m.ops.nrf_discovery.total >= 1);
    assert(m.causes.USER_NOT_FOUND >= 1 && m.causes.CONTEXT_NOT_FOUND >= 1);
    assert(m.kpi.requestsIn > 0 && m.kpi.errorRateInPct > 0 && m.kpi.messagesLastMinute > 0);
    assert(!m.ops.other_in, '/metrics, /log etc. must not count as protocol traffic');
  });
  await t('GET /metrics?format=prometheus', async () => {
    const r = await fetch(`${BASE}/t/hetoteam/metrics?format=prometheus`);
    assert(r.headers.get('content-type').startsWith('text/plain'));
    const text = await r.text();
    assert(/^udm_registrations_active 1$/m.test(text));
    assert(/^udm_messages_total\{op="uecm_register",dir="in",result="USER_NOT_FOUND"\} \d+$/m.test(text));
  });
  await t('NRF heartbeat is PATCH with an empty array', async () => {
    for (let i = 0; i < 30 && !nrfCalls.some(c => c.method === 'PATCH'); i++) await wait(500);
    const patch = nrfCalls.find(c => c.method === 'PATCH');
    assert(patch, 'no heartbeat sent');
    assert.deepStrictEqual(patch.body, []);
    assert.strictEqual(patch.ct, 'application/json-patch+json');
    assert.strictEqual((await req('GET', '/metrics')).body.ops.nrf_heartbeat.ok, 1);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
