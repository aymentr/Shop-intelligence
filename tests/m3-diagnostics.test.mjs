// M3-P2B: strict parser for the database's coded diagnostics. Pure, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseT2Diagnostics } from '../dist/persistence/runs.js';

const ok = (n, e) => JSON.stringify({ v: 1, n, e });

test('DG-1: a well-formed diagnostic parses into codes, row indices and field names', () => {
  assert.deepEqual(parseT2Diagnostics(ok(2, [{ c: 'INVALID_URL', r: 1, f: 'sourceUrl' }, { c: 'INVALID_SHAPE', r: 3, f: null }]), 5),
    { errorCount: 2, records: [{ code: 'INVALID_URL', rowIndex: 1, field: 'sourceUrl' }, { code: 'INVALID_SHAPE', rowIndex: 3, field: null }] });
  assert.deepEqual(parseT2Diagnostics('{"e": [{"c": "REQUEST_HASH_MISMATCH", "f": null, "r": null}], "n": 1, "v": 1}', 0),
    { errorCount: 1, records: [{ code: 'REQUEST_HASH_MISMATCH', rowIndex: null, field: null }] }, 'jsonb text form');
  const hundred = Array.from({ length: 100 }, (_, i) => ({ c: 'INVALID_NETWORK', r: i, f: 'network' }));
  assert.equal(parseT2Diagnostics(ok(500, hundred), 500)?.records.length, 100, 'n may exceed the 100 stored records');
});

test('DG-2: anything else fails closed (null)', () => {
  const bad = [
    undefined, null, 42, '', 'not json', '[]', 'null', '{"v":1,"n":1}', ok(0, []), ok(1, []), ok(2, [{ c: 'A_B', r: 0, f: null }]),
    JSON.stringify({ v: 2, n: 1, e: [{ c: 'INVALID_URL', r: 0, f: null }] }),
    JSON.stringify({ v: 1, n: 1, e: [{ c: 'INVALID_URL', r: 0, f: null }], extra: 1 }),
    ok(1, [{ c: 'INVALID_URL', r: 0, f: null, value: 'leak' }]), ok(1, [{ c: 'lowercase', r: 0, f: null }]),
    ok(1, [{ c: 'INVALID_URL', r: 9, f: null }]), ok(1, [{ c: 'INVALID_URL', r: -1, f: null }]), ok(1, [{ c: 'INVALID_URL', r: 0.5, f: null }]),
    ok(1, [{ c: 'INVALID_URL', r: 0, f: 'rawPayload' }]), ok(1, [{ c: 'INVALID_URL', r: '0', f: null }]), ok(1.5, [{ c: 'X_Y_Z', r: 0, f: null }]),
    ok(1, [{ c: 'INVALID_URL', r: 0 }]), ok(1, ['INVALID_URL']), 'x'.repeat(9000)];
  for (const d of bad) assert.equal(parseT2Diagnostics(d, 5), null, String(d).slice(0, 60));
});
