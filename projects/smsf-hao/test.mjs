// Unit tests for the smsf-hao NRF plugin.  Run:  node projects/smsf-hao/test.mjs
//
// These run the plugin IN-PROCESS with mock req/res, so they need no server, no port and no
// network. smoke.sh stays as it is: it tests the deployed NRF over HTTP. This file tests the
// logic, including the paths smoke.sh cannot reach (suspend on missed heartbeats, patch errors,
// supi ranges, persistence, the board reactions).
//
// Every test gets a FRESH copy of the module in its own temp dataDir, because the plugin keeps
// its registry in module-level state.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '../../board/plugins/smsf-hao/index.js');
const require_ = createRequire(import.meta.url);
const TEAM = 'smsf-hao';
const tmps = [];

/** A fresh plugin instance with its own state, temp dataDir and a board that records posts. */
function freshNrf(dataDir) {
  delete require_.cache[require_.resolve(PLUGIN)];
  const mod = require_(PLUGIN);
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'smsf-hao-test-'));
  if (!dataDir) tmps.push(dir);
  const posts = [];
  const ctx = {
    team: TEAM,
    dataDir: dir,
    board: { post: (text, channel, replyTo) => { posts.push({ text, channel, replyTo }); } },
  };
  mod.init(ctx);
  return { mod, ctx, posts, dir };
}

function mockReq(method, body) {
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []);
  req.method = method;
  req.destroy = () => {};
  return req;
}

function mockRes() {
  const res = {
    code: null, headers: {}, body: null, raw: null, ended: false,
    writeHead(code, headers) { res.code = code; res.headers = { ...headers }; },
    end(data) { res.ended = true; res.raw = data == null ? '' : String(data); try { res.body = res.raw ? JSON.parse(res.raw) : null; } catch { res.body = null; } },
  };
  return res;
}

/** Call the plugin exactly the way board/server.js does. `p` is the path after /t/smsf-hao. */
async function call({ mod, ctx }, method, p, body) {
  const url = new URL(`http://board.test/t/${TEAM}${p}`);
  const res = mockRes();
  const handled = await mod.handle(mockReq(method, body), res, {
    team: TEAM, path: decodeURIComponent(url.pathname.slice(`/t/${TEAM}`.length)) || '/',
    url, board: ctx.board, dataDir: ctx.dataDir,
  });
  return { handled, code: res.code, headers: res.headers, body: res.body, raw: res.raw };
}

const profile = (over = {}) => ({
  nfInstanceId: 'udm-1',
  nfType: 'UDM',
  fqdn: 'board.test',
  nfServices: [{ serviceInstanceId: 'udm-1-uecm', serviceName: 'nudm-uecm', versions: [{ apiVersionInUri: 'v1' }], scheme: 'https', apiPrefix: '/t/hetoteam' }],
  ...over,
});

const register = (nrf, p) => call(nrf, 'PUT', `/nnrf-nfm/v1/nf-instances/${encodeURIComponent(p.nfInstanceId)}`, p);
const discover = (nrf, q) => call(nrf, 'GET', `/nnrf-disc/v1/nf-instances?${q}`);

