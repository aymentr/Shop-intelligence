// PB2 (B-002 M2 plan section 3.2): the library never issues SET CONSTRAINTS or PREPARE
// TRANSACTION, so T2's commit-time checks cannot be moved or detached from the commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = dir => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

// Comments may explain the rule (e.g. the D7 max_prepared_transactions precondition); code may not use it.
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/--.*$/gm, '');

test('PB2: no SET CONSTRAINTS or PREPARE TRANSACTION under src/', () => {
  const hits = files('src').filter(f => /\.(ts|js|mjs|sql)$/.test(f))
    .filter(f => /SET\s+CONSTRAINTS|PREPARE\s+TRANSACTION/i.test(code(readFileSync(f, 'utf8'))));
  assert.deepEqual(hits, []);
});

test('PB2 self-check: the scan sees code, not comments', () => {
  assert.match(code("await client.query('SET CONSTRAINTS ALL IMMEDIATE');"), /SET\s+CONSTRAINTS/);
  assert.doesNotMatch(code('/* PREPARE TRANSACTION */ // SET CONSTRAINTS'), /SET\s+CONSTRAINTS|PREPARE\s+TRANSACTION/);
});
