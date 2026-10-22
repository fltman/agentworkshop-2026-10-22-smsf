// UDM (team hetoteam): Nudm_UECM + Nudm_SDM (TS 29.503) and a simulated MAP SRI-for-SM /
// ReportSM-DeliveryStatus / Alert-Service-Centre interface for the SMSC (TS 29.002, TS 29.338 S6c).
// Served at /t/hetoteam/. Contract: projects/hetoteam/CONTRACT.md

const fs = require('fs');
const path = require('path');

const TEAM = 'hetoteam';
// Peers publish public apiPrefix values, so we use the public origin too (override for local runs).
const HOST = (process.env.SMSF_BOARD_URL || 'https://smsf.torget.bjarby.com').replace(/\/$/, '');
// The NRF is the one well-known address; everything else is discovered through it.
const NRF_TEAM = process.env.NRF_TEAM || 'smsf-hao';
const NRF_NFM = `${HOST}/t/${NRF_TEAM}/nnrf-nfm/v1`;
const NRF_DISC = `${HOST}/t/${NRF_TEAM}/nnrf-disc/v1`;
const SELF_BASE = `${HOST}/t/${TEAM}`;
const NF_ID = 'a1b2c3d4-0000-4000-8000-000068657465'; // stable across restarts, so the NRF sees one UDM
// Give the SMSF time to store the UE context after its UECM PUT before the SMSC redelivers.
const ALERT_DELAY_MS = Number(process.env.UDM_ALERT_DELAY_MS ?? 2000);
const PLMN = { mcc: '001', mnc: '01' };
const LOG_MAX = 500;

// ---------- subscriber data (static, see CONTRACT.md "Test subscribers") ----------

function subscriber(n, profile, subs = {}, mng = {}) {
  return {
    supi: `imsi-00101000000000${n}`,
    gpsi: `msisdn-4670000000${n}`,
    profile,
    smsSubsData: { smsSubscribed: true, ...subs },
    smsMngData: {
      mtSmsSubscribed: true, mtSmsBarringAll: false, mtSmsBarringRoaming: false,
      moSmsSubscribed: true, moSmsBarringAll: false, moSmsBarringRoaming: false,
      ...mng,
    },
  };
}
const SUBSCRIBERS = [
  subscriber(1, 'SMS allowed'),
  subscriber(2, 'SMS allowed'),
  subscriber(3, 'SMS not allowed', { smsSubscribed: false }),
  subscriber(4, 'MT SMS barred', {}, { mtSmsBarringAll: true }),
  subscriber(5, 'MO SMS barred', {}, { moSmsBarringAll: true }),
];

const digits = s => String(s || '').replace(/^(msisdn-|imsi-|tel:)/, '').replace(/[^0-9]/g, '');

function findUe(ueId) {
  const id = String(ueId || '');
  if (id.startsWith('imsi-')) return SUBSCRIBERS.find(s => s.supi === id) || null;
  if (id.startsWith('msisdn-')) return SUBSCRIBERS.find(s => s.gpsi === id) || null;
  return null;
}
function findByMsisdn(m) {
  const d = digits(m);
  return d ? SUBSCRIBERS.find(s => digits(s.gpsi) === d) || null : null;
}

// ---------- state (persisted in ctx.dataDir) ----------

let registrations = {}; // supi -> SmsfRegistration
let mwd = {};           // supi -> { scAddresses: [..], mnrf, mcef }
let stateFile = null;
const log = [];
let logId = 0;
const nrf = { registered: false, lastHeartbeat: 0, heartBeatTimer: 60, lastError: null };
const disc = new Map(); // nfType -> { base, ts }

function loadState(dataDir) {
  if (!dataDir) return;
  stateFile = path.join(dataDir, 'state.json');
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    registrations = s.registrations || {};
    mwd = s.mwd || {};
  } catch { /* first start */ }
}
function saveState() {
  if (!stateFile) return;
  try { fs.writeFileSync(stateFile, JSON.stringify({ registrations, mwd }, null, 1)); }
  catch (e) { console.error(`[${TEAM}] save:`, e.message); }
}

