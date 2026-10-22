// Live call flow for 5G Core Light, built from each team's public /log (FLUX 05f8eb0a-γ, cross-peer trace).
// A message is drawn from the sender's log; the receiver's log is used only when the sender has none
// (SMSC, UE trigger). All peer text goes through textContent, never innerHTML.
const LANES = ['UE', 'AMF', 'SMSF', 'UDM', 'SMSC', 'NRF'];
const PEER = { trigger: 'UE', ue: 'UE', amf: 'AMF', smsf: 'SMSF', udm: 'UDM', smsc: 'SMSC', nrf: 'NRF' };
const HAS_LOG = new Set(['AMF', 'SMSF', 'UDM']); // senders whose own log we trust for their requests
const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

function short(p) {
  if (!p) return '';
  let s = String(p).replace(/https?:\/\/[^/\s]+(\/t\/[^/\s?]+)?/g, '');
  const t = s.match(/target-nf-type=([A-Z_]+)/);
  s = s.split('?')[0];
  return t ? `${s} (${t[1]})` : s;
}

// Each source maps to events {ts, from, to, kind:'req'|'res', label, status, body, diag, src}.
const SOURCES = [
  { name: 'tompa', node: 'AMF', url: '/t/tompa/log', parse(list) {
    const ev = [];
    for (const e of list) {
      const peer = PEER[e.peer];
      if (!peer) continue;
      if (e.dir === 'out') ev.push({ ts: e.ts, from: 'AMF', to: peer, kind: 'req', label: `${e.method} ${short(e.path)}`, body: e.body });
      else if (e.status != null) ev.push({ ts: e.ts, from: peer, to: 'AMF', kind: 'res', label: `${e.status} ${e.method} ${short(e.path)}`, status: e.status, body: e.body, diag: e.diag });
      else if (peer === 'UE') ev.push({ ts: e.ts, from: 'UE', to: 'AMF', kind: 'req', label: `NAS ${short(e.path).replace(/^\/ue\/[^/]+\//, '')} (${(e.path.match(/imsi-\d+/) || [''])[0]})`, body: e.body });
      else if (!HAS_LOG.has(peer) || !krilju.ok) ev.push({ ts: e.ts, from: peer, to: 'AMF', kind: 'req', label: `${e.method} ${short(e.path)}`, body: e.body, diag: e.diag });
      else if (e.diag) ev.push({ ts: e.ts, from: peer, to: 'AMF', kind: 'req', label: `${e.method} ${short(e.path)}`, body: e.body, diag: e.diag, merge: true });
    }
    return ev;
  } },
  { name: 'krilju', node: 'SMSF', url: '/t/krilju/log?limit=200', parse(list) {
    const ev = [];
    for (const e of list) {
      const peer = PEER[e.peer];
      if (!peer) continue;
      const m = String(e.what || '').match(/^(\d{3}) (.*)$/);
      if (e.dir === 'out' && !m) ev.push({ ts: e.ts, from: 'SMSF', to: peer, kind: 'req', label: short(e.what), body: e.data });
      else if (e.dir === 'in' && m) ev.push({ ts: e.ts, from: peer, to: 'SMSF', kind: 'res', label: `${m[1]} ${short(m[2])}`, status: +m[1], body: e.data });
      else if (e.dir === 'in' && !HAS_LOG.has(peer)) ev.push({ ts: e.ts, from: peer, to: 'SMSF', kind: 'req', label: short(e.what), body: e.data });
      else if (e.dir === 'out' && m && !HAS_LOG.has(peer)) ev.push({ ts: e.ts, from: 'SMSF', to: peer, kind: 'res', label: `${m[1]} ${m[2]}`, status: +m[1], body: e.data });
    }
    return ev;
  } },
  { name: 'hetoteam', node: 'UDM', url: '/t/hetoteam/log', parse(list) {
    const ev = [];
    for (const e of list) {
      const peer = PEER[e.peer];
      if (!peer) continue;
      const label = `${e.method} ${short(e.path)}`;
      if (e.dir === 'out') {
        ev.push({ ts: e.ts, from: 'UDM', to: peer, kind: 'req', label, body: e.request });
        if (e.status != null) ev.push({ ts: e.ts, from: peer, to: 'UDM', kind: 'res', label: `${e.status} ${label}`, status: e.status, body: e.response, dt: e.ms });
      } else if (!HAS_LOG.has(peer)) {
        ev.push({ ts: e.ts, from: peer, to: 'UDM', kind: 'req', label, body: e.request });
        if (e.status != null) ev.push({ ts: e.ts, from: 'UDM', to: peer, kind: 'res', label: `${e.status} ${label}`, status: e.status, body: e.response, dt: e.ms });
      }
    }
    return ev;
  } },
  { name: 'holminator', node: 'SMSC', url: '/t/holminator/log', parse(list) {
    const ev = [];
    for (const e of list) {
      const peer = PEER[e.peer];
      if (!peer || e.dir !== 'out') continue;
      ev.push({ ts: e.ts, from: 'SMSC', to: peer, kind: 'req', label: `${e.method} ${short(e.path)}`, body: e.body });
    }
    return ev;
  } },
];
const krilju = { ok: false }; // whether the SMSF log is reachable, so the AMF view can fill in when it is not

async function load(src) {
  try {
    const r = await fetch(src.url);
    if (!r.ok) return { src, ok: false, why: r.status };
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j && (j.log || j.entries)) || [];
    if (src.name === 'krilju') krilju.ok = true;
    return { src, ok: true, events: src.parse(list).map(e => ({ ...e, src: src.name })) };
  } catch (e) {
    return { src, ok: false, why: e.message };
  }
}

