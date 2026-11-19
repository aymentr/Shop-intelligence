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
import { checkCollectorLogging, checkMonitorSessionBounds, checkOperationalPreconditions, checkProductionAdvisoryPermissions, type PreconditionResult } from './preconditions.js';
import { checkIndexReadinessPrecondition, type ReadinessScope } from './readiness.js';

export interface ProductionReadinessOptions {
  /** A live session of the si_collector login, connected to the same database as `client`. */
  collector?: ClientBase | null;
  /**
   * M4-P3.3-P1-OPS-01: how the 0022 readiness check treats UNRELATED invalid index artifacts. 'strict' (default) for every
   * deployment and normal command; 'purge' / 'diagnostic' only for `retention purge` and the read-only status commands
   * (readiness.ts, docs §17.5). Every other check of this gate is identical in every scope.
   */
  readinessScope?: ReadinessScope;
}

/** The gate refused: carries the content-free failure line, so callers can report it under an accurate code. */
export class ProductionGateRefused extends Error {
  constructor(message: string) { super(message); this.name = 'ProductionGateRefused'; }
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

export async function assertProductionReady(client: ClientBase, options: ProductionReadinessOptions = {}): Promise<{ warnings: string[] }> {
  const checks = [
    ...await checkOperationalPreconditions(client),
    ...await checkProductionAdvisoryPermissions(client),
    ...await checkMonitorSessionBounds(client),                       // M4-P3.3-P2-CLOSE-01: idle / lock bounds of si_monitor
    ...await collectorChecks(client, options.collector)
  ];
  // M4-P3.3 Phase 1 (R-45): from schema version 22 on, the 0022 index must pass db/ops/readiness.sql.
  const readiness = await checkIndexReadinessPrecondition(client, options.readinessScope ?? 'strict');
  checks.push(...readiness);
  const failed = checks.filter(check => !check.ok);
  if (failed.length > 0) {
    throw new ProductionGateRefused('PRODUCTION_PREFLIGHT_FAILED: ' +
      failed.map(check => check.name + '=' + check.actual).join('; '));
  }
  return { warnings: readiness.flatMap(r => (r.warnings ?? []).map(w => `${r.name}: ${w}`)) };
}