process.on('exit', () => { for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

// ───────────────────────────── apiRoot ─────────────────────────────
// This is our own extension on top of TS 29.510 and the thing other teams get wrong most often.

test('apiRoot: scheme + fqdn + relative prefix', () => {
  const { mod } = freshNrf();
  const p = profile();
  assert.equal(mod._test.apiRootFor(p, p.nfServices[0]), 'https://board.test/t/hetoteam');
});

test('apiRoot: an absolute apiPrefix is the apiRoot, not something to concatenate', () => {
  const { mod } = freshNrf();
  const p = profile({ nfServices: [{ serviceName: 'namf-comm', scheme: 'https', apiPrefix: 'https://board.test/t/tompa' }] });
  assert.equal(mod._test.apiRootFor(p, p.nfServices[0]), 'https://board.test/t/tompa');
});

test('apiRoot: a prefix without a leading slash gets one', () => {
  const { mod } = freshNrf();
  const p = profile({ nfServices: [{ serviceName: 's', scheme: 'https', apiPrefix: 't/krilju' }] });
  assert.equal(mod._test.apiRootFor(p, p.nfServices[0]), 'https://board.test/t/krilju');
});

test('apiRoot: a trailing slash is stripped', () => {
  const { mod } = freshNrf();
  const p = profile({ nfServices: [{ serviceName: 's', scheme: 'https', apiPrefix: '/t/x/' }] });
  assert.equal(mod._test.apiRootFor(p, p.nfServices[0]), 'https://board.test/t/x');
});

test('apiRoot: an explicit apiRoot in the profile always wins', () => {
  const { mod } = freshNrf();
  const p = profile({ nfServices: [{ serviceName: 's', scheme: 'http', apiPrefix: '/ignored', apiRoot: 'https://elsewhere.example/smsc' }] });
  assert.equal(mod._test.apiRootFor(p, p.nfServices[0]), 'https://elsewhere.example/smsc');
});

test('apiRoot: falls back to ipv4Addresses and defaults the scheme to http', () => {
  const { mod } = freshNrf();
  const p = profile({ fqdn: undefined, ipv4Addresses: ['10.0.0.9'], nfServices: [{ serviceName: 's', apiPrefix: '/x' }] });
  assert.equal(mod._test.apiRootFor(p, p.nfServices[0]), 'http://10.0.0.9/x');
});

test('apiRoot: an ipEndPoint port is appended, but never twice', () => {
  const { mod } = freshNrf();
  const withPort = profile({ fqdn: 'h.example', nfServices: [{ serviceName: 's', scheme: 'http', ipEndPoints: [{ port: 8080 }], apiPrefix: '/x' }] });
  assert.equal(mod._test.apiRootFor(withPort, withPort.nfServices[0]), 'http://h.example:8080/x');
  const already = profile({ fqdn: 'h.example:9000', nfServices: [{ serviceName: 's', scheme: 'http', ipEndPoints: [{ port: 8080 }] }] });
  assert.equal(mod._test.apiRootFor(already, already.nfServices[0]), 'http://h.example:9000');
});

test('apiRoot: no host, no apiRoot, and decorate leaves the service alone', () => {
  const { mod } = freshNrf();
  const p = profile({ fqdn: undefined, ipv4Addresses: undefined });
  assert.equal(mod._test.apiRootFor(p, p.nfServices[0]), null);
  assert.equal(mod._test.decorate(p).nfServices[0].apiRoot, undefined);
});

test('decorate does not mutate the stored profile', () => {
  const { mod } = freshNrf();
  const p = profile();
  const out = mod._test.decorate(p);
  assert.equal(out.nfServices[0].apiRoot, 'https://board.test/t/hetoteam');
  assert.equal(p.nfServices[0].apiRoot, undefined);
});

// ───────────────────────────── validation ─────────────────────────────

test('validate rejects everything that would break discovery', () => {
  const { mod } = freshNrf();
  const v = mod._test.validate;
  assert.match(v(null, 'a'), /NFProfile object/);
  assert.match(v('string', 'a'), /NFProfile object/);
  assert.match(v([], 'a'), /NFProfile object/);
  assert.match(v({}, 'a'), /nfInstanceId is mandatory/);
  assert.match(v({ nfInstanceId: 'b' }, 'a'), /does not match the path/);
  assert.match(v({ nfInstanceId: 'a' }, 'a'), /nfType is mandatory/);
  assert.match(v({ nfInstanceId: 'a', nfType: 'UDM', nfServices: {} }, 'a'), /nfServices must be an array/);
  assert.equal(v({ nfInstanceId: 'a', nfType: 'UDM' }, 'a'), null);
});

test('normaliseType uppercases and trims, and leaves non-strings alone', () => {
  const { mod } = freshNrf();
  assert.equal(mod._test.normaliseType('  udm '), 'UDM');
  assert.equal(mod._test.normaliseType(undefined), undefined);
  assert.equal(mod._test.normaliseType(7), 7);
});

test('a malformed body is a ProblemDetails 400, not a crash', async () => {
  const nrf = freshNrf();
  const r = await call(nrf, 'PUT', '/nnrf-nfm/v1/nf-instances/x', '{ not json');
  assert.equal(r.code, 400);
  assert.equal(r.headers['content-type'], 'application/problem+json; charset=utf-8');
  assert.equal(r.body.title, 'INVALID_MSG_FORMAT');
  assert.match(r.body.detail, /malformed JSON/);
});

test('a rejected profile answers ProblemDetails with status, title, detail and cause', async () => {
  const nrf = freshNrf();
  const r = await call(nrf, 'PUT', '/nnrf-nfm/v1/nf-instances/x', { nfInstanceId: 'x' });
  assert.equal(r.code, 400);
  assert.deepEqual(Object.keys(r.body).sort(), ['cause', 'detail', 'status', 'title']);
  assert.equal(r.body.cause, 'MANDATORY_IE_MISSING');
  assert.equal(nrf.mod._test.st.counters.rejected, 1);
});

// ───────────────────────────── NFManagement ─────────────────────────────

test('register answers 201 with a Location header and the decorated profile', async () => {
  const nrf = freshNrf();
  const r = await register(nrf, profile());
  assert.equal(r.code, 201);
  assert.equal(r.headers.location, `/t/${TEAM}/nnrf-nfm/v1/nf-instances/udm-1`);
  assert.equal(r.body.nfServices[0].apiRoot, 'https://board.test/t/hetoteam');
  assert.equal(nrf.mod._test.st.counters.register, 1);
});

test('register fills in the defaults of TS 29.510', async () => {
  const nrf = freshNrf();
  const r = await register(nrf, profile());
  assert.equal(r.body.nfStatus, 'REGISTERED');
  assert.equal(r.body.heartBeatTimer, 30);
});

test('a lowercase nfType is normalised, an unknown one is accepted anyway', async () => {
  const nrf = freshNrf();
  assert.equal((await register(nrf, profile({ nfInstanceId: 'a', nfType: ' udm ' }))).body.nfType, 'UDM');
  const custom = await register(nrf, profile({ nfInstanceId: 'b', nfType: 'CUSTOM_SMSC' }));
  assert.equal(custom.code, 201);
  assert.equal(custom.body.nfType, 'CUSTOM_SMSC');
  assert.equal((await discover(nrf, 'target-nf-type=custom_smsc&requester-nf-type=SMSF')).body.nfInstances.length, 1);
});

test('re-registering the same id replaces it with 200 and no second Location', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const r = await register(nrf, profile({ fqdn: 'moved.test' }));
  assert.equal(r.code, 200);
  assert.equal(r.headers.location, undefined);
  assert.equal(r.body.fqdn, 'moved.test');
  assert.equal(nrf.mod._test.st.counters.register, 1);
  assert.equal(nrf.mod._test.st.counters.update, 1);
  assert.equal(nrf.mod._test.st.profiles.size, 1);
});

test('GET one instance returns it, GET an unknown one is a 404 ProblemDetails', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  assert.equal((await call(nrf, 'GET', '/nnrf-nfm/v1/nf-instances/udm-1')).body.nfInstanceId, 'udm-1');
  const miss = await call(nrf, 'GET', '/nnrf-nfm/v1/nf-instances/nope');
  assert.equal(miss.code, 404);
  assert.equal(miss.body.cause, 'NF_INSTANCE_NOT_FOUND');
});

