// AMF + UE simulator (team tompa): Namf_Communication (TS 29.518) N1N2MessageTransfer for SMS, a simulated UE,
// and the Nsmsf_SMService (TS 29.540) consumer side. Served at /t/tompa/. Contract: projects/tompa/CONTRACT.md

const sms = require('./sms');
const diagnose = require('./diagnose');

const TEAM = 'tompa';
// Peers publish absolute apiPrefix values, so we register and call on the public origin (override for local runs).
const HOST = (process.env.TOMPA_BOARD_URL || 'https://smsf.torget.bjarby.com').replace(/\/$/, '');
// The NRF is the one well-known address; everything else is discovered through it.
const NRF_TEAM = process.env.NRF_TEAM || 'smsf-hao';
const NRF_NFM = `${HOST}/t/${NRF_TEAM}/nnrf-nfm/v1`;
const NRF_DISC = `${HOST}/t/${NRF_TEAM}/nnrf-disc/v1`;
const SELF_BASE = `${HOST}/t/${TEAM}`;
const NF_ID = '7a3e0c1d-0000-4000-8000-00000000a3f0'; // stable across restarts, so the NRF sees one AMF
const PLMN = { mcc: '001', mnc: '01' };
const GUAMI = { plmnId: PLMN, amfId: 'cafe00' };
const SC_ADDRESS = process.env.TOMPA_SC_ADDRESS || '46700000100'; // holminator's SMSC address
const HEARTBEAT_S = 30;

// Test subscribers owned by the UDM (hetoteam). The UE simulator holds only UE state.
const SUBSCRIBERS = [
  ['imsi-001010000000001', 'msisdn-46700000001'],
  ['imsi-001010000000002', 'msisdn-46700000002'],
  ['imsi-001010000000003', 'msisdn-46700000003'],
  ['imsi-001010000000004', 'msisdn-46700000004'],
  ['imsi-001010000000005', 'msisdn-46700000005'],
  ['imsi-001019999999999', 'msisdn-46799999999'],
];

const ues = new Map();
function newUe(supi, gpsi) {
  return { supi, gpsi, state: 'DEREGISTERED', smsActive: false, reachable: true, lastSmsf: null, inbox: [], outbox: [] };
}
for (const [supi, gpsi] of SUBSCRIBERS) ues.set(supi, newUe(supi, gpsi));

const log = [];
let seq = 0;
const STARTED = new Date().toISOString();

// KPI counters. Success ratios are computed in kpi(); causes are counted as reported by the peer.
const kpis = {
  reg: { attempts: 0, smsActivated: 0, smsRefused: 0, causes: {} },
  dereg: { attempts: 0, ok: 0 },
  mo: { attempts: 0, ok: 0, failed: 0, causes: {} },
  mt: { received: 0, delivered: 0, notFound: 0, notReachable: 0, badRequest: 0 },
  report: { rpAck: 0, rpError: 0, uplinkOk: 0, uplinkFailed: 0 },
  nrf: { registrations: 0, heartbeatsOk: 0, heartbeatsFailed: 0, discoveries: 0, discoveryMisses: 0 },
  smsfLatency: { n: 0, sumMs: 0, maxMs: 0 },
};
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const causeOf = r => (r.body && (r.body.cause || r.body.result)) || (r.status === 0 ? 'NO_ANSWER' : `HTTP_${r.status}`);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function kpi() {
  const l = kpis.smsfLatency;
  return {
    since: STARTED,
    nrf: { registered: nrf.registered, lastStatus: nrf.lastStatus, ...kpis.nrf },
    ues: { total: ues.size, registered: [...ues.values()].filter(x => x.state === 'REGISTERED').length,
      smsActive: [...ues.values()].filter(x => x.smsActive).length, unreachable: [...ues.values()].filter(x => !x.reachable).length },
    registration: { ...kpis.reg, smsActivationSuccessPct: pct(kpis.reg.smsActivated, kpis.reg.attempts) },
    deregistration: { ...kpis.dereg },
    moSms: { ...kpis.mo, successPct: pct(kpis.mo.ok, kpis.mo.attempts) },
    mtSms: { ...kpis.mt, deliveryPct: pct(kpis.mt.delivered, kpis.mt.received) },
    deliveryReports: { ...kpis.report },
    smsfLatencyMs: { calls: l.n, avg: l.n ? Math.round(l.sumMs / l.n) : null, max: l.maxMs },
    peerFaults: { distinct: faults.size, byOwner: [...faults.values()].reduce((o, f) => ({ ...o, [f.owner]: (o[f.owner] || 0) + f.count }), {}) },
  };
}
let mr = 0;
const nextMr = () => (mr = (mr + 1) & 0xff);
const nrf = { registered: false, lastStatus: null, timer: null };
let smsfCache = null; // { base, ts }

