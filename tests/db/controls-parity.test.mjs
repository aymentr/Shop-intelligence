// Amendment C C5.2: reference-model parity for the rights + control functions of 0001.
//
// A JavaScript model of si_source_suspended, si_retention_terminated, si_window_end,
// rights_valid_for_publish, si_retention_end and of the LIFT acceptance rules is compared
// with the database over >= 64 generated histories (deterministic seed). Histories
// interleave rights versions and control events and always respect SI_EFFECTIVE_FROM_ORDER;
// a NEG step attempts an out-of-order version and asserts rejection with no change. LIFT
// attempts include stale views and wrong acknowledgements; the model predicts the exact
// outcome. Histories with no control events are additionally compared with the pre-
// Amendment-C function bodies (copied verbatim into pg_temp), which proves unchanged
// behaviour for them.
//
// All timestamps are integers in microseconds since the epoch (BigInt), exchanged with the
// database without loss. Every version is scheduled at least one hour ahead (or is the
// immediate first version), so sample instants never depend on how long the test runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { control, createSources, expectOrderRejection, freshDatabase, recordRights, roles } from './helpers.mjs';

const HISTORIES = 64;
const SEED = 0x5349_0c05;
const MARGIN = 60_000_000n;
const SEC = 1_000_000n;

let db, c;
const cleanups = [];
const fileScope = { after: fn => cleanups.push(fn) };
test.before(async () => {
  db = await freshDatabase(fileScope, 'parity');
  c = await roles(fileScope, db, ['admin', 'si_rights_admin', 'si_collector']);
});
test.after(async () => { for (const fn of cleanups.reverse()) await fn(); });

// --- deterministic PRNG (mulberry32) ---
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

// --- micro-second exchange ---
const TS = p => `(timestamptz 'epoch' + (${p}::bigint / 1000000) * interval '1 second' + (${p}::bigint % 1000000) * interval '1 microsecond')`;
const US = x => `CASE WHEN ${x} IS NULL THEN NULL WHEN ${x} = 'infinity'::timestamptz THEN 'inf' ELSE (extract(epoch FROM ${x}) * 1000000)::bigint::text END`;
const toUs = s => s === null ? null : s === 'inf' ? Infinity : BigInt(s);
const lit = us => `'${us}'`;                               // bigint literal for TS()

// --- model ---
const INF = Infinity;
const minT = (...xs) => xs.reduce((m, x) => (x === INF || x === null) ? m : (m === INF || x < m ? x : m), INF);
function modelSuspended(h) { const last = h.controls.at(-1); return !!last && last.kind !== 'LIFT'; }
function modelTerminated(h, n) { return h.controls.some(e => e.kind === 'TERMINATE_RETENTION' && e.through >= n); }
function modelWindowEnd(h, n) {
  const v = h.versions[n - 1], next = h.versions[n];
  const term = minT(...h.controls.filter(e => e.kind === 'TERMINATE_RETENTION' && e.through >= n).map(e => e.occ));
  return minT(v.exp ?? INF, next ? next.eff : INF, term);
}
function modelValid(h, n, p) {
  const v = h.versions[n - 1];
  const we = modelWindowEnd(h, n);
  return v.eff <= p && (we === INF || p + MARGIN < we) && v.evaluation === 'ALLOWED' && v.retain === 'ALLOWED'
    && !modelSuspended(h) && !modelTerminated(h, n);
}
function modelRetentionEnd(h, k) {
  const ev = [];
  for (const v of h.versions) {
    if (v.retain !== 'ALLOWED') ev.push({ x: v.eff, n: v.n, k: v.n - 1 });
    if (v.retain === 'ALLOWED' && v.exp !== null) ev.push({ x: v.exp, n: v.n, k: v.n });
  }
  const b = ev.filter(e => e.k >= k && !h.versions.some(m => m.n > e.n && m.eff <= e.x)).map(e => e.x);
  const t = h.controls.filter(e => e.kind === 'TERMINATE_RETENTION' && e.through >= k).map(e => e.occ);
  const m = minT(...b, ...t);
  return m === INF ? null : m;
}
// LIFT outcome, in the trigger's order of checks (no retired sources in this test).
function modelLift(h, att, nowUs) {
  const maxV = h.versions.length, lastSeq = h.controls.length;
  if (att.emv !== maxV || att.ecs !== lastSeq) return 'SI_STALE_VIEW';
  const last = h.controls.at(-1);
  if (!last || last.kind === 'LIFT') return 'SI_NOT_SUSPENDED';
  const lastLift = Math.max(0, ...h.controls.filter(e => e.kind === 'LIFT').map(e => e.seq));
  const term = h.controls.filter(e => e.kind === 'TERMINATE_RETENTION' && e.seq > lastLift).at(-1);
  if (!term) return (att.ack !== null || att.auth !== null) ? 'SI_BAD_ARGUMENT' : 'ok';
  if (att.ack !== term.seq) return 'SI_TERMINATION_ACK_REQUIRED';
  const av = att.auth === null ? null : h.versions[att.auth - 1];
  if (!av || att.auth !== maxV || att.auth <= term.through || av.evaluation !== 'ALLOWED' || av.retain !== 'ALLOWED'
      || (av.exp !== null && av.exp <= nowUs)) return 'SI_AUTHORIZATION_REQUIRED';
  return 'ok';
}

