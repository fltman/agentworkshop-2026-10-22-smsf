#!/usr/bin/env node
// 5G Core Light end-to-end demo, driven from the SMSC team (holminator) against the LIVE deployed modules:
//   NRF smsf-hao, AMF + UE simulator tompa, SMSF krilju, UDM hetoteam, SMSC holminator.
//
//   node demo.mjs [--base <url>] [--step <name>[,<name>...]] [--timeout <seconds>]
//
// Steps: network, attach, mo, mt, store-and-forward, metrics (default: all, in that order).
// The base URL defaults to the repo-root file .board-url and is never printed. The demo never resets anyone's
// metrics (shared live system); it compares snapshots instead. Exit code 1 if any step FAILs (SKIP is not a failure).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------- pure helpers (unit tested in test/run.mjs) ----------

export const STEP_NAMES = ['network', 'attach', 'mo', 'mt', 'store-and-forward', 'metrics'];

export function parseArgs(argv) {
  const out = { base: null, steps: null, timeoutS: 60, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--base' || a.startsWith('--base=')) out.base = val();
    else if (a === '--step' || a.startsWith('--step=')) out.steps = [...(out.steps || []), ...val().split(',').map(s => s.trim()).filter(Boolean)];
    else if (a === '--timeout' || a.startsWith('--timeout=')) {
      out.timeoutS = Number(val());
      if (!(out.timeoutS > 0)) throw new Error('--timeout must be a positive number of seconds');
    } else throw new Error(`unknown argument ${a}`);
  }
  if (out.steps) {
    const bad = out.steps.filter(s => !STEP_NAMES.includes(s));
    if (bad.length) throw new Error(`unknown step ${bad.join(', ')}; steps: ${STEP_NAMES.join(', ')}`);
  }
  return out;
}

// Normalises a base URL: no trailing slash; throws on anything that is not http(s).
export function normaliseBase(s) {
  const b = String(s || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/.test(b)) throw new Error('base URL must start with http:// or https://');
  return b;
}

// Removes every absolute URL origin, so the board URL never reaches the output.
export const redact = s => String(s).replace(/https?:\/\/[^/\s"']+/g, '');

export const msisdnOf = gpsi => String(gpsi || '').replace(/^msisdn-/, '').replace(/\D/g, '');
export const seqOf = id => Number(String(id || '').replace(/^smsc-/, '')) || 0;

// The SMSC metric keys the demo shows. pdus.* are flattened as pdus.in.<name> / pdus.out.<name>.
export const METRIC_KEYS = [
  'mo_accepted', 'mo_srr_requested', 'status_reports_generated', 'status_reports_sent',
  'mt_originated', 'mt_delivered', 'mt_absent', 'alerts_received', 'mt_srr_requested', 'mt_status_reports_simulated',
];

export function flattenMetrics(snap) {
  const out = {};
  for (const k of METRIC_KEYS) out[k] = Number((snap && snap.counters && snap.counters[k]) || 0);
  for (const dir of ['in', 'out']) {
    for (const [k, v] of Object.entries((snap && snap.pdus && snap.pdus[dir]) || {})) out[`pdus.${dir}.${k}`] = Number(v) || 0;
  }
  return out;
}

export function metricDeltas(before, after) {
  const a = flattenMetrics(before), b = flattenMetrics(after);
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = (b[k] || 0) - (a[k] || 0);
  return out;
}

// expected: { key: minimum delta }. Other traffic on the shared system may add more, never less.
export function checkExpected(deltas, expected) {
  return Object.entries(expected).map(([key, min]) => ({ key, min, got: deltas[key] || 0, ok: (deltas[key] || 0) >= min }));
}

// Did someone reset the SMSC counters between the two snapshots?
export const wasReset = (before, after) => !!(before && after && before.since !== after.since);

// An inbox entry tompa recorded for one of our MT deliveries (smsRecordId is <messageId>-<attempt>).
export const inboxHit = (inbox, messageId) =>
  (inbox || []).find(e => e && typeof e.smsRecordId === 'string' && e.smsRecordId.startsWith(`${messageId}-`)) || null;

// ---------- live plumbing ----------

const TEAMS = { nrf: 'smsf-hao', amf: 'tompa', smsf: 'krilju', udm: 'hetoteam', smsc: 'holminator' };
const UE1 = { supi: 'imsi-001010000000001', msisdn: '46700000001' };
const UE2 = { supi: 'imsi-001010000000002', msisdn: '46700000002' };
const SC_ADDRESS = '46700000100';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient(base) {
  return async function call(method, p, body, timeoutMs = 30000) {
    const t0 = Date.now();
    try {
      const r = await fetch(base + p, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: r.status, body: json, text, ms: Date.now() - t0 };
    } catch (e) {
      return { status: 0, body: null, text: e.message, ms: Date.now() - t0, error: e.message };
    }
  };
}

const brief = r => (r.status === 0 ? `no answer (${redact(r.error)})` : `${r.status}${r.body && (r.body.cause || r.body.result) ? ` ${r.body.cause || r.body.result}` : ''}`);
const oneLine = (o, max = 220) => { const s = redact(typeof o === 'string' ? o : JSON.stringify(o)); return s.length > max ? `${s.slice(0, max)}...` : s; };

class StepError extends Error {}
class StepSkip extends Error {}

function makeCtx(call, opts) {
  const ctx = {
    call, opts,
    runId: Date.now().toString(36).slice(-5),
    expected: {},
    peerNotes: [],
    lines: [],
    say(s = '') { console.log(`    ${redact(s)}`); },
    ok(s) { ctx.say(`ok    ${s}`); },
    warn(s) { ctx.say(`WARN  ${s}`); },
    fail(s) { throw new StepError(s); },
    skip(s) { throw new StepSkip(s); },
    expect(key, n = 1) { ctx.pending[key] = (ctx.pending[key] || 0) + n; },
    pending: {},
    // A fault in another team's module, in the shape #build wants: sent, expected, got.
    peer(team, sent, expected, got) {
      ctx.peerNotes.push({ team, sent, expected, got: redact(got) });
      ctx.warn(`peer ${team}: sent ${sent}; expected ${expected}; got ${redact(got)}`);
    },
    async get(p) { return call('GET', p); },
    async must(method, p, body, okStatuses = [200], label) {
      const r = await call(method, p, body);
      if (!okStatuses.includes(r.status)) {
        ctx.fail(`${label || `${method} ${p}`}: expected ${okStatuses.join('/')}, got ${brief(r)} ${oneLine(r.body || r.text, 300)}`);
      }
      return r;
    },
    async poll(fn, { timeoutMs = 10000, everyMs = 500 } = {}) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() >= until) return null;
        await sleep(everyMs);
      }
    },
  };
  return ctx;
}

