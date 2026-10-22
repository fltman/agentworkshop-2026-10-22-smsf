// "SMS Space Post": the arcade look. Every live call is an envelope rocket between NF planets.
// Success: lands, +points, combo grows. Failure: it explodes and the combo breaks. INSERT COIN sends a real SMS.
'use strict';

const POINTS = { base: 10, comboStep: 10, maxMult: 8 };
const multiplier = (combo) => Math.min(POINTS.maxMult, 1 + Math.floor(combo / POINTS.comboStep));

function scoreHit(state, ok) {
  if (!ok) return { ...state, combo: 0, lost: state.lost + 1 };
  const combo = state.combo + 1;
  const score = state.score + POINTS.base * multiplier(combo);
  return { ...state, combo, score, best: Math.max(state.best, combo), hi: Math.max(state.hi, score), landed: state.landed + 1 };
}

if (typeof module !== 'undefined') module.exports = { scoreHit, multiplier };

if (typeof window !== 'undefined') {
  const cv = document.getElementById('arcade-canvas');
  const cx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const PL = { UE: [80, 270, '#58a6ff'], AMF: [280, 270, '#3fb950'], SMSF: [500, 270, '#d29922'],
    UDM: [760, 120, '#bc8cff'], SMSC: [760, 430, '#f778ba'], NRF: [500, 70, '#79c0ff'] };
  const stars = Array.from({ length: 140 }, () => [Math.random() * W, Math.random() * H, Math.random() * 1.6 + 0.2]);
  let st = { score: 0, combo: 0, best: 0, hi: Number(localStorage.getItem('tompa-arcade-hi') || 0), landed: 0, lost: 0 };
  const rockets = [], sparks = [], pops = [], queue = [];
  let shake = 0, t0 = performance.now();

  function launch(i) {
    if (!PL[i.from] || !PL[i.to]) return;
    rockets.push({ i, t: 0, speed: 0.008 + Math.random() * 0.006, wob: Math.random() * 6.28 });
  }

  function arrive(r) {
    const [x, y] = PL[r.i.to];
    st = scoreHit(st, r.i.ok);
    localStorage.setItem('tompa-arcade-hi', st.hi);
    if (r.i.ok) {
      pops.push({ x, y: y - 40, text: `+${POINTS.base * multiplier(st.combo)}`, c: '#3fb950', life: 60 });
      for (let k = 0; k < 10; k++) sparks.push({ x, y, vx: Math.cos(k) * 2, vy: Math.sin(k) * 2, life: 30, c: '#3fb950' });
    } else {
      shake = 12;
      pops.push({ x, y: y - 40, text: `${r.i.status || 'FAIL'}! COMBO LOST`, c: '#f85149', life: 90 });
      for (let k = 0; k < 40; k++) {
        const a = Math.random() * 6.28, v = Math.random() * 5 + 1;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 50 + Math.random() * 30, c: k % 2 ? '#f85149' : '#ffa657' });
      }
    }
  }

  function envelope(x, y, ok) {
    cx.fillStyle = ok ? '#e6edf3' : '#ffb4ab';
    cx.fillRect(x - 9, y - 6, 18, 12);
    cx.strokeStyle = '#0f1419'; cx.lineWidth = 1.5;
    cx.beginPath(); cx.moveTo(x - 9, y - 6); cx.lineTo(x, y + 1); cx.lineTo(x + 9, y - 6); cx.stroke();
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (cv.closest('[hidden]')) return;
    const time = (now - t0) / 1000;
    while (queue.length && queue[0].at <= now) launch(queue.shift().i);
    cx.save();
    if (shake > 0) { cx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.85; if (shake < 0.5) shake = 0; }
    cx.fillStyle = '#05070d'; cx.fillRect(-20, -20, W + 40, H + 40);
    for (const s of stars) { s[0] -= s[2] * 0.4; if (s[0] < 0) s[0] = W; cx.fillStyle = `rgba(255,255,255,${s[2] / 2})`; cx.fillRect(s[0], s[1], s[2], s[2]); }
    // orbits
    cx.strokeStyle = 'rgba(88,166,255,0.12)'; cx.setLineDash([4, 6]);
    for (const [a, b] of [['UE', 'AMF'], ['AMF', 'SMSF'], ['SMSF', 'UDM'], ['SMSF', 'SMSC'], ['SMSC', 'UDM'], ['AMF', 'NRF'], ['SMSF', 'NRF'], ['UDM', 'NRF'], ['SMSC', 'NRF']]) {
      cx.beginPath(); cx.moveTo(PL[a][0], PL[a][1]); cx.lineTo(PL[b][0], PL[b][1]); cx.stroke();
    }
    cx.setLineDash([]);
    for (const [n, [x, y, c]] of Object.entries(PL)) {
      const pulse = 34 + Math.sin(time * 2 + x) * 2;
      const g = cx.createRadialGradient(x - 10, y - 10, 4, x, y, pulse);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, c); g.addColorStop(1, '#0b1020');
      cx.fillStyle = g; cx.beginPath(); cx.arc(x, y, pulse, 0, 6.28); cx.fill();
      cx.strokeStyle = c; cx.globalAlpha = 0.4; cx.beginPath(); cx.ellipse(x, y, pulse + 14, 8, -0.3, 0, 6.28); cx.stroke(); cx.globalAlpha = 1;
      cx.fillStyle = '#e6edf3'; cx.font = 'bold 14px ui-monospace, monospace'; cx.textAlign = 'center';
      cx.fillText(n, x, y + pulse + 22);
    }
    for (let k = rockets.length - 1; k >= 0; k--) {
      const r = rockets[k]; r.t += r.speed;
      const [x1, y1] = PL[r.i.from], [x2, y2] = PL[r.i.to];
      const arc = Math.sin(r.t * Math.PI) * 40;
      const x = x1 + (x2 - x1) * r.t, y = y1 + (y2 - y1) * r.t - arc + Math.sin(time * 8 + r.wob) * 2;
      cx.fillStyle = r.i.ok ? 'rgba(63,185,80,0.5)' : 'rgba(248,81,73,0.6)';
      for (let q = 1; q < 6; q++) cx.fillRect(x - (x2 - x1) * 0.012 * q - 2, y + (y2 - y1) * -0.012 * q - 2, 4 - q * 0.5, 4 - q * 0.5);
      envelope(x, y, r.i.ok);
      if (r.t >= 1) { rockets.splice(k, 1); arrive(r); }
    }
    for (let k = sparks.length - 1; k >= 0; k--) {
      const p = sparks[k]; p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life--;
      cx.fillStyle = p.c; cx.globalAlpha = Math.max(0, p.life / 60); cx.fillRect(p.x, p.y, 3, 3); cx.globalAlpha = 1;
      if (p.life <= 0) sparks.splice(k, 1);
    }
    cx.textAlign = 'center'; cx.font = 'bold 16px ui-monospace, monospace';
    for (let k = pops.length - 1; k >= 0; k--) {
      const p = pops[k]; p.y -= 0.6; p.life--;
      cx.fillStyle = p.c; cx.globalAlpha = Math.min(1, p.life / 30); cx.fillText(p.text, p.x, p.y); cx.globalAlpha = 1;
      if (p.life <= 0) pops.splice(k, 1);
    }
    // HUD
    cx.textAlign = 'left'; cx.font = 'bold 20px ui-monospace, monospace'; cx.fillStyle = '#ffd33d';
    cx.fillText(`SCORE ${String(st.score).padStart(6, '0')}`, 16, 30);
    cx.fillStyle = '#8b98a5'; cx.fillText(`HI ${String(st.hi).padStart(6, '0')}`, 16, 56);
    cx.textAlign = 'right'; cx.fillStyle = st.combo >= POINTS.comboStep ? '#ff7b72' : '#e6edf3';
    cx.fillText(`COMBO ${st.combo}  x${multiplier(st.combo)}`, W - 16, 30);
    cx.fillStyle = '#8b98a5'; cx.font = 'bold 14px ui-monospace, monospace';
    cx.fillText(`LANDED ${st.landed}   LOST ${st.lost}   BEST COMBO ${st.best}`, W - 16, 54);
    if (!rockets.length && Math.floor(time * 2) % 2) {
      cx.textAlign = 'center'; cx.fillStyle = '#ffd33d'; cx.font = 'bold 18px ui-monospace, monospace';
      cx.fillText('WAITING FOR TRAFFIC · INSERT COIN', W / 2, H - 20);
    }
    cx.restore();
  }
  requestAnimationFrame(frame);

  window.CoreFeed.subscribe((fresh, first) => {
    const list = first ? fresh.slice(-6) : fresh;
    const now = performance.now();
    list.forEach((i, n) => queue.push({ i, at: now + (n * 2800) / Math.max(1, list.length) }));
  });

  document.getElementById('coin').onclick = async (ev) => {
    const b = ev.currentTarget; b.disabled = true; b.textContent = 'SENDING…';
    try {
      await fetch('/t/tompa/ue/imsi-001010000000001/register', { method: 'POST' });
      const r = await fetch('/t/tompa/ue/imsi-001010000000001/sms', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'msisdn-46700000002', text: 'INSERT COIN' }) });
      b.textContent = r.ok ? 'COIN ACCEPTED' : `TILT ${r.status}`;
    } catch { b.textContent = 'TILT'; }
    setTimeout(() => { b.disabled = false; b.textContent = 'INSERT COIN (send SMS)'; }, 2500);
  };
}