test('GET the collection lists _links, other methods on it are 405', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const list = await call(nrf, 'GET', '/nnrf-nfm/v1/nf-instances');
  assert.deepEqual(list.body._links.item, [{ href: `/t/${TEAM}/nnrf-nfm/v1/nf-instances/udm-1` }]);
  assert.equal((await call(nrf, 'POST', '/nnrf-nfm/v1/nf-instances', {})).code, 405);
});

test('an id with spaces or dots survives percent-encoding; one with a slash is refused clearly', async () => {
  const nrf = freshNrf();
  const id = 'udm instance.1';
  assert.equal((await register(nrf, profile({ nfInstanceId: id }))).code, 201);
  assert.equal((await call(nrf, 'GET', `/nnrf-nfm/v1/nf-instances/${encodeURIComponent(id)}`)).body.nfInstanceId, id);

  // The server hands the plugin a DECODED path, so a slash inside an id cannot round-trip: it
  // becomes a path separator. We do not pretend otherwise, we say exactly what we saw.
  const slashed = await register(nrf, profile({ nfInstanceId: 'udm/a' }));
  assert.equal(slashed.code, 400);
  assert.match(slashed.body.detail, /does not match the path/);
});

test('DELETE deregisters once; the second time it is a 404', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const r = await call(nrf, 'DELETE', '/nnrf-nfm/v1/nf-instances/udm-1');
  assert.equal(r.code, 204);
  assert.equal(r.raw, '');
  assert.equal(nrf.mod._test.st.counters.deregister, 1);
  assert.equal((await call(nrf, 'DELETE', '/nnrf-nfm/v1/nf-instances/udm-1')).code, 404);
  assert.equal((await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF')).body.nfInstances.length, 0);
});

test('an unsupported method on an instance is 405', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  assert.equal((await call(nrf, 'POST', '/nnrf-nfm/v1/nf-instances/udm-1', {})).code, 405);
});

test('an unknown nnrf-nfm resource is not ours to answer', async () => {
  const nrf = freshNrf();
  assert.equal((await call(nrf, 'GET', '/nnrf-nfm/v1/subscriptions')).handled, false);
});

// ───────────────────────────── heartbeats and patching ─────────────────────────────

test('PATCH with no body at all is a heartbeat: 204', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const before = nrf.mod._test.st.profiles.get('udm-1').lastSeen;
  await new Promise(r => setTimeout(r, 5));
  const r = await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1');
  assert.equal(r.code, 204);
  assert.ok(nrf.mod._test.st.profiles.get('udm-1').lastSeen > before);
});

test('PATCH with an empty array is the same heartbeat', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  assert.equal((await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', [])).code, 204);
});

test('a non-empty patch answers 200 with the new profile', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const r = await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', [{ op: 'replace', path: '/nfStatus', value: 'SUSPENDED' }]);
  assert.equal(r.code, 200);
  assert.equal(r.body.nfStatus, 'SUSPENDED');
});

test('applyPatch handles add, replace, remove and nested paths', () => {
  const { mod } = freshNrf();
  const p = { nfInstanceId: 'a', load: 10, nfServices: [{ serviceName: 's', scheme: 'http' }] };
  assert.equal(mod._test.applyPatch(p, [{ op: 'add', path: '/locality', value: 'eu' }]).locality, 'eu');
  assert.equal(mod._test.applyPatch(p, [{ op: 'replace', path: '/load', value: 42 }]).load, 42);
  assert.equal(mod._test.applyPatch(p, [{ op: 'remove', path: '/load' }]).load, undefined);
  assert.equal(mod._test.applyPatch(p, [{ op: 'replace', path: '/nfServices/0/scheme', value: 'https' }]).nfServices[0].scheme, 'https');
  assert.equal(p.load, 10, 'the original is never mutated');
});

test('applyPatch decodes ~1 and ~0 in a path, per RFC 6901', () => {
  const { mod } = freshNrf();
  const out = mod._test.applyPatch({ nfInstanceId: 'a' }, [{ op: 'add', path: '/a~1b', value: 1 }, { op: 'add', path: '/c~0d', value: 2 }]);
  assert.equal(out['a/b'], 1);
  assert.equal(out['c~d'], 2);
});

test('nfInstanceId is never patchable', () => {
  const { mod } = freshNrf();
  const out = mod._test.applyPatch({ nfInstanceId: 'a' }, [{ op: 'replace', path: '/nfInstanceId', value: 'hijacked' }]);
  assert.equal(out.nfInstanceId, 'a');
});

test('applyPatch throws on a bad path, a missing path and an unsupported op', () => {
  const { mod } = freshNrf();
  const p = { nfInstanceId: 'a' };
  assert.throws(() => mod._test.applyPatch(p, [{ op: 'add', path: 'nfStatus' }]), /bad patch path/);
  assert.throws(() => mod._test.applyPatch(p, [null]), /bad patch path/);
  assert.throws(() => mod._test.applyPatch(p, [{ op: 'add', path: '/a/b/c', value: 1 }]), /patch path not found/);
  assert.throws(() => mod._test.applyPatch(p, [{ op: 'copy', path: '/x', value: 1 }]), /unsupported patch op/);
});

test('a patch error is a 400 and the stored profile is untouched', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const r = await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', [{ op: 'frobnicate', path: '/nfStatus', value: 'x' }]);
  assert.equal(r.code, 400);
  assert.equal(nrf.mod._test.st.profiles.get('udm-1').profile.nfStatus, 'REGISTERED');
});

test('a patch body that is not an array is a 400 with an example in the detail', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const r = await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', { op: 'replace' });
  assert.equal(r.code, 400);
  assert.match(r.body.detail, /JSON Patch array/);
});

