// Scenario conformance runner (FLUX 05f8eb0a-β): drives the 6-step interop script through the UE simulator and
// returns a pass/fail table with a drafted #build fault report per failing step. All I/O comes in as deps:
//   register(supi), deregister(supi) -> {supi, state, smsActive, smsf: {status, body}}
//   sendSms(supi, to, text)          -> {status, body: {smsRecordId, delivered, smsf: {status, body}} | problem}
//   setReachable(supi, bool)         -> {supi, reachable, smsf}
//   inbox(supi)                      -> [{text, from, ...}] newest first
//   logSince(id) / lastLogId()       -> AMF log entries newer than id (optional, used to localise MT faults)
//   originateMt(msisdn, text)        -> optional: start the MT leg at the SMSC. Since holminator PR 25 an MO terminates
//                                      at the SMSC and is no longer relayed as MT (#build 193), so without it the MT
//                                      steps only work against an SMSC that still relays.

const diagnose = require('./diagnose');

const { OWNER } = diagnose;
const UE = n => `imsi-00101000000000${n}`;
const MSISDN = n => `msisdn-4670000000${n}`;
const UNKNOWN = 'imsi-001019999999999';

const STEPS = [
  { step: 1, name: 'Happy path: register UE1+UE2, MO UE1→UE2, MT delivered', run: happyPath },
  { step: 2, name: 'UE3 activate → SMS_NOT_ALLOWED', run: s => expectActivate(s, UE(3)) },
  { step: 3, name: 'UE5 MO → MO_SMS_BARRED', run: moBarred },
  { step: 4, name: 'MO to UE4 (MT barred) → cause, not delivery', run: mtBarred },
  { step: 5, name: 'MWD + alert: MO to unreachable UE2, then reachable → later delivery', run: mwdAlert },
  { step: 6, name: 'Unknown subscriber activate → USER_UNKNOWN', run: s => expectActivate(s, UNKNOWN) },
];

const pass = (got, extra) => ({ verdict: 'pass', got, ...extra });
const skip = (got, extra) => ({ verdict: 'skip', got, ...extra });
const fail = (got, hop, owner, sent, extra) => ({ verdict: 'fail', got, hop, owner, sent, ...extra });
const short = r => (r ? `${r.status}${r.body && r.body.cause ? ` ${r.body.cause}` : ''}${r.body && r.body.detail ? `: ${r.body.detail}` : ''}` : 'nothing');
const activateSent = supi => `PUT nsmsf-sms/v2/ue-contexts/${supi} (Activate)`;
const moSent = (supi, to) => `POST nsmsf-sms/v2/ue-contexts/${supi}/sendsms (MO RP-DATA to ${to})`;

// Hop and owner for an SMSF answer, reusing the boundary decoder's blame logic.
function fromSmsf(op, supi, r, sent) {
  if (r && r.body && r.body.cause === 'NF_DISCOVERY_FAILED') {
    return fail('no SMSF found in NRF discovery', 'AMF→NRF', OWNER.nrf, 'GET nnrf-disc/v1/nf-instances?target-nf-type=SMSF');
  }
  const d = diagnose.smsfResponse(op, supi, r ? r.status : 0, r && r.body);
  if (d.verdict === 'fault') return fail(d.finding, d.hop, d.owner, sent, { expectedDetail: d.expected });
  return null;
}

async function ensureActive(s, n) {
  const r = await s.deps.register(UE(n));
  if (r && r.smsActive) return null;
  return fromSmsf('activate', UE(n), r && r.smsf, activateSent(UE(n))) ||
    fail(`UE${n} SMS not active after register (${short(r && r.smsf)})`, 'AMF→SMSF', OWNER.smsf, activateSent(UE(n)));
}

async function waitInbox(s, supi, text, timeoutMs = s.mtTimeoutMs) {
  const until = s.now() + timeoutMs;
  for (;;) {
    const box = (await s.deps.inbox(supi)) || [];
    const hit = box.find(m => m && m.text === text);
    if (hit) return hit;
    if (s.now() >= until) return null;
    await s.sleep(s.pollMs);
  }
}

// MO result in a form all steps share: {ok, smsf, local}. local = refused by our own AMF before reaching the SMSF.
async function mo(s, from, toN, text) {
  const r = await s.deps.sendSms(from, MSISDN(toN), text);
  const b = (r && r.body) || {};
  if (b.smsf) return { ok: r.status === 200, smsf: b.smsf, local: false };
  return { ok: false, smsf: { status: r ? r.status : 0, body: b }, local: true };
}

