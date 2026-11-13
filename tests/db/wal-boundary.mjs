// B-002 M3-R35: deterministic WAL layouts for the durability-gate tests (superuser fixtures, disposable clusters).
//
// pg_logical_emit_message(transactional, prefix, content) inserts one record and returns its END position, which is
// 8-byte aligned (MAXALIGN) and equals the page start when the record ends exactly on a page boundary. A
// non-transactional message is never flushed by the backend that wrote it (only by the WAL writer or a later flush);
// a transactional one is flushed, with everything inserted before it, by its transaction's synchronous commit.
// Every layout below is VERIFIED after it is built (insert, flush and end positions) and rebuilt if unrelated WAL
// (autovacuum, other backends) moved the insert position in between; a test never runs on an unverified layout.
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';

// The gate's function texts: before 0017 (0010 / 0011) and with 0017, for mutants and instrumented copies.
const mig = n => readFileSync(new URL(`../../db/migrations/${n}`, import.meta.url), 'utf8');
const cut = (t, a, b) => { const s = t.indexOf(a); return t.slice(s, t.indexOf(b, s) + b.length); };
export const OLD_READ = cut(mig('0010_read_durability.up.sql'), 'CREATE OR REPLACE FUNCTION si.si_read_evidence', 'END $read_evidence$;');
export const OLD_CLAIM = cut(mig('0011_reader_status.up.sql'), 'CREATE FUNCTION si.si_claim_read_intent', 'END $claim_read_intent$;')
  .replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
export const NEW_READ = cut(mig('0017_wal_boundary_gate.up.sql'), 'CREATE OR REPLACE FUNCTION si.si_read_evidence', 'END $read_evidence$;');
export const NEW_CLAIM = cut(mig('0017_wal_boundary_gate.up.sql'), 'CREATE OR REPLACE FUNCTION si.si_claim_read_intent', 'END $claim_read_intent$;');

export const BLK = 8192n;
export const SEG = 16777216n;
export const SHORT_PHD = 24n;                                                  // SizeOfXLogShortPHD (MAXALIGN 8)
export const LONG_PHD = 40n;                                                   // SizeOfXLogLongPHD (MAXALIGN 8)
export const lsn = s => { const [h, l] = s.split('/'); return (BigInt(`0x${h}`) << 32n) + BigInt(`0x${l}`); };
export const str = n => `${(n >> 32n).toString(16).toUpperCase()}/${(n & 0xffffffffn).toString(16).toUpperCase()}`;

/** Insert and flush positions now. */
export async function positions(admin) {
  const r = (await admin.query('SELECT pg_current_wal_insert_lsn()::text AS i, pg_current_wal_flush_lsn()::text AS f')).rows[0];
  return { insert: lsn(r.i), flush: lsn(r.f) };
}
/** One non-transactional (unflushed) message of `k` payload bytes; returns its end position. */
export async function stray(admin, k) {
  return lsn((await admin.query(`SELECT pg_logical_emit_message(false, 'si-r35', repeat('x', $1))::text AS e`, [Number(k)])).rows[0].e);
}
/** One transactional message of `k` payload bytes, committed synchronously; returns the insert position after it. */
async function committed(admin, k) {
  await admin.query('BEGIN');
  await admin.query(`SELECT pg_logical_emit_message(true, 'si-r35', repeat('x', $1))`, [Number(k)]);
  await admin.query('COMMIT');
  return (await positions(admin)).insert;
}
/** Waits until everything inserted up to `end` is flushed (by the WAL writer); throws after `ms`. */
export async function flushedTo(admin, end, ms = 15000) {
  const t0 = performance.now();
  for (;;) {
    const p = await positions(admin);
    if (p.flush >= end) return p;
    if (performance.now() - t0 > ms) throw new Error(`fixture: WAL not flushed to ${str(end)} within ${ms} ms (flush ${str(p.flush)})`);
    await sleep(10);
  }
}
const nextBoundary = (pos, unit) => ((pos / unit) + 1n) * unit;
const usable = (pos, unit) => nextBoundary(pos, unit) - pos;                    // bytes left before the next boundary

