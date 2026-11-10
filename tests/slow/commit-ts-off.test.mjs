// M3-P3B VR-12: track_commit_timestamp = off (run by tests/slow/commit-ts-off.sh against a disposable server).
// A lookup would raise, and earlier timestamps are lost when tracking is turned off and on again, so the
// verifier must refuse to record anything rather than classify on missing data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asOwner, connect, createSources, freshDatabase, recordRights, rejects, roles } from '../db/helpers.mjs';
import { fixtureSha256, requestSha256 } from '../../dist/persistence/request-hash.js';
import { verifyReceipts, verificationStatus, verificationFailures, VerificationFailed } from '../../dist/persistence/verification.js';
import { checkOperationalPreconditions } from '../../dist/persistence/preconditions.js';
import { assertProductionReady } from '../../dist/persistence/production-readiness.js';

test('VR-12: with commit timestamps disabled the verifier records nothing and every gate fails closed',
  { skip: process.env.SI_EXPECT_COMMIT_TS_OFF !== '1' && 'needs tests/slow/commit-ts-off.sh' }, async t => {
  const db = await freshDatabase(t, 'tsoff');
  const x = await roles(t, db, ['admin', 'si_rights_admin', 'si_collector', 'si_monitor']);
  assert.equal((await x.admin.query('SHOW track_commit_timestamp')).rows[0].track_commit_timestamp, 'off');
  await createSources(x.admin, ['off-1']); await recordRights(x.si_rights_admin, 'off-1');
  const rows = [{ network: 'META', nativeAdId: 'off-a', advertiserName: 'Synthetic Co', countries: ['DE'], seenAt: '2026-01-01T00:00:00.000Z', sourceUrl: 'https://example.test/a' }];
  const fx = fixtureSha256(rows), sha = requestSha256({ adapterId: 'off-1', evidenceKind: 'SYNTHETIC', networks: ['META'], fixtureSha256: fx });
  const run = (await x.si_collector.query('SELECT * FROM si.si_begin_run_scoped($1,$2,$3,$4,$5::text[],$6)', ['off-1', 'off-k', sha, 'SYNTHETIC', ['META'], fx])).rows[0];
  await x.si_collector.query('BEGIN');
  await x.si_collector.query('SELECT * FROM si.si_complete_run($1::uuid, $2::uuid, $3::jsonb)', [run.run_id, run.lease_token, JSON.stringify(rows)]);
  await x.si_collector.query('COMMIT');
  await rejects(assert, x.si_monitor.query('SELECT * FROM si.si_verify_receipts(10)'), { code: '55000', message: /^SI_COMMIT_TS_DISABLED/ });
  await rejects(assert, asOwner(x.admin, a => a.query('INSERT INTO si.receipt_verifications (run_id) VALUES ($1)', [run.run_id])),
    { code: '55000', message: /^SI_COMMIT_TS_DISABLED/ });
  const err = await verifyReceipts(x.si_monitor, 10).catch(e => e);
  assert.ok(err instanceof VerificationFailed);
  assert.deepEqual([err.code, err.sqlstate, err.recorded], ['COMMIT_TS_DISABLED', '55000', true]);
  assert.equal((await x.admin.query('SELECT count(*)::int AS n FROM si.receipt_verifications')).rows[0].n, 0, 'nothing recorded');
  const st = await verificationStatus(x.si_monitor);
  assert.deepEqual([st.pending, st.valid, st.invalid, st.unverifiable, st.failures24h], [1, 0, 0, 0, 1]);
  assert.deepEqual((await verificationFailures(x.si_monitor, 5)).map(f => f.code), ['COMMIT_TS_DISABLED']);
  assert.equal((await x.admin.query('SELECT si.si_evidence_readable($1) AS r', [run.run_id])).rows[0].r, false);
  const pre = await checkOperationalPreconditions(x.admin);
  assert.deepEqual(pre.find(p => p.name === 'track_commit_timestamp'), { name: 'track_commit_timestamp', ok: false, actual: 'off', expected: 'on' });
  await assert.rejects(assertProductionReady(x.admin, { collector: x.si_collector }), /track_commit_timestamp=off/);
});
