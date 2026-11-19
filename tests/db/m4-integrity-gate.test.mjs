// B-002 M4-P3.0.1-CLOSE-01: the evidence-reference trust boundary (condition of M4-P3.0.1-ACCEPT-01). Real disposable
// PostgreSQL 16, synthetic sources only. The SQL under test is db/ops/integrity-gate.sql (catalog gate) and
// db/ops/fk-audit.sql (data audit), read from the files that operations run.
//
//   IG-1  a freshly migrated database: gate PASS (0 rows), audit PASS (0 rows); both are read-only.
//   IG-2  every tampering the gate must detect, each in a rolled-back transaction, each reported exactly (only its own
//         check): observations_ad / observations_run dropped, replaced by a narrower key, re-added NOT VALID, an
//         enforcement trigger disabled, a referencing column made nullable, an immutability trigger disabled, a stored
//         session_replication_role default. Done as si_owner where the owner can (asserted), else as superuser.
//   IG-3  si_owner — not only a superuser — can create inconsistent evidence (drop the key, insert an observation whose
//         network differs from its ad's into a COMPLETED run, re-add NOT VALID). The gate reports FK_NOT_VALIDATED,
//         VALIDATE CONSTRAINT fails, the audit lists the row, and 0019 releases the run the oracle refuses — the state
//         the procedure of docs §14.9 keeps readers away from.
//   IG-4  catalog validity is not data integrity: rows written in replica mode while the keys stay VALID pass the gate
//         and are found only by the audit.
//   IG-5  cost: the gate is a catalog query (asserted < 50 ms); the audit is a full scan (reported).
//   M4-P3.1-CLOSE-01 (condition C4):
//   IG-0  the function pins of the gate equal SHA-256 of the function bodies in the latest migration that defines them
//         (computed here from the migration files, not from the catalog).
//   IG-2  (extended) the 0020/0021 summary storage: foreign keys dropped / NOT VALID / an enforcement trigger disabled,
//         a key or CHECK dropped or replaced, a trigger re-created with another definition, the body of a trigger
//         function, of the eligibility function or of verification replaced, unexpected table or function grants,
//         ownership changes, a SECURITY DEFINER search_path changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cfg, connect, createSources, freshDatabase, recordRights, roles } from './helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';

const GATE = readFileSync(new URL('../../db/ops/integrity-gate.sql', import.meta.url), 'utf8');
const AUDIT = readFileSync(new URL('../../db/ops/fk-audit.sql', import.meta.url), 'utf8');
let n = 0;
const AD = (id, network = 'META') => ({ network, nativeAdId: id, advertiserName: 'Integrity Synthetic', countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: `https://example.test/${id}`, destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: `Synthetic ${id}` });
async function collect(x, src, rows) {
  const networks = [...new Set(rows.map(r => r.network))].sort();
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `ig${++n}`, sha, 'SYNTHETIC', networks, fx])).rows[0];
  await x.si_collector.query('BEGIN');
  await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
  await x.si_collector.query('COMMIT');
  for (let i = 0; i < 20; i++) { const r = await x.si_monitor.query('SELECT * FROM si.si_verify_receipts(500)'); if (!r.rows.length || Number(r.rows[0].verified) === 0) break; }
  return run.run_id;
}
const gate = async c => (await c.query(GATE)).rows.map(r => `${r.check}:${r.detail}`);
const audit = async c => (await c.query(AUDIT)).rows.map(r => r.run_id);
async function fresh(t, prefix) {
  const db = await freshDatabase(t, prefix);
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_monitor']);
  Object.defineProperty(x, 'db', { value: db, enumerable: false });
  return x;
}