const smsc = p => `/t/${TEAMS.smsc}${p}`;
const amf = p => `/t/${TEAMS.amf}${p}`;

async function lastMessageId(ctx) {
  const r = await ctx.must('GET', smsc('/api/messages?limit=1'), undefined, [200]);
  return Array.isArray(r.body) && r.body.length ? r.body[r.body.length - 1].id : 'smsc-0';
}
async function getMessage(ctx, id) {
  const r = await ctx.get(smsc(`/api/messages/${encodeURIComponent(id)}`));
  return r.status === 200 ? r.body : null;
}
async function getUe(ctx, supi) {
  const r = await ctx.must('GET', amf(`/ue/${supi}`), undefined, [200], `tompa GET /ue/${supi}`);
  return r.body;
}

// The SMSC's own view of one message: every state change and every peer operation, in order.
function printHistory(ctx, m, title) {
  ctx.say(`${title} ${m.id} (${m.direction} ${m.kind}) ${m.from} -> ${m.to}: "${m.text}"`);
  const t0 = Date.parse(m.history && m.history[0] && m.history[0].ts) || 0;
  for (const h of m.history || []) ctx.say(`   +${String(Date.parse(h.ts) - t0).padStart(5)} ms  ${h.event.padEnd(26)} ${h.detail || ''}`);
}

// Peer exchanges the SMSC logged since sinceMs that mention one of the terms (ids, MSISDNs): the message sequence
// across the NFs as the SMSC saw it. Time-based, because the log ids restart when the plugin is redeployed.
async function printSequence(ctx, messages, terms) {
  const r = await ctx.get(smsc('/api/log'));
  if (r.status !== 200 || !Array.isArray(r.body)) return;
  const { from, to } = windowOf(messages);
  const hits = sequenceEntries(r.body, from, to, terms);
  if (!hits.length) return;
  ctx.say('message sequence seen at the SMSC:');
  for (const line of hits.map(sequenceLine)) ctx.say(`   ${line}`);
}

// The Alert-Service-Centre that triggered the delivery: an ALERT event after WAITING and before DELIVERED.
export function alertBeforeDelivery(m) {
  const h = m.history || [];
  const w = h.findIndex(x => x.event === 'WAITING');
  const d = h.findIndex(x => x.event === 'DELIVERED');
  if (w < 0 || d < 0) return null;
  return h.slice(w + 1, d).find(x => x.event === 'ALERT') || null;
}

