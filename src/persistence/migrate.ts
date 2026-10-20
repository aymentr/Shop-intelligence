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
  | 'SCHEMA_VERSION_MISMATCH';

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
  await client.query('GRANT SELECT ON si.schema_migrations TO si_collector, si_rights_admin, si_retention, si_monitor');
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
