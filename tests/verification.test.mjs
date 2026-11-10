// M3-P3B: verification library contract without a database (fixed codes; no statement for bad input).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVerificationError, verifyReceipts, verificationFailures, VerificationFailed, MAX_VERIFY_RUNS, DEFAULT_VERIFY_RUNS } from '../dist/persistence/verification.js';

const spy = (code = '23514') => { const sent = []; return { sent, query: async sql => { sent.push(sql);
  throw Object.assign(new Error('raw PostgreSQL text CANARY-value'), { code, detail: 'Key (native_ad_id)=(CANARY-value)' }); } }; };

test('VL-1: SQLSTATE classification; disabled commit timestamps have their own code', () => {
  const cases = { '55000': 'COMMIT_TS_DISABLED', '25000': 'ISOLATION', '42501': 'PRIVILEGE', '23514': 'INTEGRITY', '57014': 'STATEMENT_TIMEOUT',
    '55P03': 'LOCK_TIMEOUT', '08006': 'CONNECTION', XX000: 'INTERNAL' };
  for (const [code, want] of Object.entries(cases)) assert.equal(classifyVerificationError({ code }), want, code);
  assert.equal(classifyVerificationError(new Error('x')), 'CONNECTION');
});

test('VL-2: bad limits are refused before any statement', async () => {
  assert.deepEqual([DEFAULT_VERIFY_RUNS, MAX_VERIFY_RUNS], [100, 500]);
  for (const bad of [0, 501, 1.5, NaN, '5', null]) {
    const c = spy();
    await assert.rejects(verifyReceipts(c, bad), e => e instanceof VerificationFailed && e.message === 'VERIFICATION_FAILED: BAD_ARGUMENT');
    assert.equal(c.sent.length, 0);
  }
  const c = spy();
  await assert.rejects(verificationFailures(c, 101), /VERIFICATION_FAILED: BAD_ARGUMENT/);
  assert.equal(c.sent.length, 0);
});

test('VL-3: a database failure surfaces as a fixed code; the raw message and detail never do', async () => {
  const c = spy('55000');
  const err = await verifyReceipts(c, 5).catch(e => e);
  assert.deepEqual([err.message, err.code, err.sqlstate, err.recorded], ['VERIFICATION_FAILED: COMMIT_TS_DISABLED', 'COMMIT_TS_DISABLED', '55000', false]);
  assert.ok(!JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes('CANARY'));
  assert.equal(c.sent[0], 'SELECT * FROM si.si_verify_receipts($1::int)');
});