// Server-side time window of a set of message records (their history), padded: no local clock involved.
export function windowOf(messages, beforeMs = 50, afterMs = 500) {
  const ts = messages.flatMap(m => (m.history || []).map(h => Date.parse(h.ts))).filter(Number.isFinite);
  return { from: Math.min(...ts) - beforeMs, to: Math.max(...ts) + afterMs };
}

// Log entries in the window that mention a term, plus the answer to each matching outbound request (answers carry
// no ids, so they are paired with their request by the same 'what', in order).
export function sequenceEntries(log, fromMs, toMs, terms) {
  const inWin = log.filter(e => { const t = Date.parse(e.ts); return e.peer !== 'nrf' && t >= fromMs && t <= toMs; });
  const out = [];
  const open = [];
  for (const e of inWin) {
    const isAnswer = e.dir === 'in' && e.status !== null && e.status !== undefined;
    if (isAnswer) {
      const i = open.findIndex(o => o.what === e.what);
      if (i >= 0) { open.splice(i, 1); out.push(e); }
      continue;
    }
    if (!terms.some(x => x && JSON.stringify(e).includes(x))) continue;
    out.push(e);
    if (e.dir === 'out' && (e.status === null || e.status === undefined)) open.push(e);
  }
  return out;
}

const PEER_NAME = { smsf: 'SMSF krilju', udm: 'UDM hetoteam', api: 'API client', nrf: 'NRF smsf-hao' };
export function sequenceLine(e) {
  const peer = PEER_NAME[e.peer] || e.peer;
  const what = redact(e.what || '');
  const res = e.body && (e.body.result || e.body.cause) ? ` ${e.body.result || e.body.cause}` : '';
  const code = e.body && e.body.diameterResultCode ? ` (${e.body.diameterResultCode})` : '';
  if (/^answer /.test(what)) return `SMSC -> ${peer.padEnd(13)} ${e.status}${res}${code}  ${what}`;
  if (e.status === null || e.status === undefined) return `${e.dir === 'out' ? 'SMSC ->' : 'SMSC <-'} ${peer.padEnd(13)} ${what}`;
  return `SMSC <- ${peer.padEnd(13)} ${e.status}${res}${code}  answer to ${what.replace(/^POST /, '')}`;
}

// ---------- steps ----------

async function stepNetwork(ctx) {
  const r = await ctx.must('GET', '/t/smsf-hao/status', undefined, [200], 'NRF GET /t/smsf-hao/status');
  const inst = r.body.instances || [];
  const need = { AMF: 'tompa', SMSF: 'krilju', UDM: 'hetoteam', CUSTOM_SMSC: 'holminator' };
  const missing = [];
  for (const [type, team] of Object.entries(need)) {
    const hit = inst.find(i => i.nfType === type && i.nfStatus === 'REGISTERED' && String(i.apiRoot || '').endsWith(`/t/${team}`));
    if (!hit) { missing.push(`${type} (${team})`); continue; }
    const age = Math.round((Date.now() - Date.parse(hit.lastSeen)) / 1000);
    ctx.ok(`NRF: ${type.padEnd(11)} ${hit.nfStatus} ${redact(hit.apiRoot).padEnd(15)} services=${hit.services.join(',')} heartbeat ${age}s ago`);
  }
  if (missing.length) ctx.fail(`NRF does not list as REGISTERED: ${missing.join(', ')}`);

  const d = await ctx.get('/t/smsf-hao/nnrf-disc/v1/nf-instances?target-nf-type=CUSTOM_SMSC&requester-nf-type=UDM');
  const found = d.body && (d.body.nfInstances || []).some(p => /\/t\/holminator$/.test(String((p.nfServices || [])[0] && ((p.nfServices[0].apiPrefix) || p.nfServices[0].apiRoot) || '')));
  if (d.status !== 200 || !found) ctx.fail(`NRF discovery of CUSTOM_SMSC for UDM: expected 200 with our instance, got ${brief(d)} ${oneLine(d.body || d.text)}`);
  ctx.ok(`NRF discovery: UDM finds the SMSC (target-nf-type=CUSTOM_SMSC) -> ${d.body.nfInstances.length} instance(s)`);

  for (const team of Object.values(TEAMS)) {
    const k = await ctx.get(`/t/${team}/kpi`);
    if (k.status === 200 && k.body) {
      const extra = team === 'holminator' ? ` consistent=${k.body.extra && k.body.extra.consistent}` : team === 'smsf-hao' ? ` coreCompleteness=${k.body.coreCompleteness && k.body.coreCompleteness.ratio}` : '';
      ctx.ok(`/t/${team}/kpi answers 200 (${k.ms} ms)${extra}`);
      continue;
    }
    const m = await ctx.get(`/t/${team}/metrics`);
    if (m.status === 200) {
      // Not a fault: the group app (tompa, #build 230) reads each team's own kpi OR metrics endpoint.
      ctx.ok(`/t/${team}/metrics answers 200 (${m.ms} ms; no /kpi, ${brief(k)}: the group app reads either)`);
      continue;
    }
    ctx.fail(`${team} answers neither /kpi (${brief(k)}) nor /metrics (${brief(m)})`);
  }
}

