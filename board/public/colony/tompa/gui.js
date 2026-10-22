// Look switcher for the group app: auto-flips every 15 s; a button picks a look and pauses the flip.
'use strict';

const VIEWS = ['classic', 'map', 'arcade'];
const FLIP_MS = 15000;
const nextView = (v) => VIEWS[(VIEWS.indexOf(v) + 1) % VIEWS.length];
const fromHash = (h) => (VIEWS.includes(String(h || '').replace('#', '')) ? String(h).replace('#', '') : null);

if (typeof module !== 'undefined') module.exports = { VIEWS, FLIP_MS, nextView, fromHash };

if (typeof window !== 'undefined') {
  const bar = document.getElementById('looks');
  const autoBtn = document.getElementById('look-auto');
  const left = document.getElementById('look-left');
  let current = 'classic', auto = true, due = Date.now() + FLIP_MS;

  function show(v) {
    current = v;
    for (const name of VIEWS) document.getElementById(`v-${name}`).hidden = name !== v;
    for (const b of bar.querySelectorAll('[data-look]')) b.classList.toggle('on', b.dataset.look === v);
    document.body.dataset.look = v;
  }
  function setAuto(on) {
    auto = on; due = Date.now() + FLIP_MS;
    autoBtn.classList.toggle('on', on);
    autoBtn.textContent = on ? 'auto ⟳' : 'auto ⏸';
    if (on) history.replaceState(null, '', location.pathname);
  }

  for (const b of bar.querySelectorAll('[data-look]')) b.onclick = () => { show(b.dataset.look); setAuto(false); history.replaceState(null, '', '#' + b.dataset.look); };
  autoBtn.onclick = () => setAuto(!auto);
  setInterval(() => {
    if (!auto) { left.textContent = ''; return; }
    const s = Math.max(0, Math.ceil((due - Date.now()) / 1000));
    left.textContent = `next in ${s}s`;
    if (s === 0) { show(nextView(current)); due = Date.now() + FLIP_MS; }
  }, 250);

  const pinned = fromHash(location.hash);
  show(pinned || 'classic'); setAuto(!pinned);
  window.CoreFeed.start();
}
