// B-002 M4-P3.2: summary-backed advertiser search (migration 0023). Real disposable PostgreSQL 16, synthetic sources only.
//
// The reference is an INDEPENDENT observation-based oracle computed in JavaScript: the raw observations of the source, the
// runs readable by the unchanged per-run predicate si_evidence_readable (0007, the M3 oracle, not si_readable_runs), the
// period, the networks, and the normalizer (the identity rule itself, evaluated by the database). Grouping, distinct ads
// ((network, native_ad_id) pairs), runs, first/last, spellings, ordering (UTF-8 byte order = COLLATE "C"), cursors,
// has_more and the observation cap are recomputed here. Every request is checked twice: on the summary path and on the
// observation path forced by an open drift (the same requests, the same expected document).
//
// The path a request took is observed through the function's DEBUG message ('SI_READ_PATH summary|observations'),
// which the reader session receives with client_min_messages = debug1 (no response field, no stored state).
//
// Fixtures a product path cannot perform, labelled where used:
//   - FORCED FALLBACK: the owner appends a DRIFT_DETECTED event (then DRIFT_CLEARED) to the append-only drift log.
//   - TAMPERING (trusted-owner boundary, contract B): the superuser rewrites or deletes summary, status or identity rows
//     with session_replication_role = replica (append-only triggers and FKs bypassed), as TB-1 in m4-summaries-close.
//   - NORMALIZER CHANGE: si_normalizer_fingerprint replaced (owner), as SUM-5.
//   - INSTRUMENTED COPIES: the 0023 search text with a marked pause (tests/db/barriers.mjs) or lowered limits.
//
//   SS-1  exact equivalence with the oracle (randomized, 3 seeds): duplicate ads across runs, several networks, Unicode
//         and normalization, long names, spelling truncation, unreadable runs (INVALID, unverified, pending, expired),
//         period and network filters, two sources sharing names (no cross-source leakage), every page, exclusive and
//         inclusive cursors; the summary path is taken, and the forced observation path gives the same documents.
//   SS-2  fallback: missing status, stale fingerprint, coverage incomplete outside the page, in-statement guard,
//         and back to the summary path after backfill / clearing; every answer equals the oracle.
//   SS-3  security: revoked grant, suspension, termination, an ungranted source, live readability (verdict invalidated,
//         retention ended) after publication.
//   SS-4  concurrency: SUSPEND and a purge issued while the reader is held inside the summary block wait for it;
//         backfill and publication running concurrently with requests (each answer equals the oracle of a state).
//   SS-5  pagination boundaries, SS-6 resource caps (both paths), SS-7 malformed inputs (both paths).
//   SS-8  trusted-owner boundary: tampered summaries and a deleted identity are served until verification records the
//         drift; from then on the observation path answers exactly; rebuild and a clean verification restore the summary path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { asOwner, cfg, connect, control, createSources, freshDatabase, recordRights, roles, settle } from './helpers.mjs';
import { latestDefinition } from './durability-fixtures.mjs';
import { PAUSE_SQL, armPause, awaitMarkedPause, observeCall, pauseMarker, releasePause } from './barriers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader, revokeReader, beginRead } from '../../dist/persistence/reader.js';
import * as INTEL from '../../dist/persistence/intelligence.js';

const SEARCH_DEF = latestDefinition('si_search_advertisers', 'END $search$;');
const SEARCH_FN = SEARCH_DEF.text;
const ROLES = ['admin', 'si_rights_admin', 'si_collector', 'si_retention', 'si_monitor'];
const CAP = 200000;
let n = 0;
test.before(async () => { const a = await connect(); try { await provisionReaderPrincipal(a, 'si_reader_alice', cfg.rolePassword); } finally { await a.end(); } });

test('SS-0: the active search function is 0023 (summary path present, 0018 observation statement kept)', () => {
  assert.equal(SEARCH_DEF.file, '0023_summary_backed_search.up.sql');
  for (const s of ['si.si_summary_coverage(p_source_id)', 'count(DISTINCT u.ad_id)::int AS distinct_ads',
                   'count(DISTINCT (c.network, c.native_ad_id))::int AS distinct_ads', "RAISE DEBUG 'SI_READ_PATH %'"]) assert.equal(SEARCH_FN.split(s).length, 2, s);
});

