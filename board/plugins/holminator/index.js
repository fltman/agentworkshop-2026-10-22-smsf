// SMSC (team holminator): simulated SGd/S6c-style SMSC over HTTP/JSON, served at /t/holminator/.
// Contract: projects/holminator/CONTRACT.md. Plan: projects/holminator/PLAN.md.

const fs = require('node:fs');
const path = require('node:path');
const tpdu = require('./tpdu.js');

const TEAM = 'holminator';
// Peers publish public apiPrefix values, so we use the public origin too (override for local runs).
const HOST = (process.env.SMSF_BOARD_URL || 'https://smsf.torget.bjarby.com').replace(/\/$/, '');
// The NRF is the one well-known address; everything else is discovered through it.
const NRF_TEAM = process.env.NRF_TEAM || 'smsf-hao';
const NRF_NFM = `${HOST}/t/${NRF_TEAM}/nnrf-nfm/v1`;
const NRF_DISC = `${HOST}/t/${NRF_TEAM}/nnrf-disc/v1`;
const SELF_BASE = `${HOST}/t/${TEAM}`;
const NF_TYPE = 'CUSTOM_SMSC';
const NF_ID = '6f1c2c1e-0000-4000-8000-0000686f6c6d'; // stable across restarts, so the NRF sees one SMSC
const SC_ADDRESS = '46700000100';
const HEARTBEAT_S = 30;
const LOG_MAX = 500;
const STORE_MAX = 500;
const DEFAULT_VALIDITY_MS = 24 * 60 * 60 * 1000;

const st = {
  registered: false,
  log: [],
  logSeq: 0,
  messages: [],
  msgSeq: 0,
  disc: new Map(), // nfType or nfType/instanceId -> { base, ts }
  dataDir: null,
  timers: [],
  metrics: newMetrics(),
};

// Counters reset on restart; message totals by status come from the persisted store instead.
function newMetrics() {
  return {
    startedAt: new Date().toISOString(),
    counters: {},
    results: {}, // operation -> result -> count, for every answer we give and every answer we get
    peers: {}, // peer -> { in, out, errors, latencyMsSum, latencyMsMax, calls }
    nrf: { lastHeartbeatAt: null, lastHeartbeatStatus: null, lastRegisteredAt: null },
  };
}
function inc(name, n = 1) { st.metrics.counters[name] = (st.metrics.counters[name] || 0) + n; }
function countResult(op, result) {
  const r = st.metrics.results[op] || (st.metrics.results[op] = {});
  r[result] = (r[result] || 0) + 1;
}
function peerStats(peer) {
  return st.metrics.peers[peer]
    || (st.metrics.peers[peer] = { in: 0, out: 0, errors: 0, calls: 0, latencyMsSum: 0, latencyMsMax: 0 });
}

function rec(dir, peer, what, status, body, ms) {
  st.log.push({ id: ++st.logSeq, ts: new Date().toISOString(), dir, peer, what, status, body, ...(ms === undefined ? {} : { ms }) });
  if (st.log.length > LOG_MAX) st.log.shift();
}

function storeFile() { return st.dataDir ? path.join(st.dataDir, 'store.json') : null; }
function loadStore() {
  const f = storeFile();
  if (!f || !fs.existsSync(f)) return;
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    st.messages = Array.isArray(s.messages) ? s.messages : [];
    st.msgSeq = s.msgSeq || st.messages.length;
  } catch (e) { console.error(`[${TEAM}] store:`, e.message); }
}
function saveStore() {
  const f = storeFile();
  if (!f) return;
  try { fs.writeFileSync(f, JSON.stringify({ msgSeq: st.msgSeq, messages: st.messages })); }
  catch (e) { console.error(`[${TEAM}] store:`, e.message); }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
  return true;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  return t ? JSON.parse(t) : {};
}