test('PATCH on an unknown instance is a 404', async () => {
  const nrf = freshNrf();
  assert.equal((await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/ghost', [])).code, 404);
});

// ───────────────────────────── suspend and revive ─────────────────────────────

test('three missed heartbeats suspend an NF and drop it out of discovery', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ heartBeatTimer: 10 }));
  const entry = nrf.mod._test.st.profiles.get('udm-1');

  entry.lastSeen = Date.now() - 29 * 1000;        // still inside 3 x 10s
  nrf.mod._test.sweep();
  assert.equal(entry.profile.nfStatus, 'REGISTERED');

  entry.lastSeen = Date.now() - 31 * 1000;        // past it
  nrf.mod._test.sweep();
  assert.equal(entry.profile.nfStatus, 'SUSPENDED');
  assert.equal((await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF')).body.nfInstances.length, 0);
});

test('a heartBeatTimer of 0 or nonsense falls back to the 30s default', () => {
  const nrf = freshNrf();
  const st = nrf.mod._test.st;
  st.profiles.set('x', { profile: { nfInstanceId: 'x', nfType: 'UDM', nfStatus: 'REGISTERED', heartBeatTimer: 'soon' }, lastSeen: Date.now() - 89 * 1000 });
  nrf.mod._test.sweep();
  assert.equal(st.profiles.get('x').profile.nfStatus, 'REGISTERED', 'still inside 3 x 30s');
  st.profiles.get('x').lastSeen = Date.now() - 91 * 1000;
  nrf.mod._test.sweep();
  assert.equal(st.profiles.get('x').profile.nfStatus, 'SUSPENDED');
});

test('a status patch revives a suspended NF', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ heartBeatTimer: 1 }));
  nrf.mod._test.st.profiles.get('udm-1').lastSeen = Date.now() - 10 * 1000;
  nrf.mod._test.sweep();
  assert.equal(nrf.mod._test.st.profiles.get('udm-1').profile.nfStatus, 'SUSPENDED');
  await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', [{ op: 'replace', path: '/nfStatus', value: 'REGISTERED' }]);
  assert.equal((await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF')).body.nfInstances.length, 1);
});

test('sweep suspends each NF once, not on every pass', () => {
  const nrf = freshNrf();
  const st = nrf.mod._test.st;
  st.profiles.set('x', { profile: { nfInstanceId: 'x', nfType: 'UDM', nfStatus: 'REGISTERED', heartBeatTimer: 1 }, lastSeen: 0 });
  nrf.mod._test.sweep();
  const before = st.log.length;
  nrf.mod._test.sweep();
  assert.equal(st.log.length, before);
});

// ───────────────────────────── NFDiscovery ─────────────────────────────

test('discovery needs both target-nf-type and requester-nf-type', async () => {
  const nrf = freshNrf();
  const a = await discover(nrf, 'requester-nf-type=SMSF');
  assert.equal(a.code, 400);
  assert.equal(a.body.cause, 'MANDATORY_QUERY_PARAM_MISSING');
  assert.equal((await discover(nrf, 'target-nf-type=UDM')).code, 400);
});

test('no match is a 200 with an empty list, never a 404', async () => {
  const nrf = freshNrf();
  const r = await discover(nrf, 'target-nf-type=AUSF&requester-nf-type=SMSF');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.nfInstances, []);
  assert.equal(r.body.validityPeriod, 3600);
  assert.equal(r.headers['cache-control'], 'max-age=3600');
});

test('discovery filters by nfType, service-names and target-nf-instance-id', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'udm-1' }));
  await register(nrf, profile({ nfInstanceId: 'udm-2', nfServices: [{ serviceName: 'nudm-sdm' }] }));
  await register(nrf, profile({ nfInstanceId: 'amf-1', nfType: 'AMF', nfServices: [{ serviceName: 'namf-comm' }] }));

  assert.equal((await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF')).body.nfInstances.length, 2);
  const sdm = await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF&service-names=nudm-sdm');
  assert.deepEqual(sdm.body.nfInstances.map(p => p.nfInstanceId), ['udm-2']);
  const both = await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF&service-names=nudm-sdm,nudm-uecm');
  assert.equal(both.body.nfInstances.length, 2);
  const one = await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF&target-nf-instance-id=udm-1');
  assert.deepEqual(one.body.nfInstances.map(p => p.nfInstanceId), ['udm-1']);
});

test('discovery results carry apiRoot, so a consumer never assembles a URL', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const r = await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');
  assert.equal(r.body.nfInstances[0].nfServices[0].apiRoot, 'https://board.test/t/hetoteam');
});

test('a SUSPENDED or UNDISCOVERABLE NF is never returned', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'udm-1', nfStatus: 'SUSPENDED' }));
  await register(nrf, profile({ nfInstanceId: 'udm-2', nfStatus: 'UNDISCOVERABLE' }));
  assert.equal((await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF')).body.nfInstances.length, 0);
});

test('ordering is stable: locality first, then priority, then id', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'c', priority: 1 }));
  await register(nrf, profile({ nfInstanceId: 'a', priority: 5 }));
  await register(nrf, profile({ nfInstanceId: 'b', priority: 5 }));
  await register(nrf, profile({ nfInstanceId: 'd' }));   // no priority -> 100, last

  const byPrio = await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');
  assert.deepEqual(byPrio.body.nfInstances.map(p => p.nfInstanceId), ['c', 'a', 'b', 'd']);

  await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/d', [{ op: 'add', path: '/locality', value: 'eu' }]);
  const byLocality = await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF&preferred-locality=eu');
  assert.equal(byLocality.body.nfInstances[0].nfInstanceId, 'd');
});

