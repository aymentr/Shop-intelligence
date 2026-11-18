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
export async function checkIndexReadinessPrecondition(client: ClientBase, scope: ReadinessScope = 'strict'): Promise<ReadinessPreconditionResult[]> {
  const name = 'index_readiness_observations_by_ad_fk';
  const present = (await client.query(`SELECT pg_catalog.to_regclass('si.schema_migrations') IS NOT NULL AS present`)).rows[0]?.present === true;
  const version = present
    ? Number((await client.query('SELECT coalesce(max(version), 0) AS v FROM si.schema_migrations')).rows[0]?.v ?? 0)
    : 0;
  if (!Number.isInteger(version)) return [{ name, ok: false, actual: 'unknown schema version', expected: 'PASS' }];
  if (version < INDEX_REQUIRED_FROM_VERSION) {
    return [{ name, ok: true, actual: `NOT_APPLICABLE (schema version ${version} < ${INDEX_REQUIRED_FROM_VERSION})`, expected: 'PASS' }];
  }
  const all = await checkIndexReadiness(client);
  const { blocking, tolerated } = scope === 'strict' ? { blocking: all, tolerated: [] as ToleratedArtifact[] } : await applyScope(client, all, scope);
  return [{ name, ok: blocking.length === 0,
            actual: blocking.length === 0 ? (tolerated.length ? `PASS (${tolerated.length} tolerated in scope ${scope})` : 'PASS')
                                          : blocking.map(f => `${f.code}:${f.object}`).join(','),
            expected: 'PASS',
            ...(tolerated.length ? { warnings: tolerated.map(a => `INVALID_INDEX_ARTIFACT:${a.name} on ${a.table} (${a.reason}; scope ${scope})`) } : {}) }];
}

// ------------------------------------------------------------------------------------------------------------------
// M4-P3.3-P1-OPS-01 (docs §17.5): command-scoped tolerance of UNRELATED invalid index artifacts.
//
// 'strict' (default; every deployment and normal production command): every readiness failure blocks.
// 'purge' (retention purge) and 'diagnostic' (read-only status commands): an INVALID_INDEX_ARTIFACT is tolerated, with
// an explicit warning, only when it cannot matter to the command:
//   - it is not a schema-defined index (SCHEMA_INDEXES): an invalid schema index means a plan the purge bound or a
//     diagnostic relies on is gone (e.g. an interrupted DROP or REINDEX of a migration index) -> blocking;
//   - 'diagnostic': nothing else; those commands only read, and the planner never uses an invalid index;
//   - 'purge': in addition, it must be NOT READY (never maintained by any write), or have a valid, ready, live TWIN on the
//     same table with the identical definition (a REINDEX CONCURRENTLY leftover: writes behave exactly as for the twin).
//     A ready artifact without a twin is maintained by the purge's own UPDATE / INSERTs (collection_runs, purge_log,
//     purge_failures) and can raise unique / exclusion / expression / key-size errors or wait on other transactions
//     -> blocking.
// Every failure of observations_by_ad_fk itself (every code other than INVALID_INDEX_ARTIFACT) blocks in every scope.

export type ReadinessScope = 'strict' | 'purge' | 'diagnostic';
export type ToleratedArtifact = { name: string; table: string; reason: string };
export type ReadinessPreconditionResult = PreconditionResult & { warnings?: string[] };

/**
 * The indexes the migrations (0001-0023) and the adoption log create in schema si. An invalid index with one of these
 * names is never tolerated. tests/db/m4-ops.test.mjs (OPS-0) requires this list to equal the migrated catalog.
 */