function rec(dir, peer, method, path, status, body) {
  const entry = { id: ++seq, ts: new Date().toISOString(), dir, peer, method, path, status, body };
  log.push(entry);
  if (log.length > 300) log.shift();
  return entry;
}

// Peer faults found by the boundary decoder, de-duplicated per owner, hop and finding.
const faults = new Map();
function judge(entry, diag) {
  if (!entry || !diag) return diag;
  entry.diag = diag;
  if (diag.verdict !== 'fault') return diag;
  const key = `${diag.owner}|${diag.hop}|${diag.finding}`;
  const f = faults.get(key) || { owner: diag.owner, hop: diag.hop, finding: diag.finding, expected: diag.expected, count: 0, firstTs: entry.ts };
  f.count++;
  f.lastTs = entry.ts;
  f.lastLogId = entry.id;
  f.report = diagnose.report(entry);
  faults.set(key, f);
  return diag;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(body === undefined ? '' : JSON.stringify(body));
  return true;
}
const problem = (res, status, cause, detail) => send(res, status, { status, cause, detail }, 'application/problem+json');

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString('utf8');
  return t ? JSON.parse(t) : {};
}

async function call(peer, method, url, body, type = 'application/json') {
  const path = url.replace(HOST, '');
  rec('out', peer, method, path, null, body);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      headers: { 'content-type': type },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    const entry = rec('in', peer, method, path, r.status, json);
    if (peer === 'smsf') {
      const ms = Date.now() - t0;
      kpis.smsfLatency.n++; kpis.smsfLatency.sumMs += ms; kpis.smsfLatency.maxMs = Math.max(kpis.smsfLatency.maxMs, ms);
    }
    return { status: r.status, body: json, entry };
  } catch (e) {
    const entry = rec('in', peer, method, path, 0, { error: e.message });
    return { status: 0, body: null, error: e.message, entry };
  }
}

// ---------- NRF: register, heartbeat, discover ----------

function profile() {
  return {
    nfInstanceId: NF_ID,
    nfType: 'AMF',
    nfStatus: 'REGISTERED',
    fqdn: new URL(HOST).hostname,
    heartBeatTimer: HEARTBEAT_S,
    plmnList: [PLMN],
    amfInfo: { amfSetId: '001', amfRegionId: 'ca', guamiList: [GUAMI] },
    nfServices: [{
      serviceInstanceId: 'namf-comm-1',
      serviceName: 'namf-comm',
      versions: [{ apiVersionInUri: 'v1', apiFullVersion: '1.0.0' }],
      scheme: new URL(HOST).protocol.replace(':', ''),
      nfServiceStatus: 'REGISTERED',
      // apiRoot carries the full address; apiPrefix stays a path (smsf-hao #build 120).
      apiRoot: SELF_BASE,
      apiPrefix: `/t/${TEAM}`,
    }],
  };
}

async function registerInNrf() {
  const r = await call('nrf', 'PUT', `${NRF_NFM}/nf-instances/${NF_ID}`, profile());
  nrf.lastStatus = r.status;
  nrf.registered = r.status === 200 || r.status === 201;
  if (nrf.registered) kpis.nrf.registrations++;
  return nrf.registered;
}

async function heartbeat() {
  if (!nrf.registered) return registerInNrf();
  const r = await call('nrf', 'PATCH', `${NRF_NFM}/nf-instances/${NF_ID}`,
    [{ op: 'replace', path: '/nfStatus', value: 'REGISTERED' }], 'application/json-patch+json');
  nrf.lastStatus = r.status;
  if (r.status === 404) { kpis.nrf.heartbeatsFailed++; nrf.registered = false; return registerInNrf(); }
  const ok = r.status >= 200 && r.status < 300;
  if (ok) kpis.nrf.heartbeatsOk++; else kpis.nrf.heartbeatsFailed++;
  return ok;
}