function rec(entry) {
  log.push({ id: ++logId, ts: new Date().toISOString(), ...entry });
  if (log.length > LOG_MAX) log.shift();
}

// ---------- metrics (in memory, since plugin start) ----------

const STARTED = Date.now();
const ops = {};    // op -> { dir, total, ok, fail, msSum, msMax, lastStatus, lastTs, results: { cause: n } }
const causes = {}; // cause/result -> n
const recent = []; // timestamps of protocol messages, for the per-minute rate

function opOf(dir, method, p) {
  if (dir === 'in') {
    if (p.startsWith('/nudm-uecm/')) return { PUT: 'uecm_register', GET: 'uecm_get', DELETE: 'uecm_deregister' }[method] || 'uecm_other';
    if (p.startsWith('/nudm-sdm/')) return 'sdm_get';
    if (p.endsWith('/send-routing-info-for-sm')) return 'sri_for_sm';
    if (p.endsWith('/report-sm-delivery-status')) return 'report_sm_delivery_status';
    return 'other_in';
  }
  if (p.includes('/nnrf-nfm/')) return { PUT: 'nrf_register', PATCH: 'nrf_heartbeat', DELETE: 'nrf_deregister' }[method] || 'nrf_other';
  if (p.includes('/nnrf-disc/')) return 'nrf_discovery';
  if (p.endsWith('/alert-service-centre')) return 'alert_service_centre';
  return 'other_out';
}

function count(dir, method, p, status, ms, body) {
  const op = opOf(dir, method, p);
  const o = ops[op] || (ops[op] = { dir, total: 0, ok: 0, fail: 0, msSum: 0, msMax: 0, lastStatus: null, lastTs: null, results: {} });
  const ok = status >= 200 && status < 300;
  o.total++;
  if (ok) o.ok++; else o.fail++;
  o.msSum += ms;
  o.msMax = Math.max(o.msMax, ms);
  o.lastStatus = status;
  o.lastTs = new Date().toISOString();
  const result = ok ? String(status) : String((body && (body.cause || body.result)) || (status === 0 ? 'NO_ANSWER' : status));
  o.results[result] = (o.results[result] || 0) + 1;
  if (!ok) causes[result] = (causes[result] || 0) + 1;
  const now = Date.now();
  recent.push(now);
  while (recent.length && now - recent[0] > 60000) recent.shift();
}

const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function metrics() {
  const now = Date.now();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  const all = Object.values(ops);
  const sum = (dir, k) => all.filter(o => o.dir === dir).reduce((a, o) => a + o[k], 0);
  const op = n => ops[n] || { total: 0, ok: 0, fail: 0, results: {} };
  const inTotal = sum('in', 'total');
  const mwdPending = Object.values(mwd).reduce((a, m) => a + m.scAddresses.length, 0);
  return {
    uptimeSec: Math.round((now - STARTED) / 1000),
    since: new Date(STARTED).toISOString(),
    kpi: {
      provisionedSubscribers: SUBSCRIBERS.length,
      activeRegistrations: Object.keys(registrations).length,
      mwdPending,
      requestsIn: inTotal,
      requestsOut: sum('out', 'total'),
      errorRateInPct: rate(sum('in', 'fail'), inTotal),
      avgLatencyInMs: inTotal ? Math.round((sum('in', 'msSum') / inTotal) * 10) / 10 : null,
      messagesLastMinute: recent.length,
      uecmRegisterSuccessPct: rate(op('uecm_register').ok, op('uecm_register').total),
      sdmSuccessPct: rate(op('sdm_get').ok, op('sdm_get').total),
      sriForSmSuccessPct: rate(op('sri_for_sm').ok, op('sri_for_sm').total),
      sriAbsentSubscriber: op('sri_for_sm').results.ABSENT_SUBSCRIBER_SM || 0,
      alertsSent: op('alert_service_centre').total,
      alertsOk: op('alert_service_centre').ok,
      nrfRegistered: nrf.registered,
      nrfHeartbeatAgeSec: nrf.lastHeartbeat ? Math.round((now - nrf.lastHeartbeat) / 1000) : null,
      nrfHeartbeatTimerSec: nrf.heartBeatTimer,
    },
    ops: Object.fromEntries(Object.entries(ops).map(([k, o]) => [k, {
      dir: o.dir, total: o.total, ok: o.ok, fail: o.fail, successPct: rate(o.ok, o.total),
      avgMs: o.total ? Math.round((o.msSum / o.total) * 10) / 10 : null, maxMs: o.msMax,
      lastStatus: o.lastStatus, lastTs: o.lastTs, results: o.results,
    }])),
    causes,
  };
}

