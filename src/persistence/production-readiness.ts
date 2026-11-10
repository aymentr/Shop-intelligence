/**
 * Mandatory D7 + D5b production-readiness assertion for a single connected
 * PostgreSQL database. No privilege changes, no fallback, no environment toggle.
 *
 * Every future production entry point must call this before accepting work.
 * A passing assertion is not authorization to serve content (D8 is separate).
 *
 * D7 (M3-P3B): the gate also requires a live session of the collector login on the same database and
 * checks its EFFECTIVE logging settings (role, database-specific role and server settings combined).
 * A missing collector session, the wrong role, another database, unsafe logging, or a check that
 * cannot complete all fail closed. The per-call check in completeRunWithEvidence stays in place.
 */
import type { ClientBase } from 'pg';
import { checkCollectorLogging, checkOperationalPreconditions, checkProductionAdvisoryPermissions, type PreconditionResult } from './preconditions.js';

export interface ProductionReadinessOptions {
  /** A live session of the si_collector login, connected to the same database as `client`. */
  collector?: ClientBase | null;
}

async function collectorChecks(client: ClientBase, collector: ClientBase | null | undefined): Promise<PreconditionResult[]> {
  if (!collector) return [{ name: 'collector_session', ok: false, actual: 'missing', expected: 'a live si_collector session' }];
  try {
    const checks = await checkCollectorLogging(collector);
    const [a, b] = await Promise.all([
      client.query('SELECT current_database() AS d'), collector.query('SELECT current_database() AS d')]);
    const da = a.rows[0]?.d, db = b.rows[0]?.d;
    checks.push({ name: 'collector_database', ok: typeof da === 'string' && da === db, actual: String(db), expected: String(da) });
    return checks;
  } catch {
    return [{ name: 'collector_logging', ok: false, actual: 'check failed', expected: 'completed collector checks' }];
  }
}

export async function assertProductionReady(client: ClientBase, options: ProductionReadinessOptions = {}): Promise<void> {
  const checks = [
    ...await checkOperationalPreconditions(client),
    ...await checkProductionAdvisoryPermissions(client),
    ...await collectorChecks(client, options.collector)
  ];
  const failed = checks.filter(check => !check.ok);
  if (failed.length > 0) {
    throw new Error('PRODUCTION_PREFLIGHT_FAILED: ' +
      failed.map(check => check.name + '=' + check.actual).join('; '));
  }
}
