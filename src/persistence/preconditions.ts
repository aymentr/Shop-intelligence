/**
 * Operational preconditions for B-002 (founder decision D7). Each is an assumption the
 * database design relies on but PostgreSQL cannot enforce from inside a migration:
 *
 * - PostgreSQL 16: the behaviour the design was verified against (deferred triggers,
 *   row-lock modes, no transaction_timeout).
 * - max_prepared_transactions = 0: a PREPARE TRANSACTION could hold a publication open
 *   indefinitely between its rights check and its commit (M2 plan section 4, G3).
 * - track_commit_timestamp = on: needed by the receipt monitor and the D8 commit-timestamp
 *   gate (0004), and by forensic tests.
 * - synchronous_standby_names empty: a synchronous-replication wait would add an unbounded,
 *   externally controlled delay after the publication check.
 * - default_transaction_isolation = read committed: every B-002 routine assumes it
 *   (the control and publication paths also refuse anything else).
 *
 * Used by the integration tests and by `cli.js preflight` as a deployment check.
 */
import type { ClientBase } from 'pg';

export interface PreconditionResult { name: string; ok: boolean; actual: string; expected: string }

export async function checkOperationalPreconditions(client: ClientBase): Promise<PreconditionResult[]> {
  const r = await client.query<{
    version: string; prepared: string; commit_ts: string; sync: string; isolation: string;
  }>(`SELECT current_setting('server_version_num') AS version,
             current_setting('max_prepared_transactions') AS prepared,
             current_setting('track_commit_timestamp') AS commit_ts,
             current_setting('synchronous_standby_names') AS sync,
             current_setting('default_transaction_isolation') AS isolation`);
  const s = r.rows[0];
  if (!s) throw new Error('PRECONDITIONS_FAILED: could not read server settings');
  const v = Number(s.version);
  return [
    { name: 'postgresql_major_16', ok: v >= 160000 && v < 170000, actual: s.version, expected: '16xxxx' },
    { name: 'max_prepared_transactions', ok: s.prepared === '0', actual: s.prepared, expected: '0' },
    { name: 'track_commit_timestamp', ok: s.commit_ts === 'on', actual: s.commit_ts, expected: 'on' },
    { name: 'synchronous_standby_names', ok: s.sync === '', actual: s.sync, expected: '(empty)' },
    { name: 'default_transaction_isolation', ok: s.isolation === 'read committed', actual: s.isolation, expected: 'read committed' }
  ];
}

/**
 * Collector logging safety (Milestone 3, M3-P2B). Must run in a real si_collector session: role
 * settings apply at login, so only the session that will carry an evidence payload can show
 * what the server will log for it. Evidence payloads are sent only when every check passes.
 * Out of scope: a superuser changing system settings later, extensions, debug log levels.
 */
export async function checkCollectorLogging(client: ClientBase): Promise<PreconditionResult[]> {
  const s = (await client.query<{
    who: string; plen: string; plen_err: string; stmt: string; dur: string; sample: string; rate: string;
  }>(`SELECT current_user AS who,
             current_setting('log_parameter_max_length') AS plen,
             current_setting('log_parameter_max_length_on_error') AS plen_err,
             current_setting('log_statement') AS stmt,
             current_setting('log_min_duration_statement') AS dur,
             current_setting('log_min_duration_sample') AS sample,
             current_setting('log_transaction_sample_rate') AS rate`)).rows[0];
  if (!s) throw new Error('PRECONDITIONS_FAILED: could not read collector session settings');
  return [
    { name: 'collector_session', ok: s.who === 'si_collector', actual: s.who, expected: 'si_collector' },
    { name: 'log_parameter_max_length', ok: s.plen === '0', actual: s.plen, expected: '0' },
    { name: 'log_parameter_max_length_on_error', ok: s.plen_err === '0', actual: s.plen_err, expected: '0' },
    { name: 'log_statement', ok: s.stmt === 'none' || s.stmt === 'ddl', actual: s.stmt, expected: 'none or ddl' },
    { name: 'log_min_duration_statement', ok: s.dur === '-1', actual: s.dur, expected: '-1' },
    { name: 'log_min_duration_sample', ok: s.sample === '-1', actual: s.sample, expected: '-1' },
    { name: 'log_transaction_sample_rate', ok: Number(s.rate) === 0, actual: s.rate, expected: '0' }
  ];
}

/** Throws with every failed precondition listed; resolves when all hold. */
export async function assertOperationalPreconditions(client: ClientBase): Promise<void> {
  const failed = (await checkOperationalPreconditions(client)).filter(p => !p.ok);
  if (failed.length > 0) {
    throw new Error(`PRECONDITIONS_FAILED: ${failed.map(p => `${p.name}=${p.actual} (expected ${p.expected})`).join('; ')}`);
  }
}

/**
 * D5b production gate: PUBLIC and application-role effective privileges must be
 * absent for every advisory-lock overload. A managed service unable to revoke
 * these privileges cannot pass this gate.
 */
export async function checkProductionAdvisoryPermissions(client: ClientBase): Promise<PreconditionResult[]> {
  const r = await client.query<{ public_count: string; application_count: string; owner_lock: boolean; migrator_lock: boolean }>(`
    WITH funcs AS (
      SELECT oid, proname FROM pg_catalog.pg_proc
      WHERE pronamespace = 'pg_catalog'::regnamespace
        AND proname ~ '^pg_(try_)?advisory'
    ),
    roles AS (
      SELECT oid FROM pg_catalog.pg_roles
      WHERE rolname IN ('si_collector', 'si_rights_admin', 'si_retention', 'si_monitor')
    )
    SELECT
      (SELECT count(*)::text FROM funcs f
       WHERE EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(
           coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=f.oid),
                    pg_catalog.acldefault('f', (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=f.oid)))
         ) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE'
       )) AS public_count,
      (SELECT count(*)::text FROM funcs f CROSS JOIN roles r
       WHERE pg_catalog.has_function_privilege(r.oid, f.oid, 'EXECUTE')) AS application_count,
      pg_catalog.has_function_privilege('si_owner', 'pg_catalog.pg_advisory_xact_lock(integer,integer)', 'EXECUTE') AS owner_lock,
      pg_catalog.has_function_privilege('si_migrator', 'pg_catalog.pg_advisory_xact_lock(bigint)', 'EXECUTE') AS migrator_lock
  `);
  const s = r.rows[0];
  if (!s) throw new Error('D5B_PREFLIGHT_FAILED: no privilege results');
  return [
    { name: 'advisory_public_exposures', ok: s.public_count === '0', actual: s.public_count, expected: '0' },
    { name: 'advisory_application_exposures', ok: s.application_count === '0', actual: s.application_count, expected: '0' },
    { name: 'advisory_owner_lock', ok: s.owner_lock, actual: String(s.owner_lock), expected: 'true' },
    { name: 'advisory_migrator_lock', ok: s.migrator_lock, actual: String(s.migrator_lock), expected: 'true' }
  ];
}
