// holminator SMSC tile. Message text and bodies come from other teams' agents: textContent only, never innerHTML.
'use strict';
const API = '/t/holminator';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};
const hhmmss = ts => { const d = new Date(ts); return isNaN(d) ? String(ts || '') : d.toTimeString().slice(0, 8); };
const secs = ms => { const s = Math.round(Math.abs(ms) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`; };
const ago = ts => ts ? `${secs(Date.now() - Date.parse(ts))} ago` : 'never';
const until = ts => { const ms = Date.parse(ts) - Date.now(); return ms > 0 ? `in ${secs(ms)}` : 'due'; };
const short = (s, n = 8) => { s = String(s || ''); return s.length > n + 1 ? s.slice(0, n) + '…' : s; };
const getJson = p => fetch(API + p, { cache: 'no-store' }).then(r => r.json());
async function post(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const isSR = m => m.kind === 'STATUS_REPORT';
const stBadge = s => el('span', `st ${s}`, s);
const dirTags = m => {
  const f = document.createDocumentFragment();
  f.append(el('span', `tag ${m.direction}`, m.direction));
  if (isSR(m)) f.append(el('span', 'tag SR', 'SR'));
  return f;
};
const fmtSt = v => (typeof v === 'number' ? `0x${v.toString(16).padStart(2, '0')}` : v);

let messages = [];
let selectedId = /^#smsc-\d+$/.test(location.hash) ? location.hash.slice(1) : null; // pinned message for detail + flow; null follows the latest
let lastMetrics = null;

// ---------- header + KPIs ----------
function renderHeader(m) {
  $('sc').textContent = m.scAddress;
  const nrf = $('nrf');
  nrf.textContent = m.nrf.registered ? `NRF registered (${m.nrf.team})` : 'NRF not registered';
  nrf.className = 'pill ' + (m.nrf.registered ? 'ok' : 'bad');
  const hb = $('hb');
  const hbOk = m.nrf.lastHeartbeatStatus && /^2/.test(String(m.nrf.lastHeartbeatStatus));
  hb.textContent = m.nrf.lastHeartbeatAt ? `heartbeat ${m.nrf.lastHeartbeatStatus} ${ago(m.nrf.lastHeartbeatAt)}` : 'heartbeat: none yet';
  hb.className = 'pill ' + (!m.nrf.lastHeartbeatAt ? '' : hbOk ? 'ok' : 'warn');
  $('up').textContent = secs(m.uptimeS * 1000);
}

function renderKpis(m) {
  const c = k => m.counters[k] || 0;
  const bs = m.messages.byStatus || {};
  const bd = m.messages.byDirection || {};
  const mwd = messages.filter(x => x.mwd && x.status === 'WAITING').length;
  const cards = [
    ['MO accepted', c('mo_accepted'), 'mo', [[c('mo_received'), 'received'], [c('mo_rejected'), 'rejected'], [c('mo_dry_runs'), 'dry'], [c('mo_duplicates_accepted'), 'dup']]],
    ['MT delivered', c('mt_delivered'), 'ok', [[c('mt_originated'), 'originated'], [c('mt_attempts'), 'attempts']]],
    ['waiting now', bs.WAITING || 0, 'warn', [[c('mt_absent'), 'absent'], [c('mt_retries_scheduled'), 'retries'], [mwd, 'in MWD']]],
    ['MT failed', c('mt_failed'), 'bad', [[c('mt_expired'), 'expired'], [bs.FAILED || 0, 'stored failed']]],
    ['status reports', c('status_reports_sent'), 'sr', [[c('status_reports_generated'), 'generated'], [c('status_reports_failed'), 'failed']]],
    ['SRI-for-SM', c('sri_requests'), '', [[c('udm_delivery_reports'), 'delivery reports to UDM']]],
    ['alerts', c('alerts_received'), 'mt', [[c('alerts_redelivering'), 'SMs redelivered']]],
    ['in store', m.messages.total, '', [[bd.MO || 0, 'MO'], [bd.MT || 0, 'MT'], [c('test_requests'), 'test calls']]],
  ];
  const k = $('kpis'); k.replaceChildren();
  for (const [label, v, cls, subs] of cards) {
    const d = el('div', `kpi ${cls}${v ? '' : ' zero'}`);
    d.append(el('span', 'v', v), el('span', 'l', label));
    const s = el('span', 's');
    subs.forEach(([n, what], i) => { if (i) s.append(' · '); s.append(el('b', null, n), ` ${what}`); });
    d.append(s);
    k.append(d);
  }
}

function resultClass(r) {
  if (/^(SUCCESS|DELIVERED|2\d\d)$/.test(r)) return 'ok';
  if (/^(ACCEPTED|PENDING|DELIVERING)$/.test(r)) return 'info';
  if (/ABSENT|WAITING|BUSY|CONGESTION|SLOW|MEMORY/.test(r)) return 'warn';
  return 'bad';
}

function renderPeersResults(m) {
  const pt = $('peers'); pt.replaceChildren();
  const peers = Object.entries(m.peers).sort();
  const maxAvg = Math.max(1, ...peers.map(([, p]) => p.latencyMsAvg || 0));
  for (const [name, p] of peers) {
    const tr = el('tr');
    const avg = el('td', 'n', p.latencyMsAvg ?? '—');
    if (p.latencyMsAvg) { const bar = el('span', 'lat'); bar.style.width = `${Math.max(2, Math.round(30 * p.latencyMsAvg / maxAvg))}px`; avg.append(bar); }
    tr.append(el('td', 'peer', name), el('td', 'n', p.in), el('td', 'n', p.out), el('td', `n${p.errors ? ' c-bad' : ''}`, p.errors),
      avg, el('td', 'n', p.calls ? p.latencyMsMax : '—'));
    pt.append(tr);
  }
  if (!peers.length) { const tr = el('tr'); const td = el('td', 'empty', 'no traffic yet'); td.colSpan = 6; tr.append(td); pt.append(tr); }

  const box = $('results'); box.replaceChildren();
  const ops = Object.entries(m.results).sort();
  if (!ops.length) box.append(el('div', 'empty', 'no operations yet'));
  for (const [op, res] of ops) {
    const entries = Object.entries(res).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, n]) => a + n, 0);
    const d = el('div', 'op');
    d.append(el('div', 'on', `${op} `)); d.firstChild.append(el('span', 'dim', `(${total})`));
    const bar = el('div', 'bar'); const leg = el('div', 'leg');
    for (const [r, n] of entries) {
      const cls = resultClass(r);
      const i = el('i', `b-${cls}`); i.style.width = `${100 * n / total}%`; i.title = `${r}: ${n}`; bar.append(i);
      leg.append(el('span', `c-${cls}`, `${r} ${n}`));
    }
    d.append(bar, leg); box.append(d);
  }
}

// ---------- flow of one message ----------
// Works out how far the latest delivery attempt got, from the message history the backend keeps.
function flowModel(m) {
  const h = m.history || [];
  let lastDel = -1;
  h.forEach((e, i) => { if (e.event === 'DELIVERING') lastDel = i; });
  const att = lastDel < 0 ? [] : h.slice(lastDel + 1);
  const lastOf = name => { for (let i = att.length - 1; i >= 0; i--) if (att[i].event === name) return att[i]; return null; };
  const sri = lastOf('SRI-for-SM');
  const fwd = lastOf('MT-Forward-Short-Message');
  const s = m.status;
  // PENDING after an earlier attempt: show where that attempt stopped as waiting, the SMSC node pulses as queued.
  const stopCls = s === 'FAILED' || s === 'EXPIRED' ? 'fail' : s === 'DELIVERING' ? 'active' : 'wait';
  const ok = e => /^200\b/.test(e.detail || '');
  const result = e => String(e.detail || '').replace(/^\d+\s*,?\s*/, '');

  let smsc = 'done', udm = '', smsf = '', ue = '';
  let udmSub = '', smsfSub = m.servingSmsf ? short(m.servingSmsf) : '';
  if (s === 'PENDING' || s === 'ACCEPTED') smsc = 'active';
  if (sri) {
    udm = ok(sri) ? 'done' : stopCls;
    udmSub = ok(sri) ? 'routing ok' : result(sri);
    if (ok(sri)) {
      if (fwd) { smsf = ok(fwd) ? 'done' : stopCls; if (!ok(fwd)) smsfSub = result(fwd) || smsfSub; }
      else smsf = s === 'DELIVERING' ? 'active' : (s === 'PENDING' ? '' : stopCls);
    }
  } else if (lastDel >= 0) {
    udm = s === 'PENDING' ? '' : stopCls;
  } else if (s === 'EXPIRED' || s === 'FAILED') smsc = 'fail';
  if (s === 'DELIVERED') { udm = udm || 'done'; smsf = smsf || 'done'; ue = 'done'; }
  if (m.mwd) udmSub = udmSub ? `${udmSub}, MWD` : 'MWD set';
  if (s === 'EXPIRED') { if (udm === 'wait') udm = 'fail'; if (smsf === 'wait') smsf = 'fail'; }

  const origin = isSR(m)
    ? [{ nm: 'report', glyph: '↺', sub: m.reportFor || '', st: 'done' }]
    : m.direction === 'MO'
      ? [{ nm: 'UE', glyph: '▯', sub: m.from || short(m.supi, 12), st: 'done' }, { nm: 'SMSF', glyph: '⇄', sub: 'MO', st: 'done', edge: 'MO SMS' }]
      : [{ nm: 'SC API', glyph: '⚙', sub: m.from || '', st: 'done' }];
  const nodes = [
    ...origin,
    { nm: 'SMSC', glyph: '✉', sub: s === 'PENDING' ? 'queued' : 'stored', st: smsc, edge: m.direction === 'MO' && !isSR(m) ? 'MO-Forward' : 'submit' },
    { nm: 'UDM', glyph: '⌂', sub: udmSub, st: udm, edge: 'SRI-for-SM' },
    { nm: 'SMSF', glyph: '⇄', sub: smsfSub, st: smsf, edge: 'MT-Forward' },
    { nm: 'UE', glyph: '▯', sub: m.to || '', st: ue, edge: isSR(m) ? 'STATUS-REPORT' : 'SMS-DELIVER' },
  ];
  return nodes;
}

const GLYPH_BY_STATE = { fail: '✕', wait: '⏸' };
function renderFlow() {
  const m = messages.find(x => x.id === selectedId) || messages[messages.length - 1];
  const box = $('flow'); box.replaceChildren();
  $('follow').hidden = !selectedId;
  const note = $('flownote'); note.replaceChildren();
  if (!m) { box.append(el('div', 'empty', 'no messages yet: send one below')); $('flowwhat').textContent = ''; return; }
  $('flowwhat').textContent = `${selectedId ? 'selected' : 'latest'}: ${m.id}`;
  flowModel(m).forEach((n, i) => {
    if (i) {
      const e = el('div', `edge ${n.st === 'active' ? 'active' : n.st}`);
      e.append(el('div', 'ln'), el('div', 'lb', n.edge || ''));
      box.append(e);
    }
    const d = el('div', `node ${n.st}`);
    const sub = el('div', 'sub', n.sub); sub.title = n.sub || '';
    d.append(el('div', 'dot', GLYPH_BY_STATE[n.st] || n.glyph), el('div', 'nm', n.nm), sub);
    box.append(d);
  });
  note.append(stBadge(m.status), ' ');
  note.append(dirTags(m), ' ');
  const hist = m.history || [];
  const last = hist[hist.length - 1];
  note.append(el('b', null, last ? `${last.event}${last.detail ? ': ' + last.detail : ''}` : ''));
  if (m.status === 'WAITING' && m.nextRetryAt) note.append(el('span', 'dim', ` · retry ${until(m.nextRetryAt)}`));
  if (m.status === 'WAITING') { note.append(' · '); note.append(alertButton(m.to, 'link')); }
  if (!selectedId) { note.append(' · '); const b = el('button', 'link', 'details'); b.type = 'button'; b.onclick = () => select(m.id); note.append(b); }
}

// ---------- messages ----------
function select(id) {
  selectedId = id;
  try { history.replaceState(null, '', id ? `#${id}` : location.pathname); } catch {}
  renderMessages(); renderFlow();
  const det = $('msgdetail');
  if (id && !det.hidden) det.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function refLink(id, label) {
  const a = el('button', 'link', label || id); a.type = 'button';
  a.onclick = ev => { ev.stopPropagation(); select(id); };
  return a;
}

function renderMessages() {
  const dir = $('msgdir').value, kind = $('msgkind').value, status = $('msgstatus').value;
  const statuses = [...new Set(messages.map(m => m.status))].sort();
  const sel = $('msgstatus');
  if ([...sel.options].slice(1).map(o => o.value).join() !== statuses.join()) {
    const keep = sel.value; sel.replaceChildren(el('option', null, 'all statuses')); sel.options[0].value = '';
    for (const s of statuses) sel.append(el('option', null, s));
    sel.value = statuses.includes(keep) ? keep : '';
  }
  const rows = messages.filter(m => (!dir || m.direction === dir) && (!kind || m.kind === kind) && (!status || m.status === status)).slice().reverse();
  $('msgcount').textContent = `${rows.length} of ${messages.length}`;
  const tb = $('msgs'); tb.replaceChildren();
  for (const m of rows.slice(0, 150)) {
    const tr = el('tr', `click${m.id === selectedId ? ' sel' : ''}${isSR(m) ? ' sr' : ''}`);
    const dirTd = el('td'); dirTd.append(dirTags(m));
    const txt = el('td', 'txt');
    if (isSR(m)) { txt.append(`↳ report for `, refLink(m.reportFor), ` · TP-ST ${fmtSt(m.st)}`); }
    else {
      txt.append(m.text || '');
      if (m.statusReportId) { txt.append(' '); const s = el('span', 'tag SR'); s.append(refLink(m.statusReportId, `SR ${m.statusReportId}`)); txt.append(s); }
    }
    const stTd = el('td'); stTd.append(stBadge(m.status));
    if (m.mwd && m.status === 'WAITING') stTd.append(el('span', 'dim', ' MWD'));
    const when = m.status === 'WAITING' && m.nextRetryAt ? `retry ${until(m.nextRetryAt)}` : hhmmss(m.submittedAt);
    tr.append(el('td', 'dim', m.id), dirTd, el('td', null, `${m.from || short(m.supi, 12) || '—'} → ${m.to || '—'}`), txt, stTd,
      el('td', 'n opt', m.attempts || 0), el('td', 'dim opt', when));
    tr.onclick = () => select(selectedId === m.id ? null : m.id);
    tb.append(tr);
  }
  $('msgempty').textContent = rows.length ? '' : (messages.length ? 'nothing matches the filter' : 'no messages yet: send an MT or MO below');
  renderDetail();
  renderWaiting();
}

let detailKey = '';
function renderDetail() {
  const det = $('msgdetail');
  const m = messages.find(x => x.id === selectedId);
  const key = m ? JSON.stringify(m) : '';
  if (key === detailKey) return;
  detailKey = key;
  det.hidden = !m;
  det.replaceChildren();
  if (!m) return;
  const dh = el('div', 'dh');
  dh.append(el('b', null, m.id), dirTags(m), stBadge(m.status));
  if (m.status === 'WAITING') dh.append(alertButton(m.to));
  const x = el('button', 'ghost x', 'close'); x.type = 'button'; x.onclick = () => select(null); dh.append(x);
  det.append(dh);

  const facts = el('dl', 'facts');
  const fact = (k, v) => { if (v === undefined || v === null || v === '') return; facts.append(el('dt', null, k)); const dd = el('dd'); dd.append(v instanceof Node ? v : String(v)); facts.append(dd); };
  fact('from', m.from); fact('supi', m.supi); fact('to', m.to); fact('text', m.text);
  if (m.reportFor) fact('report for', refLink(m.reportFor));
  if (m.statusReportId) fact('status report', refLink(m.statusReportId));
  if (isSR(m)) fact('TP-ST', fmtSt(m.st));
  fact('TP-MR', m.mr); fact('TP-SRR', m.srr === undefined ? undefined : String(!!m.srr));
  fact('attempts', m.attempts);
  if (m.nextRetryAt) fact('next retry', `${hhmmss(m.nextRetryAt)} (${until(m.nextRetryAt)})`);
  fact('serving SMSF', m.servingSmsf);
  if (m.mwd) fact('MWD', 'set at the UDM, waiting for Alert-Service-Centre');
  fact('failure', m.failure);
  fact('duplicate of', m.duplicateOf);
  fact('submitted', `${hhmmss(m.submittedAt)} (${ago(m.submittedAt)})`);
  if (m.expiresAt) fact('expires', `${new Date(m.expiresAt).toLocaleString()} (${until(m.expiresAt)})`);
  fact('smsRecordId', m.smsRecordId);
  det.append(facts);

  det.append(el('h3', null, 'history'), timeline(m.history || []));
  if (m.tpduHex) det.append(decodedBox('SMS-DELIVER sent to the SMSF', m.tpduHex));
  if (m.deliveryReportHex) det.append(decodedBox('delivery report from the UE', m.deliveryReportHex));
}

function eventClass(e) {
  if (e.event === 'DELIVERED') return 'ok';
  if (e.event === 'FAILED' || e.event === 'EXPIRED') return 'bad';
  if (e.event === 'WAITING') return 'warn';
  if (e.event === 'SRI-for-SM' || e.event === 'MT-Forward-Short-Message') return /^200\b/.test(e.detail || '') ? 'ok' : 'warn';
  return 'info';
}
function timeline(hist) {
  const ol = el('ol', 'tl');
  for (const e of hist) {
    const li = el('li', eventClass(e));
    li.append(el('span', 't', hhmmss(e.ts)), el('span', 'ev', e.event));
    if (e.detail) li.append(el('span', 'dt', ` — ${e.detail}`));
    ol.append(li);
  }
  return ol;
}

const decodeCache = new Map();
function decode(hex) {
  if (!decodeCache.has(hex)) decodeCache.set(hex, post('/test/decode', { hex }).then(r => r.body).catch(e => ({ error: e.message })));
  return decodeCache.get(hex);
}
function kvList(obj) {
  const dl = el('dl', 'kv');
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    dl.append(el('dt', null, k), el('dd', null, typeof v === 'object' ? JSON.stringify(v) : String(v)));
  }
  return dl;
}
// /test/decode answers { rp: {...} | null, tpdu: { hex, ...fields } }: show one flat list.
function flatDecoded(d) {
  if (!d || typeof d.tpdu !== 'object') return d;
  const { hex, ...fields } = d.tpdu;
  return { ...(d.rp || {}), ...fields };
}
function decodedBox(title, hex, { tryDecode = true } = {}) {
  const wrap = el('div');
  wrap.append(el('h3', null, tryDecode ? `${title} (decoded)` : title));
  const slot = el('div', 'dim', tryDecode ? 'decoding…' : '');
  wrap.append(slot, el('div', 'hex', hex));
  if (tryDecode) decode(hex).then(d => slot.replaceWith(d && typeof d === 'object' && !d.error ? kvList(flatDecoded(d)) : el('div', 'dim', `not decodable by /test/decode (${d && d.error})`)));
  return wrap;
}

// ---------- alert ----------
function alertButton(msisdn, cls = 'warnbtn') {
  const b = el('button', cls, `alert SC for ${msisdn}`); b.type = 'button';
  b.title = 'POST /smsc/alert-service-centre: the UE is reachable again, redeliver what waits for it';
  b.onclick = ev => { ev.stopPropagation(); sendAlert(msisdn, 'UE_PRESENT', b); };
  return b;
}
async function sendAlert(msisdn, alertReason, btn) {
  if (btn) btn.disabled = true;
  const out = $('alertout');
  try {
    const r = await post('/smsc/alert-service-centre', { msisdn, scAddress: lastMetrics ? lastMetrics.scAddress : undefined, alertReason });
    out.replaceChildren();
    const head = el('div', 'head');
    head.append(el('span', `st ${r.status === 200 ? 'DELIVERED' : 'FAILED'}`, `HTTP ${r.status}`), el('span', null, (r.body && r.body.result) || ''));
    out.append(head);
    const ids = (r.body && r.body.redelivering) || [];
    const p = el('div', 'dim', ids.length ? 'redelivering: ' : (r.status === 200 ? `nothing was WAITING for ${msisdn}` : (r.body && r.body.detail) || ''));
    ids.forEach((id, i) => { if (i) p.append(', '); p.append(refLink(id)); });
    out.append(p);
  } finally { if (btn) btn.disabled = false; setTimeout(tick, 400); setTimeout(tick, 2500); }
}
function renderWaiting() {
  const counts = new Map();
  for (const m of messages) if (m.status === 'WAITING') counts.set(m.to, (counts.get(m.to) || 0) + 1);
  const dl = $('waitingSubs'); dl.replaceChildren();
  const hint = $('waitinghint'); hint.replaceChildren();
  if (!counts.size) { hint.textContent = 'nothing is WAITING right now'; return; }
  hint.append('WAITING for: ');
  [...counts].forEach(([to, n], i) => {
    const o = el('option'); o.value = to; o.textContent = `${n} waiting`; dl.append(o);
    if (i) hint.append(' ');
    const b = el('button', 'link', `${to} (${n})`); b.type = 'button';
    b.onclick = () => { $('alertform').elements.msisdn.value = to; };
    hint.append(b);
  });
}
$('alertform').onsubmit = ev => {
  ev.preventDefault();
  const f = ev.target.elements;
  sendAlert(f.msisdn.value.trim(), f.alertReason.value, ev.submitter || null);
};

// ---------- MT ----------
function mtBody(form) {
  const f = form.elements;
  return { from: f.from.value.trim() || undefined, to: f.to.value.trim(), text: f.text.value, validitySeconds: Number(f.validitySeconds.value) };
}
function httpHead(r, label) {
  const head = el('div', 'head');
  const ok = r.status >= 200 && r.status < 300;
  head.append(el('span', `st ${ok ? 'DELIVERED' : 'FAILED'}`, `HTTP ${r.status}`));
  if (label) head.append(el('span', null, label));
  return head;
}
function rawAnswer(body) {
  const d = el('details'); d.append(el('summary', 'dim', 'full answer'), el('pre', null, typeof body === 'string' ? body : JSON.stringify(body, null, 2)));
  return d;
}
$('mtform').onsubmit = async ev => {
  ev.preventDefault();
  const btn = ev.target.elements.send; btn.disabled = true; btn.textContent = 'delivering…';
  const out = $('mtout'); out.replaceChildren(el('div', 'dim', 'SRI-for-SM, then MT-Forward… (waits up to 25 s)'));
  try {
    const r = await post('/api/mt?wait=1', mtBody(ev.target));
    out.replaceChildren();
    const b = r.body || {};
    if (b.message) {
      const head = el('div', 'head');
      head.append(stBadge(b.result), refLink(b.messageId));
      const last = b.message.history[b.message.history.length - 1];
      if (last && last.detail) head.append(el('span', 'dim', last.detail));
      if (b.result === 'WAITING') head.append(alertButton(b.message.to));
      out.append(head, timeline(b.message.history));
      select(null); // follow the new message in the flow
    } else out.append(httpHead(r, b.result), el('div', 'err', b.detail || ''));
    out.append(rawAnswer(r.body));
  } catch (e) { out.replaceChildren(el('div', 'err', `request failed: ${e.message}`)); }
  finally { btn.disabled = false; btn.textContent = 'send and wait for outcome'; tick(); }
};
$('mtdry').onclick = async () => {
  const out = $('mtout'); out.replaceChildren(el('div', 'dim', 'building SMS-DELIVER…'));
  const r = await post('/api/mt?dryRun=1', mtBody($('mtform')));
  out.replaceChildren();
  const b = r.body || {};
  out.append(httpHead(r, b.dryRun ? 'dry run, nothing sent' : b.result));
  if (b.decoded) out.append(el('h3', null, 'SMS-DELIVER (decoded)'), kvList(b.decoded), el('div', 'hex', b.tpduHex));
  if (Array.isArray(b.wouldDo)) { out.append(el('h3', null, 'would do')); const ol = el('ol', 'tl'); for (const w of b.wouldDo) ol.append(el('li', 'info', w)); out.append(ol); }
  if (b.detail) out.append(el('div', 'err', b.detail));
};

// ---------- MO ----------
$('moform').onsubmit = async ev => {
  ev.preventDefault();
  const f = ev.target.elements;
  const out = $('moout'); out.replaceChildren(el('div', 'dim', 'encoding SMS-SUBMIT…'));
  const enc = await post('/test/encode', { type: 'SUBMIT', to: f.to.value.trim(), text: f.text.value, mr: Number(f.mr.value), rd: f.rd.checked, srr: f.srr.checked, rp: f.rp.checked });
  if (enc.status !== 200) { out.replaceChildren(httpHead(enc, 'encode failed'), el('div', 'err', (enc.body && enc.body.error) || '')); return; }
  const qs = new URLSearchParams();
  if (f.dryRun.checked) qs.set('dryRun', '1');
  if (f.scenario.value) qs.set('scenario', f.scenario.value);
  const body = { supi: f.supi.value.trim() || undefined, msisdn: f.msisdn.value.trim() || undefined, sms: { hex: f.rp.checked ? enc.body.rpDataHex : enc.body.tpduHex }, smsRecordId: `console-${Date.now()}` };
  out.replaceChildren(el('div', 'dim', f.scenario.value ? `scenario ${f.scenario.value}…` : 'MO-Forward-Short-Message…'));
  const r = await post(`/smsc/mo-forward-short-message${qs.toString() ? '?' + qs : ''}`, body);
  const b = r.body || {};
  out.replaceChildren();
  const head = httpHead(r, `${b.result || ''}${b.diameterResultCode ? ' ' + b.diameterResultCode : ''}`);
  if (b.messageId) { head.append(refLink(b.messageId)); select(null); }
  if (b.dryRun) head.append(el('span', 'dim', 'dry run, nothing stored'));
  out.append(head);
  if (b.detail) out.append(el('div', 'err', b.detail));
  if (b.decoded) out.append(el('h3', null, 'SMS-SUBMIT (decoded)'), kvList(b.decoded));
  if (b.smDeliveryFailureCause) out.append(el('div', 'dim', `SM-Delivery-Failure-Cause ${b.smDeliveryFailureCause.smEnumeratedDeliveryFailureCause} (${b.smDeliveryFailureCause.value})`));
  if (b.deliveryReport && b.deliveryReport.hex) out.append(decodedBox('SMS-SUBMIT-REPORT (deliveryReport.hex)', b.deliveryReport.hex, { tryDecode: false }));
  out.append(rawAnswer(r.body));
  tick();
};

// ---------- decode ----------
$('decform').onsubmit = async ev => {
  ev.preventDefault();
  const hex = ev.target.elements.hex.value.trim();
  const r = await post('/test/decode', { hex });
  const out = $('decout'); out.replaceChildren();
  if (r.status === 200 && r.body && typeof r.body === 'object') out.append(kvList(flatDecoded(r.body)));
  else out.append(httpHead(r), el('div', 'err', (r.body && r.body.error) || String(r.body)));
};

// ---------- wire log ----------
const logEntries = [];
const openLog = new Set();
const freshLog = new Set();
let logSince = 0;
const peersSeen = new Set();

function renderLog() {
  const peer = $('logpeer').value, q = $('logq').value.toLowerCase();
  const ol = $('log');
  const atTop = ol.scrollTop < 30;
  ol.replaceChildren();
  for (let i = logEntries.length - 1; i >= 0; i--) {
    const e = logEntries[i];
    if (peer && e.peer !== peer) continue;
    const bodyText = e.body === undefined || e.body === null ? '' : (typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2));
    if (q && !(`${e.what} ${e.peer} ${e.status} ${bodyText}`.toLowerCase().includes(q))) continue;
    const li = el('li', freshLog.has(e.id) ? 'fresh' : null);
    const bad = e.status === 0 || e.status >= 400;
    li.append(el('span', 't', hhmmss(e.ts) + ' '),
      el('span', bad ? 'err' : e.dir === 'in' ? 'in' : 'out', e.dir === 'in' ? '← ' : '→ '),
      el('span', 'peer', e.peer + ' '),
      el('span', bad ? 'err' : null, `${e.status === null || e.status === undefined ? '' : e.status + ' '}${e.what}`));
    if (typeof e.ms === 'number') li.append(el('span', 'ms', ` ${e.ms} ms`));
    if (openLog.has(e.id) && bodyText) { const pre = el('pre', null, bodyText); pre.onclick = ev => ev.stopPropagation(); li.append(pre); }
    li.onclick = () => { openLog.has(e.id) ? openLog.delete(e.id) : openLog.add(e.id); freshLog.clear(); renderLog(); };
    ol.append(li);
    if (ol.children.length >= 250) break;
  }
  if (!ol.children.length) ol.append(el('li', 'empty', 'no requests yet'));
  if (atTop) ol.scrollTop = 0;
}