// ------------------------------------------------------------------------------------------------ fixtures
function mutate(text, from, to) { assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 70)}`); return text.replace(from, () => to); }
async function fresh(t, prefix = 'm4ss') {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ROLES);
  const extra = [];
  t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  Object.defineProperty(x, 'connect', { enumerable: false, value: async user => { const k = await connect({ user, database: db }); extra.push(k); return k; } });
  return x;
}
const AD = (name, id, network = 'META', o = {}) => ({ network, nativeAdId: id, advertiserName: name, countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: `https://example.test/${encodeURIComponent(id)}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}`, ...o });
async function source(x, { grant = true, networks = ['META', 'TIKTOK', 'GOOGLE'] } = {}) {
  const src = `ss-${++n}`;
  await createSources(x.admin, [src], networks);
  await recordRights(x.si_rights_admin, src, {});
  if (grant) await grantReader(x.si_rights_admin, 'si_reader_alice', src, 'm4-p3.2 summary-backed search');
  return src;
}
async function collect(x, src, rows, { verify = true, collector = x.si_collector } = {}) {
  const networks = rows.length ? [...new Set(rows.map(r => r.network))].sort() : ['META'];
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `ss${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await collector.query('BEGIN');
  try { await collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]); await collector.query('COMMIT'); }
  catch (e) { await collector.query('ROLLBACK').catch(() => {}); throw e; }
  if (verify) await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');
  return run.run_id;
}
async function replica(x, sql, params) {
  await x.admin.query('BEGIN');
  try { await x.admin.query('SET LOCAL session_replication_role = replica'); await x.admin.query(sql, params); await x.admin.query('COMMIT'); }
  catch (e) { await x.admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const DAY = 86400000;
const day = k => new Date(Date.UTC(2026, 9, 1) + k * DAY);
const at = (x, runId, d) => replica(x, `UPDATE si.collection_runs SET started_at = $2::timestamptz - interval '1 second', finished_at = $2::timestamptz WHERE run_id = $1`, [runId, d.toISOString()]);
const invalid = (x, run) => replica(x, `INSERT INTO si.receipt_verifications (run_id, source_id, rights_version_id, verdict, reason, commit_xid, commit_ts, window_start, window_end, verified_at, verified_by)
    SELECT r.run_id, r.source_id, r.rights_version_id, 'INVALID', 'COMMITTED_AFTER_WINDOW', 3, r.finished_at, r.finished_at - interval '1 hour', r.finished_at, clock_timestamp(), 'fixture'
      FROM si.collection_runs r WHERE r.run_id = $1`, [run]);
const invalidate = (x, run) => replica(x, `UPDATE si.receipt_verifications SET verdict = 'INVALID', reason = 'COMMITTED_AFTER_WINDOW', window_end = commit_ts WHERE run_id = $1`, [run]);   // a VALID verdict rewritten
const expire = (x, run) => replica(x, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [run]);
const forceFallback = (x, src) => x.admin.query(`INSERT INTO si.summary_events (source_id, kind, finding) VALUES ($1, 'DRIFT_DETECTED', 'MISSING')`, [src]);
const clearFallback = (x, src) => x.admin.query(`INSERT INTO si.summary_events (source_id, kind) VALUES ($1, 'DRIFT_CLEARED')`, [src]);

// ------------------------------------------------------------------------------------------------ the reader, with its path
async function reader(x) {
  const c = await x.connect('si_reader_alice');
  await c.query('SET client_min_messages = debug1');
  c.paths = [];
  c.on('notice', m => { const k = /^SI_READ_PATH (summary|observations)$/.exec(m.message); if (k) c.paths.push(k[1]); });
  return c;
}
const us = d => (d ? d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z') : null);
const scope = (src, r) => INTEL.intelligenceScope('search', src, [r.q, r.n.join(','), us(r.from), us(r.to), r.after, String(r.incl)]);
/** One audited request through the SQL function (fresh intent; bounded retry on INTENT_NOT_DURABLE only). */
async function search(alice, src, r) {
  for (let attempt = 0; ; attempt++) {
    const before = alice.paths.length;
    let id;
    try { id = await beginRead(alice, src, { cursor: scope(src, r), limit: r.limit }); }
    catch (e) { return { out: `BEGIN:${e.code ?? e.message}` }; }
    const res = await settle(alice.query('SELECT si.si_search_advertisers($1, $2, $3, $4::text[], $5, $6, $7, $8, $9) AS doc',
      [src, id, r.q, r.n, r.from, r.to, r.after, r.incl, r.limit]));
    if (res.status !== 'ok' && /^SI_READ_INTENT_NOT_DURABLE/.test(String(res.message)) && attempt < 3) continue;
    const path = alice.paths.slice(before).at(-1) ?? null;
    if (res.status !== 'ok') return { out: String(res.message).match(/^SI_[A-Z_]+/)?.[0] ?? `SQLSTATE:${res.code}`, path };
    const d = res.value.rows[0].doc;
    return { out: 'ok', doc: { source_id: d.source_id, normalized_query: d.normalized_query, hits: d.hits, has_more: d.has_more }, path };
  }
}
const R = (q, o = {}) => ({ q, n: [], from: null, to: null, after: null, incl: false, limit: 50, ...o });

// ------------------------------------------------------------------------------------------------ the independent oracle
const utf8cmp = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
/** Raw observations of the source in runs readable by si_evidence_readable (optionally only `runs`), normalized by the DB. */
async function observations(x, src, runs = null) {
  return (await x.admin.query(`SELECT o.run_id, o.network, o.native_ad_id, o.advertiser_name, si.si_normalize_advertiser(o.advertiser_name) AS nn,
                                      r.finished_at, si.si_intelligence_iso(r.finished_at) AS fin
                                 FROM si.observations o JOIN si.collection_runs r ON r.run_id = o.run_id
                                WHERE o.source_id = $1 AND r.status = 'COMPLETED' AND r.retention_state = 'RETAINED' AND r.published_count > 0
                                  AND ($2::uuid[] IS NULL OR r.run_id = ANY ($2::uuid[]))
                                  AND si.si_evidence_readable(r.run_id)`, [src, runs])).rows;
}
async function oracle(x, src, r, obs = null, cap = CAP) {
  const q = (await x.admin.query('SELECT si.si_normalize_advertiser($1) AS q', [r.q])).rows[0].q;
  obs ??= await observations(x, src);
  const cand = obs.filter(o => (!r.from || (o.finished_at >= r.from && o.finished_at < r.to)) && (r.n.length === 0 || r.n.includes(o.network)) && o.nn.includes(q));
  if (cand.length > cap) return { out: 'SI_READ_SCAN_LIMIT' };
  const g = new Map();
  for (const o of cand) {
    const e = g.get(o.nn) ?? { nn: o.nn, obs: 0, ads: new Set(), runs: new Set(), fins: [], nets: new Set(), names: new Set() };
    e.obs++; e.ads.add(`${o.network}\u0000${o.native_ad_id}`); e.runs.add(o.run_id); e.fins.push(o.fin); e.nets.add(o.network); e.names.add(o.advertiser_name);
    g.set(o.nn, e);
  }
  const groups = [...g.values()].filter(e => r.after === null || utf8cmp(e.nn, r.after) > 0 || (r.incl && e.nn === r.after)).sort((a, b) => utf8cmp(a.nn, b.nn));
  const page = groups.slice(0, r.limit).map(e => {
    const names = [...e.names].sort(utf8cmp), fins = e.fins.sort();
    return { normalized_name: e.nn, names: names.slice(0, 10), names_truncated: names.length > 10, observations: e.obs, distinct_ads: e.ads.size,
             runs_with_evidence: e.runs.size, first_observed_at: fins[0], last_observed_at: fins.at(-1), networks: [...e.nets].sort(utf8cmp) };
  });
  return { out: 'ok', doc: { source_id: src, normalized_query: q, hits: page, has_more: groups.length > r.limit } };
}
/** Follows every page (exclusive cursor) and returns the per-page results. */
async function pages(alice, src, r, max = 200) {
  const out = [];
  for (let req = { ...r }, i = 0; i < max; i++) {
    const s = await search(alice, src, req);
    out.push({ req: { ...req }, ...s });
    if (s.out !== 'ok' || !s.doc.has_more) break;
    req = { ...req, after: s.doc.hits.at(-1).normalized_name, incl: false };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ a randomized dataset
function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const NAMES = ['Northwind Synthetic', 'NORTHWIND  synthetic', 'Northwind\t Synthetic', 'Ｎｏｒｔｈｗｉｎｄ Synthetic', 'Northwind Synthetic Labs',
  'Contoso Ltd', 'Contoso Ltd.', 'contoso　ltd', 'Ålesund Ægir', 'Ålesund Ægir', 'Ｃａｆé ☕ Synthetic', '🦊 Fox Synthetic', 'İstanbul Synthetic',
  'Straße Synthetic', 'STRASSE Synthetic', 'x'.repeat(1000), 'Zeta ' + 'é'.repeat(300), 'ﬁne Synthetic', 'Fabrikam', 'Fabrikam (DE)',
  ...['Acme', 'ACME', 'acme', 'AcMe', 'aCME', 'ACme', 'AcmE', 'aCme', 'acMe', 'acmE', 'ACMe', 'AcME'].map(s => `${s} Synthetic`)];
const QUERIES = ['north', 'synthetic', 'contoso', 'contoso ltd', 'ålesund', 'Ålesund', 'ｓｙｎ', '🦊', 'xxxx', 'é', 'ss', 'fi', 'acme', 'fabrikam (', 'zzz-none', 'i̇stanbul'];
/** Publishes `runs` runs per source; ads have a fixed (network, name) per native id, so the same ad recurs across runs. */
async function dataset(x, seed, { sources = 2, runs = 8 } = {}) {
  const rnd = prng(seed), pick = a => a[Math.floor(rnd() * a.length)];
  const srcs = [];
  for (let s = 0; s < sources; s++) srcs.push(await source(x));
  const adPool = Array.from({ length: 40 }, (_, i) => ({ id: `ad-${i}`, name: NAMES[i % NAMES.length], network: ['META', 'TIKTOK', 'GOOGLE'][(i * 7) % 3] }));
  const meta = { runs: {} };
  for (const src of srcs) {
    meta.runs[src] = [];
    for (let k = 0; k < runs; k++) {
      const ads = [...new Set(Array.from({ length: 3 + Math.floor(rnd() * 10) }, () => pick(adPool)))];
      const state = k === 0 ? 'ok' : pick(['ok', 'ok', 'ok', 'ok', 'invalid', 'pending', 'expired']);
      const run = await collect(x, src, ads.map(a => AD(a.name, a.id, a.network)), { verify: state !== 'pending' && state !== 'invalid' });
      if (state === 'invalid') await invalid(x, run);
      if (state === 'expired') await expire(x, run);
      await at(x, run, new Date(day(1 + k).getTime() + 3600000 * (k % 5)));
      meta.runs[src].push({ run, state, k });
    }
  }
  return { srcs, meta };
}
function requests(seed) {
  const rnd = prng(seed * 7 + 1), out = [];
  for (const q of QUERIES) {
    out.push(R(q, { limit: 1 + Math.floor(rnd() * 4) }));
    out.push(R(q, { n: [['META'], ['TIKTOK'], ['GOOGLE', 'META']][Math.floor(rnd() * 3)], limit: 2 }));
    out.push(R(q, { from: day(2), to: day(6), limit: 3 }));
  }
  out.push(R('a', { limit: 50 }), R('synthetic', { limit: 50 }));
  return out;
}

// ------------------------------------------------------------------------------------------------ SS-1
for (const seed of [11, 23, 47]) {
  test(`SS-1 (seed ${seed}): every page equals the observation oracle on the summary path, and on the forced observation path`, { timeout: 600000 }, async t => {
    const x = await fresh(t, 'm4ss1');
    const { srcs } = await dataset(x, seed);
    const alice = await reader(x);
    let compared = 0, inclusive = 0;
    for (const mode of ['summary', 'observations']) {
      if (mode === 'observations') for (const s of srcs) await forceFallback(x, s);
      for (const src of srcs) {
        const obs = await observations(x, src);
        for (const r of requests(seed)) {
          for (const p of await pages(alice, src, r)) {
            assert.deepEqual(p, { req: p.req, ...(await oracle(x, src, p.req, obs)), path: p.path }, `${mode} ${src} ${JSON.stringify(p.req)}`);
            assert.equal(p.path, p.out === 'ok' || p.out === 'SI_READ_SCAN_LIMIT' ? mode : p.path, `${mode} path for ${JSON.stringify(p.req)}`);
            compared++;
            if (p.out === 'ok' && p.doc.hits.length) {                       // the same position, inclusive: the boundary group comes back first
              const ri = { ...p.req, after: p.doc.hits[0].normalized_name, incl: true };
              const si = await search(alice, src, ri);
              assert.deepEqual(si, { ...(await oracle(x, src, ri, obs)), path: mode }, `${mode} inclusive ${JSON.stringify(ri)}`);
              assert.equal(si.doc.hits[0].normalized_name, p.doc.hits[0].normalized_name);
              inclusive++;
            }
          }
        }
      }
    }
    console.log(`# SS-1 seed ${seed}: ${compared} pages and ${inclusive} inclusive positions equal to the oracle on both paths`);
  });
}