let strayOver = null, commitOver = null;
async function calibrate(admin) {
  // Record sizes of an empty message (unflushed) and of an empty transactional message plus its commit, measured
  // where nothing crosses a page (retry otherwise).
  for (let i = 0; i < 50 && (strayOver === null || commitOver === null); i++) {
    const a = (await positions(admin)).insert;
    if (usable(a, BLK) < 1024n) { await stray(admin, 2048); continue; }
    const e = await stray(admin, 0);
    const b = await committed(admin, 0);
    if (b - a < usable(a, BLK) && e - a > 0n && e - a < 256n && b - e < 512n && (e - a) % 8n === 0n && (b - e) % 8n === 0n) {
      strayOver = e - a; commitOver = b - e;
    }
  }
  if (strayOver === null) throw new Error('fixture: calibration failed');
  return { strayOver, commitOver };
}

/**
 * Builds a layout and verifies it. kind:
 *   'page'      the last record ends exactly on a page boundary that is not a segment start (insert = boundary + 24)
 *   'before'    the last record ends 8 bytes before a page boundary
 *   'cross'     the last record starts in one page and ends 64 bytes after the next page's header
 *   'segment'   the last record is an XLOG_SWITCH (insert = next segment start + 40, flush = segment start)
 * flushed: 'writer' (wait for the WAL writer), 'commit' (the boundary record is a synchronous commit: flushed at
 * once, also with a delayed WAL writer; 'page' only) or 'no' (unflushed stray WAL; with a delayed writer).
 * Returns { insert, flush, end } as verified.
 */
export async function layout(admin, kind, flushed = 'writer') {
  const { strayOver: so, commitOver: co } = await calibrate(admin);
  for (let attempt = 0; attempt < 60; attempt++) {
    if (kind === 'segment') {
      await admin.query('SELECT pg_switch_wal()');
      const p = await positions(admin);
      if (p.insert % SEG === LONG_PHD && p.flush === p.insert - LONG_PHD) return { ...p, end: p.flush };
      continue;
    }
    const at = (await positions(admin)).insert;
    if (at % SEG < BLK || nextBoundary(at, BLK) % SEG === 0n) { await stray(admin, 4096); continue; }   // stay off segment edges
    const need = usable(at, BLK) - (kind === 'before' ? 8n : 0n);
    const over = flushed === 'commit' ? so + co : so;
    if (need < over + 64n) { await stray(admin, 256); continue; }               // too close: move into the next page
    let end;
    if (flushed === 'commit') {
      if (kind !== 'page') throw new Error('fixture: commit layouts are page boundaries only');
      // Payload sizes and positions are multiples of 8, so a payload of (need - overhead) lands exactly on the target.
      const k = need - co;
      end = (await committed(admin, k)) === at + need + SHORT_PHD ? at + need : -1n;
    } else {
      const k = need - so + (kind === 'cross' ? 64n : 0n);                     // 'cross': 64 bytes past the header
      end = await stray(admin, k);
    }
    let p = await positions(admin);
    const want = { page: [at + need, at + need + SHORT_PHD], before: [at + need, at + need],
                   cross: [null, null] }[kind];
    if (kind === 'cross') {
      if (!(end > nextBoundary(at, BLK) + SHORT_PHD && p.insert === end && end % BLK > SHORT_PHD)) continue;
    } else if (!(end === want[0] && p.insert === want[1])) continue;
    const verified = p.insert;                                                 // the layout as built and checked
    if (flushed === 'writer') p = await flushedTo(admin, end);
    if (flushed === 'commit' && p.flush !== end) continue;
    if (flushed === 'no' && p.flush >= end) continue;
    const q = await positions(admin);
    if (q.insert !== verified) continue;                                       // unrelated WAL arrived meanwhile: rebuild
    return { ...q, end };
  }
  throw new Error(`fixture: could not build the '${kind}' layout`);
}