async function ensureAttached(ctx, ue, label) {
  let u = await getUe(ctx, ue.supi);
  if (u.state === 'REGISTERED' && u.smsActive) {
    ctx.ok(`${label} ${ue.supi} (${msisdnOf(u.gpsi)}) already REGISTERED, smsActive=true`);
    return u;
  }
  ctx.say(`${label} ${ue.supi} is ${u.state}, smsActive=${u.smsActive}: POST /t/tompa/ue/${ue.supi}/register`);
  const r = await ctx.must('POST', amf(`/ue/${ue.supi}/register`), {}, [200], `tompa register ${ue.supi}`);
  if (!r.body.smsActive) {
    ctx.peer('tompa/krilju', `POST /t/tompa/ue/${ue.supi}/register`, 'smsActive=true (SMSF Activate 200/201)', oneLine(r.body));
    ctx.fail(`${label} registered but SMS not active: SMSF answered ${oneLine(r.body.smsf)}`);
  }
  ctx.ok(`${label} REGISTERED, Activate at SMSF answered ${r.body.smsf && r.body.smsf.status}`);
  u = await getUe(ctx, ue.supi);
  return u;
}

async function stepAttach(ctx) {
  await ensureAttached(ctx, UE1, 'UE1');
  await ensureAttached(ctx, UE2, 'UE2');
  // Registration across the NFs: the SMSF holds a context, the UDM holds the SMSF registration.
  const c = await ctx.get('/t/krilju/contexts');
  const regs = await ctx.get('/t/hetoteam/registrations');
  for (const ue of [UE1, UE2]) {
    if (c.status === 200 && Array.isArray(c.body)) {
      const has = c.body.some(x => JSON.stringify(x).includes(ue.supi));
      if (!has) ctx.fail(`SMSF krilju has no SMS context for ${ue.supi} (GET /t/krilju/contexts)`);
      ctx.ok(`SMSF krilju: SMS context for ${ue.supi}`);
    } else ctx.warn(`SMSF krilju /contexts answered ${brief(c)}, not shown`);
    const reg = regs.body && regs.body.registrations && regs.body.registrations[ue.supi];
    if (!reg) ctx.fail(`UDM hetoteam has no smsf-3gpp-access registration for ${ue.supi} (GET /t/hetoteam/registrations)`);
    ctx.ok(`UDM hetoteam: ${ue.supi} served by SMSF ${reg.smsfInstanceId} since ${reg.registrationTime}`);
  }
}