test('SS-1b: distinct ads are the union across runs and networks, never the sum of per-run counts; sources never mix', async t => {
  const x = await fresh(t);
  const a = await source(x), b = await source(x);
  await collect(x, a, [AD('Northwind Synthetic', 'n1'), AD('Northwind Synthetic', 'n2', 'TIKTOK')]);
  await collect(x, a, [AD('Northwind Synthetic', 'n1'), AD('NORTHWIND synthetic', 'n3')]);
  await collect(x, a, [AD('Northwind Synthetic', 'n1'), AD('Northwind Synthetic', 'n2', 'TIKTOK')]);
  await collect(x, b, [AD('Northwind Synthetic', 'n1'), AD('Northwind Synthetic', 'n9')]);
  const alice = await reader(x);
  const h = (await search(alice, a, R('north'))).doc.hits;
  assert.deepEqual(h.map(z => [z.normalized_name, z.observations, z.distinct_ads, z.runs_with_evidence, z.networks, z.names]),
    [['northwind synthetic', 6, 3, 3, ['META', 'TIKTOK'], ['NORTHWIND synthetic', 'Northwind Synthetic']]]);
  assert.deepEqual(alice.paths, ['summary']);
  assert.deepEqual((await search(alice, b, R('north'))).doc.hits.map(z => [z.observations, z.distinct_ads]), [[2, 2]]);
  for (const s of [a, b]) assert.deepEqual(await search(alice, s, R('north')), { ...(await oracle(x, s, R('north'))), path: 'summary' });
});

