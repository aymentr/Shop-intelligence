/**
 * B-002 M4-P3.3 Phase 1 (R-45): schema readiness of the index created by migration 0022.
 *
 * The check itself is db/ops/readiness.sql (read-only, catalog only; PASS = zero rows), executed verbatim so that the
 * operator script, preflight, CI, DR-1 and `migrate adopt` apply exactly the same rules. It is a deployment check of one
 * physical structure, NOT an evidence-integrity check (see db/ops/integrity-gate.sql, fk-audit.sql, verify-summaries.sql).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ClientBase } from 'pg';
import type { PreconditionResult } from './preconditions.js';

export const READINESS_SQL_PATH = fileURLToPath(new URL('../../db/ops/readiness.sql', import.meta.url));
/** The exact definition migration 0022 creates (pg_get_indexdef form); db/ops/readiness.sql pins the same text. */
export const REQUIRED_INDEX_DEFINITION =
  'CREATE INDEX observations_by_ad_fk ON si.observations USING btree (ad_id, source_id, network, native_ad_id)';
/** The first migration version that requires the index. */
export const INDEX_REQUIRED_FROM_VERSION = 22;

export type ReadinessFailure = { code: string; object: string };

export function readinessSql(path: string = READINESS_SQL_PATH): string {
  return readFileSync(path, 'utf8');
}

/** Runs db/ops/readiness.sql. Empty = PASS. */
export async function checkIndexReadiness(client: ClientBase, sql: string = readinessSql()): Promise<ReadinessFailure[]> {
  const rows = (await client.query(sql)).rows as Array<Record<string, unknown>>;
  return rows.map(r => ({ code: String(r.code), object: String(r.object) }));
}

/**
 * Preflight form. Below schema version 22 the index is not yet required (the migration or `migrate adopt 22` creates it),
 * so the check reports NOT_APPLICABLE and passes; from version 22 on it must PASS. This keeps production-mode commands
 * (`up`, `build-index`, `adopt`) usable on a database that has not reached 0022, while every database that records 0022
 * must carry a ready index.
 */
export async function checkIndexReadinessPrecondition(client: ClientBase): Promise<PreconditionResult[]> {
  const name = 'index_readiness_observations_by_ad_fk';
  const present = (await client.query(`SELECT pg_catalog.to_regclass('si.schema_migrations') IS NOT NULL AS present`)).rows[0]?.present === true;
  const version = present
    ? Number((await client.query('SELECT coalesce(max(version), 0) AS v FROM si.schema_migrations')).rows[0]?.v ?? 0)
    : 0;
  if (!Number.isInteger(version)) return [{ name, ok: false, actual: 'unknown schema version', expected: 'PASS' }];
  if (version < INDEX_REQUIRED_FROM_VERSION) {
    return [{ name, ok: true, actual: `NOT_APPLICABLE (schema version ${version} < ${INDEX_REQUIRED_FROM_VERSION})`, expected: 'PASS' }];
  }
  const failures = await checkIndexReadiness(client);
  return [{ name, ok: failures.length === 0,
            actual: failures.length === 0 ? 'PASS' : failures.map(f => `${f.code}:${f.object}`).join(','), expected: 'PASS' }];
}
