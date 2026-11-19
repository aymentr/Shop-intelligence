/**
 * Operator CLI. Connection string comes only from SI_DATABASE_URL (an admin or
 * migrator login); there is deliberately no default.
 *
 *   node dist/persistence/cli.js bootstrap            roles (cluster) + schema/ACLs (this database)
 *   node dist/persistence/cli.js up [--to N]
 *   node dist/persistence/cli.js down --to N --allow-destructive
 *   node dist/persistence/cli.js status
 *   node dist/persistence/cli.js readiness             db/ops/readiness.sql: the 0022 index (exit 1 on any failure)
 *   node dist/persistence/cli.js build-index --version 22 [--lock-timeout-ms N] [--replace-invalid]
 *                                                     CREATE INDEX CONCURRENTLY of the 0022 index (populated databases; docs §17)
 *   node dist/persistence/cli.js adopt --version 22 [--lock-timeout-ms N]
 *                                                     record 0022 as applied after build-index (advisory lock, readiness PASS)
 *   node dist/persistence/cli.js preflight            operational preconditions (deployment check, D7)
 *   node dist/persistence/cli.js preflight --collector   also checks collector logging safety in a
 *                                                     real collector session (SI_COLLECTOR_DATABASE_URL)
 *   node dist/persistence/cli.js retention purge [--limit N]   one bounded purge batch (si_retention login)
 *   node dist/persistence/cli.js retention status              content-free status (si_retention or si_monitor)
 *   node dist/persistence/cli.js retention overdue             sources past their cleanup deadline (exit 2 if any)
 *   node dist/persistence/cli.js retention failures [--limit N]   recorded purge failures (codes only)
 *   node dist/persistence/cli.js verification run [--limit N]   one bounded receipt-verification batch (si_monitor)
 *   node dist/persistence/cli.js verification status            pending / VALID / INVALID / UNVERIFIABLE, lag, xid age
 *   node dist/persistence/cli.js verification failures [--limit N]   recorded verification failures (codes only)
 *   node dist/persistence/cli.js summaries verify --source S [--max-batches N] [--max-runs N] [--max-observations N]
 *                                                     bounded summary verification sweep (si_monitor; docs §18; exit 2 if not clean)
 *   node dist/persistence/cli.js summaries status      content-free sweep / drift / eligibility per source (exit 2 if drift open)
 *   node dist/persistence/cli.js summaries clear-drift --source S --sweep N   owner recovery after a clean sweep
 *
 * Production mode (SI_PRODUCTION=1, or preflight --production) also requires SI_COLLECTOR_DATABASE_URL:
 * the gate checks a live collector session's effective logging settings and fails closed without it.
 *
 * Retention commands print only codes, ids, times and counts; a failure prints
 * "RETENTION_FAILED code=<code> sqlstate=<state> recorded=<bool>", never a database message; a refusal by the production
 * gate is code=PRECONDITION, followed by the content-free PRODUCTION_PREFLIGHT_FAILED line (M4-P3.3-P1-OPS-01).
 * Under SI_PRODUCTION=1, `retention purge` and the read-only status commands tolerate unrelated invalid index artifacts
 * that cannot matter to them, with a WARN line each; every other command is strict (docs §17.5).
 * Nothing is scheduled by this CLI.
 *
 * bootstrap sets login passwords only if SI_ROLE_PASSWORD_<ROLE> (e.g.
 * SI_ROLE_PASSWORD_SI_COLLECTOR) or SI_ROLE_PASSWORD is set. Passwords never
 * appear in arguments or output.
 */