// Same numbers in the Prometheus text format, for anyone who wants to scrape them.
function prometheus(m) {
  const lines = [];
  const g = (name, help, v) => { if (v === null || v === undefined) return; lines.push(`# HELP udm_${name} ${help}`, `# TYPE udm_${name} gauge`, `udm_${name} ${typeof v === 'boolean' ? Number(v) : v}`); };
  g('uptime_seconds', 'Seconds since the plugin started', m.uptimeSec);
  g('registrations_active', 'Active SMSF registrations', m.kpi.activeRegistrations);
  g('subscribers_provisioned', 'Provisioned subscribers', m.kpi.provisionedSubscribers);
  g('mwd_pending', 'SC addresses waiting in Message Waiting Data', m.kpi.mwdPending);
  g('nrf_registered', '1 when registered in the NRF', m.kpi.nrfRegistered);
  lines.push('# HELP udm_messages_total Protocol messages by operation and result', '# TYPE udm_messages_total counter');
  for (const [op, o] of Object.entries(m.ops)) {
    for (const [result, n] of Object.entries(o.results)) lines.push(`udm_messages_total{op="${op}",dir="${o.dir}",result="${result}"} ${n}`);
  }
  return lines.join('\n') + '\n';
}

// ---------- HTTP helpers ----------

function send(res, status, body, headers = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, h);
  res.end(body === undefined ? '' : JSON.stringify(body));
  return true;
}
// ProblemDetails, TS 29.571
const problem = (res, status, cause, detail, extra = {}) =>
  send(res, status, { title: cause, status, detail, cause, ...extra }, { 'content-type': 'application/problem+json' });
// Routing errors: MAP error name (TS 29.002) plus the S6c result code where one exists (TS 29.338).
const mapError = (res, status, result, detail, diameterResultCode, extra = {}) =>
  send(res, status, { status, result, ...(diameterResultCode ? { diameterResultCode } : {}), detail, ...extra });

class BadJson extends Error {}
const bodies = new WeakMap(); // req -> parsed body, for the message log

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  if (!t.trim()) { bodies.set(req, undefined); return {}; }
  let b;
  try { b = JSON.parse(t); } catch { bodies.set(req, t); throw new BadJson('body is not JSON'); }
  bodies.set(req, b);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadJson('body must be a JSON object');
  return b;
}

async function call(peer, method, url, body, contentType = 'application/json') {
  const entry = { dir: 'out', peer, method, path: url, request: body };
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': contentType },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const ms = Date.now() - t0;
    rec({ ...entry, status: r.status, ms, response: json });
    count('out', method, url, r.status, ms, json);
    return { status: r.status, body: json };
  } catch (e) {
    const ms = Date.now() - t0;
    rec({ ...entry, status: 0, ms, response: e.message });
    count('out', method, url, 0, ms, null);
    return { status: 0, body: null, error: e.message };
  }
}

// ---------- NRF (TS 29.510) ----------

