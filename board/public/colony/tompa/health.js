// Health tile (FLUX 5faaadcb, winner α×β): NF lights and the canary SMS from /t/tompa/health.
// Hop verdicts from the live logs (γ) were dropped: expected refusals and our own simulated outages read as faults.
'use strict';

if (typeof window !== 'undefined') {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const CLS = { up: 'ok', ok: 'ok', pass: 'ok', green: 'ok', warming: 'warn', amber: 'warn', skip: 'warn',
    degraded: 'bad', down: 'bad', fail: 'bad', red: 'bad' };
  const ago = t => (t ? `${Math.max(0, Math.round((Date.now() - Date.parse(t)) / 1000))} s ago` : '-');

  function render(h) {
    const s = h.summary;
    $('verdict').className = `kpi ${CLS[s.verdict]}`;
    $('verdict').innerHTML = `<div class="v">${esc(s.verdict.toUpperCase())}</div><div class="l">whole chain</div>`
      + `<div class="s">${s.bad.length ? `bad: ${esc(s.bad.join(', '))}. ` : ''}${s.warming.length ? `warming: ${esc(s.warming.join(', '))}. ` : ''}canary: ${esc(s.chain)}</div>`;
    $('nfs').innerHTML = h.nfs.map(n => `<div class="kpi ${CLS[n.verdict]}"><div class="v">${esc(n.node)}</div>`
      + `<div class="l">${esc(n.team)} · ${esc(n.verdict)}${n.inNrf === false ? ' · not in NRF' : ''}</div>`
      + `<div class="s">${esc(n.evidence.join('; '))}</div></div>`).join('');
    const c = h.canary;
    $('canary').innerHTML = !c ? '<span class="meta">not run yet</span>'
      : `<b class="${CLS[c.verdict] === 'ok' ? 'in' : CLS[c.verdict] === 'bad' ? 'err' : 'out'}">${esc(c.verdict.toUpperCase())}</b> `
      + `<span class="meta">${ago(c.ts)}</span><div>${esc(c.got)}</div>`
      + (c.hop ? `<div>hop <b>${esc(c.hop)}</b>, owner @${esc(c.owner)}</div>` : '')
      + (c.report ? `<div class="result">${esc(c.report)}</div>` : '');
    $('ts').textContent = `checked ${new Date(h.checkedAt).toLocaleTimeString()}`;
  }

  async function poll() {
    try { render(await (await fetch('/t/tompa/health')).json()); } catch (e) { $('ts').textContent = `health: ${e.message}`; }
  }
  async function runCanary() {
    $('run').disabled = true;
    try {
      const r = await fetch('/t/tompa/health/canary', { method: 'POST' });
      const h = await r.json();
      render(h);
      if (r.status === 429) $('ts').textContent = `canary runs at most every ${h.canaryMinS} s`;
    } finally { $('run').disabled = false; }
  }

  $('run').onclick = runCanary;
  poll(); setInterval(poll, 10000);
  // Auto canary every 2 minutes while the page is visible; the backend caps it at once per 30 s for everyone.
  setInterval(() => { if ($('auto').checked && !document.hidden) runCanary(); }, 120000);
}
