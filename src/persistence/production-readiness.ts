/**
 * Mandatory D7 + D5b production-readiness assertion for a single connected
 * PostgreSQL database. No privilege changes, no fallback, no environment toggle.
 *
 * Every future production entry point must call this before accepting work.
 * A passing assertion is not authorization to serve content (D8 is separate).
 */
import type { ClientBase } from 'pg';
import { checkOperationalPreconditions, checkProductionAdvisoryPermissions } from './preconditions.js';

export async function assertProductionReady(client: ClientBase): Promise<void> {
  const checks = [
    ...await checkOperationalPreconditions(client),
    ...await checkProductionAdvisoryPermissions(client)
  ];
  const failed = checks.filter(check => !check.ok);
  if (failed.length > 0) {
    throw new Error('PRODUCTION_PREFLIGHT_FAILED: ' +
      failed.map(check => check.name + '=' + check.actual).join('; '));
  }
}