// ------------------------------------------------------------------------------------------------ SS-2 fallback
async function small(x) {
  const s = await source(x);
  const runs = [];
  runs.push(await collect(x, s, [AD('Northwind Synthetic', 'f1'), AD('Contoso Ltd', 'f2', 'TIKTOK')]));
  runs.push(await collect(x, s, [AD('Northwind Synthetic', 'f1'), AD('Northwind Synthetic Labs', 'f3')]));
  runs.push(await collect(x, s, [AD('Contoso Ltd.', 'f4'), AD('Northwind Synthetic', 'f5')]));
  for (const [i, r] of runs.entries()) await at(x, r, new Date(day(1 + 2 * i).getTime()));
  return { s, runs };
}
const both = async (x, alice, s, r, path) => assert.deepEqual(await search(alice, s, r), { ...(await oracle(x, s, r)), path }, `${path} ${JSON.stringify(r)}`);

test('SS-2a: a run whose status (and summaries) are missing makes the source ineligible: the observation path answers exactly; backfill restores the summary path', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const alice = await reader(x);
  await both(x, alice, s, R('north'), 'summary');
  await replica(x, 'DELETE FROM si.run_advertiser_summaries WHERE run_id = $1', [runs[1]]);          // TAMPERING: a never-summarized run
  await replica(x, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [runs[1]]);
  for (const r of [R('north'), R('contoso'), R('north', { after: 'northwind synthetic', incl: true }), R('syn', { n: ['META'] })]) await both(x, alice, s, r, 'observations');
  assert.deepEqual((await x.admin.query('SELECT * FROM si.si_summary_coverage($1)', [s])).rows[0], { eligible: false, reasons: ['INCOMPLETE'] });
  await asOwner(x.admin, a => a.query('SELECT * FROM si.si_backfill_summaries(100)'));
  await both(x, alice, s, R('north'), 'summary');
});

test('SS-2b: a stale normalizer fingerprint (ICU or major-version change) falls back for every run; backfill re-derives and the summary path returns', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await reader(x);
  await both(x, alice, s, R('north'), 'summary');
  await asOwner(x.admin, a => a.query(`CREATE OR REPLACE FUNCTION si.si_normalizer_fingerprint() RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
                                         AS $f$ SELECT 'v1|icu=simulated-upgrade|pg=16' $f$`));                     // NORMALIZER CHANGE
  for (const r of [R('north'), R('contoso', { limit: 1 }), R('labs')]) await both(x, alice, s, r, 'observations');
  for (let i = 0; i < 5 && (await asOwner(x.admin, a => a.query('SELECT * FROM si.si_backfill_summaries(100)'))); i++) {
    if ((await x.admin.query('SELECT (si.si_summary_coverage($1)).eligible AS e', [s])).rows[0].e) break;
  }
  await both(x, alice, s, R('north'), 'summary');
});

test('SS-2c: coverage is source-wide: an unsummarized run OUTSIDE the requested period still forces the observation path (conservative)', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const alice = await reader(x);
  await replica(x, 'DELETE FROM si.run_advertiser_summaries WHERE run_id = $1', [runs[2]]);
  await replica(x, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [runs[2]]);
  await both(x, alice, s, R('north', { from: day(0), to: day(4) }), 'observations');             // runs[2] (day 5) is outside the period
});

