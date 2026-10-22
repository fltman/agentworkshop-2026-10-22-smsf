// tompa AMF + UE simulator tile. All peer and board text is rendered with textContent, never innerHTML.
const API = '/t/tompa';
const $ = id => document.getElementById(id);

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(k == null ? '' : String(k)));
  return e;
}

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}

const fmtPct = v => (v == null ? '–' : `${v}%`);
const level = v => (v == null ? '' : v >= 95 ? 'ok' : v >= 70 ? 'warn' : 'bad');

function tile(label, value, sub, cls = '') {
  return el('div', { class: `kpi ${cls}` }, el('div', { class: 'v' }, value), el('div', { class: 'l' }, label), el('div', { class: 's' }, sub || ''));
}

function renderKpi(k) {
  const nrf = $('nrf');
  nrf.textContent = k.nrf.registered ? `NRF registered · HB ok ${k.nrf.heartbeatsOk}` : `NRF not registered (${k.nrf.lastStatus ?? '…'})`;
  nrf.className = `pill ${k.nrf.registered ? 'ok' : 'bad'}`;
  const r = k.registration; const mo = k.moSms; const mt = k.mtSms; const d = k.deliveryReports; const l = k.smsfLatencyMs;
  $('kpis').replaceChildren(
    tile('UEs registered', `${k.ues.registered}/${k.ues.total}`, `${k.ues.smsActive} SMS active · ${k.ues.unreachable} unreachable`),
    tile('SMS activation success', fmtPct(r.smsActivationSuccessPct), `${r.smsActivated}/${r.attempts} (refused ${r.smsRefused})`, level(r.smsActivationSuccessPct)),
    tile('MO SMS success', fmtPct(mo.successPct), `${mo.ok}/${mo.attempts} (failed ${mo.failed})`, level(mo.successPct)),
    tile('MT SMS delivery', fmtPct(mt.deliveryPct), `${mt.delivered}/${mt.received} · 404 ${mt.notFound} · 504 ${mt.notReachable} · 400 ${mt.badRequest}`, level(mt.deliveryPct)),
    tile('Delivery reports', `${d.rpAck}/${d.rpError}`, `RP-ACK / RP-ERROR · uplink ok ${d.uplinkOk}, failed ${d.uplinkFailed}`, d.rpError ? 'warn' : ''),
    tile('SMSF latency', l.avg == null ? '–' : `${l.avg} ms`, `avg · max ${l.max} ms · ${l.calls} calls`),
    tile('Deregistrations', `${k.deregistration.ok}/${k.deregistration.attempts}`, 'ok / attempts'),
    tile('NRF discovery', `${k.nrf.discoveries}`, `misses ${k.nrf.discoveryMisses} · HB failed ${k.nrf.heartbeatsFailed}`, k.nrf.discoveryMisses ? 'warn' : ''),
    tile('Peer faults', `${k.peerFaults.distinct}`, Object.entries(k.peerFaults.byOwner).map(([o, n]) => `${o} ${n}`).join(' · ') || 'none seen', k.peerFaults.distinct ? 'bad' : 'ok'),
  );
  const causes = [
    ...Object.entries(r.causes).map(([c, n]) => [`activation: ${c}`, n]),
    ...Object.entries(mo.causes).map(([c, n]) => [`MO: ${c}`, n]),
  ];
  $('causes').replaceChildren(...(causes.length
    ? causes.sort((a, b) => b[1] - a[1]).map(([c, n]) => el('div', { class: 'cause' }, el('span', {}, c), el('span', {}, n)))
    : [el('div', { class: 'cause' }, el('span', {}, 'none yet'))]));
}

async function act(supi, action, body) {
  const r = await api('POST', `/ue/${encodeURIComponent(supi)}/${action}`, body);
  $('result').textContent = `${action} ${supi} → ${r.status}\n${JSON.stringify(r.body, null, 2)}`;
  refresh();
}

