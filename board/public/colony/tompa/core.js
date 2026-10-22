// 5G Core KPI dashboard: one summary per NF, read from each team's own KPI endpoint.
// A team's common GET /t/<team>/kpi ({nf, up, requests, errors, latencyMs, extra}) wins;
// otherwise a per-team adapter normalises its native format.
'use strict';

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const sumBy = (obj, f) => Object.values(obj || {}).reduce((s, v) => s + (f(v) || 0), 0);

function summary(nf, team, s) {
  const requests = s.requests ?? null;
  const errors = s.errors ?? null;
  return {
    nf, team,
    up: s.up ?? null,
    nrfRegistered: s.nrfRegistered ?? null,
    requests, errors,
    errorPct: s.errorPct ?? (requests ? pct(errors || 0, requests) : null),
    latencyMs: s.latencyMs ?? null,
    extra: s.extra || {},
  };
}

function parseProm(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{([^}]*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels = {};
    (m[3] || '').replace(/(\w+)="([^"]*)"/g, (_, k, v) => { labels[k] = v; });
    out.push({ name: m[1], labels, value: Number(m[4]) });
  }
  return out;
}

const ADAPTERS = {
  // AMF + UE sim (tompa) GET /kpi
  tompa: { nf: 'AMF', path: 'kpi', type: 'json', read(k) {
    const reg = k.registration || {}, mo = k.moSms || {}, mt = k.mtSms || {};
    const requests = (reg.attempts || 0) + (mo.attempts || 0) + (k.deregistration?.attempts || 0) + (mt.received || 0);
    const errors = (reg.smsRefused || 0) + (mo.failed || 0) + (mt.notFound || 0) + (mt.notReachable || 0) + (mt.badRequest || 0);
    return { up: true, nrfRegistered: k.nrf?.registered, requests, errors, latencyMs: k.smsfLatencyMs?.avg,
      extra: { 'UEs registered': `${k.ues?.registered ?? 0}/${k.ues?.total ?? 0}`, 'SMS active': k.ues?.smsActive,
        'MO ok': `${mo.ok || 0}/${mo.attempts || 0}`, 'MT delivered': `${mt.delivered || 0}/${mt.received || 0}`,
        'Peer faults': k.peerFaults?.distinct } };
  } },
  // SMSF (krilju) GET /metrics
  krilju: { nf: 'SMSF', path: 'metrics', type: 'json', read(k) {
    const all = { ...k.inbound, ...Object.fromEntries(Object.entries(k.outbound || {}).map(([p, v]) => ['→' + p, v])) };
    const requests = sumBy(all, (v) => v.count), errors = sumBy(all, (v) => v.errors);
    const inb = k.inbound || {}, inN = sumBy(inb, (v) => v.count);
    return { up: true, nrfRegistered: k.registeredInNrf, requests, errors,
      latencyMs: inN ? Math.round(sumBy(inb, (v) => v.ms) / inN) : null,
      extra: { 'UE contexts': k.ueContexts, 'Pending MT': k.pendingMt, Uptime: `${k.uptimeSeconds}s`,
        ...Object.fromEntries(Object.entries(inb).map(([op, v]) => [op, `${v.count - v.errors}/${v.count} ok`])) } };
  } },
  // UDM (hetoteam) GET /metrics
  hetoteam: { nf: 'UDM', path: 'metrics', type: 'json', read(m) {
    const k = m.kpi || {};
    const requests = sumBy(m.ops, (v) => v.total), errors = sumBy(m.ops, (v) => v.fail);
    return { up: true, nrfRegistered: k.nrfRegistered, requests, errors, latencyMs: k.avgLatencyInMs,
      extra: { Subscribers: k.provisionedSubscribers, 'Active regs': k.activeRegistrations, 'MWD pending': k.mwdPending,
        'UECM ok %': k.uecmRegisterSuccessPct, 'SDM ok %': k.sdmSuccessPct, 'SRI-for-SM ok %': k.sriForSmSuccessPct } };
  } },
  // SMSC (holminator) GET /metrics, Prometheus text
  holminator: { nf: 'SMSC', path: 'metrics', type: 'text', read(text) {
    const s = parseProm(text);
    const one = (n) => s.find((x) => x.name === n)?.value;
    const sum = (n) => s.filter((x) => x.name === n).reduce((a, x) => a + x.value, 0);
    const requests = sum('smsc_peer_requests_in_total') + sum('smsc_peer_requests_out_total');
    const latSum = sum('smsc_peer_latency_ms_sum'), latN = sum('smsc_peer_requests_out_total');
    const results = s.filter((x) => x.name === 'smsc_results_total');
    const extra = { Uptime: `${one('smsc_uptime_seconds')}s`, 'Heartbeats ok': one('smsc_nrf_heartbeats_ok_total') };
    for (const r of results) if (!/NF(Register|Update)/.test(r.labels.operation)) extra[`${r.labels.operation} ${r.labels.result}`] = r.value;
    return { up: one('smsc_up') === 1, nrfRegistered: one('smsc_nrf_registered') === 1, requests,
      errors: sum('smsc_peer_errors_total'), latencyMs: latN ? Math.round(latSum / latN) : null, extra };
  } },
  // NRF (smsf-hao) GET /status
  'smsf-hao': { nf: 'NRF', path: 'status', type: 'json', read(st) {
    const c = st.counters || {};
    const insts = st.instances || [];
    const requests = (c.register || 0) + (c.update || 0) + (c.deregister || 0) + (c.discover || 0) + (c.rejected || 0);
    return { up: true, nrfRegistered: null, requests, errors: c.rejected || 0, latencyMs: null,
      extra: { 'NFs registered': insts.filter((i) => i.nfStatus === 'REGISTERED').length,
        Types: Object.keys(st.byType || {}).join(', '), Discoveries: c.discover, Heartbeats: c.update } };
  } },
};