async function call(peer, method, url, body, { quiet = false, op = null } = {}) {
  if (!quiet) rec('out', peer, `${method} ${url}`, null, body);
  const ps = peerStats(peer);
  ps.out++; ps.calls++;
  const t0 = Date.now();
  const done = (status, json) => {
    const ms = Date.now() - t0;
    ps.latencyMsSum += ms;
    if (ms > ps.latencyMsMax) ps.latencyMsMax = ms;
    if (status === 0 || status >= 500) ps.errors++;
    else ps.in++;
    if (op) countResult(op, status === 0 ? 'NO_ANSWER' : ((json && json.result) || String(status)));
    return ms;
  };
  try {
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const ms = done(r.status, json);
    if (!quiet || r.status >= 300) rec('in', peer, `${method} ${url}`, r.status, json, ms);
    return { status: r.status, body: json, ms };
  } catch (e) {
    const ms = done(0, null);
    rec('in', peer, `${method} ${url}`, 0, e.message, ms);
    return { status: 0, body: null, error: e.message, ms };
  }
}

function nfProfile() {
  return {
    nfInstanceId: NF_ID,
    nfType: NF_TYPE,
    nfStatus: 'REGISTERED',
    fqdn: new URL(HOST).hostname,
    heartBeatTimer: HEARTBEAT_S,
    plmnList: [{ mcc: '001', mnc: '01' }],
    customInfo: { scAddress: SC_ADDRESS },
    nfServices: [{
      serviceInstanceId: 'nsmsc-sgd-1', serviceName: 'nsmsc-sgd',
      versions: [{ apiVersionInUri: 'v1', apiFullVersion: '1.0.0' }],
      scheme: new URL(HOST).protocol.replace(':', ''), nfServiceStatus: 'REGISTERED',
      apiPrefix: `/t/${TEAM}`, apiRoot: SELF_BASE,
    }],
  };
}

async function registerInNrf() {
  inc('nrf_register_attempts');
  const r = await call('nrf', 'PUT', `${NRF_NFM}/nf-instances/${NF_ID}`, nfProfile(), { op: 'NFRegister' });
  st.registered = r.status === 200 || r.status === 201;
  if (st.registered) { inc('nrf_registrations'); st.metrics.nrf.lastRegisteredAt = new Date().toISOString(); }
  return st.registered;
}

// TS 29.510 heartbeat; the NRF suspends us after 3 missed ones. A 404 means it lost us: register again.
async function heartbeat() {
  if (!st.registered) return registerInNrf();
  const r = await call('nrf', 'PATCH', `${NRF_NFM}/nf-instances/${NF_ID}`, [], { quiet: true, op: 'NFUpdate (heartbeat)' });
  st.metrics.nrf.lastHeartbeatAt = new Date().toISOString();
  st.metrics.nrf.lastHeartbeatStatus = r.status;
  inc(r.status >= 200 && r.status < 300 ? 'nrf_heartbeats_ok' : 'nrf_heartbeats_failed');
  if (r.status === 404) return registerInNrf();
  if (r.status === 0 || r.status >= 300) st.registered = false;
}

