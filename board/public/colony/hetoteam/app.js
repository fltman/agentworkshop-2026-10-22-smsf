'use strict';
// UDM tile: KPIs from /metrics, registrations and MWD, and the latest log entries.
// Everything shown is built with textContent: log entries carry other teams' payloads.

const API = '/t/hetoteam';
const POLL_MS = 3000;
const LOG_KEEP = 100;

const $ = id => document.getElementById(id);
let logEntries = []; // newest last
let lastLogId = 0;
let firstLoad = true;
let startedAt = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

async function getJson(path) {
  const r = await fetch(API + path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

const fmt = v => (v === null || v === undefined ? '–' : v);
const pct = v => (v === null || v === undefined ? '–' : `${v}%`);
const pctClass = v => (v === null || v === undefined ? '' : v >= 95 ? 'ok' : v >= 80 ? 'warn' : 'bad');
const time = iso => (iso ? new Date(iso).toLocaleTimeString() : '–');
const isOk = s => s >= 200 && s < 300;

function duration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function renderKpis(m) {
  const k = m.kpi;
  const errCls = k.errorRateInPct === null ? '' : k.errorRateInPct > 20 ? 'bad' : k.errorRateInPct > 5 ? 'warn' : 'ok';
  const hbCls = !k.nrfRegistered ? 'bad' : k.nrfHeartbeatAgeSec > k.nrfHeartbeatTimerSec ? 'warn' : 'ok';
  const cards = [
    ['active registrations', k.activeRegistrations, '', `of ${k.provisionedSubscribers} subscribers`],
    ['MWD pending', k.mwdPending, k.mwdPending ? 'warn' : '', 'SC addresses waiting'],
    ['msgs last minute', k.messagesLastMinute, '', 'in + out'],
    ['requests in', k.requestsIn, '', `out: ${k.requestsOut}`],
    ['error rate in', pct(k.errorRateInPct), errCls, 'non-2xx answers'],
    ['avg latency in', k.avgLatencyInMs === null ? '–' : `${k.avgLatencyInMs} ms`, '', 'UDM processing'],
    ['UECM register', pct(k.uecmRegisterSuccessPct), pctClass(k.uecmRegisterSuccessPct), 'success rate'],
    ['SDM get', pct(k.sdmSuccessPct), pctClass(k.sdmSuccessPct), 'success rate'],
    ['SRI-for-SM', pct(k.sriForSmSuccessPct), pctClass(k.sriForSmSuccessPct), `absent subscriber: ${k.sriAbsentSubscriber}`],
    ['alerts to SMSC', `${k.alertsOk}/${k.alertsSent}`, k.alertsSent && k.alertsOk < k.alertsSent ? 'warn' : '', 'ok / sent'],
    ['NRF heartbeat', k.nrfHeartbeatAgeSec === null ? '–' : `${k.nrfHeartbeatAgeSec}s ago`, hbCls, `timer ${k.nrfHeartbeatTimerSec}s`],
  ];
  $('kpis').replaceChildren(...cards.map(([label, value, cls, hint]) => {
    const c = el('div', 'kpi');
    c.append(el('b', cls, fmt(value)), el('span', null, label), el('i', null, hint));
    return c;
  }));

  const nrf = $('nrf');
  nrf.textContent = k.nrfRegistered ? 'NRF registered' : 'NRF not registered';
  nrf.className = `badge ${k.nrfRegistered ? 'ok' : 'bad'}`;
  $('uptime').textContent = `uptime ${duration(m.uptimeSec)}`;
}

function renderOps(m) {
  const rows = Object.entries(m.ops).sort((a, b) => a[1].dir.localeCompare(b[1].dir) || b[1].total - a[1].total);
  $('ops').replaceChildren(...rows.map(([name, o]) => {
    const tr = el('tr');
    tr.append(
      el('td', null, name), el('td', `dir-${o.dir}`, o.dir),
      el('td', 'n', o.total), el('td', 'n', o.ok), el('td', 'n', o.fail),
      el('td', `n ${pctClass(o.successPct)}`, pct(o.successPct)),
      el('td', 'n', fmt(o.avgMs)), el('td', 'n', o.maxMs),
      el('td', `s${String(o.lastStatus)[0]}`, `${o.lastStatus} ${time(o.lastTs)}`),
    );
    tr.title = Object.entries(o.results).map(([r, n]) => `${r}: ${n}`).join(', ');
    return tr;
  }));
  $('ops-empty').classList.toggle('hidden', rows.length > 0);

  const causes = Object.entries(m.causes).sort((a, b) => b[1] - a[1]);
  $('causes').replaceChildren(...(causes.length ? causes.map(([c, n]) => {
    const chip = el('span', 'chip', c);
    chip.append(el('b', null, n));
    return chip;
  }) : [el('span', 'empty', 'No errors.')]));
}

function shortId(id) {
  const td = el('td', null, id ? `${id.slice(0, 8)}…${id.slice(-4)}` : '–');
  if (id) td.title = id;
  return td;
}

function renderRegs(data) {
  const regs = Object.entries(data.registrations || {});
  $('regs').replaceChildren(...regs.map(([supi, r]) => {
    const tr = el('tr');
    tr.append(
      el('td', null, supi),
      shortId(r.smsfInstanceId),
      el('td', null, r.smsfMAPAddress || '–'),
      el('td', 't', time(r.registrationTime)),
    );
    return tr;
  }));
  $('regs-empty').classList.toggle('hidden', regs.length > 0);

  const mwd = Object.entries(data.mwd || {});
  $('mwd').replaceChildren(...mwd.map(([supi, w]) => {
    const tr = el('tr');
    tr.append(el('td', null, supi), el('td', null, (w.scAddresses || []).join(', ')),
      el('td', null, w.mnrf ? 'yes' : 'no'), el('td', null, w.mcef ? 'yes' : 'no'));
    return tr;
  }));
  $('mwd-empty').classList.toggle('hidden', mwd.length > 0);
}

function shortPath(p) {
  try { const u = new URL(p); return u.pathname + u.search; } catch { return p; }
}

function logItem(e, fresh) {
  const li = el('li', fresh ? 'fresh' : '');
  li.dataset.id = e.id;
  li.dataset.dir = e.dir;
  li.dataset.err = e.dir !== 'note' && !isOk(e.status) ? '1' : '';
  const d = el('details');
  const s = el('summary');
  s.append(
    el('span', 't', time(e.ts)),
    el('span', `dir-${e.dir}`, e.dir === 'in' ? '◀ in' : e.dir === 'out' ? '▶ out' : '• note'),
    el('span', null, e.peer || ''),
    el('span', null, e.method || ''),
    el('span', 'path', shortPath(e.path || '')),
  );
  if (e.status !== undefined) s.append(el('span', `s${String(e.status)[0]}`, e.status === 0 ? 'no answer' : e.status));
  if (e.ms !== undefined) s.append(el('span', 'ms', `${e.ms} ms`));
  d.append(s);
  for (const [label, body] of [['request', e.request], ['response', e.response]]) {
    if (body === undefined || body === null) continue;
    const pre = el('pre', null, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    pre.dataset.label = label;
    d.append(pre);
  }
  li.append(d);
  return li;
}

function applyFilters() {
  const show = { in: $('f-in').checked, out: $('f-out').checked, note: $('f-note').checked };
  const errOnly = $('f-err').checked;
  for (const li of $('log').children) {
    li.classList.toggle('hidden', !show[li.dataset.dir] || (errOnly && !li.dataset.err));
  }
}

function renderLog(newOnes) {
  if (newOnes.length) {
    const list = $('log');
    const open = new Set([...list.querySelectorAll('details[open]')].map(d => d.parentElement.dataset.id));
    const fresh = new Set(firstLoad ? [] : newOnes.map(e => e.id));
    list.replaceChildren(...logEntries.slice().reverse().map(e => {
      const li = logItem(e, fresh.has(e.id));
      if (open.has(String(e.id))) li.firstChild.open = true;
      return li;
    }));
    applyFilters();
  }
  $('log-empty').classList.toggle('hidden', logEntries.length > 0);
  $('logcount').textContent = logEntries.length ? `(newest first, ${logEntries.length} shown)` : '';
}

async function poll() {
  try {
    const m = await getJson('/metrics');
    // The plugin restarted and its log ids started over: start the list over too.
    if (startedAt && m.since !== startedAt) { logEntries = []; lastLogId = 0; }
    startedAt = m.since;
    const [regs, newLog] = await Promise.all([getJson('/registrations'), getJson(`/log?since=${lastLogId}`)]);
    logEntries = logEntries.concat(newLog).slice(-LOG_KEEP);
    if (newLog.length) lastLogId = newLog[newLog.length - 1].id;
    renderKpis(m);
    renderOps(m);
    renderRegs(regs);
    renderLog(newLog);
    firstLoad = false;
    $('conn').textContent = `updated ${new Date().toLocaleTimeString()}`;
    $('conn').className = 'badge dim';
  } catch (e) {
    $('conn').textContent = `offline: ${e.message}`;
    $('conn').className = 'badge bad';
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

for (const id of ['f-in', 'f-out', 'f-note', 'f-err']) $(id).addEventListener('change', applyFilters);
poll();