test('IG-0: the gate pins each security-critical function to the body in the latest migration that defines it', () => {
  const pins = [...GATE.matchAll(/\('si\.([a-z_]+)\(([^)]*)\)', '([0-9a-f]{64})'/g)].map(m => ({ name: m[1], sha: m[3] }));
  assert.equal(pins.length, 20, 'twenty pinned functions (four added by 0024)');
  const dir = new URL('../../db/migrations/', import.meta.url);
  const files = readdirSync(dir).filter(f => /^\d{4}_.*\.up\.sql$/.test(f)).sort().reverse();
  for (const p of pins) {
    let body = null, file = null;
    for (const f of files) {
      const t = readFileSync(new URL(f, dir), 'utf8');
      const m = new RegExp(`CREATE (OR REPLACE )?FUNCTION si\\.${p.name}\\(`).exec(t);
      if (!m) continue;
      const open = /\bAS\s+(\$[a-z_]*\$)/.exec(t.slice(m.index));                    // the function's opening dollar quote
      const start = m.index + open.index + open[0].length;
      body = t.slice(start, t.indexOf(open[1], start)); file = f; break;
    }
    assert.ok(body !== null, `${p.name}: defined by a migration`);
    assert.equal(createHash('sha256').update(body, 'utf8').digest('hex'), p.sha, `${p.name}: pin == body in ${file}`);
  }
});

test('IG-1: a freshly migrated database passes the gate and the audit; both are read-only', async t => {
  const x = await fresh(t, 'm4ig1');
  await createSources(x.admin, ['ig-a'], ['META']); await recordRights(x.si_rights_admin, 'ig-a', {});
  await collect(x, 'ig-a', [AD('a1'), AD('a2')]);
  assert.deepEqual(await gate(x.admin), [], 'gate PASS');
  assert.deepEqual(await audit(x.admin), [], 'audit PASS');
  // As si_owner (the role operations use), in a read-only transaction: no write is attempted.
  await x.admin.query('BEGIN READ ONLY'); await x.admin.query('SET LOCAL ROLE si_owner');
  try { assert.deepEqual(await gate(x.admin), []); assert.deepEqual(await audit(x.admin), []); } finally { await x.admin.query('ROLLBACK'); }
});

const FK_AD = 'FOREIGN KEY (ad_id, source_id, network, native_ad_id) REFERENCES si.ads(ad_id, source_id, network, native_ad_id) ON DELETE RESTRICT';
const FK_RUN = 'FOREIGN KEY (run_id, source_id, rights_version_id) REFERENCES si.collection_runs(run_id, source_id, rights_version_id)';
const trig = async (c, con, rel) => (await c.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_constraint k ON k.oid = t.tgconstraint
  WHERE k.conname = $1 AND t.tgrelid = $2::regclass ORDER BY 1 LIMIT 1`, [con, rel])).rows[0].tgname;
const TAMPER = [
  { name: 'observations_ad dropped', owner: true, sql: async c => c.query('ALTER TABLE si.observations DROP CONSTRAINT observations_ad'),
    expect: ['FK_MISSING:observations_ad'] },
  { name: 'observations_run dropped', owner: true, sql: async c => c.query('ALTER TABLE si.observations DROP CONSTRAINT observations_run'),
    expect: ['FK_MISSING:observations_run'] },
  { name: 'observations_ad replaced by a narrower key (same name)', owner: true,
    sql: async c => { await c.query('ALTER TABLE si.observations DROP CONSTRAINT observations_ad');
                      await c.query('ALTER TABLE si.observations ADD CONSTRAINT observations_ad FOREIGN KEY (ad_id) REFERENCES si.ads (ad_id)'); },
    expect: ['FK_DEFINITION:observations_ad: FOREIGN KEY (ad_id) REFERENCES si.ads(ad_id)', 'FK_REFERENCED_KEY:observations_ad'] },
  { name: 'observations_ad re-added NOT VALID', owner: true,
    sql: async c => { await c.query('ALTER TABLE si.observations DROP CONSTRAINT observations_ad');
                      await c.query(`ALTER TABLE si.observations ADD CONSTRAINT observations_ad ${FK_AD} NOT VALID`); },
    expect: ['FK_NOT_VALIDATED:observations_ad'] },
  { name: 'observations_run re-added NOT VALID', owner: true,
    sql: async c => { await c.query('ALTER TABLE si.observations DROP CONSTRAINT observations_run');
                      await c.query(`ALTER TABLE si.observations ADD CONSTRAINT observations_run ${FK_RUN} NOT VALID`); },
    expect: ['FK_NOT_VALIDATED:observations_run'] },
  { name: 'an observations_ad enforcement trigger disabled (superuser)', owner: false,
    sql: async c => c.query(`ALTER TABLE si.observations DISABLE TRIGGER "${await trig(c, 'observations_ad', 'si.observations')}"`),
    expect: ['FK_TRIGGERS:observations_ad: 3 of 4 enforcement triggers enabled'] },
  { name: 'an observations_run enforcement trigger on the referenced table disabled (superuser)', owner: false,
    sql: async c => c.query(`ALTER TABLE si.collection_runs DISABLE TRIGGER "${await trig(c, 'observations_run', 'si.collection_runs')}"`),
    expect: ['FK_TRIGGERS:observations_run: 3 of 4 enforcement triggers enabled'] },
  { name: 'a referencing column made nullable', owner: true, sql: async c => c.query('ALTER TABLE si.observations ALTER COLUMN network DROP NOT NULL'),
    expect: ['FK_COLUMN_NULLABLE:observations_ad: network'] },
  { name: 'the append-only trigger disabled', owner: true, sql: async c => c.query('ALTER TABLE si.observations DISABLE TRIGGER trg_observations_append_only'),
    expect: ['IMMUTABILITY_TRIGGER:trg_observations_append_only'] },
  { name: 'the run-completed constraint trigger disabled', owner: true, sql: async c => c.query('ALTER TABLE si.observations DISABLE TRIGGER trg_observation_run_completed'),
    expect: ['IMMUTABILITY_TRIGGER:trg_observation_run_completed'] },
  { name: 'the 0020 evidence insert guard disabled', owner: true, sql: async c => c.query('ALTER TABLE si.observations DISABLE TRIGGER trg_observation_open_run'),
    expect: ['IMMUTABILITY_TRIGGER:trg_observation_open_run'] },
  { name: 'the 0020 summary append-only trigger disabled', owner: true, sql: async c => c.query('ALTER TABLE si.run_advertiser_summaries DISABLE TRIGGER trg_summaries_append_only'),
    expect: ['IMMUTABILITY_TRIGGER:trg_summaries_append_only'] },
  { name: 'the 0020 purge-summaries trigger disabled', owner: true, sql: async c => c.query('ALTER TABLE si.collection_runs DISABLE TRIGGER trg_runs_purge_summaries'),
    expect: ['IMMUTABILITY_TRIGGER:trg_runs_purge_summaries'] },
  // ---- M4-P3.1-CLOSE-01 (C4): the summary storage
  { name: '0020 FK run_advertiser_summaries_identity dropped', owner: true,
    sql: async c => c.query('ALTER TABLE si.run_advertiser_summaries DROP CONSTRAINT run_advertiser_summaries_identity'),
    expect: ['FK_MISSING:run_advertiser_summaries_identity'] },
  { name: '0020 FK run_summary_status_run re-added NOT VALID', owner: true,
    sql: async c => { await c.query('ALTER TABLE si.run_summary_status DROP CONSTRAINT run_summary_status_run');
                      await c.query('ALTER TABLE si.run_summary_status ADD CONSTRAINT run_summary_status_run FOREIGN KEY (run_id, source_id) REFERENCES si.collection_runs (run_id, source_id) NOT VALID'); },
    expect: ['FK_NOT_VALIDATED:run_summary_status_run'] },
  { name: '0020 FK run_advertiser_summaries_run narrowed (same name)', owner: true,
    sql: async c => { await c.query('ALTER TABLE si.run_advertiser_summaries DROP CONSTRAINT run_advertiser_summaries_run');
                      await c.query('ALTER TABLE si.run_advertiser_summaries ADD CONSTRAINT run_advertiser_summaries_run FOREIGN KEY (run_id) REFERENCES si.collection_runs (run_id)'); },
    expect: ['FK_DEFINITION:run_advertiser_summaries_run: FOREIGN KEY (run_id) REFERENCES si.collection_runs(run_id)', 'FK_REFERENCED_KEY:run_advertiser_summaries_run'] },
  { name: '0020 FK enforcement trigger disabled (superuser)', owner: false,
    sql: async c => c.query(`ALTER TABLE si.run_advertiser_summaries DISABLE TRIGGER "${await trig(c, 'run_advertiser_summaries_identity', 'si.run_advertiser_summaries')}"`),
    expect: ['FK_TRIGGERS:run_advertiser_summaries_identity: 3 of 4 enforcement triggers enabled'] },
  { name: '0020 digest CHECK dropped', owner: true, sql: async c => c.query('ALTER TABLE si.advertiser_identities DROP CONSTRAINT advertiser_identities_digest'),
    expect: ['KEY_MISSING:advertiser_identities_digest'] },
  { name: '0020 cardinality CHECK replaced by a weaker one (same name)', owner: true,
    sql: async c => { await c.query('ALTER TABLE si.run_advertiser_summaries DROP CONSTRAINT run_advertiser_summaries_check');
                      await c.query('ALTER TABLE si.run_advertiser_summaries ADD CONSTRAINT run_advertiser_summaries_check CHECK (cardinality(ad_ids) >= 1)'); },
    expect: ['KEY_DEFINITION:run_advertiser_summaries_check'] },
  { name: '0020 identity key re-added NOT VALID CHECK', owner: true,
    sql: async c => { await c.query('ALTER TABLE si.advertiser_identities DROP CONSTRAINT advertiser_identities_digest');
                      await c.query(`ALTER TABLE si.advertiser_identities ADD CONSTRAINT advertiser_identities_digest CHECK (advertiser_key = sha256(convert_to(normalized_name, 'UTF8'::name))) NOT VALID`); },
    expect: ['KEY_NOT_VALIDATED:advertiser_identities_digest'] },
  { name: 'the 0020 commit check trigger disabled', owner: true, sql: async c => c.query('ALTER TABLE si.collection_runs DISABLE TRIGGER trg_runs_summary_check'),
    expect: ['IMMUTABILITY_TRIGGER:trg_runs_summary_check'] },
  { name: 'the 0020 commit check re-created with another WHEN clause', owner: true,
    sql: async c => { await c.query('DROP TRIGGER trg_runs_summary_check ON si.collection_runs');
                      await c.query(`CREATE CONSTRAINT TRIGGER trg_runs_summary_check AFTER UPDATE ON si.collection_runs DEFERRABLE INITIALLY DEFERRED
                                     FOR EACH ROW WHEN (OLD.status = 'RUNNING' AND NEW.status = 'NEVER') EXECUTE FUNCTION si.trg_runs_summary_check()`); },
    expect: ['TRIGGER_DEFINITION:trg_runs_summary_check'] },
  { name: 'the summary guard function body replaced (permissive)', owner: true,
    sql: async c => c.query(`CREATE OR REPLACE FUNCTION si.trg_summary_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
                             AS $summary_guard$ BEGIN RETURN OLD; END $summary_guard$`),
    expect: ['FUNCTION_DEFINITION:si.trg_summary_guard()'] },
  { name: 'the insert guard function body replaced (permissive)', owner: true,
    sql: async c => c.query(`CREATE OR REPLACE FUNCTION si.trg_observation_open_run() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
                             AS $observation_open_run$ BEGIN RETURN NEW; END $observation_open_run$`),
    expect: ['FUNCTION_DEFINITION:si.trg_observation_open_run()'] },
  { name: 'the eligibility function body replaced (always eligible)', owner: true,
    sql: async c => c.query(`CREATE OR REPLACE FUNCTION si.si_summary_coverage(p_source_id text) RETURNS TABLE (eligible boolean, reasons text[])
                             LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $summary_coverage$ SELECT true, '{}'::text[] $summary_coverage$`),
    expect: ['FUNCTION_DEFINITION:si.si_summary_coverage(text)'] },
  { name: 'the verification function body replaced (finds nothing)', owner: true,
    sql: async c => c.query(`CREATE OR REPLACE FUNCTION si.si_verify_summaries(p_source_id text) RETURNS TABLE (run_id uuid, finding text)
                             LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $verify_summaries$ SELECT NULL::uuid, NULL::text WHERE false $verify_summaries$`),
    expect: ['FUNCTION_DEFINITION:si.si_verify_summaries(text)'] },
  { name: 'the fingerprint loses its ICU version', owner: true,
    sql: async c => c.query(`CREATE OR REPLACE FUNCTION si.si_normalizer_fingerprint() RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
                             AS $normalizer_fingerprint$ SELECT 'v1|icu=fixed|pg=16' $normalizer_fingerprint$`),
    expect: ['FUNCTION_DEFINITION:si.si_normalizer_fingerprint()'] },
  { name: 'a SECURITY DEFINER search_path changed', owner: true,
    sql: async c => c.query('ALTER FUNCTION si.trg_runs_purge_summaries() SET search_path = public, pg_catalog'),
    expect: ['FUNCTION_DEFINITION:si.trg_runs_purge_summaries()', 'SECDEF_SEARCH_PATH:si.trg_runs_purge_summaries()'] },
  { name: 'SELECT on the summaries granted to the collector', owner: true, sql: async c => c.query('GRANT SELECT ON si.run_advertiser_summaries TO si_collector'),
    expect: ['TABLE_PRIVILEGES:run_advertiser_summaries: owner si_owner, acl {si_owner=arwdDxt/si_owner,si_collector=r/si_owner}'] },
  { name: 'INSERT on the drift log granted to the monitor', owner: true, sql: async c => c.query('GRANT INSERT ON si.summary_events TO si_monitor'),
    expect: ['TABLE_PRIVILEGES:summary_events: owner si_owner, acl {si_owner=arwdDxt/si_owner,si_monitor=a/si_owner}'] },
  { name: 'EXECUTE on the eligibility function granted to PUBLIC', owner: true, sql: async c => c.query('GRANT EXECUTE ON FUNCTION si.si_summary_coverage(text) TO PUBLIC'),
    expect: ['FUNCTION_PRIVILEGES:si.si_summary_coverage(text): owner si_owner, acl {si_owner=X/si_owner,=X/si_owner}', 'PUBLIC_EXECUTE:si.si_summary_coverage(text)'] },
  { name: 'EXECUTE on rebuild granted to the collector', owner: true, sql: async c => c.query('GRANT EXECUTE ON FUNCTION si.si_rebuild_run_summaries(uuid) TO si_collector'),
    expect: ['FUNCTION_PRIVILEGES:si.si_rebuild_run_summaries(uuid): owner si_owner, acl {si_owner=X/si_owner,si_collector=X/si_owner}'] },
  { name: 'an owner-only table with a NULL (default) ACL, as pg_restore leaves it, is NOT reported (superuser)', owner: false,
    sql: async c => c.query(`UPDATE pg_class SET relacl = NULL WHERE oid = 'si.run_advertiser_summaries'::regclass`), expect: [] },
  { name: 'a summary table given to another owner (superuser)', owner: false, sql: async c => c.query('ALTER TABLE si.run_summary_status OWNER TO si_bootstrap'),
    expect: ['TABLE_PRIVILEGES:run_summary_status: owner si_bootstrap, acl {si_bootstrap=arwdDxt/si_bootstrap}'] },
  { name: 'a SECURITY DEFINER trigger function given to another owner (superuser)', owner: false,
    sql: async c => c.query('ALTER FUNCTION si.trg_runs_summary_check() OWNER TO si_bootstrap'),
    expect: ['FUNCTION_PRIVILEGES:si.trg_runs_summary_check(): owner si_bootstrap, acl {si_bootstrap=X/si_bootstrap}', 'SECDEF_OWNER:si.trg_runs_summary_check(): si_bootstrap'] },
  { name: 'a stored session_replication_role default (superuser)', owner: false,
    sql: async c => c.query(`ALTER ROLE si_collector IN DATABASE ${c.database} SET session_replication_role = replica`),
    expect: (db) => [`REPLICA_DEFAULT:${db}/si_collector`] },
];
for (const m of TAMPER) {
  test(`IG-2 (${m.name}): reported exactly by the gate`, async t => {
    const x = await fresh(t, 'm4ig2');
    const c = x.admin;
    assert.deepEqual(await gate(c), [], 'baseline: PASS');
    await c.query('BEGIN');
    try {
      if (m.owner) await c.query('SET LOCAL ROLE si_owner');                   // the owner can do this itself
      await m.sql(c);
      await c.query('RESET ROLE');
      const got = await gate(c);
      const want = typeof m.expect === 'function' ? m.expect(x.db) : m.expect;
      console.log(`# IG-2 ${m.name}${m.owner ? ' (as si_owner)' : ''}: ${JSON.stringify(got)}`);
      assert.deepEqual(got, want);
    } finally { await c.query('ROLLBACK'); }
    assert.deepEqual(await gate(c), [], 'rolled back: PASS again');
  });
}

