// Shop Intelligence — M3-P3D: complete synthetic evidence lifecycle demonstration (updated for M3-AUD-01:
// every read commits a read intent first).
//
// Drives the REAL implementation (migrations 0001-0009 and the persistence library in dist/) against a
// disposable PostgreSQL 16.15 server started by demo/run.sh. Synthetic data only: the B-001 fixture
// (fixtures/synthetic-ads.json), normalized by the existing B-001 parser and deterministically expanded
// (identity suffixes only) where a scenario needs more records. No network collection, no live source.
//
// Every scenario asserts its outcome. The machine-readable report contains counts, codes and timings
// only — never advertising content, native ids or URLs; the program scans its own report (and the
// server log) for every fixture value and fails if one appears.
//
// Fixtures that no product path can perform (each named in the report): the demo superuser ages a
// stored retention deadline and disturbs a receipt identity under session_replication_role = replica.
// Source rows are inserted as si_owner (sources have no write function; provisioning is an owner task).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseAd } from '../dist/validation.js';
import { bootstrapCluster, bootstrapDatabase, LOGIN_ROLES, provisionReaderPrincipal } from '../dist/persistence/bootstrap.js';
import { migrateUp, codeSchemaVersion } from '../dist/persistence/migrate.js';
import { checkOperationalPreconditions, checkCollectorLogging } from '../dist/persistence/preconditions.js';
import { fixtureSha256, requestSha256 } from '../dist/persistence/request-hash.js';
import { t1PreflightScoped, completeRunWithEvidence, T2Refused } from '../dist/persistence/runs.js';
import { verifyReceipts, verificationStatus } from '../dist/persistence/verification.js';
import { beginRead, readEvidence, grantReader, revokeReader, ReadFailed } from '../dist/persistence/reader.js';
import { purgeDue, retentionStatus } from '../dist/persistence/retention.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const env = process.env;
const DB = 'si_demo';
const cfg = {
  host: '127.0.0.1', port: Number(env.DEMO_PGPORT), adminUser: env.DEMO_ADMIN_USER ?? 'si_bootstrap',
  adminPassword: env.DEMO_ADMIN_PASSWORD, container: env.DEMO_CONTAINER ?? '', report: env.DEMO_REPORT ?? '',
  mutant: env.DEMO_MUTANT || null, skipDeadline: env.DEMO_SKIP_DEADLINE === '1', commit: env.DEMO_COMMIT ?? 'unknown'
};
// Safety: only a disposable loopback server started by demo/run.sh.
if (!Number.isInteger(cfg.port) || !cfg.adminPassword || !/^si-demo-[A-Za-z0-9-]+$/.test(cfg.container)) {
  console.error('DEMO_REFUSED: run through demo/run.sh (disposable loopback container only)');
  process.exit(2);
}
const ROLE_PW = randomBytes(18).toString('hex');                          // per-run, never printed
const READER = 'si_reader_demo_analyst', OTHER = 'si_reader_demo_other';
const started = Date.now();

// ------------------------------------------------------------------------------------------------
// Connections (one dedicated client per role; least privilege everywhere except the admin fixtures)
const clients = [];
async function conn(user, database = DB) {
  const c = new pg.Client({ host: cfg.host, port: cfg.port, user, database, application_name: 'si-demo',
    password: user === cfg.adminUser ? cfg.adminPassword : ROLE_PW });
  c.on('error', () => {});
  await c.connect();
  clients.push(c);
  return c;
}

// ------------------------------------------------------------------------------------------------
// Report and scenario runner (content-free by construction; failures carry codes or our own messages)
const report = {
  demo: 'shop-intelligence-m3-p3d-synthetic-lifecycle', commit: cfg.commit, mutant: cfg.mutant,
  postgres_version: null, schema_version: null, started_at: new Date(started).toISOString(), duration_ms: null,
  scenarios: [], counts: {
    collection: { runs_started: 0, runs_completed: 0, runs_failed: 0, received: 0, published: 0, duplicates: 0, conflicts: 0 },
    verification: { valid: 0, invalid: 0, unverifiable: 0 },
    reads: { authorized_calls: 0, records_returned: 0, denied_calls: {} },
    purge: { runs: 0, observations: 0, identities: 0 },
    // Measured, never assumed: A1 counts what a caller rollback removed. Request records are the committed
    // read intents; release records are the consumption mark and the completion row (not rollback-resistant).
    audit: { purge_log_records: 0, reader_access_records: 0, read_intents: 0, read_intents_consumed: 0,
             request_records_lost_on_rollback: null, release_records_lost_on_rollback: null, verification_records: 0 }
  },
  timings_ms: {}, resources: {}, fixtures_used: [], limitations: []
};
const reason = e => (e instanceof assert.AssertionError ? (e.generatedMessage ? 'assertion failed' : e.message)
  : (e instanceof ReadFailed || e instanceof T2Refused) ? `${e.name}:${e.code}` : (e?.code ? `sqlstate ${e.code}` : (e?.name ?? 'error')));
async function scenario(id, name, kind, fn) {
  const t0 = performance.now();
  let outcome = 'PASS', why = null, detail = null;
  try { detail = (await fn()) ?? null; } catch (e) { outcome = 'FAIL'; why = reason(e); }
  report.scenarios.push({ id, kind, name, outcome, ...(why ? { reason: why } : {}), ...(detail ? { detail } : {}),
                          ms: Math.round(performance.now() - t0) });
  console.log(`${outcome === 'PASS' ? 'PASS' : 'FAIL'} ${id} ${name}${why ? ` — ${why}` : ''}`);
  return outcome === 'PASS';
}
const deny = code => { report.counts.reads.denied_calls[code] = (report.counts.reads.denied_calls[code] ?? 0) + 1; };
const time = (k, ms) => { report.timings_ms[k] = Math.round(ms); };