test('SS-2d: the in-statement guard falls back even when eligibility is wrong (coverage replaced by an always-eligible copy)', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const alice = await reader(x);
  await asOwner(x.admin, a => a.query(`CREATE OR REPLACE FUNCTION si.si_summary_coverage(p_source_id text) RETURNS TABLE (eligible boolean, reasons text[])
                                         LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $c$ SELECT true, '{}'::text[] $c$`));
  await both(x, alice, s, R('north'), 'summary');
  await replica(x, 'DELETE FROM si.run_advertiser_summaries WHERE run_id = $1', [runs[1]]);
  await replica(x, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [runs[1]]);
  await both(x, alice, s, R('north'), 'observations');                                       // status gap: guard
  await clearFallback(x, s); await forceFallback(x, s);                                       // drift: guard (coverage still says eligible)
  await asOwner(x.admin, a => a.query('SELECT * FROM si.si_backfill_summaries(100)'));
  await both(x, alice, s, R('north'), 'observations');
  await clearFallback(x, s);
  await both(x, alice, s, R('north'), 'summary');
});

// M4-P3.2-CLOSE-01 (IM7 of M4-P3.2-ACCEPT-01): the guard's CURRENT-FINGERPRINT clause, decisive on its own. Double fault, in
// this disposable database only: eligibility is wrong (an always-eligible coverage copy, as SS-2d) AND the normalizer
// fingerprint changed (as SS-2b) before any backfill. Every readable run still has a status, so a guard that only counted
// statuses would pass; but every status, identity and summary row carries the OLD fingerprint, so a summary page under the
// current fingerprint finds no identity and would answer differently from the oracle. Only `ss.normalizer = fp` in the
// guard sends the request to the observation path.
test('SS-2e: wrong eligibility AND a stale fingerprint: the guard rejects statuses of the old fingerprint and the observation path answers exactly', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await reader(x);
  await both(x, alice, s, R('north'), 'summary');
  const old = (await x.admin.query('SELECT si.si_normalizer_fingerprint() AS f')).rows[0].f;
  await asOwner(x.admin, a => a.query(`CREATE OR REPLACE FUNCTION si.si_summary_coverage(p_source_id text) RETURNS TABLE (eligible boolean, reasons text[])
                                         LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $c$ SELECT true, '{}'::text[] $c$`));   // WRONG ELIGIBILITY
  await asOwner(x.admin, a => a.query(`CREATE OR REPLACE FUNCTION si.si_normalizer_fingerprint() RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
                                         AS $f$ SELECT 'v1|icu=simulated-upgrade|pg=16' $f$`));                                                 // NORMALIZER CHANGE
  const cur = (await x.admin.query('SELECT si.si_normalizer_fingerprint() AS f')).rows[0].f;
  assert.notEqual(cur, old);
  // The state in which only the fingerprint clause can refuse the summary path:
  const st = (await x.admin.query(`
    WITH rr AS (SELECT si.si_readable_runs($1, NULL, NULL) AS a)
    SELECT (SELECT (si.si_summary_coverage($1)).eligible) AS eligible, si.si_summary_drift_open($1) AS drift,
           (SELECT cardinality(a) FROM rr) AS readable,
           (SELECT count(*)::int FROM si.run_summary_status ss, rr WHERE ss.run_id = ANY (rr.a) AND ss.source_id = $1) AS statuses,
           (SELECT count(*)::int FROM si.run_summary_status ss, rr WHERE ss.run_id = ANY (rr.a) AND ss.source_id = $1 AND ss.normalizer = $2) AS statuses_old,
           (SELECT count(*)::int FROM si.run_summary_status ss WHERE ss.source_id = $1 AND ss.normalizer = $3) AS statuses_current,
           (SELECT count(*)::int FROM si.advertiser_identities i WHERE i.source_id = $1 AND i.normalizer = $3) AS identities_current,
           (SELECT count(*)::int FROM si.advertiser_identities i WHERE i.source_id = $1 AND i.normalizer = $2) AS identities_old`, [s, old, cur])).rows[0];
  assert.ok(st.readable > 0, JSON.stringify(st));
  assert.deepEqual(st, { eligible: true, drift: false, readable: st.readable, statuses: st.readable, statuses_old: st.readable, statuses_current: 0,
                         identities_current: 0, identities_old: st.identities_old }, 'precondition: wrong eligibility, no drift, a status for every readable run, all of the OLD fingerprint');
  assert.ok(st.identities_old > 0);
  for (const r of [R('north'), R('contoso', { limit: 1 }), R('labs'), R('synthetic', { n: ['META'] })]) {
    const want = await oracle(x, s, r);
    assert.ok(want.out === 'ok' && want.doc.hits.length > 0, `precondition: the oracle answer for ${r.q} is not empty (a summary page under the current fingerprint would be): ${JSON.stringify(want).slice(0, 200)}`);
    const got = await search(alice, s, r);
    assert.equal(got.path, 'observations', `${r.q}: statuses of the old fingerprint must not admit the summary path (IM7)`);
    assert.deepEqual(got, { ...want, path: 'observations' }, `${r.q}: the observation path answers exactly`);
  }
});

