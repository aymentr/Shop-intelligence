// B-002 M4-P3.1-TEST-CLOSE-01 (R-44): the emergency-control observation used by RT-13, verified on its own.
// A holder transaction keeps the source row locked FOR NO KEY UPDATE, exactly as si_purge_due does; a control is issued
// and observed. The legacy loop (RT-13 at e06b9da, copied verbatim below as a negative control) stopped on an idle
// control session, which is also the state of a session whose query has not been received yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, control, createSources, freshDatabase, pid, recordRights, roles } from './helpers.mjs';
import { PAUSE_SQL, inMarkedPause, observeCall, pauseMarker } from './barriers.mjs';

let n = 0;
async function setup(t) {
  const db = await freshDatabase(t, 'm4tb');
  const x = await roles(t, db, ['admin', 'si_rights_admin']);
  const extra = []; t.after(async () => { for (const e of extra) await e.end().catch(() => {}); });
  const conn = async user => { const k = await connect({ user, database: db }); extra.push(k); return k; };
  return { x, conn };
}
async function heldSource({ x, conn }) {
  const src = `tb-${++n}`; await createSources(x.admin, [src], ['META']); await recordRights(x.si_rights_admin, src, {});
  const holder = await conn(undefined), ra = await conn('si_rights_admin');
  const close = async () => { for (const c of [holder, ra]) { await c.end().catch(() => {}); } };
  await holder.query('BEGIN'); await holder.query('SELECT 1 FROM si.sources WHERE source_id = $1 FOR NO KEY UPDATE', [src]);
  return { src, holder, ra, close, holderPid: await pid(holder), raPid: await pid(ra) };
}
/** RT-13's barrier at e06b9da, verbatim (negative control only). */
async function legacyBlocked(admin, raPid, retPid) {
  let blocked = false;
  for (let i = 0; i < 400 && !blocked; i++) {
    blocked = (await admin.query('SELECT $2::int = ANY (pg_blocking_pids($1)) AS b', [raPid, retPid])).rows[0].b;
    if (!blocked) { const st = (await admin.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [raPid])).rows[0]; if (st?.state === 'idle') break; }
  }
  return blocked;
}
const delayed = (ms, f) => () => sleep(ms).then(f);           // a deliberately late query start