// ------------------------------------------------------------------------------------------------
// Synthetic fixtures: the B-001 fixture through the existing B-001 parser, plus a deterministic expansion
const FIXTURE_PATH = 'fixtures/synthetic-ads.json';
const RAW = JSON.parse(readFileSync(new URL(`../${FIXTURE_PATH}`, import.meta.url), 'utf8'));
const BASE = RAW.map(parseAd);
const expand = (k, tag) => Array.from({ length: k }, (_, i) => { const b = BASE[i % BASE.length]; return { ...b, nativeAdId: `${b.nativeAdId}-${tag}-${i}` }; });
const FORBIDDEN = new Set();
for (const r of [...RAW, ...BASE]) for (const k of ['nativeAdId', 'advertiserName', 'sourceUrl', 'title', 'destinationUrl', 'creativeUrl']) if (r[k]) FORBIDDEN.add(String(r[k]));
FORBIDDEN.add('SYN-'); FORBIDDEN.add('example.org');
report.fixtures_used.push({ path: FIXTURE_PATH, records: RAW.length, normalization: 'B-001 parseAd', expansion: 'identity suffix only' });

// ------------------------------------------------------------------------------------------------
// Real interfaces (no business logic here: the database and the library decide)
let n = 0;
async function asOwner(admin, fn) {
  await admin.query('BEGIN');
  try { await admin.query('SET LOCAL ROLE si_owner'); const r = await fn(admin); await admin.query('COMMIT'); return r; }
  catch (e) { await admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const createSource = (admin, id, policy = 'FAIL_RUN') => asOwner(admin, a => a.query(
  `INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks, conflict_policy) VALUES ($1, $2, 'SYNTHETIC', '{META,TIKTOK}', $3)`,
  [id, `Demo ${id}`, policy]));
async function recordRights(ra, src, { retain = 'ALLOWED', expiresSql = 'NULL' } = {}) {
  return (await ra.query(`SELECT * FROM si.si_record_rights_version($1, 'ALLOWED', $2, 'DENIED', 'DENIED', 'DENIED', 30, interval '1 hour',
      'Author-created synthetic fixture for the lifecycle demonstration only', 'M3-P3D demonstration', NULL, ${expiresSql},
      ARRAY['SYNTHETIC_DECLARATION'], ARRAY['repo:${FIXTURE_PATH}'], NULL, ARRAY['synthetic records; URLs are never fetched'])`,
    [src, retain])).rows[0];
}
async function controlView(ra, src) {
  return (await ra.query(`SELECT (SELECT coalesce(max(version), 0) FROM si.rights_versions WHERE source_id = $1) AS v,
                                 (SELECT coalesce(max(control_seq), 0) FROM si.source_controls WHERE source_id = $1) AS s`, [src])).rows[0];
}
const control = (ra, src, kind, o = {}) => ra.query('SELECT * FROM si.si_record_source_control($1, $2, $3, NULL, $4, $5, NULL, NULL)',
  [src, kind, `demo ${kind}`, o.v ?? null, o.s ?? null]);
async function start(col, src, rows) {
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows);
  const t1 = await t1PreflightScoped(col, { sourceId: src, requestKey: `demo-${++n}`, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx,
    requestSha256: requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx }) });
  if (t1.outcome === 'RUNNING') report.counts.collection.runs_started++;
  return t1;
}
async function collect(col, src, rows) {
  const t1 = await start(col, src, rows);
  assert.equal(t1.outcome, 'RUNNING', 'T1 must start a RUNNING attempt');
  const t2 = await completeRunWithEvidence(col, t1.runId, t1.leaseToken, rows);
  if (t2.outcome === 'COMPLETED') {
    const c = report.counts.collection;
    c.runs_completed++; c.received += t2.counts.received; c.published += t2.counts.published; c.duplicates += t2.counts.duplicate; c.conflicts += t2.counts.conflict;
  } else if (t2.outcome === 'FAILED') report.counts.collection.runs_failed++;
  return { t1, t2 };
}
async function verifyAll(mon) {
  const v = await verifyReceipts(mon, 500);
  report.counts.verification.valid += v.valid; report.counts.verification.invalid += v.invalid; report.counts.verification.unverifiable += v.unverifiable;
  return v;
}
async function readAll(rd, src, limit = 100) {
  const seq = []; let cursor = null;
  for (;;) {
    const p = await readEvidence(rd, src, { cursor, limit });
    report.counts.reads.authorized_calls++; report.counts.reads.records_returned += p.records.length;
    if (!p.records.length) break;
    seq.push(...p.records.map(r => `${r.runId}/${r.ordinal}`)); cursor = p.nextCursor;
  }
  return seq;
}
async function denied(p) {
  try { await p; } catch (e) { if (e instanceof ReadFailed) { deny(e.code); return e.code; } throw e; }
  return 'ALLOWED';
}
/** Superuser fixture (see header): one statement with every trigger skipped. */
async function replica(admin, sql, params) {
  await admin.query('BEGIN');
  try { await admin.query('SET LOCAL session_replication_role = replica'); await admin.query(sql, params); await admin.query('COMMIT'); }
  catch (e) { await admin.query('ROLLBACK').catch(() => {}); throw e; }
}
const verdict = async (admin, runId) => (await admin.query('SELECT verdict, reason FROM si.receipt_verifications WHERE run_id = $1', [runId])).rows[0];
async function purgeAll(ret, src) {
  let last;
  for (let i = 0; i < 50; i++) {
    last = await purgeDue(ret, 20);
    if (last.outcome !== 'PURGED') break;
    report.counts.purge.runs += last.runsPurged; report.counts.purge.observations += last.observationsPurged; report.counts.purge.identities += last.identitiesPurged;
    if (src && last.sourceId === src) return last;
  }
  return last;
}

