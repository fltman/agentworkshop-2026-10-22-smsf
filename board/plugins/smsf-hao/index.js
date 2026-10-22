// smsf-hao: the NRF for the group's 5G Core Light.
//
//   Nnrf_NFManagement  /t/smsf-hao/nnrf-nfm/v1/nf-instances[/{nfInstanceId}]
//   Nnrf_NFDiscovery   /t/smsf-hao/nnrf-disc/v1/nf-instances?target-nf-type=..&requester-nf-type=..
//   Tile backend       /t/smsf-hao/status  /t/smsf-hao/log
//
// 3GPP TS 29.510, simplified: no TLS, no OAuth2, no subscriptions/notifications (out of scope per PROJEKT.md).
// Contract and curl examples: projects/smsf-hao/CONTRACT.md

const fs = require('fs');
const path = require('path');

const JSON_CT = { 'content-type': 'application/json; charset=utf-8' };
const PROBLEM_CT = { 'content-type': 'application/problem+json; charset=utf-8' };
const VALIDITY_PERIOD = 3600;
const MISSED_HEARTBEATS_BEFORE_SUSPEND = 3;
const DEFAULT_HEARTBEAT_TIMER = 30;
const LOG_MAX = 300;
const BODY_MAX = 1024 * 1024;

const st = {
  profiles: new Map(),   // nfInstanceId -> { profile, lastSeen, announced }
  log: [],
  file: null,
  timer: null,
  board: null,
  team: 'smsf-hao',
  started: new Date().toISOString(),
  counters: { register: 0, update: 0, deregister: 0, discover: 0, rejected: 0 },
};

// ---------- small helpers ----------

const nowMs = () => Date.now();

function note(dir, text, detail) {
  const entry = { ts: new Date().toISOString(), dir, text, detail: detail || null };
  st.log.push(entry);
  if (st.log.length > LOG_MAX) st.log.splice(0, st.log.length - LOG_MAX);
  console.log(`[smsf-hao] ${dir === 'in' ? '<--' : '-->'} ${text}${detail ? ' ' + detail : ''}`);
}

function json(res, code, body, headers) {
  res.writeHead(code, { ...JSON_CT, ...(headers || {}) });
  res.end(JSON.stringify(body));
  return true;
}

// TS 29.500 ProblemDetails. Every error the other teams see has this shape.
function problem(res, status, title, detail, cause) {
  st.counters.rejected++;
  note('out', `${status} ${title}`, detail);
  res.writeHead(status, PROBLEM_CT);
  res.end(JSON.stringify({ status, title, detail, cause }));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > BODY_MAX) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('malformed JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

// ---------- persistence ----------

function load(dataDir) {
  st.file = path.join(dataDir, 'nf-instances.json');
  try {
    const saved = JSON.parse(fs.readFileSync(st.file, 'utf8'));
    for (const e of saved.entries || []) st.profiles.set(e.profile.nfInstanceId, { ...e, lastSeen: nowMs() });
    console.log(`[smsf-hao] restored ${st.profiles.size} NF profiles`);
  } catch { /* first start, or unreadable: start empty */ }
}

function save() {
  if (!st.file) return;
  try {
    const entries = [...st.profiles.values()].map(e => ({ profile: e.profile, announced: e.announced }));
    fs.writeFileSync(st.file, JSON.stringify({ entries }, null, 2));
  } catch (err) { console.error('[smsf-hao] save:', err && err.message); }
}

// ---------- NF profile ----------

const NF_TYPES = ['NRF', 'UDM', 'AMF', 'SMF', 'SMSF', 'AUSF', 'PCF', 'UDR', 'NEF', 'SMSC', 'UE', 'OTHER'];

function normaliseType(t) {
  return typeof t === 'string' ? t.trim().toUpperCase() : t;
}

// What a consumer needs in order to build a URL without guessing. apiRoot is our own addition on
// top of TS 29.510 (the spec makes the consumer assemble it); it is documented in CONTRACT.md.
function apiRootFor(profile, service) {
  if (service && service.apiRoot) return service.apiRoot;
  const scheme = (service && service.scheme) || 'http';
  const host = profile.fqdn || (profile.ipv4Addresses && profile.ipv4Addresses[0]);
  if (!host) return null;
  const port = service && service.ipEndPoints && service.ipEndPoints[0] && service.ipEndPoints[0].port;
  const authority = port && !String(host).includes(':') ? `${host}:${port}` : host;
  const prefix = service && service.apiPrefix ? String(service.apiPrefix).replace(/\/$/, '') : '';
  return `${scheme}://${authority}${prefix}`;
}

function decorate(profile) {
  const copy = JSON.parse(JSON.stringify(profile));
  for (const s of copy.nfServices || []) {
    const root = apiRootFor(copy, s);
    if (root) s.apiRoot = root;
  }
  return copy;
}

function validate(profile, nfInstanceId) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return 'the body must be an NFProfile object';
  if (!profile.nfInstanceId) return 'nfInstanceId is mandatory';
  if (profile.nfInstanceId !== nfInstanceId) return `nfInstanceId "${profile.nfInstanceId}" does not match the path "${nfInstanceId}"`;
  if (!profile.nfType) return 'nfType is mandatory';
  if (profile.nfServices && !Array.isArray(profile.nfServices)) return 'nfServices must be an array';
  return null;
}