function nfProfile() {
  const self = new URL(SELF_BASE);
  // TS 29.510: apiRoot = scheme://fqdn[:port]/apiPrefix. apiRoot itself is smsf-hao's convenience field.
  const svc = (id, name, v, full) => ({
    serviceInstanceId: id, serviceName: name, versions: [{ apiVersionInUri: v, apiFullVersion: full }],
    scheme: self.protocol.replace(':', ''), nfServiceStatus: 'REGISTERED',
    ...(self.port ? { ipEndPoints: [{ port: Number(self.port) }] } : {}),
    apiPrefix: self.pathname, apiRoot: SELF_BASE,
  });
  return {
    nfInstanceId: NF_ID,
    nfType: 'UDM',
    nfStatus: 'REGISTERED',
    fqdn: self.hostname,
    plmnList: [PLMN],
    udmInfo: {
      supiRanges: [{ start: '001010000000000', end: '001019999999999' }],
      gpsiRanges: [{ start: '46700000000', end: '46799999999' }],
    },
    nfServices: [
      svc('nudm-uecm-1', 'nudm-uecm', 'v1', '1.0.0'),
      svc('nudm-sdm-1', 'nudm-sdm', 'v2', '2.0.0'),
      svc('sms-routing-1', 'sms-routing', 'v1', '1.0.0'),
    ],
  };
}

async function registerInNrf() {
  const r = await call('nrf', 'PUT', `${NRF_NFM}/nf-instances/${NF_ID}`, nfProfile());
  nrf.registered = r.status === 200 || r.status === 201;
  nrf.lastError = nrf.registered ? null : `register answered ${r.status || r.error}`;
  if (nrf.registered) {
    nrf.lastHeartbeat = Date.now();
    const hb = r.body && Number(r.body.heartBeatTimer);
    if (hb > 0) nrf.heartBeatTimer = hb;
  }
}

async function heartbeat() {
  // An empty JSON Patch is the plain heartbeat (TS 29.510 5.2.2.3).
  const r = await call('nrf', 'PATCH', `${NRF_NFM}/nf-instances/${NF_ID}`, [], 'application/json-patch+json');
  if (r.status === 404) { nrf.registered = false; return registerInNrf(); }
  if (r.status >= 200 && r.status < 300) { nrf.lastHeartbeat = Date.now(); nrf.lastError = null; }
  else nrf.lastError = `heartbeat answered ${r.status || r.error}`;
}

async function nrfTick() {
  if (!nrf.registered) return registerInNrf();
  // Heartbeat a bit before the NRF's timer runs out.
  if (Date.now() - nrf.lastHeartbeat >= nrf.heartBeatTimer * 800) return heartbeat();
}

