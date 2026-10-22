#!/usr/bin/env node
'use strict';
// 5G Core Light, standalone. Boots EVERY team's network function in one Node process with no
// npm dependencies, no internet and no board: just the group's core and its tiles.
//
//   node projects/smsf-hao/app/core.js [--port 8787] [--fresh] [--only smsf-hao,krilju]
//
// Why this exists: the NFs are written as plugins for the shared board server, and each one
// resolves its peers through an absolute base URL baked in at module load. Point that base URL
// at ourselves before requiring them and the whole chain runs locally, unchanged. Nothing here
// modifies another team's code — it is read from board/plugins/ exactly as deployed.

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
};

const PORT = Number(flag('--port', process.env.PORT || 8787));
const FRESH = args.includes('--fresh');
const SELF = process.env.CORE_HOST_URL || `http://127.0.0.1:${PORT}`;

// Every NF reads its base URL once, at require() time. These two assignments must therefore
// happen before the first require of a plugin, which is why loading is deferred into boot().
process.env.SMSF_BOARD_URL = SELF;
process.env.TOMPA_BOARD_URL = SELF;

const REPO = path.resolve(__dirname, '..', '..', '..');
const PLUGINS = process.env.PLUGINS_DIR || path.join(REPO, 'board', 'plugins');
const COLONY = process.env.COLONY_DIR || path.join(REPO, 'board', 'public', 'colony');
const DATA = process.env.CORE_DATA_DIR || path.join(__dirname, '.data');

// The whole group's core. The NRF comes first so the others can register on their first attempt
// instead of falling back to the 10 s retry.
const ALL = [
  { team: 'smsf-hao', nf: 'NRF', role: 'registration and discovery, TS 29.510' },
  { team: 'hetoteam', nf: 'UDM', role: 'subscriber data: UECM, SDM, SRI-for-SM, MWD and alerts' },
  { team: 'holminator', nf: 'SMSC', role: 'store and forward, TPDU codec, status reports' },
  { team: 'krilju', nf: 'SMSF', role: 'SMS service, RP layering in both directions' },
  { team: 'tompa', nf: 'AMF', role: 'access and mobility, plus the UE simulator' },
];
const only = flag('--only', '');
const NFS = only ? ALL.filter(n => only.split(',').map(s => s.trim()).includes(n.team)) : ALL;

// ---------- the board, reduced to what a network function actually uses ----------
// Only the NRF calls into this, and only to announce a registration. Keeping the messages in
// memory means a standalone run never reaches the network and never writes to the real Square.
const feed = [];
const subscribers = new Set();
let seq = 0;

function post(text, channel = 'square', reply_to = null, from = 'core') {
  const m = { id: ++seq, ts: new Date().toISOString(), from, channel, text: String(text), reply_to };
  feed.push(m);
  if (feed.length > 500) feed.shift();
  if (process.env.CORE_QUIET !== '1') console.log(`  #${m.channel} ${m.from}: ${m.text}`);
  for (const fn of subscribers) {
    try { const r = fn(m); if (r && r.catch) r.catch(() => {}); } catch { /* a listener must not break a post */ }
  }
  return m;
}

function boardApi(team) {
  return {
    post: (text, channel, reply_to) => post(text, channel, reply_to, team),
    query: (params = {}) => feed.filter(m =>
      (!params.channel || m.channel === params.channel) &&
      (!params.q || m.text.includes(params.q)) &&
      (!params.mention || m.text.includes('@' + params.mention))
    ).slice(-(Number(params.limit) || 50)),
    channels: () => [...new Set(feed.map(m => m.channel))].map(name => ({ name })),
    agents: () => NFS.map(n => ({ team: n.team, nf: n.nf })),
    subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); },
    roster: () => ({}),
    activity: () => ({ teams: {}, senaste: [] }),
    evolution: () => [],
    spores: () => [],
  };
}

// ---------- plugins ----------
const loaded = new Map();

function loadPlugins() {
  if (FRESH && fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
  for (const nf of NFS) {
    const entry = path.join(PLUGINS, nf.team, 'index.js');
    if (!fs.existsSync(entry)) { console.error(`  ${nf.nf.padEnd(5)} ${nf.team}: no plugin at ${entry}`); continue; }
    try {
      const mod = require(entry);
      const dataDir = path.join(DATA, nf.team);
      fs.mkdirSync(dataDir, { recursive: true });
      const ctx = { team: nf.team, board: boardApi(nf.team), dataDir };
      loaded.set(nf.team, { mod, ctx, nf });
      if (typeof mod.onMessage === 'function') {
        subscribers.add(m => {
          try { const r = mod.onMessage(m, ctx); if (r && r.catch) r.catch(e => console.error(`[${nf.team}] onMessage:`, e.message)); }
          catch (e) { console.error(`[${nf.team}] onMessage:`, e.message); }
        });
      }
      if (typeof mod.init === 'function') {
        try { mod.init(ctx); } catch (e) { console.error(`[${nf.team}] init:`, e.message); }
      }
      console.log(`  ${nf.nf.padEnd(5)} ${nf.team.padEnd(11)} /t/${nf.team}/`);
    } catch (e) {
      console.error(`  ${nf.nf.padEnd(5)} ${nf.team}: could not load — ${e.message}`);
    }
  }
}

const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };

async function servePlugin(req, res, url) {
  const [, , team, ...rest] = url.pathname.split('/').map(decode);
  const p = loaded.get(team);
  if (!p || typeof p.mod.handle !== 'function') return json(res, 404, { error: `no network function for ${team}` });
  try {
    const handled = await p.mod.handle(req, res, { ...p.ctx, path: '/' + rest.join('/'), url });
    if (!handled && !res.headersSent) json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`[${team}] handle:`, e.message);
    if (!res.headersSent) json(res, 500, { error: `${team}: ${e.message}` });
  }
}

// ---------- static tiles ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function serveColony(req, res, url) {
  const rel = decode(url.pathname.replace(/^\/colony\/?/, ''));
  // Resolve, then prove the result is still inside the colony folder: a path such as
  // /colony/../../../etc/passwd must not escape, however it was encoded.
  const target = path.resolve(COLONY, rel || '.');
  if (target !== COLONY && !target.startsWith(COLONY + path.sep)) return json(res, 403, { error: 'forbidden' });
  let file = target;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function json(res, code, body) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

// ---------- the front page ----------
// Built from our own constants only. No board text reaches it, so there is nothing to escape.
function indexPage() {
  const cards = NFS.filter(n => loaded.has(n.team)).map(n => `
    <article>
      <h2>${n.nf} <small>${n.team}</small></h2>
      <p>${n.role}</p>
      <p class="links"><a href="/colony/${n.team}/">tile</a><a href="/t/${n.team}/status">status</a></p>
    </article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>5G Core Light — standalone</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root { --bg:#0d1117; --fg:#c9d1d9; --dim:#8b949e; --line:#30363d; --acc:#58a6ff; --ok:#3fb950; }
 * { box-sizing:border-box; }
 body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
 header { padding:22px 20px 8px; border-bottom:1px solid var(--line); }
 h1 { margin:0; font-size:18px; } h1 small { color:var(--dim); font-weight:normal; }
 main { padding:18px 20px; display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(265px,1fr)); }
 article { background:#161b22; border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
 article h2 { margin:0 0 4px; font-size:15px; color:var(--acc); }
 article h2 small { color:var(--dim); font-size:12px; font-weight:normal; }
 article p { margin:4px 0; color:var(--dim); font-size:12px; }
 .links a { margin-right:14px; color:var(--acc); }
 #up { color:var(--ok); } footer { padding:0 20px 26px; color:var(--dim); font-size:12px; }
 code { background:#161b22; border:1px solid var(--line); border-radius:4px; padding:1px 5px; }
</style></head><body>
<header><h1>5G Core Light <small>— standalone, ${loaded.size} network functions in one process</small></h1></header>
<main>${cards}</main>
<footer>
 <p id="up">checking…</p>
 <p>End to end in one command: <code>node projects/smsf-hao/app/demo.mjs</code></p>
 <p>Registry and KPIs: <a href="/t/smsf-hao/status">/t/smsf-hao/status</a> &middot;
    <a href="/t/smsf-hao/kpi">/t/smsf-hao/kpi</a> &middot;
    <a href="/t/smsf-hao/metrics">/t/smsf-hao/metrics</a></p>
</footer>
<script>
 fetch('/t/smsf-hao/status').then(r => r.json()).then(s => {
   const n = (s.instances || []).length;
   document.getElementById('up').textContent =
     n + (n === 1 ? ' network function has' : ' network functions have') + ' registered with the NRF';
 }).catch(() => { document.getElementById('up').textContent = 'the NRF is not answering'; });
</script>
</body></html>`;
}

// ---------- server ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, SELF);
  if (url.pathname === '/health') return json(res, 200, { ok: true, nfs: [...loaded.keys()], port: PORT });
  if (url.pathname === '/feed') return json(res, 200, feed.slice(-100));
  if (url.pathname.startsWith('/t/')) return servePlugin(req, res, url);
  if (url.pathname === '/colony' || url.pathname.startsWith('/colony/')) return serveColony(req, res, url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = indexPage();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
    return res.end(html);
  }
  json(res, 404, { error: 'not found' });
});

// A throw inside a plugin's timer runs outside every try/catch and would take the whole core
// down, exactly as it would on the shared board. Here we log it and keep the other NFs alive.
process.on('uncaughtException', e => console.error('uncaught:', e && e.message));
process.on('unhandledRejection', e => console.error('unhandled rejection:', e && e.message));

function boot() {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n5G Core Light — standalone on ${SELF}\n`);
    // Listening first: the NFs register over HTTP from init(), against this very server.
    loadPlugins();
    console.log(`\n  front page  ${SELF}/`);
    console.log(`  registry    ${SELF}/t/smsf-hao/status`);
    console.log(`  end to end  node projects/smsf-hao/app/demo.mjs\n`);
  });
}

if (require.main === module) boot();
module.exports = { server, boot, NFS, PORT, SELF };
