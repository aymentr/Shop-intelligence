/**
 * Plain-SQL migration runner for B-002.
 *
 * - Files: db/migrations/NNNN_name.up.sql and NNNN_name.down.sql, versions 1..n with no gaps.
 * - Each migration runs in its own transaction, under a transaction-level advisory
 *   lock (concurrent runners serialize), as role si_owner (so si_owner owns every
 *   object), with search_path = pg_catalog, pg_temp (so every object must be
 *   schema-qualified; an unqualified CREATE fails instead of landing somewhere odd).
 * - si.schema_migrations records version, name, SHA-256 of both files and who applied it.
 *   Any edit to an applied file, an applied version missing locally, or an
 *   out-of-order set refuses to run anything.
 * - Rollback ("down") requires an explicit allowDestructive flag and refuses when any
 *   non-SYNTHETIC source exists.
 *
 * The connecting role must be able to SET ROLE si_owner (in tests: the bootstrap
 * superuser; in a real deployment: a migrator login that is a member of si_owner).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientBase } from 'pg';
import { checkIndexReadiness, REQUIRED_INDEX_DEFINITION, type ReadinessFailure } from './readiness.js';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
/** Arbitrary fixed key for pg_advisory_xact_lock; documented so operators can see it in pg_locks. */
export const MIGRATION_LOCK_KEY = '5349004d49470001';
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export type MigrationErrorCode =
  | 'INVALID_MIGRATION_SET'
  | 'CHECKSUM_MISMATCH'
  | 'UNKNOWN_APPLIED_VERSION'
  | 'OUT_OF_ORDER'
  | 'DESTRUCTIVE_NOT_ALLOWED'
  | 'NON_SYNTHETIC_DATA'
  | 'SCHEMA_VERSION_MISMATCH'
  // M4-P3.3 Phase 1: populated adoption of migration 0022 (docs §17)
  | 'NOT_ADOPTABLE'
  | 'WRONG_VERSION'
  | 'INDEX_NOT_READY'
  | 'INVALID_INDEX_PRESENT'
  | 'INDEX_CONFLICT'
  | 'INVALID_ARTIFACTS_PRESENT'
  | 'BUILD_FAILED';

export class MigrationError extends Error {
  constructor(readonly code: MigrationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'MigrationError';
  }
}

export type Migration = {
  version: number;
  name: string;
  up: string;
  down: string;
  upSha256: string;
  downSha256: string;
};

export type AppliedMigration = {
  version: number;
  name: string;
  upSha256: string;
  downSha256: string;
  appliedBy: string;
  appliedAt: Date;
};

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Reads and validates the migration set. Checksums are over the raw file bytes. */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const parts = new Map<number, { name: string; up?: Buffer; down?: Buffer }>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = FILE_PATTERN.exec(file);
    if (!m) throw new MigrationError('INVALID_MIGRATION_SET', `unexpected file name ${file}`);
    const version = Number(m[1]);
    const name = m[2]!;
    const entry = parts.get(version) ?? { name };
    if (entry.name !== name) throw new MigrationError('INVALID_MIGRATION_SET', `version ${version} has two names`);
    const bytes = readFileSync(join(dir, file));
    if (m[3] === 'up') entry.up = bytes; else entry.down = bytes;
    parts.set(version, entry);
  }
  const versions = [...parts.keys()].sort((a, b) => a - b);
  return versions.map((version, i) => {
    if (version !== i + 1) throw new MigrationError('INVALID_MIGRATION_SET', `versions must be 1..n without gaps; found ${versions.join(',')}`);
    const p = parts.get(version)!;
    if (!p.up || !p.down) throw new MigrationError('INVALID_MIGRATION_SET', `version ${version} needs both .up.sql and .down.sql`);
    return {
      version,
      name: p.name,
      up: p.up.toString('utf8'),
      down: p.down.toString('utf8'),
      upSha256: sha256(p.up),
      downSha256: sha256(p.down)
    };
  });
}

/** Highest migration version shipped with this code. */
export function codeSchemaVersion(dir: string = DEFAULT_MIGRATIONS_DIR): number {
  return loadMigrations(dir).at(-1)?.version ?? 0;
}

