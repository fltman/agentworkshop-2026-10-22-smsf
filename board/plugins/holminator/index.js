// SMSC (team holminator): simulated SGd/S6c-style SMSC over HTTP/JSON, served at /t/holminator/.
// Contract: projects/holminator/CONTRACT.md. Plan: projects/holminator/PLAN.md.

const fs = require('node:fs');
const path = require('node:path');

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

const st = {
  registered: false,
  log: [],
  logSeq: 0,
  messages: [],
  msgSeq: 0,
  disc: new Map(), // nfType or nfType/instanceId -> { base, ts }
  dataDir: null,
  timers: [],
};

function rec(dir, peer, what, status, body) {
  st.log.push({ id: ++st.logSeq, ts: new Date().toISOString(), dir, peer, what, status, body });
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

async function call(peer, method, url, body, { quiet = false } = {}) {
  if (!quiet) rec('out', peer, `${method} ${url}`, null, body);
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
    if (!quiet || r.status >= 300) rec('in', peer, `${method} ${url}`, r.status, json);
    return { status: r.status, body: json };
  } catch (e) {
    rec('in', peer, `${method} ${url}`, 0, e.message);
    return { status: 0, body: null, error: e.message };
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
  const r = await call('nrf', 'PUT', `${NRF_NFM}/nf-instances/${NF_ID}`, nfProfile());
  st.registered = r.status === 200 || r.status === 201;
  return st.registered;
}

// TS 29.510 heartbeat; the NRF suspends us after 3 missed ones. A 404 means it lost us: register again.
async function heartbeat() {
  if (!st.registered) return registerInNrf();
  const r = await call('nrf', 'PATCH', `${NRF_NFM}/nf-instances/${NF_ID}`, [], { quiet: true });
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
  if (hit && Date.now() - hit.ts < 60000) return hit.base;
  let q = `target-nf-type=${encodeURIComponent(nfType)}&requester-nf-type=${NF_TYPE}`;
  if (instanceId) q += `&target-nf-instance-id=${encodeURIComponent(instanceId)}`;
  const r = await call('nrf', 'GET', `${NRF_DISC}/nf-instances?${q}`);
  const list = r.body && Array.isArray(r.body.nfInstances) ? r.body.nfInstances : [];
  const inst = (instanceId && list.find(i => i.nfInstanceId === instanceId)) || list[0];
  if (!inst) return null;
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

async function handle(req, res, { path: p, url }) {
  if (req.method === 'POST' && p === '/smsc/mo-forward-short-message') {
    let b = null;
    try { b = await readJson(req); } catch { /* logged below */ }
    rec('in', 'smsf', 'POST /smsc/mo-forward-short-message', null, b);
    return notImplemented(res, 'MO-Forward-Short-Message');
  }
  if (req.method === 'POST' && p === '/smsc/alert-service-centre') {
    let b = null;
    try { b = await readJson(req); } catch { /* logged below */ }
    rec('in', 'udm', 'POST /smsc/alert-service-centre', null, b);
    return notImplemented(res, 'Alert-Service-Centre');
  }
  if (req.method === 'POST' && p === '/api/mt') return notImplemented(res, 'MT origination');
  if (req.method === 'GET' && p === '/api/messages') return send(res, 200, st.messages);
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
  _internals: { nfProfile, resolve, registerInNrf, heartbeat, baseOf, saveStore, SC_ADDRESS, NF_ID, NF_TYPE },
};
