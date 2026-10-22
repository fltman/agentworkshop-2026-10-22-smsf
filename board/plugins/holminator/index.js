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
const STORE_MAX = 500; // the store holds only messages not yet final; this cap is a safety net (store_evicted)
const HISTORY_MAX = 500; // finished messages, newest last; the oldest is dropped beyond this (history_evicted)
// A message in one of these states is done: it leaves the store (st.messages) for the history (st.history).
const FINAL = ['DELIVERED', 'FAILED', 'EXPIRED', 'FORWARDED', 'REJECTED'];
const DEFAULT_VALIDITY_MS = 24 * 60 * 60 * 1000;

const st = {
  registered: false,
  log: [],
  logSeq: 0,
  messages: [], // the store: only messages not yet final (ACCEPTED, PENDING, DELIVERING, WAITING)
  history: [], // finished messages (FINAL), ring buffer of HISTORY_MAX, newest last
  msgSeq: 0,
  disc: new Map(), // nfType or nfType/instanceId -> { base, ts }
  dataDir: null,
  timers: [],
  metrics: null, // newMetrics(), set below once the key lists exist
  inflight: new Set(), // recipients with an SMS-DELIVER outstanding: only one at a time per MS (TS 23.040 6.2)
  lastScts: new Map(), // recipient -> last TP-SCTS second used, so timestamps stay unique per MS
};