import pg from 'pg';
import { bootstrapCluster, bootstrapDatabase, LOGIN_ROLES, type LoginRole } from './bootstrap.js';
import { adoptMigration, buildIndexConcurrently, migrateDown, migrateUp, migrationStatus } from './migrate.js';
import { checkIndexReadiness, checkIndexReadinessPrecondition } from './readiness.js';
import { checkCollectorLogging, checkOperationalPreconditions, checkProductionAdvisoryPermissions } from './preconditions.js';
import { assertProductionReady, ProductionGateRefused } from './production-readiness.js';
import type { ReadinessScope } from './readiness.js';
import { clearDrift, SweepBatchFailed, verificationStatus as summaryVerificationStatus, verifySource } from './summary-verification.js';
import { DEFAULT_PURGE_RUNS, overdueRetention, purgeDue, purgeFailures, RetentionFailed, retentionStatus } from './retention.js';
import { DEFAULT_VERIFY_RUNS, verificationFailures, verificationStatus, VerificationFailed, verifyReceipts } from './verification.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function intArg(name: string, fallback: number): number {
  const v = arg(name);
  return v === undefined ? fallback : (/^[0-9]{1,4}$/.test(v) ? Number(v) : NaN);
}

async function retention(client: pg.Client, sub: string | undefined): Promise<void> {
  if (sub === 'purge') {
    console.log(JSON.stringify(await purgeDue(client, intArg('--limit', DEFAULT_PURGE_RUNS))));
  } else if (sub === 'status') {
    console.log(JSON.stringify(await retentionStatus(client)));
  } else if (sub === 'overdue') {
    const overdue = await overdueRetention(client);
    console.log(JSON.stringify(overdue));
    if (overdue.length > 0) process.exitCode = 2;
  } else if (sub === 'failures') {
    console.log(JSON.stringify(await purgeFailures(client, intArg('--limit', 20))));
  } else {
    throw new Error('usage: cli.js retention purge [--limit N] | status | overdue | failures [--limit N]');
  }
}

async function verification(client: pg.Client, sub: string | undefined): Promise<void> {
  if (sub === 'run') {
    console.log(JSON.stringify(await verifyReceipts(client, intArg('--limit', DEFAULT_VERIFY_RUNS))));
  } else if (sub === 'status') {
    const status = await verificationStatus(client);
    console.log(JSON.stringify(status));
    if (status.lagExceeded || status.xidAgeWarning) process.exitCode = 2;
  } else if (sub === 'failures') {
    console.log(JSON.stringify(await verificationFailures(client, intArg('--limit', 20))));
  } else {
    throw new Error('usage: cli.js verification run [--limit N] | status | failures [--limit N]');
  }
}

/** M4-P3.3 Phase 2 (docs §18): batched summary verification (si_monitor) and the owner's drift clearance. */
async function summaries(client: pg.Client, sub: string | undefined): Promise<void> {
  if (sub === 'verify') {
    const source = arg('--source');
    if (!source) throw new Error('usage: cli.js summaries verify --source S [--max-batches N] [--max-runs N] [--max-observations N] [--max-identities N]');
    const r = await verifySource(client, source, { maxBatches: intArg('--max-batches', 100000),
      budget: { maxRuns: intArg('--max-runs', 50), maxObservations: Number(arg('--max-observations') ?? 5000), maxIdentities: intArg('--max-identities', 1000) } });
    const sum = (k: 'runs' | 'observations' | 'identities' | 'findings' | 'unverifiable') => r.batches.reduce((a, b) => a + b[k], 0);
    console.log(JSON.stringify({ sweepId: r.sweepId, state: r.state, batches: r.batches.length, runs: sum('runs'), observations: sum('observations'),
      identities: sum('identities'), findings: sum('findings'), unverifiable: sum('unverifiable'), retriedFailures: r.failures.map(f => f.code) }));
    if (r.state === 'COMPLETED_DRIFT' || r.state === 'INCOMPLETE' || r.state === 'STALE') process.exitCode = 2;
  } else if (sub === 'status') {
    const st = await summaryVerificationStatus(client);
    console.log(JSON.stringify(st));
    if (st.some(s => s.driftOpen)) process.exitCode = 2;
  } else if (sub === 'clear-drift') {
    const source = arg('--source'), sweep = Number(arg('--sweep'));
    if (!source || !Number.isInteger(sweep)) throw new Error('usage: cli.js summaries clear-drift --source S --sweep N');
    console.log(JSON.stringify({ clearedEvent: await clearDrift(client, source, sweep) }));
  } else {
    throw new Error('usage: cli.js summaries verify --source S [...] | status | clear-drift --source S --sweep N');
  }
}

