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
const getJson = p => fetch(API + p, { cache: 'no-store' }).then(r => r.json());
// Marks the tile's own calls so /test/decode does not count them as external test requests.
const TILE_HEADERS = { 'content-type': 'application/json', 'x-holminator-tile': '1' };
const MSG_LIMIT = 200; // the poll fetches only the newest MSG_LIMIT messages (GET /api/messages?limit=)
async function post(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: TILE_HEADERS, body: JSON.stringify(body) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
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
  const cb = consistencyBadge(m), cp = $('consistency');
  cp.textContent = cb.text;
  cp.className = 'pill ' + (cb.state === 'ok' ? 'ok' : cb.state === 'bad' ? 'bad' : '');
  const cf = $('consfail'); cf.replaceChildren(); cf.hidden = !cb.failed.length;
  for (const f of cb.failed) { const d = el('div'); d.append(el('b', null, f.name), f.detail ? ` — ${f.detail}` : ''); cf.append(d); }
  const since = countersSince(m);
  $('since').textContent = since ? `counters since ${new Date(since).toLocaleString()}` : `counters since ${DASH}`;
  $('since').title = since ? `counters are persisted from ${since} (${ago(since)})` : 'the backend does not report when its counters started';
}

const numTd = v => el('td', `n${v === DASH ? ' dim' : ''}`, v);
function renderPanels(m) {
  const pt = pduTable(m), tb = $('pdus'); tb.replaceChildren();
  for (const g of pt.groups) {
    const h = el('tr', 'grp'); const th = el('td', null); th.colSpan = 4;
    if (g.grp) th.append(el('span', `tag ${g.grp}`, g.grp));
    th.append(g.title.replace(/^(MO|MT) · /, '')); h.append(th); tb.append(h);
    for (const r of g.rows) {
      const tr = el('tr');
      tr.append(el('td', 'pdu', r.in ? r.in.label : ''), r.in ? numTd(r.in.v) : el('td'), el('td', 'pdu', r.out ? r.out.label : ''), r.out ? numTd(r.out.v) : el('td'));
      tb.append(tr);
    }
  }
  const rc = rpCauses(m);
  for (const [id, list] of [['causesin', rc.in], ['causesout', rc.out]]) {
    const box = $(id); box.replaceChildren();
    if (!list) { box.append(el('div', 'dim', DASH)); continue; }
    if (!list.length) { box.append(el('div', 'dim', 'none')); continue; }
    const dl = el('dl', 'kv');
    for (const { cause, n } of list) dl.append(el('dt', null, cause), el('dd', 'n', n));
    box.append(dl);
  }

  const sp = srPanel(m);
  const srStats = (id, fields) => {
    const ss = $(id); ss.replaceChildren();
    for (const f of fields) {
      const d = el('div', `srs ${f.cls}${f.v === DASH ? ' unknown' : f.v ? '' : ' zero'}`);
      d.append(el('span', 'v', f.v), el('span', 'l', f.k)); d.title = f.hint;
      ss.append(d);
    }
  };
  const tpStTable = (id, rows) => {
    const tt = $(id); tt.replaceChildren();
    if (!rows || !rows.length) { const tr = el('tr'); const td = el('td', 'empty', rows ? 'no status reports yet' : DASH); td.colSpan = 3; tr.append(td); tt.append(tr); }
    else for (const r of rows) { const tr = el('tr'); tr.append(el('td', `c-${r.cls}`, r.code), el('td', null, r.name), numTd(r.n)); tt.append(tr); }
  };
  srStats('srstats', sp.fields); tpStTable('tpst', sp.byTpSt);
  srStats('srstatsmt', sp.mt.fields); tpStTable('tpstmt', sp.mt.byTpSt);

  const so = sgdOps(m), sb = $('sgdops'); sb.replaceChildren();
  for (let i = 0; i < Math.max(so.in.length, so.out.length); i++) {
    const a = so.in[i], b = so.out[i], tr = el('tr');
    tr.append(el('td', 'peer', a ? a.op : ''), a ? numTd(a.v) : el('td'), el('td', 'peer', b ? b.op : ''), b ? numTd(b.v) : el('td'));
    sb.append(tr);
  }
}

function renderKpis(m) {
  const k = $('kpis'); k.replaceChildren();
  for (const { grp, label, v, cls, subs, est, title, note } of kpiCards(m, messages)) {
    const d = el('div', `kpi ${cls} g-${grp || 'none'}${v && v !== DASH ? '' : ' zero'}`);
    d.append(el('span', 'v', v), el('span', 'l', label));
    if (title) d.title = title;
    if (est) { const e = el('span', 'est'); e.title = est; d.append(' ', e); d.title = est; }
    if (note) d.append(el('span', 'note', note));
    const s = el('span', 's');
    subs.forEach(([n, what], i) => { if (i) s.append(' · '); s.append(el('b', null, n), ` ${what}`); });
    d.append(s);
    k.append(d);
  }
}

