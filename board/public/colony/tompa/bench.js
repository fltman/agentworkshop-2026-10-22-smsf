// Test bench: one button per test case against the live core, verdict OK/NOK against the expected outcome.
// Cases take { tompa, smsc, sleep } so they can be unit-tested with fakes (projects/tompa/test/bench.test.js).
// All peer text is rendered with textContent, never innerHTML.

const UE = n => `imsi-00101000000000${n}`;
const MSISDN = n => `4670000000${n}`;
const UNKNOWN = 'imsi-001019999999999';
const tag = () => `bench ${Math.floor(Math.random() * 1e6)}`;

const ok = (detail, data) => ({ ok: true, detail, data });
const nok = (detail, data) => ({ ok: false, detail, data });

async function ensureReg(c, n) {
  const ue = (await c.tompa('GET', `/ue/${UE(n)}`)).body;
  if (ue && ue.state === 'REGISTERED' && ue.smsActive) return ue;
  return (await c.tompa('POST', `/ue/${UE(n)}/register`)).body;
}

async function waitInbox(c, n, text, ms = 10000) {
  for (let t = 0; t < ms; t += 500) {
    const inbox = (await c.tompa('GET', `/ue/${UE(n)}/inbox`)).body || [];
    if (inbox.some(m => m.text === text)) return true;
    await c.sleep(500);
  }
  return false;
}

async function waitMessage(c, id, want, ms) {
  let m = null;
  for (let t = 0; t < ms; t += 1000) {
    m = (await c.smsc('GET', `/api/messages/${id}`)).body;
    if (m && want.includes(m.status)) return m;
    await c.sleep(1000);
  }
  return m;
}

const smsfOf = r => (r && r.smsf) || {};
const causeOf = s => (s.body && (s.body.cause || s.body.result)) || '';
// SMSC ?wait=1 answers { result, messageId, message: { status, history } } (holminator CONTRACT 4).
const mtStatus = r => r && (r.result || (r.message && r.message.status) || r.status);

const CASES = [
  { id: 'reg_ok', group: 'REG', title: 'Register UE1', expect: 'SMS active, SMSF 200/201',
    async run(c) {
      await c.tompa('POST', `/ue/${UE(1)}/deregister`);
      const r = (await c.tompa('POST', `/ue/${UE(1)}/register`)).body;
      const s = smsfOf(r);
      return r && r.smsActive && [200, 201].includes(s.status) ? ok(`SMSF ${s.status}, SMS active`, r) : nok(`SMSF ${s.status} ${causeOf(s)}`, r);
    } },
  { id: 'reg_refused', group: 'REG', title: 'Register UE3 (not subscribed to SMS)', expect: 'SMSF 403 SMS_NOT_ALLOWED, UE still registered',
    async run(c) {
      const r = (await c.tompa('POST', `/ue/${UE(3)}/register`)).body;
      const s = smsfOf(r);
      return r && r.state === 'REGISTERED' && !r.smsActive && s.status === 403 ? ok(`SMSF 403 ${causeOf(s)}`, r) : nok(`SMSF ${s.status} ${causeOf(s)}, smsActive ${r && r.smsActive}`, r);
    } },
  { id: 'reg_unknown', group: 'REG', title: 'Register unknown IMSI', expect: 'SMSF 404 USER_UNKNOWN',
    async run(c) {
      const r = (await c.tompa('POST', `/ue/${UNKNOWN}/register`)).body;
      const s = smsfOf(r);
      return r && !r.smsActive && s.status === 404 ? ok(`SMSF 404 ${causeOf(s)}`, r) : nok(`SMSF ${s.status} ${causeOf(s)}`, r);
    } },
  { id: 'dereg', group: 'DEREG', title: 'Deregister UE1', expect: 'SMSF 204, UE deregistered',
    async run(c) {
      await ensureReg(c, 1);
      const r = (await c.tompa('POST', `/ue/${UE(1)}/deregister`)).body;
      const s = smsfOf(r);
      await c.tompa('POST', `/ue/${UE(1)}/register`); // leave UE1 registered for the other cases
      return r && r.state === 'DEREGISTERED' && s.status === 204 ? ok('SMSF 204', r) : nok(`state ${r && r.state}, SMSF ${s.status} ${causeOf(s)}`, r);
    } },
  { id: 'mo_ok', group: 'MO', title: 'MO SMS UE1 → UE2', expect: 'accepted by the SMSC (SMSF 200, RP-ACK)',
    // Since holminator PR 25 an MO terminates at the SMSC (#build 193): no MT to UE2, the MT cases cover the inbox.
    async run(c) {
      await ensureReg(c, 1);
      const r = await c.tompa('POST', `/ue/${UE(1)}/sms`, { to: `msisdn-${MSISDN(2)}`, text: tag() });
      const s = smsfOf(r.body);
      return r.status === 200 && s.status === 200 ? ok('SMSF 200, accepted by the SMSC', r.body) : nok(`MO ${r.status}, SMSF ${s.status} ${causeOf(s)}`, r.body);
    } },
  { id: 'mo_barred', group: 'MO', title: 'MO SMS from UE5 (MO-barred)', expect: 'refused, SMSF 403 MO_SMS_BARRED',
    async run(c) {
      const reg = await ensureReg(c, 5);
      if (!reg || !reg.smsActive) return nok(`UE5 SMS not active (SMSF ${smsfOf(reg).status})`, reg);
      const r = await c.tompa('POST', `/ue/${UE(5)}/sms`, { to: `msisdn-${MSISDN(2)}`, text: tag() });
      const s = smsfOf(r.body);
      return r.status !== 200 && s.status === 403 ? ok(`SMSF 403 ${causeOf(s)}`, r.body) : nok(`MO ${r.status}, SMSF ${s.status} ${causeOf(s)}`, r.body);
    } },
  { id: 'mt_ok', group: 'MT', title: 'MT SMS SC → UE2 (via SMSC)', expect: 'DELIVERED, text in UE2 inbox',
    async run(c) {
      await ensureReg(c, 2);
      await c.tompa('POST', `/ue/${UE(2)}/reachable`, { reachable: true });
      const text = tag();
      const r = (await c.smsc('POST', '/api/mt?wait=1', { to: MSISDN(2), text })).body;
      const st = mtStatus(r);
      if (st !== 'DELIVERED') return nok(`SMSC status ${st}`, r);
      return (await waitInbox(c, 2, text, 3000)) ? ok(`DELIVERED: "${text}"`, r) : nok('SMSC says DELIVERED, not in UE2 inbox', r);
    } },
  { id: 'mt_barred', group: 'MT', title: 'MT SMS SC → UE4 (MT-barred)', expect: 'FAILED (CALL_BARRED)',
    async run(c) {
      const r = (await c.smsc('POST', '/api/mt?wait=1', { to: MSISDN(4), text: tag() })).body;
      return mtStatus(r) === 'FAILED' ? ok('FAILED as expected', r) : nok(`SMSC status ${mtStatus(r)}`, r);
    } },
  { id: 'mt_unreachable', group: 'MT', title: 'MT SMS to unreachable UE2, then reachable', expect: 'WAITING, then DELIVERED via the alert',
    async run(c) {
      await ensureReg(c, 2);
      await c.tompa('POST', `/ue/${UE(2)}/reachable`, { reachable: false });
      try {
        const text = tag();
        const a = (await c.smsc('POST', '/api/mt', { to: MSISDN(2), text })).body;
        if (!a || !a.messageId) return nok('SMSC gave no messageId', a);
        const w = await waitMessage(c, a.messageId, ['WAITING', 'FAILED', 'DELIVERED'], 15000);
        if (!w || w.status !== 'WAITING') return nok(`expected WAITING, got ${w && w.status}`, w);
        await c.tompa('POST', `/ue/${UE(2)}/reachable`, { reachable: true });
        const d = await waitMessage(c, a.messageId, ['DELIVERED', 'FAILED'], 20000);
        return d && d.status === 'DELIVERED' ? ok('WAITING → DELIVERED after the alert', d) : nok(`after reachable: ${d && d.status}`, d);
      } finally {
        await c.tompa('POST', `/ue/${UE(2)}/reachable`, { reachable: true });
      }
    } },
];

