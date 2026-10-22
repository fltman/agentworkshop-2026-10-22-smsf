#!/usr/bin/env node
// End to end through the whole group's 5G core, with assertions.
//
//   node projects/smsf-hao/app/demo.mjs            # boots the core itself if nothing is running
//   BASE=http://127.0.0.1:8787 node .../demo.mjs   # or runs against one that already is
//
// Exit code 0 only if every step passed, so this works as a check and not just a demo.

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const T = BASE + '/t';
const UE1 = 'imsi-001010000000001', UE2 = 'imsi-001010000000002';
const MSISDN1 = '46700000001', MSISDN2 = '46700000002';

const steps = [];
let failed = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function http(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a non-JSON body is reported as-is below */ }
  return { status: res.status, body: parsed, text };
}

// `check` returns the detail string on success and throws on failure, so a step reads as one line.
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, ok: true, detail: detail || '', ms: Date.now() - started });
  } catch (e) {
    failed++;
    steps.push({ name, ok: false, detail: e.message, ms: Date.now() - started });
  }
}

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

async function waitFor(what, fn, timeoutMs = 30000, everyMs = 500) {
  const until = Date.now() + timeoutMs;
  let last = 'never succeeded';
  for (;;) {
    try { const v = await fn(); if (v) return v; last = 'condition still false'; }
    catch (e) { last = e.message; }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}: ${last}`);
    await sleep(everyMs);
  }
}

async function ensureCore() {
  try {
    const h = await http('GET', BASE + '/health');
    if (h.status === 200) return 'already running';
  } catch { /* nothing listening, so boot one below */ }
  if (process.env.BASE) throw new Error(`nothing is answering on ${BASE}`);
  const core = await import('./core.js');
  process.env.CORE_QUIET = '1';
  core.default.boot();
  await waitFor('the core to listen', async () => (await http('GET', BASE + '/health')).status === 200);
  return 'booted in this process';
}

async function main() {
  console.log(`\n5G Core Light — end to end against ${BASE}\n`);

  await step('core is up', async () => await ensureCore());

  await step('all four network functions register with the NRF', async () => {
    const s = await waitFor('four registrations', async () => {
      const r = await http('GET', `${T}/smsf-hao/status`);
      const types = Object.keys(r.body?.byType || {});
      return types.length >= 4 ? types : null;
    });
    return s.sort().join(', ');
  });

  await step('NRF discovery answers for every target type', async () => {
    const want = { SMSF: 'krilju', UDM: 'hetoteam', AMF: 'tompa', CUSTOM_SMSC: 'holminator' };
    const found = [];
    for (const type of Object.keys(want)) {
      const r = await http('GET', `${T}/smsf-hao/nnrf-disc/v1/nf-instances?target-nf-type=${type}&requester-nf-type=SMSF`);
      expect(r.status === 200, `discovery for ${type} answered ${r.status}`);
      expect(Array.isArray(r.body?.nfInstances), `discovery for ${type} returned no nfInstances array`);
      expect(r.body.nfInstances.length > 0, `nobody is registered as ${type}`);
      const root = r.body.nfInstances[0].nfServices?.[0]?.apiRoot || r.body.nfInstances[0].apiRoot || '';
      // The apiRoot must be usable as-is. A doubled host here was a real fault once.
      expect(!/https?:\/\/[^/]+https?:\/\//.test(root), `${type} has a doubled host in its apiRoot: ${root}`);
      found.push(type);
    }
    return found.join(', ') + ' — every apiRoot well formed';
  });

  await step('both UEs attach through the AMF and activate SMS', async () => {
    for (const supi of [UE1, UE2]) {
      const r = await http('POST', `${T}/tompa/ue/${supi}/register`, {});
      expect(r.status === 200, `register ${supi} answered ${r.status}: ${r.text.slice(0, 120)}`);
      expect(r.body.smsActive === true, `${supi} attached but SMS is not active`);
    }
    return `${UE1} and ${UE2} registered, smsActive`;
  });

  await step('mobile originated: UE1 submits an SMS that reaches the SMSC', async () => {
    const r = await http('POST', `${T}/tompa/ue/${UE1}/sms`, { to: `msisdn-${MSISDN2}`, text: 'hello from the standalone core' });
    expect(r.status >= 200 && r.status < 300, `MO answered ${r.status}: ${r.text.slice(0, 160)}`);
    expect(r.body?.delivered !== false, `the SMSF rejected the MO: ${r.text.slice(0, 160)}`);
    const status = r.body?.smsf?.body?.deliveryStatus;
    expect(status === 'SMS_DELIVERY_SUCCESS', `expected SMS_DELIVERY_SUCCESS, got ${status}`);
    return `smsRecordId ${r.body.smsRecordId}, ${status}`;
  });

  await step('the SMSC recorded the MO as forwarded', async () => {
    // Since holminator's MO change an accepted MO terminates at the SMSC as FORWARDED; it no
    // longer produces an MT of its own. Asserting the new behaviour, not the old one.
    const r = await http('GET', `${T}/holminator/api/messages?limit=20`);
    expect(r.status === 200, `the SMSC answered ${r.status}`);
    const list = Array.isArray(r.body) ? r.body : r.body?.messages || [];
    const mo = list.filter(m => m.direction === 'MO').pop();
    expect(mo, 'the SMSC has no MO record');
    expect(['FORWARDED', 'ACCEPTED'].includes(mo.status), `MO ended as ${mo.status}`);
    return `${mo.id} ${mo.status}`;
  });

  await step('mobile terminated: the SMSC delivers to UE2 through SMSF and AMF', async () => {
    const r = await http('POST', `${T}/holminator/api/mt?wait=1`, { to: MSISDN2, text: 'mt through the whole chain' });
    expect(r.status >= 200 && r.status < 300, `MT answered ${r.status}: ${r.text.slice(0, 160)}`);
    expect(r.body?.result === 'DELIVERED', `expected DELIVERED, got ${r.body?.result}`);
    return `${r.body.messageId} ${r.body.result}`;
  });

  await step('the message is in UE2 inbox, decoded', async () => {
    const hit = await waitFor('the MT to appear in the inbox', async () => {
      const r = await http('GET', `${T}/tompa/ue/${UE2}/inbox`);
      const list = Array.isArray(r.body) ? r.body : [];
      return list.find(m => m.text === 'mt through the whole chain') || null;
    }, 10000);
    expect(hit.hex && hit.hex.length > 0, 'the inbox entry carries no TPDU');
    return `from ${hit.from}: "${hit.text}"`;
  });

  await step('an unroutable MT is held, not lost', async () => {
    const r = await http('POST', `${T}/holminator/api/mt?wait=1`, { to: '46700000999', text: 'nobody is home' });
    expect(r.status >= 200 && r.status < 300, `MT answered ${r.status}`);
    expect(r.body?.result !== 'DELIVERED', 'an unknown subscriber was reported as delivered');
    return `result ${r.body?.result} — store and forward kept it`;
  });

  await step('NRF KPIs report a complete, healthy core', async () => {
    const r = await http('GET', `${T}/smsf-hao/kpi`);
    expect(r.status === 200, `the KPI endpoint answered ${r.status}`);
    const k = r.body;
    expect(k.coreCompleteness.missing.length === 0, `missing from the core: ${k.coreCompleteness.missing.join(', ')}`);
    expect(!k.discovery.unservedTargets?.length, `discovery found nothing for: ${(k.discovery.unservedTargets || []).join(', ')}`);
    const err = k.reliability?.errorRatio;
    expect(!err, `the NRF answered ${k.reliability?.errors} errors out of ${k.reliability?.responses}`);
    return `${k.coreCompleteness.present.length}/${k.coreCompleteness.expected.length} present, ` +
           `${k.discovery.queries} discovery queries, hit ratio ${Math.round((k.discovery.hitRatio ?? 1) * 100)}%, ` +
           `p95 ${k.latencyMs?.p95 ?? 0} ms`;
  });

  // ---------- report ----------
  const width = Math.max(...steps.map(s => s.name.length));
  console.log('');
  for (const s of steps) {
    console.log(`  ${s.ok ? 'ok  ' : 'FAIL'}  ${s.name.padEnd(width)}  ${String(s.ms).padStart(5)} ms  ${s.detail}`);
  }
  const passed = steps.length - failed;
  console.log(`\n  ${passed}/${steps.length} steps passed\n`);
  if (failed) { console.log('  The core did NOT complete an end-to-end SMS.\n'); process.exit(1); }
  console.log('  MO and MT both completed across all five network functions.\n');
  process.exit(0);
}

main().catch(e => { console.error('\n  the run itself failed:', e.message, '\n'); process.exit(1); });
