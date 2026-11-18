// DEMO-V1: local interface API, end to end against a real disposable PostgreSQL 16 (tests/db harness: loopback,
// *_test database names only). SYNTHETIC DATA ONLY.
//
// Expected values are recomputed independently here from the dataset definition (app/server/dataset.ts PLAN), never
// from the API under test. Run with: npm run test:app.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cfg, dropDatabase, assertSafeTarget, uniqueDbName } from '../db/helpers.mjs';
import { prepareDatabase, seedDemo } from '../../app/dist/seed.js';
import { DemoService } from '../../app/dist/service.js';
import { createServer } from '../../app/dist/server.js';
import { PLAN, SOURCES, ADVERTISERS } from '../../app/dist/dataset.js';
import { normalizeAdvertiser } from '../../dist/persistence/intelligence.js';

const PW = cfg.rolePassword;
const passwords = { collector: PW, rightsAdmin: PW, monitor: PW, analyst: PW, migrator: PW };
const admin = { user: cfg.adminUser, password: cfg.adminPassword };

/** A seeded database, a service and a server on an ephemeral loopback port. */
async function app(t) {
  const database = uniqueDbName('demoapp');
  assertSafeTarget(database);
  const db = { host: cfg.host, port: cfg.port, database };
  t.after(() => dropDatabase(database));
  await prepareDatabase(db, admin, passwords);
  const seeded = await seedDemo(db, admin, passwords);
  const service = new DemoService({ db, passwords });
  const { server, csrfToken } = createServer({ port: 0, service });
  await new Promise(r => server.once('listening', r));
  t.after(async () => { server.close(); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, headers = {}) => { const r = await fetch(base + path, { headers }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };
  const post = async (path, body, headers = { 'Content-Type': 'application/json', 'X-SI-CSRF': csrfToken }) => {
    const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { base, get, post, seeded, csrfToken };
}

// ---- independent expectation from the dataset definition
const GRANTED = SOURCES.filter(s => s.grantedToAnalyst).map(s => s.sourceId);
function expected(sourceId) {
  const obs = (PLAN[sourceId] ?? []).filter(p => p.expect === 'COMPLETED').flatMap(p => p.rows);
  return { observations: obs.length, advertisers: new Set(obs.map(o => normalizeAdvertiser(o.advertiserName))).size,
           distinctAds: new Set(obs.map(o => `${o.network}|${o.nativeAdId}`)).size, rows: obs };
}
function expectedAdvertiser(sourceId, name) {
  const runs = (PLAN[sourceId] ?? []).filter(p => p.expect === 'COMPLETED' && p.rows.some(r => r.advertiserName === name));
  const rows = runs.flatMap(p => p.rows.filter(r => r.advertiserName === name));
  return { observations: rows.length, distinctAds: new Set(rows.map(r => `${r.network}|${r.nativeAdId}`)).size, runs: runs.length,
           perAd: Object.fromEntries([...new Set(rows.map(r => r.nativeAdId))].map(id => [id, rows.filter(r => r.nativeAdId === id).length])) };
}

test('APP-1: seeding goes through the real pipeline and matches the plan (one FAILED run, verified receipts)', async t => {
  const a = await app(t);
  const planned = Object.values(PLAN).flat();
  assert.equal(a.seeded.runs.length, planned.length);
  assert.deepEqual(a.seeded.runs.map(r => r.outcome), planned.map(p => p.expect));
  assert.equal(a.seeded.runs.find(r => r.outcome === 'FAILED').code, 'VALIDATION_FAILED');
  assert.equal(a.seeded.verified, planned.filter(p => p.expect === 'COMPLETED' && p.rows.length > 0).length, 'every published run verified');
});

test('APP-2: overview equals an independent recomputation; isolation and empty source', async t => {
  const a = await app(t);
  const { status, body } = await a.get('/api/overview');
  assert.equal(status, 200);
  for (const s of SOURCES) {
    const got = body.sources.find(x => x.sourceId === s.sourceId);
    if (!s.grantedToAnalyst) {
      assert.equal(got.access.state, 'NOT_GRANTED', `${s.sourceId} is not granted`);
      assert.equal(got.evidence, null, 'nothing released for an ungranted source');
      continue;
    }
    const e = expected(s.sourceId);
    assert.equal(got.access.state, 'AVAILABLE');
    assert.deepEqual([got.evidence.observations, got.evidence.advertisers, got.evidence.distinctAds], [e.observations, e.advertisers, e.distinctAds], s.sourceId);
  }
  const gamma = body.sources.find(x => x.sourceId === 'demo-market-gamma');
  assert.deepEqual([gamma.evidence.observations, gamma.status.runsCompleted, gamma.status.runsEmpty], [0, 1, 1], 'empty: collected, nothing found');
  const tot = GRANTED.map(expected);
  assert.equal(body.totals.readableObservations, tot.reduce((n, e) => n + e.observations, 0));
  assert.equal(body.totals.advertiserIdentities, tot.reduce((n, e) => n + e.advertisers, 0));
  assert.equal(body.totals.runs.failed, 1);
});

test('APP-3: search pagination walks every hit exactly once, in code point order; tampered cursor refused', async t => {
  const a = await app(t);
  const want = GRANTED.flatMap(s => [...new Set(expected(s).rows.map(r => normalizeAdvertiser(r.advertiserName)))].map(n => `${n}|${s}`)).sort();
  const seen = [];
  let r = await a.get('/api/search?q=synthetic&limit=2'), pages = 1;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.excluded.map(x => [x.sourceId, x.state]).filter(([id]) => id === 'demo-market-delta'), [['demo-market-delta', 'NOT_GRANTED']]);
  for (;;) {
    assert.ok(r.body.hits.length <= 2);
    seen.push(...r.body.hits.map(h => `${h.normalizedName}|${h.sourceId}`));
    if (!r.body.nextCursor) break;
    r = await a.get(`/api/search?q=synthetic&limit=2&sources=${r.body.sources.join(',')}&cursor=${encodeURIComponent(r.body.nextCursor)}`);
    assert.equal(r.status, 200); pages++;
  }
  assert.ok(pages >= 3, 'more than one page');
  assert.deepEqual(seen, want, 'every advertiser once, ordered by (normalized name, source)');
  const bad = await a.get('/api/search?q=synthetic&limit=2&sources=demo-market-alpha&cursor=eyJ2IjoyfQ');
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'BAD_CURSOR']);
  const other = await a.get(`/api/search?q=northwind&limit=2&sources=demo-market-alpha`);
  const nw = other.body.hits[0];
  const e = expectedAdvertiser('demo-market-alpha', ADVERTISERS.NW);
  assert.deepEqual([nw.observations, nw.distinctAds, nw.runsWithEvidence], [e.observations, e.distinctAds, e.runs], 'distinct ads not summed per run');
  const none = await a.get('/api/search?q=no-such-advertiser');
  assert.deepEqual([none.status, none.body.hits.length], [200, 0], 'empty result is empty, not an error');
  const net = await a.get('/api/search?q=synthetic&networks=PINTEREST');
  assert.deepEqual(net.body.hits.map(h => h.sourceId), ['demo-market-beta'], 'network filter');
});

