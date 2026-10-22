// SMSF (team krilju): Nsmsf_SMService (TS 29.540) plus the SMSC-facing interface, SGd style.
// Served at /t/krilju/. Contract: projects/krilju/CONTRACT.md

const TEAM = 'krilju';
// Peers publish public apiPrefix values, so we use the public origin too (override for local runs).
const HOST = (process.env.SMSF_BOARD_URL || 'https://smsf.torget.bjarby.com').replace(/\/$/, '');
// The NRF is the one well-known address; everything else is discovered through it.
const NRF_TEAM = process.env.NRF_TEAM || 'smsf-hao';
const NRF_NFM = `${HOST}/t/${NRF_TEAM}/nnrf-nfm/v1`;
const NRF_DISC = `${HOST}/t/${NRF_TEAM}/nnrf-disc/v1`;
const SELF_BASE = `${HOST}/t/${TEAM}`;
const NF_ID = '6f1c2c1e-0000-4000-8000-0000006b7269'; // stable across restarts, so the NRF sees one SMSF
const PENDING_MT_MS = 15000;

const contexts = new Map(); // supi -> { supi, gpsi, amfId, since }
const pendingMt = new Map(); // smsRecordId -> resolve(report)
const pendingMr = new Map(); // supi:rpMr -> smsRecordId, for UEs that omit smsRecordId in their RP-ACK
let rpMrSeq = 0;
const SC_ADDRESS = '46700000100';
const rpLayer = require('./rp');
const log = [];
const disc = new Map(); // nfType -> { base, ts }
let registered = false;

const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage(); // per-request { id, kind }, filled in once the SMS is identified
const FLOW = Symbol('flow');
const tag = (id, kind) => { const f = als.getStore(); if (f && id) { f.id = id; f.kind = kind; } };
let logSeq = 0;
function rec(dir, peer, what, data) {
  log.push({ id: ++logSeq, ts: new Date().toISOString(), dir, peer, what, data, [FLOW]: als.getStore() });
  if (log.length > 500) log.shift();
}

const startedAt = Date.now();
const inbound = new Map();  // route -> { count, byStatus, ms }
const outbound = new Map(); // peer  -> { count, errors, byStatus, ms }
function bump(map, key, status, ms) {
  const m = map.get(key) || { count: 0, errors: 0, byStatus: {}, ms: 0 };
  m.count++; m.ms += ms;
  if (status === 0 || status >= 400) m.errors++;
  m.byStatus[status] = (m.byStatus[status] || 0) + 1;
  map.set(key, m);
}
const table = map => Object.fromEntries([...map].map(([k, v]) => [k, { ...v, avgMs: v.count ? Math.round(v.ms / v.count) : 0 }]));

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body === undefined ? '' : JSON.stringify(body));
  return true;
}
const problem = (res, status, cause, detail) => send(res, status, { status, cause, detail });

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  if (!t) return {};
  return JSON.parse(t);
}

async function call(peer, method, url, body) {
  rec('out', peer, `${method} ${url}`, body);
  const t0 = Date.now();
  const r = await rawCall(peer, method, url, body);
  bump(outbound, peer, r.status, Date.now() - t0);
  return r;
}

async function rawCall(peer, method, url, body) {
  try {
    const r = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    rec('in', peer, `${r.status} ${method} ${url}`, json);
    return { status: r.status, body: json };
  } catch (e) {
    rec('in', peer, `ERROR ${method} ${url}`, e.message);
    return { status: 0, body: null, error: e.message };
  }
}

async function registerInNrf() {
  const profile = {
    nfInstanceId: NF_ID,
    nfType: 'SMSF',
    nfStatus: 'REGISTERED',
    fqdn: new URL(HOST).host,
    heartBeatTimer: 30,
    nfServices: [{
      serviceInstanceId: 'nsmsf-sms-1', serviceName: 'nsmsf-sms', versions: [{ apiVersionInUri: 'v2', apiFullVersion: '2.0.0' }],
      scheme: new URL(HOST).protocol.replace(':', ''), nfServiceStatus: 'REGISTERED', apiPrefix: `/t/${TEAM}`, apiRoot: SELF_BASE,
    }],
  };
  const r = await call('nrf', 'PUT', `${NRF_NFM}/nf-instances/${NF_ID}`, profile);
  registered = r.status === 200 || r.status === 201;
  return registered;
}