function isHeartbeat(e) { return e.to === 'NRF' || e.from === 'NRF' ? /PATCH|heartbeat/i.test(e.label) : false; }

function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = String(text);
  return n;
}

function draw(events) {
  const s = $('flow');
  const W = Math.max(900, $('wrap').clientWidth - 4);
  const left = 70; const gap = (W - left - 30) / (LANES.length - 1); const top = 40; const row = 24;
  const x = l => left + LANES.indexOf(l) * gap;
  const H = top + events.length * row + 20;
  s.setAttribute('width', W); s.setAttribute('height', H);
  const defs = svg('defs');
  for (const [id, color] of [['a-req', '#58a6ff'], ['a-res', '#8b98a5'], ['a-err', '#f85149']]) {
    const m = svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
    defs.append(m);
  }
  const kids = [defs];
  for (const l of LANES) {
    kids.push(svg('text', { x: x(l), y: 20, 'text-anchor': 'middle', class: 'lane-h' }, l));
    kids.push(svg('line', { x1: x(l), y1: 28, x2: x(l), y2: H, class: 'lane' }));
  }
  events.forEach((e, i) => {
    const y = top + i * row + 12;
    const bad = e.status === 0 || e.status >= 400 || (e.diag && e.diag.verdict === 'fault');
    const g = svg('g', { class: 'row' });
    g.append(svg('rect', { x: 0, y: y - 14, width: W, height: row, fill: 'transparent' }));
    g.append(svg('text', { x: 4, y: y + 4, class: 'ts' }, new Date(e.ts).toLocaleTimeString()));
    const x1 = x(e.from); const x2 = x(e.to);
    const cls = e.diag && e.diag.verdict === 'fault' ? 'fault' : bad ? 'err' : e.kind;
    g.append(svg('line', { x1, y1: y, x2: x2 + (x2 > x1 ? -2 : 2), y2: y, class: cls, 'marker-end': `url(#a-${bad ? 'err' : e.kind})` }));
    const label = e.diag && e.diag.verdict === 'fault' ? `${e.label}  ⚠ ${e.diag.finding}` : e.label;
    g.append(svg('text', { x: (x1 + x2) / 2, y: y - 3, 'text-anchor': 'middle', class: bad ? 'err' : '' }, label.length > 70 ? `${label.slice(0, 67)}…` : label));
    g.addEventListener('click', () => detail(e));
    kids.push(g);
  });
  s.replaceChildren(...kids);
}

function detail(e) {
  const d = $('detail');
  const head = document.createElement('div');
  head.textContent = `${new Date(e.ts).toLocaleTimeString()}  ${e.from} → ${e.to}  ${e.label}  (from ${e.src} log${e.dt != null ? `, ${e.dt} ms` : ''})`;
  const kids = [head];
  if (e.diag) {
    const diag = document.createElement('div');
    diag.className = e.diag.verdict === 'fault' ? 'meta err' : 'meta';
    diag.textContent = e.diag.verdict === 'fault' ? `fault on ${e.diag.hop}, owner @${e.diag.owner}: ${e.diag.finding} (expected ${e.diag.expected})` : `diagnosis: ${e.diag.verdict}${e.diag.finding ? `, ${e.diag.finding}` : ''}`;
    kids.push(diag);
  }
  const pre = document.createElement('pre');
  pre.className = 'result';
  pre.style.maxHeight = '260px';
  pre.textContent = e.body == null ? '(no body)' : JSON.stringify(e.body, null, 2);
  kids.push(pre);
  d.replaceChildren(...kids);
}

async function refresh() {
  krilju.ok = false;
  const k = await load(SOURCES[1]);
  const rest = await Promise.all([SOURCES[0], SOURCES[2], SOURCES[3]].map(load));
  const results = [rest[0], k, rest[1], rest[2]];
  $('sources').replaceChildren(...results.map(r => {
    const span = document.createElement('span');
    span.className = `src ${r.ok ? 'ok' : 'bad'}`;
    span.textContent = r.ok ? `${r.src.node} log ✓` : `${r.src.node} log ✗ (${r.why})`;
    span.title = r.src.url;
    return span;
  }));
  let ev = results.flatMap(r => (r.ok ? r.events : []));
  // A tompa diag on an SMSF request is merged onto the SMSF's own arrow for the same N1N2.
  const merges = ev.filter(e => e.merge);
  ev = ev.filter(e => !e.merge);
  for (const m of merges) {
    const twin = ev.find(e => e.from === m.from && e.to === m.to && e.kind === 'req' && Math.abs(Date.parse(e.ts) - Date.parse(m.ts)) < 1000);
    if (twin) twin.diag = m.diag; else ev.push(m);
  }
  if (!$('hb').checked) ev = ev.filter(e => !isHeartbeat(e));
  if (!$('nrf').checked) ev = ev.filter(e => e.from !== 'NRF' && e.to !== 'NRF');
  const q = $('q').value.trim().toLowerCase();
  if (q) ev = ev.filter(e => `${e.label} ${JSON.stringify(e.body || '')}`.toLowerCase().includes(q));
  ev.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  draw(ev.slice(-Number($('n').value)));
}

for (const id of ['hb', 'nrf', 'n']) $(id).addEventListener('change', refresh);
$('q').addEventListener('input', refresh);
refresh();
setInterval(() => { if ($('live').checked) refresh(); }, 3000);