test('APP-4: advertiser detail and evidence history equal the plan; same name in another source is separate', async t => {
  const a = await app(t);
  for (const [src, name] of [['demo-market-alpha', ADVERTISERS.NW], ['demo-market-beta', ADVERTISERS.NW], ['demo-market-alpha', ADVERTISERS.HG]]) {
    const r = await a.get(`/api/advertiser?source=${src}&name=${encodeURIComponent(name)}`);
    assert.equal(r.status, 200);
    const e = expectedAdvertiser(src, name), h = r.body.history;
    assert.deepEqual([h.observations.length, h.distinctAds, h.runsWithEvidence], [e.observations, e.distinctAds, e.runs], `${src} ${name}`);
    assert.deepEqual(Object.fromEntries(r.body.ads.map(x => [x.nativeAdId, x.observations])), e.perAd);
    assert.ok(h.observations.every(o => o.verification === 'VALID' && /^[0-9a-f]{64}$/.test(o.contentSha256) && o.sourceId === src));
    assert.equal(h.endOfActivity, 'UNKNOWN');
  }
  const seen = (await a.get(`/api/advertiser?source=demo-market-alpha&name=${encodeURIComponent(ADVERTISERS.NW)}`)).body.history;
  // The server's rule (0015/0016): per observation, the source-reported first/last seen, else its seenAt.
  const nwRows = (PLAN['demo-market-alpha']).filter(p => p.expect === 'COMPLETED').flatMap(p => p.rows).filter(r => r.advertiserName === ADVERTISERS.NW);
  const firsts = nwRows.map(r => r.sourceReportedFirstSeen ?? r.seenAt).sort(), lasts = nwRows.map(r => r.sourceReportedLastSeen ?? r.seenAt).sort();
  assert.deepEqual([seen.sourceReportedFirstSeen, seen.sourceReportedLastSeen], [firsts[0], lasts[lasts.length - 1]]);
  const missing = await a.get('/api/advertiser?source=demo-market-gamma&name=Nobody');
  assert.deepEqual([missing.status, missing.body.history.observations.length], [200, 0], 'empty history');
});