test('limit truncates, and a nonsense limit is ignored', async () => {
  const nrf = freshNrf();
  for (const id of ['a', 'b', 'c']) await register(nrf, profile({ nfInstanceId: id }));
  assert.equal((await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF&limit=2')).body.nfInstances.length, 2);
  assert.equal((await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF&limit=0')).body.nfInstances.length, 3);
  assert.equal((await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF&limit=later')).body.nfInstances.length, 3);
});

test('inSupiRange understands start/end, a regex pattern and the imsi- prefix', () => {
  const { mod } = freshNrf();
  const r = mod._test.inSupiRange;
  assert.equal(r([{ start: '46700000000', end: '46799999999' }], 'imsi-46700000123'), true);
  assert.equal(r([{ start: '46700000000', end: '46799999999' }], '46800000000'), false);
  assert.equal(r([{ pattern: '^4670' }], 'imsi-46700000123'), true);
  assert.equal(r([{ pattern: '^4680' }], 'imsi-46700000123'), false);
  assert.equal(r([{ pattern: '[unclosed' }], '467'), false, 'a broken pattern must not throw');
  assert.equal(r([{}], '467'), false, 'a range with neither pattern nor start/end matches nothing');
});

test('a supi query only filters NFs that declare supiRanges', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'serves-46', supiRanges: [{ start: '46000000000', end: '46999999999' }] }));
  await register(nrf, profile({ nfInstanceId: 'serves-47', supiRanges: [{ start: '47000000000', end: '47999999999' }] }));
  await register(nrf, profile({ nfInstanceId: 'serves-all' }));
  const r = await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF&supi=imsi-46700000123');
  assert.deepEqual(r.body.nfInstances.map(p => p.nfInstanceId).sort(), ['serves-46', 'serves-all']);
});

test('a non-GET on nnrf-disc is a 405', async () => {
  const nrf = freshNrf();
  assert.equal((await call(nrf, 'POST', '/nnrf-disc/v1/nf-instances', {})).code, 405);
});

// ───────────────────────────── tile backend ─────────────────────────────

test('status reports the counters, the NFs by type and their apiRoot', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  await register(nrf, profile({ nfInstanceId: 'amf-1', nfType: 'amf' }));
  await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');

  const r = await call(nrf, 'GET', '/status');
  assert.equal(r.code, 200);
  assert.equal(r.body.nrf, TEAM);
  assert.deepEqual(r.body.byType, { UDM: 1, AMF: 1 });
  assert.equal(r.body.counters.register, 2);
  assert.equal(r.body.counters.discover, 1);
  const udm = r.body.instances.find(i => i.nfInstanceId === 'udm-1');
  assert.equal(udm.apiRoot, 'https://board.test/t/hetoteam');
  assert.deepEqual(udm.services, ['nudm-uecm']);
  assert.ok(Date.parse(udm.lastSeen));
});

test('the root path is the status page too', async () => {
  const nrf = freshNrf();
  assert.equal((await call(nrf, 'GET', '/')).body.nrf, TEAM);
});

test('the log is returned newest-last and the limit is capped at 300', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const r = await call(nrf, 'GET', '/log?limit=2');
  assert.equal(r.body.log.length, 2);
  assert.ok(['in', 'out'].includes(r.body.log[0].dir));
  assert.ok(Date.parse(r.body.log[0].ts));
  assert.ok((await call(nrf, 'GET', '/log?limit=99999')).body.log.length <= 300);
});

test('the log never grows past 300 entries', async () => {
  const nrf = freshNrf();
  const st = nrf.mod._test.st;
  for (let i = 0; i < 400; i++) await call(nrf, 'GET', '/nnrf-nfm/v1/nf-instances/ghost');
  assert.equal(st.log.length, 300);
});

test('an unknown path is left to the server, which answers 404', async () => {
  const nrf = freshNrf();
  assert.equal((await call(nrf, 'GET', '/no/such/thing')).handled, false);
});

// ───────────────────────────── persistence ─────────────────────────────

test('the registry survives a restart, and lastSeen is reset so nothing is suspended at boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smsf-hao-test-'));
  tmps.push(dir);
  const first = freshNrf(dir);
  await register(first, profile());
  await register(first, profile({ nfInstanceId: 'amf-1', nfType: 'AMF' }));

  const second = freshNrf(dir);
  assert.equal(second.mod._test.st.profiles.size, 2);
  const r = await discover(second, 'target-nf-type=UDM&requester-nf-type=SMSF');
  assert.deepEqual(r.body.nfInstances.map(p => p.nfInstanceId), ['udm-1']);
  second.mod._test.sweep();
  assert.equal(second.mod._test.st.profiles.get('udm-1').profile.nfStatus, 'REGISTERED');
});

test('an unreadable data file starts an empty registry instead of crashing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smsf-hao-test-'));
  tmps.push(dir);
  require_('node:fs').writeFileSync(join(dir, 'nf-instances.json'), 'not json at all');
  const nrf = freshNrf(dir);
  assert.equal(nrf.mod._test.st.profiles.size, 0);
});

test('a save that fails is logged, not thrown, and no file means no save', () => {
  const nrf = freshNrf();
  nrf.mod._test.st.file = '/nonexistent-dir-smsf-hao/nf-instances.json';
  assert.doesNotThrow(() => nrf.mod._test.save());
  nrf.mod._test.st.file = null;
  assert.doesNotThrow(() => nrf.mod._test.save());
});

test('a sweep that throws never escapes the timer and takes the board down', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const nrf = freshNrf();
  nrf.mod._test.st.profiles = null;              // make sweep throw inside the interval
  assert.doesNotThrow(() => t.mock.timers.tick(15000));
  nrf.mod._test.st.profiles = new Map();
});

// ───────────────────────────── the board ─────────────────────────────