async function stepMo(ctx) {
  const u1 = await getUe(ctx, UE1.supi);
  if (!(u1.state === 'REGISTERED' && u1.smsActive)) ctx.fail(`UE1 is not attached (${u1.state}, smsActive=${u1.smsActive}); run --step attach`);
  const marker = await lastMessageId(ctx);
  const text = `demo ${ctx.runId} MO UE1 to UE2`;
  ctx.say(`UE1 sends MO: POST /t/tompa/ue/${UE1.supi}/sms {to: ${UE2.msisdn}, srr: true, text: "${text}"}`);
  const r = await ctx.call('POST', amf(`/ue/${UE1.supi}/sms`), { to: UE2.msisdn, text, srr: true });
  if (r.status !== 200 || !r.body || !r.body.delivered) ctx.fail(`MO not delivered: ${brief(r)} ${oneLine(r.body || r.text, 400)}`);
  const sb = r.body.smsf && r.body.smsf.body || {};
  ctx.ok(`AMF -> SMSF sendsms answered ${r.body.smsf.status} ${sb.deliveryStatus || ''}; RP-ACK to UE ${sb.smsPayload ? sb.smsPayload.hex : '-'} (smsRecordId ${r.body.smsRecordId})`);

  const mo = await ctx.poll(async () => {
    const l = await ctx.get(smsc(`/api/messages?since=${marker}`));
    return Array.isArray(l.body) && l.body.find(m => m.direction === 'MO' && m.smsRecordId === r.body.smsRecordId);
  }, { timeoutMs: 5000 });
  if (!mo) ctx.fail(`no MO record at the SMSC with smsRecordId ${r.body.smsRecordId} after 5 s`);
  if (mo.status !== 'FORWARDED') ctx.fail(`MO ${mo.id} is ${mo.status}, expected FORWARDED`);
  if (mo.srr !== true) ctx.fail(`MO ${mo.id} has srr=${mo.srr}: TP-SRR was lost on the way (sent srr: true to tompa)`);
  ctx.ok(`SMSC stored MO ${mo.id} from ${mo.from} (supi ${mo.supi}) to ${mo.to}, TP-MR ${mo.mr}, TP-SRR=1, status FORWARDED (simulated onward delivery)`);
  ctx.expect('mo_accepted'); ctx.expect('mo_srr_requested'); ctx.expect('pdus.in.RP-DATA/SMS-SUBMIT'); ctx.expect('pdus.out.RP-ACK/SMS-SUBMIT-REPORT');

  const srId = mo.statusReportId || (await ctx.poll(async () => (await getMessage(ctx, mo.id) || {}).statusReportId, { timeoutMs: 5000 }));
  if (!srId) ctx.fail(`MO ${mo.id} has no statusReportId after 5 s although TP-SRR=1`);
  const sr = await ctx.poll(async () => { const m = await getMessage(ctx, srId); return m && !['PENDING', 'DELIVERING', 'ACCEPTED'].includes(m.status) ? m : null; }, { timeoutMs: 15000 });
  if (!sr) ctx.fail(`status report ${srId} not final after 15 s`);
  if (sr.status !== 'DELIVERED') ctx.fail(`status report ${srId} is ${sr.status}, expected DELIVERED: ${oneLine(sr.history.slice(-2))}`);
  if (sr.st !== 0) ctx.fail(`status report ${srId} TP-ST ${sr.st}, expected 0x00`);
  ctx.ok(`SMS-STATUS-REPORT ${sr.id} for ${sr.reportFor}: TP-MR ${sr.mr}, TP-RA ${sr.ra}, TP-ST 0x00, DELIVERED to UE1 ${sr.to}`);
  ctx.expect('status_reports_generated'); ctx.expect('status_reports_sent'); ctx.expect('pdus.out.RP-DATA/SMS-STATUS-REPORT');

  const hit = await ctx.poll(async () => inboxHit((await getUe(ctx, UE1.supi)).inbox, sr.id), { timeoutMs: 5000 });
  if (!hit) {
    ctx.peer('tompa', `MT status report ${sr.id} via SMSF (SMSC says DELIVERED)`, `an inbox entry on UE1 with smsRecordId ${sr.id}-<n>`, 'none within 5 s');
    ctx.fail(`UE1 inbox has no entry for ${sr.id}`);
  }
  if (hit.kind !== 'status-report') ctx.fail(`UE1 inbox entry for ${sr.id} is kind ${hit.kind}, expected status-report`);
  ctx.ok(`UE1 inbox: ${hit.kind} "${hit.text}"`);
  printHistory(ctx, mo, 'SMSC history');
  printHistory(ctx, sr, 'SMSC history');
  await printSequence(ctx, [mo, sr], [mo.smsRecordId, mo.id, sr.id, sr.to]);
}

async function stepMt(ctx) {
  const u2 = await getUe(ctx, UE2.supi);
  if (!(u2.state === 'REGISTERED' && u2.smsActive)) ctx.fail(`UE2 is not attached (${u2.state}, smsActive=${u2.smsActive}); run --step attach`);
  const text = `demo ${ctx.runId} MT to UE2`;
  ctx.say(`generator: POST /t/holminator/api/mt?wait=1 {to: ${UE2.msisdn}, text: "${text}"} (srr defaults to true)`);
  const r = await ctx.must('POST', smsc('/api/mt?wait=1'), { to: UE2.msisdn, text }, [200], 'SMSC /api/mt');
  const m = r.body.message;
  ctx.expect('mt_originated'); ctx.expect('mt_srr_requested');
  if (r.body.result !== 'DELIVERED') ctx.fail(`MT ${r.body.messageId} ended ${r.body.result}, expected DELIVERED: ${oneLine(m && m.history.slice(-3), 400)}`);
  ctx.ok(`MT ${m.id} DELIVERED in ${Date.parse(m.deliveredAt) - Date.parse(m.submittedAt)} ms, attempts ${m.attempts}, serving SMSF ${m.servingSmsf}, SMS-DELIVER-REPORT ${m.deliveryReportHex}`);
  ctx.expect('mt_delivered'); ctx.expect('pdus.out.RP-DATA/SMS-DELIVER'); ctx.expect('pdus.in.RP-ACK/SMS-DELIVER-REPORT');
  const final = (await ctx.poll(async () => { const x = await getMessage(ctx, m.id); return x && x.statusReport ? x : null; }, { timeoutMs: 5000 })) || m;
  if (!final.statusReport || final.statusReport.tpSt !== '0x00') ctx.fail(`MT ${m.id}: simulated status report to the originating SME is ${oneLine(final.statusReport)}, expected TP-ST 0x00`);
  ctx.ok(`status report to the originating SME ${m.from} (simulated): TP-ST ${final.statusReport.tpSt}`);
  ctx.expect('mt_status_reports_simulated');
  const hit = await ctx.poll(async () => inboxHit((await getUe(ctx, UE2.supi)).inbox, m.id), { timeoutMs: 5000 });
  if (!hit) {
    ctx.peer('tompa', `MT ${m.id} via SMSF (SMSC got 200 SUCCESS)`, `an inbox entry on UE2 with smsRecordId ${m.id}-<n>`, 'none within 5 s');
    ctx.fail(`UE2 inbox has no entry for ${m.id}`);
  }
  if (hit.text !== text) ctx.fail(`UE2 inbox text "${hit.text}", expected "${text}"`);
  ctx.ok(`UE2 inbox: ${hit.kind} from ${hit.from} "${hit.text}"`);
  printHistory(ctx, final, 'SMSC history');
  await printSequence(ctx, [final], [final.id, final.to]);
}

