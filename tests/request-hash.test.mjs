// C7: request-hash canonicalization (B-002 2.1 section C). Pure, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, fixtureSha256, requestSha256 } from '../dist/persistence/request-hash.js';

const rowsA = [{ network: 'META', nativeAdId: '1', title: 'Café' }, { network: 'META', nativeAdId: '2', title: 'x' }];

test('C7: key order and whitespace do not matter; row order does', () => {
  const reordered = [{ title: 'Café', nativeAdId: '1', network: 'META' }, { nativeAdId: '2', title: 'x', network: 'META' }];
  assert.equal(fixtureSha256(rowsA), fixtureSha256(reordered));
  assert.equal(fixtureSha256(rowsA), fixtureSha256(JSON.parse(JSON.stringify(rowsA, null, 4))));
  assert.notEqual(fixtureSha256(rowsA), fixtureSha256([rowsA[1], rowsA[0]]), 'input order is significant');
});

test('C7: strings and keys are NFC-normalized', () => {
  const decomposed = [{ network: 'META', nativeAdId: '1', title: 'Café' }, rowsA[1]];
  assert.equal(fixtureSha256(rowsA), fixtureSha256(decomposed));
  assert.equal(canonicalJson({ 'é': 1 }), canonicalJson({ 'é': 1 }));
  assert.throws(() => canonicalJson({ 'é': 1, 'é': 2 }), /collide/);
});

test('C7: canonical form is sorted, compact and rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: [1, { d: 2, c: null }], a: true }), '{"a":true,"b":[1,{"c":null,"d":2}]}');
  assert.throws(() => canonicalJson({ x: Infinity }), /non-finite/);
});

test('C7: request hash sorts networks, binds every field and validates input', () => {
  const base = { adapterId: 'synthetic-fixture', evidenceKind: 'SYNTHETIC', networks: ['TIKTOK', 'META'], fixtureSha256: fixtureSha256(rowsA) };
  const h = requestSha256(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(requestSha256({ ...base, networks: ['META', 'TIKTOK'] }), h);
  for (const change of [{ adapterId: 'other' }, { evidenceKind: 'LICENSED' }, { networks: ['META'] }, { fixtureSha256: fixtureSha256([rowsA[0]]) }]) {
    assert.notEqual(requestSha256({ ...base, ...change }), h, JSON.stringify(change));
  }
  assert.throws(() => requestSha256({ ...base, networks: ['META', 'META'] }), /duplicate/);
  assert.throws(() => requestSha256({ ...base, fixtureSha256: 'nothex' }), /64 hex/);
});
