// Shared helpers for PostgreSQL integration tests. Synthetic data only.
//
// Safety guard: every test refuses to run unless the server is on a loopback
// address and every database it creates or drops ends in "_test".
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootstrapCluster, bootstrapDatabase, LOGIN_ROLES } from '../../dist/persistence/bootstrap.js';
import { migrateUp } from '../../dist/persistence/migrate.js';

export const cfg = Object.freeze({
  host: process.env.SI_TEST_PGHOST ?? '127.0.0.1',
  port: Number(process.env.SI_TEST_PGPORT ?? 54329),
  adminUser: process.env.SI_TEST_ADMIN_USER ?? 'si_bootstrap',
  adminPassword: process.env.SI_TEST_ADMIN_PASSWORD ?? 'local-test-only',   // dev-only placeholder, matches compose.yaml
  rolePassword: process.env.SI_TEST_ROLE_PASSWORD ?? 'local-test-only',     // dev-only placeholder
  maintenanceDb: process.env.SI_TEST_MAINTENANCE_DB ?? 'postgres',
  template: process.env.SI_TEST_TEMPLATE ?? 'si_template_test'
});

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export function assertSafeTarget(dbName) {
  if (!LOOPBACK.has(cfg.host)) throw new Error(`refusing: SI_TEST_PGHOST must be a loopback address, got ${cfg.host}`);
  if (!/^[a-z0-9_]+_test$/.test(dbName)) throw new Error(`refusing: test database names must match ^[a-z0-9_]+_test$, got ${dbName}`);
}

export async function connect({ user = cfg.adminUser, password, database = cfg.maintenanceDb, app = 'si-test' } = {}) {
  const client = new pg.Client({
    host: cfg.host, port: cfg.port, user, database,
    password: password ?? (user === cfg.adminUser ? cfg.adminPassword : cfg.rolePassword),
    application_name: app
  });
  // Idle-connection errors (e.g. a test database dropped WITH (FORCE) during cleanup) must
  // not crash the test process; errors on active queries still reject their promises.
  client.on('error', () => {});
  await client.connect();
  return client;
}

export function uniqueDbName(prefix) {
  return `si_t_${prefix}_${randomBytes(4).toString('hex')}_test`;
}

/** Cluster roles (with test passwords) — idempotent. */
export async function ensureRoles() {
  const admin = await connect();
  try {
    await bootstrapCluster(admin, { passwords: Object.fromEntries(LOGIN_ROLES.map(r => [r, cfg.rolePassword])) });
  } finally { await admin.end(); }
}