async function beginLocked(client: ClientBase): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(x'${MIGRATION_LOCK_KEY}'::bigint)`);
  await client.query('SET LOCAL ROLE si_owner');
  await client.query('SET LOCAL search_path = pg_catalog, pg_temp');
  await client.query(`
    CREATE TABLE IF NOT EXISTS si.schema_migrations (
      version     int  PRIMARY KEY CHECK (version >= 1),
      name        text NOT NULL CHECK (name ~ '^[a-z0-9_]+$'),
      up_sha256   text NOT NULL CHECK (up_sha256   ~ '^[0-9a-f]{64}$'),
      down_sha256 text NOT NULL CHECK (down_sha256 ~ '^[0-9a-f]{64}$'),
      applied_by  text NOT NULL DEFAULT session_user,
      applied_at  timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
  await client.query('REVOKE ALL ON si.schema_migrations FROM PUBLIC');
  await client.query('GRANT SELECT ON si.schema_migrations TO si_collector, si_rights_admin, si_retention, si_monitor, si_migrator');
}

async function readApplied(client: ClientBase): Promise<AppliedMigration[]> {
  const res = await client.query(
    'SELECT version, name, up_sha256, down_sha256, applied_by, applied_at FROM si.schema_migrations ORDER BY version'
  );
  return res.rows.map(r => ({
    version: r.version, name: r.name, upSha256: r.up_sha256, downSha256: r.down_sha256,
    appliedBy: r.applied_by, appliedAt: r.applied_at
  }));
}

/** Refuses to proceed unless the applied set is exactly 1..k and every applied file is byte-identical. */
function verifyApplied(applied: AppliedMigration[], local: Migration[]): void {
  applied.forEach((a, i) => {
    if (a.version !== i + 1) throw new MigrationError('OUT_OF_ORDER', `applied versions are not 1..k: ${applied.map(x => x.version).join(',')}`);
    const l = local.find(m => m.version === a.version);
    if (!l) throw new MigrationError('UNKNOWN_APPLIED_VERSION', `version ${a.version} is applied but has no local files`);
    if (l.name !== a.name || l.upSha256 !== a.upSha256 || l.downSha256 !== a.downSha256) {
      throw new MigrationError('CHECKSUM_MISMATCH', `version ${a.version} (${a.name}) differs from what was applied`);
    }
  });
}

async function rollbackQuietly(client: ClientBase): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* connection may already be broken */ }
}

/** Applies pending migrations up to `to` (default: all). Returns the versions applied by this call. */
export async function migrateUp(client: ClientBase, opts: { dir?: string; to?: number } = {}): Promise<number[]> {
  const local = loadMigrations(opts.dir);
  const target = opts.to ?? local.at(-1)?.version ?? 0;
  if (!Number.isInteger(target) || target < 0 || target > local.length) {
    throw new MigrationError('INVALID_MIGRATION_SET', `target ${target} outside 0..${local.length}`);
  }
  const done: number[] = [];
  for (;;) {
    await beginLocked(client);
    try {
      const applied = await readApplied(client);
      verifyApplied(applied, local);
      const next = local[applied.length];
      if (!next || next.version > target) { await client.query('COMMIT'); return done; }
      await client.query(next.up);
      await client.query(
        'INSERT INTO si.schema_migrations (version, name, up_sha256, down_sha256) VALUES ($1, $2, $3, $4)',
        [next.version, next.name, next.upSha256, next.downSha256]
      );
      await client.query('COMMIT');
      done.push(next.version);
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    }
  }
}