async function stepStoreAndForward(ctx) {
  const timeoutMs = ctx.opts.timeoutS * 1000;
  let u2 = await getUe(ctx, UE2.supi);
  if (u2.state !== 'REGISTERED') ctx.fail(`UE2 is ${u2.state} before the step; run --step attach`);
  let deregistered = false;
  try {
    ctx.say(`UE2 detaches: POST /t/tompa/ue/${UE2.supi}/deregister`);
    const d = await ctx.call('POST', amf(`/ue/${UE2.supi}/deregister`), {});
    if (d.status === 404 || d.status === 405) ctx.skip(`tompa offers no deregister for UEs (${brief(d)}): cannot make UE2 unreachable`);
    if (d.status !== 200) ctx.fail(`tompa deregister: ${brief(d)} ${oneLine(d.body || d.text)}`);
    deregistered = true;
    ctx.ok(`UE2 ${d.body.state}; SMSF Deactivate answered ${d.body.smsf ? d.body.smsf.status : 'nothing (SMS was not active)'}`);
    const regs = await ctx.get('/t/hetoteam/registrations');
    if (regs.body && regs.body.registrations && regs.body.registrations[UE2.supi]) {
      ctx.peer('krilju/hetoteam', `DELETE ue-contexts/${UE2.supi} at the SMSF (via tompa deregister)`, 'UDM drops the smsf-3gpp-access registration', 'registration still present in GET /t/hetoteam/registrations');
      ctx.fail('UDM still holds the SMSF registration of UE2 after deregistration');
    }
    ctx.ok('UDM: no SMSF registration for UE2 any more');

    const text = `demo ${ctx.runId} store-and-forward to UE2`;
    ctx.say(`generator: POST /t/holminator/api/mt?wait=1 {to: ${UE2.msisdn}, text: "${text}"}`);
    const r = await ctx.must('POST', smsc('/api/mt?wait=1'), { to: UE2.msisdn, text }, [200], 'SMSC /api/mt');
    const id = r.body.messageId;
    ctx.expect('mt_originated'); ctx.expect('mt_srr_requested');
    if (r.body.result !== 'WAITING') ctx.fail(`MT ${id} ended ${r.body.result}, expected WAITING (absent subscriber): ${oneLine(r.body.message && r.body.message.history.slice(-3), 400)}`);
    const sri = (r.body.message.history || []).filter(h => h.event === 'SRI-for-SM').pop();
    ctx.ok(`MT ${id} WAITING: SRI-for-SM ${sri ? sri.detail : '(not in history)'}`);
    ctx.expect('mt_absent');
    const mwd = await ctx.get('/t/hetoteam/registrations');
    const w = mwd.body && mwd.body.mwd && mwd.body.mwd[UE2.supi];
    if (!w || !(w.scAddresses || []).includes(SC_ADDRESS)) {
      ctx.peer('hetoteam', `SRI-for-SM for ${UE2.msisdn} while not registered`, `MWD for ${UE2.supi} with scAddress ${SC_ADDRESS}`, oneLine(w || 'no MWD entry'));
      ctx.fail('UDM holds no Message Waiting Data for UE2 with our SC address');
    }
    ctx.ok(`UDM MWD for ${UE2.supi}: scAddresses=${w.scAddresses.join(',')} mnrf=${w.mnrf}`);

    ctx.say(`UE2 attaches again: POST /t/tompa/ue/${UE2.supi}/register`);
    const reg = await ctx.must('POST', amf(`/ue/${UE2.supi}/register`), {}, [200], 'tompa register UE2');
    deregistered = false;
    if (!reg.body.smsActive) ctx.fail(`UE2 registered but SMS not active: ${oneLine(reg.body.smsf)}`);
    ctx.ok(`UE2 REGISTERED, SMSF Activate ${reg.body.smsf.status} -> SMSF registers in UDM -> UDM alerts the SMSC`);

    const t0 = Date.now();
    const done = await ctx.poll(async () => { const m = await getMessage(ctx, id); return m && ['DELIVERED', 'FAILED', 'EXPIRED'].includes(m.status) ? m : null; }, { timeoutMs, everyMs: 1000 });
    if (!done) {
      const m = await getMessage(ctx, id);
      const mwd2 = await ctx.get('/t/hetoteam/registrations');
      ctx.peer('hetoteam', `UE2 re-registered (SMSF PUT uecm) with MWD for ${SC_ADDRESS}`, 'POST /smsc/alert-service-centre to the SMSC within a few seconds',
        `MT still ${m && m.status} after ${ctx.opts.timeoutS} s; UDM mwd now ${oneLine((mwd2.body && mwd2.body.mwd && mwd2.body.mwd[UE2.supi]) || 'none')}`);
      ctx.fail(`MT ${id} not delivered within ${ctx.opts.timeoutS} s after re-registration`);
    }
    if (done.status !== 'DELIVERED') ctx.fail(`MT ${id} ended ${done.status}: ${oneLine(done.history.slice(-3), 400)}`);
    // m.viaAlert is only a transient flag for the next attempt; the history is the record.
    const alert = alertBeforeDelivery(done);
    ctx.ok(`MT ${id} DELIVERED ${Math.round((Date.now() - t0) / 100) / 10} s after re-registration, attempts ${done.attempts}`);
    if (!alert) {
      ctx.peer('hetoteam', `UE2 re-registered (SMSF PUT uecm) with MWD for ${SC_ADDRESS}`, 'POST /smsc/alert-service-centre before redelivery', 'no ALERT in the SMSC history; the retry timer delivered it');
      ctx.fail('delivered by the retry timer, not by Alert-Service-Centre');
    }
    ctx.ok(`UDM alerted the SMSC: ${alert.detail} (${alert.ts}); redelivered on that alert`);
    ctx.expect('alerts_received');
    ctx.expect('mt_delivered');
    const final = (await ctx.poll(async () => { const x = await getMessage(ctx, id); return x && x.statusReport ? x : null; }, { timeoutMs: 5000 })) || done;
    if (!final.statusReport || final.statusReport.tpSt !== '0x00') ctx.fail(`MT ${id}: status report ${oneLine(final.statusReport)}, expected TP-ST 0x00`);
    ctx.ok(`status report to the originating SME (simulated): TP-ST ${final.statusReport.tpSt}`);
    ctx.expect('mt_status_reports_simulated');
    const hit = await ctx.poll(async () => inboxHit((await getUe(ctx, UE2.supi)).inbox, id), { timeoutMs: 5000 });
    if (!hit) ctx.fail(`UE2 inbox has no entry for ${id}`);
    ctx.ok(`UE2 inbox: ${hit.kind} "${hit.text}"`);
    printHistory(ctx, final, 'SMSC history');
    await printSequence(ctx, [final], [id, final.to]);
  } finally {
    if (deregistered) {
      const back = await ctx.call('POST', amf(`/ue/${UE2.supi}/register`), {});
      ctx.say(`cleanup: re-registered UE2 -> ${brief(back)} smsActive=${back.body && back.body.smsActive}`);
    }
  }
}