// --- pre-Amendment-C oracle: the M1 bodies at commit 1d897a0, verbatim, in pg_temp ---
const PRE_C = [
  `CREATE FUNCTION pg_temp.pre_window_end(p_version bigint) RETURNS timestamptz LANGUAGE sql STABLE AS $$
     SELECT least(coalesce(v.expires_at, 'infinity'::timestamptz),
                  coalesce((SELECT n.effective_from FROM si.rights_versions n WHERE n.source_id = v.source_id AND n.version = v.version + 1),
                           'infinity'::timestamptz))
     FROM si.rights_versions v WHERE v.rights_version_id = p_version $$`,
  `CREATE FUNCTION pg_temp.pre_valid(p_version bigint, p_at timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
     SELECT coalesce((SELECT v.effective_from <= p_at AND p_at + si.si_publish_margin() < pg_temp.pre_window_end(v.rights_version_id)
                        AND v.evaluation = 'ALLOWED' AND v.retain = 'ALLOWED' AND (s.retired_at IS NULL OR p_at < s.retired_at)
                      FROM si.rights_versions v JOIN si.sources s ON s.source_id = v.source_id WHERE v.rights_version_id = p_version), false) $$`,
  `CREATE FUNCTION pg_temp.pre_retention_end(p_source_id text, p_collected_version int) RETURNS timestamptz LANGUAGE sql STABLE AS $$
     SELECT min(e.x) FROM (
         SELECT v.effective_from AS x, v.version AS n, v.version - 1 AS k FROM si.rights_versions v WHERE v.source_id = p_source_id AND v.retain <> 'ALLOWED'
       UNION ALL
         SELECT v.expires_at, v.version, v.version FROM si.rights_versions v WHERE v.source_id = p_source_id AND v.retain = 'ALLOWED' AND v.expires_at IS NOT NULL
     ) e WHERE e.k >= p_collected_version
       AND NOT EXISTS (SELECT 1 FROM si.rights_versions m WHERE m.source_id = p_source_id AND m.version > e.n AND m.effective_from <= e.x) $$`
];

