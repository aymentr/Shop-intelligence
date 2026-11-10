// M3-P3A: retention library contract without a database (codes only; no statement for bad input).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRetentionError, purgeDue, purgeFailures, RetentionFailed, MAX_PURGE_RUNS, DEFAULT_PURGE_RUNS } from '../dist/persistence/retention.js';

const spy = (impl = async () => { throw Object.assign(new Error('raw PostgreSQL text CANARY-value'), { code: '23503', detail: 'Key (native_ad_id)=(CANARY-value)' }); }) => {
  const sent = [];
  return { sent, query: async (sql, params) => { sent.push(sql); return impl(sql, params); } };
};

test('RL-1: SQLSTATE classification is fixed and total', () => {
  const cases = { '55P03': 'LOCK_TIMEOUT', '57014': 'STATEMENT_TIMEOUT', '25000': 'ISOLATION', '40001': 'ISOLATION', '42501': 'PRIVILEGE',
    '23503': 'INTEGRITY', '23514': 'INTEGRITY', '08006': 'CONNECTION', '57P01': 'CONNECTION', '22023': 'INTERNAL', XX000: 'INTERNAL' };
  for (const [code, want] of Object.entries(cases)) assert.equal(classifyRetentionError({ code }), want, code);
  for (const v of [undefined, null, {}, new Error('x'), { code: 'not-a-state' }]) assert.equal(classifyRetentionError(v), 'CONNECTION');
});

test('RL-2: bad limits are refused before any statement', async () => {
  assert.deepEqual([DEFAULT_PURGE_RUNS, MAX_PURGE_RUNS], [10, 20]);
  for (const bad of [0, -1, 21, 1.5, NaN, '5', null]) {
    const c = spy();
    await assert.rejects(purgeDue(c, bad), e => e instanceof RetentionFailed && e.message === 'RETENTION_FAILED: BAD_ARGUMENT');
    assert.equal(c.sent.length, 0, `no statement for ${bad}`);
  }
  const c = spy();
  await assert.rejects(purgeFailures(c, 101), /^RetentionFailed: RETENTION_FAILED: BAD_ARGUMENT$/);
  assert.equal(c.sent.length, 0);
});

test('RL-3: a database failure surfaces as a fixed code; the raw message and detail never do', async () => {
  const c = spy();
  const err = await purgeDue(c, 5).catch(e => e);
  assert.ok(err instanceof RetentionFailed);
  assert.deepEqual([err.message, err.code, err.sqlstate], ['RETENTION_FAILED: INTEGRITY', 'INTEGRITY', '23503']);
  assert.ok(!JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes('CANARY'), 'no database text retained');
  assert.equal(err.recorded, false, 'recording failed too (same spy), and is reported as such');
  assert.deepEqual(c.sent.slice(0, 1), ['SELECT * FROM si.si_purge_due($1::int)']);
});