// Base URL of an NF through NRF discovery (cached 60 s).
async function resolve(nfType) {
  const hit = disc.get(nfType);
  if (hit && Date.now() - hit.ts < 60000) return hit.base;
  const r = await call('nrf', 'GET', `${NRF_DISC}/nf-instances?target-nf-type=${nfType}&requester-nf-type=UDM`);
  const inst = r.body && Array.isArray(r.body.nfInstances) ? r.body.nfInstances[0] : null;
  if (!inst) return null;
  const svc = (inst.nfServices || [])[0] || {};
  // apiRoot (smsf-hao's field), then an absolute apiPrefix, then scheme://fqdn + apiPrefix.
  let base = svc.apiRoot || inst.apiRoot || null;
  const prefix = svc.apiPrefix || inst.apiPrefix || '';
  if (!base && /^https?:\/\//.test(prefix)) base = prefix;
  if (!base && inst.fqdn) {
    const port = ((svc.ipEndPoints || [])[0] || {}).port;
    base = `${svc.scheme || 'https'}://${inst.fqdn}${port ? `:${port}` : ''}${prefix}`;
  }
  base = base ? base.replace(/\/$/, '') : null;
  if (base) disc.set(nfType, { base, ts: Date.now() });
  return base;
}

// ---------- Message Waiting Data and Alert-Service-Centre ----------

function mwdStatus(supi) {
  const m = mwd[supi];
  return { scAddressInMwd: !!(m && m.scAddresses.length), mnrf: !!(m && m.mnrf), mcef: !!(m && m.mcef) };
}
function addMwd(supi, scAddress, flag) {
  const m = mwd[supi] || (mwd[supi] = { scAddresses: [], mnrf: false, mcef: false });
  if (!m.scAddresses.includes(scAddress)) m.scAddresses.push(scAddress);
  m[flag] = true;
  saveState();
}
function removeMwd(supi, scAddress) {
  const m = mwd[supi];
  if (!m) return;
  m.scAddresses = m.scAddresses.filter(a => a !== scAddress);
  if (!m.scAddresses.length) delete mwd[supi];
  saveState();
}

// TS 23.040: the UE is reachable again, so alert every SMSC that has messages waiting for it.
async function alertServiceCentres(sub) {
  const m = mwd[sub.supi];
  if (!m || !m.scAddresses.length) return;
  // Deregistered again during the delay: keep MWD for the next registration.
  if (!registrations[sub.supi]) return;
  const smsc = await resolve('CUSTOM_SMSC');
  if (!smsc) { rec({ dir: 'note', peer: 'smsc', path: 'alert-service-centre', response: 'no CUSTOM_SMSC in NRF, MWD kept' }); return; }
  for (const scAddress of [...m.scAddresses]) {
    const r = await call('smsc', 'POST', `${smsc}/smsc/alert-service-centre`,
      { msisdn: digits(sub.gpsi), scAddress, alertReason: 'UE_PRESENT' });
    if (r.status >= 200 && r.status < 300) removeMwd(sub.supi, scAddress);
  }
}

// ---------- Nudm_UECM: smsf-3gpp-access (TS 29.503 5.3) ----------

async function uecm(req, res, ueId) {
  const sub = findUe(ueId);
  if (req.method === 'PUT') {
    const b = await readJson(req);
    if (!sub) return problem(res, 404, 'USER_NOT_FOUND', `${ueId} is not provisioned`);
    const missing = ['smsfInstanceId', 'plmnId'].filter(k => !b[k]);
    if (missing.length) {
      return problem(res, 400, 'MANDATORY_IE_MISSING', `missing: ${missing.join(', ')}`,
        { invalidParams: missing.map(param => ({ param: `/${param}`, reason: 'mandatory' })) });
    }
    const existed = !!registrations[sub.supi];
    const reg = { ...b, registrationTime: new Date().toISOString() };
    registrations[sub.supi] = reg;
    saveState();
    if (mwd[sub.supi]) {
      const t = setTimeout(() => {
        alertServiceCentres(sub).catch(e => console.error(`[${TEAM}] alert:`, e.message));
      }, ALERT_DELAY_MS);
      if (t.unref) t.unref();
    }
    if (existed) return send(res, 200, reg);
    return send(res, 201, reg, { location: `${SELF_BASE}/nudm-uecm/v1/${ueId}/registrations/smsf-3gpp-access` });
  }
  if (req.method === 'GET' || req.method === 'DELETE') {
    if (!sub) return problem(res, 404, 'USER_NOT_FOUND', `${ueId} is not provisioned`);
    const reg = registrations[sub.supi];
    if (!reg) return problem(res, 404, 'CONTEXT_NOT_FOUND', `no SMSF registered for ${ueId}`);
    if (req.method === 'GET') return send(res, 200, reg);
    delete registrations[sub.supi];
    saveState();
    return send(res, 204);
  }
  return problem(res, 405, 'METHOD_NOT_ALLOWED', 'PUT, GET or DELETE');
}

// ---------- Nudm_SDM (TS 29.503 6.1) ----------

const DATASETS = { SMS_SUB: 'smsSubsData', SMS_MNG: 'smsMngData' };

function sdm(req, res, supi, dataset, url) {
  if (req.method !== 'GET') return problem(res, 405, 'METHOD_NOT_ALLOWED', 'GET only');
  const sub = findUe(supi);
  if (!sub) return problem(res, 404, 'USER_NOT_FOUND', `${supi} is not provisioned`);
  if (dataset === 'sms-data') return send(res, 200, sub.smsSubsData);
  if (dataset === 'sms-mng-data') return send(res, 200, sub.smsMngData);
  if (dataset) return problem(res, 404, 'DATA_NOT_FOUND', `${dataset} is not served by this UDM; use sms-data or sms-mng-data`);
  const names = (url.searchParams.get('dataset-names') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) return problem(res, 400, 'MANDATORY_IE_MISSING', 'dataset-names is required');
  const unknown = names.filter(n => !DATASETS[n]);
  if (unknown.length) return problem(res, 404, 'DATA_NOT_FOUND', `data sets not served: ${unknown.join(', ')}`);
  const out = {};
  for (const n of names) out[DATASETS[n]] = sub[DATASETS[n]];
  return send(res, 200, out);
}

// ---------- simulated SRI-for-SM / ReportSM-DeliveryStatus ----------

async function sriForSm(req, res) {
  const b = await readJson(req);
  if (!b.msisdn || !b.scAddress) return mapError(res, 400, 'UNEXPECTED_DATA_VALUE', 'msisdn and scAddress are mandatory');
  const sub = findByMsisdn(b.msisdn);
  if (!sub) return mapError(res, 404, 'UNKNOWN_SUBSCRIBER', 'MSISDN not provisioned', 5001);
  if (!sub.smsSubsData.smsSubscribed || !sub.smsMngData.mtSmsSubscribed) {
    return mapError(res, 403, 'TELESERVICE_NOT_PROVISIONED', 'MT SMS is not part of the subscription');
  }
  if (sub.smsMngData.mtSmsBarringAll) return mapError(res, 403, 'CALL_BARRED', 'MT SMS barred for this subscriber');
  const reg = registrations[sub.supi];
  if (!reg) {
    addMwd(sub.supi, String(b.scAddress), 'mnrf');
    return mapError(res, 404, 'ABSENT_SUBSCRIBER_SM', 'no SMSF registered, UE not reachable; SC address stored in MWD',
      5550, { mwdStatus: mwdStatus(sub.supi) });
  }
  return send(res, 200, {
    imsi: digits(sub.supi),
    supi: sub.supi,
    servingNode: {
      nodeType: 'SMSF',
      smsfInstanceId: reg.smsfInstanceId,
      ...(reg.smsfMAPAddress ? { smsfMAPAddress: reg.smsfMAPAddress } : {}),
      ...(reg.smsfDiameterAddress ? { smsfDiameterAddress: reg.smsfDiameterAddress } : {}),
    },
    mwdStatus: mwdStatus(sub.supi),
  });
}

const OUTCOMES = ['ABSENT_SUBSCRIBER', 'SUCCESSFUL_TRANSFER', 'MEMORY_CAPACITY_EXCEEDED'];

async function reportSmDeliveryStatus(req, res) {
  const b = await readJson(req);
  if (!b.msisdn || !b.scAddress || !OUTCOMES.includes(b.deliveryOutcome)) {
    return mapError(res, 400, 'UNEXPECTED_DATA_VALUE', `msisdn, scAddress and deliveryOutcome (${OUTCOMES.join(' | ')}) are mandatory`);
  }
  const sub = findByMsisdn(b.msisdn);
  if (!sub) return mapError(res, 404, 'UNKNOWN_SUBSCRIBER', 'MSISDN not provisioned', 5001);
  const sc = String(b.scAddress);
  if (b.deliveryOutcome === 'ABSENT_SUBSCRIBER') addMwd(sub.supi, sc, 'mnrf');
  else if (b.deliveryOutcome === 'MEMORY_CAPACITY_EXCEEDED') addMwd(sub.supi, sc, 'mcef');
  else removeMwd(sub.supi, sc);
  return send(res, 200, { storedMsisdn: digits(sub.gpsi), mwdStatus: mwdStatus(sub.supi) });
}

// ---------- routing ----------

function route(req, res, p, url) {
  let m;
  if ((m = p.match(/^\/nudm-uecm\/v1\/([^/]+)\/registrations\/smsf-3gpp-access$/))) return uecm(req, res, m[1]);
  if ((m = p.match(/^\/nudm-sdm\/v2\/([^/]+)(?:\/([^/]+))?$/))) return sdm(req, res, m[1], m[2], url);
  if (p === '/sms-routing/v1/send-routing-info-for-sm' && req.method === 'POST') return sriForSm(req, res);
  if (p === '/sms-routing/v1/report-sm-delivery-status' && req.method === 'POST') return reportSmDeliveryStatus(req, res);
  return null;
}

const peerOf = p => (p.startsWith('/nudm-') ? 'smsf' : p.startsWith('/sms-routing') ? 'smsc' : '?');

module.exports = {
  init(ctx) {
    loadState(ctx && ctx.dataDir);
    const tick = () => { nrfTick().catch(e => { nrf.lastError = e.message; console.error(`[${TEAM}] nrf:`, e.message); }); };
    // The NRF may load after us: retry registration every 10 s, then heartbeat as the NRF asks.
    const t = setInterval(() => { try { tick(); } catch (e) { console.error(`[${TEAM}]`, e.message); } }, 10000);
    if (t.unref) t.unref();
    const first = setTimeout(() => { try { tick(); } catch (e) { console.error(`[${TEAM}]`, e.message); } }, 3000);
    if (first.unref) first.unref();
  },

  async handle(req, res, { path: p, url }) {
    if (req.method === 'GET' && (p === '/' || p === '/status')) {
      return send(res, 200, {
        nf: 'UDM', team: TEAM, nfInstanceId: NF_ID, apiPrefix: SELF_BASE, nrf: { ...nrf, base: NRF_NFM },
        registrations: Object.keys(registrations).length, mwd: Object.keys(mwd).length,
        contract: 'projects/hetoteam/CONTRACT.md',
      });
    }
    if (req.method === 'GET' && p === '/subscribers') return send(res, 200, SUBSCRIBERS);
    if (req.method === 'GET' && p === '/metrics') {
      const m = metrics();
      if (url.searchParams.get('format') === 'prometheus') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(prometheus(m));
        return true;
      }
      return send(res, 200, m);
    }
    if (req.method === 'GET' && p === '/registrations') return send(res, 200, { registrations, mwd });
    if (req.method === 'GET' && p === '/log') {
      const since = Number(url.searchParams.get('since')) || 0;
      return send(res, 200, log.filter(e => e.id > since).slice(-200));
    }
    if (req.method === 'POST' && p === '/admin/reset') {
      registrations = {}; mwd = {}; saveState();
      return send(res, 200, { reset: true });
    }

    // Protocol messages: log and count each one with its answer.
    const t0 = Date.now();
    const origEnd = res.end.bind(res);
    res.end = (chunk, ...rest) => {
      let response = null;
      try { response = chunk && chunk.length ? JSON.parse(chunk.toString()) : null; } catch { response = String(chunk); }
      const ms = Date.now() - t0;
      rec({ dir: 'in', peer: peerOf(p), method: req.method, path: p + (url.search || ''), status: res.statusCode, ms, request: bodies.get(req), response });
      count('in', req.method, p, res.statusCode, ms, response);
      return origEnd(chunk, ...rest);
    };
    try {
      const r = route(req, res, p, url);
      if (r === null) { res.end = origEnd; return false; }
      await r;
      return true;
    } catch (e) {
      if (e instanceof BadJson) return problem(res, 400, 'INVALID_MSG_FORMAT', e.message);
      throw e;
    }
  },
};
