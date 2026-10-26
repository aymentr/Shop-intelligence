// Grants, ownership, role attributes and the SECURITY DEFINER contract (Amendment A4)
// for the objects that exist after migration 0001. Checks the catalog AND attempts the
// forbidden operations for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { asOwner, cfg, connect, control, freshDatabase, recordRights, rejects, roles } from './helpers.mjs';

const APP_ROLES = ['si_collector', 'si_rights_admin', 'si_retention', 'si_monitor'];
const TABLES = ['si.sources', 'si.rights_versions', 'si.rights_evidence', 'si.source_controls', 'si.schema_migrations',
                'si.collection_runs', 'si.publication_receipts', 'si.run_errors'];
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const RECORD_SIG = 'si.si_record_rights_version(text,text,text,text,text,text,integer,interval,text,text,timestamp with time zone,timestamp with time zone,text[],text[],text[],text[])';
const CONTROL_SIG = 'si.si_record_source_control(text,text,text,text,integer,integer,integer,integer)';

// Expected table-level privileges per role (everything not listed must be false).
const EXPECTED_TABLE = {
  si_collector:    { 'si.sources': ['SELECT'], 'si.rights_versions': ['SELECT'], 'si.rights_evidence': ['SELECT'], 'si.source_controls': ['SELECT'], 'si.schema_migrations': ['SELECT'],
                     // 0002 step 1: read only; write grants arrive with their enforcing triggers (steps 2-4)
                     'si.collection_runs': ['SELECT'], 'si.publication_receipts': ['SELECT'] },
  si_rights_admin: { 'si.sources': ['SELECT'], 'si.rights_versions': ['SELECT'], 'si.rights_evidence': ['SELECT'], 'si.source_controls': ['SELECT'], 'si.schema_migrations': ['SELECT'],
                     'si.collection_runs': ['SELECT'] },
  si_retention:    { 'si.sources': ['SELECT'], 'si.rights_versions': ['SELECT'], 'si.rights_evidence': ['SELECT'], 'si.source_controls': ['SELECT'], 'si.schema_migrations': ['SELECT'],
                     'si.collection_runs': ['SELECT'], 'si.publication_receipts': ['SELECT'], 'si.run_errors': ['SELECT'] },
  si_monitor:      { 'si.schema_migrations': ['SELECT'] }
};
// Expected EXECUTE grantees per function (owner excluded). Anything else in schema si: none.
const EXPECTED_EXECUTE = {
  si_record_rights_version: ['si_rights_admin'],
  si_record_source_control: ['si_rights_admin'],
  si_begin_run: ['si_collector'],                      // 0002 step 2 (T1)
  rights_valid_for_publish: ['si_collector'],
  si_source_suspended: ['si_collector'],
  si_retention_terminated: ['si_collector'],
  si_window_end: ['si_collector'],
  si_publish_margin: ['si_collector']
};
const EXPECTED_DEFINER = ['si_begin_run', 'si_record_rights_version', 'si_record_source_control'];
const EXPECTED_VOLATILITY = {
  si_record_rights_version: 'v', rights_valid_for_publish: 's', si_window_end: 's', si_publish_margin: 'i', si_retention_end: 's',
  trg_rights_insert: 'v', trg_append_only: 'v', trg_evidence_attribution: 'v', trg_rights_evidence_required: 'v', trg_sources_retire_final: 'v',
  // Amendment C
  si_record_source_control: 'v', si_source_suspended: 's', si_retention_terminated: 's', si_source_suspended_at: 's',
  trg_source_controls_insert: 'v',
  // 0002 step 2
  si_request_lock_namespace: 'i', si_request_lock_key: 'i', si_lock_request_key: 'v', si_run_lease: 'i',
  si_t1_rights_decision: 's', trg_runs_insert: 'v', si_begin_run: 'v',
  // Step 3 slice 1: SECURITY INVOKER audit guard
  trg_runs_no_delete: 'v'
};