/**
 * M4-P3.3-P1-OPS-01 (docs §17.5): the readiness scope of the production gate for this command. Only `retention purge`
 * ('purge') and the read-only status commands ('diagnostic') may tolerate UNRELATED invalid index artifacts (with a
 * warning); every other command, including `preflight --production`, is 'strict'. All other gate checks are unchanged.
 */
function readinessScopeFor(command: string | undefined, sub: string | undefined): ReadinessScope {
  if (command === 'retention' && sub === 'purge') return 'purge';
  if ((command === 'retention' && (sub === 'status' || sub === 'overdue' || sub === 'failures')) ||
      (command === 'verification' && (sub === 'status' || sub === 'failures')) ||
      (command === 'summaries' && sub === 'status') || command === 'status' || command === 'readiness') return 'diagnostic';
  return 'strict';
}

/** A live collector session for the production gate, or null (the gate then fails closed). */
async function collectorSession(): Promise<pg.Client | null> {
  const curl = process.env.SI_COLLECTOR_DATABASE_URL;
  if (!curl) return null;
  const col = new pg.Client({ connectionString: curl, application_name: 'si-preflight-collector' });
  try { await col.connect(); return col; } catch { await col.end().catch(() => {}); return null; }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const url = process.env.SI_DATABASE_URL;
  if (!url) throw new Error('SI_DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url,
    application_name: command === 'retention' ? 'si-retention' : command === 'verification' ? 'si-verification' : 'si-migrate' });
  await client.connect();
  try {
    // Production CLI operations and explicit production preflight must fail closed
    // before dispatch. Provisioning D5b remains a separate privileged operation.
    // Trusted deployment must set SI_PRODUCTION=1 for ALL production entry points.
    if (process.env.SI_PRODUCTION === '1' ||
        (command === 'preflight' && process.argv.includes('--production'))) {
      const col = await collectorSession();
      try {
        const { warnings } = await assertProductionReady(client, { collector: col, readinessScope: readinessScopeFor(command, process.argv[3]) });
        for (const w of warnings) console.error(`WARN PRODUCTION_PREFLIGHT_TOLERATED: ${w}`);
      } finally { await col?.end().catch(() => {}); }
    }
    if (command === 'bootstrap') {
      const passwords: Partial<Record<LoginRole, string>> = {};
      for (const role of LOGIN_ROLES) {
        const pw = process.env[`SI_ROLE_PASSWORD_${role.toUpperCase()}`] ?? process.env.SI_ROLE_PASSWORD;
        if (pw !== undefined) passwords[role] = pw;
      }
      await bootstrapCluster(client, { passwords });
      await bootstrapDatabase(client);
      console.log(`bootstrap complete; passwords set for: ${Object.keys(passwords).join(', ') || 'none'}`);
    } else if (command === 'up') {
      const to = arg('--to');
      const done = await migrateUp(client, to === undefined ? {} : { to: Number(to) });
      console.log(`applied: ${done.join(', ') || 'nothing'}`);
    } else if (command === 'down') {
      const to = arg('--to');
      if (to === undefined) throw new Error('down requires --to N');
      const done = await migrateDown(client, { to: Number(to), allowDestructive: process.argv.includes('--allow-destructive') });
      console.log(`rolled back: ${done.join(', ') || 'nothing'}`);
    } else if (command === 'status') {
      const s = await migrationStatus(client);
      console.log(JSON.stringify({ applied: s.applied.map(a => a.version), pending: s.pending, problem: s.problem }));
    } else if (command === 'readiness') {
      const failures = await checkIndexReadiness(client);
      for (const f of failures) console.log(`FAIL ${f.code} ${f.object}`);
      if (failures.length) process.exitCode = 1; else console.log('readiness PASS (si.observations_by_ad_fk)');
    } else if (command === 'build-index' || command === 'adopt') {
      const version = Number(arg('--version'));
      const lt = arg('--lock-timeout-ms');
      const lockTimeoutMs = lt === undefined ? undefined : Number(lt);
      const r = command === 'build-index'
        ? await buildIndexConcurrently(client, { version, ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }), replaceInvalid: process.argv.includes('--replace-invalid') })
        : await adoptMigration(client, { version, ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }) });
      console.log(JSON.stringify(r));
    } else if (command === 'preflight') {
      const results = await checkOperationalPreconditions(client);
      if (process.argv.includes('--production')) results.push(...await checkProductionAdvisoryPermissions(client));
      if (process.argv.includes('--collector') || process.argv.includes('--production')) {
        const curl = process.env.SI_COLLECTOR_DATABASE_URL;
        if (!curl) throw new Error('preflight --collector requires SI_COLLECTOR_DATABASE_URL (an si_collector login)');
        const col = new pg.Client({ connectionString: curl, application_name: 'si-preflight-collector' });
        await col.connect();
        try { results.push(...await checkCollectorLogging(col)); } finally { await col.end(); }
      }
      if (process.argv.includes('--production')) results.push(...await checkIndexReadinessPrecondition(client));
      for (const p of results) console.log(`${p.ok ? 'ok  ' : 'FAIL'} ${p.name}: ${p.actual} (expected ${p.expected})`);
      if (results.some(p => !p.ok)) process.exitCode = 1;
    } else if (command === 'retention') {
      await retention(client, process.argv[3]);
    } else if (command === 'verification') {
      await verification(client, process.argv[3]);
    } else if (command === 'summaries') {
      await summaries(client, process.argv[3]);
    } else {
      throw new Error('usage: cli.js bootstrap | up [--to N] | down --to N --allow-destructive | status | readiness | build-index --version 22 [--lock-timeout-ms N] [--replace-invalid] | adopt --version 22 [--lock-timeout-ms N] | preflight [--production] [--collector] | retention <purge|status|overdue|failures> | verification <run|status|failures> | summaries <verify|status|clear-drift>');
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  if (err instanceof RetentionFailed) {
    // Fixed fields only: never a PostgreSQL message, detail or evidence value.
    console.error(`RETENTION_FAILED code=${err.code} sqlstate=${err.sqlstate ?? 'none'} recorded=${err.recorded}`);
    process.exitCode = 1;
    return;
  }
  if (err instanceof SweepBatchFailed) {
    console.error(`SUMMARY_VERIFICATION_FAILED code=${err.code} sqlstate=${err.sqlstate ?? 'none'} recorded=${err.recorded}`);
    process.exitCode = 1;
    return;
  }
  if (err instanceof VerificationFailed) {
    console.error(`VERIFICATION_FAILED code=${err.code} sqlstate=${err.sqlstate ?? 'none'} recorded=${err.recorded}`);
    process.exitCode = 1;
    return;
  }
  if (process.argv[2] === 'retention' && err instanceof ProductionGateRefused) {
    // M4-P3.3-P1-OPS-01: a gate refusal is a precondition failure, not a connection failure. Both lines are content-free
    // (check names, catalog object names, settings).
    console.error('RETENTION_FAILED code=PRECONDITION sqlstate=none recorded=false');
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (process.argv[2] === 'retention' && !(err instanceof Error && /^(usage:|SI_DATABASE_URL is required)/.test(err.message))) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`RETENTION_FAILED code=CONNECTION sqlstate=${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'none'} recorded=false`);
    process.exitCode = 1;
    return;
  }
  // Error messages here come from this code or from PostgreSQL, never from ad sources.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