function renderUes(list) {
  $('ues').tBodies[0].replaceChildren(...list.map(u => el('tr', {},
    el('td', {}, u.supi), el('td', {}, u.gpsi),
    el('td', { class: u.state === 'REGISTERED' ? 'on' : 'off' }, u.state),
    el('td', { class: u.smsActive ? 'on' : (u.state === 'REGISTERED' ? 'err' : 'off') }, u.smsActive ? 'active' : (u.lastSmsf && u.lastSmsf.body && u.lastSmsf.body.cause) || '–'),
    el('td', { class: u.reachable ? 'on' : 'err' }, u.reachable ? 'yes' : 'no'),
    el('td', {},
      u.state === 'REGISTERED'
        ? el('button', { onclick: () => act(u.supi, 'deregister') }, 'deregister')
        : el('button', { onclick: () => act(u.supi, 'register') }, 'register'),
      el('button', { onclick: () => act(u.supi, 'reachable', { reachable: !u.reachable }) }, u.reachable ? 'make unreachable' : 'make reachable')),
  )));
  const sel = $('mo-from');
  const keep = sel.value;
  sel.replaceChildren(...list.map(u => el('option', { value: u.supi }, `${u.supi} (${u.gpsi})`)));
  if (keep) sel.value = keep;
  const inbox = list.flatMap(u => u.inbox.map(m => ({ ...m, to: u.gpsi }))).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 8);
  $('inbox').replaceChildren(...(inbox.length
    ? inbox.map(m => el('li', {}, el('div', {}, m.text ?? '(undecoded)'), el('div', { class: 'meta' }, `${m.from} → ${m.to} · ${new Date(m.ts).toLocaleTimeString()}`)))
    : [el('li', { class: 'meta' }, 'no MT SMS yet')]));
}

function renderLog(entries) {
  $('log').tBodies[0].replaceChildren(...entries.slice(0, 40).map(e => el('tr', {},
    el('td', {}, new Date(e.ts).toLocaleTimeString()),
    el('td', { class: e.dir }, e.dir === 'in' ? '←' : '→'),
    el('td', {}, e.peer),
    el('td', {}, `${e.method} ${e.path}`),
    el('td', { class: e.status >= 400 || e.status === 0 ? 'err' : '' }, e.status == null ? '' : e.status),
    el('td', { class: e.diag ? `d-${e.diag.verdict}` : '' }, !e.diag ? '' : e.diag.verdict === 'ok' ? 'ok'
      : e.diag.verdict === 'expected' ? `expected: ${e.diag.finding}` : `${e.diag.hop} @${e.diag.owner}: ${e.diag.finding}`),
  )));
}

function renderFaults(list) {
  $('faults').replaceChildren(...(list.length
    ? list.map(f => el('div', { class: 'fault' },
      el('div', {}, el('b', {}, `@${f.owner}`), ` ${f.hop} ×${f.count}`),
      el('div', {}, f.finding),
      el('div', { class: 'meta' }, `expected: ${f.expected}`),
      el('button', { onclick: () => navigator.clipboard && navigator.clipboard.writeText(f.report) }, 'copy report')))
    : [el('div', { class: 'meta' }, 'no peer faults seen')]));
}

async function refresh() {
  try {
    const [k, u, l, f] = await Promise.all([api('GET', '/kpi'), api('GET', '/ue'), api('GET', '/log'), api('GET', '/faults')]);
    if (k.status === 200) renderKpi(k.body);
    if (u.status === 200) renderUes(u.body);
    if (l.status === 200) renderLog(l.body);
    if (f.status === 200) renderFaults(f.body);
  } catch (e) {
    $('nrf').textContent = `backend unreachable: ${e.message}`;
    $('nrf').className = 'pill bad';
  }
}

$('mo').addEventListener('submit', ev => {
  ev.preventDefault();
  act($('mo-from').value, 'sms', { to: $('mo-to').value, text: $('mo-text').value });
});

refresh();
setInterval(refresh, 3000);