test('C5.2 parity: generated ordered histories with controls agree with the reference model; control-free histories equal pre-C SQL', async () => {
  for (const sql of PRE_C) await c.admin.query(sql);                 // superuser session; pg_temp only, nothing persists
  const r = rng(SEED);
  const ra = c.si_rights_admin;
  const base = toUs((await c.admin.query(`SELECT ${US(`date_trunc('second', clock_timestamp()) + interval '1 hour'`)} AS b`)).rows[0].b);
  const ids = Array.from({ length: HISTORIES }, (_, i) => `par-${i}`);
  await createSources(c.admin, ids);
  const stats = { versions: 0, neg: 0, controls: 0, lifts: {}, recoveries: 0, checks: 0, controlFree: 0 };

  for (const [hi, src] of ids.entries()) {
    const h = { versions: [], controls: [] };
    const controlFree = hi % 4 === 0;                                // every fourth history has no control events
    const steps = 4 + Math.floor(r() * 7);
    for (let s = 0; s < steps; s++) {
      const op = controlFree ? pick(r, ['version', 'version', 'version', 'neg'])
                             : pick(r, ['version', 'version', 'version', 'neg', 'SUSPEND', 'SUSPEND', 'TERMINATE_RETENTION', 'LIFT', 'LIFT', 'LIFT']);
      if (op === 'version') {
        const last = h.versions.at(-1);
        const evaluation = r() < 0.75 ? 'ALLOWED' : pick(r, ['DENIED', 'UNKNOWN']);
        const retain = r() < 0.7 ? 'ALLOWED' : pick(r, ['DENIED', 'UNKNOWN']);
        const immediate = !last && r() < 0.3;
        const from = last ? (last.eff > base ? last.eff : base) : base;
        const eff = immediate ? null : from + pick(r, [0n, 1n, 10n, 120n, 3600n]) * SEC;
        const expD = immediate ? null : pick(r, [null, null, 30n, 61n, 3600n]);
        const row = await recordRights(ra, src, {
          evaluation, retain, retention_days: retain === 'ALLOWED' ? 30 : null,
          effective_from_sql: eff === null ? 'NULL' : TS(lit(eff)),
          expires_at_sql: expD === null ? 'NULL' : TS(lit(eff + expD * SEC)) });
        const effUs = toUs((await c.admin.query(`SELECT ${US('effective_from')} AS e FROM si.rights_versions WHERE rights_version_id = $1`, [row.rights_version_id])).rows[0].e);
        h.versions.push({ n: row.version, id: row.rights_version_id, eff: effUs, exp: expD === null ? null : eff + expD * SEC, evaluation, retain });
        assert.equal(row.version, h.versions.length);
        stats.versions++;
      } else if (op === 'neg') {
        const last = h.versions.at(-1);
        if (!last || last.eff < base) continue;                       // needs a pending version to violate against
        await expectOrderRejection(assert, ra, src, r() < 0.5 ? {} : { effective_from_sql: TS(lit(last.eff - SEC)) });
        stats.neg++;
      } else if (op === 'LIFT') {
        const maxV = h.versions.length, lastSeq = h.controls.length;
        const lastLift = Math.max(0, ...h.controls.filter(e => e.kind === 'LIFT').map(e => e.seq));
        const term = h.controls.filter(e => e.kind === 'TERMINATE_RETENTION' && e.seq > lastLift).at(-1);
        const variant = pick(r, ['correct', 'correct', 'correct', 'stale-seq', 'stale-version', 'wrong-ack', 'no-ack']);
        const att = { emv: maxV, ecs: lastSeq, ack: term ? term.seq : null, auth: term ? maxV : null };
        if (variant === 'stale-seq') att.ecs = lastSeq + 1;
        if (variant === 'stale-version') att.emv = maxV + 1;
        if (variant === 'wrong-ack') att.ack = (term ? term.seq : 0) + 7;
        if (variant === 'no-ack') { att.ack = null; att.auth = null; }
        const nowUs = toUs((await c.admin.query(`SELECT ${US('clock_timestamp()')} AS n`)).rows[0].n);
        const want = modelLift(h, att, nowUs);
        let got = 'ok', row;
        try {
          row = await control(ra, src, 'LIFT', { expectedMaxVersion: att.emv, expectedControlSeq: att.ecs, ackTerminationSeq: att.ack, authorizationVersion: att.auth });
        } catch (e) { got = (e.message.match(/^(SI_[A-Z_]+)/) ?? [e.message])[1]; }
        assert.equal(got, want, `${src} LIFT ${variant} ${JSON.stringify(att)}`);
        stats.lifts[`${variant}:${got}`] = (stats.lifts[`${variant}:${got}`] ?? 0) + 1;
        if (got === 'ok' && att.ack !== null) stats.recoveries++;
        if (got === 'ok') h.controls.push({ seq: row.control_seq, kind: 'LIFT', occ: toUs((await c.admin.query(`SELECT ${US('occurred_at')} AS o FROM si.source_controls WHERE control_event_id = $1`, [row.control_event_id])).rows[0].o) });
      } else {
        const row = await control(ra, src, op);
        const occUs = toUs((await c.admin.query(`SELECT ${US('occurred_at')} AS o FROM si.source_controls WHERE control_event_id = $1`, [row.control_event_id])).rows[0].o);
        const through = op === 'TERMINATE_RETENTION' ? h.versions.length : null;
        assert.equal(row.through_version, through, `${src} through_version`);
        h.controls.push({ seq: row.control_seq, kind: op, through, occ: occUs });
        assert.equal(row.control_seq, h.controls.length);
        stats.controls++;
      }

      // --- compare after every step ---
      assert.equal((await c.si_collector.query('SELECT si.si_source_suspended($1) AS s', [src])).rows[0].s, modelSuspended(h), `${src} suspended`);
      for (const v of h.versions) {
        const we = modelWindowEnd(h, v.n);
        const samples = [v.eff - 1n, v.eff, v.eff + SEC, base + 10n * 86400n * SEC];
        if (we !== INF) samples.push(we - MARGIN - 1n, we - MARGIN, we);
        const got = (await c.si_collector.query(
          `SELECT array_agg(si.rights_valid_for_publish($1, ${TS('p')}) ORDER BY o) AS got
           FROM unnest($2::bigint[]) WITH ORDINALITY AS u(p, o)`, [v.id, samples.map(String)])).rows[0].got;
        assert.deepEqual(got, samples.map(p => modelValid(h, v.n, p)), `${src} v${v.n} validity at ${samples}`);
        const w = (await c.admin.query(`SELECT ${US('si.si_window_end($1)')} AS w`, [v.id])).rows[0].w;
        assert.equal(toUs(w), we, `${src} v${v.n} window end`);
        assert.equal((await c.si_collector.query('SELECT si.si_retention_terminated($1, $2) AS t', [src, v.n])).rows[0].t, modelTerminated(h, v.n));
        if (controlFree) {
          const pre = (await c.admin.query(
            `SELECT array_agg(pg_temp.pre_valid($1, ${TS('p')}) ORDER BY o) AS got FROM unnest($2::bigint[]) WITH ORDINALITY AS u(p, o)`,
            [v.id, samples.map(String)])).rows[0].got;
          assert.deepEqual(got, pre, `${src} v${v.n}: control-free validity equals the pre-C function`);
          const pw = (await c.admin.query(`SELECT ${US('pg_temp.pre_window_end($1)')} AS w`, [v.id])).rows[0].w;
          assert.equal(w, pw, `${src} v${v.n}: window end equals pre-C`);
        }
        stats.checks += samples.length;
      }
      for (let k = 1; k <= h.versions.length + 1; k++) {
        const e = (await c.admin.query(`SELECT ${US('si.si_retention_end($1, $2)')} AS e`, [src, k])).rows[0].e;
        assert.equal(toUs(e), modelRetentionEnd(h, k), `${src} retention end k=${k}`);
        if (controlFree) {
          const pe = (await c.admin.query(`SELECT ${US('pg_temp.pre_retention_end($1, $2)')} AS e`, [src, k])).rows[0].e;
          assert.equal(e, pe, `${src} k=${k}: retention end equals pre-C`);
        }
      }
    }
    if (controlFree) stats.controlFree++;
  }
  // Coverage: the generator must actually have exercised every interesting outcome.
  assert.ok(stats.versions >= 150 && stats.controls >= 40 && stats.neg >= 20 && stats.recoveries >= 1 && stats.controlFree === HISTORIES / 4, JSON.stringify(stats));
  for (const outcome of ['ok', 'SI_STALE_VIEW', 'SI_NOT_SUSPENDED', 'SI_TERMINATION_ACK_REQUIRED', 'SI_AUTHORIZATION_REQUIRED']) {
    assert.ok(Object.keys(stats.lifts).some(k => k.endsWith(`:${outcome}`)), `LIFT outcome ${outcome} not exercised: ${JSON.stringify(stats.lifts)}`);
  }
  console.log(`# parity stats ${JSON.stringify(stats)}`);
});