test('APP-5: authorization — an ungranted source is refused, never shown as empty', async t => {
  const a = await app(t);
  const h = await a.get(`/api/advertiser?source=demo-market-delta&name=${encodeURIComponent(ADVERTISERS.QS)}`);
  assert.deepEqual([h.status, h.body.error.code], [403, 'NOT_AUTHORIZED']);
  const s = await a.get('/api/search?q=quarry&sources=demo-market-delta');
  assert.deepEqual([s.body.hits.length, s.body.excluded[0].state], [0, 'NOT_GRANTED']);
  const all = await a.get('/api/search?q=quarry');
  assert.equal(all.body.hits.length, 0, 'delta evidence never appears in a default search');
});

test('APP-6: workflow 1 — collection, publication, verification, then the advertiser appears in search', async t => {
  const a = await app(t);
  const c = await a.post('/api/ops/collect', { sourceId: 'demo-market-alpha', scenarioId: 'new-advertiser' });
  assert.equal(c.status, 200);
  assert.deepEqual([c.body.outcome, c.body.run.status, c.body.run.counts.published, c.body.run.retentionState], ['COMPLETED', 'COMPLETED', 3, 'RETAINED']);
  assert.ok(c.body.run.receiptAt, 'receipt persisted');
  assert.equal((await a.get('/api/search?q=aurora')).body.hits.length, 0, 'not readable before verification');
  const v = await a.post('/api/ops/verify', {});
  assert.deepEqual([v.body.result.verified, v.body.result.valid, v.body.status.pending], [1, 1, 0]);
  const s = await a.get('/api/search?q=aurora');
  assert.deepEqual(s.body.hits.map(h => [h.names[0], h.sourceId, h.distinctAds]), [[ADVERTISERS.AK, 'demo-market-alpha', 2]]);
});

test('APP-7: failed publication is persisted as FAILED and publishes nothing; scope mismatch is REJECTED', async t => {
  const a = await app(t);
  const before = (await a.get('/api/overview')).body.totals;
  const f = await a.post('/api/ops/collect', { sourceId: 'demo-market-alpha', scenarioId: 'invalid' });
  assert.deepEqual([f.body.outcome, f.body.code, f.body.run.status, f.body.run.outcomeCode, f.body.run.receiptAt], ['FAILED', 'VALIDATION_FAILED', 'FAILED', 'VALIDATION_FAILED', null]);
  assert.deepEqual(f.body.diagnostics.errors.map(e => [e.code, e.field]), [['INVALID_COUNTRIES', 'countries']]);
  const r = await a.post('/api/ops/collect', { sourceId: 'demo-market-gamma', scenarioId: 'new-advertiser' });
  assert.deepEqual([r.body.outcome, r.body.run.status, r.body.run.outcomeCode], ['REJECTED', 'REJECTED', 'NETWORK_SCOPE_MISMATCH']);
  await a.post('/api/ops/verify', {});
  const after = (await a.get('/api/overview')).body.totals;
  assert.deepEqual([after.readableObservations, after.distinctAds], [before.readableObservations, before.distinctAds], 'no evidence from a failed publication');
  assert.equal(after.runs.failed, before.runs.failed + 1);
  assert.equal((await a.get('/api/search?q=aurora')).body.hits.length, 0, 'the valid row of the refused batch was not published either');
});

test('APP-8: workflow 3 — SUSPEND makes the evidence unreadable everywhere; LIFT restores it', async t => {
  const a = await app(t);
  const name = encodeURIComponent(ADVERTISERS.JP);
  assert.equal((await a.get(`/api/advertiser?source=demo-market-beta&name=${name}`)).status, 200);
  const s = await a.post('/api/ops/control', { sourceId: 'demo-market-beta', kind: 'SUSPEND', reason: 'test suspension' });
  assert.deepEqual([s.status, s.body.control.kind, s.body.control.recordedBy, s.body.access.state, s.body.access.reasons], [200, 'SUSPEND', 'si_rights_admin', 'UNAVAILABLE', ['SUSPENDED']]);
  const h = await a.get(`/api/advertiser?source=demo-market-beta&name=${name}`);
  assert.deepEqual([h.status, h.body.error.code, h.body.error.reasons], [409, 'SOURCE_UNAVAILABLE', ['SUSPENDED']]);
  const q = await a.get('/api/search?q=juniper');
  assert.deepEqual([q.body.hits.length, q.body.excluded.find(x => x.sourceId === 'demo-market-beta').reasons], [0, ['SUSPENDED']]);
  const o = (await a.get('/api/overview')).body.sources.find(x => x.sourceId === 'demo-market-beta');
  assert.deepEqual([o.access.state, o.evidence], ['UNAVAILABLE', null]);
  const blocked = await a.post('/api/ops/collect', { sourceId: 'demo-market-beta', scenarioId: 'empty' });
  assert.deepEqual([blocked.body.outcome, blocked.body.code], ['REFUSED', 'SOURCE_SUSPENDED'], 'collection refused while suspended');
  const l = await a.post('/api/ops/control', { sourceId: 'demo-market-beta', kind: 'LIFT', reason: 'test lift' });
  assert.equal(l.body.access.state, 'AVAILABLE');
  assert.equal((await a.get(`/api/advertiser?source=demo-market-beta&name=${name}`)).status, 200);
});