// Every known counter, PDU, RP-Cause, TP-ST and SGd operation key starts at 0, so a missing key is never a silent 0.
// Counters are persisted in store.json with the messages (saveStore/loadStore); since is when they started counting.
const COUNTERS = [
  'requests_in', 'answers_error', 'test_requests', 'store_evicted', 'history_evicted',
  'mo_received', 'mo_accepted', 'mo_rejected', 'mo_dry_runs', 'mo_duplicates_accepted', 'mo_forwarded', 'mo_expired',
  'mt_originated', 'mt_attempts', 'mt_forward_not_sent', 'mt_delivered', 'mt_failed', 'mt_expired', 'mt_absent',
  'mt_retries_scheduled', 'mt_rp_error_temporary', 'mt_attempts_exhausted', 'mt_alert_fast_retries',
  'sri_requests', 'udm_delivery_reports', 'alerts_received', 'alerts_redelivering',
  'status_reports_generated', 'status_reports_sent', 'status_reports_failed', 'status_reports_expired',
  'mo_srr_requested', 'mt_srr_requested', 'mt_status_reports_simulated',
  'nrf_register_attempts', 'nrf_registrations', 'nrf_heartbeats_ok', 'nrf_heartbeats_failed',
  'nrf_discoveries', 'nrf_discoveries_empty', 'nrf_discovery_cache_hits',
];
const PDUS_IN = ['RP-DATA/SMS-SUBMIT', 'RP-ACK/SMS-DELIVER-REPORT', 'RP-ACK/STATUS-REPORT-ACK', 'RP-ERROR/SMS-DELIVER-REPORT', 'none/no-report'];
const PDUS_OUT = ['RP-ACK/SMS-SUBMIT-REPORT', 'RP-ERROR/SMS-SUBMIT-REPORT', 'RP-DATA/SMS-DELIVER', 'RP-DATA/SMS-STATUS-REPORT'];
const OPS_OUT = ['SRI-for-SM', 'MT-Forward-SM', 'Report-SM-Delivery-Status', 'NFDiscover', 'NFRegister', 'NFUpdate'];
const OPS_IN = ['MO-Forward-SM', 'Alert-SC'];
// "22 MEMORY_CAPACITY_EXCEEDED": number plus the TS 24.011 8.2.5.4 name in upper snake case.
const rpCauseKey = c => `${c} ${String(tpdu.RP_CAUSE[c] || 'Unknown RP-Cause').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
const tpStKey = v => `0x${Number(v).toString(16).padStart(2, '0')}`;
const zeros = keys => Object.fromEntries(keys.map(k => [k, 0]));
const TP_ST_KEYS = [...new Set([...Object.values(tpdu.ST), 0x60].map(tpStKey))].sort();
function newMetrics() {
  const now = new Date().toISOString();
  const causes = Object.keys(tpdu.RP_CAUSE).map(Number).map(rpCauseKey);
  return {
    startedAt: now, // this process
    since: now, // when the persisted counters started counting (kept across restarts)
    counters: zeros(COUNTERS),
    results: {}, // operation -> result -> count, for every answer we give and every answer we get
    peers: {}, // peer -> { in, out, errors, latencyMsSum, latencyMsMax, calls }
    nrf: { lastHeartbeatAt: null, lastHeartbeatStatus: null, lastRegisteredAt: null },
    pdus: { in: zeros(PDUS_IN), out: zeros(PDUS_OUT) },
    rpCauses: { in: zeros(causes), out: zeros(causes) },
    byTpSt: zeros(TP_ST_KEYS),
    byTpStMt: zeros(TP_ST_KEYS), // simulated status reports to the originating SME of an /api/mt with srr
    operationsOut: zeros(OPS_OUT),
    operationsIn: zeros(OPS_IN),
  };
}
st.metrics = newMetrics();
// Persisted parts of st.metrics, merged over fresh pre-seeded defaults on load.
const PERSISTED = ['since', 'counters', 'results', 'peers', 'pdus', 'rpCauses', 'byTpSt', 'byTpStMt', 'operationsOut', 'operationsIn'];
function restoreMetrics(saved) {
  const m = newMetrics();
  if (!saved || typeof saved !== 'object') return m;
  if (saved.since) m.since = saved.since;
  for (const k of ['counters', 'results', 'peers', 'byTpSt', 'byTpStMt', 'operationsOut', 'operationsIn']) Object.assign(m[k], saved[k] || {});
  for (const k of ['pdus', 'rpCauses']) for (const d of ['in', 'out']) Object.assign(m[k][d], (saved[k] && saved[k][d]) || {});
  return m;
}
function inc(name, n = 1) { st.metrics.counters[name] = (st.metrics.counters[name] || 0) + n; }
function bump(map, key, n = 1) { map[key] = (map[key] || 0) + n; }
function pdu(dir, key) { bump(st.metrics.pdus[dir], key); }
function rpCause(dir, c) { if (c !== null && c !== undefined) bump(st.metrics.rpCauses[dir], rpCauseKey(c)); }
// SGd/NRF operation names per Diameter-style operation; call() passes its op label.
const OP_NAME = { 'MT-Forward-Short-Message': 'MT-Forward-SM', 'NFUpdate (heartbeat)': 'NFUpdate' };
function countOp(dir, op) { bump(dir === 'out' ? st.metrics.operationsOut : st.metrics.operationsIn, OP_NAME[op] || op); }
// In-flight MT attempts, so the consistency checks hold while an attempt runs: counted but no forward sent yet
// (openNoFwd), forward sent but no answer yet (openFwd). Not persisted: a restart ends every attempt.
const mtOpen = { noFwd: 0, fwd: 0 };
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
    st.history = Array.isArray(s.history) ? s.history : [];
    st.msgSeq = s.msgSeq || st.messages.length + st.history.length;
    if (s.metrics) st.metrics = { ...restoreMetrics(s.metrics), startedAt: st.metrics.startedAt, nrf: st.metrics.nrf };
    // Migration: older files kept finished messages in the store; they belong in the history.
    for (const m of st.messages.filter(x => FINAL.includes(x.status))) retire(m);
  } catch (e) { console.error(`[${TEAM}] store:`, e.message); }
}
function saveStore() {
  const f = storeFile();
  if (!f) return;
  const metrics = Object.fromEntries(PERSISTED.map(k => [k, st.metrics[k]]));
  try { fs.writeFileSync(f, JSON.stringify({ msgSeq: st.msgSeq, messages: st.messages, history: st.history, metrics })); }
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
  if (op) countOp('out', op);
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
  const prefix = svc.apiPrefix || inst.apiPrefix || '';
  // An NRF that prefixes scheme+fqdn to an already absolute apiPrefix gives "https://hosthttps://host/..." as apiRoot.
  if (svc.apiRoot && !/^https?:\/\/.*https?:\/\//.test(svc.apiRoot)) return svc.apiRoot.replace(/\/$/, '');
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
  // With an instance id, only that instance will do: another SMSF does not hold the UE's context.
  const inst = instanceId ? list.find(i => i.nfInstanceId === instanceId) : list[0];
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

// Every inbound peer request gets exactly one reply(), so these two counters feed GET /kpi.
function reply(res, peer, what, status, body) {
  rec('out', peer, `answer ${what}`, status, body);
  peerStats(peer).out++;
  inc('requests_in');
  if (status >= 400) inc('answers_error');
  const cause = body && body.smDeliveryFailureCause && body.smDeliveryFailureCause.smEnumeratedDeliveryFailureCause;
  countResult(what, (body && body.result ? body.result : String(status)) + (cause ? `/${cause}` : ''));
  return send(res, status, body);
}

// Shared call-flow log shape {ts, dir, peer, method, path, status, body}; answers carry method null and the operation as path.
function flowEntry(e) {
  const m = /^(GET|POST|PUT|PATCH|DELETE) (\S+)(.*)$/.exec(e.what || '');
  let path = m ? m[2] : String(e.what || '').replace(/^answer /, '');
  if (m) { try { path = new URL(path).pathname; } catch { /* already a path */ } }
  return { id: e.id, ts: e.ts, dir: e.dir, peer: e.peer, method: m ? m[1] : null, path,
    status: e.status ?? null, body: e.body ?? null, ...(m && m[3] ? { note: m[3].trim() } : {}), ...(e.ms === undefined ? {} : { ms: e.ms }) };
}

// Inbound request from a peer: logged and counted the same way for every operation.
function inbound(peer, what, body) {
  peerStats(peer).in++;
  rec('in', peer, what, null, body);
}

function saveMessage(m) {
  st.messages.push(m);
  if (st.messages.length > STORE_MAX) { st.messages.shift(); inc('store_evicted'); }
  saveStore();
  return m;
}

// A final message leaves the store for the history (same object, so later notes such as statusReportId still land).
function retire(m) {
  const i = st.messages.indexOf(m);
  if (i >= 0) st.messages.splice(i, 1);
  if (!st.history.includes(m)) st.history.push(m);
  while (st.history.length > HISTORY_MAX) { st.history.shift(); inc('history_evicted'); }
}
const idNum = m => Number(String(m.id).replace(/^smsc-/, '')) || 0;
// Store and history together, ordered by id (oldest first): what GET /api/messages has always listed.
function allMessages() { return [...st.history, ...st.messages].sort((a, b) => idNum(a) - idNum(b)); }
function findMessage(id) { return st.messages.find(x => x.id === id) || st.history.find(x => x.id === id) || null; }

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

// Every MO answer is one RP-ACK or RP-ERROR towards the UE (the SMSF builds the RP layer from our answer). The
// RP-Cause it would carry for a rejection (TS 24.011 8.2.5.4), by our Diameter result: 5004 -> 95 semantically incorrect,
// 5005 -> 96 invalid mandatory information, 5552 -> 69 facility not implemented, 5012 -> 38 network out of order,
// 5555 -> 42 congestion for SC_CONGESTION, else 21 short message transfer rejected.
// RP-Cause the UE should get for our OFA error, per TS 23.040 11.3 (MAP MO-ForwardSM error -> RP-Cause).
// Unexpected data value and system failure map to 38; equipmentProtocolError has no row, so we use 21.
const MO_RP_CAUSE = { 5004: 38, 5005: 38, 5552: 69, 5012: 38 };
const MO_SM_FAILURE_RP_CAUSE = {
  UNKNOWN_SERVICE_CENTRE: 1, SC_CONGESTION: 42, INVALID_SME_ADDRESS: 21, USER_NOT_SC_USER: 28, EQUIPMENT_PROTOCOL_ERROR: 21,
};
function moRejected(cause) {
  inc('mo_rejected');
  pdu('out', 'RP-ERROR/SMS-SUBMIT-REPORT');
  rpCause('out', cause);
}

// TP-RD duplicate window for FORWARDED MOs (mutable for tests via _internals.MO_LIMITS, or env).
const MO_LIMITS = { DUP_WINDOW_MS: Number(process.env.HOLMINATOR_DUP_WINDOW_MS) || 60000 };

const sameAddr = (a, b) => tpdu.digitsOf(a) === tpdu.digitsOf(b);
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
const flag = (url, name) => !!url && ['1', 'true', 'yes'].includes(String(url.searchParams.get(name) || '').toLowerCase());

// TS 29.338 6.2.1 (OFR/OFA) and TS 23.040 clause 10 MO: the SC accepts the SMS-SUBMIT, answers, then
// forwards it towards the recipient as a simulated onward delivery (status FORWARDED; no MT is made for an MO). ?scenario= forces an outcome, ?dryRun=1 validates and answers without storing
// or delivering.
async function moForward(req, res, url) {
  const what = 'MO-Forward-Short-Message';
  const scenarioName = url && url.searchParams.get('scenario') ? url.searchParams.get('scenario').toUpperCase() : null;
  const dryRun = flag(url, 'dryRun');
  let b;
  inc('mo_received');
  pdu('in', 'RP-DATA/SMS-SUBMIT');
  countOp('in', 'MO-Forward-SM');
  if (scenarioName || dryRun) inc('test_requests');
  try { b = await readJson(req); } catch {
    inbound('smsf', 'POST /smsc/mo-forward-short-message', 'invalid JSON');
    moRejected(95);
    return reply(res, 'smsf', what, 400, { result: 'UNEXPECTED_DATA_VALUE', diameterResultCode: 5004, detail: 'body is not JSON' });
  }
  inbound('smsf', `POST /smsc/mo-forward-short-message${scenarioName ? ` [scenario ${scenarioName}]` : ''}${dryRun ? ' [dry run]' : ''}`, b);
  const bad = (status, body) => { moRejected(MO_RP_CAUSE[body.diameterResultCode] || 38); return reply(res, 'smsf', what, status, body); };
  const fail = (cause, fcs, detail) => { moRejected(MO_SM_FAILURE_RP_CAUSE[cause] || 21); return moFailure(res, cause, fcs, detail); };

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
  // TS 23.040 9.2.3.12: reserved or unsupported TP-VP is TP-FCS C7, mapped like the other TPDU faults. An absolute
  // TP-VP already in the past is rejected the same way: the SC cannot keep the SM for a period that is over (3.2.1).
  if (s.vpError) return fail('EQUIPMENT_PROTOCOL_ERROR', tpdu.FCS.TP_VP_NOT_SUPPORTED, `TP-VP not supported: ${s.vpError}`);
  if (s.validUntil && Date.parse(s.validUntil) <= Date.now()) {
    return fail('EQUIPMENT_PROTOCOL_ERROR', tpdu.FCS.TP_VP_NOT_SUPPORTED, `TP-VP not supported: absolute validity ${s.validUntil} is already past`);
  }

  const from = tpdu.digitsOf(b.msisdn) || null;
  const supi = b.supi || null;
  // TS 23.040 9.2.3.25: TP-RD=1 tells the SC to reject an SMS-SUBMIT with the same TP-MR and TP-DA from the same OA
  // as one it still holds; TP-RD=0 tells it to accept. A FORWARDED MO counts as held only for DUP_WINDOW_MS after it
  // was forwarded (RP TR1M retransmissions): UEs wrap TP-MR at 256, so a longer window flags normal traffic.
  const dup = allMessages().find(m => m.direction === 'MO' && m.mr === s.mr && m.to === to
    && ((from && m.from === from) || (supi && m.supi === supi))
    && (['ACCEPTED', ...ACTIVE].includes(m.status)
      || (m.status === 'FORWARDED' && !expired(m) && Date.now() - Date.parse(m.forwardedAt || m.submittedAt) < MO_LIMITS.DUP_WINDOW_MS)));
  if (dup && s.rd) {
    return fail('EQUIPMENT_PROTOCOL_ERROR', tpdu.FCS.SM_REJECTED_DUPLICATE_SM, `duplicate of ${dup.id} (TP-MR ${s.mr}, TP-RD=1)`);
  }
  if (dup) inc('mo_duplicates_accepted');

  const now = new Date();
  const expiresAt = s.validUntil || new Date(now.getTime() + (s.validityMs || DEFAULT_VALIDITY_MS)).toISOString();
  const report = { hex: tpdu.bytesToHex(tpdu.encodeSubmitReportAck(now)) };
  if (dryRun) {
    inc('mo_dry_runs');
    pdu('out', 'RP-ACK/SMS-SUBMIT-REPORT');
    return reply(res, 'smsf', what, 200, {
      result: 'SUCCESS', diameterResultCode: 2001, messageId: null, dryRun: true, deliveryReport: report,
      decoded: { from, supi, to, text: s.text, mr: s.mr, srr: s.srr, rd: s.rd, dcs: s.dcs, rpWrapped: !!mo.rp, vpFormat: s.vpFormat, singleShot: !!s.singleShot, expiresAt },
    });
  }
  const msg = saveMessage({
    id: `smsc-${++st.msgSeq}`,
    direction: 'MO',
    kind: 'SMS',
    status: 'ACCEPTED',
    from, supi, to,
    text: s.text, mr: s.mr, srr: s.srr, pid: s.pid, dcs: s.dcs,
    smsRecordId: b.smsRecordId || null,
    submitHex: tpdu.bytesToHex(mo.tpdu), vpFormat: s.vpFormat, singleShot: !!s.singleShot,
    submittedAt: now.toISOString(),
    expiresAt,
    duplicateOf: dup ? dup.id : null,
    history: [{ ts: now.toISOString(), event: 'ACCEPTED', detail: `MO from ${from || supi}` }],
  });

  inc('mo_accepted');
  if (s.srr) inc('mo_srr_requested');
  pdu('out', 'RP-ACK/SMS-SUBMIT-REPORT');
  reply(res, 'smsf', what, 200, {
    result: 'SUCCESS', diameterResultCode: 2001, messageId: msg.id, deliveryReport: report,
  });
  onMoAccepted(msg);
  return true;
}

// ---------- MT: the SC as SMS-GMSC towards the recipient (TS 23.040 10.1, 3.2.6-3.2.8; TS 29.338 S6c/SGd) ----------
// Message states: PENDING (ready for an attempt) -> DELIVERING -> DELIVERED | WAITING (absent or temporary failure,
// redelivered on Alert-Service-Centre or on nextRetryAt) | FAILED (permanent) | EXPIRED (validity period over).
const ACTIVE = ['PENDING', 'DELIVERING', 'WAITING'];
const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 10 * 60000;
const SWEEP_MS = 10000;
// Store-and-forward limits: backoff retries stop after MAX_ATTEMPTS attempts (mutable for tests via _internals).
const MT_LIMITS = { MAX_ATTEMPTS: Number(process.env.HOLMINATOR_MT_MAX_ATTEMPTS) || 8 };
// RP-Cause values from the UE that are temporary (TS 24.011 8.2.5.4): retried with backoff. 111 (protocol error
// unspecified) is what the simulated UE answers on a TPDU it cannot parse: temporary, but bounded by MAX_ATTEMPTS.
const RP_TEMPORARY = new Set([41, 42, 47, 111]);
const ST_CONGESTION_STOPPED = 0x60; // TS 23.040 9.2.3.15: permanent error, SC is not making any more attempts
// Alert timing (mutable for tests via _internals.TIMING, or env). The UDM may alert while the SMSF's UECM
// registration is still in progress, before the SMSF holds the UE context: wait a grace delay before redelivering,
// and give an alert-triggered attempt that the SMSF answers absent/unknown one fast retry before going back to MWD.
const TIMING = {
  ALERT_GRACE_MS: Number(process.env.HOLMINATOR_ALERT_GRACE_MS) || 2000,
  ALERT_FAST_RETRY_MS: Number(process.env.HOLMINATOR_ALERT_FAST_RETRY_MS) || 5000,
};

// Move the given WAITING messages to PENDING once their nextRetryAt is due, then kick the recipient.
function redeliverAfter(ms, to, ids, reason) {
  const tm = setTimeout(() => {
    const i = st.timers.indexOf(tm); if (i >= 0) st.timers.splice(i, 1);
    try {
      const now = Date.now();
      for (const m of st.messages) {
        if (!ids.includes(m.id) || m.status !== 'WAITING' || !m.nextRetryAt || Date.parse(m.nextRetryAt) > now + 5) continue;
        m.nextRetryAt = null; m.status = 'PENDING'; hist(m, 'PENDING', reason);
      }
      saveStore();
      kick(to);
    } catch (e) { console.error(`[${TEAM}] redeliver:`, e.message); }
  }, ms);
  if (tm.unref) tm.unref();
  tm.redeliver = true;
  st.timers.push(tm);
}

function hist(m, event, detail) { m.history.push({ ts: new Date().toISOString(), event, detail }); }
function setStatus(m, status, detail) {
  m.status = status; hist(m, status, detail);
  if (FINAL.includes(status)) retire(m);
  saveStore();
}

// TP-SCTS is the SC arrival time, nudged forward so no two SMs to the same MS share one (TS 23.040 6.2 (1)).
function sctsFor(m) {
  if (!m.sctsAt) {
    const want = Math.floor(Date.parse(m.submittedAt) / 1000);
    const s = Math.max(want, (st.lastScts.get(m.to) || 0) + 1);
    st.lastScts.set(m.to, s);
    m.sctsAt = new Date(s * 1000).toISOString();
  }
  return new Date(m.sctsAt);
}

function buildMtTpdu(m, moreToSend) {
  if (m.kind === 'STATUS_REPORT') {
    return tpdu.encodeStatusReport({ mr: m.mr, ra: m.ra, sctsDate: new Date(m.origSctsAt), dtDate: new Date(m.dischargeAt), st: m.st, moreToSend });
  }
  return tpdu.encodeDeliver({
    from: m.from || tpdu.digitsOf(m.supi) || SC_ADDRESS, text: m.text, sri: !!m.srr, date: sctsFor(m), moreToSend, pid: m.pid || 0,
  });
}

function enqueue(m, detail) {
  setStatus(m, 'PENDING', detail);
  kick(m.to);
}

// One SMS-DELIVER outstanding per recipient; the next PENDING one goes when the previous attempt is done.
function kick(to) {
  if (st.inflight.has(to)) return;
  const next = st.messages.find(m => m.to === to && m.status === 'PENDING');
  if (!next) return;
  st.inflight.add(to);
  attemptMt(next)
    .catch(e => { console.error(`[${TEAM}] mt:`, e.message); retryLater(next, `internal error: ${e.message}`); })
    .finally(() => { st.inflight.delete(to); kick(to); });
}

function expired(m) { return m.expiresAt && Date.now() > Date.parse(m.expiresAt); }

// Wrapper so every counted attempt ends in exactly one of: forward answered (pdus.in) or mt_forward_not_sent.
async function attemptMt(m) {
  const a = { counted: false, sent: false, answered: false };
  try { return await attemptMtOnce(m, a); } finally {
    if (a.counted && !a.sent) { mtOpen.noFwd--; inc('mt_forward_not_sent'); }
    if (a.sent && !a.answered) { mtOpen.fwd--; pdu('in', 'none/no-report'); }
  }
}

// Which RP message came back in the MT-Forward answer (TS 24.011 7.3): counted per PDU, RP-ERROR also per cause.
// The UE's answer in an MT-Forward reply. SGd TFA carries the bare SMS-DELIVER-REPORT TPDU (TS 29.338 SM-RP-UI) and
// the SMSF gives the RP-Cause in body.rpCause; an RP-ACK/RP-ERROR with its RP header is accepted too.
function ueAnswer(fwd) {
  const b = fwd.body || {};
  const hex = b.deliveryReport && b.deliveryReport.hex;
  const given = Number.isInteger(b.rpCause) ? b.rpCause : null;
  const mti = hex && /^[0-9a-f]{2}/i.test(hex) ? parseInt(hex.slice(0, 2), 16) & 7 : -1;
  if (mti === 4 || mti === 5) return { kind: 'ERROR', cause: given !== null ? given : tpdu.rpErrorCause(hex), hex };
  if (given !== null) return { kind: 'ERROR', cause: given, hex };
  if (mti === 2 || mti === 3) return { kind: 'ACK', hex };
  if (hex) return fwd.status === 200 ? { kind: 'ACK', hex } : fwd.status === 502 ? { kind: 'ERROR', cause: null, hex } : { kind: null, hex };
  return { kind: null, hex: null };
}

function countMtAnswer(m, fwd) {
  const a = ueAnswer(fwd);
  if (a.kind === 'ACK') return pdu('in', m.kind === 'STATUS_REPORT' ? 'RP-ACK/STATUS-REPORT-ACK' : 'RP-ACK/SMS-DELIVER-REPORT');
  if (a.kind === 'ERROR') { pdu('in', 'RP-ERROR/SMS-DELIVER-REPORT'); return rpCause('in', a.cause); }
  return pdu('in', 'none/no-report');
}

async function attemptMtOnce(m, a) {
  if (m.direction === 'MO') return onMoAccepted(m); // an MO never goes out as MT (legacy relay records)
  if (expired(m)) return expire(m);
  m.attempts = (m.attempts || 0) + 1;
  m.nextRetryAt = null;
  const viaAlert = !!m.viaAlert;
  m.viaAlert = false;
  setStatus(m, 'DELIVERING', `attempt ${m.attempts}`);
  inc('mt_attempts');
  a.counted = true; mtOpen.noFwd++;

  const udm = await resolve('UDM');
  if (!udm) return retryLater(m, 'no UDM in the NRF');
  inc('sri_requests');
  const sri = await call('udm', 'POST', `${udm}/sms-routing/v1/send-routing-info-for-sm`, {
    msisdn: m.to, scAddress: SC_ADDRESS, smRpPri: false, smRpMti: m.kind === 'STATUS_REPORT' ? 1 : 0,
  }, { op: 'SRI-for-SM' });
  const sr = sri.body && sri.body.result;
  if (sri.status !== 200) {
    hist(m, 'SRI-for-SM', `${sri.status} ${sr || sri.error || ''}`.trim());
    // ABSENT_SUBSCRIBER_SM: the UDM has put our address in MWD and will alert us (TS 23.040 3.2.8 case 1).
    if (sr === 'ABSENT_SUBSCRIBER_SM') { m.mwd = true; inc('mt_absent'); return waitForAlert(m, 'absent subscriber (no SMSF registered), in MWD at the UDM'); }
    if (sr === 'UNKNOWN_SUBSCRIBER') return fail(m, tpdu.ST.NOT_OBTAINABLE, 'unknown subscriber');
    if (sr === 'TELESERVICE_NOT_PROVISIONED') return fail(m, tpdu.ST.INCOMPATIBLE_DESTINATION, 'SMS not provisioned for the recipient');
    if (sr === 'CALL_BARRED') return fail(m, tpdu.ST.SERVICE_REJECTED_STOPPED, 'MT SMS barred for the recipient');
    if (sri.status === 0 || sri.status >= 500) return retryLater(m, `SRI-for-SM failed (${sri.status || sri.error})`);
    return fail(m, tpdu.ST.REMOTE_PROCEDURE_ERROR, `SRI-for-SM answered ${sri.status} ${sr || ''}`.trim());
  }

  const supi = sri.body.supi || null;
  const smsfId = sri.body.servingNode && sri.body.servingNode.smsfInstanceId;
  m.servingSmsf = smsfId || null;
  hist(m, 'SRI-for-SM', `200, ${supi}, serving SMSF ${smsfId || 'none'}`);
  const smsf = smsfId ? await resolve('SMSF', smsfId) : null;
  if (!smsf) return retryLater(m, `serving SMSF ${smsfId || '(none)'} not found in the NRF`);

  const more = st.messages.some(x => x !== m && x.to === m.to && x.status === 'PENDING');
  const hex = tpdu.bytesToHex(buildMtTpdu(m, more));
  m.tpduHex = hex;
  pdu('out', m.kind === 'STATUS_REPORT' ? 'RP-DATA/SMS-STATUS-REPORT' : 'RP-DATA/SMS-DELIVER');
  a.sent = true; mtOpen.noFwd--; mtOpen.fwd++;
  const fwd = await call('smsf', 'POST', `${smsf}/smsc/mt-forward-short-message`, {
    supi, msisdn: m.to, scAddress: SC_ADDRESS, sms: { hex }, smsRecordId: `${m.id}-${m.attempts}`, moreMessagesToSend: more,
  }, { op: 'MT-Forward-Short-Message' });
  a.answered = true; mtOpen.fwd--;
  countMtAnswer(m, fwd);
  const fr = fwd.body && fwd.body.result;
  if (fwd.body && fwd.body.deliveryReport && fwd.body.deliveryReport.hex) m.deliveryReportHex = fwd.body.deliveryReport.hex;
  hist(m, 'MT-Forward-Short-Message', `${fwd.status} ${fr || fwd.error || ''}`.trim());

  if (fwd.status === 200) return delivered(m);
  if (fr === 'ABSENT_SUBSCRIBER' || (fwd.status === 404 && fr === 'UNKNOWN_SUBSCRIBER')) {
    inc('mt_absent');
    // Right after an alert the SMSF may not have stored the UE context yet: one fast retry per alert.
    if (viaAlert && !m.alertFastRetryUsed && !m.singleShot) {
      m.alertFastRetryUsed = true;
      m.nextRetryAt = new Date(Date.now() + TIMING.ALERT_FAST_RETRY_MS).toISOString();
      inc('mt_alert_fast_retries');
      setStatus(m, 'WAITING', `SMSF answered ${fwd.status} ${fr} right after Alert-Service-Centre (UE context likely not stored yet); one fast retry in ${TIMING.ALERT_FAST_RETRY_MS / 1000} s`);
      redeliverAfter(TIMING.ALERT_FAST_RETRY_MS, m.to, [m.id], 'fast retry after Alert-Service-Centre');
      return;
    }
    await reportDeliveryStatus(m, 'ABSENT_SUBSCRIBER');
    return waitForAlert(m, 'absent subscriber at the SMSF, reported to the UDM for MWD');
  }
  // Only this attempt's answer counts; m.deliveryReportHex may hold one from an earlier attempt.
  const ans = ueAnswer(fwd);
  const drHex = ans.kind === 'ERROR' ? (ans.hex || '-') : null;
  const rpCause = ans.kind === 'ERROR' ? ans.cause : null;
  if (rpCause === 22) { // RP-Cause 22: memory capacity exceeded (TS 24.011 8.2.5.4)
    await reportDeliveryStatus(m, 'MEMORY_CAPACITY_EXCEEDED');
    return waitForAlert(m, 'UE memory full, reported to the UDM for MWD');
  }
  if (fwd.status === 502 && drHex && RP_TEMPORARY.has(rpCause)) {
    inc('mt_rp_error_temporary');
    return retryLater(m, `UE answered RP-ERROR cause ${rpCause} (temporary)`, rpCause === 42 ? ST_CONGESTION_STOPPED : tpdu.ST.ERROR_IN_SME_STOPPED);
  }
  if (fwd.status === 502 && drHex) return fail(m, tpdu.ST.ERROR_IN_SME_STOPPED, `UE answered RP-ERROR${rpCause === null ? '' : ` cause ${rpCause}`}`);
  if (fwd.status === 0 || fwd.status >= 500) return retryLater(m, `MT-Forward failed (${fwd.status || fwd.error} ${fr || ''})`.trim());
  return fail(m, tpdu.ST.REMOTE_PROCEDURE_ERROR, `MT-Forward answered ${fwd.status} ${fr || ''}`.trim());
}

// TS 23.040 3.2.6 / 8.1.1: the GMSC reports to the UDM so it can set MWD, or clear it after success.
async function reportDeliveryStatus(m, deliveryOutcome) {
  const udm = await resolve('UDM');
  if (!udm) return;
  inc('udm_delivery_reports');
  const r = await call('udm', 'POST', `${udm}/sms-routing/v1/report-sm-delivery-status`,
    { msisdn: m.to, scAddress: SC_ADDRESS, deliveryOutcome }, { op: 'Report-SM-Delivery-Status' });
  hist(m, 'Report-SM-Delivery-Status', `${deliveryOutcome}: ${r.status}`);
  if (r.status === 200 && deliveryOutcome !== 'SUCCESSFUL_TRANSFER') m.mwd = true;
}

async function delivered(m) {
  m.deliveredAt = new Date().toISOString();
  setStatus(m, 'DELIVERED', `delivered to ${m.to}`);
  inc(m.kind === 'STATUS_REPORT' ? 'status_reports_sent' : 'mt_delivered');
  if (m.mwd) { m.mwd = false; await reportDeliveryStatus(m, 'SUCCESSFUL_TRANSFER'); }
  statusReport(m, tpdu.ST.RECEIVED_BY_SME);
  saveStore(); // the counters above changed after setStatus saved
}

// Alert-driven redelivery, with a slow autonomous retry in case the alert never comes (TS 23.040 3.2.7 note 5).
function waitForAlert(m, detail) {
  if (singleShotOver(m, detail)) return;
  m.nextRetryAt = new Date(Date.now() + RETRY_MAX_MS).toISOString();
  setStatus(m, 'WAITING', detail);
}

// Single-shot SM (enhanced TP-VP b6, TS 23.040 9.2.3.12.3): one delivery attempt only, no retry, no alert wait.
function singleShotOver(m, detail) {
  if (!m.singleShot) return false;
  fail(m, tpdu.ST.NO_RESPONSE_FROM_SME_STOPPED, `single-shot SM, no further attempts: ${detail}`);
  return true;
}

function retryLater(m, detail, capSt = tpdu.ST.NO_RESPONSE_FROM_SME_STOPPED) {
  if (singleShotOver(m, detail)) return;
  if ((m.attempts || 0) >= MT_LIMITS.MAX_ATTEMPTS) {
    inc('mt_attempts_exhausted');
    return fail(m, capSt, `${detail}; giving up after ${m.attempts} attempts (max ${MT_LIMITS.MAX_ATTEMPTS})`);
  }
  const ms = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, (m.attempts || 1) - 1), RETRY_MAX_MS);
  m.nextRetryAt = new Date(Date.now() + ms).toISOString();
  inc('mt_retries_scheduled');
  setStatus(m, 'WAITING', `${detail}; retry in ${Math.round(ms / 1000)} s`);
}

function fail(m, stValue, detail) {
  m.failure = detail;
  setStatus(m, 'FAILED', detail);
  inc(m.kind === 'STATUS_REPORT' ? 'status_reports_failed' : 'mt_failed');
  statusReport(m, stValue);
  saveStore();
}

function expire(m) {
  setStatus(m, 'EXPIRED', `validity period ended ${m.expiresAt}`);
  inc(m.direction === 'MO' ? 'mo_expired' : m.kind === 'STATUS_REPORT' ? 'status_reports_expired' : 'mt_expired');
  statusReport(m, tpdu.ST.VALIDITY_PERIOD_EXPIRED);
  saveStore();
}

// TS 23.040 3.2.9: when the SUBMIT had TP-SRR=1 the SC returns an SMS-STATUS-REPORT to the originating MS once the
// outcome is final. Never for a status report itself, and only when there is an MS to send it to.
function statusReport(orig, stValue) {
  if (orig.direction === 'MT' && orig.kind !== 'STATUS_REPORT') return orig.srr ? simulatedStatusReport(orig, stValue) : null;
  if (orig.direction !== 'MO' || orig.kind === 'STATUS_REPORT' || !orig.srr || !orig.from) return null;
  const now = new Date();
  const sr = saveMessage({
    id: `smsc-${++st.msgSeq}`, direction: 'MT', kind: 'STATUS_REPORT', status: 'PENDING',
    from: SC_ADDRESS, to: orig.from, ra: orig.to, mr: orig.mr, st: stValue, reportFor: orig.id,
    text: `status report for ${orig.id}: TP-ST 0x${stValue.toString(16).padStart(2, '0')}`,
    origSctsAt: orig.submittedAt, dischargeAt: now.toISOString(),
    submittedAt: now.toISOString(), expiresAt: new Date(now.getTime() + DEFAULT_VALIDITY_MS).toISOString(),
    history: [{ ts: now.toISOString(), event: 'PENDING', detail: `TP-ST 0x${stValue.toString(16).padStart(2, '0')} for ${orig.id}` }],
  });
  inc('status_reports_generated');
  bump(st.metrics.byTpSt, tpStKey(stValue));
  inc('mt_originated');
  orig.statusReportId = sr.id;
  saveStore();
  kick(sr.to);
  return sr;
}

// An /api/mt with srr: the originator is an external SME we simulate, so its SMS-STATUS-REPORT is recorded, not
// sent (like MO onward delivery). Once per MT, on its final outcome (DELIVERED, FAILED, EXPIRED).
function simulatedStatusReport(m, stValue) {
  if (m.statusReport) return null;
  const key = tpStKey(stValue);
  m.statusReport = { tpSt: key, at: new Date().toISOString() };
  hist(m, 'STATUS_REPORT', `status report to originating SME (simulated), TP-ST ${key}`);
  inc('mt_status_reports_simulated');
  bump(st.metrics.byTpStMt, key);
  saveStore();
  return m.statusReport;
}

// Every accepted MO terminates here (PROJEKT.md: UE -> AMF -> SMSF -> SMSC, result back to the UE). Onward delivery
// to TP-DA is simulated: no SRI-for-SM, no MT-Forward. With TP-SRR the originator gets an SMS-STATUS-REPORT (TP-ST
// 0x00) as a new MT record over the real MT path. Also used on restart for MOs an older deploy left unfinished.
function onMoAccepted(msg) {
  if (expired(msg)) return expire(msg);
  msg.forwardedAt = new Date().toISOString();
  setStatus(msg, 'FORWARDED', `simulated onward delivery to ${msg.to}`);
  inc('mo_forwarded');
  statusReport(msg, tpdu.ST.RECEIVED_BY_SME);
  saveStore();
}

// Expire, and move due WAITING messages back to PENDING. Also picks up PENDING ones after a restart.
function sweep() {
  const now = Date.now();
  const touched = new Set();
  for (const m of [...st.messages]) { // a copy: expire() moves the message to the history
    if (!ACTIVE.includes(m.status)) continue;
    if (m.status !== 'DELIVERING' && expired(m)) { expire(m); continue; }
    if (m.status === 'WAITING' && m.nextRetryAt && Date.parse(m.nextRetryAt) <= now) {
      m.status = 'PENDING'; hist(m, 'PENDING', 'retry'); touched.add(m.to);
    }
    if (m.status === 'PENDING') touched.add(m.to);
  }
  saveStore();
  for (const to of touched) kick(to);
}

// TS 29.338 / TS 23.040 3.2.7: the UDM tells us the MS is reachable again; deliver what waits for it.
async function alertServiceCentre(req, res) {
  const what = 'Alert-Service-Centre';
  let b;
  inc('alerts_received');
  countOp('in', 'Alert-SC');
  try { b = await readJson(req); } catch {
    inbound('udm', 'POST /smsc/alert-service-centre', 'invalid JSON');
    return reply(res, 'udm', what, 400, { result: 'UNEXPECTED_DATA_VALUE', diameterResultCode: 5004, detail: 'body is not JSON' });
  }
  inbound('udm', 'POST /smsc/alert-service-centre', b);
  const msisdn = tpdu.digitsOf(b && b.msisdn);
  if (!msisdn) return reply(res, 'udm', what, 400, { result: 'MISSING_AVP', diameterResultCode: 5005, detail: 'msisdn is mandatory' });
  if (b.scAddress && !sameAddr(b.scAddress, SC_ADDRESS)) {
    return reply(res, 'udm', what, 400, { result: 'UNEXPECTED_DATA_VALUE', diameterResultCode: 5004, detail: `SC address ${b.scAddress} is not ${SC_ADDRESS}` });
  }
  const waiting = st.messages.filter(m => m.to === msisdn && m.status === 'WAITING');
  // Grace delay: the alert can arrive before the SMSF has stored the UE context (UECM PUT still in progress).
  const due = new Date(Date.now() + TIMING.ALERT_GRACE_MS).toISOString();
  for (const m of waiting) {
    m.nextRetryAt = due; m.viaAlert = true; m.alertFastRetryUsed = false;
    hist(m, 'ALERT', `Alert-Service-Centre ${b.alertReason || ''}`.trim() + `; redelivery in ${TIMING.ALERT_GRACE_MS / 1000} s`);
  }
  saveStore();
  inc('alerts_redelivering', waiting.length);
  reply(res, 'udm', what, 200, { result: 'SUCCESS', diameterResultCode: 2001, redelivering: waiting.map(m => m.id) });
  if (waiting.length) redeliverAfter(TIMING.ALERT_GRACE_MS, msisdn, waiting.map(m => m.id), `Alert-Service-Centre ${b.alertReason || ''}`.trim());
  return true;
}

// POST /api/mt: the SC originates an SM itself (an application, or anyone testing). ?dryRun=1 builds the
// SMS-DELIVER without storing or sending; ?wait=1 answers when the first attempt has an outcome (max 25 s).
async function apiMt(req, res, url) {
  const what = 'MT origination';
  let b;
  try { b = await readJson(req); } catch { return reply(res, 'api', what, 400, { result: 'UNEXPECTED_DATA_VALUE', detail: 'body is not JSON' }); }
  inbound('api', `POST /api/mt${flag(url, 'dryRun') ? ' [dry run]' : ''}`, b);
  const to = tpdu.digitsOf(b && b.to);
  const from = tpdu.digitsOf(b && b.from) || SC_ADDRESS;
  if (!to || to.length > 15) return reply(res, 'api', what, 400, { result: 'MISSING_AVP', detail: 'to (MSISDN, at most 15 digits) is mandatory' });
  if (typeof b.text !== 'string' || !b.text.length) return reply(res, 'api', what, 400, { result: 'MISSING_AVP', detail: 'text is mandatory' });
  if (b.text.length > 160) return reply(res, 'api', what, 400, { result: 'UNEXPECTED_DATA_VALUE', detail: 'text is longer than one SM (160 characters); concatenation is not supported' });
  // The generator always asks for a status report (TP-SRI) unless the body says srr: false.
  const srr = !(b.srr === false || b.srr === 0 || b.srr === 'false');
  const now = new Date();
  const validityMs = Number(b.validitySeconds) > 0 ? Number(b.validitySeconds) * 1000 : DEFAULT_VALIDITY_MS;
  if (flag(url, 'dryRun')) {
    inc('test_requests');
    const t = tpdu.encodeDeliver({ from, text: b.text, sri: srr, date: now });
    return reply(res, 'api', what, 200, {
      result: 'SUCCESS', dryRun: true, tpduHex: tpdu.bytesToHex(t), decoded: tpdu.decodeDeliver(t),
      wouldDo: ['NFDiscover UDM', `SRI-for-SM ${to}`, 'NFDiscover SMSF by servingNode.smsfInstanceId', 'MT-Forward-Short-Message'],
    });
  }
  const m = saveMessage({
    id: `smsc-${++st.msgSeq}`, direction: 'MT', kind: 'SMS', status: 'PENDING', from, to, text: b.text, srr, singleShot: !!b.singleShot,
    submittedAt: now.toISOString(), expiresAt: new Date(now.getTime() + validityMs).toISOString(),
    history: [{ ts: now.toISOString(), event: 'ACCEPTED', detail: `originated by the SC API from ${from}` }],
  });
  inc('mt_originated');
  if (m.srr) inc('mt_srr_requested');
  enqueue(m, `queued for MT delivery to ${to}`);
  if (!flag(url, 'wait')) return reply(res, 'api', what, 202, { result: 'ACCEPTED', messageId: m.id, status: m.status, track: `/t/${TEAM}/api/messages/${m.id}` });
  const until = Date.now() + 25000;
  while (['PENDING', 'DELIVERING'].includes(m.status) && Date.now() < until) await sleep(200);
  return reply(res, 'api', what, 200, { result: m.status, messageId: m.id, message: m });
}

// The store holds only messages not yet final; finished ones are in the history.
function storeStats() {
  const byStatus = { ACCEPTED: 0, PENDING: 0, DELIVERING: 0, WAITING: 0 };
  let oldest = null;
  for (const m of st.messages) {
    byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    if (m.submittedAt && (!oldest || m.submittedAt < oldest)) oldest = m.submittedAt;
  }
  return { held: st.messages.length, max: STORE_MAX, byStatus, oldestAt: oldest };
}

function metricsSnapshot() {
  const byStatus = {}, byDirection = {};
  for (const m of allMessages()) { // store + history: every record we still know about
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
    since: st.metrics.since,
    counters: { ...st.metrics.counters },
    results: st.metrics.results,
    peers,
    messages: { total: st.messages.length + st.history.length, byStatus, byDirection },
    store: storeStats(),
    history: { kept: st.history.length, max: HISTORY_MAX },
    pdus: { in: { ...st.metrics.pdus.in }, out: { ...st.metrics.pdus.out } },
    rpCauses: { in: { ...st.metrics.rpCauses.in }, out: { ...st.metrics.rpCauses.out } },
    statusReports: statusReportStats(),
    statusReportsMt: { requested: st.metrics.counters.mt_srr_requested, simulated: st.metrics.counters.mt_status_reports_simulated, byTpSt: { ...st.metrics.byTpStMt } },
    sgd: { results: st.metrics.results, operationsOut: { ...st.metrics.operationsOut }, operationsIn: { ...st.metrics.operationsIn } },
    consistency: consistency(),
  };
}

const sinceCounting = m => !m.submittedAt || Date.parse(m.submittedAt) >= Date.parse(st.metrics.since);
function statusReportStats() {
  const c = st.metrics.counters;
  return {
    requested: c.mo_srr_requested, // accepted MOs with TP-SRR=1
    generated: c.status_reports_generated, // SMS-STATUS-REPORT records made (TP-SRR outcomes)
    sent: st.metrics.pdus.out['RP-DATA/SMS-STATUS-REPORT'], // MT-Forward attempts carrying one
    delivered: c.status_reports_sent, // acknowledged by the UE (the counter keeps its old name)
    failed: c.status_reports_failed,
    expired: c.status_reports_expired,
    waiting: st.messages.filter(m => m.kind === 'STATUS_REPORT' && ACTIVE.includes(m.status)).length, // current
    byTpSt: { ...st.metrics.byTpSt },
  };
}

// Self-checks over the counters: every PDU in has its PDU out, every MT attempt ends in an answer or a reason.
// Attempts still running are counted as open (mtOpen), so the checks also hold mid-attempt.
function consistency() {
  const c = st.metrics.counters, pin = st.metrics.pdus.in, pout = st.metrics.pdus.out;
  const out = [];
  const chk = (name, left, right, detail) => out.push({ name, ok: left === right, detail: `${left} ${left === right ? '==' : '!='} ${right}: ${detail}` });
  chk('mo_pdus', pin['RP-DATA/SMS-SUBMIT'], pout['RP-ACK/SMS-SUBMIT-REPORT'] + pout['RP-ERROR/SMS-SUBMIT-REPORT'],
    'in RP-DATA/SMS-SUBMIT == out RP-ACK + RP-ERROR SMS-SUBMIT-REPORT');
  const fwds = pout['RP-DATA/SMS-DELIVER'] + pout['RP-DATA/SMS-STATUS-REPORT'];
  chk('mt_attempts_forwarded', c.mt_attempts, fwds + c.mt_forward_not_sent + mtOpen.noFwd,
    `mt_attempts == out RP-DATA SMS-DELIVER + SMS-STATUS-REPORT (${fwds}) + mt_forward_not_sent (${c.mt_forward_not_sent}) + starting now (${mtOpen.noFwd})`);
  const answers = pin['RP-ACK/SMS-DELIVER-REPORT'] + pin['RP-ACK/STATUS-REPORT-ACK'] + pin['RP-ERROR/SMS-DELIVER-REPORT'] + pin['none/no-report'];
  chk('mt_attempts_answered', c.mt_attempts, answers + c.mt_forward_not_sent + mtOpen.noFwd + mtOpen.fwd,
    `mt_attempts == in RP-ACK (both) + RP-ERROR + none/no-report (${answers}) + mt_forward_not_sent (${c.mt_forward_not_sent}) + in flight (${mtOpen.noFwd + mtOpen.fwd})`);
  const sr = statusReportStats();
  const srWaiting = st.messages.filter(m => m.kind === 'STATUS_REPORT' && ACTIVE.includes(m.status) && sinceCounting(m)).length;
  chk('status_reports', sr.generated, sr.delivered + sr.failed + sr.expired + srWaiting,
    `generated == delivered + failed + expired + waiting (${srWaiting} generated since ${st.metrics.since})`);
  // Every accepted MO with TP-SRR gets exactly one status report from onMoAccepted/expire via statusReport(), unless
  // it has no originating MSISDN (supi only); a record still ACCEPTED has none yet either.
  const known = allMessages(); // store + history
  const evicted = (c.store_evicted || 0) + (c.history_evicted || 0);
  const skipped = `not checked: ${evicted} message(s) evicted (store_evicted ${c.store_evicted}, history_evicted ${c.history_evicted})`;
  const moNoReport = known.filter(m => m.direction === 'MO' && m.srr && !m.statusReportId && sinceCounting(m)).length;
  const mtSrrOpen = known.filter(m => m.direction === 'MT' && m.kind !== 'STATUS_REPORT' && m.srr && !m.statusReport && sinceCounting(m)).length;
  if (evicted) out.push({ name: 'mo_status_reports', ok: true, detail: skipped });
  else chk('mo_status_reports', c.mo_srr_requested, c.status_reports_generated + moNoReport,
    `mo_srr_requested == status_reports_generated (${c.status_reports_generated}) + MOs with TP-SRR and no report (no originator or not forwarded yet) since ${st.metrics.since} (${moNoReport})`);
  if (evicted) out.push({ name: 'mt_status_reports', ok: true, detail: skipped });
  else chk('mt_status_reports', c.mt_srr_requested, c.mt_status_reports_simulated + mtSrrOpen,
    `mt_srr_requested == mt_status_reports_simulated (${c.mt_status_reports_simulated}) + MTs with srr not final yet since ${st.metrics.since} (${mtSrrOpen})`);
  const moStored = known.filter(m => m.direction === 'MO' && sinceCounting(m)).length;
  if (evicted) out.push({ name: 'mo_store', ok: true, detail: `${skipped} (store max ${STORE_MAX}, history max ${HISTORY_MAX})` });
  else chk('mo_store', c.mo_received, moStored + c.mo_rejected + c.mo_dry_runs,
    `mo_received == MO records in store + history since ${st.metrics.since} (${moStored}) + mo_rejected (${c.mo_rejected}) + mo_dry_runs (${c.mo_dry_runs})`);
  const finalHeld = st.messages.filter(m => FINAL.includes(m.status));
  chk('store_only_pending', finalHeld.length, 0,
    `final records in the store (should be in the history)${finalHeld.length ? `: ${finalHeld.slice(0, 5).map(m => `${m.id} ${m.status}`).join(', ')}` : ''}`);
  return out;
}

// POST /api/metrics/reset {clearMessages?}: every metric back to its pre-seeded 0 and since=now. startedAt (this
// process) and the NRF health stay. clearMessages also drops the store and the history and cancels pending redelivery timers, so no
// message from before since can skew the consistency checks. An MT attempt already in flight still finishes.
async function metricsReset(req, res) {
  let b = {};
  try { b = await readJson(req); } catch { return send(res, 400, { error: 'body is not JSON' }); }
  const clear = !!(b && b.clearMessages === true);
  st.metrics = { ...newMetrics(), startedAt: st.metrics.startedAt, nrf: st.metrics.nrf };
  let cleared = 0;
  if (clear) {
    cleared = st.messages.length + st.history.length;
    for (const m of st.messages) { m.nextRetryAt = null; m.viaAlert = false; }
    st.messages = [];
    st.history = [];
    for (const tm of st.timers.filter(x => x.redeliver)) { clearTimeout(tm); st.timers.splice(st.timers.indexOf(tm), 1); }
  }
  saveStore();
  const body = { ok: true, since: st.metrics.since, clearedMessages: cleared };
  rec('in', 'api', 'POST /api/metrics/reset', 200, { request: b, answer: body });
  return send(res, 200, body);
}

// GET /kpi: the common KPI summary every NF team offers (tompa, #build 142). Derived from the metrics above.
// requests: inbound peer requests we answered; errors: our answers >= 400 plus outbound peer errors (no answer or 5xx);
// latencyMs: average over every outbound peer call.
function kpi() {
  const c = st.metrics.counters;
  const peers = Object.values(st.metrics.peers);
  const calls = peers.reduce((s, p) => s + p.calls, 0);
  const latencySum = peers.reduce((s, p) => s + p.latencyMsSum, 0);
  return {
    nf: 'SMSC', up: true,
    requests: c.requests_in || 0,
    errors: (c.answers_error || 0) + peers.reduce((s, p) => s + p.errors, 0),
    latencyMs: calls ? Math.round(latencySum / calls) : 0,
    extra: {
      mo_accepted: c.mo_accepted || 0,
      mt_delivered: c.mt_delivered || 0,
      mt_failed: c.mt_failed || 0,
      waiting: st.messages.filter(m => m.status === 'WAITING').length,
      status_reports_sent: c.status_reports_sent || 0,
      alerts_received: c.alerts_received || 0,
      registeredInNrf: st.registered,
      pdus_in: Object.values(st.metrics.pdus.in).reduce((s, v) => s + v, 0),
      pdus_out: Object.values(st.metrics.pdus.out).reduce((s, v) => s + v, 0),
      consistent: consistency().every(x => x.ok),
      mo_srr_requested: c.mo_srr_requested || 0,
      mt_status_reports_simulated: c.mt_status_reports_simulated || 0,
      store_held: st.messages.length,
    },
  };
}

// GET /api/messages[?scope=store|history][&limit=N][&since=X]. Without scope: the history and the store together
// (everything we still know about), ordered by id (smsc-<seq> ascending). scope=store: only messages not yet final;
// scope=history: only finished ones. Then:
// since=smsc-<n> (or <n>) keeps messages created after that id; since=<ISO time> keeps messages whose updatedAt (the
// ts of their last history entry) is later. limit=N then keeps the newest N. The answer is always oldest first.
function updatedAt(m) { const h = m.history || []; return (h.length && h[h.length - 1].ts) || m.submittedAt; }
function listMessages(url) {
  const qs = url ? url.searchParams : new URLSearchParams();
  const scope = qs.get('scope');
  if (scope !== null && scope !== '' && !['store', 'history', 'all'].includes(scope)) return { error: 'scope must be store, history or all' };
  let list = scope === 'store' ? [...st.messages].sort((a, b) => idNum(a) - idNum(b))
    : scope === 'history' ? [...st.history].sort((a, b) => idNum(a) - idNum(b)) : allMessages();
  const since = qs.get('since');
  if (since !== null && since !== '') {
    const idm = /^(?:smsc-)?(\d+)$/.exec(since);
    if (idm) {
      const n = Number(idm[1]);
      list = list.filter(m => Number(String(m.id).replace(/^smsc-/, '')) > n);
    } else {
      const t = Date.parse(since);
      if (isNaN(t)) return { error: 'since must be a message id (smsc-<n>) or an ISO timestamp' };
      list = list.filter(m => Date.parse(updatedAt(m)) > t);
    }
  }
  const limit = qs.get('limit');
  if (limit !== null && limit !== '') {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) return { error: 'limit must be a positive integer' };
    list = list.slice(-n);
  }
  return { list };
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
  line('store_held', {}, m.store.held);
  for (const [s, v] of Object.entries(m.store.byStatus)) line('store_held_by_status', { status: s }, v);
  line('history_kept', {}, m.history.kept);
  for (const dir of ['in', 'out']) {
    for (const [type, v] of Object.entries(m.pdus[dir])) line('pdus_total', { dir, type }, v);
    for (const [cause, v] of Object.entries(m.rpCauses[dir])) line('rp_causes_total', { dir, cause }, v);
  }
  for (const [k, v] of Object.entries(m.statusReports)) if (k !== 'byTpSt') line(k === 'waiting' ? 'status_reports_waiting' : 'status_reports_total', k === 'waiting' ? {} : { outcome: k }, v);
  for (const [tpSt, v] of Object.entries(m.statusReports.byTpSt)) line('status_reports_by_tp_st_total', { tp_st: tpSt }, v);
  line('status_reports_mt_requested_total', {}, m.statusReportsMt.requested);
  line('status_reports_mt_simulated_total', {}, m.statusReportsMt.simulated);
  for (const [tpSt, v] of Object.entries(m.statusReportsMt.byTpSt)) line('status_reports_mt_by_tp_st_total', { tp_st: tpSt }, v);
  for (const [operation, v] of Object.entries(m.sgd.operationsOut)) line('sgd_operations_total', { dir: 'out', operation }, v);
  for (const [operation, v] of Object.entries(m.sgd.operationsIn)) line('sgd_operations_total', { dir: 'in', operation }, v);
  for (const ck of m.consistency) line('consistency_ok', { check: ck.name }, ck.ok ? 1 : 0);
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
      { method: 'POST', path: `${base}/smsc/mo-forward-short-message`, what: 'MO-Forward-Short-Message (TS 29.338 OFR/OFA). Real: stores the SM, answers RP-ACK and marks it FORWARDED (simulated onward delivery, no MT); TP-SRR gives a status report MT to the originator.', example: mo },
      { method: 'POST', path: `${base}/smsc/mo-forward-short-message?dryRun=1`, what: 'Same, nothing stored or delivered; the answer includes the decoded SMS-SUBMIT.', example: mo },
      { method: 'POST', path: `${base}/smsc/mo-forward-short-message?dryRun=1`, what: 'RP-DATA wrapped SMS-SUBMIT is accepted too.', example: { ...mo, sms: { hex: rpHex } } },
      { method: 'POST', path: `${base}/smsc/alert-service-centre`, what: 'Alert-Service-Centre from the UDM: every WAITING SM for that MSISDN is delivered again. Answers with the ids it redelivers.', example: { msisdn: '46700000002', scAddress: SC_ADDRESS, alertReason: 'UE_PRESENT' } },
      { method: 'POST', path: `${base}/api/mt?wait=1`, what: 'Make the SMSC originate an MT SMS: SRI-for-SM to the UDM, then MT-Forward to the serving SMSF. ?wait=1 answers with the outcome of the first attempt (DELIVERED, WAITING, FAILED), without it you get 202 and a messageId. srr defaults to true (TP-SRI set, simulated status report to the originating SME on the final outcome); send srr:false to skip it.', example: { from: '46700000100', to: '46700000002', text: 'Hello from the SMSC', validitySeconds: 3600, srr: true } },
      { method: 'POST', path: `${base}/api/mt?dryRun=1`, what: 'Build the SMS-DELIVER we would send, decoded, without sending anything.', example: { to: '46700000002', text: 'Hello' } },
      { method: 'GET', path: `${base}/api/messages/smsc-1`, what: 'One message with its full history: SRI answer, MT-Forward answer, MWD reports, status report.' },
      { method: 'POST', path: `${base}/test/encode`, what: 'Build a TPDU: type SUBMIT or DELIVER; rp=true wraps it in RP-DATA. SUBMIT vp: a relative octet, or {type:"absolute",time,tzMinutes}, {type:"enhanced",format:"none|relative|seconds|hhmmss",value,singleShot}, {type:"raw",vpf,hex}.', example: { type: 'SUBMIT', to: '46700000002', text: 'Hello', mr: 1, srr: false, rd: false, rp: false } },
      { method: 'POST', path: `${base}/test/decode`, what: 'Decode RP-DATA, RP-ACK, RP-ERROR, SMS-SUBMIT, SMS-DELIVER, SMS-STATUS-REPORT, SMS-SUBMIT-REPORT or SMS-DELIVER-REPORT hex. Optional kind (e.g. "submit-report") or direction ("MO"/"MT") picks between TPDUs sharing a TP-MTI.', example: { hex: submitHex } },
      { method: 'GET', path: `${base}/api/messages?limit=50`, what: 'Messages the SMSC holds, with history, oldest first. ?limit=N keeps the newest N; ?since=smsc-<n> only those created after that id; ?since=<ISO time> only those updated (last history entry) after it. ?scope=store: only messages not yet final (the store); ?scope=history: only finished ones (newest 500); no scope: both.' },
      { method: 'GET', path: `${base}/kpi`, what: 'Common KPI summary: {nf, up, requests, errors, latencyMs, extra:{mo_accepted, mt_delivered, mt_failed, waiting, status_reports_sent, alerts_received, registeredInNrf}}.' },
      { method: 'GET', path: `${base}/api/log?since=0`, what: 'Every request and answer, in and out.' },
      { method: 'GET', path: `${base}/api/metrics`, what: 'Counters, results per operation, per-peer traffic and latency (JSON).' },
      { method: 'GET', path: `${base}/metrics`, what: 'The same in Prometheus text format.' },
      { method: 'POST', path: `${base}/api/metrics/reset`, what: 'Zero every metric (all keys re-seeded at 0) and set since=now. {clearMessages:true} also drops every stored message and cancels its retries, for a clean slate. Answers {ok, since, clearedMessages}.', example: { clearMessages: false } },
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
      t = tpdu.encodeSubmit({ mr: Number(b.mr) || 0, to: b.to, text: b.text, srr: !!b.srr, rd: !!b.rd, vp: b.vp === undefined ? null : b.vp });
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
  if (req.headers['x-holminator-tile'] !== '1') inc('test_requests'); // the tile's own detail view does not count
  try { return send(res, 200, tpdu.decodeAny(String(b.hex || ''), { kind: b.kind, direction: b.direction })); }
  catch (e) { return send(res, 400, { error: e.message }); }
}

async function handle(req, res, { path: p, url }) {
  if (req.method === 'POST' && p === '/smsc/mo-forward-short-message') return moForward(req, res, url);
  if (req.method === 'GET' && p === '/test') return send(res, 200, testCatalogue());
  if (req.method === 'POST' && p === '/test/encode') return testEncode(req, res);
  if (req.method === 'POST' && p === '/test/decode') return testDecode(req, res);
  if (req.method === 'POST' && p === '/smsc/alert-service-centre') return alertServiceCentre(req, res);
  if (req.method === 'POST' && p === '/api/mt') return apiMt(req, res, url);
  if (req.method === 'GET' && p.startsWith('/api/messages/')) {
    const m = findMessage(decodeURIComponent(p.slice('/api/messages/'.length)));
    return m ? send(res, 200, m) : send(res, 404, { error: 'no such message' });
  }
  if (req.method === 'GET' && p === '/api/messages') {
    const r = listMessages(url);
    return r.error ? send(res, 400, { error: r.error }) : send(res, 200, r.list);
  }
  if (req.method === 'GET' && p === '/kpi') return send(res, 200, kpi());
  if (req.method === 'GET' && p === '/api/metrics') return send(res, 200, metricsSnapshot());
  if (req.method === 'POST' && p === '/api/metrics/reset') return metricsReset(req, res);
  if (req.method === 'GET' && p === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(metricsText());
    return true;
  }
  if (req.method === 'GET' && p === '/log') {
    const limit = Math.min(Number((url && url.searchParams.get('limit')) || 200) || 200, LOG_MAX);
    return send(res, 200, st.log.slice(-limit).reverse().map(flowEntry));
  }
  if (req.method === 'GET' && p === '/api/log') {
    const since = Number((url && url.searchParams.get('since')) || 0);
    return send(res, 200, st.log.filter(e => e.id > since).slice(-200));
  }
  if (req.method === 'GET' && (p === '/status' || p === '/')) {
    return send(res, 200, {
      nf: 'SMSC', nfType: NF_TYPE, nfInstanceId: NF_ID, scAddress: SC_ADDRESS, apiPrefix: SELF_BASE,
      registeredInNrf: st.registered, messages: st.messages.length, storeHeld: st.messages.length, historyKept: st.history.length,
    });
  }
  return false;
}

module.exports = {
  init(ctx) {
    st.dataDir = ctx && ctx.dataDir;
    loadStore();
    // An attempt cut short by a restart is simply tried again.
    for (const m of st.messages) if (m.status === 'DELIVERING') { m.status = 'PENDING'; hist(m, 'PENDING', 'restart during an attempt'); }
    // Store-and-forward across restarts: ACCEPTED (MT never started, e.g. a crash right after the MO) and PENDING
    // go out now, expired ones end with a status report if SRR was set. WAITING keeps waiting for the alert; its
    // fallback nextRetryAt is in the store and sweep() picks it up when due.
    const requeue = new Set();
    for (const m of [...st.messages]) { // a copy: FORWARDED and EXPIRED move to the history
      // Every record has an explicit direction; MTs come only from /api/mt and status reports.
      if (!m.direction) m.direction = m.kind === 'STATUS_REPORT' || m.from === SC_ADDRESS ? 'MT' : 'MO';
      // MO terminates at the SMSC: one an older deploy left ACCEPTED (or in the old MO-to-MT relay) is FORWARDED now.
      if (m.direction === 'MO') { if (['ACCEPTED', ...ACTIVE].includes(m.status)) onMoAccepted(m); continue; }
      if (m.status !== 'ACCEPTED' && m.status !== 'PENDING') continue;
      if (expired(m)) { expire(m); continue; }
      if (m.status === 'ACCEPTED') { m.status = 'PENDING'; hist(m, 'PENDING', 'restart: queued for MT delivery'); }
      requeue.add(m.to);
    }
    saveStore();
    for (const to of requeue) kick(to);
    // The NRF may load after us or lose its state on a redeploy: heartbeat() re-registers when needed.
    const first = setTimeout(() => { heartbeat().catch(e => console.error(`[${TEAM}] nrf:`, e.message)); }, 3000);
    if (first.unref) first.unref();
    every(HEARTBEAT_S * 1000, heartbeat);
    every(SWEEP_MS, sweep);
  },
  handle,
  // For tests.
  _st: st,
  _internals: { allMessages, findMessage, retire, FINAL, HISTORY_MAX, sweep, kick, nfProfile, resolve, registerInNrf, heartbeat, baseOf, saveStore, metricsSnapshot, metricsText, newMetrics, SC_ADDRESS, NF_ID, NF_TYPE, TIMING, MT_LIMITS, MO_LIMITS },
};