async function inconsistentFixture(t, prefix) {
  const x = await fresh(t, prefix);
  const c = x.admin;
  await createSources(c, ['ig-a'], ['META', 'TIKTOK']); await recordRights(x.si_rights_admin, 'ig-a', {});
  const OK = await collect(x, 'ig-a', [AD('ok1')]);
  const R = await collect(x, 'ig-a', [AD('r1')]);
  await c.query(`UPDATE si.sources SET supported_networks = '{META}' WHERE source_id = 'ig-a'`);
  return { x, c, OK, R };
}
const readableNow = async (c, src) => (await c.query(`SELECT si.si_readable_runs($1, NULL, NULL) AS a,
    ARRAY(SELECT r.run_id FROM si.collection_runs r WHERE r.source_id = $1 AND si.si_evidence_readable(r.run_id)) AS o`, [src])).rows[0];

test('IG-3: si_owner can create inconsistent evidence; gate, VALIDATE and audit all detect it', async t => {
  const { x, c, OK, R } = await inconsistentFixture(t, 'm4ig3');
  // As si_owner only: drop the key, add an observation recorded as TIKTOK against R's META ad, re-add NOT VALID.
  await c.query('BEGIN'); await c.query('SET LOCAL ROLE si_owner');
  await c.query('ALTER TABLE si.observations DROP CONSTRAINT observations_ad');
  await c.query('ALTER TABLE si.observations DISABLE TRIGGER trg_observation_open_run');   // 0020: the owner must disable the insert guard
  await c.query(`INSERT INTO si.observations (run_id, source_id, rights_version_id, ordinal, ad_id, network, native_ad_id, advertiser_name, countries, seen_at, source_url, content_sha256)
      SELECT o.run_id, o.source_id, o.rights_version_id, 1, a.ad_id, 'TIKTOK', a.native_ad_id, o.advertiser_name, o.countries, o.seen_at, o.source_url, o.content_sha256
        FROM si.observations o JOIN si.ads a ON a.native_ad_id = 'ok1' WHERE o.run_id = $1 AND o.ordinal = 0`, [R]);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');                              // the deferred run-completed check runs (and passes)
  await c.query(`ALTER TABLE si.observations ADD CONSTRAINT observations_ad ${FK_AD} NOT VALID`);
  await c.query('ALTER TABLE si.observations ENABLE TRIGGER trg_observation_open_run');
  await c.query('COMMIT');
  assert.equal((await c.query(`SELECT status FROM si.collection_runs WHERE run_id = $1`, [R])).rows[0].status, 'COMPLETED', 'written into a COMPLETED run');
  assert.deepEqual(await gate(c), ['FK_NOT_VALIDATED:observations_ad'], 'gate: the key is not validated');
  await assert.rejects(c.query('ALTER TABLE si.observations VALIDATE CONSTRAINT observations_ad'), { code: '23503' }, 'VALIDATE fails');
  assert.deepEqual(await audit(c), [R], 'audit: exactly the inconsistent observation');
  const r = await readableNow(c, 'ig-a');
  console.log(`# IG-3 oracle readable ${r.o.length}, set-based readable ${r.a.length} (R released by 0019: ${r.a.includes(R)})`);
  assert.deepEqual(r.o, [OK], 'oracle: R refused (TIKTOK unsupported)');
  assert.deepEqual([...r.a].sort(), [OK, R].sort(), '0019 releases R in this state: the procedure must keep readers away from it');
});

