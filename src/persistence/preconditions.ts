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

/** Throws with every failed precondition listed; resolves when all hold. */
export async function assertOperationalPreconditions(client: ClientBase): Promise<void> {
  const failed = (await checkOperationalPreconditions(client)).filter(p => !p.ok);
  if (failed.length > 0) {
    throw new Error(`PRECONDITIONS_FAILED: ${failed.map(p => `${p.name}=${p.actual} (expected ${p.expected})`).join('; ')}`);
  }
}