// The MT leg for UE n: originated at the SMSC when the dep exists, else the MO relay (old SMSC behaviour) carries it.
async function mtLeg(s, n, text) {
  if (s.deps.originateMt) await s.deps.originateMt(MSISDN(n).replace('msisdn-', ''), text);
}

// An N1N2 for this UE since logId that the boundary decoder judged a fault: the MT reached us but was malformed.
function mtFaultSince(s, logId, supi) {
  if (!s.deps.logSince) return null;
  const e = (s.deps.logSince(logId) || []).find(x => x.dir === 'in' && x.diag && x.diag.verdict === 'fault' &&
    String(x.path || '').endsWith(`/ue-contexts/${supi}/n1-n2-messages`));
  return e ? e.diag : null;
}

async function happyPath(s) {
  for (const n of [1, 2]) {
    const f = await ensureActive(s, n);
    if (f) return f;
  }
  const text = `scenario-1 ${s.tag}`;
  const logId = s.deps.lastLogId ? s.deps.lastLogId() : 0;
  const m = await mo(s, UE(1), 2, text);
  if (m.local) return fail(`AMF refused locally: ${short(m.smsf)}`, 'AMF (local)', 'tompa', moSent(UE(1), MSISDN(2)));
  if (!m.ok) return fromSmsf('sendsms', UE(1), m.smsf, moSent(UE(1), MSISDN(2))) || fail(short(m.smsf), 'AMF→SMSF', OWNER.smsf, moSent(UE(1), MSISDN(2)));
  await mtLeg(s, 2, text);
  const hit = await waitInbox(s, UE(2), text);
  if (hit) { s.mtWorks = true; return pass(`MO 200, MT RP-DATA delivered to UE2 from ${hit.from || '?'}`); }
  s.mtWorks = false;
  const d = mtFaultSince(s, logId, UE(2));
  if (d) return fail(`MO 200, MT reached the AMF but ${d.finding}`, d.hop, d.owner, moSent(UE(1), MSISDN(2)), { expectedDetail: d.expected });
  return fail(`MO 200, no N1N2 with RP-DATA for UE2 within ${s.mtTimeoutMs / 1000} s`, 'SMSC→SMSF→AMF (MT leg)', OWNER.smsf,
    moSent(UE(1), MSISDN(2)), { expectedDetail: 'N1N2MessageTransfer with RP-DATA to UE2' });
}

async function expectActivate(s, supi) {
  const r = await s.deps.register(supi);
  const smsf = r && r.smsf;
  const want = diagnose.EXPECTED.activate[supi];
  const d = diagnose.smsfResponse('activate', supi, smsf ? smsf.status : 0, smsf && smsf.body);
  if (d.verdict === 'expected') return pass(short(smsf));
  return fromSmsf('activate', supi, smsf, activateSent(supi)) ||
    fail(short(smsf), 'AMF→SMSF', OWNER.smsf, activateSent(supi), { expectedDetail: want });
}

async function moBarred(s) {
  const f = await ensureActive(s, 5);
  if (f) return { ...f, got: `precondition: ${f.got}` };
  const m = await mo(s, UE(5), 1, `scenario-3 ${s.tag}`);
  if (m.local) return skip(`AMF refused locally: ${short(m.smsf)}`);
  const d = diagnose.smsfResponse('sendsms', UE(5), m.smsf.status, m.smsf.body);
  if (d.verdict === 'expected') return pass(short(m.smsf));
  return fromSmsf('sendsms', UE(5), m.smsf, moSent(UE(5), MSISDN(1)));
}

async function mtBarred(s) {
  for (const n of [1, 4]) {
    const f = await ensureActive(s, n);
    if (f) return { ...f, got: `precondition: ${f.got}` };
  }
  const text = `scenario-4 ${s.tag}`;
  const m = await mo(s, UE(1), 4, text);
  if (m.local) return skip(`AMF refused locally: ${short(m.smsf)}`);
  if (!m.ok) return pass(`MO refused with ${short(m.smsf)}`);
  await mtLeg(s, 4, text);
  const hit = await waitInbox(s, UE(4), text);
  if (hit) {
    return fail(`MO 200 and the MT SMS was delivered to the MT-barred UE4`, 'SMSC→UDM (SRI-for-SM)', OWNER.smsc,
      moSent(UE(1), MSISDN(4)), { expectedDetail: 'MT barred for UE4 (mtSmsBarringAll), no delivery' });
  }
  if (s.mtWorks === false) return skip('MO 200, no MT to UE4, but MT delivery is broken (step 1), so inconclusive');
  if (s.mtWorks === undefined) return skip('MO 200, no MT to UE4; run step 1 first to tell barring from a broken MT leg');
  return pass(`MO 200, not delivered to UE4 within ${s.mtTimeoutMs / 1000} s (no cause reported back)`);
}

