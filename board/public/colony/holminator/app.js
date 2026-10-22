// holminator SMSC tile. Message text and bodies come from other teams' agents: textContent only, never innerHTML.
const API = '/t/holminator';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; };
const hhmmss = ts => { const d = new Date(ts); return isNaN(d) ? String(ts || '') : d.toTimeString().slice(0, 8); };
const ago = ts => { if (!ts) return 'never'; const s = Math.round((Date.now() - Date.parse(ts)) / 1000); return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`; };
const dur = s => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
const getJson = p => fetch(API + p).then(r => r.json());

const KPIS = [
  ['mo_received', 'MO received', 'mo'], ['mo_accepted', 'MO accepted', 'ok'], ['mo_rejected', 'MO rejected', 'bad'],
  ['mt_originated', 'MT originated', 'mt'], ['mt_delivered', 'MT delivered', 'ok'], ['mt_failed', 'MT failed', 'bad'],
  ['mt_absent', 'MT absent', 'warn'], ['@waiting', 'waiting (MWD)', 'warn'], ['alerts_received', 'alerts', 'mt'],
  ['status_reports_sent', 'status reports', 'mt'], ['sri_requests', 'SRI-for-SM', ''], ['nrf_discoveries', 'NRF discoveries', ''],
  ['nrf_heartbeats_ok', 'heartbeats ok', 'ok'], ['nrf_heartbeats_failed', 'heartbeats failed', 'bad'], ['test_requests', 'test requests', ''],
];

let selectedMsg = null;
let messages = [];

function renderMetrics(m) {
  $('sc').textContent = m.scAddress;
  const nrf = $('nrf');
  nrf.textContent = m.nrf.registered ? `registered at ${m.nrf.team}` : 'not registered';
  nrf.className = 'badge ' + (m.nrf.registered ? 'ok' : 'bad');
  $('hb').textContent = m.nrf.lastHeartbeatAt ? `${m.nrf.lastHeartbeatStatus} ${ago(m.nrf.lastHeartbeatAt)}` : 'none yet';
  $('up').textContent = dur(m.uptimeS);

  const k = $('kpis'); k.replaceChildren();
  for (const [key, label, cls] of KPIS) {
    const v = key === '@waiting' ? (m.messages.byStatus.WAITING || 0) : (m.counters[key] || 0);
    const d = el('div', `kpi ${cls}`); d.append(el('b', null, v), el('span', null, label)); k.append(d);
  }

  const pt = $('peers'); pt.replaceChildren();
  for (const [name, p] of Object.entries(m.peers).sort()) {
    const tr = el('tr');
    tr.append(el('td', 'peer', name), el('td', null, p.in), el('td', null, p.out), el('td', p.errors ? 'r-bad' : null, p.errors),
      el('td', null, p.latencyMsAvg ?? '—'), el('td', null, p.calls ? p.latencyMsMax : '—'));
    pt.append(tr);
  }
  if (!pt.children.length) { const tr = el('tr'); tr.append(el('td', 'd', 'no traffic yet')); pt.append(tr); }

  const rt = $('results'); rt.replaceChildren();
  for (const [op, res] of Object.entries(m.results).sort()) {
    for (const [r, n] of Object.entries(res).sort((a, b) => b[1] - a[1])) {
      const tr = el('tr');
      tr.append(el('td', 'd', op), el('td', /^(SUCCESS|2\d\d)/.test(r) ? 'r-ok' : 'r-bad', r), el('td', null, n));
      rt.append(tr);
    }
  }
}

function renderMessages() {
  const dir = $('msgdir').value, status = $('msgstatus').value;
  const statuses = [...new Set(messages.map(m => m.status))].sort();
  const sel = $('msgstatus');
  if (sel.options.length - 1 !== statuses.length) {
    const keep = sel.value; sel.replaceChildren(el('option', null, 'all statuses'));
    sel.options[0].value = '';
    for (const s of statuses) sel.append(el('option', null, s));
    sel.value = keep;
  }
  const rows = messages.filter(m => (!dir || m.direction === dir) && (!status || m.status === status)).slice().reverse();
  $('msgcount').textContent = `${rows.length} of ${messages.length}`;
  const tb = $('msgs'); tb.replaceChildren();
  for (const m of rows.slice(0, 200)) {
    const tr = el('tr', 'click' + (m.id === selectedMsg ? ' sel' : ''));
    tr.append(el('td', 'd', m.id), el('td', m.direction, m.direction), el('td', null, m.from || m.supi || '—'), el('td', null, m.to || '—'),
      el('td', null, m.text), el('td', `s-${m.status}`, m.status), el('td', 'd', hhmmss(m.submittedAt)));
    tr.onclick = () => { selectedMsg = selectedMsg === m.id ? null : m.id; renderMessages(); };
    tb.append(tr);
  }
  $('msgempty').textContent = rows.length ? '' : (messages.length ? 'nothing matches the filter' : 'no messages yet');

  const det = $('msgdetail');
  const m = messages.find(x => x.id === selectedMsg);
  det.hidden = !m;
  det.replaceChildren();
  if (m) {
    det.append(el('h3', null, `${m.id} · ${m.direction} · ${m.status}`));
    const facts = { from: m.from, supi: m.supi, to: m.to, 'TP-MR': m.mr, 'TP-SRR': m.srr, 'TP-DCS': m.dcs, smsRecordId: m.smsRecordId,
      submitted: m.submittedAt, expires: m.expiresAt, duplicateOf: m.duplicateOf, attempts: m.attempts };
    for (const [k, v] of Object.entries(facts)) if (v !== undefined && v !== null) det.append(el('div', 'd', `${k}: ${v}`));
    const ol = el('ol');
    for (const h of m.history || []) ol.append(el('li', null, `${hhmmss(h.ts)} ${h.event}${h.detail ? ' — ' + h.detail : ''}`));
    det.append(ol);
  }
}

const logEntries = [];
const openLog = new Set();
let logSince = 0;
const peersSeen = new Set();

function renderLog() {
  const peer = $('logpeer').value, q = $('logq').value.toLowerCase();
  const ol = $('log');
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  ol.replaceChildren();
  for (const e of logEntries) {
    if (peer && e.peer !== peer) continue;
    const bodyText = e.body === undefined || e.body === null ? '' : (typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2));
    if (q && !(`${e.what} ${e.peer} ${e.status} ${bodyText}`.toLowerCase().includes(q))) continue;
    const li = el('li');
    li.append(el('span', 't', hhmmss(e.ts) + ' '));
    const bad = e.status === 0 || e.status >= 400;
    li.append(el('span', bad ? 'err' : e.dir === 'in' ? 'in' : 'out', (e.dir === 'in' ? '<-- ' : '--> ')));
    li.append(el('span', 'peer', e.peer + ' '));
    li.append(el('span', bad ? 'err' : null, `${e.status === null || e.status === undefined ? '' : e.status + ' '}${e.what}`));
    if (typeof e.ms === 'number') li.append(el('span', 'd', ` ${e.ms} ms`));
    if (openLog.has(e.id) && bodyText) {
      const pre = el('pre', null, bodyText);
      pre.onclick = ev => ev.stopPropagation();
      li.append(pre);
    }
    li.onclick = () => { openLog.has(e.id) ? openLog.delete(e.id) : openLog.add(e.id); renderLog(); };
    ol.append(li);
  }
  if (atBottom) ol.scrollTop = ol.scrollHeight;
}

async function pollLog() {
  if ($('logpause').checked) return;
  const fresh = await getJson(`/api/log?since=${logSince}`);
  if (!Array.isArray(fresh) || !fresh.length) return;
  logEntries.push(...fresh);
  logSince = fresh[fresh.length - 1].id;
  while (logEntries.length > 400) logEntries.shift();
  for (const e of fresh) if (!peersSeen.has(e.peer)) { peersSeen.add(e.peer); $('logpeer').append(el('option', null, e.peer)); }
  renderLog();
}

async function tick() {
  try {
    const [m, msgs] = await Promise.all([getJson('/api/metrics'), getJson('/api/messages')]);
    renderMetrics(m);
    messages = Array.isArray(msgs) ? msgs : [];
    renderMessages();
    await pollLog();
  } catch (e) {
    const nrf = $('nrf'); nrf.textContent = 'SMSC backend not answering'; nrf.className = 'badge bad';
  }
}

// ---------- test console ----------
const show = (label, status, body) => { $('out').textContent = `${label}\nHTTP ${status}\n${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}`; };
async function post(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}

$('moform').onsubmit = async ev => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const on = n => f.get(n) === 'on';
  const enc = await post('/test/encode', { type: 'SUBMIT', to: f.get('to'), text: f.get('text'), mr: Number(f.get('mr')), rd: on('rd'), srr: on('srr'), rp: on('rp') });
  if (enc.status !== 200) return show('encode failed', enc.status, enc.body);
  const qs = new URLSearchParams();
  if (on('dryRun')) qs.set('dryRun', '1');
  if (f.get('scenario')) qs.set('scenario', f.get('scenario'));
  const body = { supi: f.get('supi') || undefined, msisdn: f.get('msisdn') || undefined, sms: { hex: on('rp') ? enc.body.rpDataHex : enc.body.tpduHex }, smsRecordId: `console-${Date.now()}` };
  const r = await post(`/smsc/mo-forward-short-message${qs.toString() ? '?' + qs : ''}`, body);
  show(`POST ${API}/smsc/mo-forward-short-message${qs.toString() ? '?' + qs : ''}\n${JSON.stringify(body)}`, r.status, r.body);
  tick();
};
$('mtform').onsubmit = async ev => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const body = { from: f.get('from'), to: f.get('to'), text: f.get('text'), srr: f.get('srr') === 'on' };
  const r = await post('/api/mt', body);
  show(`POST ${API}/api/mt\n${JSON.stringify(body)}`, r.status, r.body);
  tick();
};
$('decform').onsubmit = async ev => {
  ev.preventDefault();
  const r = await post('/test/decode', { hex: new FormData(ev.target).get('hex').trim() });
  show('decode', r.status, r.body);
};

for (const id of ['msgdir', 'msgstatus']) $(id).onchange = renderMessages;
$('logpeer').onchange = renderLog;
$('logq').oninput = renderLog;

getJson('/test').then(c => {
  for (const [name, what] of Object.entries(c.moScenarios || {})) {
    const o = el('option', null, `${name}: ${what}`); o.value = name; $('scenarios').append(o);
  }
}).catch(() => {});

tick();
setInterval(tick, 3000);