test('a new NF is announced once in #build, a re-registration is not', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  assert.equal(nrf.posts.length, 1);
  assert.equal(nrf.posts[0].channel, 'build');
  assert.match(nrf.posts[0].text, /UDM registered/);
  assert.match(nrf.posts[0].text, /nudm-uecm/);
  await register(nrf, profile({ fqdn: 'moved.test' }));
  assert.equal(nrf.posts.length, 1);
});

test('a smoke-test registration is not news', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'smoke-123' }));
  await register(nrf, profile({ nfInstanceId: 'test-9' }));
  assert.equal(nrf.posts.length, 0);
});

test('a board post that throws does not take the NRF down', async () => {
  const nrf = freshNrf();
  nrf.ctx.board.post = () => { throw new Error('board is down'); };
  const r = await register(nrf, profile());
  assert.equal(r.code, 201);
});

test('onMessage answers a mention once, with the live NF list, as a reply', () => {
  const nrf = freshNrf();
  nrf.mod._test.st.profiles.set('a', { profile: { nfInstanceId: 'a', nfType: 'UDM', nfStatus: 'REGISTERED' } });
  nrf.mod._test.st.profiles.set('b', { profile: { nfInstanceId: 'smoke-1', nfType: 'AMF', nfStatus: 'REGISTERED' } });
  nrf.mod.onMessage({ id: 7, from: 'krilju', channel: 'build', text: 'how do we register, @smsf-hao ?' }, nrf.ctx);
  assert.equal(nrf.posts.length, 1);
  assert.equal(nrf.posts[0].channel, 'build');
  assert.equal(nrf.posts[0].replyTo, 7);
  assert.match(nrf.posts[0].text, /Registered right now: UDM\./, 'test instances are left out');
});

test('onMessage keeps quiet: itself, the bots, a message with no mention, and inside the cooldown', () => {
  const nrf = freshNrf();
  const msg = over => ({ id: 1, from: 'krilju', channel: 'build', text: '@smsf-hao hello', ...over });
  nrf.mod.onMessage(msg({ from: TEAM }), nrf.ctx);
  nrf.mod.onMessage(msg({ from: 'release' }), nrf.ctx);
  nrf.mod.onMessage(msg({ from: 'Lead' }), nrf.ctx);
  nrf.mod.onMessage(msg({ text: 'the nrf is up' }), nrf.ctx);
  nrf.mod.onMessage(msg({ text: '@smsf-haoxyz hello' }), nrf.ctx);
  assert.equal(nrf.posts.length, 0);

  nrf.mod.onMessage(msg(), nrf.ctx);
  assert.equal(nrf.posts.length, 1);
  nrf.mod.onMessage(msg({ id: 2 }), nrf.ctx);
  assert.equal(nrf.posts.length, 1, 'one answer per ten minutes, not per mention');
});

test('a reply that throws does not take the NRF down', () => {
  const nrf = freshNrf();
  nrf.ctx.board.post = () => { throw new Error('board is down'); };
  nrf.mod.onMessage({ id: 1, from: 'krilju', channel: 'build', text: '@smsf-hao hi' }, nrf.ctx);
});

// ───────────────────────────── the group's real profiles ─────────────────────────────
// A regression guard for the four NFs that are live right now.

test('the four live NF profiles all produce a usable apiRoot', async () => {
  const nrf = freshNrf();
  const live = [
    ['krilju-smsf', 'SMSF', '/t/krilju', 'nsmsf-sms'],
    ['hetoteam-udm', 'UDM', '/t/hetoteam', 'nudm-uecm'],
    ['holminator-smsc', 'CUSTOM_SMSC', '/t/holminator', 'nsmsc-sgd'],
    ['tompa-amf', 'AMF', 'https://board.test/t/tompa', 'namf-comm'],   // absolute, the shape that used to double
  ];
  for (const [id, nfType, apiPrefix, serviceName] of live) {
    await register(nrf, { nfInstanceId: id, nfType, fqdn: 'board.test', nfServices: [{ serviceName, scheme: 'https', apiPrefix }] });
  }
  const r = await call(nrf, 'GET', '/status');
  for (const i of r.body.instances) {
    assert.equal(i.apiRoot, `https://board.test/t/${i.nfInstanceId.split('-')[0]}`, `${i.nfInstanceId} apiRoot`);
    assert.doesNotMatch(i.apiRoot, /https?:\/\/[^/]*https?:\/\//, 'no doubled host');
  }
  assert.equal(r.body.instances.length, 4);
});

// ───────────────────────────── KPIs ─────────────────────────────

const kpi = nrf => call(nrf, 'GET', '/kpi').then(r => r.body);

test('core completeness: the four NF types the SMS flow needs', async () => {
  const nrf = freshNrf();
  let k = await kpi(nrf);
  assert.equal(k.coreCompleteness.ratio, 0);
  assert.deepEqual(k.coreCompleteness.missing, ['AMF', 'UDM', 'SMSF', 'SMSC']);

  await register(nrf, profile({ nfInstanceId: 'amf-1', nfType: 'AMF' }));
  await register(nrf, profile({ nfInstanceId: 'udm-1', nfType: 'UDM' }));
  await register(nrf, profile({ nfInstanceId: 'smsf-1', nfType: 'SMSF' }));
  k = await kpi(nrf);
  assert.deepEqual(k.coreCompleteness.missing, ['SMSC']);
  assert.equal(k.coreCompleteness.ratio, 0.75);

  // holminator registers CUSTOM_SMSC, and that must count as the SMSC.
  await register(nrf, profile({ nfInstanceId: 'smsc-1', nfType: 'CUSTOM_SMSC' }));
  k = await kpi(nrf);
  assert.deepEqual(k.coreCompleteness.missing, []);
  assert.equal(k.coreCompleteness.ratio, 1);
});

test('a suspended NF does not count towards core completeness', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'amf-1', nfType: 'AMF', heartBeatTimer: 1 }));
  assert.equal((await kpi(nrf)).coreCompleteness.present.length, 1);
  nrf.mod._test.st.profiles.get('amf-1').lastSeen = Date.now() - 10 * 1000;
  nrf.mod._test.sweep();
  const k = await kpi(nrf);
  assert.deepEqual(k.coreCompleteness.present, []);
  assert.equal(k.registry.registered, 0);
  assert.equal(k.registry.suspended, 1);
});