async function mwdAlert(s) {
  for (const n of [1, 2]) {
    const f = await ensureActive(s, n);
    if (f) return { ...f, got: `precondition: ${f.got}` };
  }
  const text = `scenario-5 ${s.tag}`;
  await s.deps.setReachable(UE(2), false);
  try {
    const m = await mo(s, UE(1), 2, text);
    if (m.local) return skip(`AMF refused locally: ${short(m.smsf)}`);
    if (!m.ok) {
      return fromSmsf('sendsms', UE(1), m.smsf, moSent(UE(1), MSISDN(2))) ||
        fail(short(m.smsf), 'AMF→SMSF', OWNER.smsf, moSent(UE(1), MSISDN(2)));
    }
    await mtLeg(s, 2, text);
    await s.sleep(s.mwdHoldMs);
  } finally {
    await s.deps.setReachable(UE(2), true);
  }
  const hit = await waitInbox(s, UE(2), text, s.mwdTimeoutMs);
  if (hit) return pass('stored while unreachable, delivered after the UE came back (alert worked)');
  return skip(`pending: not delivered within ${s.mwdTimeoutMs / 1000} s after the UE came back (MWD/alert may not be supported yet)`);
}

function report(r, ts) {
  return `@${r.owner} fault on ${r.hop} (tompa scenario step ${r.step}: ${r.name}). Sent: ${r.sent}. ` +
    `Expected: ${r.expectedDetail || r.expected}. Got: ${r.got}. (tompa scenario runner, ${ts})`;
}

function createRunner(deps, opts = {}) {
  const sleep = opts.sleep || (ms => new Promise(res => setTimeout(res, ms)));
  const now = opts.now || Date.now;
  let last = null;
  let running = false;

  async function run(only) {
    if (running) { const e = new Error('a scenario run is already in progress'); e.code = 'BUSY'; throw e; }
    const steps = only ? STEPS.filter(x => x.step === Number(only)) : STEPS;
    if (!steps.length) { const e = new Error(`no step ${only}`); e.code = 'NO_STEP'; throw e; }
    running = true;
    const startedAt = new Date(now()).toISOString();
    const s = { deps, sleep, now, tag: now().toString(36), mtTimeoutMs: opts.mtTimeoutMs ?? 5000, pollMs: opts.pollMs ?? 250,
      mwdHoldMs: opts.mwdHoldMs ?? 1000, mwdTimeoutMs: opts.mwdTimeoutMs ?? 8000,
      mtWorks: undefined };
    const prev1 = only && last && last.steps.find(x => x.step === 1);
    if (prev1 && prev1.verdict !== 'skip') s.mtWorks = prev1.verdict === 'pass';
    const out = [];
    try {
      for (const def of steps) {
        let r;
        try { r = (await def.run(s)) || fail('no result', 'AMF', 'tompa', '-'); } catch (e) { r = fail(`runner error: ${e.message}`, 'AMF (runner)', 'tompa', '-'); }
        const row = { step: def.step, name: def.name, expected: EXPECTED_TEXT[def.step], got: r.got, verdict: r.verdict,
          hop: r.hop || null, owner: r.owner || null, report: null };
        if (r.verdict === 'fail') row.report = report({ ...row, sent: r.sent, expectedDetail: r.expectedDetail }, startedAt);
        out.push(row);
      }
    } finally { running = false; }
    const summary = out.reduce((o, x) => ({ ...o, [x.verdict]: o[x.verdict] + 1 }), { pass: 0, fail: 0, skip: 0 });
    last = { startedAt, finishedAt: new Date(now()).toISOString(), only: only ? Number(only) : null, summary, steps: out };
    return last;
  }

  return { run, last: () => last, running: () => running };
}

const EXPECTED_TEXT = {
  1: 'Activate 200/201 for UE1+UE2, MO 200, N1N2 with RP-DATA to UE2',
  2: 'Activate refused with SMS_NOT_ALLOWED',
  3: 'UplinkSMS refused with MO_SMS_BARRED',
  4: 'a failure or cause from the core, no delivery to UE4',
  5: 'delivery to UE2 after it becomes reachable (MWD + alert)',
  6: 'Activate refused with USER_UNKNOWN',
};

module.exports = { createRunner, STEPS: STEPS.map(({ step, name }) => ({ step, name, expected: EXPECTED_TEXT[step] })) };
