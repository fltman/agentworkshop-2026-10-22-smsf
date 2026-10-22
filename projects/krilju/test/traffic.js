// Steady MO and MT traffic against the deployed core.  Run: node projects/krilju/test/traffic.js [seconds-between-messages]
// MO comes from tompa's UE sim (/ue/{supi}/sms), MT from holminator's generator (/api/mt).
// Stop with Ctrl-C or by creating the file /tmp/krilju-traffic.stop. Never toggles reachability, so other teams' tests are not disturbed.
const fs = require('node:fs');
const BASE = process.env.CORE_URL || 'https://smsf.torget.bjarby.com/t';
const EVERY = (Number(process.argv[2]) || 20) * 1000;
const UES = [1, 2]; // happy subscribers (UDM test set)
const supi = n => `imsi-00101000000000${n}`;
const msisdn = n => `msisdn-4670000000${n}`;
const stats = { MO: { ok: 0, fail: 0 }, MT: { ok: 0, fail: 0 } };

async function post(path, body) {
  try {
    const r = await fetch(`${BASE}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: { error: e.message } }; }
}

// A UE that lost its registration (AMF sim restart) answers 409: register it again and retry once.
async function moSms(n, to, text) {
  let r = await post(`tompa/ue/${supi(n)}/sms`, { to, text });
  if (r.status === 409) { await ensureRegistered(n); r = await post(`tompa/ue/${supi(n)}/sms`, { to, text }); }
  return r;
}

async function ensureRegistered(n) {
  const r = await post(`tompa/ue/${supi(n)}/register`, {});
  return r.status === 200 && r.body && r.body.smsActive;
}

// Non-happy cases, one every fifth step. They only use test subscribers and never toggle reachability.
const errors = [
  { name: 'MO barred (UE5)', run: () => moSms(5, msisdn(2), 'barred'),
    pass: r => r.body && r.body.delivered === false && r.body.smsf && r.body.smsf.status === 403 },
  { name: 'register not allowed (UE3)', run: () => post(`tompa/ue/${supi(3)}/register`, {}),
    pass: r => r.body && r.body.smsActive === false && r.body.smsf && r.body.smsf.status === 403 },
  { name: 'register unknown SUPI', run: () => post('tompa/ue/imsi-001019999999999/register', {}),
    pass: r => r.body && r.body.smsActive === false && r.body.smsf && r.body.smsf.status === 404 },
  { name: 'MT to barred UE4', run: () => post('holminator/api/mt?wait=1', { to: '46700000004', text: 'mt barred' }),
    pass: r => r.status < 500 && r.status !== 0 && !/DELIVERED/.test(JSON.stringify(r.body)) },
];
const errStats = Object.fromEntries(errors.map(e => [e.name, { pass: 0, fail: 0 }]));

async function errorStep(i) {
  const c = errors[Math.floor(i / 5) % errors.length];
  const r = await c.run();
  const ok = !!c.pass(r);
  errStats[c.name][ok ? 'pass' : 'fail']++;
  console.log(`${new Date().toTimeString().slice(0, 8)} ERR ${c.name} ${ok ? 'as expected' : 'UNEXPECTED'} http ${r.status} ${ok ? '' : JSON.stringify(r.body).slice(0, 200)}`);
}

async function step(i) {
  if (i % 5 === 4) return errorStep(i);
  const from = UES[i % UES.length], to = UES[(i + 1) % UES.length], text = `krilju traffic #${i}`;
  let kind, r;
  if (i % 3 === 2) { // every third message is an MT from the SMSC generator
    kind = 'MT';
    r = await post('holminator/api/mt?wait=1', { to: `4670000000${to}`, text });
  } else {
    kind = 'MO';
    r = await moSms(from, msisdn(to), text);
  }
  const ok = r.status >= 200 && r.status < 300 && (kind === 'MT' || !r.body || r.body.delivered !== false);
  stats[kind][ok ? 'ok' : 'fail']++;
  console.log(`${new Date().toTimeString().slice(0, 8)} ${kind} #${i} ${ok ? 'ok' : 'FAIL'} http ${r.status} | MO ${stats.MO.ok}/${stats.MO.ok + stats.MO.fail} MT ${stats.MT.ok}/${stats.MT.ok + stats.MT.fail}`);
}

(async () => {
  for (const n of [...UES, 5]) await ensureRegistered(n);
  for (let i = 0; !fs.existsSync('/tmp/krilju-traffic.stop'); i++) {
    await step(i).catch(e => console.log('step error', e.message));
    await new Promise(r => setTimeout(r, EVERY));
  }
  console.log('stopped', JSON.stringify({ ...stats, errors: errStats }));
})();