// ------------------------------------------------------------------------------------------------ SS-3 security
test('SS-3: authorization, availability and readability stay live on the summary path', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const other = await source(x, { grant: false });
  await collect(x, other, [AD('Northwind Synthetic', 'o1')]);
  const alice = await reader(x);
  await both(x, alice, s, R('north'), 'summary');
  assert.equal((await search(alice, other, R('north'))).out, 'BEGIN:NOT_AUTHORIZED');            // never granted
  // Readability is evaluated per request: a verdict invalidated and a retention ended after publication drop the runs.
  await invalidate(x, runs[0]); await both(x, alice, s, R('north'), 'summary');
  await expire(x, runs[1]); await both(x, alice, s, R('north'), 'summary');
  assert.deepEqual((await search(alice, s, R('labs'))).doc.hits, []);                              // only in runs[1]
  // Revocation between the intent and the call (the intent was granted).
  const id = await beginRead(alice, s, { cursor: scope(s, R('north')), limit: 50 });
  await revokeReader(x.si_rights_admin, 'si_reader_alice', s, 'ss-3');
  const r = await settle(alice.query('SELECT si.si_search_advertisers($1, $2, $3, $4::text[], NULL, NULL, NULL, false, 50) AS doc', [s, id, 'north', []]));
  assert.match(String(r.message), /^SI_READ_NOT_AUTHORIZED/);
  await grantReader(x.si_rights_admin, 'si_reader_alice', s, 'again');
  await both(x, alice, s, R('north'), 'summary');
  await control(x.si_rights_admin, s, 'SUSPEND');
  assert.equal((await search(alice, s, R('north'))).out, 'SI_READ_SOURCE_UNAVAILABLE');
});

