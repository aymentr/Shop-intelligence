// Shared fixtures for the M3-AUD-03 durability tests (tests/db/m3-durability.test.mjs and
// tests/crash/m3-durability-crash.test.mjs). Not a test file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { cfg, connect, createSources, freshDatabase, pid, recordRights, settle } from './helpers.mjs';
import { provisionReaderPrincipal } from '../../dist/persistence/bootstrap.js';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { grantReader } from '../../dist/persistence/reader.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const MIG10 = readFileSync(new URL('../../db/migrations/0010_read_durability.up.sql', import.meta.url), 'utf8');
let n = 0;

export async function provisionReaders() {
  const a = await connect();
  try { for (const p of ['si_reader_alice', 'si_reader_bob']) await provisionReaderPrincipal(a, p, cfg.rolePassword); } finally { await a.end(); }
}
// Connections are opened here (not through roles()) because a crash drops them all.
export async function fresh(t, prefix = 'm3dur') {
  const db = await freshDatabase(t, prefix);
  const open = [];
  const c = async (user = cfg.adminUser) => { const k = await connect({ user, database: db }); open.push(k); return k; };
  t.after(async () => { for (const k of open) await k.end().catch(() => {}); });
  const x = { db, c, admin: await c(), ra: await c('si_rights_admin'), col: await c('si_collector'), mon: await c('si_monitor') };
  await x.admin.query('CREATE TABLE public.flushme (x int)');                 // fixture: a synchronous write commit flushes WAL
  return x;
}
const ROW = id => ({ network: 'META', nativeAdId: id, advertiserName: 'Synthetic Co', countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z',
  sourceUrl: 'https://example.test/a', destinationUrl: 'https://example.test/d', creativeUrl: 'https://example.test/c', title: 'Synthetic' });
export async function ready(x, k = 2) {
  const src = `du-${++n}`;
  await createSources(x.admin, [src], ['META']);
  await recordRights(x.ra, src, {});
  const rs = Array.from({ length: k }, (_, i) => ROW(`du${n}-${i}`));
  const fx = fixtureSha256(rs), sha = requestSha256({ adapterId: src, evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  const run = (await x.col.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', [src, `dk${++n}`, sha, 'SYNTHETIC', ['META'], fx])).rows[0];
  await x.col.query('BEGIN');
  await x.col.query('SELECT * FROM si.si_complete_run($1::uuid,$2::uuid,$3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rs)]);
  await x.col.query('COMMIT');
  await x.mon.query('SELECT * FROM si.si_verify_receipts(100)');
  await grantReader(x.ra, 'si_reader_alice', src, 'durability test');
  return { src, run };
}
export const READ = 'SELECT * FROM si.si_read_evidence($1, $2, $3, $4)';
export const intent = async (c, src, cur = null, lim = 100) => (await c.query('SELECT si.si_begin_read($1, $2, $3) AS id', [src, cur, lim])).rows[0].id;
/** An intent committed ASYNCHRONOUSLY: the bypass of S13 (SET LOCAL after si_begin_read, inside the caller's transaction). */
export async function asyncIntent(c, src) {
  await c.query('BEGIN');
  const id = await intent(c, src);
  await c.query('SET LOCAL synchronous_commit = off');
  await c.query('COMMIT');
  return id;
}
export const outcome = r => r.status === 'ok' ? `ok:${r.value.rows.length}` : (String(r.message).match(/^SI_[A-Z_]+/)?.[0] ?? r.code);
export async function serverUp() {
  for (let i = 0; i < 150; i++) { try { const k = await connect(); await k.query('SELECT 1'); await k.end(); return; } catch { await sleep(200); } }
  throw new Error('the server did not come back after crash recovery');
}
export async function crash(backendPid) {                                             // fixture: SIGKILL -> crash recovery
  execFileSync('docker', ['compose', 'exec', '-T', 'db', 'kill', '-9', String(backendPid)], { cwd: REPO });
  await sleep(300);
  await serverUp();
}
export async function writerDelay(value) {                                            // fixture (superuser)
  const k = await connect();
  try { await k.query(value ? `ALTER SYSTEM SET wal_writer_delay = '${value}'` : 'ALTER SYSTEM RESET wal_writer_delay'); await k.query('SELECT pg_reload_conf()'); }
  finally { await k.end(); }
  await sleep(300);
}
export const intentExists = async (db, id) => { const k = await connect({ database: db }); try { return (await k.query('SELECT 1 FROM si.read_intents WHERE intent_id = $1', [id])).rowCount === 1; } finally { await k.end(); } };

/**
 * One adversarial attempt: an asynchronously committed intent, read inside an explicit transaction (so the read's
 * own commit never flushes anything), the reader's backend killed while it holds the rows, then recovery.
 * Returns whether rows were released and whether the intent survived.
 */
export async function releaseThenCrash(x, src, { pauseRead = null } = {}) {
  const a = await connect({ user: 'si_reader_alice', database: x.db }), r = await connect({ user: 'si_reader_alice', database: x.db });
  const id = await asyncIntent(a, src);
  const rp = await pid(r);
  if (pauseRead) await r.query(`SET si.test_pause = '${pauseRead}'`);
  await r.query('BEGIN');
  const got = await settle(r.query(READ, [src, id, null, 100]));
  await crash(rp);
  await a.end().catch(() => {}); await r.end().catch(() => {});
  const released = got.status === 'ok' && got.value.rows.length > 0;
  return { released, survived: await intentExists(x.db, id), outcome: outcome(got) };
}

export function fnText(mig, startMarker, endMarker) {
  const s = mig.indexOf(startMarker);
  return mig.slice(s, mig.indexOf(endMarker, s) + endMarker.length);
}
export function mutate(text, from, to) {
  assert.equal(text.split(from).length, 2, `exactly one anchor: ${from.slice(0, 60)}`);
  return text.replace(from, to);
}
export const READ_FN = fnText(MIG10, 'CREATE OR REPLACE FUNCTION si.si_read_evidence', 'END $read_evidence$;');
export const WAIT = `  WHILE pg_current_wal_flush_lsn() < target LOOP`;
export const PAUSE_AT = `  BEGIN\n    xid_of_intent :=`;
export const withPause = fn => mutate(fn, PAUSE_AT, `  PERFORM pg_sleep(coalesce(nullif(current_setting('si.test_pause', true), ''), '0')::float8);\n${PAUSE_AT}`);
