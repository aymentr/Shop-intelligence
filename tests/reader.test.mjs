// M3-P3C / M3-AUD-01: internal reader library contract without a database (fixed codes; no statement for
// bad input; the intent statement always precedes the read, and a failed intent means no read).
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginRead, classifyReadError, readEvidence, ReadFailed, MAX_READ_RECORDS, MAX_READ_BYTES } from '../dist/persistence/reader.js';

const spy = (err = { code: '42501', message: 'SI_READ_NOT_AUTHORIZED: not authorized' }) => {
  const sent = [];
  return { sent, query: async sql => { sent.push(sql); throw Object.assign(new Error(err.message + ' CANARY-detail'), { code: err.code, detail: 'CANARY' }); } };
};

test('RL-1: database errors map to fixed read codes', () => {
  const cases = [[{ code: '42501', message: 'SI_READ_NOT_AUTHORIZED: x' }, 'NOT_AUTHORIZED'], [{ code: '42501', message: 'permission denied' }, 'NOT_AUTHORIZED'],
    [{ code: '22023', message: 'SI_READ_BAD_CURSOR: x' }, 'BAD_CURSOR'], [{ code: '22023', message: 'SI_READ_BAD_ARGUMENT: x' }, 'BAD_ARGUMENT'],
    [{ code: '55000', message: 'SI_READ_UNSAFE_SESSION: log_statement' }, 'UNSAFE_SESSION'], [{ code: '55P03', message: 'SI_READ_BUSY: x' }, 'BUSY'],
    [{ code: '25000', message: 'SI_ISOLATION: x' }, 'ISOLATION'], [{ code: '42501', message: 'SI_READ_INTENT_INVALID: x' }, 'INTENT_INVALID'],
    [{ code: '55000', message: 'SI_READ_INTENT_UNCOMMITTED: x' }, 'INTENT_UNCOMMITTED'], [{ code: '55000', message: 'SI_READ_INTENT_USED: x' }, 'INTENT_USED'],
    [{ code: '55000', message: 'SI_READ_INTENT_EXPIRED: x' }, 'INTENT_EXPIRED'], [{ code: '08006' }, 'CONNECTION'], [new Error('x'), 'CONNECTION'], [{ code: 'XX000' }, 'INTERNAL']];
  for (const [e, want] of cases) assert.equal(classifyReadError(e), want, JSON.stringify(e));
});

test('RL-2: bad arguments are refused before any statement', async () => {
  assert.deepEqual([MAX_READ_RECORDS, MAX_READ_BYTES], [100, 262144]);
  for (const [src, opts] of [['', {}], ['UPPER', {}], [null, {}], ['rd-1', { limit: 0 }], ['rd-1', { limit: 101 }], ['rd-1', { limit: 1.5 }],
                             ['rd-1', { cursor: 'x'.repeat(161) }], ['rd-1', { cursor: 5 }]]) {
    for (const fn of [readEvidence, beginRead]) {
      const c = spy();
      await assert.rejects(fn(c, src, opts), e => e instanceof ReadFailed && /^READ_FAILED: (BAD_ARGUMENT|BAD_CURSOR)$/.test(e.message));
      assert.equal(c.sent.length, 0);
    }
  }
  const c = spy();
  await assert.rejects(readEvidence(c, 'rd-1', { intentId: 'not-a-uuid' }), e => e.code === 'INTENT_INVALID');
  assert.equal(c.sent.length, 0);
});

test('RL-3: a refusal carries a fixed message only; database text never leaks', async () => {
  const c = spy();
  const err = await readEvidence(c, 'rd-1').catch(e => e);
  assert.deepEqual([err.message, err.code, err.sqlstate], ['READ_FAILED: NOT_AUTHORIZED', 'NOT_AUTHORIZED', '42501']);
  assert.ok(!JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes('CANARY'));
  assert.deepEqual(c.sent, ['SELECT si.si_begin_read($1, $2, $3::int) AS id'], 'the intent failed: the read is never sent');
  assert.equal(err.intentId, null);
  assert.equal(err.retryable, false);
});

const ID = '0b8f6a1e-2f53-4c1b-9d2e-3a4b5c6d7e8f';
function scripted(...steps) {                      // each step: a result rows array or an error
  const sent = [];
  return { sent, query: async (sql, params) => { sent.push([sql, params]); const s = steps.shift();
    if (s instanceof Error || (s && s.code)) throw Object.assign(new Error(s.message ?? 'x'), { code: s.code }); return { rows: s }; } };
}

test('RL-4: the intent is committed first; the read names it and the exact same scope', async () => {
  const c = scripted([{ id: ID }], []);
  const page = await readEvidence(c, 'rd-1', { cursor: 'v1|rd-1|c', limit: 7 });
  assert.deepEqual(c.sent, [['SELECT si.si_begin_read($1, $2, $3::int) AS id', ['rd-1', 'v1|rd-1|c', 7]],
                            ['SELECT * FROM si.si_read_evidence($1, $2::uuid, $3, $4::int)', ['rd-1', ID, 'v1|rd-1|c', 7]]]);
  assert.deepEqual(page, { records: [], nextCursor: null, intentId: ID });
});

test('RL-5: an uncertain intent (connection lost, no id) never leads to a read', async () => {
  for (const step of [{ code: '08006', message: 'gone' }, new Error('Connection terminated unexpectedly')]) {
    const c = scripted(step);
    const err = await readEvidence(c, 'rd-1').catch(e => e);
    assert.equal(err.code, 'CONNECTION');
    assert.equal(c.sent.length, 1, 'only the intent statement was sent');
  }
  const bad = scripted([{ id: null }]);
  assert.equal((await readEvidence(bad, 'rd-1').catch(e => e)).code, 'INTERNAL');
  assert.equal(bad.sent.length, 1);
});

test('RL-6: retry semantics — BUSY / CONNECTION after a committed intent are retryable with that intent; others are not', async () => {
  const busy = await readEvidence(scripted([{ id: ID }], { code: '55P03', message: 'SI_READ_BUSY: x' }), 'rd-1').catch(e => e);
  assert.deepEqual([busy.code, busy.intentId, busy.retryable], ['BUSY', ID, true]);
  const lost = await readEvidence(scripted([{ id: ID }], { code: '57P01', message: 'terminating' }), 'rd-1').catch(e => e);
  assert.deepEqual([lost.code, lost.retryable], ['CONNECTION', true]);
  for (const [m, code] of [['SI_READ_INTENT_USED: x', 'INTENT_USED'], ['SI_READ_INTENT_EXPIRED: x', 'INTENT_EXPIRED'], ['SI_READ_NOT_AUTHORIZED: x', 'NOT_AUTHORIZED']]) {
    const e = await readEvidence(scripted([{ id: ID }], { code: '55000', message: m }), 'rd-1').catch(x => x);
    assert.deepEqual([e.code, e.retryable], [code, false]);
  }
  const c = scripted([]);
  await readEvidence(c, 'rd-1', { intentId: ID });
  assert.deepEqual(c.sent.map(s => s[0]), ['SELECT * FROM si.si_read_evidence($1, $2::uuid, $3, $4::int)'], 'a retry reuses the intent: no new intent');
});
