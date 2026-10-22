'use strict';
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
const svg = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
const fmt = (v, u = '') => (v == null ? '–' : v + u);

function card(label, value, sub, cls) {
  const d = el('div', 'kpi' + (cls ? ' ' + cls : ''));
  d.append(el('div', 'v', value), el('div', 'l', label));
  if (sub) d.append(el('div', 's', sub));
  return d;
}

function chart(win) {
  const c = $('chart'), W = c.clientWidth || 600, H = 180, pad = 20;
  c.setAttribute('viewBox', `0 0 ${W} ${H}`);
  c.replaceChildren();
  const now = Math.floor(Date.now() / 1000);
  const by = new Map((win || []).map(b => [b.t, b]));
  let max = 1;
  for (const b of by.values()) max = Math.max(max, b.ok + b.expected + b.failed);
  const bw = (W - pad) / 60;
  c.append(svg('line', { class: 'axis', x1: pad, y1: H - pad, x2: W, y2: H - pad }),
    svg('text', { x: 0, y: 12 }, String(max)), svg('text', { x: 0, y: H - pad }, '0'),
    svg('text', { x: pad, y: H - 4 }, '-60 s'), svg('text', { x: W - 24, y: H - 4 }, 'now'));
  for (let i = 0; i < 60; i++) {
    const b = by.get(now - 59 + i);
    if (!b) continue;
    let y = H - pad;
    for (const k of ['ok', 'expected', 'failed']) {
      const h = (b[k] / max) * (H - 2 * pad);
      if (!h) continue;
      y -= h;
      c.append(svg('rect', { class: k, x: pad + i * bw + 1, y, width: Math.max(1, bw - 2), height: h }));
    }
  }
}

function render(s) {
  const t = s.totals || { sent: 0, ok: 0, expected: 0, failed: 0, skipped: 0 };
  $('state').textContent = s.running ? `running at ${s.rate} msg/s, ${s.remainingS}s left`
    : s.stoppedBy ? `stopped (${s.stoppedBy})` : 'idle';
  $('start').disabled = false;
  $('stop').disabled = !s.running;
  const sp = s.successPct;
  $('cards').replaceChildren(
    card('State', s.running ? 'running' : 'idle', s.running ? `${s.remainingS}s left` : null, s.running ? 'ok' : null),
    card('Current load', fmt(s.currentRate, '/s'), `target ${fmt(s.rate, '/s')}`),
    card('In flight', fmt(s.inFlight), t.skipped ? `${t.skipped} ticks skipped` : null, t.skipped ? 'warn' : null),
    card('Sent', t.sent),
    card('Success', fmt(sp, ' %'), 'ok + expected refusals', sp == null ? null : sp >= 95 ? 'ok' : sp >= 80 ? 'warn' : 'bad'),
    card('Ok', t.ok, null, 'ok'),
    card('Expected refusals', t.expected),
    card('Failed', t.failed, null, t.failed ? 'bad' : null),
    card('Latency', fmt(s.latencyMs && s.latencyMs.avg, ' ms'), `p95 ${fmt(s.latencyMs && s.latencyMs.p95, ' ms')}, max ${fmt(s.latencyMs && s.latencyMs.max, ' ms')}`),
  );
  const causes = Object.entries(s.causes || {}).sort((a, b) => b[1] - a[1]);
  const box = $('causes');
  box.replaceChildren();
  if (!causes.length) box.append(el('span', 'meta', 'none yet'));
  for (const [k, v] of causes) { const r = el('div', 'cause'); r.append(el('span', null, k), el('span', null, v)); box.append(r); }
  chart(s.window);
}

async function poll() {
  try { render(await (await fetch('/t/tompa/traffic')).json()); } catch (e) { $('state').textContent = `backend unreachable: ${e.message}`; }
}

async function post(path, body) {
  $('start').disabled = true;
  const r = await fetch(`/t/tompa/traffic/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  render(await r.json());
}

$('rate').addEventListener('input', () => { $('rate-v').textContent = $('rate').value; });
$('start').addEventListener('click', () => post('start', { rate: Number($('rate').value), durationS: Number($('dur').value) }));
$('stop').addEventListener('click', () => post('stop'));
poll();
setInterval(poll, 1000);
