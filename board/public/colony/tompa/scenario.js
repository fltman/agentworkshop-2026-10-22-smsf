'use strict';
const API = '/t/tompa';
const $ = id => document.getElementById(id);

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
}

function kpi(label, value, cls) {
  const d = el('div', undefined, `kpi ${cls || ''}`);
  d.append(el('div', value, 'v'), el('div', label, 'l'));
  return d;
}

function render(r) {
  const rows = $('rows');
  rows.replaceChildren();
  $('totals').replaceChildren();
  if (r.available && $('step').options.length === 1) {
    for (const s of r.available) { const o = el('option', `${s.step}. ${s.name}`); o.value = s.step; $('step').append(o); }
  }
  if (!r.startedAt) { $('ts').textContent = 'no run yet'; return; }
  $('ts').textContent = `last run ${new Date(r.startedAt).toLocaleTimeString()}${r.only ? ` (step ${r.only})` : ''}`;
  const s = r.summary || {};
  $('totals').append(kpi('pass', s.pass, 'ok'), kpi('fail', s.fail, s.fail ? 'bad' : 'ok'), kpi('skip / pending', s.skip, s.skip ? 'warn' : ''));
  for (const x of r.steps) {
    const tr = el('tr');
    const v = el('td', x.verdict, `d-${x.verdict === 'pass' ? 'ok' : x.verdict === 'fail' ? 'fault' : 'skip'}`);
    tr.append(el('td', x.step), el('td', x.name, 'wrap'), el('td', x.expected, 'wrap'), el('td', x.got, 'wrap'), v,
      el('td', x.hop || ''), el('td', x.owner || ''));
    const act = el('td');
    tr.append(act);
    rows.append(tr);
    if (!x.report) continue;
    const rep = el('tr', undefined, 'rep');
    rep.hidden = true;
    const cell = el('td', x.report);
    cell.colSpan = 8;
    rep.append(cell);
    const btn = el('button', 'fault report');
    btn.onclick = () => { rep.hidden = !rep.hidden; };
    const copy = el('button', 'copy');
    copy.onclick = () => navigator.clipboard && navigator.clipboard.writeText(x.report);
    act.append(btn, copy);
    rows.append(rep);
  }
}

async function load() {
  const r = await fetch(`${API}/scenario`);
  render(await r.json());
}

$('run').onclick = async () => {
  const step = $('step').value;
  $('run').disabled = true;
  $('ts').textContent = 'running… (MT waits up to 5 s per step, MWD up to 8 s)';
  try {
    const r = await fetch(`${API}/scenario/run${step ? `?step=${step}` : ''}`, { method: 'POST' });
    const b = await r.json();
    if (!r.ok) { $('ts').textContent = `${r.status} ${b.cause || ''}: ${b.detail || ''}`; return; }
    render(b);
  } catch (e) { $('ts').textContent = `error: ${e.message}`; } finally { $('run').disabled = false; }
};

load().catch(e => { $('ts').textContent = `error: ${e.message}`; });