async function stepMetrics(ctx) {
  const now = await ctx.must('GET', smsc('/api/metrics'), undefined, [200], 'SMSC /api/metrics');
  const before = ctx.startMetrics;
  if (wasReset(before, now.body)) {
    ctx.warn(`SMSC metrics were reset during the run (since ${before.since} -> ${now.body.since}); deltas are not meaningful`);
  } else {
    const deltas = metricDeltas(before, now.body);
    const shown = Object.entries(deltas).filter(([k, v]) => v || ctx.expected[k] || METRIC_KEYS.includes(k));
    ctx.say(`SMSC metric deltas over the run (since ${before.since}; other teams' traffic can add to them):`);
    for (const [k, v] of shown) ctx.say(`   ${k.padEnd(40)} ${String(v >= 0 ? `+${v}` : v).padStart(5)}${ctx.expected[k] ? `   (demo expects >= +${ctx.expected[k]})` : ''}`);
    const bad = checkExpected(deltas, ctx.expected).filter(x => !x.ok);
    if (bad.length) ctx.fail(`metrics did not move as the demo's own traffic requires: ${bad.map(x => `${x.key} +${x.got} < +${x.min}`).join(', ')}`);
    if (Object.keys(ctx.expected).length) ctx.ok(`every metric moved at least as much as the demo's own traffic (${Object.keys(ctx.expected).length} checked)`);
  }
  // Consistency can be briefly off while a message is in flight; give it a few seconds.
  let checks = now.body.consistency || [];
  for (let i = 0; i < 6 && checks.some(c => !c.ok); i++) {
    await sleep(1000);
    checks = ((await ctx.get(smsc('/api/metrics'))).body || {}).consistency || [];
  }
  for (const c of checks) ctx.say(`   ${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(22)} ${c.detail}`);
  if (!checks.length) ctx.fail('no consistency checks in /api/metrics');
  const off = checks.filter(c => !c.ok);
  if (off.length) ctx.fail(`consistency checks failing: ${off.map(c => c.name).join(', ')}`);
  ctx.ok(`all ${checks.length} SMSC consistency checks ok`);
}

