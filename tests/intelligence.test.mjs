// M4-P1: intelligence library contract without a database (pure functions; bad input refused before any statement).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdvertiser, statusCursor, freshnessFromStatus, searchAdvertisers, advertiserHistory, sourceStatus, scanEvidence,
         IntelligenceFailed, sourceAvailability, availabilityCursor, UNAVAILABILITY_REASONS } from '../dist/persistence/intelligence.js';

const spy = () => { const sent = []; return { sent, query: async sql => { sent.push(sql); throw new Error('no database in this test'); } }; };
const base = { sourceId: 's-1', periodFrom: '2026-10-01T00:00:00.000Z', periodTo: '2026-10-11T00:00:00.000Z', asOf: '2026-10-12T00:00:00.000Z',
  latestSuccessfulCollectionAt: null, latestVerifiedEvidenceAt: null, runsCompleted: 0, runsFailed: 0, runsEmpty: 0, runsWithEvidence: 0,
  runsVerifiedValid: 0, runsVerifiedInvalid: 0, runsVerifiedUnverifiable: 0, runsVerificationPending: 0, runsReadable: 0, runsPurged: 0,
  daysInPeriod: 10, daysWithCollection: 0, daysWithVerifiedEvidence: 0 };

test('IL-1: deterministic normalization and status scope', () => {
  assert.equal(normalizeAdvertiser('  ＮＯＲＴＨWIND   Outfitters\t'), 'northwind outfitters');
  assert.equal(statusCursor('s-1', { from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-10-11T12:30:00.250Z') }),
               'v1|s-1|status|2026-10-01T00:00:00.000000Z|2026-10-11T12:30:00.250000Z');
});

test('IL-2: UNKNOWN whenever the status cannot support a value; zero coverage is a measurement', () => {
  const f = freshnessFromStatus(base);
  assert.deepEqual([f.collectionFreshness.state, f.evidenceFreshness.state, f.verificationCompleteness.state, f.collectionReliability.state],
                   ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  assert.deepEqual(f.collectionCoverage, { state: 'KNOWN', value: { daysWithCollection: 0, daysInPeriod: 10, ratio: 0 } });
  const g = freshnessFromStatus({ ...base, latestSuccessfulCollectionAt: '2026-10-11T00:00:00.000Z', latestVerifiedEvidenceAt: '2026-10-10T00:00:00.000Z',
    runsCompleted: 3, runsFailed: 1, runsWithEvidence: 3, runsVerifiedValid: 2, runsVerifiedUnverifiable: 1, daysWithCollection: 3, daysWithVerifiedEvidence: 2 });
  assert.deepEqual(g.collectionFreshness.value, { latestSuccessfulCollectionAt: '2026-10-11T00:00:00.000Z', ageSeconds: 86400 });
  assert.deepEqual(g.evidenceFreshness.value, { latestVerifiedObservationAt: '2026-10-10T00:00:00.000Z', ageSeconds: 172800 });
  assert.equal(g.verificationCompleteness.value.ratio, 0.6667, '2/3 rounded to 4 decimals');
  assert.equal(g.collectionReliability.value.successRatio, 0.75);
  assert.ok(g.notes.some(n => /performance, spend, reach/.test(n)));
});

test('IL-3: bad arguments are refused before any statement', async () => {
  const bad = [
    c => searchAdvertisers(c, { sources: [], query: 'x' }), c => searchAdvertisers(c, { sources: ['s-1'], query: '   ' }),
    c => searchAdvertisers(c, { sources: ['s-1'], query: 'x', limit: 51 }), c => searchAdvertisers(c, { sources: ['BAD'], query: 'x' }),
    c => searchAdvertisers(c, { sources: Array.from({ length: 11 }, (_, i) => `s-${i}`), query: 'x' }),
    c => searchAdvertisers(c, { sources: ['s-1'], query: 'x', networks: ['meta'] }),
    c => searchAdvertisers(c, { sources: ['s-1'], query: 'x', period: { from: new Date(10), to: new Date(5) } }),
    c => advertiserHistory(c, 's-1', ''), c => sourceStatus(c, 's-1', { from: new Date(0), to: new Date(400 * 86400000) }),
    c => scanEvidence(c, 's-1', { maxRecords: 0 })
  ];
  for (const f of bad) {
    const c = spy();
    await assert.rejects(f(c), e => e instanceof IntelligenceFailed && e.code === 'BAD_ARGUMENT');
    assert.equal(c.sent.length, 0);
  }
});

test('IL-4 (M4-P1.1 D1): availability scope, typed failure with fixed reasons, and fail-closed row validation', async () => {
  assert.equal(availabilityCursor('s-1'), 'v1|s-1|availability');
  assert.deepEqual([...UNAVAILABILITY_REASONS], ['RETIRED', 'TERMINATED', 'SUSPENDED', 'RIGHTS_RESTRICTED', 'RETENTION_RESTRICTED', 'NOT_SYNTHETIC', 'UNAVAILABLE']);
  const e = new IntelligenceFailed('SOURCE_UNAVAILABLE', { sourceId: 's-1', reasons: ['SUSPENDED'] });
  assert.deepEqual([e.message, e.code, e.sourceId, [...e.reasons]], ['INTELLIGENCE_FAILED: SOURCE_UNAVAILABLE', 'SOURCE_UNAVAILABLE', 's-1', ['SUSPENDED']]);
  assert.ok(Object.isFrozen(e.reasons), 'reasons cannot be altered by a caller');
  assert.deepEqual([new IntelligenceFailed('BAD_ARGUMENT').sourceId, [...new IntelligenceFailed('BAD_ARGUMENT').reasons]], [null, []]);
  const c = spy();
  await assert.rejects(sourceAvailability(c, 'BAD ID'), err => err instanceof IntelligenceFailed && err.code === 'BAD_ARGUMENT');
  assert.deepEqual(c.sent, [], 'refused before any statement');
  // A row that is inconsistent or carries an unknown reason fails closed (INTERNAL), never "available".
  const rowClient = row => ({ query: async sql => (/si_begin_read/.test(sql) ? { rows: [{ id: '00000000-0000-0000-0000-000000000001' }] } : { rows: [row] }) });
  const good = { source_id: 's-1', as_of: new Date('2026-10-12T00:00:00Z'), available: true, reasons: [], state_token: 'a'.repeat(32) };
  assert.deepEqual(await sourceAvailability(rowClient(good), 's-1'),
    { sourceId: 's-1', asOf: '2026-10-12T00:00:00.000Z', available: true, reasons: [], stateToken: 'a'.repeat(32) });
  for (const bad of [{ ...good, reasons: ['SUSPENDED'] }, { ...good, available: false }, { ...good, available: false, reasons: ['MAINTENANCE'] },
                     { ...good, state_token: 'x' }, { ...good, source_id: 's-2' }, { ...good, as_of: null }]) {
    await assert.rejects(sourceAvailability(rowClient(bad), 's-1'), err => err?.name === 'ReadFailed' && err.code === 'INTERNAL', JSON.stringify(bad));
  }
});