test('APP-9: no credentials reach the browser; CSRF, host and input guards; fixed error codes only', async t => {
  const a = await app(t);
  const html = await (await fetch(a.base + '/')).text();
  const pages = [html, ...(await Promise.all(['/api/overview', '/api/sources', '/api/operations', '/api/search?q=synthetic',
    `/api/advertiser?source=demo-market-alpha&name=${encodeURIComponent(ADVERTISERS.NW)}`].map(async p => JSON.stringify((await a.get(p)).body))))];
  for (const p of pages) {
    assert.ok(!p.includes(PW) && !p.includes(cfg.adminPassword), 'no password in any response');
    assert.ok(!/postgres(ql)?:\/\//i.test(p) && !/"password"/i.test(p), 'no connection string or password field');
  }
  const headers = (await fetch(a.base + '/')).headers;
  assert.match(headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(headers.get('x-frame-options'), 'DENY');
  const noCsrf = await a.post('/api/ops/verify', {}, { 'Content-Type': 'application/json' });
  assert.deepEqual([noCsrf.status, noCsrf.body.error.code], [403, 'CSRF_REQUIRED']);
  const xorigin = await a.post('/api/ops/verify', {}, { 'Content-Type': 'application/json', 'X-SI-CSRF': a.csrfToken, Origin: 'http://evil.example' });
  assert.deepEqual([xorigin.status, xorigin.body.error.code], [403, 'ORIGIN_NOT_ALLOWED']);
  // fetch() does not let a caller forge Host; a raw request does (the DNS-rebinding case).
  const host = await new Promise((resolve, reject) => {
    const u = new URL(a.base);
    http.get({ host: u.hostname, port: u.port, path: '/api/overview', headers: { Host: 'evil.example' } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    }).on('error', reject);
  });
  assert.deepEqual([host.status, host.body.error.code], [421, 'HOST_NOT_ALLOWED']);
  for (const bad of ['/api/search?q=', `/api/search?q=${'x'.repeat(301)}`, '/api/search?q=a&networks=MYSPACE', '/api/search?q=a&from=2026-01-01',
                     '/api/search?q=a&from=2026-02-30&to=2026-03-01', '/api/search?q=a&limit=51', "/api/search?q=a&sources=x';drop",
                     '/api/advertiser?source=demo-market-alpha', '/api/advertiser?source=BAD!&name=a']) {
    const r = await a.get(bad);
    assert.deepEqual([r.status, r.body.error.code], [400, 'BAD_ARGUMENT'], bad);
  }
  const scenario = await a.post('/api/ops/collect', { sourceId: 'demo-market-alpha', scenarioId: 'free-form', rows: [{}] });
  assert.deepEqual([scenario.status, scenario.body.error.code], [400, 'BAD_ARGUMENT'], 'the browser cannot submit evidence');
  const ctl = await a.post('/api/ops/control', { sourceId: 'demo-market-alpha', kind: 'TERMINATE_RETENTION', reason: 'no' });
  assert.deepEqual([ctl.status, ctl.body.error.code], [400, 'BAD_ARGUMENT'], 'only SUSPEND and LIFT are exposed');
  const nf = await a.get('/api/../../etc/passwd');
  assert.equal(nf.status, 404);
});

test('APP-10: the synthetic setup is repeatable (same content on a second seed)', async t => {
  const snap = async a => {
    const o = (await a.get('/api/overview')).body;
    const s = (await a.get('/api/search?q=synthetic&limit=50')).body.hits.map(h => [h.sourceId, h.normalizedName, h.observations, h.distinctAds, h.runsWithEvidence, h.networks]);
    return { totals: o.totals, sources: o.sources.map(x => [x.sourceId, x.access.state, x.evidence?.observations ?? null]), s };
  };
  const one = await snap(await app(t)), two = await snap(await app(t));
  assert.deepEqual(two, one);
});