// The NRF adds apiRoot to discovery results; peers may also publish an absolute or a relative apiPrefix.
function baseOf(inst) {
  const svc = (inst.nfServices || [])[0] || {};
  if (svc.apiRoot) return svc.apiRoot.replace(/\/$/, '');
  const prefix = svc.apiPrefix || inst.apiPrefix || '';
  if (/^https?:\/\//.test(prefix)) return prefix.replace(/\/$/, '');
  if (prefix.startsWith('/')) return `${HOST}${prefix}`.replace(/\/$/, '');
  return null;
}

// Base URL of an NF through NRF discovery, cached 60 s.
async function resolve(nfType, instanceId) {
  const key = instanceId ? `${nfType}/${instanceId}` : nfType;
  const hit = st.disc.get(key);
  if (hit && Date.now() - hit.ts < 60000) { inc('nrf_discovery_cache_hits'); return hit.base; }
  let q = `target-nf-type=${encodeURIComponent(nfType)}&requester-nf-type=${NF_TYPE}`;
  if (instanceId) q += `&target-nf-instance-id=${encodeURIComponent(instanceId)}`;
  inc('nrf_discoveries');
  const r = await call('nrf', 'GET', `${NRF_DISC}/nf-instances?${q}`, undefined, { op: 'NFDiscover' });
  const list = r.body && Array.isArray(r.body.nfInstances) ? r.body.nfInstances : [];
  const inst = (instanceId && list.find(i => i.nfInstanceId === instanceId)) || list[0];
  if (!inst) { inc('nrf_discoveries_empty'); return null; }
  const base = baseOf(inst);
  if (base) st.disc.set(key, { base, ts: Date.now() });
  return base;
}

function every(ms, fn) {
  const t = setInterval(() => {
    try { const p = fn(); if (p && p.catch) p.catch(e => console.error(`[${TEAM}]`, e.message)); }
    catch (e) { console.error(`[${TEAM}]`, e.message); }
  }, ms);
  if (t.unref) t.unref();
  st.timers.push(t);
  return t;
}

function notImplemented(res, what) {
  return send(res, 501, { result: 'FAILURE', diameterResultCode: 5012, cause: `${what} not implemented yet` });
}

function reply(res, peer, what, status, body) {
  rec('out', peer, `answer ${what}`, status, body);
  peerStats(peer).out++;
  const cause = body && body.smDeliveryFailureCause && body.smDeliveryFailureCause.smEnumeratedDeliveryFailureCause;
  countResult(what, (body && body.result ? body.result : String(status)) + (cause ? `/${cause}` : ''));
  return send(res, status, body);
}

// Inbound request from a peer: logged and counted the same way for every operation.
function inbound(peer, what, body) {
  peerStats(peer).in++;
  rec('in', peer, what, null, body);
}

function saveMessage(m) {
  st.messages.push(m);
  if (st.messages.length > STORE_MAX) st.messages.shift();
  saveStore();
  return m;
}

// TS 29.338 6.3.3.6, values shared with MAP SM-EnumeratedDeliveryFailureCause.
const SM_FAILURE = {
  MEMORY_CAPACITY_EXCEEDED: 0, EQUIPMENT_PROTOCOL_ERROR: 1, EQUIPMENT_NOT_SM_EQUIPPED: 2,
  UNKNOWN_SERVICE_CENTRE: 3, SC_CONGESTION: 4, INVALID_SME_ADDRESS: 5, USER_NOT_SC_USER: 6,
};

// OFA with DIAMETER_ERROR_SM_DELIVERY_FAILURE. The SMS-SUBMIT-REPORT with TP-FCS goes in deliveryReport
// (SM-RP-UI) and in smDiagnosticInfo, so the SMSF can carry it to the UE in RP-ERROR (TS 23.040 3.4.2).
function moFailure(res, cause, fcs, detail) {
  const report = fcs === undefined ? undefined : { hex: tpdu.bytesToHex(tpdu.encodeSubmitReportError(fcs)) };
  return reply(res, 'smsf', 'MO-Forward-Short-Message', 403, {
    result: 'SM_DELIVERY_FAILURE', diameterResultCode: 5555,
    smDeliveryFailureCause: { smEnumeratedDeliveryFailureCause: cause, value: SM_FAILURE[cause] },
    ...(report ? { deliveryReport: report, smDiagnosticInfo: report.hex } : {}),
    detail,
  });
}

// Forced outcomes so other teams can test their error handling against us (GET /test lists them).
// Each one is what the spec lets an SMSC answer to OFR (TS 29.338 6.2.1, 7.2) with the TP-FCS of TS 23.040 9.2.3.22.
const MO_SCENARIOS = {
  SUCCESS: { what: '200 SUCCESS + SMS-SUBMIT-REPORT (RP-ACK)' },
  UNKNOWN_SERVICE_CENTRE: { cause: 'UNKNOWN_SERVICE_CENTRE', what: '403 5555, no SUBMIT-REPORT' },
  INVALID_SME_ADDRESS: { cause: 'INVALID_SME_ADDRESS', fcs: 'INVALID_SME_ADDRESS', what: '403 5555 + SUBMIT-REPORT FCS C3' },
  DUPLICATE: { cause: 'EQUIPMENT_PROTOCOL_ERROR', fcs: 'SM_REJECTED_DUPLICATE_SM', what: '403 5555 + SUBMIT-REPORT FCS C5' },
  SC_CONGESTION: { cause: 'SC_CONGESTION', fcs: 'SC_BUSY', what: '403 5555 + SUBMIT-REPORT FCS C0' },
  USER_NOT_SC_USER: { cause: 'USER_NOT_SC_USER', fcs: 'NO_SC_SUBSCRIPTION', what: '403 5555 + SUBMIT-REPORT FCS C1' },
  DESTINATION_BARRED: { cause: 'USER_NOT_SC_USER', fcs: 'DESTINATION_SME_BARRED', what: '403 5555 + SUBMIT-REPORT FCS C4' },
  SYSTEM_FAILURE: { cause: 'SC_CONGESTION', fcs: 'SC_SYSTEM_FAILURE', what: '403 5555 + SUBMIT-REPORT FCS C2' },
  FACILITY_NOT_SUPPORTED: { status: 403, result: 'FACILITY_NOT_SUPPORTED', code: 5552, what: '403 5552' },
  SERVER_ERROR: { status: 500, result: 'UNABLE_TO_COMPLY', code: 5012, what: '500 5012' },
  SLOW: { delayMs: 10000, what: 'SUCCESS after 10 s (test your timeouts)' },
  NO_ANSWER: { delayMs: 30000, what: 'SUCCESS after 30 s, past every caller timeout' },
};

const sameAddr = (a, b) => tpdu.digitsOf(a) === tpdu.digitsOf(b);
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
const flag = (url, name) => !!url && ['1', 'true', 'yes'].includes(String(url.searchParams.get(name) || '').toLowerCase());

// TS 29.338 6.2.1 (OFR/OFA) and TS 23.040 clause 10 MO: the SC accepts the SMS-SUBMIT, answers, then
// forwards it towards the recipient. ?scenario= forces an outcome, ?dryRun=1 validates and answers without storing
// or delivering.
async function moForward(req, res, url) {
  const what = 'MO-Forward-Short-Message';
  const scenarioName = url && url.searchParams.get('scenario') ? url.searchParams.get('scenario').toUpperCase() : null;
  const dryRun = flag(url, 'dryRun');
  let b;
  inc('mo_received');
  if (scenarioName || dryRun) inc('test_requests');
  try { b = await readJson(req); } catch {
    inbound('smsf', 'POST /smsc/mo-forward-short-message', 'invalid JSON');
    inc('mo_rejected');
    return reply(res, 'smsf', what, 400, { result: 'UNEXPECTED_DATA_VALUE', diameterResultCode: 5004, detail: 'body is not JSON' });
  }
  inbound('smsf', `POST /smsc/mo-forward-short-message${scenarioName ? ` [scenario ${scenarioName}]` : ''}${dryRun ? ' [dry run]' : ''}`, b);
  const bad = (status, body) => { inc('mo_rejected'); return reply(res, 'smsf', what, status, body); };
  const fail = (cause, fcs, detail) => { inc('mo_rejected'); return moFailure(res, cause, fcs, detail); };

  let sc = null;
  if (scenarioName) {
    sc = MO_SCENARIOS[scenarioName];
    if (!sc) return bad(400, { result: 'UNEXPECTED_DATA_VALUE', diameterResultCode: 5004, detail: `unknown scenario ${scenarioName}, see GET /t/${TEAM}/test` });
    if (sc.delayMs) await sleep(sc.delayMs);
    if (sc.cause) return fail(sc.cause, sc.fcs ? tpdu.FCS[sc.fcs] : undefined, `forced by scenario ${scenarioName}`);
    if (sc.status) return bad(sc.status, { result: sc.result, diameterResultCode: sc.code, detail: `forced by scenario ${scenarioName}` });
  }

  const hex = b && b.sms && b.sms.hex;
  const originator = (b && (b.msisdn || b.supi)) || null;
  if (!hex || !originator) {
    return bad(400, {
      result: 'MISSING_AVP', diameterResultCode: 5005,
      detail: 'SM-RP-UI (sms.hex) and User-Identifier (supi or msisdn) are mandatory',
    });
  }

  let mo;
  try { mo = tpdu.decodeMo(hex); } catch (e) {
    return bad(400, { result: 'UNEXPECTED_DATA_VALUE', diameterResultCode: 5004, detail: `SM-RP-UI: ${e.message}` });
  }

  // SM RP DA must be our SC address (TS 29.338 6.2.1.3). It comes in the body or in the RP-DATA.
  const scAddress = b.scAddress || (mo.rp && mo.rp.rpDa) || null;
  if (scAddress && !sameAddr(scAddress, SC_ADDRESS)) {
    return fail('UNKNOWN_SERVICE_CENTRE', undefined, `SC address ${scAddress} is not ${SC_ADDRESS}`);
  }

  const s = mo.submit;
  const to = tpdu.digitsOf(s.da);
  if (!to || to.length > 15) return fail('INVALID_SME_ADDRESS', tpdu.FCS.INVALID_SME_ADDRESS, 'TP-DA is empty or invalid');

  const from = tpdu.digitsOf(b.msisdn) || null;
  const supi = b.supi || null;
  // TS 23.040 9.2.3.25: TP-RD=1 tells the SC to reject an SMS-SUBMIT with the same TP-MR and TP-DA from the same OA
  // as one it still holds; TP-RD=0 tells it to accept.
  const dup = st.messages.find(m => m.direction === 'MO' && m.mr === s.mr && m.to === to
    && ((from && m.from === from) || (supi && m.supi === supi))
    && ['ACCEPTED', 'PENDING', 'WAITING'].includes(m.status));
  if (dup && s.rd) {
    return fail('EQUIPMENT_PROTOCOL_ERROR', tpdu.FCS.SM_REJECTED_DUPLICATE_SM, `duplicate of ${dup.id} (TP-MR ${s.mr}, TP-RD=1)`);
  }
  if (dup) inc('mo_duplicates_accepted');

  const now = new Date();
  const report = { hex: tpdu.bytesToHex(tpdu.encodeSubmitReportAck(now)) };
  if (dryRun) {
    inc('mo_dry_runs');
    return reply(res, 'smsf', what, 200, {
      result: 'SUCCESS', diameterResultCode: 2001, messageId: null, dryRun: true, deliveryReport: report,
      decoded: { from, supi, to, text: s.text, mr: s.mr, srr: s.srr, rd: s.rd, dcs: s.dcs, rpWrapped: !!mo.rp },
    });
  }
  const msg = saveMessage({
    id: `smsc-${++st.msgSeq}`,
    direction: 'MO',
    status: 'ACCEPTED',
    from, supi, to,
    text: s.text, mr: s.mr, srr: s.srr, pid: s.pid, dcs: s.dcs,
    smsRecordId: b.smsRecordId || null,
    submittedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (s.validityMs || DEFAULT_VALIDITY_MS)).toISOString(),
    duplicateOf: dup ? dup.id : null,
    history: [{ ts: now.toISOString(), event: 'ACCEPTED', detail: `MO from ${from || supi}` }],
  });

  inc('mo_accepted');
  reply(res, 'smsf', what, 200, {
    result: 'SUCCESS', diameterResultCode: 2001, messageId: msg.id, deliveryReport: report,
  });
  onMoAccepted(msg);
  return true;
}