/** Fresh database with bootstrap applied; migrated unless migrate === false. Dropped by t.after. */
export async function freshDatabase(t, prefix, { migrate = true, fromTemplate = true } = {}) {
  const name = uniqueDbName(prefix);
  assertSafeTarget(name);
  const admin = await connect();
  try {
    if (migrate && fromTemplate) {
      assertSafeTarget(cfg.template);
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${cfg.template}`);
    } else {
      await admin.query(`CREATE DATABASE ${name}`);
    }
  } finally { await admin.end(); }
  t.after(() => dropDatabase(name));
  // Database-level ACLs are not copied from a template, so run the database bootstrap on every clone.
  const db = await connect({ database: name });
  try {
    await bootstrapDatabase(db);
    if (migrate && !fromTemplate) await migrateUp(db);
  } finally { await db.end(); }
  return name;
}

export async function dropDatabase(name) {
  assertSafeTarget(name);
  const admin = await connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
}

/** Opens one dedicated connection per requested role (never a shared pool). Closed by t.after. */
export async function roles(t, database, names) {
  const out = {};
  for (const n of names) {
    out[n] = n === 'admin' ? await connect({ database }) : await connect({ user: n, database });
  }
  t.after(async () => { for (const c of Object.values(out)) await c.end().catch(() => {}); });
  return out;
}

/** Runs fn inside a transaction as si_owner (for fixtures), with the runner's search_path. */
export async function asOwner(client, fn) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE si_owner');
    await client.query('SET LOCAL search_path = pg_catalog, pg_temp');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Expects a query to fail; returns the error (asserting SQLSTATE and/or message when given). */
export async function rejects(assert, promise, { code, message } = {}) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `expected an error${code ? ` with SQLSTATE ${code}` : ''}${message ? ` matching ${message}` : ''}`);
  if (code) assert.equal(err.code, code, `SQLSTATE: ${err.message}`);
  if (message) assert.match(err.message, message);
  return err;
}

/** V5 rule: proves that `waiterPid` is blocked by `holderPid`, using a third, observer connection. */
export async function waitUntilBlocked(observer, waiterPid, holderPid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await observer.query(
      `SELECT $2::int = ANY (pg_catalog.pg_blocking_pids($1)) AS blocked,
              (SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid = $1) AS wait`,
      [waiterPid, holderPid]);
    if (r.rows[0].blocked && r.rows[0].wait === 'Lock') return;
    await sleep(25);
  }
  throw new Error(`pid ${waiterPid} was not observed blocked by pid ${holderPid} within ${timeoutMs} ms`);
}

export const pid = async c => (await c.query('SELECT pg_catalog.pg_backend_pid() AS p')).rows[0].p;

/**
 * Classifies how a concurrent statement ended, so a concurrency test can tell expected lock
 * contention and serialization apart from a terminated connection, a timeout or an
 * unexpected database error.
 */
export function classifyError(err) {
  if (['57P01', '57P02', '57P03', '25P03'].includes(err.code) || /Connection terminated|not queryable|terminating connection/i.test(err.message)) return 'terminated';
  if (err.code === '55P03') return 'lock-timeout';
  if (err.code === '57014') return 'statement-timeout';
  return 'db-error';
}
export async function settle(promise) {
  try { return { status: 'ok', value: await promise }; } catch (err) { return { status: classifyError(err), code: err.code, message: err.message }; }
}

/**
 * Starts tracking a statement that is expected to block. The outcome handler is attached
 * immediately, so a rejection that arrives while the test is still committing the holder is
 * captured instead of surfacing as an unhandled rejection. Pass the result to
 * expectWaiterOk / expectWaiterError.
 */
export function waiter(promise) {
  const s = settle(promise);
  s.isWaiter = true;
  return s;
}
const outcome = p => (p.isWaiter ? p : settle(p));

/** A blocked waiter must complete normally. Returns its result. */
export async function expectWaiterOk(assert, promise) {
  const r = await outcome(promise);
  assert.equal(r.status, 'ok', `waiter ended with ${r.status}${r.code ? ` (${r.code})` : ''}: ${r.message ?? ''}`);
  return r.value;
}

/** A blocked waiter must fail with exactly this database error — not a timeout or a lost connection. */
export async function expectWaiterError(assert, promise, { code, message }) {
  const r = await outcome(promise);
  assert.equal(r.status, 'db-error', `waiter ended with ${r.status}${r.code ? ` (${r.code})` : ''}: ${r.message ?? ''}`);
  assert.equal(r.code, code, `SQLSTATE: ${r.message}`);
  if (message) assert.match(r.message, message);
}

/**
 * Commits a lock holder and proves the commit really happened on the same, live backend:
 * COMMIT on an aborted transaction reports ROLLBACK, and a backend terminated by
 * idle_in_transaction_session_timeout (or anything else) throws here instead of letting a
 * waiter "succeed" against a rolled-back holder.
 */
export async function holderCommit(assert, client, expectedPid) {
  let r;
  try { r = await client.query('COMMIT'); } catch (err) {
    assert.fail(`lock holder lost before COMMIT (${classifyError(err)}${err.code ? `, ${err.code}` : ''}): ${err.message}`);
  }
  assert.equal(r.command, 'COMMIT', 'holder transaction committed (an aborted transaction would report ROLLBACK)');
  assert.equal(await pid(client), expectedPid, 'holder backend is the same, live session');
}

/** Evidence arguments for si_record_rights_version: one synthetic declaration. */
export const SYNTH_EVIDENCE = [['SYNTHETIC_DECLARATION'], ['test:synthetic'], null, ['test fixture']];

/**
 * Calls si.si_record_rights_version. Every argument may be overridden; times are
 * passed as SQL expressions so microsecond precision never round-trips through JS Date.
 */
export async function recordRights(client, source, o = {}) {
  const v = {
    evaluation: 'ALLOWED', retain: 'ALLOWED', subscriber_display: 'DENIED', media_mirror: 'DENIED', export: 'DENIED',
    retention_days: 30, cleanup_within: '1 hour', basis: 'synthetic test fixture', change_reason: 'test',
    effective_from_sql: 'NULL', expires_at_sql: 'NULL', evidence: SYNTH_EVIDENCE, expectOrderViolation: false, ...o
  };
  // Amendment C rev1 R2 meta-check: every test history must satisfy SI_EFFECTIVE_FROM_ORDER
  // unless the test explicitly expects the rejection (expectOrderRejection). A mis-specified
  // history fails here as a test bug, before the database is asked.
  // Callers without SELECT on rights_versions (privilege tests) skip the check: their call
  // is refused for lack of EXECUTE anyway, before any history could be written.
  let violates = null;
  try {
    violates = (await client.query(
      `SELECT EXISTS (SELECT 1 FROM si.rights_versions WHERE source_id = $1
                      AND effective_from > coalesce(${v.effective_from_sql}, clock_timestamp())) AS violates`, [source])).rows[0].violates;
  } catch (err) {
    if (err.code !== '42501') throw err;
  }
  if (violates === true && !v.expectOrderViolation) {
    throw new Error(`TEST BUG: history for ${source} violates SI_EFFECTIVE_FROM_ORDER (effective_from ${v.effective_from_sql}); use expectOrderRejection()`);
  }
  if (violates === false && v.expectOrderViolation) {
    throw new Error(`TEST BUG: expected an ordering violation for ${source}, but the history is ordered`);
  }
  const [kinds, refs, shas, descs] = v.evidence;
  const r = await client.query(
    `SELECT * FROM si.si_record_rights_version($1, $2, $3, $4, $5, $6, $7, $8::interval, $9, $10,
        ${v.effective_from_sql}, ${v.expires_at_sql}, $11::text[], $12::text[], $13::text[], $14::text[])`,
    [source, v.evaluation, v.retain, v.subscriber_display, v.media_mirror, v.export, v.retention_days,
     v.cleanup_within, v.basis, v.change_reason, kinds, refs, shas, descs]);
  return r.rows[0];
}

/**
 * NEG tests: asserts the history really violates the ordering rule, that the database
 * rejects it with SI_EFFECTIVE_FROM_ORDER, and that no version was added.
 */
export async function expectOrderRejection(assert, client, source, o = {}) {
  const count = async () => (await client.query('SELECT count(*)::int AS n FROM si.rights_versions WHERE source_id = $1', [source])).rows[0].n;
  const before = await count();
  await rejects(assert, recordRights(client, source, { ...o, expectOrderViolation: true }), { code: '23514', message: /SI_EFFECTIVE_FROM_ORDER/ });
  assert.equal(await count(), before, 'a rejected version changes nothing');
}

/** Calls si.si_record_source_control (Amendment C). LIFT-only fields are ignored for other kinds. */
export async function control(client, source, kind, o = {}) {
  const r = await client.query('SELECT * FROM si.si_record_source_control($1, $2, $3, $4, $5, $6, $7, $8)',
    [source, kind, o.reason ?? `test ${kind}`, o.reference ?? null, o.expectedMaxVersion ?? null,
     o.expectedControlSeq ?? null, o.ackTerminationSeq ?? null, o.authorizationVersion ?? null]);
  return r.rows[0];
}

/** What an operator sees before a LIFT: latest version, latest control sequence, open termination. */
export async function controlView(client, source) {
  return (await client.query(`
    SELECT (SELECT coalesce(max(version), 0) FROM si.rights_versions WHERE source_id = $1) AS "maxVersion",
           (SELECT coalesce(max(control_seq), 0) FROM si.source_controls WHERE source_id = $1) AS "lastSeq",
           (SELECT max(control_seq) FROM si.source_controls WHERE source_id = $1 AND kind = 'TERMINATE_RETENTION'
              AND control_seq > (SELECT coalesce(max(control_seq), 0) FROM si.source_controls WHERE source_id = $1 AND kind = 'LIFT')) AS "openTermination"`,
    [source])).rows[0];
}

/** LIFT with a fresh view; `o` may override expectations or add acknowledgement/authorization. */
export async function lift(client, source, o = {}) {
  const v = await controlView(client, source);
  return control(client, source, 'LIFT', { expectedMaxVersion: v.maxVersion, expectedControlSeq: v.lastSeq, ...o });
}

/** Inserts synthetic test sources as si_owner. */
export async function createSources(admin, ids, networks = ['META']) {
  await asOwner(admin, async c => {
    for (const id of ids) {
      await c.query(`INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks)
                     VALUES ($1, $2, 'SYNTHETIC', $3)`, [id, `test ${id}`, networks]);
    }
  });
}

/**
 * Catalog fingerprint of schema si: relations, columns, constraints, indexes,
 * triggers, functions (definition, owner, ACL, settings, volatility, definer flag),
 * table/column ACLs, schema ACL and default ACLs. Used instead of pg_dump so the
 * comparison does not depend on a client binary matching the server version.
 */
export async function schemaFingerprint(client) {
  const q = async sql => (await client.query(sql)).rows;
  return JSON.stringify({
    schema: await q(`SELECT nspname, pg_get_userbyid(nspowner) AS owner, nspacl::text FROM pg_namespace WHERE nspname = 'si'`),
    defaultAcl: await q(`SELECT coalesce(n.nspname, '(all schemas)') AS scope, defaclobjtype, defaclacl::text
                         FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
                         WHERE d.defaclrole = 'si_owner'::regrole ORDER BY 1, 2`),
    relations: await q(`SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner, c.relacl::text
                        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'si' ORDER BY 1`),
    columns: await q(`SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
                             pg_get_expr(d.adbin, d.adrelid) AS dflt, a.attidentity, a.attgenerated, a.attacl::text
                      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                      WHERE n.nspname = 'si' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p') ORDER BY 1, 2`),
    constraints: await q(`SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def, condeferrable, condeferred
                          FROM pg_constraint WHERE connamespace = 'si'::regnamespace ORDER BY 1, 2`),
    indexes: await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'si' ORDER BY 1`),
    triggers: await q(`SELECT tgrelid::regclass::text AS rel, tgname, pg_get_triggerdef(t.oid) AS def, tgenabled
                       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                       WHERE c.relnamespace = 'si'::regnamespace AND NOT tgisinternal ORDER BY 1, 2`),
    functions: await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def,
                               pg_get_userbyid(p.proowner) AS owner, p.proacl::text, p.proconfig, p.provolatile, p.prosecdef
                        FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace ORDER BY 1, 2`)
  });
}