// ------------------------------------------------------------------------------------------------
// Targeted mutants (negative controls for the demo itself): the demo must FAIL with any of them.
function fnText(file, start, end) {
  const t = readFileSync(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8');
  const s = t.indexOf(start);
  return t.slice(s, t.indexOf(end, s) + end.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}
function mutate(text, from, to) { assert.equal(text.split(from).length, 2, 'mutation anchor'); return text.replace(from, to); }
const MUTANTS = {
  // Both reader entry points check the grant (0009): the mutant disables it in both.
  grant: () => [
    mutate(fnText('0010_read_durability.up.sql', 'CREATE OR REPLACE FUNCTION si.si_read_evidence', 'END $read_evidence$;'),
      'IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM si.reader_grants g', 'IF NOT FOUND OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g'),
    mutate(fnText('0009_read_audit.up.sql', 'CREATE FUNCTION si.si_begin_read', 'END $begin_read$;'),
      '     OR NOT EXISTS (SELECT 1 FROM si.reader_grants g', '     OR false AND NOT EXISTS (SELECT 1 FROM si.reader_grants g')].join('\n'),
  retention: () => mutate(fnText('0007_receipt_verification.up.sql', 'CREATE FUNCTION si.si_evidence_readable', '$evidence_readable$;\n'),
    '       AND n.t + si.si_publish_margin() < si.si_effective_retention_end(r.source_id, v.version, r.retain_until)\n', ''),
  verdict: () => mutate(fnText('0007_receipt_verification.up.sql', 'CREATE FUNCTION si.si_evidence_readable', '$evidence_readable$;\n'),
    `SELECT rv.verdict = 'VALID'`, 'SELECT true')
};

// ------------------------------------------------------------------------------------------------
let A, col, ra, mon, ret, rd, other;
try {
  // ---------------------------------------------------------------- environment
  await scenario('E1', 'Disposable PostgreSQL 16 with the required settings', 'setup', async () => {
    const root = await conn(cfg.adminUser, 'postgres');
    await bootstrapCluster(root, { passwords: Object.fromEntries(LOGIN_ROLES.map(r => [r, ROLE_PW])) });
    for (const p of [READER, OTHER]) await provisionReaderPrincipal(root, p, ROLE_PW);
    await root.query(`DROP DATABASE IF EXISTS ${DB}`); await root.query(`CREATE DATABASE ${DB}`);
    A = await conn(cfg.adminUser);
    await bootstrapDatabase(A);
    const mig = await conn('si_migrator');
    const t0 = performance.now();
    const applied = await migrateUp(mig);
    time('migrations', performance.now() - t0);
    assert.deepEqual(applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 'the real migrations 0001-0013 are applied by the least-privilege migrator');
    report.schema_version = codeSchemaVersion();
    report.postgres_version = (await A.query('SHOW server_version')).rows[0].server_version;
    assert.match(report.postgres_version, /^16\./, 'PostgreSQL 16');
    const pre = await checkOperationalPreconditions(A);
    assert.ok(pre.every(p => p.ok), 'operational preconditions (D7): commit timestamps on, READ COMMITTED, no prepared transactions, no sync standby');
    [col, ra, mon, ret, rd, other] = await Promise.all(['si_collector', 'si_rights_admin', 'si_monitor', 'si_retention', READER, OTHER].map(u => conn(u)));
    assert.ok((await checkCollectorLogging(col)).every(p => p.ok), 'collector session logging is safe');
    if (cfg.mutant) { await asOwner(A, a => a.query(MUTANTS[cfg.mutant]())); }
    return { migrations_applied: applied.length, preconditions_ok: pre.length };
  });

  // Real-deadline INVALID scenario (N5) starts first: it needs about 7.5 minutes of wall time.
  let deadline = null;
  if (!cfg.skipDeadline) {
    await createSource(A, 'demo-deadline');
    await recordRights(ra, 'demo-deadline', { expiresSql: `clock_timestamp() + interval '450 seconds'` });
    const c = await conn('si_collector');
    const rows = expand(2, 'dl');
    const t1 = await start(c, 'demo-deadline', rows);
    deadline = (async () => {
      await c.query('BEGIN');
      await c.query('SET CONSTRAINTS si.trg_runs_publish_check IMMEDIATE');           // the G3 vector, detected by D8
      await c.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [t1.runId, t1.leaseToken, JSON.stringify(rows)]);
      for (;;) {
        const past = (await c.query(`SELECT clock_timestamp() > (SELECT expires_at FROM si.rights_versions WHERE source_id = 'demo-deadline')
                                       + interval '5 seconds' AS p`)).rows[0].p;
        if (past) break;
        await c.query('SELECT pg_sleep(20)');
      }
      await c.query('COMMIT');
      return t1.runId;
    })();
    deadline.catch(() => {});
  }

  // ---------------------------------------------------------------- happy path
  const SRC = 'demo-synthetic';
  const rows24 = expand(24, 'h');
  const batch = [...rows24, rows24[0]];                                                // one identical duplicate
  let h = {};
  await scenario('H1', 'Create an authorized synthetic source', 'happy', async () => {
    await createSource(A, SRC);
    const s = (await A.query('SELECT evidence_kind, supported_networks FROM si.sources WHERE source_id = $1', [SRC])).rows[0];
    assert.deepEqual([s.evidence_kind, s.supported_networks], ['SYNTHETIC', ['META', 'TIKTOK']], 'synthetic source with two networks');
  });
  await scenario('H2', 'Record source rights (evaluation and retention allowed; display, mirroring and export denied)', 'happy', async () => {
    const v = await recordRights(ra, SRC);
    const r = (await A.query(`SELECT evaluation, retain, subscriber_display, media_mirror, export, si.rights_valid_for_publish($1, clock_timestamp()) AS ok
                                FROM si.rights_versions WHERE rights_version_id = $1`, [v.rights_version_id])).rows[0];
    assert.deepEqual(r, { evaluation: 'ALLOWED', retain: 'ALLOWED', subscriber_display: 'DENIED', media_mirror: 'DENIED', export: 'DENIED', ok: true },
      'rights version allows internal evaluation only');
  });
  await scenario('H3', 'Start a scoped collection run bound to the fixture hash', 'happy', async () => {
    h.t1 = await start(col, SRC, batch);
    assert.equal(h.t1.outcome, 'RUNNING', 'T1 RUNNING');
    const scope = (await A.query('SELECT networks FROM si.run_request_scope WHERE run_id = $1', [h.t1.runId])).rows[0];
    assert.deepEqual(scope.networks, ['META', 'TIKTOK'], 'request scope recorded');
  });
  await scenario('H4', 'Submit the fixture-bound evidence and persist it atomically', 'happy', async () => {
    const t0 = performance.now();
    h.t2 = await completeRunWithEvidence(col, h.t1.runId, h.t1.leaseToken, batch);
    time('completion_25_rows', performance.now() - t0);
    assert.equal(h.t2.outcome, 'COMPLETED', 'T2 COMPLETED');
    const c = report.counts.collection; c.runs_completed++; c.received += h.t2.counts.received; c.published += h.t2.counts.published; c.duplicates += h.t2.counts.duplicate;
    assert.deepEqual(h.t2.counts, { received: 25, published: 24, duplicate: 1, conflict: 0 }, 'database-derived counts');
    return h.t2.counts;
  });
  await scenario('H5', 'Publication counts match the stored evidence and the receipt', 'happy', async () => {
    const r = (await A.query(`SELECT r.status, r.retention_state, r.published_count, (SELECT count(*)::int FROM si.observations o WHERE o.run_id = r.run_id) AS obs,
        (SELECT count(*)::int FROM si.publication_receipts p WHERE p.run_id = r.run_id) AS receipts FROM si.collection_runs r WHERE r.run_id = $1`, [h.t1.runId])).rows[0];
    assert.deepEqual(r, { status: 'COMPLETED', retention_state: 'RETAINED', published_count: 24, obs: 24, receipts: 1 }, 'counts, evidence and receipt agree');
  });
  await scenario('H6', 'The commit timestamp of the completion transaction is resolvable', 'happy', async () => {
    const r = (await A.query(`SELECT count(DISTINCT o.xmin::text)::int AS xids, bool_and(o.xmin::text = p.xmin::text) AS same,
        pg_xact_commit_timestamp(min(p.xmin::text)::xid) IS NOT NULL AS ts FROM si.observations o JOIN si.publication_receipts p ON p.run_id = o.run_id
        WHERE o.run_id = $1`, [h.t1.runId])).rows[0];
    assert.deepEqual(r, { xids: 1, same: true, ts: true }, 'one transaction identity shared by evidence and receipt, with a commit timestamp');
  });
  await scenario('H7', 'Receipt verification records a VALID verdict', 'happy', async () => {
    const t0 = performance.now();
    const v = await verifyAll(mon);
    time('verification_batch', performance.now() - t0);
    assert.ok(v.valid >= 1, 'at least one VALID');
    assert.deepEqual(await verdict(A, h.t1.runId), { verdict: 'VALID', reason: 'COMMITTED_IN_WINDOW' }, 'VALID, committed inside the rights window');
  });
  await scenario('H8', 'Provision a dedicated internal reader and grant it this source', 'happy', async () => {
    const id = await grantReader(ra, READER, SRC, 'M3-P3D demonstration: internal synthetic evaluation');
    const g = (await A.query('SELECT principal, purpose, granted_by FROM si.reader_grants WHERE grant_id = $1', [id])).rows[0];
    assert.deepEqual(g, { principal: READER, purpose: 'INTERNAL_SYNTHETIC_EVALUATION', granted_by: 'si_rights_admin' }, 'audited internal grant');
  });
  let seq1;
  await scenario('H9', 'Retrieve permitted observations (no destination or creative URLs)', 'happy', async () => {
    const t0 = performance.now();
    const p = await readEvidence(rd, SRC, { limit: 10 });
    time('read_page_10', performance.now() - t0);
    report.counts.reads.authorized_calls++; report.counts.reads.records_returned += p.records.length;
    assert.equal(p.records.length, 10, 'a page of 10');
    assert.ok(p.records.every(r => !('destinationUrl' in r) && !('creativeUrl' in r)), 'URL fields excluded from the interface');
  });
  await scenario('H10', 'Paginate deterministically over all 24 records', 'happy', async () => {
    seq1 = await readAll(rd, SRC, 7);
    const seq2 = await readAll(rd, SRC, 100);
    assert.equal(seq1.length, 24, 'every record reachable');
    assert.deepEqual(seq1, seq2, 'pages of 7 concatenate to the single 100-record page');
    return { records: seq1.length, order_sha256: createHash('sha256').update(seq1.join(',')).digest('hex').slice(0, 16) };
  });
  await scenario('H11', 'Revoke the reader grant; later reads are denied', 'happy', async () => {
    const cursor = (await readEvidence(rd, SRC, { limit: 1 })).nextCursor;
    report.counts.reads.authorized_calls++; report.counts.reads.records_returned += 1;
    await revokeReader(ra, READER, SRC, 'demonstration finished');
    assert.equal(await denied(readEvidence(rd, SRC)), 'NOT_AUTHORIZED', 'read denied after revocation');
    assert.equal(await denied(readEvidence(rd, SRC, { cursor })), 'NOT_AUTHORIZED', 'an earlier cursor is not a capability');
  });
  await scenario('H12', 'Advance retention (labelled fixture) and purge', 'happy', async () => {
    await replica(A, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '10 minutes' WHERE run_id = $1`, [h.t1.runId]);
    const st = (await retentionStatus(mon)).find(s => s.sourceId === SRC);
    assert.equal(st.dueRuns, 1, 'retention status reports the run as due');
    const t0 = performance.now();
    const p = await purgeAll(ret, SRC);
    time('purge_batch', performance.now() - t0);
    assert.deepEqual([p.outcome, p.runsPurged, p.observationsPurged, p.identitiesPurged], ['PURGED', 1, 24, 24], 'purged through si_purge_due');
    report.fixtures_used.push({ fixture: 'retention deadline aged by the demo superuser (session_replication_role = replica)', scenarios: ['H12', 'N7', 'N14'] });
  });
  await scenario('H13', 'Evidence is deleted; content-free audit records remain', 'happy', async () => {
    const r = (await A.query(`SELECT (SELECT count(*)::int FROM si.observations WHERE run_id = $1) AS obs,
        (SELECT count(*)::int FROM si.ads WHERE source_id = $2) AS ads, (SELECT retention_state FROM si.collection_runs WHERE run_id = $1) AS state,
        (SELECT count(*)::int FROM si.publication_receipts WHERE run_id = $1) AS receipts, (SELECT count(*)::int FROM si.purge_log WHERE run_id = $1) AS purge_log,
        (SELECT count(*)::int FROM si.receipt_verifications WHERE run_id = $1) AS verification`, [h.t1.runId, SRC])).rows[0];
    assert.deepEqual(r, { obs: 0, ads: 0, state: 'PURGED', receipts: 1, purge_log: 1, verification: 1 }, 'evidence gone, audit kept');
    const cols = (await A.query(`SELECT string_agg(attname, ',' ORDER BY attnum) AS c FROM pg_attribute WHERE attrelid = 'si.purge_log'::regclass AND attnum > 0`)).rows[0].c;
    assert.ok(!/native|url|title|advertiser|countr/.test(cols), 'the purge audit has no content columns');
    assert.equal(await denied(readEvidence(await conn(READER), SRC)), 'NOT_AUTHORIZED', 'nothing readable');
  });

  // ---------------------------------------------------------------- negative controls
  const mk = async (id, policy) => { await createSource(A, id, policy); await recordRights(ra, id); return id; };
  const S2 = await mk('demo-second'), S3 = await mk('demo-third');
  const r2 = await collect(col, S2, expand(4, 'b')), r3 = await collect(col, S3, expand(3, 'c'));
  await verifyAll(mon);
  await grantReader(ra, READER, S2, 'negative controls');
  await scenario('N1', 'An unauthorized principal and a service role are denied', 'negative', async () => {
    assert.equal(await denied(readEvidence(other, S2)), 'NOT_AUTHORIZED', 'principal without a grant');
    assert.equal(await denied(readEvidence(mon, S2)), 'NOT_AUTHORIZED', 'service role');
    assert.equal(await denied(readEvidence(rd, S2)), 'ALLOWED', 'the granted principal reads');
    report.counts.reads.authorized_calls++;
  });
  await scenario('N2', 'Cross-source access and a cross-source cursor are refused', 'negative', async () => {
    assert.equal(await denied(readEvidence(rd, S3)), 'NOT_AUTHORIZED', 'source not granted');
    const cursor = (await readEvidence(rd, S2, { limit: 1 })).nextCursor;
    report.counts.reads.authorized_calls++; report.counts.reads.records_returned += 1;
    await grantReader(ra, READER, S3, 'cursor check');
    assert.equal(await denied(readEvidence(rd, S3, { cursor })), 'BAD_CURSOR', 'another source\'s cursor');
    await revokeReader(ra, READER, S3, 'cursor check done');
  });
  await scenario('N3', 'An invalid evidence batch is refused whole, with coded diagnostics only', 'negative', async () => {
    const raw = RAW.map(r => ({ ...r }));                                       // un-normalized fixture: non-canonical timestamps
    const { t2 } = await collect(col, S3, raw);
    assert.equal(t2.outcome, 'FAILED', 'run failed');
    assert.equal(t2.code, 'VALIDATION_FAILED', 'validation failure');
    assert.ok(t2.diagnostics?.records.every(d => /^[A-Z_]+$/.test(d.code)), 'diagnostics are codes, row indices and field names');
    return { diagnostic_codes: [...new Set(t2.diagnostics.records.map(d => d.code))] };
  });
  await scenario('N4', 'Duplicates: identical copies are counted; conflicting copies fail FAIL_RUN and keep the first under KEEP_FIRST', 'negative', async () => {
    const [a] = expand(1, 'dup'), conflicting = [a, { ...a, title: 'Different synthetic title' }];
    const strict = await collect(col, S3, conflicting);
    assert.deepEqual([strict.t2.outcome, strict.t2.code], ['FAILED', 'DUPLICATE_CONFLICT'], 'FAIL_RUN refuses a conflicting duplicate');
    const keep = await mk('demo-keep-first', 'KEEP_FIRST');
    const k = await collect(col, keep, conflicting);
    assert.deepEqual([k.t2.outcome, k.t2.counts.published, k.t2.counts.duplicate, k.t2.counts.conflict], ['COMPLETED', 1, 1, 1], 'KEEP_FIRST keeps the lowest ordinal');
  });
  await scenario('N6', 'An UNVERIFIABLE completion (disturbed identity, labelled fixture) is never readable', 'negative', async () => {
    const u = await collect(col, S2, expand(2, 'u'));
    await replica(A, 'UPDATE si.publication_receipts SET receipt_at = receipt_at WHERE run_id = $1', [u.t1.runId]);
    await verifyAll(mon);
    assert.deepEqual(await verdict(A, u.t1.runId), { verdict: 'UNVERIFIABLE', reason: 'IDENTITY_MISMATCH' }, 'UNVERIFIABLE');
    const seq = await readAll(rd, S2);
    assert.ok(!seq.some(s => s.startsWith(u.t1.runId)), 'excluded from reads');
    report.fixtures_used.push({ fixture: 'receipt identity disturbed by the demo superuser (session_replication_role = replica)', scenarios: ['N6'] });
  });
  await scenario('N7', 'Expired evidence is not returned', 'negative', async () => {
    const before = (await readAll(rd, S2)).length;
    await replica(A, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '1 minute' WHERE run_id = $1`, [r2.t1.runId]);
    const seq = await readAll(rd, S2);
    assert.ok(before >= 4 && !seq.some(s => s.startsWith(r2.t1.runId)), 'expired run excluded');
  });
  await scenario('N8', 'A suspended source returns nothing; LIFT restores access', 'negative', async () => {
    const s = await mk('demo-suspend'); await collect(col, s, expand(2, 's')); await verifyAll(mon);
    await grantReader(ra, READER, s, 'suspension check');
    assert.equal((await readAll(rd, s)).length, 2, 'readable before');
    await control(ra, s, 'SUSPEND');
    assert.equal((await readAll(rd, s)).length, 0, 'nothing while suspended');
    const v = await controlView(ra, s);
    await control(ra, s, 'LIFT', { v: v.v, s: v.s });
    assert.equal((await readAll(rd, s)).length, 2, 'readable after LIFT');
  });
  await scenario('N9', 'A terminated source returns nothing and is purged', 'negative', async () => {
    const s = await mk('demo-terminate'); await collect(col, s, expand(2, 't')); await verifyAll(mon);
    await grantReader(ra, READER, s, 'termination check');
    await control(ra, s, 'TERMINATE_RETENTION');
    assert.equal((await readAll(rd, s)).length, 0, 'nothing after TERMINATE_RETENTION');
    const p = await purgeAll(ret, s);
    assert.equal(p?.sourceId, s, 'terminated evidence purged');
  });
  await scenario('N10', 'A revoked grant is denied (and its cursor is not a capability)', 'negative', async () => {
    const cursor = (await readEvidence(rd, S2, { limit: 1 })).nextCursor;
    report.counts.reads.authorized_calls++;
    await revokeReader(ra, READER, S2, 'revocation check');
    assert.equal(await denied(readEvidence(rd, S2, { cursor })), 'NOT_AUTHORIZED', 'revoked');
    await grantReader(ra, READER, S2, 'restore for remaining checks');
  });
  await scenario('N11', 'An invalid cursor is refused with a fixed code', 'negative', async () => {
    for (const c of ['garbage', 'v1|demo-second|2026-13-45T00:00:00.000000Z|00000000-0000-0000-0000-000000000000|0']) {
      assert.equal(await denied(readEvidence(rd, S2, { cursor: c })), 'BAD_CURSOR', 'malformed cursor');
    }
  });
  await scenario('N12', 'An excessive read limit is refused (library before sending; database as well)', 'negative', async () => {
    assert.equal(await denied(readEvidence(rd, S2, { limit: 101 })), 'BAD_ARGUMENT', 'library refuses');
    const codes = [];
    for (const sql of ['SELECT si.si_begin_read($1, NULL, 101)', 'SELECT * FROM si.si_read_evidence($1, NULL::uuid, NULL, 101)']) {
      try { await rd.query(sql, [S2]); codes.push('none'); } catch (e) { codes.push(e.code); }
    }
    assert.deepEqual(codes, ['22023', '22023'], 'database refuses at the intent and at the read (SQLSTATE only reported)');
  });
  await scenario('N13', 'Unsafe logging configurations are refused before any payload or read', 'negative', async () => {
    await A.query(`ALTER ROLE si_collector IN DATABASE ${DB} SET log_parameter_max_length = -1`);
    try {
      const lax = await conn('si_collector');
      const t1 = await start(lax, S3, expand(1, 'log'));
      let code = null;
      try { await completeRunWithEvidence(lax, t1.runId, t1.leaseToken, expand(1, 'log')); } catch (e) { code = e instanceof T2Refused ? e.code : 'other'; }
      assert.equal(code, 'UNSAFE_LOGGING', 'collector refuses to transmit evidence');
    } finally { await A.query(`ALTER ROLE si_collector IN DATABASE ${DB} RESET log_parameter_max_length`); }
    await rd.query(`SET statement_timeout = 0`);
    assert.equal(await denied(readEvidence(rd, S2)), 'UNSAFE_SESSION', 'reader session without a statement bound');
    await rd.query('RESET statement_timeout');
  });
  await scenario('N14', 'Concurrent purge and completion: the purge skips the busy source, no foreign-key error', 'negative', async () => {
    const s = await mk('demo-concurrent');
    const old = await collect(col, s, expand(2, 'k1'));
    await replica(A, `UPDATE si.collection_runs SET retain_until = clock_timestamp() - interval '10 minutes' WHERE run_id = $1`, [old.t1.runId]);
    const c2 = await conn('si_collector');
    const rows = [expand(2, 'k1')[0], ...expand(1, 'k2')];                      // reuses an identity of the expiring run
    const t1 = await start(c2, s, rows);
    await c2.query('BEGIN');
    await c2.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [t1.runId, t1.leaseToken, JSON.stringify(rows)]);
    const busy = await purgeDue(ret, 20);
    await c2.query('COMMIT');
    report.counts.collection.runs_completed++;
    assert.equal(busy.outcome, 'BUSY', 'source held by the completion is skipped');
    const p = await purgeAll(ret, s);
    assert.deepEqual([p.outcome, p.runsPurged, p.identitiesPurged], ['PURGED', 1, 1], 'purged afterwards; the shared identity is kept');
  });

  // ---------------------------------------------------------------- auditability (M3-AUD-01; A1 in M3-P3D)
  const intentCount = async () => (await A.query('SELECT count(*)::int AS n FROM si.read_intents')).rows[0].n;
  await scenario('A1', 'Request audit only: a caller rollback keeps the committed request record but erases the release record (no disclosure audit)', 'audit', async () => {
    const logCount = async () => (await A.query('SELECT count(*)::int AS n FROM si.reader_access_log')).rows[0].n;
    const s = await mk('demo-audit'); await collect(col, s, expand(3, 'a')); await verifyAll(mon);
    await grantReader(ra, READER, s, 'request audit demonstration');
    const [intentsBefore, logBefore] = [await intentCount(), await logCount()];
    const intentId = await beginRead(rd, s);                         // autocommit: the request record commits (and is flushed) first
    await rd.query('BEGIN');
    const p = await readEvidence(rd, s, { intentId });
    await rd.query('ROLLBACK');
    assert.ok(p.records.length > 0, 'the reader did receive records');
    assert.equal(await intentCount() - intentsBefore, 1, 'the committed intent survived the rollback');
    const st = (await A.query('SELECT principal, source_id, state FROM si.read_intents WHERE intent_id = $1', [intentId])).rows[0];
    assert.deepEqual(st, { principal: READER, source_id: s, state: 'OPEN' }, 'bound to the reader and the source; outcome unknown');
    await rd.query('BEGIN');
    const inside = await denied(readEvidence(rd, s));
    await rd.query('ROLLBACK');
    assert.equal(inside, 'INTENT_UNCOMMITTED', 'an intent that is not committed releases nothing');
    const requestLost = 1 - (await intentCount() - intentsBefore);                // measured
    const releaseLost = 1 - (await logCount() - logBefore);                       // measured: the release was not recorded
    report.counts.audit.request_records_lost_on_rollback = requestLost;
    report.counts.audit.release_records_lost_on_rollback = releaseLost;
    assert.equal(requestLost, 0, 'request record kept');
    assert.equal(releaseLost, 1, 'release record lost: rollback-resistant release accounting is NOT IMPLEMENTED');
    return { records_received: p.records.length, request_records_lost: requestLost, release_records_lost: releaseLost,
             disclosure_audit: 'NOT GUARANTEED' };
  });

  await scenario('A2', 'Revocation between the committed intent and the read is enforced; the intent is single-use and a failed read may be retried', 'audit', async () => {
    const s = await mk('demo-audit-2'); await collect(col, s, expand(2, 'r')); await verifyAll(mon);
    await grantReader(ra, READER, s, 'revocation between steps');
    const revoked = await beginRead(rd, s);
    await revokeReader(ra, READER, s, 'revoked between the intent and the read');
    assert.equal(await denied(readEvidence(rd, s, { intentId: revoked })), 'NOT_AUTHORIZED', 'a committed intent does not override revocation');
    await grantReader(ra, READER, s, 'granted again');
    await ra.query('BEGIN');
    await control(ra, s, 'SUSPEND');
    let busy = null;
    try { await readEvidence(rd, s); } catch (e) { busy = e; }
    await ra.query('ROLLBACK');
    assert.ok(busy instanceof ReadFailed && busy.code === 'BUSY' && busy.retryable, 'BUSY while a control is in progress; retryable');
    deny(busy.code);
    const retried = await readEvidence(rd, s, { intentId: busy.intentId });
    report.counts.reads.authorized_calls++; report.counts.reads.records_returned += retried.records.length;
    assert.equal(retried.records.length, 2, 'the retry with the same committed intent reads');
    assert.equal(await denied(readEvidence(rd, s, { intentId: busy.intentId })), 'INTENT_USED', 'a consumed intent is final');
  });

  // ---------------------------------------------------------------- real deadline (INVALID)
  if (deadline) {
    await scenario('N5', 'INVALID: a completion committed after its rights expired (IMMEDIATE publication-check bypass) is detected and never readable', 'negative', async () => {
      const t0 = performance.now();
      const runId = await deadline;
      time('deadline_wait', performance.now() - t0);
      await verifyAll(mon);
      assert.deepEqual(await verdict(A, runId), { verdict: 'INVALID', reason: 'COMMITTED_AFTER_WINDOW' }, 'INVALID');
      await grantReader(ra, READER, 'demo-deadline', 'invalid-evidence check');
      assert.equal((await readAll(rd, 'demo-deadline')).length, 0, 'never readable');
    });
  } else {
    report.scenarios.push({ id: 'N5', kind: 'negative', name: 'INVALID verification (real deadline)', outcome: 'SKIPPED', reason: 'DEMO_SKIP_DEADLINE=1', ms: 0 });
    console.log('SKIP N5 INVALID verification (real deadline) — DEMO_SKIP_DEADLINE=1');
  }

  // ---------------------------------------------------------------- logs
  await scenario('L1', 'No fixture value in the server log', 'safety', async () => {
    const r = spawnSync('docker', ['logs', cfg.container], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    assert.equal(r.status, 0, 'server log readable');
    const log = `${r.stdout}${r.stderr}`;
    assert.ok(![...FORBIDDEN].some(f => log.includes(f)), 'no native id, URL, advertiser name or title in the server log');
    return { log_bytes: log.length };
  });

  // ---------------------------------------------------------------- final counts
  const audit = (await A.query(`SELECT (SELECT count(*)::int FROM si.purge_log) AS p, (SELECT count(*)::int FROM si.reader_access_log) AS a,
                                       (SELECT count(*)::int FROM si.receipt_verifications) AS v, (SELECT count(*)::int FROM si.read_intents) AS i,
                                       (SELECT count(*)::int FROM si.read_intents WHERE state = 'CONSUMED') AS ic,
                                       (SELECT count(*)::int FROM si.reader_access_log l WHERE NOT EXISTS (
                                          SELECT 1 FROM si.read_intents r WHERE r.intent_id = l.intent_id
                                            AND r.principal = l.principal AND r.source_id = l.source_id)) AS orphan`)).rows[0];
  assert.equal(audit.orphan, 0, 'every completion record names a committed intent of the same reader and source');
  Object.assign(report.counts.audit, { purge_log_records: audit.p, reader_access_records: audit.a, verification_records: audit.v,
                                       read_intents: audit.i, read_intents_consumed: audit.ic });
  const vs = await verificationStatus(mon);
  report.counts.verification = { valid: vs.valid, invalid: vs.invalid, unverifiable: vs.unverifiable, pending: vs.pending };
  report.resources = { node_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    database_bytes: Number((await A.query('SELECT pg_database_size(current_database()) AS b')).rows[0].b) };
} catch (e) {
  report.scenarios.push({ id: 'X', kind: 'setup', name: 'Unexpected demo error', outcome: 'FAIL', reason: reason(e), ms: 0 });
  console.log(`FAIL X unexpected — ${reason(e)}`);
} finally {
  for (const c of clients) await c.end().catch(() => {});
}

report.duration_ms = Date.now() - started;
report.limitations = [
  'Synthetic evidence only; no live source, no real advertising data, no network collection.',
  'Retention is advanced and one identity is disturbed by labelled superuser fixtures; superusers are outside the trust boundary.',
  'REQUEST AUDIT only: every read first commits a scoped read intent, and no evidence is released until that commit is flushed to WAL (M3-AUD-01, M3-AUD-03). DISCLOSURE AUDIT: NOT GUARANTEED. Exactly-once delivery: NOT GUARANTEED. Rollback-resistant release accounting: NOT IMPLEMENTED (A1 measures the lost release record).',
  'Internal evaluation reads only. Subscriber display, export and media mirroring are DENIED by the rights model; there is no customer-facing interface.',
  'D8/G3 still needs independent verification; D5b is not applied (no production host); production startup enforcement does not exist.',
  'Timings come from a disposable PostgreSQL 16 container and are not production measurements.',
  'Nothing is scheduled: verification and purge run when invoked.'
];
const failed = report.scenarios.filter(s => s.outcome === 'FAIL');
report.result = failed.length === 0 ? 'PASS' : 'FAIL';
const text = JSON.stringify(report, null, 2);
const leak = [...FORBIDDEN].filter(f => text.includes(f));
if (leak.length) { console.error('DEMO_REPORT_LEAK: the report would contain fixture values; refusing to write it'); process.exit(3); }
if (cfg.report) writeFileSync(cfg.report, text + '\n');
console.log(`RESULT ${report.result}: ${report.scenarios.filter(s => s.outcome === 'PASS').length} passed, ${failed.length} failed, ` +
            `${report.scenarios.filter(s => s.outcome === 'SKIPPED').length} skipped; ${report.duration_ms} ms`);
process.exitCode = failed.length === 0 ? 0 : 1;