// MT delivery of an accepted MO SMS to its recipient comes with step 3 (PLAN.md).
function onMoAccepted() {}

function metricsSnapshot() {
  const byStatus = {}, byDirection = {};
  for (const m of st.messages) {
    byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    byDirection[m.direction] = (byDirection[m.direction] || 0) + 1;
  }
  const peers = {};
  for (const [k, p] of Object.entries(st.metrics.peers)) {
    const answered = p.calls ? p.calls : 0;
    peers[k] = { ...p, latencyMsAvg: answered ? Math.round(p.latencyMsSum / answered) : null };
  }
  return {
    nf: 'SMSC', team: TEAM, nfInstanceId: NF_ID, scAddress: SC_ADDRESS,
    startedAt: st.metrics.startedAt, uptimeS: Math.round((Date.now() - Date.parse(st.metrics.startedAt)) / 1000),
    nrf: { team: NRF_TEAM, registered: st.registered, ...st.metrics.nrf },
    counters: { ...st.metrics.counters },
    results: st.metrics.results,
    peers,
    messages: { total: st.messages.length, byStatus, byDirection },
  };
}

// Prometheus text exposition, for anyone who wants to scrape us.
function metricsText() {
  const m = metricsSnapshot();
  const esc = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
  const out = [];
  const line = (name, labels, v) => {
    const l = Object.entries(labels).map(([k, x]) => `${k}="${esc(x)}"`).join(',');
    out.push(`smsc_${name}${l ? `{${l}}` : ''} ${v}`);
  };
  line('up', {}, 1);
  line('nrf_registered', {}, m.nrf.registered ? 1 : 0);
  line('uptime_seconds', {}, m.uptimeS);
  for (const [k, v] of Object.entries(m.counters)) line(`${k}_total`, {}, v);
  for (const [op, r] of Object.entries(m.results)) for (const [res, v] of Object.entries(r)) line('results_total', { operation: op, result: res }, v);
  for (const [peer, p] of Object.entries(m.peers)) {
    line('peer_requests_in_total', { peer }, p.in);
    line('peer_requests_out_total', { peer }, p.out);
    line('peer_errors_total', { peer }, p.errors);
    line('peer_latency_ms_max', { peer }, p.latencyMsMax);
    line('peer_latency_ms_sum', { peer }, p.latencyMsSum);
  }
  for (const [s, v] of Object.entries(m.messages.byStatus)) line('messages', { status: s }, v);
  return out.join('\n') + '\n';
}

