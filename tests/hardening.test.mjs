// Regression tests for defects found while reviewing the B-001 prototype.
// 14 of these 17 fail against the prototype as provided. The other 3 (clock
// injection, offset normalization, unparseable clock) pin behavior that the
// original got right only by coincidence of string comparison on Z-suffixed
// inputs or the host clock, and guard against regressions in the new code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureAdapter, ingestOffline, mayUse, validateRights, parseAd, parseInstant, diagnostics } from '../dist/index.js';

const right = { sourceId: 'synthetic', basis: 'author-created synthetic data', evaluation: 'ALLOWED', retain: 'UNKNOWN', subscriber_display: 'DENIED', media_mirror: 'DENIED', export: 'DENIED' };
const row = { network: 'META', nativeAdId: 'test1', advertiserName: 'Demo', countries: ['DE'], seenAt: '2026-10-18T00:00:00Z', sourceUrl: 'https://example.org/ad/1' };
const fixedClock = () => '2026-10-19T12:00:00.000Z';
const run = (rows, opts = { now: fixedClock }) => ingestOffline(new FixtureAdapter('synthetic', ['META'], rows), right, 'run-1', '2026-10-19T00:00:00Z', opts);

// --- rights expiry: previously compared as strings and failed open ---
test('unparseable expiresAt denies instead of never expiring', () => {
  assert.equal(mayUse({ ...right, expiresAt: 'never' }, 'evaluation', '2026-10-19T00:00:00Z'), false);
  assert.throws(() => validateRights({ ...right, expiresAt: 'never' }), /expiresAt/);
});
test('expiresAt with offset is compared as an instant', () => {
  // 01:00+02:00 on the 19th is 23:00Z on the 18th, which is before "now".
  assert.equal(mayUse({ ...right, expiresAt: '2026-10-19T01:00:00+02:00' }, 'evaluation', '2026-10-18T23:30:00Z'), false);
  assert.equal(mayUse({ ...right, expiresAt: '2026-10-19T03:00:00+02:00' }, 'evaluation', '2026-10-18T23:30:00Z'), true);
});
test('unparseable clock denies', () => {
  assert.equal(mayUse({ ...right, expiresAt: '2030-01-01T00:00:00Z' }, 'evaluation', 'garbage'), false);
});
test('ingestion uses the injected clock for rights expiry', async () => {
  const r = { ...right, expiresAt: '2026-10-19T06:00:00Z' };
  await assert.rejects(() => ingestOffline(new FixtureAdapter('synthetic', ['META'], [row]), r, 'r', '2026-10-19T00:00:00Z', { now: fixedClock }), /RIGHTS_BLOCKED/);
});

// --- timestamps: previously host-timezone dependent and calendar-lenient ---
test('timestamps without an explicit offset are rejected', () => {
  assert.throws(() => parseAd({ ...row, seenAt: '2026-10-18T12:00:00' }), /Invalid timestamp seenAt/);
});
test('impossible calendar dates are rejected, not rolled over', () => {
  assert.throws(() => parseAd({ ...row, seenAt: '2026-02-30T00:00:00Z' }), /Invalid timestamp/);
  assert.throws(() => parseAd({ ...row, seenAt: '2026-10-18T24:00:00Z' }), /Invalid timestamp/);
  assert.equal(parseInstant('2028-02-29T00:00:00Z')?.toISOString(), '2028-02-29T00:00:00.000Z');
});
test('offset timestamps normalize to UTC', () => {
  assert.equal(parseAd({ ...row, seenAt: '2026-10-18T14:00:00+02:00' }).seenAt, '2026-10-18T12:00:00.000Z');
});
test('source-reported first seen after last seen is rejected', () => {
  assert.throws(() => parseAd({ ...row, sourceReportedFirstSeen: '2026-10-10T00:00:00Z', sourceReportedLastSeen: '2026-01-01T00:00:00Z' }), /after/);
});

// --- identity ---
test('nativeAdId rejects control characters and excessive length', () => {
  assert.throws(() => parseAd({ ...row, nativeAdId: 'a1\n[forged log line]' }), /Invalid nativeAdId/);
  assert.throws(() => parseAd({ ...row, nativeAdId: 'x'.repeat(257) }), /Invalid nativeAdId/);
  assert.equal(parseAd({ ...row, nativeAdId: 'x'.repeat(256) }).nativeAdId.length, 256);
});
test('country order does not affect normalized record', () => {
  assert.deepEqual(parseAd({ ...row, countries: ['US', 'DE', 'US'] }).countries, ['DE', 'US']);
});

// --- run tracking and provenance ---
test('completed and failed runs record finishedAt; startedAt is canonical', async () => {
  const ok = await run([row]);
  assert.equal(ok.run.finishedAt, '2026-10-19T12:00:00.000Z');
  assert.equal(ok.run.startedAt, '2026-10-19T00:00:00.000Z');
  const bad = await run([{ ...row, countries: ['Germany'] }]);
  assert.equal(bad.run.status, 'FAILED');
  assert.equal(bad.run.finishedAt, '2026-10-19T12:00:00.000Z');
});
test('invalid startedAt is rejected before a run starts', async () => {
  await assert.rejects(() => ingestOffline(new FixtureAdapter('synthetic', ['META'], [row]), right, 'r', 'not-a-date'), /startedAt/);
});
test('normalized records carry runId for provenance', async () => {
  const r = await run([row]);
  assert.equal(r.ads[0].runId, 'run-1');
  assert.equal(r.ads[0].sourceId, 'synthetic');
});
test('adapter returning a non-array fails the run instead of completing empty', async () => {
  const adapter = { id: 'synthetic', supportedNetworks: ['META'], evidenceKind: 'SYNTHETIC', async readOffline() { return {}; } };
  const r = await ingestOffline(adapter, right, 'r', '2026-10-19T00:00:00Z');
  assert.equal(r.run.status, 'FAILED');
  assert.equal(r.run.received, 0);
  assert.equal(r.ads.length, 0);
});
test('non-object rows fail the run', async () => {
  const r = await run([row, null]);
  assert.equal(r.run.status, 'FAILED');
  assert.match(r.run.errors[0], /row 1: Row is not an object/);
});
test('adapter without a supported evidence kind is refused', async () => {
  const adapter = { id: 'synthetic', supportedNetworks: ['META'], evidenceKind: 'LICENSED', async readOffline() { return [row]; } };
  await assert.rejects(() => ingestOffline(adapter, right, 'r', '2026-10-19T00:00:00Z'), /evidence kind/);
});

// --- dedup: conflicting duplicates were previously dropped silently ---
test('conflicting duplicates are counted; re-observation is not a conflict', async () => {
  const r = await run([row, { ...row, seenAt: '2026-10-18T05:00:00Z' }, { ...row, advertiserName: 'Someone Else' }]);
  assert.equal(r.run.status, 'COMPLETED');
  assert.equal(r.run.unique, 1);
  assert.equal(r.run.duplicate, 2);
  assert.equal(r.run.conflicts, 1);
  assert.equal(diagnostics(r).conflictingDuplicates, 1);
  assert.equal(r.ads[0].advertiserName, 'Demo', 'first record is kept');
});
