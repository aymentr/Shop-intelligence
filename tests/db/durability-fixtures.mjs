// Shared fixtures for the durability tests (tests/crash/*.test.mjs: M3-AUD-03 and M4-P1 INT-19). Not a test file.
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
/**
 * Fixture (superuser): set (`'10s'`) or restore (`null`) the WAL writer interval, and return only once the requested
 * environment is VERIFIED, never after a fixed sleep (M4-P1.1, D2):
 *   1. a new backend reports the requested wal_writer_delay (the postmaster processed the reload);
 *   2. the WAL writer itself runs with it, measured with stray WAL — a non-transactional logical message, which is
 *      written but never flushed by the backend that wrote it (like the pruning records the 0010 gate trips on):
 *        - restore: three consecutive stray records are each flushed within 600 ms (the gate waits 1 s; the default
 *          200 ms writer flushes them in about 200 ms, a 10 s writer in about 10 s);
 *        - widen: a stray record stays unflushed for at least 500 ms (an unrelated flush can end one probe early,
 *          so up to ten probes are tried).
 * Throws if the condition is not reached within 30 s, so the next test never starts in an unknown environment.
 * The probe measures the effect the fixture exists for; it does not change the read path or the gate.
 */
export async function writerDelay(value) {
  const k = await connect();
  try {
    await k.query(value ? `ALTER SYSTEM SET wal_writer_delay = '${value}'` : 'ALTER SYSTEM RESET wal_writer_delay');
    await k.query('SELECT pg_reload_conf()');
    const target = value ? parseDelayMs(value) : Number((await k.query(`SELECT boot_val FROM pg_settings WHERE name = 'wal_writer_delay'`)).rows[0].boot_val);
    const deadline = performance.now() + 30000;
    for (;;) {                                                                          // 1. the reload reached new backends
      const s = await connect();
      let ms;
      try { ms = Number((await s.query(`SELECT setting FROM pg_settings WHERE name = 'wal_writer_delay'`)).rows[0].setting); } finally { await s.end(); }
      if (ms === target) break;
      if (performance.now() > deadline) throw new Error(`writer fixture: wal_writer_delay is ${ms} ms, expected ${target} ms`);
      await sleep(20);
    }
    if (value) {                                                                        // 2a. the long interval is in force
      for (let i = 0; ; i++) {
        const ms = await strayWalFlushMs(k, 500);
        if (ms >= 500) break;
        if (i >= 9 || performance.now() > deadline) throw new Error(`writer fixture: the ${value} interval is not in force (stray WAL flushed in ${ms.toFixed(0)} ms)`);
      }
    } else {                                                                            // 2b. the default writer is back
      let consecutive = 0;
      while (consecutive < 3) {
        const ms = await strayWalFlushMs(k, 1500);
        consecutive = ms <= 600 ? consecutive + 1 : 0;
        if (consecutive < 3 && performance.now() > deadline) throw new Error(`writer fixture: the default WAL writer is not back (stray WAL flushed in ${ms.toFixed(0)} ms)`);
      }
    }
  } finally { await k.end(); }
}
/**
 * Fixture (M4-P1.1, D2): one gated library read on a freshly cloned database before a timing or single-attempt
 * assertion. Measured cause: the FIRST gated request on a new database touches catalog and table pages for the first
 * time; that on-access pruning inserts WAL (Heap2 PRUNE) before the gate captures its target, and nothing flushes it
 * while the idle WAL writer hibernates (25 x wal_writer_delay), so the first request fails closed (NOT_DURABLE) and the
 * library retries it with a fresh intent (about 1 s). Observed on 25 of 25 fresh databases without this warm-up and
 * on 0 of 1500 reads after it. Returns the number of intents the warm-up needed (1 = no refusal).
 */
export async function warm(x, src) {
  const k = await x.c('si_reader_alice');
  const n = async () => (await x.admin.query('SELECT count(*)::int AS n FROM si.read_intents')).rows[0].n;
  const before = await n();
  const { readEvidence } = await import('../../dist/persistence/reader.js');
  await readEvidence(k, src, { limit: 1 });
  return (await n()) - before;
}
const parseDelayMs = v => { const m = /^(\d+)(ms|s)$/.exec(v); if (!m) throw new Error(`writer fixture: unsupported value ${v}`); return Number(m[1]) * (m[2] === 's' ? 1000 : 1); };
/** How long a stray WAL record stays unflushed (ms), observed up to `capMs` (returns `capMs` or more if still unflushed). */
export async function strayWalFlushMs(k, capMs) {
  const lsn = (await k.query(`SELECT pg_logical_emit_message(false, 'si-writer-fixture-probe', '') AS l`)).rows[0].l;
  const t0 = performance.now();
  for (;;) {
    if ((await k.query('SELECT pg_current_wal_flush_lsn() >= $1::pg_lsn AS ok', [lsn])).rows[0].ok) return performance.now() - t0;
    if (performance.now() - t0 >= capMs) return performance.now() - t0;
    await sleep(5);
  }
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