/** Rolls back to version `to` (0 = everything), newest first. Destructive: requires allowDestructive. */
export async function migrateDown(
  client: ClientBase,
  opts: { dir?: string; to: number; allowDestructive: boolean }
): Promise<number[]> {
  if (opts.allowDestructive !== true) {
    throw new MigrationError('DESTRUCTIVE_NOT_ALLOWED', 'down migrations delete data; pass allowDestructive: true (CLI: --allow-destructive)');
  }
  const local = loadMigrations(opts.dir);
  if (!Number.isInteger(opts.to) || opts.to < 0) throw new MigrationError('INVALID_MIGRATION_SET', `invalid target ${opts.to}`);
  const done: number[] = [];
  for (;;) {
    await beginLocked(client);
    try {
      const applied = await readApplied(client);
      verifyApplied(applied, local);
      const last = applied.at(-1);
      if (!last || last.version <= opts.to) { await client.query('COMMIT'); return done; }
      const exists = await client.query(`SELECT pg_catalog.to_regclass('si.sources') IS NOT NULL AS present`);
      if (exists.rows[0].present) {
        const real = await client.query(`SELECT count(*)::int AS n FROM si.sources WHERE evidence_kind <> 'SYNTHETIC'`);
        if (real.rows[0].n > 0) throw new MigrationError('NON_SYNTHETIC_DATA', 'refusing a destructive rollback while non-synthetic sources exist; use a forward migration');
      }
      const m = local.find(x => x.version === last.version)!;
      await client.query(m.down);
      await client.query('DELETE FROM si.schema_migrations WHERE version = $1', [m.version]);
      await client.query('COMMIT');
      done.push(m.version);
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    }
  }
}

/** Read-only status. Does not create anything and takes no lock. */
export async function migrationStatus(client: ClientBase, dir?: string): Promise<{
  applied: AppliedMigration[]; pending: number[]; problem: string | null;
}> {
  const local = loadMigrations(dir);
  const present = await client.query(`SELECT pg_catalog.to_regclass('si.schema_migrations') IS NOT NULL AS present`);
  const applied = present.rows[0].present ? await readApplied(client) : [];
  let problem: string | null = null;
  try { verifyApplied(applied, local); } catch (err) { problem = (err as Error).message; }
  return { applied, pending: local.filter(m => m.version > applied.length).map(m => m.version), problem };
}

/**
 * For application start-up: refuses to run against a database whose applied schema
 * version differs from the version this code was built for.
 */
export async function assertSchemaVersion(client: ClientBase, expected: number = codeSchemaVersion()): Promise<void> {
  // Two statements: a missing table is a parse-time error, so a CASE cannot guard it.
  const present = await client.query(`SELECT pg_catalog.to_regclass('si.schema_migrations') IS NOT NULL AS present`);
  const actual = present.rows[0].present
    ? Number((await client.query('SELECT coalesce(max(version), 0) AS v FROM si.schema_migrations')).rows[0].v)
    : 0;
  if (actual !== expected) {
    throw new MigrationError('SCHEMA_VERSION_MISMATCH', `database is at version ${actual}, code expects ${expected}`);
  }
}

// ------------------------------------------------------------------------------------------------
// M4-P3.3 Phase 1 (R-42): populated adoption of migration 0022 (docs §17).
//
// Migration 0022 builds its index non-concurrently inside the migrator's transaction, which blocks writes to
// si.observations for the duration of the build. On a populated database the operator instead:
//   1. buildIndexConcurrently(22): CREATE INDEX CONCURRENTLY with the exact 0022 statement, outside any transaction;
//   2. adoptMigration(22): under the migrator's advisory lock, with DDL on si.observations excluded, re-verify the applied
//      set, the 0022 file checksums and db/ops/readiness.sql, then record 0022 in si.schema_migrations with the file's
//      exact checksums (as `up` would) and the adoption evidence in si.schema_adoptions.
// 0022 itself is never rewritten. `migrate down --to 21` reverses an adoption exactly like an application.

/** The only adoptable migration, pinned: its files, name and the statement whose effect may be prebuilt. */
export const ADOPTABLE = Object.freeze({
  22: Object.freeze({
    name: 'purge_fk_support_index',
    upSha256: '2404e47d4cc178ee41b3c8e41111fa1f0440768b727495fe99fc671624c165fc',
    downSha256: '2af3d1a4034315c9d754a660124de5b03e6b966d8fb19e67ee71ddd01ef9dd0f',
    statement: 'CREATE INDEX observations_by_ad_fk ON si.observations (ad_id, source_id, network, native_ad_id);',
    index: 'observations_by_ad_fk'
  })
});
type Adoptable = (typeof ADOPTABLE)[22];