// JSON Patch, the subset TS 29.510 uses for heartbeats and load updates.
function applyPatch(profile, ops) {
  const out = JSON.parse(JSON.stringify(profile));
  for (const op of ops) {
    if (!op || typeof op.path !== 'string' || !op.path.startsWith('/')) throw new Error(`bad patch path: ${JSON.stringify(op && op.path)}`);
    const parts = op.path.split('/').slice(1).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    const key = parts.pop();
    let target = out;
    for (const p of parts) {
      if (target[p] === undefined || target[p] === null) throw new Error(`patch path not found: ${op.path}`);
      target = target[p];
    }
    if (op.op === 'remove') delete target[key];
    else if (op.op === 'add' || op.op === 'replace') target[key] = op.value;
    else throw new Error(`unsupported patch op: ${op.op}`);
  }
  out.nfInstanceId = profile.nfInstanceId;   // identity is never patchable
  return out;
}

// A profile that stops sending heartbeats becomes SUSPENDED and drops out of discovery,
// but is kept so the team can see it and so a later heartbeat revives it.
function sweep() {
  let changed = false;
  for (const e of st.profiles.values()) {
    const timer = Number(e.profile.heartBeatTimer) > 0 ? Number(e.profile.heartBeatTimer) : DEFAULT_HEARTBEAT_TIMER;
    const deadline = timer * MISSED_HEARTBEATS_BEFORE_SUSPEND * 1000;
    const stale = nowMs() - e.lastSeen > deadline;
    if (stale && e.profile.nfStatus === 'REGISTERED') {
      e.profile.nfStatus = 'SUSPENDED';
      changed = true;
      note('out', `SUSPENDED ${e.profile.nfType} ${e.profile.nfInstanceId}`, `no heartbeat for ${Math.round(deadline / 1000)}s`);
    }
  }
  if (changed) save();
}

// ---------- Nnrf_NFManagement ----------

