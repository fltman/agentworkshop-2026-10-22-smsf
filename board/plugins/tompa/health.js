// End-to-end health of the five NFs (FLUX 5faaadcb). Pure functions; index.js does the I/O.
// α: every team's GET /status, cross-checked with the NRF's own instance list.
// β: canary = scenario step 1 (register UE1+UE2, MO UE1→UE2, MT delivered), rate-capped, skipped while warming.
'use strict';

const NFS = [
  { team: 'tompa', node: 'AMF' },
  { team: 'krilju', node: 'SMSF' },
  { team: 'hetoteam', node: 'UDM' },
  { team: 'holminator', node: 'SMSC' },
  { team: 'smsf-hao', node: 'NRF' },
];
const WARMUP_S = 60; // every merge restarts the board; a young NF is warming, not broken (spore frontend2-23)
const NRF_STALE_S = 90; // 3 heartbeats of 30 s

const age = (iso, now) => (iso ? Math.round((now - Date.parse(iso)) / 1000) : null);

// One NF: http status + body of its /status, and the NRF's instance list (or null when the NRF is unreachable).
function judgeNf(nf, http, body, nrfInstances, now = Date.now()) {
  const out = { team: nf.team, node: nf.node, verdict: 'up', evidence: [] };
  const sent = `GET /t/${nf.team}/status`;
  if (http !== 200 || !body || typeof body !== 'object') {
    out.verdict = 'down';
    out.evidence.push(`${sent} -> ${http || 'no answer'}`);
    return out;
  }
  const started = body.startedAt || body.started;
  const upS = typeof body.uptimeS === 'number' ? body.uptimeS : age(started, now);
  const warm = body.warmup && body.warmup.state;
  if ((warm && warm !== 'ready') || (upS !== null && upS < WARMUP_S)) {
    out.verdict = 'warming';
    out.evidence.push(warm && warm !== 'ready' ? `warmup ${warm}` : `up ${upS} s`);
  }
  if (nf.node === 'NRF') {
    out.evidence.push(`${(body.instances || []).length} instance(s) registered`);
    return out;
  }
  const says = body.nrf && typeof body.nrf === 'object' ? body.nrf.registered : body.registeredInNrf;
  const inst = nrfInstances && body.nfInstanceId && nrfInstances.find(i => i.nfInstanceId === body.nfInstanceId);
  const seen = inst ? age(inst.lastSeen, now) : null;
  out.inNrf = nrfInstances ? Boolean(inst && inst.nfStatus === 'REGISTERED' && (seen === null || seen <= NRF_STALE_S)) : null;
  if (says === false) out.evidence.push('says: not registered in NRF');
  if (nrfInstances && !inst) out.evidence.push('missing from the NRF instance list');
  else if (inst && seen !== null && seen > NRF_STALE_S) out.evidence.push(`NRF last saw it ${seen} s ago`);
  if (out.verdict === 'up' && (says === false || out.inNrf === false)) out.verdict = 'degraded';
  if (!out.evidence.length) out.evidence.push(`${sent} -> 200${inst ? `, NRF saw it ${seen} s ago` : ''}`);
  return out;
}

function summary(nfs, canary) {
  const bad = nfs.filter(n => n.verdict === 'down' || n.verdict === 'degraded');
  const warming = nfs.filter(n => n.verdict === 'warming');
  const chain = canary && canary.verdict;
  const verdict = bad.length || chain === 'fail' ? 'red' : warming.length || !chain || chain === 'skip' ? 'amber' : 'green';
  return { verdict, bad: bad.map(n => n.node), warming: warming.map(n => n.node), chain: chain || 'not run' };
}

// Canary result from a scenario run, reduced to step 1. Never blames a peer the scenario did not name.
function canaryFrom(run, now = Date.now()) {
  const s = run && run.steps && run.steps.find(x => x.step === 1);
  if (!s) return { verdict: 'skip', ts: new Date(now).toISOString(), got: 'scenario step 1 did not run' };
  return { verdict: s.verdict, ts: new Date(now).toISOString(), got: s.got, hop: s.hop || null, owner: s.owner || null, report: s.report || null };
}

module.exports = { NFS, WARMUP_S, NRF_STALE_S, judgeNf, summary, canaryFrom };
