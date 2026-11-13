// B-002 M3-R35.1 (C2): normal regression tests must exercise the ACTIVE durability gate (migration 0017).
// M3-R35-ACCEPT-01 found that several harnesses installed the 0010 si_read_evidence text in their test databases
// (an instrumented copy, a "restore the production function", the baselines and mutants of RC/RD-M/AUD-DM/AUD-M),
// so those tests silently ran the pre-0017 gate. This file guards against it:
//   GI-1  the shared fixture texts are the latest migration definitions of both gates and contain the 0017 target;
//         a fresh database runs exactly them (assertGate 'active'), and assertGate rejects the 0010 gate
//   GI-2  no test file extracts a gate from an older migration, except the labelled historical comparison
//         (tests/db/wal-boundary.mjs: OLD_READ / OLD_CLAIM, used by R35-M only)
//   GI-3  every harness that installs an instrumented copy or a baseline asserts the gate it runs (assertGate)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asOwner, freshDatabase, roles } from './helpers.mjs';
import { READ_FN, CLAIM_FN, READ_DEF, CLAIM_DEF, TARGET, assertGate, withPause } from './durability-fixtures.mjs';
import { OLD_READ, OLD_CLAIM } from './wal-boundary.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const migrations = readdirSync(join(REPO, 'db/migrations')).filter(f => /^\d{4}_.*\.up\.sql$/.test(f)).sort();
const definesGate = f => /CREATE (OR REPLACE )?FUNCTION si\.si_(read_evidence|claim_read_intent)\(/.test(readFileSync(join(REPO, 'db/migrations', f), 'utf8'));

test('GI-1: the fixture gate texts are the latest definitions (0017); a fresh database runs them; the 0010 gate is detected', async t => {
  const latest = migrations.filter(definesGate).at(-1);
  assert.equal(READ_DEF.file, latest, 'si_read_evidence comes from the latest migration that defines a gate');
  assert.equal(CLAIM_DEF.file, latest, 'si_claim_read_intent comes from the latest migration that defines a gate');
  assert.equal(TARGET.trim().startsWith('target := si.si_durability_target(pg_current_wal_insert_lsn());'), true, TARGET);
  for (const fn of [READ_FN, CLAIM_FN]) assert.ok(fn.includes(`\n${TARGET}\n`), 'both gates contain the 0017 target line');
  const db = await freshDatabase(t, 'gint');
  const { admin } = await roles(t, db, ['admin']);
  assert.equal(await assertGate(admin, 'active'), 'active');
  await asOwner(admin, a => a.query(withPause(READ_FN)));
  assert.equal(await assertGate(admin, 'instrumented'), 'instrumented', 'an instrumented 0017 copy is recognized');
  await assert.rejects(assertGate(admin, 'active'), /si_read_evidence instrumented/);
  await asOwner(admin, a => a.query(OLD_READ));
  await assert.rejects(assertGate(admin, 'instrumented'), /si_read_evidence NOT the active gate/, 'the 0010 read gate is detected');
  await asOwner(admin, a => a.query(READ_FN));
  await asOwner(admin, a => a.query(OLD_CLAIM));
  await assert.rejects(assertGate(admin, 'active'), /si_claim_read_intent NOT the active gate/, 'the 0011 claim gate is detected');
  await asOwner(admin, a => a.query(CLAIM_FN));
  assert.equal(await assertGate(admin, 'active'), 'active', 'restored exactly');
});

const testFiles = (() => {
  const out = [];
  const walk = d => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(mjs|sh)$/.test(e)) out.push(relative(REPO, p)); } };
  walk(join(REPO, 'tests')); walk(join(REPO, 'demo'));
  return out.sort();
})();
const HISTORICAL = new Map([['tests/db/wal-boundary.mjs', 'OLD_READ / OLD_CLAIM: the pre-0017 gate for the R35-M old-target mutant']]);

/** Files (path -> text) that extract a durability gate from an older migration: directly (the file name followed by
 *  a gate's name within one extraction call) or through a variable holding that migration's text. Other functions of
 *  the same files (si_begin_read in 0009, si_read_source_status in 0011) are allowed. */
export function olderGateExtractions(files) {
  const older = migrations.filter(definesGate).slice(0, -1);            // 0008-0011 define earlier gates
  const GATE = /si\.si_read_evidence|si\.si_claim_read_intent/;
  const out = [];
  for (const [f, s] of files) {
    for (const m of older) {
      for (let i = s.indexOf(m); i >= 0; i = s.indexOf(m, i + 1)) if (GATE.test(s.slice(i, i + 200))) out.push(`${f} -> ${m}`);
      for (const v of s.matchAll(new RegExp(`const\\s+(\\w+)\\s*=[^;\\n]*${m.replace(/\./g, '\\.')}`, 'g'))) {
        if (new RegExp(`\\(\\s*${v[1]}\\s*,\\s*'CREATE (OR REPLACE )?FUNCTION si\\.si_(read_evidence|claim_read_intent)`).test(s)) out.push(`${f} -> ${m} (via ${v[1]})`);
      }
    }
  }
  return [...new Set(out)];
}

test('GI-2: no test extracts a durability gate from an older migration, except the labelled historical comparison', () => {
  const files = testFiles.filter(f => f !== 'tests/db/gate-integrity.test.mjs' && !HISTORICAL.has(f)).map(f => [f, readFileSync(join(REPO, f), 'utf8')]);
  const offenders = olderGateExtractions(files);
  assert.deepEqual(offenders, [], 'gate texts must come from durability-fixtures.mjs (READ_FN / CLAIM_FN), never from an older migration');
  for (const [f] of HISTORICAL) assert.match(readFileSync(join(REPO, f), 'utf8'), /OLD_READ[\s\S]*0010_read_durability/, `${f}: the historical text is labelled`);
});

test('GI-3: every harness that installs a si_read_evidence copy asserts which gate its baseline runs', () => {
  const missing = [];
  for (const f of testFiles.filter(f => f.endsWith('.test.mjs') && f !== 'tests/db/gate-integrity.test.mjs')) {
    const s = readFileSync(join(REPO, f), 'utf8');
    const installs = /withPause\(READ_FN\)|query\(READ_FN\)/.test(s);
    if (installs && !s.includes('assertGate(')) missing.push(f);
  }
  assert.deepEqual(missing, []);
});
