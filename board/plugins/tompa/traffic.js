// Continuous MO SMS traffic generator over the UE simulator (team tompa). Drives the AMF's own handlers in-process,
// so every message goes UE → AMF → SMSF → SMSC → … on the live peers. Rate and duration are capped.
'use strict';

const MAX_RATE = 5;          // msg/s
const MAX_DURATION_S = 300;  // auto-stop
const MAX_IN_FLIGHT = 20;    // skip ticks rather than pile up on a slow core
const WINDOW_S = 60;
const LAT_SAMPLES = 500;

const UE1 = 'imsi-001010000000001', UE2 = 'imsi-001010000000002', UE5 = 'imsi-001010000000005';
const MSISDN = { [UE1]: '46700000001', [UE2]: '46700000002', [UE5]: '46700000005' };
const UE4_MSISDN = '46700000004';
const SENDERS = [UE1, UE2, UE5];

// ~90 % happy path UE1↔UE2, ~5 % MO from MO-barred UE5, ~5 % to MT-barred UE4.
function pick(rnd) {
  const x = rnd();
  if (x < 0.05) return { kind: 'mo-barred', from: UE5, to: MSISDN[UE1], expect: 'MO_SMS_BARRED' };
  if (x < 0.10) return { kind: 'mt-barred', from: UE1, to: UE4_MSISDN, expect: 'BARRED' };
  return x < 0.55 ? { kind: 'happy', from: UE1, to: MSISDN[UE2] } : { kind: 'happy', from: UE2, to: MSISDN[UE1] };
}

const causeOf = r => {
  const s = r && r.body && r.body.smsf;
  const b = (s && s.body) || (r && r.body) || {};
  return b.cause || b.result || (r && r.status ? `HTTP_${r.status}` : 'NO_ANSWER');
};

// verdict: ok (delivered as intended), expected (the core refused as the subscriber data says), failed (anything else)
function classify(p, r) {
  const ok = r && r.status === 200;
  if (p.kind === 'happy') return ok ? 'ok' : 'failed';
  if (p.kind === 'mt-barred') return ok || /BARRED/i.test(causeOf(r)) ? 'expected' : 'failed'; // MT barring may only bite on delivery
  return !ok && causeOf(r) === p.expect ? 'expected' : 'failed';
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function createGenerator({ sendSms, ensureRegistered, now = Date.now, rnd = Math.random, setTimer = setInterval, clearTimer = clearInterval }) {
  let st = null;
  const empty = () => ({ sent: 0, ok: 0, expected: 0, failed: 0, skipped: 0 });

  function bucket(t) {
    const sec = Math.floor(t / 1000);
    let b = st.window[st.window.length - 1];
    if (!b || b.t !== sec) { b = { t: sec, ...empty() }; st.window.push(b); }
    while (st.window.length && st.window[0].t <= sec - WINDOW_S) st.window.shift();
    return b;
  }

  async function fire() {
    if (!st || !st.running) return;
    if (now() >= st.stopsAt) return stop('auto-stop');
    if (st.inFlight >= MAX_IN_FLIGHT) { st.totals.skipped++; bucket(now()).skipped++; return; }
    const p = pick(rnd);
    st.inFlight++; st.totals.sent++; bucket(now()).sent++;
    const t0 = now();
    let r;
    try { r = await sendSms(p.from, p.to, `load ${st.totals.sent}`); } catch (e) { r = { status: 0, body: { cause: e.message } }; }
    const ms = now() - t0;
    st.inFlight--;
    const v = classify(p, r);
    st.totals[v]++; bucket(now())[v]++;
    if (v !== 'ok' && !(r && r.status === 200)) { const c = `${p.kind}: ${causeOf(r)}`; st.causes[c] = (st.causes[c] || 0) + 1; }
    st.lat.push(ms); if (st.lat.length > LAT_SAMPLES) st.lat.shift();
  }

  async function start({ rate = 1, durationS = MAX_DURATION_S } = {}) {
    if (st && st.running) stop('restart');
    rate = Math.min(MAX_RATE, Math.max(0.1, Number(rate) || 1));
    durationS = Math.min(MAX_DURATION_S, Math.max(5, Number(durationS) || MAX_DURATION_S));
    const prep = {};
    for (const supi of SENDERS) {
      try { prep[supi] = await ensureRegistered(supi); } catch (e) { prep[supi] = { error: e.message }; }
    }
    const t = now();
    st = { running: true, rate, durationS, startedAt: t, stopsAt: t + durationS * 1000, stoppedBy: null,
      inFlight: 0, totals: empty(), causes: {}, lat: [], window: [], prep };
    st.timer = setTimer(() => { fire(); }, Math.round(1000 / rate));
    return stats();
  }

  function stop(reason = 'stopped') {
    if (!st || !st.running) return stats();
    st.running = false; st.stoppedBy = reason; st.stoppedAt = now();
    clearTimer(st.timer);
    return stats();
  }

  function stats() {
    if (!st) return { running: false, limits: { maxRate: MAX_RATE, maxDurationS: MAX_DURATION_S } };
    if (st.running && now() >= st.stopsAt) stop('auto-stop');
    const t = now();
    const sorted = [...st.lat].sort((a, b) => a - b);
    const recent = st.window.filter(b => b.t > Math.floor(t / 1000) - 10);
    const done = st.totals.ok + st.totals.expected + st.totals.failed;
    return {
      running: st.running, rate: st.rate, durationS: st.durationS, stoppedBy: st.stoppedBy,
      startedAt: new Date(st.startedAt).toISOString(), stopsAt: new Date(st.stopsAt).toISOString(),
      remainingS: st.running ? Math.max(0, Math.round((st.stopsAt - t) / 1000)) : 0,
      inFlight: st.inFlight,
      currentRate: Math.round((recent.reduce((s, b) => s + b.sent, 0) / 10) * 10) / 10,
      totals: st.totals,
      successPct: done ? Math.round(((st.totals.ok + st.totals.expected) / done) * 1000) / 10 : null,
      latencyMs: { avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
        p95: percentile(sorted, 0.95), max: sorted.length ? sorted[sorted.length - 1] : null },
      causes: st.causes, window: st.window, prep: st.prep,
      limits: { maxRate: MAX_RATE, maxDurationS: MAX_DURATION_S, maxInFlight: MAX_IN_FLIGHT },
    };
  }

  return { start, stop, stats, fire };
}

module.exports = { createGenerator, classify, pick, MAX_RATE, MAX_DURATION_S };
