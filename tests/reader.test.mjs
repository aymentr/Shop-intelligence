// M3-P3C: internal reader library contract without a database (fixed codes; no statement for bad input).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReadError, readEvidence, ReadFailed, MAX_READ_RECORDS, MAX_READ_BYTES } from '../dist/persistence/reader.js';

const spy = (err = { code: '42501', message: 'SI_READ_NOT_AUTHORIZED: not authorized' }) => {
  const sent = [];
  return { sent, query: async sql => { sent.push(sql); throw Object.assign(new Error(err.message + ' CANARY-detail'), { code: err.code, detail: 'CANARY' }); } };
};

test('RL-1: database errors map to fixed read codes', () => {
  const cases = [[{ code: '42501', message: 'SI_READ_NOT_AUTHORIZED: x' }, 'NOT_AUTHORIZED'], [{ code: '42501', message: 'permission denied' }, 'NOT_AUTHORIZED'],
    [{ code: '22023', message: 'SI_READ_BAD_CURSOR: x' }, 'BAD_CURSOR'], [{ code: '22023', message: 'SI_READ_BAD_ARGUMENT: x' }, 'BAD_ARGUMENT'],
    [{ code: '55000', message: 'SI_READ_UNSAFE_SESSION: log_statement' }, 'UNSAFE_SESSION'], [{ code: '55P03', message: 'SI_READ_BUSY: x' }, 'BUSY'],
    [{ code: '25000', message: 'SI_ISOLATION: x' }, 'ISOLATION'], [{ code: '08006' }, 'CONNECTION'], [new Error('x'), 'CONNECTION'], [{ code: 'XX000' }, 'INTERNAL']];
  for (const [e, want] of cases) assert.equal(classifyReadError(e), want, JSON.stringify(e));
});

test('RL-2: bad arguments are refused before any statement', async () => {
  assert.deepEqual([MAX_READ_RECORDS, MAX_READ_BYTES], [100, 262144]);
  for (const [src, opts] of [['', {}], ['UPPER', {}], [null, {}], ['rd-1', { limit: 0 }], ['rd-1', { limit: 101 }], ['rd-1', { limit: 1.5 }],
                             ['rd-1', { cursor: 'x'.repeat(161) }], ['rd-1', { cursor: 5 }]]) {
    const c = spy();
    await assert.rejects(readEvidence(c, src, opts), e => e instanceof ReadFailed && /^READ_FAILED: (BAD_ARGUMENT|BAD_CURSOR)$/.test(e.message));
    assert.equal(c.sent.length, 0);
  }
});

test('RL-3: a refusal carries a fixed message only; database text never leaks', async () => {
  const c = spy();
  const err = await readEvidence(c, 'rd-1').catch(e => e);
  assert.deepEqual([err.message, err.code, err.sqlstate], ['READ_FAILED: NOT_AUTHORIZED', 'NOT_AUTHORIZED', '42501']);
  assert.ok(!JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes('CANARY'));
  assert.equal(c.sent[0], 'SELECT * FROM si.si_read_evidence($1, $2, $3::int)');
});
