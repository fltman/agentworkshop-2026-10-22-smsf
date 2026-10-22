// Live interaction feed for the group app: every team's own /log, normalised to
// {ts, from, to, status, ok, label}. "from" is the caller, "to" the callee, whichever log saw it.
'use strict';

const NODES = ['UE', 'AMF', 'SMSF', 'UDM', 'SMSC', 'NRF'];
const PEER = { trigger: 'UE', ue: 'UE', amf: 'AMF', smsf: 'SMSF', udm: 'UDM', smsc: 'SMSC', nrf: 'NRF' };
const FEEDS = [
  { team: 'tompa', node: 'AMF', url: '/t/tompa/log' },
  { team: 'krilju', node: 'SMSF', url: '/t/krilju/log?limit=200' },
  { team: 'hetoteam', node: 'UDM', url: '/t/hetoteam/log' },
  { team: 'holminator', node: 'SMSC', url: '/t/holminator/log' },
];

function shortPath(p) {
  return String(p || '').replace(/https?:\/\/[^/\s]+/g, '').replace(/^\/t\/[^/]+/, '').split('?')[0]
    .replace(/imsi-\d+/g, '{supi}').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '{id}').slice(0, 60);
}

// One log entry from the log of `feed` ({team, node}) → an interaction, or null for a half we skip.
// Caller: a path into ANOTHER team's API (/t/<other>/ or an absolute URL) means this node called the peer;
// krilju logs answers as "<status> <what>": dir "in" is the answer to the SMSF's own call.
function callerIsSelf(feed, e, fromText) {
  if (fromText) return e.dir === 'in';
  const path = String(e.path || '');
  if (/^https?:\/\//.test(path)) return true;
  const t = path.match(/^\/t\/([^/]+)\//);
  if (t) return t[1] !== feed.team;
  return e.dir === 'out';
}

function normalize(feed, e) {
  const node = feed.node;
  const peer = PEER[e && e.peer];
  if (!peer || peer === node) return null;
  const what = String(e.what || '');
  const m = what.match(/^(\d{3}) (.*)$/);
  const status = e.status != null ? Number(e.status) : m ? Number(m[1]) : null;
  if (status == null && peer !== 'UE') return null; // a request alone is drawn when its answer is logged
  const self = peer === 'UE' ? false : callerIsSelf(feed, e, !!m);
  const from = self ? node : peer, to = self ? peer : node;
  const failText = /RP-ERROR|FAIL|ERROR/i.test(what) || (e.diag && e.diag.verdict === 'fault');
  const ok = status == null ? true : status < 400 && !failText;
  const label = (m ? m[2].replace(/https?:\/\/\S+/g, (u) => shortPath(u)) : `${e.method || ''} ${shortPath(e.path)}`).trim() || what;
  return { ts: e.ts, from, to, status, ok, label };
}

// Two logs can see the same call; one copy per caller, callee, status and second.
const key = (i) => `${i.from}|${i.to}|${i.status}|${String(i.ts).slice(0, 19)}`;

function collect(results) {
  const seen = new Set(), out = [];
  for (const { feed, list } of results) {
    for (const e of list || []) {
      const i = normalize(feed, e);
      if (!i || seen.has(key(i))) continue;
      seen.add(key(i)); out.push(i);
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

if (typeof module !== 'undefined') module.exports = { NODES, FEEDS, normalize, collect, key, shortPath };

// ---- browser: poll every 3 s, hand only new interactions to the subscribers ----
if (typeof window !== 'undefined') {
  const subs = [], seen = new Set();
  let first = true;
  async function poll() {
    const results = await Promise.all(FEEDS.map(async (f) => {
      try {
        const r = await fetch(f.url);
        const j = r.ok ? await r.json() : [];
        return { feed: f, list: Array.isArray(j) ? j : (j && (j.log || j.entries)) || [] };
      } catch { return { feed: f, list: [] }; }
    }));
    const fresh = collect(results).filter((i) => !seen.has(key(i)));
    fresh.forEach((i) => seen.add(key(i)));
    for (const s of subs) s(fresh, first);
    first = false;
  }
  window.CoreFeed = { NODES, subscribe(fn) { subs.push(fn); }, start() { poll(); setInterval(poll, 3000); } };
}