test('traffic is counted per operation, and the tile polling is not counted at all', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  await register(nrf, profile({ fqdn: 'again.test' }));
  await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', []);
  await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', [{ op: 'add', path: '/load', value: 5 }]);
  await call(nrf, 'GET', '/nnrf-nfm/v1/nf-instances/udm-1');
  await call(nrf, 'GET', '/nnrf-nfm/v1/nf-instances');
  await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');
  await call(nrf, 'DELETE', '/nnrf-nfm/v1/nf-instances/udm-1');
  for (let i = 0; i < 5; i++) { await call(nrf, 'GET', '/status'); await call(nrf, 'GET', '/log'); await kpi(nrf); }

  const k = await kpi(nrf);
  assert.deepEqual(k.traffic.byOperation,
    { register: 1, replace: 1, heartbeat: 1, patch: 1, read: 1, list: 1, discover: 1, deregister: 1 });
  assert.equal(k.traffic.requests, 8);
  assert.equal(k.traffic.perMinute, 8, 'our own dashboard must not inflate the rate');
});

test('responses are counted by status code and turned into an error ratio', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());                                        // 201
  await call(nrf, 'GET', '/nnrf-nfm/v1/nf-instances/ghost');             // 404
  await call(nrf, 'PUT', '/nnrf-nfm/v1/nf-instances/x', { nfType: 'UDM' }); // 400
  await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');      // 200

  const k = await kpi(nrf);
  assert.deepEqual(k.traffic.byCode, { 200: 1, 201: 1, 400: 1, 404: 1 });
  assert.equal(k.reliability.responses, 4);
  assert.equal(k.reliability.errors, 2);
  assert.equal(k.reliability.errorRatio, 0.5);
});

test('discovery hit ratio, and the unserved targets nobody has registered for', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');
  await discover(nrf, 'target-nf-type=UDM&requester-nf-type=AMF');
  await discover(nrf, 'target-nf-type=SMSF&requester-nf-type=AMF');      // nobody there
  await discover(nrf, 'target-nf-type=SMSF&requester-nf-type=UDM');      // still nobody

  const k = await kpi(nrf);
  assert.equal(k.discovery.queries, 4);
  assert.equal(k.discovery.hits, 2);
  assert.equal(k.discovery.empty, 2);
  assert.equal(k.discovery.hitRatio, 0.5);
  assert.deepEqual(k.discovery.byTarget.UDM, { queries: 2, hits: 2, empty: 2 - 2 });
  assert.deepEqual(k.discovery.unservedTargets, [{ target: 'SMSF', queries: 2 }]);
});

test('a target stops being unserved as soon as somebody registers', async () => {
  const nrf = freshNrf();
  await discover(nrf, 'target-nf-type=AMF&requester-nf-type=SMSF');
  assert.equal((await kpi(nrf)).discovery.unservedTargets.length, 1);
  await register(nrf, profile({ nfInstanceId: 'amf-1', nfType: 'AMF' }));
  await discover(nrf, 'target-nf-type=AMF&requester-nf-type=SMSF');
  assert.deepEqual((await kpi(nrf)).discovery.unservedTargets, []);
});

test('a rejected query is not a discovery query', async () => {
  const nrf = freshNrf();
  await discover(nrf, 'requester-nf-type=SMSF');
  const k = await kpi(nrf);
  assert.equal(k.discovery.queries, 0);
  assert.equal(k.discovery.hitRatio, null, 'no queries means no ratio, not a fake 0');
  assert.equal(k.traffic.byCode['400'], 1);
});

test('suspensions and revivals are counted', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ heartBeatTimer: 1 }));
  nrf.mod._test.st.profiles.get('udm-1').lastSeen = Date.now() - 10 * 1000;
  nrf.mod._test.sweep();
  assert.equal((await kpi(nrf)).reliability.suspensions, 1);

  await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', [{ op: 'replace', path: '/nfStatus', value: 'REGISTERED' }]);
  assert.equal((await kpi(nrf)).reliability.revivals, 1);

  nrf.mod._test.st.profiles.get('udm-1').lastSeen = Date.now() - 10 * 1000;
  nrf.mod._test.sweep();
  await register(nrf, profile({ heartBeatTimer: 1 }));          // a full re-register also revives
  const k = await kpi(nrf);
  assert.equal(k.reliability.suspensions, 2);
  assert.equal(k.reliability.revivals, 2);
});

test('a plain heartbeat does not count as a revival', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  await call(nrf, 'PATCH', '/nnrf-nfm/v1/nf-instances/udm-1', []);
  assert.equal((await kpi(nrf)).reliability.revivals, 0);
});

test('heartbeat health shows the budget used, worst first', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'fresh', heartBeatTimer: 30 }));
  await register(nrf, profile({ nfInstanceId: 'late', heartBeatTimer: 10 }));
  nrf.mod._test.st.profiles.get('late').lastSeen = Date.now() - 24 * 1000;

  const h = (await kpi(nrf)).heartbeats;
  assert.equal(h[0].nfInstanceId, 'late', 'the one closest to suspension is first');
  assert.equal(h[0].budgetSeconds, 30);
  assert.equal(h[0].budgetUsed, 0.8);
  assert.equal(h[0].health, 'late');
  assert.equal(h[1].health, 'ok');
  assert.equal(h[1].budgetUsed, 0);
});