// ------------------------------------------------------------------------------------------------ SS-4 concurrency
/** The 0023 text with a marked pause AFTER the coverage call (inside the summary block, under the source lock). */
const PAUSED = mutate(SEARCH_FN, '    IF cov.eligible IS TRUE THEN\n', PAUSE_SQL.replace(/^/gm, '  ') + '    IF cov.eligible IS TRUE THEN\n');
async function heldRequest(x, s, r) {
  await asOwner(x.admin, a => a.query(PAUSED));
  const alice = await reader(x), holder = await x.connect(undefined);
  const alicePid = (await alice.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const p = pauseMarker(); await armPause(holder, alice, p);
  const pending = search(alice, s, r);
  await awaitMarkedPause(x.admin, alicePid, p.mark);
  return { alice, alicePid, pending, release: () => releasePause(holder, p) };
}
test('SS-4a: a SUSPEND and a TERMINATE issued while the reader is inside the summary block wait for it; the page is the pre-control answer', async t => {
  for (const kind of ['SUSPEND', 'TERMINATE_RETENTION']) {
    const x = await fresh(t);
    const { s } = await small(x);
    const expected = await oracle(x, s, R('north'));
    const h = await heldRequest(x, s, R('north'));
    const raPid = (await x.si_rights_admin.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const obs = await observeCall(x.admin, { waiterPid: raPid, holderPid: h.alicePid, call: () => control(x.si_rights_admin, s, kind) });
    assert.equal(obs.state, 'blocked', `${kind} waits for the reader's source lock: ${obs.trace}`);
    await h.release();
    assert.deepEqual(await h.pending, { ...expected, path: 'summary' });
    assert.equal((await obs.result).status, 'ok');
    const after = await search(await reader(x), s, R('north'));
    assert.equal(after.out, 'SI_READ_SOURCE_UNAVAILABLE', `${kind}: the next request sees the control`);
  }
});
test('SS-4b: a purge issued while the reader is inside the summary block skips the source (SKIP LOCKED) and removes nothing; after the read it purges, and answers stay exact', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  await expire(x, runs[1]);
  const expected = await oracle(x, s, R('north'));
  const h = await heldRequest(x, s, R('north'));
  const retPid = (await x.si_retention.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const obs = await observeCall(x.admin, { waiterPid: retPid, holderPid: h.alicePid, call: () => x.si_retention.query('SELECT * FROM si.si_purge_due(20)') });
  assert.equal(obs.state, 'completed', `the purge does not wait for the reader (0006: FOR NO KEY UPDATE SKIP LOCKED): ${obs.trace}`);
  assert.notEqual((await obs.result).value.rows[0]?.outcome, 'PURGED', 'the held source is skipped');
  assert.ok((await x.admin.query('SELECT count(*)::int AS n FROM si.run_advertiser_summaries WHERE run_id = $1', [runs[1]])).rows[0].n > 0, 'nothing removed under the reader');
  await h.release();
  assert.deepEqual(await h.pending, { ...expected, path: 'summary' });
  assert.equal((await x.si_retention.query('SELECT * FROM si.si_purge_due(20)')).rows[0].outcome, 'PURGED');
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.run_advertiser_summaries WHERE run_id = $1', [runs[1]])).rows[0].n, 0);
  const alice = await reader(x);
  for (const r of [R('north'), R('labs'), R('contoso')]) await both(x, alice, s, r, 'summary');
});
test('SS-4c: backfill running concurrently with requests: every answer equals the oracle; the path turns to summary once coverage is complete', async t => {
  const x = await fresh(t);
  const s = await source(x);
  const runs = [];
  for (let i = 0; i < 30; i++) runs.push(await collect(x, s, [AD('Northwind Synthetic', `b${i % 7}`), AD(`Contoso ${i % 4}`, `c${i}`, 'TIKTOK')]));
  for (const r of runs) { await replica(x, 'DELETE FROM si.run_advertiser_summaries WHERE run_id = $1', [r]); await replica(x, 'DELETE FROM si.run_summary_status WHERE run_id = $1', [r]); }
  for (const r of runs) await replica(x, `DELETE FROM si.advertiser_identities i WHERE i.source_id = $1 AND NOT EXISTS (SELECT 1 FROM si.run_advertiser_summaries z WHERE z.identity_id = i.identity_id)`, [s]);
  const expected = { north: await oracle(x, s, R('north')), contoso: await oracle(x, s, R('contoso', { limit: 2 })) };
  const alice = await reader(x);
  let done = false;
  const backfill = (async () => { const c = await x.connect(undefined); await c.query('SET ROLE si_owner');
    for (let i = 0; i < 40; i++) { await c.query('SELECT * FROM si.si_backfill_summaries(1)'); await new Promise(z => setTimeout(z, 5)); } done = true; })();
  const seen = new Set();
  while (!done) {
    const a = await search(alice, s, R('north')), b = await search(alice, s, R('contoso', { limit: 2 }));
    assert.deepEqual(a, { ...expected.north, path: a.path }); assert.deepEqual(b, { ...expected.contoso, path: b.path });
    seen.add(a.path); seen.add(b.path);
  }
  await backfill;
  assert.deepEqual(await search(alice, s, R('north')), { ...expected.north, path: 'summary' });
  assert.ok(seen.has('observations'), 'the observation path answered while backfill was incomplete');
});
test('SS-4d: publication running concurrently with requests: every answer equals the oracle of a readable state the publisher committed', async t => {
  const x = await fresh(t);
  const s = await source(x);
  await collect(x, s, [AD('Northwind Synthetic', 'p0')]);
  const alice = await reader(x);
  const collector = await x.connect('si_collector');
  // The publisher is the only writer: readability changes only when one of its statements commits (a completion leaves
  // the run pending; a verification call commits its verdicts atomically). It records the readable set after each step,
  // so the chain below holds every state a request could have seen.
  const readableSet = async () => (await x.admin.query(`SELECT array_agg(r.run_id ORDER BY r.run_id)::text[] AS a FROM si.collection_runs r
                                                         WHERE r.source_id = $1 AND r.status = 'COMPLETED' AND si.si_evidence_readable(r.run_id)`, [s])).rows[0].a ?? [];
  const chain = [await readableSet()];
  let done = false;
  const publishing = (async () => {
    for (let i = 1; i <= 30; i++) {
      await collect(x, s, [AD('Northwind Synthetic', `p${i % 5}`), AD(`NORTHWIND synthetic ${i % 3}`, `q${i}`, 'TIKTOK')], { collector, verify: false });
      chain.push(await readableSet());
      await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)');
      chain.push(await readableSet());
    }
    done = true;
  })();
  const answers = [];
  while (!done) answers.push(await search(alice, s, R('north', { limit: 2 })));
  await publishing;
  const allObs = await observations(x, s);
  const states = [];
  for (const set of chain) { const k = JSON.stringify(set); if (!states.some(z => z.k === k)) states.push({ k, o: await oracle(x, s, R('north', { limit: 2 }), allObs.filter(o => set.includes(o.run_id))) }); }
  for (const a of answers) {
    assert.equal(a.path, 'summary');
    const { path, ...rest } = a;
    assert.ok(states.some(z => isDeepStrictEqual(z.o, rest)), `an answer equals the oracle of a committed readable state: ${JSON.stringify(rest).slice(0, 600)}`);
  }
  console.log(`# SS-4d: ${answers.length} answers during 30 publications (${states.length} distinct readable states), each equal to the oracle of one of them`);
});

// ------------------------------------------------------------------------------------------------ SS-5 pagination, SS-6 caps, SS-7 inputs
test('SS-5: pagination boundaries (limit 1 and 50, inclusive and exclusive, 1000-character names, positions between and beyond names) on both paths', async t => {
  const x = await fresh(t);
  const s = await source(x);
  const long = 'Q'.repeat(999) + 'a', long2 = 'Q'.repeat(999) + 'b';
  await collect(x, s, [AD('Alpha Synthetic', 'a'), AD('alpha synthetic', 'a2'), AD('Beta Synthetic', 'b'), AD(long, 'l1'), AD(long2, 'l2'), AD('Ωmega Synthetic', 'o'), AD('ｚeta Synthetic', 'z')]);
  const alice = await reader(x);
  const positions = [null, 'alpha synthetic', 'alpha synthetic ', 'alpha', 'beta synthetic', long.toLowerCase(), 'q', 'zzzz', '\u{10FFFF}', 'ωmega synthetic'];
  for (const mode of ['summary', 'observations']) {
    if (mode === 'observations') await forceFallback(x, s);
    for (const after of positions) for (const incl of [false, true]) for (const limit of [1, 2, 50]) {
      const r = R(after === null ? 'a' : 'a', { after, incl, limit });
      assert.deepEqual(await search(alice, s, r), { ...(await oracle(x, s, r)), path: mode }, `${mode} ${JSON.stringify({ after: after?.slice(0, 20), incl, limit })}`);
    }
    for (const q of ['q', 'synthetic', 'eta']) for (const p of await pages(alice, s, R(q, { limit: 1 }))) assert.deepEqual(p, { req: p.req, ...(await oracle(x, s, p.req)), path: mode });
  }
});
test('SS-6: the observation cap and the byte bound are exactly the observation path\'s (instrumented copies with lowered limits, both paths)', async t => {
  const x = await fresh(t);
  const s = await source(x);
  await collect(x, s, Array.from({ length: 6 }, (_, i) => AD(`Northwind ${String.fromCharCode(65 + i)}`, `cap${i}`)));
  await collect(x, s, [AD('Northwind A', 'cap0'), AD('Northwind B', 'cap9', 'TIKTOK')]);           // 8 matching observations
  const alice = await reader(x);
  for (const mode of ['summary', 'observations']) {
    if (mode === 'observations') await forceFallback(x, s);
    for (const cap of [7, 8]) {
      await asOwner(x.admin, a => a.query(mutate(SEARCH_FN, 'max_candidates constant int := 200000;', `max_candidates constant int := ${cap};`)));
      const got = await search(alice, s, R('northwind', { limit: 2 }));
      assert.deepEqual(got, { ...(await oracle(x, s, R('northwind', { limit: 2 }), null, cap)), path: mode }, `${mode} cap ${cap}`);
      assert.equal(got.out, cap === 7 ? 'SI_READ_SCAN_LIMIT' : 'ok');
      assert.equal((await search(alice, s, R('northwind', { limit: 2, n: ['TIKTOK'] }))).out, 'ok', 'the cap counts only the filtered observations');
    }
    const one = await alice.query(`SELECT 1`).then(() => search(alice, s, R('northwind', { limit: 1 })));
    const bound = Buffer.byteLength(JSON.stringify(one.doc.hits[0])) + 400;          // one hit fits; five do not
    await asOwner(x.admin, a => a.query(mutate(SEARCH_FN, 'max_bytes constant int := 262144;', `max_bytes constant int := ${bound};`)));
    assert.deepEqual([(await search(alice, s, R('northwind', { limit: 1 }))).out, (await search(alice, s, R('northwind', { limit: 5 }))).out], ['ok', 'SI_READ_RESULT_TOO_LARGE']);
    await asOwner(x.admin, a => a.query(SEARCH_FN));
  }
});
test('SS-7: malformed inputs are refused identically on both paths', async t => {
  const x = await fresh(t);
  const { s } = await small(x);
  const alice = await reader(x);
  const bad = [R('north', { limit: 0 }), R('north', { limit: 51 }), R('x'.repeat(301)), R(' \t　 '), R('north', { after: '' }), R('north', { after: 'x'.repeat(18001) }),
    R('north', { n: ['MYSPACE'] }), R('north', { from: day(5), to: day(5) }), R('north', { from: day(1), to: null }), R('north', { incl: null })];
  const outcome = async () => { const o = []; for (const r of bad) { const z = await search(alice, s, r); o.push(z.out); } return o; };
  const a = await outcome(); await forceFallback(x, s); const b = await outcome();
  assert.deepEqual(a, b);
  assert.ok(a.every(z => z !== 'ok'), JSON.stringify(a));
  console.log(`# SS-7 outcomes: ${JSON.stringify(a)}`);
});

// ------------------------------------------------------------------------------------------------ SS-8 trusted-owner boundary
test('SS-8: tampered summaries and a deleted identity are served until verification records drift (contract B); then the observation path is exact; rebuild restores the summary path', async t => {
  const x = await fresh(t);
  const { s, runs } = await small(x);
  const alice = await reader(x);
  const exact = await oracle(x, s, R('north'));
  await replica(x, `UPDATE si.run_advertiser_summaries SET names = names || ARRAY['Forged Spelling'] WHERE run_id = $1`, [runs[0]]);   // TAMPERING
  await replica(x, `DELETE FROM si.advertiser_identities WHERE source_id = $1 AND normalized_name = 'northwind synthetic labs'`, [s]);   // TAMPERING (FK bypassed)
  const served = await search(alice, s, R('north'));
  assert.equal(served.path, 'summary');
  assert.notDeepEqual(served.doc, exact.doc, 'the read path does not recompute content: the tampering is visible (documented limitation)');
  const findings = (await asOwner(x.admin, a => a.query('SELECT * FROM si.si_verify_summaries($1)', [s]))).rows.map(r => r.finding).sort();
  assert.ok(findings.length > 0, 'verification finds the tampering');
  await both(x, alice, s, R('north'), 'observations');
  for (const r of runs) await asOwner(x.admin, a => a.query('SELECT si.si_rebuild_run_summaries($1)', [r]));
  assert.deepEqual((await asOwner(x.admin, a => a.query('SELECT * FROM si.si_verify_summaries($1)', [s]))).rows, []);
  await both(x, alice, s, R('north'), 'summary');
  console.log(`# SS-8 verification findings: ${JSON.stringify(findings)}`);
});

// ------------------------------------------------------------------------------------------------ SS-9 long names, memory
test('SS-9: an 18,000-character normalized name repeated over 150 runs: the page equals the oracle and no temporary file is written', { timeout: 600000 }, async t => {
  const x = await fresh(t);
  const s = await source(x);
  const huge = '\uFDFA'.repeat(1000);                                         // NFKC expands each character to 18: 18,000 characters
  for (let i = 0; i < 150; i++) await collect(x, s, [AD(huge, `h${i % 9}`), AD(`Northwind ${i % 13} Synthetic`, `n${i}`, 'TIKTOK')]);
  assert.equal((await x.admin.query('SELECT length(si.si_normalize_advertiser($1)) AS l', [huge])).rows[0].l, 18000);
  const alice = await reader(x);
  const temp = async () => { await x.admin.query('SELECT pg_stat_force_next_flush()'); await new Promise(r => setTimeout(r, 700)); await x.admin.query('SELECT pg_stat_clear_snapshot()');
    return Number((await x.admin.query('SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database()')).rows[0].temp_bytes); };
  const t0 = await temp();
  const q = (await x.admin.query('SELECT left(si.si_normalize_advertiser($1), 3) AS q', [huge])).rows[0].q;
  for (const r of [R(q), R('synthetic', { limit: 5 }), R('a', { limit: 50 })]) for (const p of await pages(alice, s, r)) assert.deepEqual(p, { req: p.req, ...(await oracle(x, s, p.req)), path: 'summary' });
  assert.equal(await temp() - t0, 0, 'no temporary file on the summary path');
});