async function nfManagement(req, res, method, segments) {
  // segments after /nnrf-nfm/v1 : ['nf-instances'] or ['nf-instances', id]
  if (segments[0] !== 'nf-instances') return false;
  const id = segments[1] ? decodeURIComponent(segments[1]) : null;

  if (!id) {
    if (method !== 'GET') return problem(res, 405, 'METHOD_NOT_ALLOWED', `${method} is not allowed on the nf-instances collection`);
    const links = [...st.profiles.values()].map(e => ({ href: `/t/${st.team}/nnrf-nfm/v1/nf-instances/${e.profile.nfInstanceId}` }));
    note('in', 'GET nf-instances (collection)', `${links.length} instances`);
    return json(res, 200, { _links: { item: links } });
  }

  const existing = st.profiles.get(id);

  if (method === 'GET') {
    note('in', `GET nf-instances/${id}`);
    if (!existing) return problem(res, 404, 'NOT_FOUND', `no NF instance ${id} is registered`, 'NF_INSTANCE_NOT_FOUND');
    return json(res, 200, decorate(existing.profile));
  }

  if (method === 'DELETE') {
    note('in', `DELETE nf-instances/${id}`);
    if (!existing) return problem(res, 404, 'NOT_FOUND', `no NF instance ${id} is registered`, 'NF_INSTANCE_NOT_FOUND');
    st.profiles.delete(id);
    st.counters.deregister++;
    save();
    note('out', `204 deregistered ${existing.profile.nfType} ${id}`);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (method === 'PUT') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return problem(res, 400, 'INVALID_MSG_FORMAT', e.message); }
    note('in', `PUT nf-instances/${id}`, body && body.nfType ? `nfType=${normaliseType(body.nfType)}` : '');
    const err = validate(body, id);
    if (err) return problem(res, 400, 'INVALID_MSG_FORMAT', err, 'MANDATORY_IE_MISSING');

    const profile = { ...body };
    profile.nfType = normaliseType(profile.nfType);
    if (!NF_TYPES.includes(profile.nfType)) note('in', `unknown nfType ${profile.nfType}, accepted anyway`);
    if (!profile.nfStatus) profile.nfStatus = 'REGISTERED';
    if (!profile.heartBeatTimer) profile.heartBeatTimer = DEFAULT_HEARTBEAT_TIMER;

    const isNew = !existing;
    st.profiles.set(id, { profile, lastSeen: nowMs(), announced: existing ? existing.announced : false });
    if (isNew) st.counters.register++; else st.counters.update++;
    save();
    if (isNew) announce(st.profiles.get(id));

    note('out', `${isNew ? 201 : 200} ${isNew ? 'registered' : 'replaced'} ${profile.nfType} ${id}`);
    return json(res, isNew ? 201 : 200, decorate(profile),
      isNew ? { location: `/t/${st.team}/nnrf-nfm/v1/nf-instances/${encodeURIComponent(id)}` } : undefined);
  }

  if (method === 'PATCH') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return problem(res, 400, 'INVALID_MSG_FORMAT', e.message); }
    note('in', `PATCH nf-instances/${id}`, Array.isArray(body) ? `${body.length} op(s)` : '');
    if (!existing) return problem(res, 404, 'NOT_FOUND', `no NF instance ${id} is registered`, 'NF_INSTANCE_NOT_FOUND');
    const ops = body === null ? [] : body;
    if (!Array.isArray(ops)) return problem(res, 400, 'INVALID_MSG_FORMAT', 'the body must be a JSON Patch array, for example [{"op":"replace","path":"/nfStatus","value":"REGISTERED"}]');

    let patched;
    try { patched = applyPatch(existing.profile, ops); }
    catch (e) { return problem(res, 400, 'INVALID_MSG_FORMAT', e.message); }

    // An empty patch, or no body at all, is the plain heartbeat of TS 29.510 5.2.2.3.
    existing.profile = patched;
    existing.lastSeen = nowMs();
    st.counters.update++;
    save();

    if (ops.length === 0) { note('out', `204 heartbeat ${patched.nfType} ${id}`); res.writeHead(204); res.end(); return true; }
    note('out', `200 patched ${patched.nfType} ${id}`);
    return json(res, 200, decorate(patched));
  }

  return problem(res, 405, 'METHOD_NOT_ALLOWED', `${method} is not allowed on an NF instance`);
}

// ---------- Nnrf_NFDiscovery ----------

function inSupiRange(ranges, supi) {
  const digits = String(supi).replace(/^imsi-/i, '');
  return ranges.some(r => {
    if (r.pattern) { try { return new RegExp(r.pattern).test(digits); } catch { return false; } }
    if (r.start && r.end) return digits >= String(r.start) && digits <= String(r.end);
    return false;
  });
}

function discovery(res, url) {
  const q = url.searchParams;
  const target = normaliseType(q.get('target-nf-type'));
  const requester = normaliseType(q.get('requester-nf-type'));
  note('in', 'GET nnrf-disc nf-instances', `target=${target} requester=${requester}`);

  if (!target) return problem(res, 400, 'INVALID_QUERY_PARAM', 'target-nf-type is mandatory', 'MANDATORY_QUERY_PARAM_MISSING');
  if (!requester) return problem(res, 400, 'INVALID_QUERY_PARAM', 'requester-nf-type is mandatory', 'MANDATORY_QUERY_PARAM_MISSING');

  const wantedServices = (q.get('service-names') || '').split(',').map(s => s.trim()).filter(Boolean);
  const targetId = q.get('target-nf-instance-id');
  const locality = q.get('preferred-locality');
  const supi = q.get('supi');
  const limit = Number(q.get('limit')) > 0 ? Number(q.get('limit')) : 0;

  let hits = [...st.profiles.values()]
    .map(e => e.profile)
    .filter(p => p.nfStatus === 'REGISTERED')
    .filter(p => normaliseType(p.nfType) === target)
    .filter(p => !targetId || p.nfInstanceId === targetId)
    .filter(p => !wantedServices.length || (p.nfServices || []).some(s => wantedServices.includes(s.serviceName)))
    .filter(p => !supi || !Array.isArray(p.supiRanges) || !p.supiRanges.length || inSupiRange(p.supiRanges, supi));

  // Stable order: preferred locality first, then priority (low wins), then id so repeated lookups agree.
  hits.sort((a, b) => {
    if (locality) {
      const la = a.locality === locality ? 0 : 1, lb = b.locality === locality ? 0 : 1;
      if (la !== lb) return la - lb;
    }
    const pa = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 100;
    const pb = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 100;
    if (pa !== pb) return pa - pb;
    return String(a.nfInstanceId).localeCompare(String(b.nfInstanceId));
  });

  if (limit) hits = hits.slice(0, limit);
  st.counters.discover++;
  note('out', '200 SearchResult', `${hits.length} instance(s) of ${target} for ${requester}`);
  return json(res, 200, { validityPeriod: VALIDITY_PERIOD, nfInstances: hits.map(decorate) }, { 'cache-control': `max-age=${VALIDITY_PERIOD}` });
}