test('IG-4: keys VALID and enforced, rows written around them in replica mode — the gate passes, only the audit finds them', async t => {
  const { c, OK, R } = await inconsistentFixture(t, 'm4ig4');
  await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
  await c.query(`UPDATE si.observations SET network = 'TIKTOK' WHERE run_id = $1`, [R]);
  await c.query('COMMIT');
  assert.deepEqual(await gate(c), [], 'gate PASS: the constraints are in force now');
  assert.deepEqual(await audit(c), [R], 'audit: the row written while they were bypassed');
  void OK;
});

test('IG-5: cost — the gate is a catalog query; the audit is a full scan', async t => {
  const x = await fresh(t, 'm4ig5');
  await createSources(x.admin, ['ig-a'], ['META']); await recordRights(x.si_rights_admin, 'ig-a', {});
  for (let k = 0; k < 20; k++) await collect(x, 'ig-a', Array.from({ length: 50 }, (_, i) => AD(`c${k}x${i}`)));
  const time = async sql => { const ms = []; for (let i = 0; i < 20; i++) { const t0 = performance.now(); await x.admin.query(sql); ms.push(performance.now() - t0); } return ms.sort((a, b) => a - b)[18]; };
  const g = await time(GATE), a = await time(AUDIT);
  console.log(`# IG-5 p95 over 20 (1,000 observations): gate ${g.toFixed(2)} ms, audit ${a.toFixed(2)} ms`);
  assert.ok(g < 50, 'the gate stays a catalog query');
});