async function runCase(cs, c) {
  const t0 = Date.now();
  try {
    return { ...(await cs.run(c)), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, detail: `error: ${e.message}`, ms: Date.now() - t0 };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { CASES, runCase };

if (typeof document !== 'undefined') {
  const call = prefix => async (method, path, body) => {
    const r = await fetch(`${prefix}${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, body: j };
  };
  const ctx = { tompa: call('/t/tompa'), smsc: call('/t/holminator'), sleep: ms => new Promise(r => setTimeout(r, ms)) };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const grid = document.getElementById('cases');
  const cards = {};
  let busy = false;

  for (const cs of CASES) {
    const card = el('div', 'card');
    const head = el('div', 'head');
    head.append(el('span', `grp ${cs.group.toLowerCase()}`, cs.group), el('span', 'title', cs.title));
    const badge = el('span', 'badge idle', '—');
    const btn = el('button', null, 'Run');
    const detail = el('div', 'detail', `expect: ${cs.expect}`);
    const raw = el('pre', 'raw');
    detail.onclick = () => raw.classList.toggle('open');
    head.append(badge, btn);
    card.append(head, detail, raw);
    grid.append(card);
    cards[cs.id] = { badge, btn, detail, raw };
    btn.onclick = () => runOne(cs);
  }

  async function runOne(cs) {
    const v = cards[cs.id];
    v.btn.disabled = true;
    v.badge.className = 'badge run'; v.badge.textContent = '…';
    const r = await runCase(cs, ctx);
    v.badge.className = `badge ${r.ok ? 'ok' : 'nok'}`;
    v.badge.textContent = r.ok ? 'OK' : 'NOK';
    v.detail.textContent = `${r.detail} · ${(r.ms / 1000).toFixed(1)} s · expect: ${cs.expect}`;
    v.raw.textContent = JSON.stringify(r.data ?? null, null, 2);
    v.btn.disabled = false;
    return r;
  }

  document.getElementById('all').onclick = async () => {
    if (busy) return;
    busy = true;
    const sum = document.getElementById('sum');
    let pass = 0;
    for (const cs of CASES) { sum.textContent = `running ${cs.title}…`; if ((await runOne(cs)).ok) pass++; }
    sum.textContent = `${pass}/${CASES.length} OK`;
    sum.className = pass === CASES.length ? 'ok' : 'nok';
    busy = false;
  };
}