/** The pinned migration, checked against the local files (fails closed on any byte difference). */
function adoptable(version: number, local: Migration[]): { pin: Adoptable; m: Migration } {
  if (version !== 22) throw new MigrationError('NOT_ADOPTABLE', `only migration 22 can be adopted, not ${version}`);
  const pin = ADOPTABLE[22];
  const m = local.find(x => x.version === version);
  if (!m) throw new MigrationError('INVALID_MIGRATION_SET', `migration ${version} has no local files`);
  if (m.name !== pin.name || m.upSha256 !== pin.upSha256 || m.downSha256 !== pin.downSha256) {
    throw new MigrationError('CHECKSUM_MISMATCH', `local migration ${version} (${m.name}) is not the pinned adoptable file`);
  }
  if (m.up.split(pin.statement).length !== 2) throw new MigrationError('NOT_ADOPTABLE', `migration ${version} does not contain its pinned statement exactly once`);
  return { pin, m };
}

const describe = (f: ReadinessFailure[]): string => f.map(x => `${x.code}:${x.object}`).join(',');
const OWN_BUILD_FAILURES = new Set(['INDEX_NOT_VALID', 'INDEX_NOT_READY', 'INDEX_NOT_LIVE']);

export type BuildResult = { state: 'BUILT' | 'ALREADY_BUILT' | 'ALREADY_APPLIED'; ms: number; replacedInvalid: boolean };

/**
 * Step 1: builds the 0022 index with CREATE INDEX CONCURRENTLY, outside any transaction (PostgreSQL refuses it inside
 * one). Takes NO advisory lock: a concurrent `up` that reaches 0022 waits for the build (its CREATE INDEX conflicts with
 * the build's lock) and then fails on the existing name, recording nothing; adoption re-verifies everything under the lock.
 *  - schema already at >= 22: ALREADY_APPLIED, nothing done;
 *  - schema not exactly 21: WRONG_VERSION;
 *  - another invalid index in schema si: INVALID_ARTIFACTS_PRESENT (never dropped here: it may be someone else's);
 *  - an existing ready index with the required definition: ALREADY_BUILT;
 *  - an existing INVALID index of the required name AND definition (a previous build of this procedure that failed):
 *    INVALID_INDEX_PRESENT, unless `replaceInvalid`, then DROP INDEX CONCURRENTLY of exactly that index and rebuild;
 *  - anything else under that name (valid with another definition, wrong table, not an index): INDEX_CONFLICT, never dropped.
 */