const STEPS = {
  network: { title: 'Network up: NRF lists AMF, SMSF, UDM and SMSC; every team answers /kpi', run: stepNetwork },
  attach: { title: 'Attach: UE1 and UE2 registered and SMS-active (AMF -> SMSF -> UDM)', run: stepAttach },
  mo: { title: 'MO SMS UE1 -> UE2 with TP-SRR, status report back to UE1', run: stepMo },
  mt: { title: 'MT SMS from the SMSC generator to UE2, simulated status report to the SME', run: stepMt },
  'store-and-forward': { title: 'Store-and-forward: UE2 absent -> WAITING + MWD, re-register -> alert -> DELIVERED', run: stepStoreAndForward },
  metrics: { title: 'Metrics: SMSC counter deltas over the run and consistency checks', run: stepMetrics },
};

// ---------- main ----------

function defaultBase() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const f = path.resolve(here, '../../.board-url');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { throw new Error('no --base given and the repo-root file .board-url is missing'); }
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) {
    console.log(`usage: node demo.mjs [--base <url>] [--step <${STEP_NAMES.join('|')}>[,...]] [--timeout <s>]`);
    return 0;
  }
  let base;
  try { base = normaliseBase(opts.base || defaultBase()); } catch (e) { console.error(e.message); return 2; }
  const call = makeClient(base);
  const ctx = makeCtx(call, opts);
  const names = opts.steps || STEP_NAMES;

  console.log(`5G Core Light - end-to-end demo by holminator (SMSC), run ${ctx.runId}, ${new Date().toISOString()}`);
  console.log(`base: ${opts.base ? '--base' : '.board-url'} (not shown); steps: ${names.join(', ')}`);
  const m0 = await call('GET', smsc('/api/metrics'));
  if (m0.status !== 200) { console.error(`cannot read the SMSC metrics: ${brief(m0)}`); return 1; }
  ctx.startMetrics = m0.body;

  const results = [];
  for (const [i, name] of names.entries()) {
    const s = STEPS[name];
    console.log(`\n[${i + 1}/${names.length}] ${name}: ${s.title}`);
    const t0 = Date.now();
    ctx.pending = {};
    let verdict = 'PASS', reason = '';
    try { await s.run(ctx); } catch (e) {
      if (e instanceof StepSkip) { verdict = 'SKIP'; reason = e.message; } else { verdict = 'FAIL'; reason = e instanceof StepError ? e.message : `${e.name}: ${e.message}`; }
    }
    // Metric expectations count only for the demo traffic that verifiably happened (PASS or the part before a FAIL).
    for (const [k, n] of Object.entries(ctx.pending)) ctx.expected[k] = (ctx.expected[k] || 0) + n;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  => ${verdict} ${name} (${secs} s)${reason ? `: ${redact(reason)}` : ''}`);
    results.push({ name, verdict, reason });
  }

  console.log('\nSummary');
  for (const r of results) console.log(`  ${r.verdict.padEnd(4)} ${r.name}${r.reason ? `  - ${redact(r.reason)}` : ''}`);
  if (ctx.peerNotes.length) {
    console.log('\nPeer notes (for #build: sent / expected / got)');
    for (const n of ctx.peerNotes) console.log(`  @${n.team}: sent ${n.sent}; expected ${n.expected}; got ${n.got}`);
  }
  const failed = results.filter(r => r.verdict === 'FAIL').length;
  console.log(failed ? `\n${failed} step(s) FAILED` : '\nDEMO PASSED');
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => process.exit(code), e => { console.error(redact(e.stack || e.message)); process.exit(1); });
}