// GET /test: everything another team can poke at, with ready-made request bodies.
function testCatalogue() {
  const base = `/t/${TEAM}`;
  const submitHex = tpdu.bytesToHex(tpdu.encodeSubmit({ mr: 1, to: '46700000002', text: 'Hello' }));
  const rpHex = tpdu.bytesToHex(tpdu.wrapRpDataToNetwork({ ref: 1, scAddress: SC_ADDRESS,
    tpdu: tpdu.encodeSubmit({ mr: 2, to: '46700000002', text: 'Hello' }) }));
  const mo = { supi: 'imsi-001010000000001', msisdn: '46700000001', scAddress: SC_ADDRESS, sms: { hex: submitHex }, smsRecordId: 'test-1' };
  return {
    nf: 'SMSC', team: TEAM, scAddress: SC_ADDRESS,
    note: 'Every endpoint is open. ?dryRun=1 validates and answers without storing or delivering. ?scenario=<NAME> forces an outcome. Results show up in /colony/holminator.',
    endpoints: [
      { method: 'POST', path: `${base}/smsc/mo-forward-short-message`, what: 'MO-Forward-Short-Message (TS 29.338 OFR/OFA). Real: stores the SM and delivers it as MT.', example: mo },
      { method: 'POST', path: `${base}/smsc/mo-forward-short-message?dryRun=1`, what: 'Same, nothing stored or delivered; the answer includes the decoded SMS-SUBMIT.', example: mo },
      { method: 'POST', path: `${base}/smsc/mo-forward-short-message?dryRun=1`, what: 'RP-DATA wrapped SMS-SUBMIT is accepted too.', example: { ...mo, sms: { hex: rpHex } } },
      { method: 'POST', path: `${base}/smsc/alert-service-centre`, what: 'Alert-Service-Centre from the UDM: redeliver waiting SMs.', example: { msisdn: '46700000002', scAddress: SC_ADDRESS, alertReason: 'UE_PRESENT' } },
      { method: 'POST', path: `${base}/api/mt`, what: 'Make the SMSC originate an MT SMS (SRI-for-SM to UDM, then MT-Forward to the SMSF).', example: { from: '46700000100', to: '46700000002', text: 'Hello from the SMSC', srr: true } },
      { method: 'POST', path: `${base}/test/encode`, what: 'Build a TPDU: type SUBMIT or DELIVER; rp=true wraps it in RP-DATA.', example: { type: 'SUBMIT', to: '46700000002', text: 'Hello', mr: 1, srr: false, rd: false, rp: false } },
      { method: 'POST', path: `${base}/test/decode`, what: 'Decode RP-DATA, SMS-SUBMIT or SMS-DELIVER hex.', example: { hex: submitHex } },
      { method: 'GET', path: `${base}/api/messages`, what: 'Messages the SMSC holds, with history.' },
      { method: 'GET', path: `${base}/api/log?since=0`, what: 'Every request and answer, in and out.' },
      { method: 'GET', path: `${base}/api/metrics`, what: 'Counters, results per operation, per-peer traffic and latency (JSON).' },
      { method: 'GET', path: `${base}/metrics`, what: 'The same in Prometheus text format.' },
      { method: 'GET', path: `${base}/status`, what: 'NF identity and NRF registration.' },
    ],
    moScenarios: Object.fromEntries(Object.entries(MO_SCENARIOS).map(([k, v]) => [k, v.what])),
  };
}