export async function buildIndexConcurrently(client: ClientBase, opts: {
  version: number; dir?: string; lockTimeoutMs?: number; replaceInvalid?: boolean;
}): Promise<BuildResult> {
  const local = loadMigrations(opts.dir);
  const { pin } = adoptable(opts.version, local);
  const lockTimeout = opts.lockTimeoutMs ?? 5000;
  if (!Number.isInteger(lockTimeout) || lockTimeout < 1 || lockTimeout > 600000) throw new MigrationError('INVALID_MIGRATION_SET', `invalid lock timeout ${lockTimeout}`);
  const present = await client.query(`SELECT pg_catalog.to_regclass('si.schema_migrations') IS NOT NULL AS present`);
  const applied = present.rows[0].present ? await readApplied(client) : [];
  verifyApplied(applied, local);
  if (applied.length >= opts.version) return { state: 'ALREADY_APPLIED', ms: 0, replacedInvalid: false };
  if (applied.length !== opts.version - 1) throw new MigrationError('WRONG_VERSION', `database is at version ${applied.length}, building ${opts.version} requires ${opts.version - 1}`);
  await client.query('SET ROLE si_owner');
  try {
    await client.query('SET search_path = pg_catalog, pg_temp');
    await client.query(`SET lock_timeout = '${lockTimeout}ms'`);
    await client.query(`SET statement_timeout = 0`);
    let replacedInvalid = false;
    const failures = await checkIndexReadiness(client);
    const artifacts = failures.filter(f => f.code === 'INVALID_INDEX_ARTIFACT');
    if (artifacts.length) throw new MigrationError('INVALID_ARTIFACTS_PRESENT', `invalid indexes in schema si must be removed by an operator first: ${describe(artifacts)}`);
    const own = failures.filter(f => f.code !== 'INDEX_MISSING');
    if (failures.length === 0) return { state: 'ALREADY_BUILT', ms: 0, replacedInvalid: false };
    if (own.length > 0) {
      const target = (await client.query(`
        SELECT i.indexrelid::oid AS oid, i.indisvalid, pg_catalog.pg_get_indexdef(i.indexrelid) AS def
          FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
         WHERE c.relnamespace = 'si'::regnamespace AND c.relname = $1 AND i.indrelid = 'si.observations'::regclass`, [pin.index])).rows[0];
      const onlyOwnBuildFailure = own.every(f => OWN_BUILD_FAILURES.has(f.code));
      if (!target || !onlyOwnBuildFailure || target.def !== REQUIRED_INDEX_DEFINITION || target.indisvalid) {
        throw new MigrationError('INDEX_CONFLICT', `si.${pin.index} exists and is not an invalid copy of the required index (${describe(own)}); it is never dropped automatically`);
      }
      if (!opts.replaceInvalid) {
        throw new MigrationError('INVALID_INDEX_PRESENT', `si.${pin.index} is an invalid leftover of a failed concurrent build (${describe(own)}); rerun with --replace-invalid to drop and rebuild it`);
      }
      // Re-check the same object, still invalid, immediately before dropping it.
      const again = (await client.query(`SELECT i.indisvalid FROM pg_catalog.pg_index i WHERE i.indexrelid = $1`, [target.oid])).rows[0];
      if (!again || again.indisvalid) throw new MigrationError('INDEX_CONFLICT', `si.${pin.index} changed while being inspected`);
      await client.query(`DROP INDEX CONCURRENTLY si.${pin.index}`);
      replacedInvalid = true;
    }
    const t0 = performance.now();
    try {
      await client.query(pin.statement.replace(/^CREATE INDEX /, 'CREATE INDEX CONCURRENTLY '));
    } catch (err) {
      const left = (await checkIndexReadiness(client).catch(() => [])).filter(f => OWN_BUILD_FAILURES.has(f.code));
      throw new MigrationError('BUILD_FAILED', `${(err as Error).message}${left.length ? `; an invalid index was left (${describe(left)}): rerun with --replace-invalid` : ''}`);
    }
    const ms = performance.now() - t0;
    const after = await checkIndexReadiness(client);
    if (after.length) throw new MigrationError('INDEX_NOT_READY', `after the build: ${describe(after)}`);
    return { state: 'BUILT', ms, replacedInvalid };
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('RESET lock_timeout').catch(() => {});
    await client.query('RESET statement_timeout').catch(() => {});
    await client.query('RESET search_path').catch(() => {});
  }
}

export type AdoptResult = { state: 'ADOPTED' | 'ALREADY_APPLIED'; adoptionId: number | null };

async function ensureAdoptionLog(client: ClientBase): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS si.schema_adoptions (
      adoption_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      version            int    NOT NULL CHECK (version >= 1),
      name               text   NOT NULL CHECK (name ~ '^[a-z0-9_]+$'),
      up_sha256          text   NOT NULL CHECK (up_sha256   ~ '^[0-9a-f]{64}$'),
      down_sha256        text   NOT NULL CHECK (down_sha256 ~ '^[0-9a-f]{64}$'),
      index_name         text   NOT NULL,
      index_oid          oid    NOT NULL,
      index_definition   text   NOT NULL,
      index_bytes        bigint NOT NULL CHECK (index_bytes >= 0),
      readiness          text   NOT NULL CHECK (readiness = 'PASS'),
      server_version_num int    NOT NULL,
      adopted_by         text   NOT NULL DEFAULT session_user,
      adopted_at         timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
  await client.query(`
    CREATE OR REPLACE FUNCTION si.trg_schema_adoptions_append_only() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
    BEGIN RAISE EXCEPTION 'SI_APPEND_ONLY: si.schema_adoptions is append-only' USING ERRCODE = 'insufficient_privilege'; END $f$`);
  await client.query(`CREATE OR REPLACE TRIGGER trg_schema_adoptions_append_only BEFORE UPDATE OR DELETE ON si.schema_adoptions
                        FOR EACH ROW EXECUTE FUNCTION si.trg_schema_adoptions_append_only()`);
  await client.query(`CREATE OR REPLACE TRIGGER trg_schema_adoptions_no_truncate BEFORE TRUNCATE ON si.schema_adoptions
                        FOR EACH STATEMENT EXECUTE FUNCTION si.trg_schema_adoptions_append_only()`);
  await client.query('REVOKE ALL ON si.schema_adoptions FROM PUBLIC');
  await client.query('REVOKE ALL ON FUNCTION si.trg_schema_adoptions_append_only() FROM PUBLIC');
  await client.query('GRANT SELECT ON si.schema_adoptions TO si_monitor, si_migrator');
}