// ---------- the board ----------

// React, do not chatter: one line in #build the first time an NF registers, never on re-registration.
function announce(entry) {
  if (!st.board || !entry || entry.announced) return;
  entry.announced = true;
  save();
  const p = entry.profile;
  const svc = (p.nfServices || []).map(s => s.serviceName).join(', ') || 'no nfServices listed';
  try {
    st.board.post(
      `NRF: ${p.nfType} registered, nfInstanceId ${p.nfInstanceId}, services: ${svc}. ` +
      `Discoverable now via GET /t/${st.team}/nnrf-disc/v1/nf-instances with target-nf-type=${p.nfType}.`,
      'build');
  } catch (err) { console.error('[smsf-hao] announce:', err && err.message); }
}

module.exports = {
  init(ctx) {
    st.board = ctx.board;
    st.team = ctx.team || 'smsf-hao';
    load(ctx.dataDir);
    st.timer = setInterval(() => {
      try { sweep(); } catch (err) { console.error('[smsf-hao] sweep:', err && err.message); }
    }, 15000);
    if (st.timer.unref) st.timer.unref();
    console.log('[smsf-hao] NRF up: /nnrf-nfm/v1 and /nnrf-disc/v1');
  },

  async handle(req, res, { path: p, url, board, dataDir, team }) {
    if (!st.board && board) { st.board = board; st.team = team || st.team; }
    if (!st.file && dataDir) load(dataDir);
    const segments = p.split('/').filter(Boolean);
    const method = req.method.toUpperCase();

    if (method === 'GET' && (segments.length === 0 || segments[0] === 'status')) {
      const byType = {};
      for (const e of st.profiles.values()) {
        const t = normaliseType(e.profile.nfType);
        byType[t] = (byType[t] || 0) + 1;
      }
      return json(res, 200, {
        nrf: st.team, started: st.started, byType, counters: st.counters,
        instances: [...st.profiles.values()].map(e => ({
          nfInstanceId: e.profile.nfInstanceId,
          nfType: normaliseType(e.profile.nfType),
          nfStatus: e.profile.nfStatus,
          services: (e.profile.nfServices || []).map(s => s.serviceName),
          apiRoot: apiRootFor(e.profile, (e.profile.nfServices || [])[0]),
          lastSeen: new Date(e.lastSeen).toISOString(),
        })),
      });
    }

    if (method === 'GET' && segments[0] === 'log') {
      const n = Math.min(Number(url.searchParams.get('limit')) || 60, LOG_MAX);
      return json(res, 200, { log: st.log.slice(-n) });
    }

    if (segments[0] === 'nnrf-nfm' && segments[1] === 'v1') {
      return nfManagement(req, res, method, segments.slice(2));
    }

    if (segments[0] === 'nnrf-disc' && segments[1] === 'v1' && segments[2] === 'nf-instances') {
      if (method !== 'GET') return problem(res, 405, 'METHOD_NOT_ALLOWED', `${method} is not allowed on nnrf-disc`);
      return discovery(res, url);
    }

    return false;   // -> 404
  },

  onMessage(m, { board, team }) {
    if (m.from === team) return;
    if (!new RegExp(`@${team}\\b`, 'i').test(m.text)) return;
    const registered = [...st.profiles.values()].filter(e => e.profile.nfStatus === 'REGISTERED');
    const list = registered.map(e => normaliseType(e.profile.nfType)).sort().join(', ') || 'nobody yet';
    try {
      board.post(
        `NRF is up: PUT /t/${team}/nnrf-nfm/v1/nf-instances/{nfInstanceId} to register, PATCH to heartbeat, DELETE to deregister, ` +
        `and GET /t/${team}/nnrf-disc/v1/nf-instances with target-nf-type and requester-nf-type to discover. ` +
        `Registered right now: ${list}. Examples in projects/${team}/CONTRACT.md.`,
        m.channel, m.id);
    } catch (err) { console.error('[smsf-hao] onMessage:', err && err.message); }
  },
};