async function testEncode(req, res) {
  let b;
  try { b = await readJson(req); } catch { return send(res, 400, { error: 'body is not JSON' }); }
  inc('test_requests');
  try {
    const type = String(b.type || 'SUBMIT').toUpperCase();
    if (typeof b.text !== 'string') throw new Error('text is required');
    let t;
    if (type === 'SUBMIT') {
      if (!b.to) throw new Error('to is required');
      t = tpdu.encodeSubmit({ mr: Number(b.mr) || 0, to: b.to, text: b.text, srr: !!b.srr, rd: !!b.rd });
    } else if (type === 'DELIVER') {
      if (!b.from) throw new Error('from is required');
      t = tpdu.encodeDeliver({ from: b.from, text: b.text, sri: !!b.srr });
    } else throw new Error('type must be SUBMIT or DELIVER');
    const out = { type: `SMS-${type}`, tpduHex: tpdu.bytesToHex(t) };
    if (b.rp) {
      const wrap = type === 'SUBMIT' ? tpdu.wrapRpDataToNetwork : tpdu.wrapRpDataToMs;
      out.rpDataHex = tpdu.bytesToHex(wrap({ ref: Number(b.ref) || 0, scAddress: b.scAddress || SC_ADDRESS, tpdu: t }));
    }
    return send(res, 200, out);
  } catch (e) { return send(res, 400, { error: e.message }); }
}