/**
 * Step 2: records migration `version` (22 only) as applied after its index was prebuilt. One transaction, under the
 * migrator's advisory lock (concurrent `up`, `down` and adoptions serialize), as si_owner:
 *   applied set exactly 1..21 with byte-identical files (else WRONG_VERSION / CHECKSUM_MISMATCH; 22 already applied
 *   -> ALREADY_APPLIED, nothing written); local 0022 equal to the pinned files; SHARE UPDATE EXCLUSIVE lock on
 *   si.observations (no CREATE/DROP INDEX, concurrent or not, until commit; reads and writes continue);
 *   db/ops/readiness.sql = PASS (else INDEX_NOT_READY with every code); then the same si.schema_migrations row `up`
 *   writes, and one si.schema_adoptions row (append-only) with the index's oid, definition and size.
 */
export async function adoptMigration(client: ClientBase, opts: { version: number; dir?: string; lockTimeoutMs?: number }): Promise<AdoptResult> {
  const local = loadMigrations(opts.dir);
  const { pin, m } = adoptable(opts.version, local);
  const lockTimeout = opts.lockTimeoutMs ?? 5000;
  if (!Number.isInteger(lockTimeout) || lockTimeout < 1 || lockTimeout > 600000) throw new MigrationError('INVALID_MIGRATION_SET', `invalid lock timeout ${lockTimeout}`);
  try {
    await beginLocked(client);                       // inside the guard: a failed lock or SET ROLE rolls back too
    const applied = await readApplied(client);
    verifyApplied(applied, local);
    if (applied.length >= opts.version) {
      const failures = await checkIndexReadiness(client);
      if (failures.length) throw new MigrationError('INDEX_NOT_READY', `version ${opts.version} is recorded but the index is not ready: ${describe(failures)}`);
      await client.query('COMMIT');
      return { state: 'ALREADY_APPLIED', adoptionId: null };
    }
    if (applied.length !== opts.version - 1) throw new MigrationError('WRONG_VERSION', `database is at version ${applied.length}, adopting ${opts.version} requires ${opts.version - 1}`);
    await client.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
    await client.query('LOCK TABLE si.observations IN SHARE UPDATE EXCLUSIVE MODE');
    const failures = await checkIndexReadiness(client);
    if (failures.length) throw new MigrationError('INDEX_NOT_READY', `the prebuilt index is not ready: ${describe(failures)}`);
    const ix = (await client.query(`SELECT c.oid, pg_catalog.pg_get_indexdef(c.oid) AS def, pg_catalog.pg_relation_size(c.oid) AS bytes,
                                           pg_catalog.current_setting('server_version_num')::int AS server
                                      FROM pg_catalog.pg_class c WHERE c.relnamespace = 'si'::regnamespace AND c.relname = $1`, [pin.index])).rows[0];
    await client.query(
      'INSERT INTO si.schema_migrations (version, name, up_sha256, down_sha256) VALUES ($1, $2, $3, $4)',
      [m.version, m.name, m.upSha256, m.downSha256]
    );
    await ensureAdoptionLog(client);
    const row = (await client.query(`
      INSERT INTO si.schema_adoptions (version, name, up_sha256, down_sha256, index_name, index_oid, index_definition, index_bytes, readiness, server_version_num)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PASS', $9) RETURNING adoption_id`,
      [m.version, m.name, m.upSha256, m.downSha256, pin.index, ix.oid, ix.def, ix.bytes, ix.server])).rows[0];
    await client.query('COMMIT');
    return { state: 'ADOPTED', adoptionId: Number(row.adoption_id) };
  } catch (err) {
    await rollbackQuietly(client);
    throw err;
  }
}
