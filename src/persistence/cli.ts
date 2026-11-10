/**
 * Operator CLI. Connection string comes only from SI_DATABASE_URL (an admin or
 * migrator login); there is deliberately no default.
 *
 *   node dist/persistence/cli.js bootstrap            roles (cluster) + schema/ACLs (this database)
 *   node dist/persistence/cli.js up [--to N]
 *   node dist/persistence/cli.js down --to N --allow-destructive
 *   node dist/persistence/cli.js status
 *   node dist/persistence/cli.js preflight            operational preconditions (deployment check, D7)
 *   node dist/persistence/cli.js preflight --collector   also checks collector logging safety in a
 *                                                     real collector session (SI_COLLECTOR_DATABASE_URL)
 *   node dist/persistence/cli.js retention purge [--limit N]   one bounded purge batch (si_retention login)
 *   node dist/persistence/cli.js retention status              content-free status (si_retention or si_monitor)
 *   node dist/persistence/cli.js retention overdue             sources past their cleanup deadline (exit 2 if any)
 *   node dist/persistence/cli.js retention failures [--limit N]   recorded purge failures (codes only)
 *
 * Retention commands print only codes, ids, times and counts; a failure prints
 * "RETENTION_FAILED code=<code> sqlstate=<state> recorded=<bool>", never a database message.
 * Nothing is scheduled by this CLI.
 *
 * bootstrap sets login passwords only if SI_ROLE_PASSWORD_<ROLE> (e.g.
 * SI_ROLE_PASSWORD_SI_COLLECTOR) or SI_ROLE_PASSWORD is set. Passwords never
 * appear in arguments or output.
 */
import pg from 'pg';
import { bootstrapCluster, bootstrapDatabase, LOGIN_ROLES, type LoginRole } from './bootstrap.js';
import { migrateDown, migrateUp, migrationStatus } from './migrate.js';
import { checkCollectorLogging, checkOperationalPreconditions, checkProductionAdvisoryPermissions } from './preconditions.js';
import { assertProductionReady } from './production-readiness.js';
import { DEFAULT_PURGE_RUNS, overdueRetention, purgeDue, purgeFailures, RetentionFailed, retentionStatus } from './retention.js';

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

async function main(): Promise<void> {
  const command = process.argv[2];
  const url = process.env.SI_DATABASE_URL;
  if (!url) throw new Error('SI_DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url, application_name: command === 'retention' ? 'si-retention' : 'si-migrate' });
  await client.connect();
  try {
    // Production CLI operations and explicit production preflight must fail closed
    // before dispatch. Provisioning D5b remains a separate privileged operation.
    // Trusted deployment must set SI_PRODUCTION=1 for ALL production entry points.
    if (process.env.SI_PRODUCTION === '1' ||
        (command === 'preflight' && process.argv.includes('--production'))) {
      await assertProductionReady(client);
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
    } else if (command === 'preflight') {
      const results = await checkOperationalPreconditions(client);
      if (process.argv.includes('--production')) results.push(...await checkProductionAdvisoryPermissions(client));
      if (process.argv.includes('--collector')) {
        const curl = process.env.SI_COLLECTOR_DATABASE_URL;
        if (!curl) throw new Error('preflight --collector requires SI_COLLECTOR_DATABASE_URL (an si_collector login)');
        const col = new pg.Client({ connectionString: curl, application_name: 'si-preflight-collector' });
        await col.connect();
        try { results.push(...await checkCollectorLogging(col)); } finally { await col.end(); }
      }
      for (const p of results) console.log(`${p.ok ? 'ok  ' : 'FAIL'} ${p.name}: ${p.actual} (expected ${p.expected})`);
      if (results.some(p => !p.ok)) process.exitCode = 1;
    } else if (command === 'retention') {
      await retention(client, process.argv[3]);
    } else {
      throw new Error('usage: cli.js bootstrap | up [--to N] | down --to N --allow-destructive | status | preflight [--production] [--collector] | retention <purge|status|overdue|failures>');
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