function resultClass(r) {
  if (/^(SUCCESS|DELIVERED|FORWARDED|2\d\d)$/.test(r)) return 'ok';
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

// ---------- flow model (pure, no DOM: test/run.mjs evaluates this block on its own) ----------
const isSR = m => m.kind === 'STATUS_REPORT';
const short = (s, n = 8) => { s = String(s || ''); return s.length > n + 1 ? s.slice(0, n) + '…' : s; };
// An MO (SMS-SUBMIT) terminates at the SMSC; everything the SMSC sends towards a UE (SMS, status report) is an MT.
const flowKind = m => (m && m.direction === 'MO' && !isSR(m) ? 'MO' : 'MT');
const srIdOf = m => (m && (m.statusReportId || (m.sr && (m.sr.id || m.sr.messageId)))) || null;
const flowHint = m => (flowKind(m) === 'MO' ? 'UE → AMF → SMSF → SMSC (ends here, onward simulated)' : 'SMSC → NRF → UDM → SMSF → AMF → UE');

// MO: UE -> AMF -> SMSF -> SMSC (MO-Forward-SM), RP-ACK with SMS-SUBMIT-REPORT back the same way. The SMSC stores
// the SM and marks it FORWARDED: onward delivery is simulated, there is no SRI or MT-Forward for an MO.
function moFlow(m) {
  const s = m.status;
  const end = s === 'FORWARDED' ? 'done' : s === 'ACCEPTED' ? 'active' : /^(FAILED|EXPIRED)$/.test(s) ? 'fail' : 'off';
  const endSub = s === 'FORWARDED' ? 'simulated' : s === 'ACCEPTED' ? 'forwarding…' : s === 'EXPIRED' ? 'expired, not forwarded' : end === 'fail' ? (m.failure || s) : `legacy ${s || ''}`.trim();
  return {
    kind: 'MO',
    nodes: [
      { nm: 'UE', glyph: '▯', sub: m.from || short(m.supi, 12), st: 'done' },
      { nm: 'AMF', glyph: '◇', sub: 'NAS', st: 'done', edge: 'RP-DATA · SMS-SUBMIT', back: 'RP-ACK · SUBMIT-REPORT', backSt: 'done' },
      { nm: 'SMSF', glyph: '⇄', sub: '', st: 'done', edge: 'UplinkSMS', back: 'RP-ACK', backSt: 'done' },
      { nm: 'SMSC', glyph: '✉', sub: 'stored', st: 'done', edge: 'MO-Forward-SM (RP-DATA/SMS-SUBMIT)', back: '2001 · RP-ACK (SUBMIT-REPORT)', backSt: 'done' },
      { nm: 'onward', glyph: '⇢', sub: endSub, st: end, end: true, edge: 'simulated onward delivery' },
    ],
    side: null,
  };
}

// MT: SMSC -> (NRF) -> UDM (SRI-for-SM) -> SMSF (MT-Forward-SM) -> AMF -> UE (SMS-DELIVER or SMS-STATUS-REPORT), RP-ACK or
// RP-ERROR back. How far the latest attempt got comes from the history the backend keeps. The side chain is the
// absent path: ReportSM-DeliveryStatus to the UDM (MWD), then Alert-SC from the UDM and a new attempt.
function mtFlow(m) {
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
  // The SMSF answers 502 with the UE's RP-ERROR as deliveryReport: the UE was reached and refused.
  const rpErr = !!(fwd && /^502\b/.test(fwd.detail || '') && m.deliveryReportHex);
  const delivered = s === 'DELIVERED';

  let smsc = 'done', nrf = '', udm = '', smsf = '', amf = '', ue = '';
  let udmSub = '', smsfSub = m.servingSmsf ? short(m.servingSmsf) : '', ueSub = m.to || '';
  if (s === 'PENDING' || s === 'ACCEPTED') smsc = 'active';
  if (sri) {
    nrf = 'done';
    udm = ok(sri) ? 'done' : stopCls;
    udmSub = ok(sri) ? 'routing ok' : result(sri);
    if (ok(sri)) {
      if (fwd) {
        smsf = ok(fwd) || rpErr ? 'done' : stopCls;
        if (!ok(fwd) && !rpErr) smsfSub = result(fwd) || smsfSub;
        if (rpErr) { amf = 'done'; ue = stopCls; ueSub = 'RP-ERROR'; }
      } else smsf = s === 'DELIVERING' ? 'active' : (s === 'PENDING' ? '' : stopCls);
    }
  } else if (lastDel >= 0) {
    nrf = s === 'PENDING' ? '' : stopCls;
  } else if (s === 'EXPIRED' || s === 'FAILED') smsc = 'fail';
  if (delivered) { nrf = nrf || 'done'; udm = udm || 'done'; smsf = smsf || 'done'; amf = 'done'; ue = 'done'; }
  if (m.mwd) udmSub = udmSub ? `${udmSub}, MWD` : 'MWD set';
  if (s === 'EXPIRED') { if (nrf === 'wait') nrf = 'fail'; if (udm === 'wait') udm = 'fail'; if (smsf === 'wait') smsf = 'fail'; }

  const ansLabel = delivered ? 'RP-ACK' : rpErr ? 'RP-ERROR' : 'RP-ACK / RP-ERROR';
  const ansSt = delivered ? 'done' : rpErr ? 'fail' : 'off';
  const fwdBack = delivered ? '200 · RP-ACK' : rpErr ? '502 · RP-ERROR' : fwd && !ok(fwd) ? result(fwd) || 'error' : 'answer';
  const fwdBackSt = delivered ? 'done' : rpErr ? 'fail' : fwd && !ok(fwd) ? stopCls : 'off';
  const smscSub = s === 'PENDING' ? 'queued' : isSR(m) ? `report for ${short(m.reportFor, 10)}` : m.from ? `from ${m.from}` : 'stored';

  // Absent path. MWD is set by a ReportSM-DeliveryStatus (absent at the SMSF, memory full) or by the UDM itself
  // when SRI-for-SM answers ABSENT_SUBSCRIBER_SM.
  const reportedTo = h.some(e => e.event === 'Report-SM-Delivery-Status' && !/^SUCCESSFUL/.test(e.detail || ''));
  const absentSri = h.some(e => e.event === 'SRI-for-SM' && /ABSENT/.test(e.detail || ''));
  const reported = reportedTo || absentSri || !!m.mwd;
  let alertAt = -1;
  h.forEach((e, i) => { if (e.event === 'ALERT') alertAt = i; });
  const alerted = alertAt >= 0;
  const redelivered = alerted && h.slice(alertAt + 1).some(e => e.event === 'DELIVERING');
  const off = st => (reported ? st : 'off');
  const side = {
    label: 'absent path',
    taken: reported,
    nodes: [
      { nm: 'SMSC', glyph: '✉', sub: reported ? 'UE absent' : '', st: off('done') },
      { nm: 'UDM', glyph: '⌂', sub: reported ? (alerted ? 'MWD → alert' : 'MWD set') : 'MWD', st: off(alerted ? 'done' : 'wait'),
        edge: reportedTo || !absentSri ? 'ReportSM-DeliveryStatus' : 'ReportSM-DeliveryStatus (MWD set by SRI)', est: off('done') },
      { nm: 'SMSC', glyph: '↻', sub: redelivered ? 'redelivered' : alerted ? 'redelivery due' : reported ? 'waits for alert' : 'redeliver',
        st: off(redelivered ? 'done' : alerted ? 'active' : 'wait'), edge: 'Alert-SC', est: off(alerted ? 'done' : 'wait') },
    ],
  };

  return {
    kind: 'MT',
    nodes: [
      { nm: 'SMSC', glyph: '✉', sub: smscSub, st: smsc },
      { nm: 'NRF', glyph: '⌕', sub: 'discovery', st: nrf, aux: true, edge: 'NFDiscover' },
      { nm: 'UDM', glyph: '⌂', sub: udmSub, st: udm, edge: 'SRI-for-SM',
        back: sri ? (ok(sri) ? 'serving SMSF' : result(sri) || 'error') : 'routing info', backSt: sri ? (ok(sri) ? 'done' : udm) : 'off' },
      { nm: 'SMSF', glyph: '⇄', sub: smsfSub, st: smsf, edge: 'MT-Forward-SM', back: fwdBack, backSt: fwdBackSt },
      { nm: 'AMF', glyph: '◇', sub: 'NAS', st: amf, edge: 'N1N2 transfer', back: ansLabel, backSt: ansSt },
      { nm: 'UE', glyph: '▯', sub: ueSub, st: ue, edge: isSR(m) ? 'SMS-STATUS-REPORT' : 'SMS-DELIVER',
        back: delivered ? 'RP-ACK · DELIVER-REPORT' : ansLabel, backSt: ansSt },
      ...(m.srr && !isSR(m) ? [mtReportStep(m)] : []),
    ],
    side,
  };
}

// TP-ST of the simulated status report for an MT with TP-SRR (message.statusReport), or null while there is none.
function mtReportInfo(m) {
  const r = m && m.statusReport;
  if (!r) return null;
  const raw = typeof r === 'object' ? (r.st ?? r.tpSt ?? r.tp_st) : r;
  return raw === undefined || raw === null ? null : stInfo(raw);
}
// The MT's last step, like the MO's "onward delivery (simulated)": status report back to the originating SME.
function mtReportStep(m) {
  const info = mtReportInfo(m);
  const final = /^(DELIVERED|FAILED|EXPIRED)$/.test(m.status);
  const st = info ? { ok: 'done', warn: 'wait', bad: 'fail' }[info.cls] : final ? 'active' : 'off';
  return { nm: 'orig. SME', glyph: '↩', end: true, st, edge: 'status report (simulated)',
    sub: info ? `TP-ST ${info.code} ${info.name}` : final ? 'reporting…' : 'after the final outcome' };
}

const flowModel = m => (flowKind(m) === 'MO' ? moFlow(m) : mtFlow(m));

// KPI cards, MO and MT counted apart. Counters the backend does not have yet fall back to the polled message window.
function kpiCards(m, msgs, now) {
  const cs = (m && m.counters) || {};
  const has = k => typeof cs[k] === 'number';
  const c = k => cs[k] || 0;
  const ms = (m && m.messages) || {};
  const bs = ms.byStatus || {}, bd = ms.byDirection || {};
  const list = Array.isArray(msgs) ? msgs : [];
  const mo = status => list.filter(x => flowKind(x) === 'MO' && (!status || x.status === status)).length;
  const mwd = list.filter(x => x.mwd && x.status === 'WAITING').length;
  const newBackend = has('mo_forwarded');
  return [
    { grp: 'MO', label: 'MO received', v: has('mo_received') ? c('mo_received') : c('mo_accepted'), cls: 'mo',
      est: has('mo_received') ? '' : 'no mo_received counter: showing mo_accepted',
      subs: [[c('mo_accepted'), 'accepted (RP-ACK)'], [c('mo_rejected'), 'rejected'], [c('mo_duplicates_accepted'), 'dup'], [c('mo_dry_runs'), 'dry']] },
    { grp: 'MO', label: 'MO forwarded', v: newBackend ? c('mo_forwarded') : mo('FORWARDED'), cls: 'mo',
      est: newBackend ? '' : 'no mo_forwarded counter: counted in the message window',
      subs: [[mo('ACCEPTED'), 'not yet forwarded'], [c('mo_expired'), 'expired'], [mo(), 'MO in window']] },
    { grp: 'MO', label: 'MO status reports', v: has('status_reports_sent') ? c('status_reports_sent') : DASH, cls: 'sr',
      title: 'SMS-STATUS-REPORT sent back to the originating UE for MOs with TP-SRR, delivered (RP-ACK)',
      subs: [[num(cs.mo_srr_requested), 'requested'], [num(cs.status_reports_generated), 'generated'], [num(cs.status_reports_failed), 'failed']] },
    { grp: 'MT', label: 'MT originated', v: c('mt_originated'), cls: 'mt',
      est: newBackend ? '' : 'older backend: includes MOs it delivered as MT',
      subs: [[c('mt_attempts'), 'attempts'], [c('sri_requests'), 'SRI-for-SM']] },
    { grp: 'MT', label: 'MT SMS delivered', v: c('mt_delivered'), cls: 'ok', title: 'generator SMS acknowledged by the UE with RP-ACK; status reports excluded',
      subs: [[c('mt_rp_error_temporary'), 'RP-ERROR temp']] },
    { grp: 'MT', label: 'MT waiting', v: bs.WAITING || 0, cls: 'warn', subs: [[c('mt_absent'), 'absent'], [c('mt_retries_scheduled'), 'retries'], [c('mt_alert_fast_retries'), 'fast retries'], [mwd, 'in MWD']] },
    { grp: 'MT', label: 'MT failed', v: c('mt_failed'), cls: 'bad', subs: [[c('mt_expired'), 'expired'], [c('mt_attempts_exhausted'), 'attempts exhausted'], [bs.FAILED || 0, 'stored failed']] },
    { grp: 'MT', label: 'MT status reports', v: num(cs.mt_status_reports_simulated), cls: 'sr', note: 'to originating SME, simulated',
      title: 'SMS-STATUS-REPORT for MTs with TP-SRR, returned to the originating SME (simulated)',
      subs: [[num(cs.mt_srr_requested), 'requested']] },
    { grp: 'MT', label: 'Alert-SC received', v: c('alerts_received'), cls: 'mt', subs: [[c('udm_delivery_reports'), 'ReportSM-DeliveryStatus'], [c('alerts_redelivering'), 'redelivered']] },
    ...storeCards(m, now),
  ];
}
// The store holds only messages not yet final; finished ones move to the history (both capped, see /api/metrics).
const STORE_STATUSES = ['ACCEPTED', 'PENDING', 'DELIVERING', 'WAITING'];
const inStore = m => !!m && STORE_STATUSES.includes(m.status);
const ageShort = (ts, now) => {
  const ms = (now ?? Date.now()) - Date.parse(ts);
  if (!(ms >= 0)) return DASH;
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
function storeCards(m, now) {
  const o = k => (m && m[k] && typeof m[k] === 'object' ? m[k] : null);
  const s = o('store'), h = o('history'), cs = (m && m.counters) || {}, bd = (m && m.messages && m.messages.byDirection) || {};
  const bs = (s && s.byStatus) || {};
  const storeSubs = s ? STORE_STATUSES.map(k => [num(bs[k]), k.toLowerCase()]) : [];
  if (s && s.oldestAt) storeSubs.push([ageShort(s.oldestAt, now), 'oldest']);
  return [
    { grp: '', label: 'in store', v: s ? num(s.held) : DASH, cls: 'store',
      title: s ? `messages not yet final (max ${num(s.max)}); finished ones move to the history` : 'older backend: no store section in /api/metrics',
      subs: storeSubs },
    { grp: '', label: 'history', v: h ? num(h.kept) : DASH, cls: '',
      title: 'finished messages kept for the message list; the oldest are dropped beyond max',
      subs: h ? [[num(h.max), 'max'], [num(cs.history_evicted), 'evicted'], [bd.MO ?? DASH, 'MO listed'], [bd.MT ?? DASH, 'MT listed']]
        : [[bd.MO ?? DASH, 'MO listed'], [bd.MT ?? DASH, 'MT listed']] },
  ];
}
// ---------- metrics panels (pure): PDUs, RP-Causes, status reports, SGd operations, consistency ----------
// A missing key means the backend is older than these panels: show "–", never a made-up 0.
const DASH = '–';
const num = v => (typeof v === 'number' && isFinite(v) ? v : DASH);
const countersSince = m => (m && (m.since || (m.metrics && m.metrics.since) || m.countersSince)) || null;

// TP-Status, TS 23.040 9.2.3.15. 0x00-0x1F completed, 0x20-0x3F temporary (SC still trying), 0x40+ permanent.
const ST_NAMES = {
  0x00: 'received by SME', 0x01: 'forwarded, delivery unconfirmed', 0x02: 'replaced by SC',
  0x20: 'congestion (still trying)', 0x21: 'SME busy (still trying)', 0x22: 'no response from SME (still trying)',
  0x23: 'service rejected (still trying)', 0x24: 'QoS not available (still trying)', 0x25: 'error in SME (still trying)',
  0x40: 'remote procedure error', 0x41: 'incompatible destination', 0x42: 'connection rejected by SME', 0x43: 'not obtainable',
  0x44: 'QoS not available', 0x45: 'no interworking available', 0x46: 'SM validity period expired',
  0x47: 'SM deleted by originating SME', 0x48: 'SM deleted by SC administration', 0x49: 'SM does not exist',
  0x60: 'congestion (stopped)', 0x61: 'SME busy (stopped)', 0x62: 'no response from SME (stopped)',
  0x63: 'service rejected (stopped)', 0x64: 'QoS not available (stopped)', 0x65: 'error in SME (stopped)',
};
const stCode = k => { const n = typeof k === 'number' ? k : Number(String(k).trim()); return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null; };
function stInfo(k) {
  const n = stCode(k);
  if (n === null) return { code: String(k), name: 'not a TP-ST value', cls: 'bad' };
  const name = ST_NAMES[n] || (n < 0x20 ? 'completed (reserved/SC specific)' : n < 0x40 ? 'temporary (reserved/SC specific)' : 'permanent (reserved/SC specific)');
  return { code: `0x${n.toString(16).padStart(2, '0')}`, name, cls: n < 0x20 ? 'ok' : n < 0x40 ? 'warn' : 'bad' };
}

// RP/TP PDUs the SMSC receives and sends, paired per direction of the SM: MO (UE -> SMSC) and MT (SMSC -> UE).
const PDU_GROUPS = [
  { grp: 'MO', title: 'MO · SMS-SUBMIT and its report', in: ['RP-DATA/SMS-SUBMIT'], out: ['RP-ACK/SMS-SUBMIT-REPORT', 'RP-ERROR/SMS-SUBMIT-REPORT'] },
  { grp: 'MT', title: 'MT · SMS-DELIVER, SMS-STATUS-REPORT and the UE answer',
    in: ['RP-ACK/SMS-DELIVER-REPORT', 'RP-ERROR/SMS-DELIVER-REPORT', 'RP-ACK/STATUS-REPORT-ACK', 'none/no-report'],
    out: ['RP-DATA/SMS-DELIVER', 'RP-DATA/SMS-STATUS-REPORT'] },
];
function pduTable(m) {
  const p = m && m.pdus;
  const side = d => (p && p[d] && typeof p[d] === 'object' ? p[d] : null);
  const pin = side('in'), pout = side('out');
  const cell = (obj, key) => (key ? { label: key.replace('/', ' / '), v: obj ? num(obj[key]) : DASH } : null);
  const groups = PDU_GROUPS.map(g => {
    const rows = [];
    for (let i = 0; i < Math.max(g.in.length, g.out.length); i++) rows.push({ in: cell(pin, g.in[i]), out: cell(pout, g.out[i]) });
    return { grp: g.grp, title: g.title, rows };
  });
  // Keys the backend added that this table does not know yet still show, as "other".
  const known = new Set(PDU_GROUPS.flatMap(g => [...g.in, ...g.out]));
  const extraIn = Object.keys(pin || {}).filter(k => !known.has(k)), extraOut = Object.keys(pout || {}).filter(k => !known.has(k));
  if (extraIn.length || extraOut.length) {
    const rows = [];
    for (let i = 0; i < Math.max(extraIn.length, extraOut.length); i++) rows.push({ in: cell(pin, extraIn[i]), out: cell(pout, extraOut[i]) });
    groups.push({ grp: '', title: 'other', rows });
  }
  return { known: !!(pin || pout), groups };
}
// RP-Cause breakdown per side, most frequent first; the backend pre-seeds every cause at 0, so only non-zero ones
// show. null for a side the backend does not report.
function rpCauses(m) {
  const r = m && m.rpCauses;
  const side = d => (r && r[d] && typeof r[d] === 'object' ? Object.entries(r[d]).filter(([, n]) => n !== 0).map(([cause, n]) => ({ cause, n: num(n) })).sort((a, b) => (Number(b.n) || 0) - (Number(a.n) || 0)) : null);
  return { in: side('in'), out: side('out') };
}
const SR_FIELDS = [['requested', '', 'MOs that asked for a report (TP-SRR=1)'], ['generated', '', 'status report records made (TP-SRR outcomes)'], ['sent', 'sr', 'MT-Forward attempts carrying an SMS-STATUS-REPORT'],
  ['delivered', 'ok', 'acknowledged by the UE (RP-ACK)'], ['failed', 'bad', 'permanent failure'], ['expired', 'bad', 'validity period ended'], ['waiting', 'warn', 'in the store, still to be delivered']];
const SR_MT_FIELDS = [['requested', '', 'MTs that asked for a report (TP-SRR)'], ['simulated', 'sr', 'reports returned to the originating SME (simulated)']];
const tpStRows = bt => (bt && typeof bt === 'object'
  ? Object.entries(bt).filter(([, n]) => n !== 0).map(([k, n]) => ({ ...stInfo(k), n: num(n) })).sort((a, b) => (Number(b.n) || 0) - (Number(a.n) || 0) || a.code.localeCompare(b.code))
  : null);
// Status reports both ways: MO side (sent to the originating UE, statusReports) at the top level, MT side (simulated
// to the originating SME, statusReportsMt) under .mt.
function srPanel(m) {
  const obj = k => (m && m[k] && typeof m[k] === 'object' ? m[k] : null);
  const s = obj('statusReports'), t = obj('statusReportsMt');
  const fields = SR_FIELDS.map(([k, cls, hint]) => ({ k, cls, hint, v: s ? num(s[k]) : DASH }));
  const mt = { known: !!t, fields: SR_MT_FIELDS.map(([k, cls, hint]) => ({ k, cls, hint, v: t ? num(t[k]) : DASH })), byTpSt: tpStRows(t && t.byTpSt) };
  return { known: !!s, fields, byTpSt: tpStRows(s && s.byTpSt), mt };
}
// TP-SRR note for a message row: MO -> the status report MT we send to the UE; MT -> the simulated report to the SME.
function srrNote(m, msgs) {
  if (!m || !m.srr || isSR(m)) return null;
  if (flowKind(m) === 'MO') {
    const id = srIdOf(m);
    const sr = id && Array.isArray(msgs) ? msgs.find(x => x.id === id) : null;
    const status = (sr && sr.status) || null;
    return { kind: 'MO', id, cls: 'SR', text: id ? `SRR · report ${id}${status ? ` ${status}` : ''}` : 'SRR · report pending' };
  }
  const info = mtReportInfo(m);
  return { kind: 'MT', id: null, cls: info ? `st-${info.cls}` : 'SR', text: info ? `SRR · report TP-ST ${info.code} (simulated)` : 'SRR · report pending (simulated)' };
}
const SGD_OPS = {
  in: ['MO-Forward-SM', 'Alert-SC'],
  out: ['SRI-for-SM', 'MT-Forward-SM', 'Report-SM-Delivery-Status', 'NFDiscover', 'NFRegister', 'NFUpdate'],
};
function sgdOps(m) {
  const g = m && m.sgd && typeof m.sgd === 'object' ? m.sgd : null;
  const side = (key, order) => {
    const o = g && g[key] && typeof g[key] === 'object' ? g[key] : null;
    const keys = [...order, ...Object.keys(o || {}).filter(k => !order.includes(k))];
    // An operation value may be a count or {count|total, ...}: show the count.
    const val = v => (v && typeof v === 'object' ? num(v.count ?? v.total) : num(v));
    return keys.map(op => ({ op, v: o ? val(o[op]) : DASH }));
  };
  return { known: !!g, in: side('operationsIn', SGD_OPS.in), out: side('operationsOut', SGD_OPS.out) };
}
function consistencyBadge(m) {
  const c = m && m.consistency;
  if (!Array.isArray(c)) return { state: 'unknown', text: `consistency ${DASH}`, failed: [] };
  const failed = c.filter(x => !x || x.ok !== true).map(x => ({ name: (x && x.name) || '?', detail: (x && x.detail) || '' }));
  if (!failed.length) return { state: 'ok', text: `consistent (${c.length} check${c.length === 1 ? '' : 's'})`, failed };
  return { state: 'bad', text: `inconsistent: ${failed.map(f => f.name).join(', ')}`, failed };
}
// Inline note after POST /api/metrics/reset ({status, body:{ok, since, clearedMessages}}). Non-2xx: older backend.
function resetNote(res) {
  const ok = !!(res && res.status >= 200 && res.status < 300 && res.body && res.body.ok);
  if (!ok) return { ok: false, text: 'reset not supported by this backend' };
  const d = new Date(res.body.since);
  const at = isNaN(d) ? DASH : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const n = Number(res.body.clearedMessages) || 0;
  return { ok: true, text: `reset at ${at} (${n} message${n === 1 ? '' : 's'} cleared)` };
}
// POST /api/mt body from the MT form (pure: reads form.elements only). srr is always sent explicitly: the backend
// defaults it to true, so an unchecked box must say srr:false.
function mtBody(form) {
  const f = form.elements;
  return { from: f.from.value.trim() || undefined, to: f.to.value.trim(), text: f.text.value, validitySeconds: Number(f.validitySeconds.value),
    singleShot: f.singleShot.checked || undefined, srr: !!(f.srr && f.srr.checked) };
}
// ---------- end flow model ----------

// ---------- flow rendering ----------
const GLYPH_BY_STATE = { fail: '✕', wait: '⏸' };
function chainEl(model, cls = '') {
  const box = el('div', `flow ${cls}`.trim());
  model.nodes.forEach((n, i) => {
    if (i) {
      const e = el('div', `edge ${n.est || n.st || ''}`.trim());
      e.append(el('div', 'ln'), el('div', 'lb', n.edge || ''));
      if (n.back) { const b = el('div', `back ${n.backSt || 'off'}`); b.append(el('div', 'ln'), el('div', 'lb', n.back)); e.append(b); }
      box.append(e);
    }
    const d = el('div', `node ${n.st || ''}${n.end ? ' end' : ''}${n.aux ? ' aux' : ''}`);
    const sub = el('div', 'sub', n.sub); sub.title = n.sub || '';
    d.append(el('div', 'dot', GLYPH_BY_STATE[n.st] || n.glyph), el('div', 'nm', n.nm), sub);
    box.append(d);
  });
  return box;
}
function flowHead(m, title) {
  const h = el('div', 'fh');
  h.append(el('span', `tag ${flowKind(m)}`, flowKind(m)));
  if (isSR(m)) h.append(el('span', 'tag SR', 'SR'));
  h.append(el('span', null, title));
  return h;
}
function flowTitle(m) {
  if (flowKind(m) === 'MO') return 'mobile originated: terminates at the SMSC (stored, RP-ACK, onward delivery simulated)';
  return isSR(m) ? `status report to the originator of ${m.reportFor || '?'}` : 'mobile terminated: SMSC to the UE';
}
// One message's flow (plus its absent path), and for an MO its status report as a separate MT.
function flowBlock(m, { compact = false } = {}) {
  const wrap = el('div', 'flowblock');
  const model = flowModel(m);
  wrap.append(flowHead(m, flowTitle(m)), chainEl(model, model.kind));
  if (model.side) {
    const sh = el('div', `fh side${model.side.taken ? ' taken' : ''}`, `${model.side.label}${model.side.taken ? '' : ' (not taken)'}`);
    wrap.append(sh, chainEl(model.side, `side${compact ? ' compact' : ''}`));
  }
  return wrap;
}
function linkedSrBlock(m) {
  const srId = flowKind(m) === 'MO' ? srIdOf(m) : null;
  if (!srId) return null;
  const sr = messages.find(x => x.id === srId);
  const wrap = el('div', 'flowblock linked');
  const h = el('div', 'fh');
  h.append(el('span', 'tag MT', 'MT'), el('span', 'tag SR', 'SR'), 'status report for this MO, a separate MT: ', refLink(srId));
  const status = (sr && sr.status) || (m.sr && m.sr.status);
  if (status) h.append(' ', stBadge(status));
  wrap.append(h);
  if (sr) wrap.append(chainEl(flowModel(sr), 'MT'));
  else wrap.append(el('div', 'dim', 'not in the polled window: open it to see its flow'));
  return wrap;
}

function renderFlow() {
  const m = messages.find(x => x.id === selectedId) || messages[messages.length - 1];
  const box = $('flow'); box.replaceChildren();
  $('follow').hidden = !selectedId;
  const note = $('flownote'); note.replaceChildren();
  if (!m) { box.append(el('div', 'empty', 'no messages yet: send one below')); $('flowwhat').textContent = ''; return; }
  $('flowwhat').textContent = `${selectedId ? 'selected' : 'latest'}: ${m.id}`;
  box.append(flowBlock(m));
  const linked = linkedSrBlock(m);
  if (linked) box.append(linked);
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
  const total = lastMetrics && lastMetrics.messages ? lastMetrics.messages.total : 0;
  $('msgcount').textContent = `${rows.length} of ${messages.length}${total > messages.length ? ` (newest; ${total} known)` : ''} · ${messages.filter(inStore).length} in store`;
  const tb = $('msgs'); tb.replaceChildren();
  for (const m of rows.slice(0, 150)) {
    const tr = el('tr', `click${m.id === selectedId ? ' sel' : ''}${isSR(m) ? ' sr' : ''}`);
    const dirTd = el('td'); dirTd.append(dirTags(m)); dirTd.title = flowHint(m);
    const txt = el('td', 'txt');
    if (isSR(m)) { txt.append(`↳ report for `, refLink(m.reportFor), ` · TP-ST ${fmtSt(m.st)}`); }
    else {
      txt.append(m.text || '');
      const srr = srrNote(m, messages);
      const srId = flowKind(m) === 'MO' ? srIdOf(m) : null;
      if (srr) {
        txt.append(' '); const s = el('span', `tag srr ${srr.cls}`);
        if (srr.id) s.append(refLink(srr.id, srr.text)); else s.textContent = srr.text;
        txt.append(s);
      } else if (srId) { txt.append(' '); const s = el('span', 'tag SR'); s.append(refLink(srId, `MT SR ${srId}`)); txt.append(s); }
    }
    const stTd = el('td'); stTd.append(stBadge(m.status));
    if (inStore(m)) { const t = el('span', 'tag store', 'in store'); t.title = 'not final yet: held in the SMSC store'; stTd.append(' ', t); }
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
  fact('flow', flowHint(m));
  fact('from', m.from); fact('supi', m.supi); fact('to', m.to); fact('text', m.text);
  if (m.reportFor) fact('report for', refLink(m.reportFor));
  if (srIdOf(m)) fact('status report', refLink(srIdOf(m)));
  if (m.forwardedAt) fact('forwarded', `${hhmmss(m.forwardedAt)} (simulated onward delivery)`);
  if (isSR(m)) { fact('TP-ST', fmtSt(m.st)); fact('TP-RA', m.ra); }
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

  det.append(el('h3', null, `${flowKind(m)} flow`), flowBlock(m, { compact: true }));
  const linked = linkedSrBlock(m);
  if (linked) det.append(linked);
  det.append(el('h3', null, 'history'), timeline(m.history || []));
  if (m.submitHex) det.append(decodedBox('SMS-SUBMIT received from the SMSF', m.submitHex));
  if (m.tpduHex) det.append(decodedBox(isSR(m) ? 'SMS-STATUS-REPORT sent to the SMSF' : 'SMS-DELIVER sent to the SMSF', m.tpduHex));
  if (m.deliveryReportHex) det.append(decodedBox('delivery report from the UE', m.deliveryReportHex));
}

function eventClass(e) {
  if (e.event === 'DELIVERED' || e.event === 'FORWARDED') return 'ok';
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
    const [m, msgs] = await Promise.all([getJson('/api/metrics'), getJson(`/api/messages?limit=${MSG_LIMIT}`)]);
    lastMetrics = m;
    messages = Array.isArray(msgs) ? msgs : [];
    // A pinned message older than the polled window is fetched on its own so the detail view keeps it.
    if (selectedId && !messages.some(x => x.id === selectedId)) {
      const one = await fetch(`${API}/api/messages/${encodeURIComponent(selectedId)}`, { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null)).catch(() => null);
      if (one && one.id === selectedId) messages.unshift(one); else selectedId = null;
    }
    renderHeader(m); renderKpis(m); renderPanels(m); renderPeersResults(m);
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
$('resetbtn').onclick = async () => {
  if (!confirm('Reset all SMSC metrics?')) return;
  const clearMessages = $('resetclear').checked, note = $('resetnote');
  let res;
  try { res = await post('/api/metrics/reset', { clearMessages }); } catch { res = null; }
  const n = resetNote(res);
  note.textContent = n.text; note.className = `resetnote ${n.ok ? 'ok' : 'bad'}`;
  if (n.ok) { if (clearMessages) selectedId = null; while (ticking) await new Promise(r => setTimeout(r, 50)); await tick(); }
};

getJson('/test').then(c => {
  for (const [name, what] of Object.entries(c.moScenarios || {})) {
    const o = el('option', null, `${name} — ${what}`); o.value = name; $('scenarios').append(o);
  }
}).catch(() => {});

tick();
setInterval(tick, 3000);