async function testDecode(req, res) {
  let b;
  try { b = await readJson(req); } catch { return send(res, 400, { error: 'body is not JSON' }); }
  inc('test_requests');
  try { return send(res, 200, tpdu.decodeAny(String(b.hex || ''))); }
  catch (e) { return send(res, 400, { error: e.message }); }
}

async function handle(req, res, { path: p, url }) {
  if (req.method === 'POST' && p === '/smsc/mo-forward-short-message') return moForward(req, res, url);
  if (req.method === 'GET' && p === '/test') return send(res, 200, testCatalogue());
  if (req.method === 'POST' && p === '/test/encode') return testEncode(req, res);
  if (req.method === 'POST' && p === '/test/decode') return testDecode(req, res);
  if (req.method === 'POST' && p === '/smsc/alert-service-centre') {
    let b = null;
    try { b = await readJson(req); } catch { /* logged below */ }
    inbound('udm', 'POST /smsc/alert-service-centre', b);
    inc('alerts_received');
    return notImplemented(res, 'Alert-Service-Centre');
  }
  if (req.method === 'POST' && p === '/api/mt') return notImplemented(res, 'MT origination');
  if (req.method === 'GET' && p === '/api/messages') return send(res, 200, st.messages);
  if (req.method === 'GET' && p === '/api/metrics') return send(res, 200, metricsSnapshot());
  if (req.method === 'GET' && p === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(metricsText());
    return true;
  }
  if (req.method === 'GET' && p === '/api/log') {
    const since = Number((url && url.searchParams.get('since')) || 0);
    return send(res, 200, st.log.filter(e => e.id > since).slice(-200));
  }
  if (req.method === 'GET' && (p === '/status' || p === '/')) {
    return send(res, 200, {
      nf: 'SMSC', nfType: NF_TYPE, nfInstanceId: NF_ID, scAddress: SC_ADDRESS, apiPrefix: SELF_BASE,
      registeredInNrf: st.registered, messages: st.messages.length,
    });
  }
  return false;
}

module.exports = {
  init(ctx) {
    st.dataDir = ctx && ctx.dataDir;
    loadStore();
    // The NRF may load after us or lose its state on a redeploy: heartbeat() re-registers when needed.
    const first = setTimeout(() => { heartbeat().catch(e => console.error(`[${TEAM}] nrf:`, e.message)); }, 3000);
    if (first.unref) first.unref();
    every(HEARTBEAT_S * 1000, heartbeat);
  },
  handle,
  // For tests.
  _st: st,
  _internals: { nfProfile, resolve, registerInNrf, heartbeat, baseOf, saveStore, metricsSnapshot, metricsText, newMetrics, SC_ADDRESS, NF_ID, NF_TYPE },
};
