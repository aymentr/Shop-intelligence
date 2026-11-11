/**
 * Runs the idempotent bootstrap SQL (db/bootstrap). Roles are cluster-wide and are
 * created here, never in migrations, because managed PostgreSQL hosts often deny
 * CREATEROLE to the migration user.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';

export const BOOTSTRAP_DIR = fileURLToPath(new URL('../../db/bootstrap/', import.meta.url));
export const LOGIN_ROLES = ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor', 'si_migrator'] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

/** Creates or normalizes the five roles and their session settings; optionally sets login passwords. */
export async function bootstrapCluster(
  client: Client,
  opts: { passwords?: Partial<Record<LoginRole, string>>; dir?: string } = {}
): Promise<void> {
  await client.query(readFileSync(join(opts.dir ?? BOOTSTRAP_DIR, 'roles.sql'), 'utf8'));
  for (const role of LOGIN_ROLES) {
    const pw = opts.passwords?.[role];
    if (pw === undefined) continue;
    if (typeof pw !== 'string' || pw.length < 12) throw new Error(`password for ${role} must be at least 12 characters`);
    // ALTER ROLE cannot take bind parameters; escape both identifier and literal.
    await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} PASSWORD ${client.escapeLiteral(pw)}`);
  }
}

/** Per-database setup: schema si, database and schema ACLs, closed default function privileges. */
export async function bootstrapDatabase(client: Client, opts: { dir?: string } = {}): Promise<void> {
  await client.query(readFileSync(join(opts.dir ?? BOOTSTRAP_DIR, 'database.sql'), 'utf8'));
}

/** Name rule for dedicated internal reader principals (M3-P3C). */
export const READER_PRINCIPAL = /^si_reader_[a-z0-9_]{1,40}$/;

/**
 * Creates or normalizes one dedicated internal reader principal (cluster administrator only):
 * a LOGIN role named si_reader_<name>, no elevated attribute, member of si_reader with INHERIT (to
 * use EXECUTE on the read function) but neither SET nor ADMIN, and the session limits the read function
 * requires — role settings are per login role, so each principal carries its own. One principal per
 * person or process: credentials must never be shared. Granting access to a source is a separate,
 * audited step (si_grant_reader, by si_rights_admin).
 */
export async function provisionReaderPrincipal(client: Client, name: string, password?: string): Promise<void> {
  if (!READER_PRINCIPAL.test(name)) throw new Error('reader principal names must match si_reader_<name>');
  const id = client.escapeIdentifier(name);
  await client.query('BEGIN');
  try {
    const exists = (await client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [name])).rowCount;
    if (!exists) await client.query(`CREATE ROLE ${id} LOGIN`);
    await client.query(`ALTER ROLE ${id} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    await client.query(`GRANT si_reader TO ${id} WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`);
    const settings: Array<[string, string]> = [['statement_timeout', '10s'], ['idle_in_transaction_session_timeout', '5s'], ['lock_timeout', '2s'],
                          ['log_parameter_max_length', '0'], ['log_parameter_max_length_on_error', '0'], ['log_statement', 'none'],
                          ['log_min_duration_statement', '-1'], ['log_min_duration_sample', '-1'], ['log_transaction_sample_rate', '0']];
    for (const [k, v] of settings) {
      await client.query(`ALTER ROLE ${id} SET ${k} = ${client.escapeLiteral(v)}`);
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 12) throw new Error('reader principal password must be at least 12 characters');
      await client.query(`ALTER ROLE ${id} PASSWORD ${client.escapeLiteral(password)}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