function fromCommon(team, k) {
  return summary(k.nf || ADAPTERS[team]?.nf || team, team, k);
}

function fromAdapter(team, body) {
  const a = ADAPTERS[team];
  return summary(a.nf, team, a.read(body));
}

function totals(rows) {
  const live = rows.filter((r) => r.up);
  const requests = live.reduce((s, r) => s + (r.requests || 0), 0);
  const errors = live.reduce((s, r) => s + (r.errors || 0), 0);
  return { nfsUp: live.length, nfs: rows.length, nrfRegistered: live.filter((r) => r.nrfRegistered).length,
    requests, errors, errorPct: pct(errors, requests) };
}

async function loadOne(team) {
  try {
    const r = await fetch(`/t/${team}/kpi`);
    if (r.ok && team !== 'tompa') {
      const k = await r.json();
      if (k && 'requests' in k) return { ...fromCommon(team, k), source: 'common /kpi' };
    }
  } catch { /* fall through to adapter */ }
  const a = ADAPTERS[team];
  try {
    const r = await fetch(`/t/${team}/${a.path}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = a.type === 'text' ? await r.text() : await r.json();
    return { ...fromAdapter(team, body), source: `/${a.path}` };
  } catch (e) {
    return { ...summary(a.nf, team, { up: false }), source: `/${a.path}`, error: e.message };
  }
}

if (typeof module !== 'undefined') module.exports = { ADAPTERS, parseProm, fromCommon, fromAdapter, totals, summary, loadOne };

// ---- browser ----
if (typeof document !== 'undefined' && document.getElementById('rows')) {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const fmt = (v, unit = '') => (v == null ? '–' : v + unit);
  const cls = (r) => (!r.up ? 'bad' : r.errorPct > 10 ? 'bad' : r.errorPct > 0 ? 'warn' : 'ok');

  function card(label, value, sub, c) {
    const d = el('div', 'kpi' + (c ? ' ' + c : ''));
    d.append(el('div', 'v', value), el('div', 'l', label));
    if (sub) d.append(el('div', 's', sub));
    return d;
  }

  async function refresh() {
    const rows = await Promise.all(Object.keys(ADAPTERS).map(loadOne));
    const t = totals(rows);
    $('totals').replaceChildren(
      card('NFs up', `${t.nfsUp}/${t.nfs}`, null, t.nfsUp === t.nfs ? 'ok' : 'bad'),
      card('Registered in NRF', `${t.nrfRegistered}/${t.nfs - 1}`, 'excluding the NRF', t.nrfRegistered >= t.nfs - 1 ? 'ok' : 'warn'),
      card('Requests', t.requests),
      card('Errors', t.errors, fmt(t.errorPct, ' %'), t.errors ? 'warn' : 'ok'),
    );
    const tb = $('rows'); tb.replaceChildren();
    for (const r of rows) {
      const tr = el('tr');
      tr.append(el('td', null, r.nf), el('td', 'meta', r.team),
        el('td', r.up ? 'on' : 'err', r.up ? 'up' : `down${r.error ? ' (' + r.error + ')' : ''}`),
        el('td', r.nrfRegistered === false ? 'err' : r.nrfRegistered ? 'on' : 'off', r.nrfRegistered == null ? '–' : r.nrfRegistered ? 'yes' : 'no'),
        el('td', null, fmt(r.requests)), el('td', r.errors ? 'err' : null, fmt(r.errors)),
        el('td', 'd-' + { bad: 'fault', warn: 'warn', ok: 'ok' }[cls(r)], fmt(r.errorPct, ' %')), el('td', null, fmt(r.latencyMs, ' ms')),
        el('td', 'meta', r.source));
      tb.append(tr);
    }
    const nodes = $('nodes'); nodes.replaceChildren();
    for (const r of rows) {
      const c = el('div', 'card');
      c.append(el('h2', null, `${r.nf} `)); c.firstChild.append(el('small', null, r.team));
      for (const [k, v] of Object.entries(r.extra)) {
        if (v == null || v === '') continue;
        const line = el('div', 'cause'); line.append(el('span', null, k), el('span', 'v', v)); c.append(line);
      }
      nodes.append(c);
    }
    $('ts').textContent = 'updated ' + new Date().toLocaleTimeString();
  }

  refresh();
  setInterval(() => { if ($('live').checked) refresh(); }, 5000);
}
