// "Torget map" look: the 5G core as nodes in The Square's newsreel style; every live call travels its edge,
// green for success, red for failure. Counters per edge since the page opened.
'use strict';

const LAYOUT = { UE: [90, 300], AMF: [300, 300], SMSF: [540, 300], UDM: [800, 140], SMSC: [800, 460], NRF: [540, 80] };
const ROLE = { UE: 'phones', AMF: 'tompa', SMSF: 'krilju', UDM: 'hetoteam', SMSC: 'holminator', NRF: 'smsf-hao' };
const EDGES = [['UE', 'AMF'], ['AMF', 'SMSF'], ['SMSF', 'UDM'], ['SMSF', 'SMSC'], ['SMSC', 'UDM'], ['AMF', 'NRF'], ['SMSF', 'NRF'], ['UDM', 'NRF'], ['SMSC', 'NRF']];
const edgeKey = (a, b) => [a, b].sort().join('-');

if (typeof module !== 'undefined') module.exports = { LAYOUT, EDGES, edgeKey };

if (typeof window !== 'undefined') {
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; return n; };
  const root = document.getElementById('map-svg');
  const ticker = document.getElementById('map-ticker');
  const tally = document.getElementById('map-tally');
  const edges = {}, nodes = {};
  let ok = 0, nok = 0;

  const gEdges = mk('g'), gDots = mk('g'), gNodes = mk('g');
  root.append(gEdges, gDots, gNodes);

  function edge(a, b) {
    const k = edgeKey(a, b);
    if (edges[k]) return edges[k];
    const [x1, y1] = LAYOUT[a], [x2, y2] = LAYOUT[b];
    const line = mk('line', { x1, y1, x2, y2, class: 'm-edge' });
    const label = mk('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 8, class: 'm-count' }, '');
    gEdges.append(line, label);
    return (edges[k] = { line, label, ok: 0, nok: 0 });
  }
  EDGES.forEach(([a, b]) => edge(a, b));

  for (const [n, [x, y]] of Object.entries(LAYOUT)) {
    const g = mk('g', { class: 'm-node', transform: `translate(${x} ${y})` });
    g.append(mk('circle', { r: 46 }), mk('text', { y: 2, class: 'm-name' }, n), mk('text', { y: 20, class: 'm-team' }, ROLE[n]));
    gNodes.append(g); nodes[n] = g;
  }

  function flash(n, cls) {
    const g = nodes[n]; if (!g) return;
    g.classList.remove('hit-ok', 'hit-nok'); void g.getBBox(); g.classList.add(cls);
  }

  function addTicker(i) {
    const li = document.createElement('li');
    li.className = i.ok ? 'ok' : 'nok';
    li.textContent = `${new Date(i.ts).toLocaleTimeString()}  ${i.from} → ${i.to}  ${i.status ?? ''} ${i.label}`;
    ticker.prepend(li);
    while (ticker.children.length > 9) ticker.lastChild.remove();
  }

  function show(i, animate) {
    if (!LAYOUT[i.from] || !LAYOUT[i.to]) return;
    const e = edge(i.from, i.to);
    i.ok ? (e.ok++, ok++) : (e.nok++, nok++);
    e.label.textContent = `${e.ok} ✓${e.nok ? `  ${e.nok} ✗` : ''}`;
    e.line.classList.toggle('m-bad', e.nok > 0);
    tally.textContent = `${ok} OK · ${nok} NOK`;
    const heartbeat = i.ok && (i.to === 'NRF' || i.from === 'NRF') && /PATCH|heartbeat/i.test(i.label);
    if (!heartbeat) addTicker(i);
    if (!animate || document.hidden || root.closest('[hidden]')) return;
    const [x1, y1] = LAYOUT[i.from], [x2, y2] = LAYOUT[i.to];
    const s = i.ok ? 7 : 10;
    const dot = window.CoreFeed.kindOf(i) === 'signal'
      ? mk('polygon', { points: `0,${-s - 2} ${s + 2},0 0,${s + 2} ${-s - 2},0`, class: `m-dot m-sig ${i.ok ? 'ok' : 'nok'}` })
      : mk('circle', { r: s, class: i.ok ? 'm-dot ok' : 'm-dot nok' });
    gDots.append(dot);
    const a = dot.animate([{ transform: `translate(${x1}px, ${y1}px)` }, { transform: `translate(${x2}px, ${y2}px)` }],
      { duration: 1100, easing: 'ease-in-out' });
    a.onfinish = () => { dot.remove(); flash(i.to, i.ok ? 'hit-ok' : 'hit-nok'); };
  }

  // A poll brings up to 3 s of calls at once; replay them spread over that time so they read as traffic.
  window.CoreFeed.subscribe((fresh, first) => {
    const list = fresh; // first poll: count the whole log window, animate only the newest 8
    list.forEach((i, n) => {
      const replay = !first || n >= list.length - 8;
      if (!replay) return show(i, false);
      setTimeout(() => show(i, true), first ? (n - (list.length - 8)) * 350 : (n * 2800) / Math.max(1, list.length));
    });
  });
}