let db, c;
const cleanups = [];
const fileScope = { after: fn => cleanups.push(fn) };
test.before(async () => {
  db = await freshDatabase(fileScope, 'privs');
  c = await roles(fileScope, db, ['admin', ...APP_ROLES]);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

test('G1: table privileges match the grant matrix exactly (every role x table x privilege)', async () => {
  const mismatches = [];
  for (const role of APP_ROLES) for (const table of TABLES) for (const priv of PRIVS) {
    const has = (await c.admin.query('SELECT has_table_privilege($1, $2, $3) AS h', [role, table, priv])).rows[0].h;
    const want = (EXPECTED_TABLE[role][table] ?? []).includes(priv);
    if (has !== want) mismatches.push(`${role} ${priv} ${table}: has=${has} want=${want}`);
  }
  assert.deepEqual(mismatches, []);
  const pub = (await c.admin.query(`
    SELECT c.relname FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.relnamespace = 'si'::regnamespace AND a.grantee = 0`)).rows;
  assert.deepEqual(pub, [], 'nothing in si is granted to PUBLIC');
});

test('G1 (0002 step 1): no application role holds any column-level write privilege on the run tables', async () => {
  const r = (await c.admin.query(`
    SELECT c.relname, a.attname, x.grantee::regrole::text AS grantee, x.privilege_type
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, aclexplode(a.attacl) x
    WHERE c.relname IN ('collection_runs','publication_receipts','run_errors') AND c.relnamespace = 'si'::regnamespace
      AND a.attacl IS NOT NULL`)).rows;
  assert.deepEqual(r, []);
  for (const role of APP_ROLES) for (const t of ['si.collection_runs', 'si.publication_receipts', 'si.run_errors']) {
    for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      assert.equal((await c.admin.query('SELECT has_table_privilege($1, $2, $3) AS h', [role, t, p])).rows[0].h, false, `${role} ${p} ${t}`);
    }
  }
  await rejects(assert, c.si_collector.query(`DELETE FROM si.collection_runs`), { code: '42501' });
  await rejects(assert, c.si_collector.query(`UPDATE si.collection_runs SET status = 'COMPLETED'`), { code: '42501' });
  await rejects(assert, c.si_collector.query(`INSERT INTO si.publication_receipts (run_id, source_id, rights_version_id) VALUES (gen_random_uuid(), 'synthetic-fixture', 1)`), { code: '42501' });
});

test('G1: column privileges — only si_rights_admin may UPDATE, and only sources.retired_at / conflict_policy', async () => {
  const cols = (await c.admin.query(`SELECT attname FROM pg_attribute WHERE attrelid = 'si.sources'::regclass AND attnum > 0 AND NOT attisdropped`)).rows.map(r => r.attname);
  for (const role of APP_ROLES) for (const col of cols) {
    const has = (await c.admin.query(`SELECT has_column_privilege($1, 'si.sources', $2, 'UPDATE') AS h`, [role, col])).rows[0].h;
    assert.equal(has, role === 'si_rights_admin' && ['retired_at', 'conflict_policy'].includes(col), `${role} UPDATE sources.${col}`);
  }
  await rejects(assert, c.si_rights_admin.query(`UPDATE si.sources SET supported_networks = '{META}' WHERE source_id = 'synthetic-fixture'`), { code: '42501' });
  await rejects(assert, c.si_collector.query(`UPDATE si.sources SET retired_at = now()`), { code: '42501' });
});

test('database and schema ACLs: CONNECT only for app roles, no TEMP, no CREATE anywhere, USAGE on si', async () => {
  for (const role of APP_ROLES) {
    const r = (await c.admin.query(`
      SELECT has_database_privilege($1, current_database(), 'CONNECT') AS connect,
             has_database_privilege($1, current_database(), 'TEMP') AS temp,
             has_database_privilege($1, current_database(), 'CREATE') AS createdb,
             has_schema_privilege($1, 'si', 'USAGE') AS usage, has_schema_privilege($1, 'si', 'CREATE') AS create_si,
             has_schema_privilege($1, 'public', 'CREATE') AS create_public`, [role])).rows[0];
    assert.deepEqual(r, { connect: true, temp: false, createdb: false, usage: true, create_si: false, create_public: false }, role);
  }
  await rejects(assert, c.si_collector.query('CREATE TABLE si.x (a int)'), { code: '42501' });
  await rejects(assert, c.si_collector.query('CREATE TABLE public.x (a int)'), { code: '42501' });
  await rejects(assert, c.si_rights_admin.query('CREATE TEMP TABLE x (a int)'), { code: '42501' });
  const pub = (await c.admin.query(`SELECT a.privilege_type FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database() AND a.grantee = 0`)).rows;
  assert.deepEqual(pub, [], 'PUBLIC has no database privileges');
});

test('SD1: SECURITY DEFINER contract — owner, fixed search_path, no PUBLIC EXECUTE, exact grantees, volatility', async () => {
  const fns = (await c.admin.query(`
    SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
           p.proacl IS NULL AS default_acl,
           coalesce((SELECT array_agg(pg_get_userbyid(a.grantee)::text ORDER BY 1) FROM aclexplode(p.proacl) a
                     WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner AND a.grantee <> 0), '{}') AS grantees,
           EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_grant
    FROM pg_proc p WHERE p.pronamespace = 'si'::regnamespace ORDER BY 1`)).rows;
  assert.deepEqual(fns.filter(f => f.prosecdef).map(f => f.proname), EXPECTED_DEFINER, 'the set of definer routines equals the allowlist');
  assert.deepEqual(fns.map(f => f.proname).sort(), Object.keys(EXPECTED_VOLATILITY).sort(), 'no unexpected functions');
  for (const f of fns) {
    assert.equal(f.owner, 'si_owner', f.proname);
    assert.deepEqual(f.proconfig, ['search_path=pg_catalog, pg_temp'], `${f.proname} search_path`);
    assert.equal(f.default_acl, false, `${f.proname}: a NULL ACL would mean PUBLIC EXECUTE`);
    assert.equal(f.public_grant, false, `${f.proname}: PUBLIC must not have EXECUTE`);
    assert.deepEqual(f.grantees, EXPECTED_EXECUTE[f.proname] ?? [], `${f.proname} grantees`);
    assert.equal(f.provolatile, EXPECTED_VOLATILITY[f.proname], `${f.proname} volatility`);
  }
});

test('SD2/G3: role attributes and per-role session settings', async () => {
  const r = Object.fromEntries((await c.admin.query(`
    SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolconfig
    FROM pg_roles WHERE rolname = ANY($1)`, [['si_owner', ...APP_ROLES]])).rows.map(x => [x.rolname, x]));
  for (const name of ['si_owner', ...APP_ROLES]) {
    assert.deepEqual([r[name].rolsuper, r[name].rolbypassrls, r[name].rolcreaterole, r[name].rolcreatedb, r[name].rolreplication],
                     [false, false, false, false, false], name);
    assert.equal(r[name].rolcanlogin, name !== 'si_owner', `${name} login`);
  }
  const settings = n => (r[n].rolconfig ?? []).slice().sort();
  assert.deepEqual(settings('si_collector'), ['idle_in_transaction_session_timeout=10s', 'lock_timeout=30s', 'statement_timeout=30s']);
  assert.deepEqual(settings('si_rights_admin'), ['idle_in_transaction_session_timeout=10s', 'lock_timeout=30s']);
  assert.deepEqual(settings('si_retention'), ['lock_timeout=30s', 'statement_timeout=120s']);
  assert.deepEqual(settings('si_monitor'), ['statement_timeout=30s']);
  assert.equal((await c.si_collector.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s', 'settings apply on login');
});

test('SD3: unauthorized callers get permission denied (application roles and a role with no grants)', async t => {
  const call = client => recordRights(client, 'synthetic-fixture', { evaluation: 'DENIED', retain: 'DENIED', retention_days: null });
  for (const role of ['si_collector', 'si_retention', 'si_monitor']) {
    await rejects(assert, call(c[role]), { code: '42501', message: /permission denied for function si_record_rights_version/ });
  }
  await rejects(assert, c.si_collector.query(`SELECT si.si_retention_end('synthetic-fixture', 1)`), { code: '42501' });
  await rejects(assert, c.si_monitor.query(`SELECT si.rights_valid_for_publish(1, now())`), { code: '42501' });
  await rejects(assert, c.si_rights_admin.query(`SELECT si.rights_valid_for_publish(1, now())`), { code: '42501' });

  // A brand-new login role: first it cannot even connect (PUBLIC has no CONNECT) ...
  const nogrant = `si_t_nogrant_${randomBytes(3).toString('hex')}`;
  await c.admin.query(`CREATE ROLE ${nogrant} LOGIN PASSWORD '${cfg.rolePassword}'`);
  t.after(async () => {
    const a = await connect();
    await a.query(`DROP OWNED BY ${nogrant}`).catch(() => {});
    await a.query(`DROP ROLE IF EXISTS ${nogrant}`).catch(() => {});
    await a.end();
  });
  await rejects(assert, connect({ user: nogrant, database: db }), { code: '42501' });
  // ... and with CONNECT + schema USAGE only, EXECUTE is still denied (so the denial is the function grant itself).
  await c.admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${nogrant}; GRANT USAGE ON SCHEMA si TO ${nogrant}`);
  const ng = await connect({ user: nogrant, database: db });
  t.after(() => ng.end());
  await rejects(assert, call(ng), { code: '42501', message: /permission denied for function si_record_rights_version/ });
  await rejects(assert, ng.query('SELECT * FROM si.sources'), { code: '42501' });
  await c.admin.query(`REVOKE ALL ON SCHEMA si FROM ${nogrant}; REVOKE ALL ON DATABASE ${db} FROM ${nogrant}`);
});

test('SD3: the authorized caller succeeds even with a hostile search_path', async () => {
  await c.si_rights_admin.query(`SET search_path = "$user", public, pg_temp`);
  const v = await recordRights(c.si_rights_admin, 'synthetic-fixture', { evaluation: 'DENIED', retain: 'DENIED', retention_days: null,
    effective_from_sql: `clock_timestamp() + interval '100 years'` });
  assert.equal(v.version, 2);
  await c.si_rights_admin.query('RESET search_path');
});

test('SD3 (Amendment C): only si_rights_admin may record source controls; audit predicate is owner-only', async t => {
  const call = client => control(client, 'synthetic-fixture', 'SUSPEND');
  for (const role of ['si_collector', 'si_retention', 'si_monitor']) {
    await rejects(assert, call(c[role]), { code: '42501', message: /permission denied for function si_record_source_control/ });
    await rejects(assert, c[role].query(`INSERT INTO si.source_controls (source_id, control_seq, kind, reason) VALUES ('synthetic-fixture', 1, 'SUSPEND', 'x')`), { code: '42501' });
  }
  await rejects(assert, c.si_rights_admin.query(`INSERT INTO si.source_controls (source_id, control_seq, kind, reason) VALUES ('synthetic-fixture', 1, 'SUSPEND', 'x')`), { code: '42501' });
  for (const role of APP_ROLES) {
    await rejects(assert, c[role].query(`SELECT si.si_source_suspended_at('synthetic-fixture', now())`), { code: '42501' });
  }
  for (const role of ['si_rights_admin', 'si_retention', 'si_monitor']) {
    await rejects(assert, c[role].query(`SELECT si.si_source_suspended('synthetic-fixture')`), { code: '42501' });
  }
  assert.equal((await c.si_collector.query(`SELECT si.si_source_suspended('synthetic-fixture') AS s`)).rows[0].s, false);
  assert.equal((await c.admin.query(`SELECT has_function_privilege('si_rights_admin', $1, 'EXECUTE') AS h`, [CONTROL_SIG])).rows[0].h, true);
});

test('SD3 (Amendment C): the control function works with a hostile search_path and records session_user', async () => {
  await c.si_rights_admin.query(`SET search_path = "$user", public, pg_temp`);
  await c.admin.query(`SET ROLE si_owner; INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks) VALUES ('sd3-ctl', 'x', 'SYNTHETIC', '{META}'); RESET ROLE`);
  const r = await control(c.si_rights_admin, 'sd3-ctl', 'SUSPEND');
  assert.equal(r.control_seq, 1);
  await c.si_rights_admin.query('RESET search_path');
  assert.equal((await c.admin.query(`SELECT recorded_by FROM si.source_controls WHERE source_id = 'sd3-ctl'`)).rows[0].recorded_by, 'si_rights_admin');
});

test('SD5: functions created later in schema si start without PUBLIC EXECUTE (default privileges)', async () => {
  await c.admin.query('BEGIN');
  await c.admin.query('SET LOCAL ROLE si_owner');
  await c.admin.query(`CREATE FUNCTION si.t_default_priv() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
  const r = (await c.admin.query(`
    SELECT p.proacl IS NULL AS default_acl, EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_grant,
           has_function_privilege('si_collector', 'si.t_default_priv()', 'EXECUTE') AS collector
    FROM pg_proc p WHERE p.oid = 'si.t_default_priv()'::regprocedure`)).rows[0];
  await c.admin.query('ROLLBACK');
  assert.deepEqual(r, { default_acl: false, public_grant: false, collector: false });
});

test('SD7: trigger functions cannot be called directly', async () => {
  for (const fn of ['trg_append_only', 'trg_rights_insert', 'trg_rights_evidence_required', 'trg_sources_retire_final', 'trg_evidence_attribution',
                    'trg_source_controls_insert', 'trg_runs_insert']) {
    await rejects(assert, asOwner(c.admin, x => x.query(`SELECT si.${fn}()`)), { code: '0A000' });
  }
});

test('PostgreSQL behaviour: a deferred trigger fires at COMMIT as the session role without EXECUTE on the trigger function', async () => {
  const r = (await c.admin.query(`SELECT has_function_privilege('si_rights_admin', 'si.trg_rights_evidence_required()', 'EXECUTE') AS h`)).rows[0];
  assert.equal(r.h, false);
  // si_rights_admin's COMMIT runs the deferred evidence check (it raises without evidence: see rights test R2)
  // and succeeds with evidence, so firing does not require EXECUTE.
  await c.admin.query(`SET ROLE si_owner; INSERT INTO si.sources (source_id, display_name, evidence_kind, supported_networks) VALUES ('pg-behaviour', 'x', 'SYNTHETIC', '{META}'); RESET ROLE`);
  await c.si_rights_admin.query('BEGIN');
  await recordRights(c.si_rights_admin, 'pg-behaviour');
  await c.si_rights_admin.query('COMMIT');
});

test('IA-1 prerequisite: rights_versions has UNIQUE (rights_version_id, source_id) for the composite foreign keys of 0002', async () => {
  const r = (await c.admin.query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'si.rights_versions'::regclass AND contype = 'u'`)).rows.map(x => x.def).sort();
  assert.ok(r.includes('UNIQUE (rights_version_id, source_id)'), JSON.stringify(r));
  assert.ok(r.includes('UNIQUE (source_id, version)'), JSON.stringify(r));
});