test('a suspended NF reports health down', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ heartBeatTimer: 1 }));
  nrf.mod._test.st.profiles.get('udm-1').lastSeen = Date.now() - 10 * 1000;
  nrf.mod._test.sweep();
  assert.equal((await kpi(nrf)).heartbeats[0].health, 'down');
});

test('latency percentiles come out of the measured window', () => {
  const { mod } = freshNrf();
  const p = mod._test.percentile;
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(p(xs, 50), 50);
  assert.equal(p(xs, 95), 95);
  assert.equal(p(xs, 100), 100);
  assert.equal(p([], 95), 0, 'no samples is 0, not NaN');
  assert.equal(p([7], 50), 7);
});

test('every service request is timed', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');
  const lat = (await kpi(nrf)).latencyMs;
  assert.equal(lat.count, 2);
  assert.ok(lat.max >= lat.p50 && lat.p95 <= lat.max);
  assert.ok(lat.avg >= 0 && lat.max < 1000, 'an in-process call is sub-second');
});

test('the latency window never grows past 500 samples', async () => {
  const nrf = freshNrf();
  for (let i = 0; i < 520; i++) await call(nrf, 'GET', '/nnrf-nfm/v1/nf-instances/ghost');
  assert.equal(nrf.mod._test.st.kpi.latency.length, 500);
  assert.equal((await kpi(nrf)).traffic.byCode['404'], 520, 'the counters keep counting');
});

test('uptime and the registry breakdown are reported', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'a', nfType: 'udm' }));
  await register(nrf, profile({ nfInstanceId: 'b', nfType: 'UDM', nfStatus: 'UNDISCOVERABLE' }));
  const k = await kpi(nrf);
  assert.equal(k.nrf, TEAM);
  assert.ok(Date.parse(k.generated));
  assert.ok(k.uptimeSeconds >= 0);
  assert.deepEqual(k.registry.byType, { UDM: 2 });
  assert.deepEqual(k.registry.byStatus, { REGISTERED: 1, UNDISCOVERABLE: 1 });
  assert.equal(k.registry.total, 2);
});

test('/metrics is Prometheus text with a HELP and TYPE line for every metric', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');
  await discover(nrf, 'target-nf-type=PCF&requester-nf-type=SMSF');

  const r = await call(nrf, 'GET', '/metrics');
  assert.equal(r.code, 200);
  assert.match(r.headers['content-type'], /^text\/plain; version=0\.0\.4/);

  const lines = r.raw.trim().split('\n');
  const names = new Set();
  for (const line of lines) {
    if (line.startsWith('# HELP ')) { names.add(line.split(' ')[2]); continue; }
    if (line.startsWith('# TYPE ')) continue;
    assert.match(line, /^[a-z_]+(\{[^}]*\})? -?[\d.]+$/, `malformed sample: ${line}`);
    assert.ok(names.has(line.split(/[{ ]/)[0]), `${line} has no HELP line`);
  }
  assert.ok(names.size >= 14, `expected the full metric set, got ${names.size}`);
  assert.match(r.raw, /^nrf_up 1$/m);
  assert.match(r.raw, /^nrf_nf_instances\{nf_type="UDM"\} 1$/m);
  assert.match(r.raw, /^nrf_requests_total\{operation="register"\} 1$/m);
  assert.match(r.raw, /^nrf_discovery_queries_total\{target_nf_type="PCF",result="empty"\} 1$/m);
  assert.match(r.raw, /^nrf_discovery_hit_ratio 0\.5$/m);
  assert.match(r.raw, /^nrf_core_completeness_ratio 0\.25$/m);
});

test('/metrics on an empty NRF is still valid, with no NaN and no empty label', async () => {
  const nrf = freshNrf();
  const r = await call(nrf, 'GET', '/metrics');
  assert.doesNotMatch(r.raw, /NaN|undefined|null/);
  assert.match(r.raw, /^nrf_discovery_hit_ratio 1$/m, 'no queries yet is not a miss');
  assert.match(r.raw, /^nrf_error_ratio 0$/m);
});

test('a label value with a quote or a backslash in it cannot break the exposition', async () => {
  const nrf = freshNrf();
  await register(nrf, profile({ nfInstanceId: 'od\\d "quoted"' }));
  const r = await call(nrf, 'GET', '/metrics');
  const line = r.raw.split('\n').find(l => l.startsWith('nrf_heartbeat_age_seconds'));
  assert.equal(line, 'nrf_heartbeat_age_seconds{nf_instance_id="od\\\\d \\"quoted\\"",nf_type="UDM"} 0');
});

test('reading the KPIs does not change them', async () => {
  const nrf = freshNrf();
  await register(nrf, profile());
  const a = await kpi(nrf);
  await call(nrf, 'GET', '/metrics');
  const b = await kpi(nrf);
  assert.deepEqual(a.traffic, b.traffic);
  assert.deepEqual(a.discovery, b.discovery);
});

test('the KPI report is a copy: mutating it cannot corrupt the live counters', async () => {
  const nrf = freshNrf();
  await discover(nrf, 'target-nf-type=UDM&requester-nf-type=SMSF');
  const r = nrf.mod._test.kpiReport();
  r.discovery.byTarget.UDM.queries = 999;
  r.traffic.byOperation.discover = 999;
  assert.equal(nrf.mod._test.st.kpi.discovery.byTarget.UDM.queries, 1);
  assert.equal(nrf.mod._test.st.kpi.byOperation.discover, 1);
});