// The NRF suspends a profile after 3 missed heartbeats; re-register if it forgot us.
async function heartbeat() {
  const r = await fetch(`${NRF_NFM}/nf-instances/${NF_ID}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json-patch+json' },
    body: '[]',
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (r && r.status === 204) return;
  registered = false;
  await registerInNrf();
}

// NRF type names for peers that TS 29.510 has no type for.
const NF_TYPE = { SMSC: 'CUSTOM_SMSC' };

// Resolve the base URL of an NF through NRF discovery (cached 60 s).
async function resolve(nfType) {
  const hit = disc.get(nfType);
  if (hit && Date.now() - hit.ts < 60000) return hit.base;
  const target = NF_TYPE[nfType] || nfType;
  const r = await call('nrf', 'GET', `${NRF_DISC}/nf-instances?target-nf-type=${target}&requester-nf-type=SMSF`);
  const inst = r.body && Array.isArray(r.body.nfInstances) ? r.body.nfInstances[0] : null;
  if (!inst) return null;
  const svc = (inst.nfServices || [])[0] || {};
  let base = svc.apiRoot || svc.apiPrefix || '';
  if (base.startsWith('/')) base = `${HOST}${base}`; // relative apiPrefix: same board
  base = base.replace(/\/$/, '') || null;
  if (base) disc.set(nfType, { base, ts: Date.now() });
  return base;
}

async function activate(req, res, supi) {
  let b;
  try { b = await readJson(req); } catch { return problem(res, 400, 'INVALID_JSON', 'body is not JSON'); }
  rec('in', 'amf', `PUT ue-contexts/${supi}`, b);
  if (!/^imsi-\d+$/.test(supi)) return problem(res, 400, 'INVALID_SUPI', 'supi must be imsi-<digits>');
  const udm = await resolve('UDM');
  if (!udm) return problem(res, 503, 'NF_DISCOVERY_FAILED', 'no UDM found in NRF');

  // TS 23.502 4.13.3.1: register in the UDM first, then fetch the SMS subscription data.
  const reg = await call('udm', 'PUT', `${udm}/nudm-uecm/v1/${supi}/registrations/smsf-3gpp-access`, {
    smsfInstanceId: NF_ID,
    plmnId: (b.guami && b.guami.plmnId) || b.plmnId || { mcc: '001', mnc: '01' },
    smsfMAPAddress: '46700000999',
    smsfDiameterAddress: { name: 'smsf.krilju', realm: 'workshop' },
  });
  if (reg.status === 404) return problem(res, 404, 'USER_UNKNOWN', 'subscriber not found in UDM');
  if (reg.status === 0 || reg.status >= 300) return problem(res, 502, 'UDM_REGISTRATION_FAILED', `UDM answered ${reg.status}`);

  const unregister = () => call('udm', 'DELETE', `${udm}/nudm-uecm/v1/${supi}/registrations/smsf-3gpp-access`);
  const sms = await call('udm', 'GET', `${udm}/nudm-sdm/v2/${supi}/sms-data`);
  if (sms.status === 404) { await unregister(); return problem(res, 404, 'USER_UNKNOWN', 'no SMS data for subscriber'); }
  if (sms.status !== 200) { await unregister(); return problem(res, 502, 'UDM_UNAVAILABLE', `UDM answered ${sms.status}`); }
  if (!sms.body || sms.body.smsSubscribed !== true) {
    await unregister();
    return problem(res, 403, 'SMS_NOT_ALLOWED', 'SMS is not part of the subscription');
  }
  const mng = await call('udm', 'GET', `${udm}/nudm-sdm/v2/${supi}/sms-mng-data`);
  const mngData = mng.status === 200 && mng.body ? mng.body : {};

  contexts.set(supi, { supi, gpsi: b.gpsi || null, amfId: b.amfId || null, mng: mngData, since: new Date().toISOString() });
  return send(res, 201, { smsfInstanceId: NF_ID });
}

async function deactivate(res, supi) {
  rec('in', 'amf', `DELETE ue-contexts/${supi}`);
  if (!contexts.has(supi)) return problem(res, 404, 'CONTEXT_NOT_FOUND', 'no SMS context for this supi');
  contexts.delete(supi);
  const udm = await resolve('UDM');
  if (udm) await call('udm', 'DELETE', `${udm}/nudm-uecm/v1/${supi}/registrations/smsf-3gpp-access`);
  return send(res, 204);
}

async function uplinkSms(req, res, supi) {
  let b;
  try { b = await readJson(req); } catch { return problem(res, 400, 'INVALID_JSON', 'body is not JSON'); }
  rec('in', 'amf', `POST ue-contexts/${supi}/sendsms`, b);
  tag((b.jsonData && b.jsonData.smsRecordId) || `mo-${supi.slice(-3)}-${Date.now()}`, 'MO'); // retagged MT if this is a UE answer
  const ctx = contexts.get(supi);
  if (!ctx) return problem(res, 404, 'CONTEXT_NOT_FOUND', 'SMS not activated for this supi');
  const jd = b.jsonData || {};
  const hex = jd.smsPayload && jd.smsPayload.hex;
  if (!hex) return problem(res, 400, 'MANDATORY_IE_MISSING', 'jsonData.smsPayload.hex missing');
  const rp = rpLayer.parseFromUe(hex);

  // The UE's answer to an MT SMS (RP-ACK / RP-ERROR) arrives here, matched on smsRecordId or on the RP-MR.
  if (rp && (rp.type === 'ACK' || rp.type === 'ERROR')) {
    const id = (jd.smsRecordId && pendingMt.has(jd.smsRecordId) && jd.smsRecordId) || pendingMr.get(`${supi}:${rp.rpMr}`);
    tag(id, 'MT');
    const waiting = id && pendingMt.get(id);
    if (waiting) {
      pendingMt.delete(id);
      waiting({ hex: rp.tpdu, error: rp.type === 'ERROR', cause: rp.cause });
      return send(res, 200, { smsRecordId: id, deliveryStatus: 'SMS_DELIVERY_SUCCESS' });
    }
    return problem(res, 404, 'NO_PENDING_MT', 'no MT SMS is waiting for this report');
  }

  const mng = ctx.mng || {};
  if (mng.moSmsSubscribed === false || mng.moSmsBarringAll === true) {
    return problem(res, 403, 'MO_SMS_BARRED', 'MO SMS is not allowed for this subscriber');
  }
  // RP-DATA from the UE: the SMSC leg carries the bare TPDU. Anything else is passed on as is.
  const isRpData = rp && rp.type === 'DATA';
  const tpdu = isRpData ? rp.tpdu : hex;
  const smsc = await resolve('SMSC');
  if (!smsc) return problem(res, 503, 'NF_DISCOVERY_FAILED', 'no SMSC found in NRF');
  const r = await call('smsc', 'POST', `${smsc}/smsc/mo-forward-short-message`, {
    supi, msisdn: ctx.gpsi, scAddress: (isRpData && rp.scAddress) || SC_ADDRESS, sms: { hex: tpdu }, smsRecordId: jd.smsRecordId,
  });
  const report = r.body && r.body.deliveryReport && r.body.deliveryReport.hex;
  const payload = hexStr => ({ contentType: 'application/vnd.3gpp.sms', hex: hexStr });
  if (r.status === 200 && r.body && r.body.result === 'SUCCESS') {
    return send(res, 200, {
      smsRecordId: jd.smsRecordId, deliveryStatus: 'SMS_DELIVERY_SUCCESS', deliveryReport: r.body.deliveryReport,
      ...(isRpData ? { smsPayload: payload(rpLayer.rpAck(rp.rpMr, report)) } : {}),
    });
  }
  const cause = (r.body && r.body.result) || 'SMSC_FAILURE';
  const status = r.status === 0 ? 504 : 502;
  const err = { status, cause, detail: `SMSC answered ${r.status}` };
  // Give the UE an RP-ERROR: 21 short message transfer rejected, 38 network out of order.
  if (isRpData) err.smsPayload = payload(rpLayer.rpError(rp.rpMr, r.status === 403 ? 21 : 38, report));
  return send(res, status, err);
}

async function mtForward(req, res) {
  let b;
  try { b = await readJson(req); } catch { return problem(res, 400, 'INVALID_JSON', 'body is not JSON'); }
  rec('in', 'smsc', 'POST /smsc/mt-forward-short-message', b);
  const hex = b.sms && b.sms.hex;
  const id = b.smsRecordId || `mt-${Date.now()}`;
  tag(id, 'MT');
  if (!hex || !(b.supi || b.msisdn)) return send(res, 400, { result: 'FAILURE', cause: 'supi or msisdn and sms.hex are required' });
  let ctx = b.supi ? contexts.get(b.supi) : null;
  if (!ctx && b.msisdn) ctx = [...contexts.values()].find(c => c.gpsi && c.gpsi.replace(/^msisdn-/, '') === String(b.msisdn).replace(/^msisdn-/, ''));
  if (!ctx) return send(res, 404, { result: 'UNKNOWN_SUBSCRIBER', cause: 'no SMS context in this SMSF' });
  const amf = await resolve('AMF');
  if (!amf) return send(res, 503, { result: 'FAILURE', cause: 'no AMF found in NRF' });
  const rpMr = (rpMrSeq = (rpMrSeq + 1) & 0xff);
  const mrKey = `${ctx.supi}:${rpMr}`;
  // Register before the call: the UE's RP-ACK may arrive before the N1N2 answer returns.
  const report = new Promise(resolve => {
    pendingMt.set(id, resolve);
    pendingMr.set(mrKey, id);
    const t = setTimeout(() => { if (pendingMt.delete(id)) resolve(null); }, PENDING_MT_MS);
    if (t.unref) t.unref();
  });
  report.then(() => pendingMr.delete(mrKey));
  const r = await call('amf', 'POST', `${amf}/namf-comm/v1/ue-contexts/${ctx.supi}/n1-n2-messages`, {
    n1MessageContainer: { n1MessageClass: 'SMS', n1MessageContent: { contentId: 'sms' } },
    smsPayload: { contentType: 'application/vnd.3gpp.sms', hex: rpLayer.rpDataToUe(rpMr, b.scAddress || SC_ADDRESS, hex) },
    smsRecordId: id,
  });
  if (r.status < 200 || r.status >= 300) {
    pendingMt.delete(id);
    pendingMr.delete(mrKey);
    if (r.status === 404 || r.status === 504 || r.status === 0) return send(res, 504, { result: 'ABSENT_SUBSCRIBER', cause: 'UE not reachable' });
    return send(res, 502, { result: 'FAILURE', cause: `AMF answered ${r.status}` });
  }
  const rep = await report;
  if (!rep) return send(res, 504, { result: 'FAILURE', cause: 'no delivery report from the UE' });
  if (rep.error) return send(res, 502, { result: 'FAILURE', cause: 'UE answered RP-ERROR', rpCause: rep.cause, ...(rep.hex ? { deliveryReport: { hex: rep.hex } } : {}) });
  return send(res, 200, { result: 'SUCCESS', ...(rep.hex ? { deliveryReport: { hex: rep.hex } } : {}) });
}

function routeOf(method, path) {
  if (/^\/nsmsf-sms\/v2\/ue-contexts\/[^/]+\/sendsms$/.test(path) && method === 'POST') return { name: 'UplinkSMS', peer: 'amf' };
  if (/^\/nsmsf-sms\/v2\/ue-contexts\/[^/]+$/.test(path) && method === 'PUT') return { name: 'Activate', peer: 'amf' };
  if (/^\/nsmsf-sms\/v2\/ue-contexts\/[^/]+$/.test(path) && method === 'DELETE') return { name: 'Deactivate', peer: 'amf' };
  if (method === 'POST' && path === '/smsc/mt-forward-short-message') return { name: 'MT-Forward-Short-Message', peer: 'smsc' };
  return null;
}

function prometheus() {
  const out = [`smsf_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
    `smsf_ue_contexts ${contexts.size}`, `smsf_registered_in_nrf ${registered ? 1 : 0}`, `smsf_pending_mt ${pendingMt.size}`];
  for (const [k, v] of inbound) for (const [st, n] of Object.entries(v.byStatus)) out.push(`smsf_inbound_total{route="${k}",status="${st}"} ${n}`);
  for (const [k, v] of outbound) for (const [st, n] of Object.entries(v.byStatus)) out.push(`smsf_outbound_total{peer="${k}",status="${st}"} ${n}`);
  return out.join('\n') + '\n';
}