async function pollLog() {
  if ($('logpause').checked) return;
  const fresh = await getJson(`/api/log?since=${logSince}`);
  freshLog.clear();
  if (Array.isArray(fresh) && fresh.length) {
    const first = logSince === 0;
    logEntries.push(...fresh);
    logSince = fresh[fresh.length - 1].id;
    while (logEntries.length > 400) logEntries.shift();
    if (!first) for (const e of fresh) freshLog.add(e.id);
    for (const e of fresh) if (!peersSeen.has(e.peer)) { peersSeen.add(e.peer); $('logpeer').append(el('option', null, e.peer)); }
    renderLog();
  } else if (!logEntries.length) renderLog();
}

// ---------- loop ----------
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const [m, msgs] = await Promise.all([getJson('/api/metrics'), getJson('/api/messages')]);
    lastMetrics = m;
    messages = Array.isArray(msgs) ? msgs : [];
    if (selectedId && !messages.some(x => x.id === selectedId)) selectedId = null;
    renderHeader(m); renderKpis(m); renderPeersResults(m);
    renderMessages(); renderFlow();
    await pollLog();
  } catch (e) {
    const nrf = $('nrf'); nrf.textContent = 'SMSC backend not answering'; nrf.className = 'pill bad';
  } finally { ticking = false; }
}

for (const id of ['msgdir', 'msgkind', 'msgstatus']) $(id).onchange = renderMessages;
$('follow').onclick = () => select(null);
$('logpeer').onchange = renderLog;
$('logq').oninput = renderLog;
$('logpause').onchange = () => { if (!$('logpause').checked) pollLog(); };

getJson('/test').then(c => {
  for (const [name, what] of Object.entries(c.moScenarios || {})) {
    const o = el('option', null, `${name} — ${what}`); o.value = name; $('scenarios').append(o);
  }
}).catch(() => {});

tick();
setInterval(tick, 3000);
