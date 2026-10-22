// Group app: the whole 5G Core Light on one page. Reads every team's backend, edits nobody's folder.
'use strict';

const CHAIN = [
  { team: 'tompa', nf: 'AMF', role: 'UEs + AMF' },
  { team: 'krilju', nf: 'SMSF', role: 'SMS function' },
  { team: 'hetoteam', nf: 'UDM', role: 'subscribers' },
  { team: 'holminator', nf: 'SMSC', role: 'store and forward' },
  { team: 'smsf-hao', nf: 'NRF', role: 'discovery' },
];

const UES = [1, 2, 3, 4, 5].map((n) => ({ supi: `imsi-00101000000000${n}`, msisdn: `4670000000${n}`, label: `UE${n}` }));

function nodeClass(r) {
  if (!r || !r.up) return 'bad';
  if (r.nf !== 'NRF' && r.nrfRegistered === false) return 'warn';
  return r.errorPct > 10 ? 'warn' : 'ok';
}

function statusClass(status) {
  if (['DELIVERED', 'FORWARDED'].includes(status)) return 's-ok';
  if (['FAILED', 'EXPIRED', 'REJECTED'].includes(status)) return 's-bad';
  return 's-warn';
}

function recent(list, n = 12) {
  const arr = Array.isArray(list) ? list : (list && list.messages) || [];
  return [...arr].sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt))).slice(0, n);
}

// MO leg outcome from our /ue/{supi}/sms answer, MT leg outcome from the SMSC message.
function moStep(status, body) {
  if (status >= 200 && status < 300) return { cls: 's-ok', text: `MO accepted by SMSF (HTTP ${status})` };
  return { cls: 's-bad', text: `MO refused: HTTP ${status} ${body?.cause || body?.title || ''}`.trim() };
}

function mtStep(msg) {
  const status = msg?.message?.status || msg?.status || msg?.result || 'UNKNOWN';
  return { cls: statusClass(status), status, text: `MT via SMSC: ${status}` };
}

if (typeof module !== 'undefined') module.exports = { CHAIN, UES, nodeClass, statusClass, recent, moStep, mtStep };

// ---- browser ----
if (typeof document !== 'undefined' && document.getElementById('chain')) {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const fmt = (v, u = '') => (v == null ? '–' : v + u);
  const json = async (r) => { try { return await r.json(); } catch { return null; } };

  for (const sel of ['from', 'to']) for (const u of UES) $(sel).append(new Option(`${u.label} ${u.msisdn}`, u.supi));
  $('to').selectedIndex = 1;
  for (const c of CHAIN) { const a = el('a', null, `${c.nf} · ${c.team}`); a.href = `/colony/${c.team}/`; $('tiles').append(a); }

  async function refreshNodes() {
    const rows = await Promise.all(CHAIN.map((c) => loadOne(c.team)));
    const chain = $('chain'); chain.replaceChildren();
    rows.forEach((r, i) => {
      if (i) chain.append(el('span', 'arrow', i === CHAIN.length - 1 ? '⋯' : '→'));
      const a = el('a', `card node ${nodeClass(r)}`); a.href = `/colony/${CHAIN[i].team}/`;
      a.append(el('div', 'nf', CHAIN[i].nf), el('div', 'team', `${CHAIN[i].team} · ${CHAIN[i].role}`),
        el('div', 'meta', r.up ? `up · NRF ${r.nrfRegistered == null ? '–' : r.nrfRegistered ? 'yes' : 'no'} · ${fmt(r.requests)} req · ${fmt(r.errorPct, ' %')} err` : `down ${r.error || ''}`));
      chain.append(a);
    });
    const t = totals(rows);
    const card = (l, v, c) => { const d = el('div', 'kpi' + (c ? ' ' + c : '')); d.append(el('div', 'v', v), el('div', 'l', l)); return d; };
    $('totals').replaceChildren(card('NFs up', `${t.nfsUp}/${t.nfs}`, t.nfsUp === t.nfs ? 'ok' : 'bad'),
      card('Requests', t.requests), card('Errors', `${t.errors} (${fmt(t.errorPct, ' %')})`, t.errors ? 'warn' : 'ok'));
  }

  async function refreshMsgs() {
    try {
      const r = await fetch('/t/holminator/api/messages');
      const tb = $('msgs'); tb.replaceChildren();
      for (const m of recent(await json(r))) {
        const tr = el('tr');
        tr.append(el('td', 'meta', new Date(m.submittedAt).toLocaleTimeString()), el('td', null, m.direction), el('td', null, m.from),
          el('td', null, m.to), el('td', null, String(m.text || '').slice(0, 30)), el('td', statusClass(m.status), m.status));
        tb.append(tr);
      }
    } catch { /* SMSC down shows in the chain */ }
  }

  function step(s) { const li = el('li', s.cls, s.text); $('e2e-steps').append(li); return li; }

  $('send').onclick = async () => {
    $('send').disabled = true; $('e2e-steps').replaceChildren();
    const from = UES.find((u) => u.supi === $('from').value), to = UES.find((u) => u.supi === $('to').value);
    const text = $('text').value || 'hello';
    try {
      for (const u of [from, to]) {
        const r = await fetch(`/t/tompa/ue/${u.supi}/register`, { method: 'POST' });
        step({ cls: r.ok ? 's-ok' : 's-bad', text: `${u.label} registered: HTTP ${r.status}` });
      }
      const mo = await fetch(`/t/tompa/ue/${from.supi}/sms`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: `msisdn-${to.msisdn}`, text }) });
      step(moStep(mo.status, await json(mo)));
      const mt = await fetch('/t/holminator/api/mt?wait=1', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: to.msisdn, text }) });
      const s = mtStep(await json(mt));
      step(mt.ok ? s : { cls: 's-bad', text: `MT refused by SMSC: HTTP ${mt.status}` });
      if (s.status === 'DELIVERED') {
        const inbox = await json(await fetch(`/t/tompa/ue/${to.supi}/inbox`)) || [];
        const got = inbox.some((m) => m.text === text);
        step({ cls: got ? 's-ok' : 's-warn', text: got ? `${to.label} has it in its inbox` : `${to.label} inbox does not show it yet` });
      }
    } catch (e) { step({ cls: 's-bad', text: `error: ${e.message}` }); }
    $('send').disabled = false; refreshMsgs();
  };

  async function tick() { await Promise.all([refreshNodes(), refreshMsgs()]); $('ts').textContent = 'updated ' + new Date().toLocaleTimeString(); }
  tick(); setInterval(tick, 5000);
}
