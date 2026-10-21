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
