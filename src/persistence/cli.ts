/**
 * Operator CLI. Connection string comes only from SI_DATABASE_URL (an admin or
 * migrator login); there is deliberately no default.
 *
 *   node dist/persistence/cli.js bootstrap            roles (cluster) + schema/ACLs (this database)
 *   node dist/persistence/cli.js up [--to N]
 *   node dist/persistence/cli.js down --to N --allow-destructive
 *   node dist/persistence/cli.js status
 *
 * bootstrap sets login passwords only if SI_ROLE_PASSWORD_<ROLE> (e.g.
 * SI_ROLE_PASSWORD_SI_COLLECTOR) or SI_ROLE_PASSWORD is set. Passwords never
 * appear in arguments or output.
 */
import pg from 'pg';
import { bootstrapCluster, bootstrapDatabase, LOGIN_ROLES, type LoginRole } from './bootstrap.js';
import { migrateDown, migrateUp, migrationStatus } from './migrate.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const url = process.env.SI_DATABASE_URL;
  if (!url) throw new Error('SI_DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url, application_name: 'si-migrate' });
  await client.connect();
  try {
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
    } else {
      throw new Error('usage: cli.js bootstrap | up [--to N] | down --to N --allow-destructive | status');
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  // Error messages here come from this code or from PostgreSQL, never from ad sources.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