export const SCHEMA_INDEXES: ReadonlySet<string> = new Set([
  'ads_ad_id_source_id_network_native_ad_id_key', 'ads_pkey', 'ads_source_id_network_native_ad_id_key',
  'advertiser_identities_identity_id_source_id_key', 'advertiser_identities_key', 'advertiser_identities_pkey',
  'availability_state_key_pkey', 'collection_runs_pkey', 'collection_runs_run_id_source_id_key',
  'collection_runs_run_id_source_id_rights_version_id_key', 'collection_runs_source_id_request_key_attempt_key',
  'collection_runs_summary_eligible', 'observations_by_ad', 'observations_by_ad_fk', 'observations_by_source_advertiser_key',
  'observations_pkey', 'observations_run_id_ad_id_key', 'publication_receipts_pkey', 'purge_failures_pkey', 'purge_log_pkey',
  'purge_log_run_id_key', 'read_intents_open', 'read_intents_pkey', 'reader_access_log_pkey', 'reader_grants_one_active',
  'reader_grants_pkey', 'receipt_verifications_pkey', 'receipts_by_rights_version', 'rights_evidence_by_version',
  'rights_evidence_pkey', 'rights_versions_pkey', 'rights_versions_rights_version_id_source_id_key',
  'rights_versions_source_id_version_key', 'run_advertiser_summaries_by_identity', 'run_advertiser_summaries_pkey',
  'run_errors_pkey', 'run_request_scope_pkey', 'run_summary_status_by_source', 'run_summary_status_pkey',
  'runs_by_rights_version', 'runs_lease', 'runs_one_completed', 'runs_one_running', 'runs_retention',
  'runs_verification_pending', 'schema_adoptions_pkey', 'schema_migrations_pkey', 'source_controls_control_event_id_source_id_key',
  'source_controls_pkey', 'source_controls_source_id_control_seq_key', 'sources_pkey', 'summary_events_by_source',
  'summary_events_pkey', 'verification_failures_pkey'
]);

/** Read-only catalog facts about the named invalid indexes of schema si. */
const ARTIFACT_SQL = `
  SELECT c.relname AS name, t.relname AS tbl, i.indisready AS ready,
         EXISTS (SELECT 1 FROM pg_catalog.pg_index j JOIN pg_catalog.pg_class jc ON jc.oid = j.indexrelid
                  WHERE j.indrelid = i.indrelid AND j.indexrelid <> i.indexrelid
                    AND j.indisvalid AND j.indisready AND j.indislive
                    AND pg_catalog.replace(pg_catalog.pg_get_indexdef(j.indexrelid),
                                           ' INDEX ' || pg_catalog.quote_ident(jc.relname) || ' ON ', ' INDEX _ ON ')
                      = pg_catalog.replace(pg_catalog.pg_get_indexdef(i.indexrelid),
                                           ' INDEX ' || pg_catalog.quote_ident(c.relname) || ' ON ', ' INDEX _ ON ')) AS twin
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
   WHERE c.relnamespace = 'si'::regnamespace AND c.relname = ANY ($1::text[])
     AND NOT (i.indisvalid AND i.indisready AND i.indislive)`;

async function applyScope(client: ClientBase, all: ReadinessFailure[], scope: Exclude<ReadinessScope, 'strict'>):
    Promise<{ blocking: ReadinessFailure[]; tolerated: ToleratedArtifact[] }> {
  const blocking = all.filter(f => f.code !== 'INVALID_INDEX_ARTIFACT');          // the 0022 index's own failures: always
  const artifacts = all.filter(f => f.code === 'INVALID_INDEX_ARTIFACT');
  const tolerated: ToleratedArtifact[] = [];
  if (artifacts.length === 0) return { blocking, tolerated };
  const facts = new Map((await client.query(ARTIFACT_SQL, [artifacts.map(a => a.object)])).rows
    .map(r => [String(r.name), { table: String(r.tbl), ready: r.ready === true, twin: r.twin === true }]));
  for (const a of artifacts) {
    const f = facts.get(a.object);
    if (!f || a.object === 'observations_by_ad_fk' || SCHEMA_INDEXES.has(a.object)) { blocking.push(a); continue; }
    if (scope === 'diagnostic') { tolerated.push({ name: a.object, table: f.table, reason: 'not a schema index; read-only command' }); continue; }
    if (!f.ready) tolerated.push({ name: a.object, table: f.table, reason: 'not a schema index; not ready: never maintained' });
    else if (f.twin) tolerated.push({ name: a.object, table: f.table, reason: 'not a schema index; identical valid twin' });
    else blocking.push(a);
  }
  return { blocking, tolerated };
}