function routeOf(method, path) {
  if (/^\/nsmsf-sms\/v2\/ue-contexts\/[^/]+\/sendsms$/.test(path) && method === 'POST') return { name: 'UplinkSMS', peer: 'amf' };
  if (/^\/nsmsf-sms\/v2\/ue-contexts\/[^/]+$/.test(path) && method === 'PUT') return { name: 'Activate', peer: 'amf' };
  if (/^\/nsmsf-sms\/v2\/ue-contexts\/[^/]+$/.test(path) && method === 'DELETE') return { name: 'Deactivate', peer: 'amf' };
  if (method === 'POST' && path === '/smsc/mt-forward-short-message') return { name: 'MT-Forward-Short-Message', peer: 'smsc' };
  return null;
}

function prometheus() {
  const out = [`smsf_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
    `smsf_ue_contexts ${contexts.size}`, `smsf_registered_in_nrf ${registered ? 1 : 0}`, `smsf_pending_mt ${pendingMt.size}`];
  for (const [k, v] of inbound) for (const [st, n] of Object.entries(v.byStatus)) out.push(`smsf_inbound_total{route="${k}",status="${st}"} ${n}`);
  for (const [k, v] of outbound) for (const [st, n] of Object.entries(v.byStatus)) out.push(`smsf_outbound_total{peer="${k}",status="${st}"} ${n}`);
  return out.join('\n') + '\n';
}

module.exports = {
  init() {
    const tick = () => {
      (registered ? heartbeat() : registerInNrf()).catch(e => console.error(`[${TEAM}] nrf:`, e.message));
    };
    // Register (retrying while the NRF is not up), then heartbeat every 20 s.
    const t = setInterval(() => {
      try { tick(); } catch (e) { console.error(`[${TEAM}]`, e.message); }
    }, 20000);
    if (t.unref) t.unref();
    const first = setTimeout(() => { try { tick(); } catch (e) { console.error(`[${TEAM}]`, e.message); } }, 3000);
    if (first.unref) first.unref();
  },

  handle(req, res, ctx) {
    return als.run({}, () => handleInner(req, res, ctx));
  },
};

async function handleInner(req, res, { path }) {
    const route = routeOf(req.method, path);
    if (route) {
      const t0 = Date.now();
      res.on('finish', () => {
        bump(inbound, route.name, res.statusCode, Date.now() - t0);
        rec('out', route.peer, `${res.statusCode} ${route.name}`);
      });
    }
    const m = path.match(/^\/nsmsf-sms\/v2\/ue-contexts\/([^/]+)(\/sendsms)?$/);
    if (m) {
      const supi = decodeURIComponent(m[1]);
      if (!m[2] && req.method === 'PUT') return activate(req, res, supi);
      if (!m[2] && req.method === 'DELETE') return deactivate(res, supi);
      if (m[2] && req.method === 'POST') return uplinkSms(req, res, supi);
      return problem(res, 405, 'METHOD_NOT_ALLOWED', 'see CONTRACT.md');
    }
    if (req.method === 'POST' && path === '/smsc/mt-forward-short-message') return mtForward(req, res);
    if (req.method === 'GET' && path === '/log') {
      const lim = Math.min(500, Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 100);
      return send(res, 200, log.slice(-lim).map(e => ({ ...e, flow: e[FLOW] && e[FLOW].id, kind: e[FLOW] && e[FLOW].kind })));
    }
    if (req.method === 'GET' && path === '/metrics') {
      return send(res, 200, {
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), nfInstanceId: NF_ID, registeredInNrf: registered,
        ueContexts: contexts.size, pendingMt: pendingMt.size, inbound: table(inbound), outbound: table(outbound),
      });
    }
    if (req.method === 'GET' && path === '/metrics.prom') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(prometheus());
      return true;
    }
    if (req.method === 'GET' && path === '/contexts') return send(res, 200, [...contexts.values()]);
    if (req.method === 'GET' && path === '/status') return send(res, 200, { nfInstanceId: NF_ID, registeredInNrf: registered, contexts: contexts.size });
    return false;
}
