/**
 * DEMO-V1 — repeatable setup of a disposable demo database, through the existing validated mechanisms only:
 *   - cluster roles and the per-database bootstrap (bootstrapCluster / bootstrapDatabase);
 *   - the migrations (migrateUp, as si_migrator);
 *   - a dedicated reader principal (provisionReaderPrincipal) and per-source grants (si_grant_reader, si_rights_admin);
 *   - rights versions (si_record_rights_version, si_rights_admin);
 *   - collection runs: T1 (t1PreflightScoped) and T2 with evidence (completeRunWithEvidence, si_collector), which
 *     validate, deduplicate and publish inside si_complete_run;
 *   - receipt verification (verifyReceipts, si_monitor).
 * The one owner step is registering the synthetic sources (INSERT INTO si.sources as si_owner): there is no source
 * registration function, and the existing demonstrations and tests register sources the same way. No time shift,
 * no replica mode, no direct write to runs, evidence, receipts, verdicts or summaries.
 */
import pg from 'pg';
import { bootstrapCluster, bootstrapDatabase, LOGIN_ROLES, provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { migrateUp } from '../../dist/persistence/migrate.js';
import { grantReader } from '../../dist/persistence/reader.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { completeRunWithEvidence, t1PreflightScoped } from '../../dist/persistence/runs.js';
import { verifyReceipts } from '../../dist/persistence/verification.js';
import { ANALYST, PLAN, SOURCES, type EvidenceRow } from './dataset.js';

export interface DbTarget { host: string; port: number; database: string }
export interface RolePasswords { collector: string; rightsAdmin: string; monitor: string; analyst: string; migrator: string }

const DB_NAME = /^[a-z][a-z0-9_]{2,62}$/;

async function client(t: DbTarget, user: string, password: string, database = t.database): Promise<pg.Client> {
  const c = new pg.Client({ host: t.host, port: t.port, user, password, database, application_name: 'si-demo-v1-seed' });
  c.on('error', () => {});
  await c.connect();
  return c;
}

/** Creates (or recreates) the demo database: roles, migrations, analyst principal. Requires the cluster superuser. */
export async function prepareDatabase(t: DbTarget, admin: { user: string; password: string }, pw: RolePasswords): Promise<number[]> {
  if (!DB_NAME.test(t.database)) throw new Error('demo database name must match ^[a-z][a-z0-9_]{2,62}$');
  const root = await client(t, admin.user, admin.password, 'postgres');
  try {
    const passwords: Record<string, string> = { si_collector: pw.collector, si_rights_admin: pw.rightsAdmin, si_monitor: pw.monitor, si_migrator: pw.migrator };
    await bootstrapCluster(root, { passwords: Object.fromEntries(LOGIN_ROLES.filter(r => passwords[r]).map(r => [r, passwords[r] as string])) });
    await provisionReaderPrincipal(root, ANALYST, pw.analyst);
    await root.query(`DROP DATABASE IF EXISTS ${root.escapeIdentifier(t.database)} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${root.escapeIdentifier(t.database)}`);
  } finally { await root.end(); }
  const db = await client(t, admin.user, admin.password);
  try { await bootstrapDatabase(db); } finally { await db.end(); }
  const mig = await client(t, 'si_migrator', pw.migrator);
  try { return await migrateUp(mig); } finally { await mig.end(); }
}

export interface SeedRunResult { sourceId: string; label: string; outcome: string; code: string | null; published: number }
export interface SeedResult { runs: SeedRunResult[]; verified: number }

let keySeq = 0;
/** A unique, valid request key (^[A-Za-z0-9._:-]{1,128}$). */
export function requestKey(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${(++keySeq).toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/** T1 + T2 for one run, exactly as a collector does it. Returns the persisted outcome; never pretends success. */
export async function collectRun(col: pg.ClientBase, sourceId: string, sourceNetworks: string[], rows: EvidenceRow[], keyPrefix: string) {
  const networks = rows.length ? [...new Set(rows.map(r => r.network))].sort() : [sourceNetworks[0] as string];
  const fx = fixtureSha256(rows as unknown as Parameters<typeof fixtureSha256>[0]);
  const t1 = await t1PreflightScoped(col, { sourceId, requestKey: requestKey(keyPrefix), evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx,
    requestSha256: requestSha256({ adapterId: sourceId, evidenceKind: 'SYNTHETIC', networks, fixtureSha256: fx }) });
  if (t1.outcome !== 'RUNNING' || !t1.leaseToken) {
    return { runId: t1.runId, t1: t1.outcome, outcome: t1.outcome, code: t1.outcomeCode, published: 0, diagnostics: null };
  }
  const t2 = await completeRunWithEvidence(col, t1.runId, t1.leaseToken, rows);
  if (t2.outcome === 'COMPLETED') return { runId: t1.runId, t1: t1.outcome, outcome: 'COMPLETED', code: null, published: t2.counts.published, diagnostics: null };
  if (t2.outcome === 'FAILED') return { runId: t1.runId, t1: t1.outcome, outcome: 'FAILED', code: t2.code, published: 0, diagnostics: t2.diagnostics };
  return { runId: t1.runId, t1: t1.outcome, outcome: 'NOT_OWNER', code: null, published: 0, diagnostics: null };
}

/** Registers the sources, records rights, grants the analyst, then publishes and verifies the planned runs. */
export async function seedDemo(t: DbTarget, admin: { user: string; password: string }, pw: RolePasswords): Promise<SeedResult> {
  const owner = await client(t, admin.user, admin.password);
  const ra = await client(t, 'si_rights_admin', pw.rightsAdmin);
  const col = await client(t, 'si_collector', pw.collector);
  const mon = await client(t, 'si_monitor', pw.monitor);
  try {
    await owner.query('BEGIN');
    await owner.query('SET LOCAL ROLE si_owner');
    for (const s of SOURCES) {
      await owner.query(`INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks, conflict_policy)
                         VALUES ($1, $2, 'SYNTHETIC', $3::text[], 'KEEP_FIRST')`, [s.sourceId, s.displayName, s.networks]);
    }
    await owner.query('COMMIT');
    for (const s of SOURCES) {
      await ra.query(`SELECT * FROM si.si_record_rights_version($1, 'ALLOWED', 'ALLOWED', 'DENIED', 'DENIED', 'DENIED', 30, interval '1 hour',
        'Author-created synthetic data for the DEMO-V1 local interface only', 'DEMO-V1 local demonstration', NULL, NULL,
        ARRAY['SYNTHETIC_DECLARATION'], ARRAY['app/server/dataset.ts'], NULL, ARRAY['synthetic records; URLs are never fetched'])`, [s.sourceId]);
      if (s.grantedToAnalyst) await grantReader(ra, ANALYST, s.sourceId, 'internal synthetic evaluation (DEMO-V1 local interface)');
    }
    const runs: SeedRunResult[] = [];
    let verified = 0;
    for (const s of SOURCES) {
      for (const p of PLAN[s.sourceId] ?? []) {
        const r = await collectRun(col, s.sourceId, s.networks, p.rows, 'seed');
        if (r.outcome !== p.expect) throw new Error(`seed: ${p.label} expected ${p.expect}, got ${r.outcome}${r.code ? ` (${r.code})` : ''}`);
        runs.push({ sourceId: s.sourceId, label: p.label, outcome: r.outcome, code: r.code, published: r.published });
        verified += (await verifyReceipts(mon, 100)).verified;
      }
    }
    return { runs, verified };
  } finally {
    for (const c of [owner, ra, col, mon]) await c.end().catch(() => {});
  }
}