test('TB-1 (negative control): with a delayed query start the legacy RT-13 loop concludes "not blocked" although the source is held', async t => {
  const s = await setup(t), h = await heldSource(s);
  const ctl = delayed(50, () => control(h.ra, h.src, 'SUSPEND'))();
  assert.equal(await legacyBlocked(s.x.admin, h.raPid, h.holderPid), false, 'the race is real: idle-before-start was taken for completion');
  await h.holder.query('COMMIT'); await ctl;
});
test('TB-2: the observation reports not-started, then blocked, for the same delayed start', async t => {
  const s = await setup(t), h = await heldSource(s);
  const obs = await observeCall(s.x.admin, { waiterPid: h.raPid, holderPid: h.holderPid, call: delayed(50, () => control(h.ra, h.src, 'SUSPEND')) });
  assert.equal(obs.state, 'blocked');
  assert.equal(obs.trace[0], 'not-started');
  assert.equal(obs.trace.at(-1), 'blocked');
  await h.holder.query('COMMIT');
  assert.equal((await obs.result).status, 'ok', 'the control completes once the holder commits');
});
test('TB-3: 200 trials with random start delays (0-20 ms): always blocked; the legacy loop, run on the same trials, is reported', async t => {
  const s = await setup(t);
  let legacyMiss = 0; const states = {};
  for (let i = 0; i < 200; i++) {
    const h = await heldSource(s), d = Math.floor(Math.random() * 21);
    if (i % 2) {
      const obs = await observeCall(s.x.admin, { waiterPid: h.raPid, holderPid: h.holderPid, call: delayed(d, () => control(h.ra, h.src, 'SUSPEND')) });
      states[obs.state] = (states[obs.state] ?? 0) + 1;
      await h.holder.query('COMMIT'); assert.equal((await obs.result).status, 'ok'); await h.close();
    } else {
      const ctl = delayed(d, () => control(h.ra, h.src, 'SUSPEND'))();
      if (!(await legacyBlocked(s.x.admin, h.raPid, h.holderPid))) legacyMiss++;
      await h.holder.query('COMMIT'); await ctl; await h.close();
    }
  }
  console.log(`# TB-3: new observation ${JSON.stringify(states)} of 100; legacy loop concluded "not blocked" in ${legacyMiss} of 100 held trials`);
  assert.deepEqual(states, { blocked: 100 });
  assert.ok(legacyMiss > 0, 'the negative control still detects the legacy race under delayed starts');
});
test('TB-4: completed and failed are distinguished from blocked', async t => {
  const s = await setup(t);
  const src = `tb-${++n}`; await createSources(s.x.admin, [src], ['META']); await recordRights(s.x.si_rights_admin, src, {});
  const ra = await connect({ user: 'si_rights_admin', database: (await s.x.admin.query('SELECT current_database() AS d')).rows[0].d }); t.after(() => ra.end());
  const other = await connect({ database: (await s.x.admin.query('SELECT current_database() AS d')).rows[0].d }); t.after(() => other.end());
  const [raPid, otherPid] = [await pid(ra), await pid(other)];
  const done = await observeCall(s.x.admin, { waiterPid: raPid, holderPid: otherPid, call: delayed(20, () => control(ra, src, 'SUSPEND')) });
  assert.deepEqual([done.state, done.trace[0], done.trace.at(-1)], ['completed', 'not-started', 'completed']);
  const failed = await observeCall(s.x.admin, { waiterPid: raPid, holderPid: otherPid, call: () => control(ra, 'tb-no-such-source', 'SUSPEND') });
  assert.equal(failed.state, 'failed');
  assert.equal((await failed.result).code, '23503', 'the failure is reported with its SQLSTATE, not as completion');
});
test('TB-5: diagnostics are kept in full: a call held by an unexpected session fails the observation with both sessions and their locks', async t => {
  const s = await setup(t), h = await heldSource(s);
  const bystander = await connect({ database: (await s.x.admin.query('SELECT current_database() AS d')).rows[0].d }); t.after(() => bystander.end());
  await assert.rejects(observeCall(s.x.admin, { waiterPid: h.raPid, holderPid: await pid(bystander), call: () => control(h.ra, h.src, 'SUSPEND'), ms: 300 }),
    e => /neither blocked by \d+ nor settled/.test(e.message) && /"activity"/.test(e.message) && /"locks"/.test(e.message) && /blocked_by/.test(e.message));
  await h.holder.query('COMMIT');
});
test('TB-6 (R-43 marker scope): the pause marker is visible only inside the pause transaction, also in a function without a subtransaction', async t => {
  const s = await setup(t);
  const db = (await s.x.admin.query('SELECT current_database() AS d')).rows[0].d;
  // si_search_advertisers leaves its locked block by rolling back a subtransaction (SI_READ_RELEASE), which would revert
  // the marker in any case; this function has no such block, so only the transaction-local scope can revert it.
  await s.x.admin.query(`CREATE FUNCTION public.tb_pause() RETURNS text LANGUAGE plpgsql AS $f$ BEGIN\n${PAUSE_SQL}  RETURN current_setting('application_name'); END $f$`);
  const c = await connect({ database: db, app: 'tb-6' }); t.after(() => c.end());
  const p = pauseMarker();
  await c.query(`SELECT set_config('si.test_mark', $1, false), set_config('si.test_key', $2, false)`, [p.mark, p.key]);
  assert.equal((await c.query('SELECT public.tb_pause() AS a')).rows[0].a, p.mark, 'inside the pause the marker is the session name');
  assert.equal((await c.query(`SELECT current_setting('application_name') AS a`)).rows[0].a, 'tb-6', 'after the transaction the marker is gone');
  assert.equal(await inMarkedPause(s.x.admin, await pid(c), p.mark), false);
});