function baseOf(inst, serviceName) {
  const svc = (inst.nfServices || []).find(s => s.serviceName === serviceName) || (inst.nfServices || [])[0] || {};
  if (svc.apiRoot) return svc.apiRoot.replace(/\/$/, '');
  const prefix = svc.apiPrefix || inst.apiPrefix || '';
  if (/^https?:\/\//.test(prefix)) return prefix.replace(/\/$/, '');
  if (prefix) return `${HOST}${prefix.startsWith('/') ? '' : '/'}${prefix}`.replace(/\/$/, '');
  return null;
}

async function smsfBase() {
  if (smsfCache && Date.now() - smsfCache.ts < 60000) return smsfCache.base;
  const r = await call('nrf', 'GET',
    `${NRF_DISC}/nf-instances?target-nf-type=SMSF&requester-nf-type=AMF&service-names=nsmsf-sms`);
  judge(r.entry, diagnose.discovery('SMSF', r.status, r.body));
  const inst = r.body && Array.isArray(r.body.nfInstances) ? r.body.nfInstances[0] : null;
  const base = inst ? baseOf(inst, 'nsmsf-sms') : null;
  kpis.nrf.discoveries++;
  if (!base) kpis.nrf.discoveryMisses++;
  smsfCache = base ? { base, ts: Date.now() } : null;
  return base;
}

// ---------- UE simulator triggers ----------

function ueOr404(res, supi) {
  const ue = ues.get(supi);
  if (!ue) { problem(res, 404, 'USER_NOT_FOUND', `no simulated UE ${supi}`); return null; }
  return ue;
}

async function activateSms(ue) {
  const smsf = await smsfBase();
  if (!smsf) return { status: 503, body: { status: 503, cause: 'NF_DISCOVERY_FAILED', detail: 'no SMSF found in NRF' } };
  const r = await call('smsf', 'PUT', `${smsf}/nsmsf-sms/v2/ue-contexts/${ue.supi}`, {
    supi: ue.supi, gpsi: ue.gpsi, amfId: NF_ID, accessType: '3GPP_ACCESS', guami: GUAMI,
  });
  judge(r.entry, diagnose.smsfResponse('activate', ue.supi, r.status, r.body));
  if (r.status === 0) smsfCache = null;
  ue.smsActive = r.status === 200 || r.status === 201;
  ue.lastSmsf = { op: 'activate', status: r.status, body: r.body };
  return r;
}

// TS 23.502 4.2.2.2 / 4.13.3.1: registration succeeds for the 5GS even when SMS over NAS is refused.
async function register(res, ue) {
  ue.state = 'REGISTERED';
  kpis.reg.attempts++;
  const r = await activateSms(ue);
  if (ue.smsActive) kpis.reg.smsActivated++; else { kpis.reg.smsRefused++; bump(kpis.reg.causes, causeOf(r)); }
  return send(res, 200, { supi: ue.supi, state: ue.state, smsActive: ue.smsActive, smsf: { status: r.status, body: r.body } });
}

async function deregister(res, ue) {
  kpis.dereg.attempts++;
  let smsf = null;
  if (ue.smsActive) {
    const base = await smsfBase();
    if (base) {
      const r = await call('smsf', 'DELETE', `${base}/nsmsf-sms/v2/ue-contexts/${ue.supi}`);
      judge(r.entry, diagnose.smsfResponse('deactivate', ue.supi, r.status, r.body));
      smsf = { status: r.status, body: r.body };
    }
  }
  if (!smsf || smsf.status === 204) kpis.dereg.ok++;
  ue.state = 'DEREGISTERED';
  ue.smsActive = false;
  ue.lastSmsf = smsf && { op: 'deactivate', ...smsf };
  return send(res, 200, { supi: ue.supi, state: ue.state, smsf });
}

async function uplink(ue, smsRecordId, hexPayload, text) {
  const base = await smsfBase();
  if (!base) return { status: 503, body: { status: 503, cause: 'NF_DISCOVERY_FAILED', detail: 'no SMSF found in NRF' } };
  const payload = { contentType: 'application/vnd.3gpp.sms', hex: hexPayload };
  if (text !== undefined) payload.text = text;
  return call('smsf', 'POST', `${base}/nsmsf-sms/v2/ue-contexts/${ue.supi}/sendsms`,
    { jsonData: { smsRecordId, smsPayload: payload, gpsi: ue.gpsi } });
}

async function moSms(req, res, ue) {
  let b;
  try { b = await readJson(req); } catch { return problem(res, 400, 'INVALID_JSON', 'body is not JSON'); }
  if (!b.to || typeof b.text !== 'string') return problem(res, 400, 'MANDATORY_IE_MISSING', 'to and text are required');
  if (ue.state !== 'REGISTERED') return problem(res, 409, 'UE_NOT_REGISTERED', 'register the UE first');
  if (!ue.smsActive) return problem(res, 409, 'SMS_NOT_ACTIVE', 'SMS over NAS is not active for this UE');
  const rpMr = nextMr();
  const hexPayload = sms.moSubmit({ rpMr, tpMr: rpMr, scAddress: SC_ADDRESS, to: b.to, text: b.text });
  const smsRecordId = `mo-${TEAM}-${Date.now()}-${rpMr}`;
  kpis.mo.attempts++;
  const r = await uplink(ue, smsRecordId, hexPayload, b.text);
  judge(r.entry, diagnose.smsfResponse('sendsms', ue.supi, r.status, r.body));
  const ok = r.status === 200;
  if (ok) kpis.mo.ok++; else { kpis.mo.failed++; bump(kpis.mo.causes, causeOf(r)); }
  ue.outbox.unshift({ ts: new Date().toISOString(), smsRecordId, to: b.to, text: b.text, ok, status: r.status, result: r.body });
  ue.outbox.length = Math.min(ue.outbox.length, 20);
  return send(res, ok ? 200 : 502, { smsRecordId, delivered: ok, smsf: { status: r.status, body: r.body } });
}

async function setReachable(req, res, ue) {
  let b;
  try { b = await readJson(req); } catch { return problem(res, 400, 'INVALID_JSON', 'body is not JSON'); }
  if (typeof b.reachable !== 'boolean') return problem(res, 400, 'MANDATORY_IE_MISSING', 'reachable (boolean) is required');
  const was = ue.reachable;
  ue.reachable = b.reachable;
  // Stretch goal: when the UE is back, re-activate SMS. The SMSF re-registers in the UDM, which alerts the SMSC
  // for any Message Waiting Data (hetoteam CONTRACT 1.1 and 4).
  let smsf = null;
  if (!was && ue.reachable && ue.state === 'REGISTERED') {
    const r = await activateSms(ue);
    smsf = { status: r.status, body: r.body };
  }
  return send(res, 200, { supi: ue.supi, reachable: ue.reachable, smsf });
}

// ---------- Namf_Communication: N1N2MessageTransfer ----------

async function n1n2(req, res, supi) {
  let b;
  const n1n2Path = `/namf-comm/v1/ue-contexts/${supi}/n1-n2-messages`;
  try { b = await readJson(req); } catch {
    judge(rec('in', 'smsf', 'POST', n1n2Path, null, null), diagnose.n1n2(null));
    return problem(res, 400, 'INVALID_JSON', 'body is not JSON');
  }
  judge(rec('in', 'smsf', 'POST', n1n2Path, null, b), diagnose.n1n2(b));
  kpis.mt.received++;
  const cls = b.n1MessageContainer && b.n1MessageContainer.n1MessageClass;
  const hexPayload = b.smsPayload && b.smsPayload.hex;
  if (cls !== 'SMS' || !hexPayload) { kpis.mt.badRequest++; return problem(res, 400, 'MANDATORY_IE_MISSING', 'n1MessageClass SMS and smsPayload.hex are required'); }
  const ue = ues.get(supi);
  if (!ue || ue.state !== 'REGISTERED') { kpis.mt.notFound++; return problem(res, 404, 'CONTEXT_NOT_FOUND', 'no UE context for this supi'); }
  if (!ue.reachable) { kpis.mt.notReachable++; return problem(res, 504, 'UE_NOT_REACHABLE', 'UE is not reachable'); }

  let parsed = null;
  let parseError = null;
  try { parsed = sms.parseMt(hexPayload); } catch (e) { parseError = e.message; }
  if (parsed) {
    ue.inbox.unshift({ ts: new Date().toISOString(), smsRecordId: b.smsRecordId || null, from: parsed.from,
      text: parsed.text !== null ? parsed.text : (b.smsPayload.text || null), scAddress: parsed.scAddress, hex: hexPayload });
    ue.inbox.length = Math.min(ue.inbox.length, 20);
  }
  send(res, 200, { cause: 'N1_N2_TRANSFER_INITIATED' });

  // TS 23.502 4.13.3.6: the UE answers the MT SMS on the uplink. RP-ACK if we could read it, RP-ERROR otherwise.
  // RP-ERROR cause 111 = protocol error, unspecified (TS 24.011 8.2.5.4).
  const answer = parsed ? sms.rpAck(parsed.rpMr) : sms.rpError(parseInt(hexPayload.slice(2, 4), 16) || 0, 111);
  if (parsed) { kpis.mt.delivered++; kpis.report.rpAck++; } else kpis.report.rpError++;
  const t = setTimeout(() => {
    uplink(ue, b.smsRecordId, answer, parsed ? undefined : `RP-ERROR: ${parseError}`)
      .then(r => {
        judge(r.entry, diagnose.smsfResponse('report', ue.supi, r.status, r.body));
        if (r.status === 200) kpis.report.uplinkOk++; else kpis.report.uplinkFailed++;
      })
      .catch(e => console.error(`[${TEAM}] delivery report:`, e.message));
  }, 50);
  if (t.unref) t.unref();
  return true;
}

// ---------- routing ----------

module.exports = {
  init() {
    const tick = () => heartbeat().catch(e => console.error(`[${TEAM}] nrf:`, e.message));
    const first = setTimeout(() => { try { tick(); } catch (e) { console.error(`[${TEAM}]`, e.message); } }, 3000);
    if (first.unref) first.unref();
    // Until registered: retry every 10 s. Then heartbeat every HEARTBEAT_S. One timer, re-armed each round.
    const loop = () => {
      nrf.timer = setTimeout(() => {
        try { tick(); } catch (e) { console.error(`[${TEAM}]`, e.message); }
        loop();
      }, nrf.registered ? HEARTBEAT_S * 1000 : 10000);
      if (nrf.timer.unref) nrf.timer.unref();
    };
    loop();
  },

  async handle(req, res, { path }) {
    const n = path.match(/^\/namf-comm\/v1\/ue-contexts\/([^/]+)\/n1-n2-messages$/);
    if (n) {
      if (req.method !== 'POST') return problem(res, 405, 'METHOD_NOT_ALLOWED', 'POST only');
      return n1n2(req, res, decodeURIComponent(n[1]));
    }

    if (req.method === 'GET' && path === '/ue') return send(res, 200, [...ues.values()]);
    const u = path.match(/^\/ue\/([^/]+)(?:\/(register|deregister|sms|reachable|inbox))?$/);
    if (u) {
      const ue = ueOr404(res, decodeURIComponent(u[1]));
      if (!ue) return true;
      const action = u[2];
      if (!action && req.method === 'GET') return send(res, 200, ue);
      if (action === 'inbox' && req.method === 'GET') return send(res, 200, ue.inbox);
      if (req.method !== 'POST') return problem(res, 405, 'METHOD_NOT_ALLOWED', 'see CONTRACT.md');
      rec('in', 'trigger', 'POST', path, null, null);
      if (action === 'register') return register(res, ue);
      if (action === 'deregister') return deregister(res, ue);
      if (action === 'sms') return moSms(req, res, ue);
      if (action === 'reachable') return setReachable(req, res, ue);
      return problem(res, 405, 'METHOD_NOT_ALLOWED', 'see CONTRACT.md');
    }

    if (req.method === 'GET' && path === '/log') return send(res, 200, log.slice(-100).reverse());
    if (req.method === 'GET' && path === '/kpi') return send(res, 200, kpi());
    if (req.method === 'GET' && path === '/faults') {
      return send(res, 200, [...faults.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1)));
    }
    if (req.method === 'GET' && (path === '/status' || path === '/')) {
      return send(res, 200, { nf: 'AMF', team: TEAM, nfInstanceId: NF_ID, nrf: { registered: nrf.registered, lastStatus: nrf.lastStatus },
        smsf: smsfCache && smsfCache.base, ues: ues.size, registered: [...ues.values()].filter(x => x.state === 'REGISTERED').length });
    }
    return false;
  },
};
