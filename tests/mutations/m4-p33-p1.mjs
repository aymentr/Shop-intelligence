// B-002 M4-P3.3 Phase 1: deliberate breaks of the readiness gate (db/ops/readiness.sql) and of the adoption procedure
// (src/persistence/migrate.ts, readiness.ts, production-readiness.ts). Each mutant is applied with exactly one anchor; TypeScript mutants are compiled
// (npm run build); the RDY and MIG suites run; the mutant is KILLED only if its named detector fails with an assertion.
// Every file is restored byte for byte after each mutant (verified), dist/ is rebuilt, and the restored baseline must be green.
//   CI=true node tests/mutations/m4-p33-p1.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

if (process.env.CI !== 'true') throw new Error('m4-p33-p1 requires CI=true');
if (process.env.SI_PRODUCTION === '1') throw new Error('m4-p33-p1 refuses production mode');
if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.SI_TEST_PGHOST ?? '127.0.0.1')) throw new Error('loopback PostgreSQL test host required');

const SQL = 'db/ops/readiness.sql', TS = 'src/persistence/migrate.ts';
const RDY_TS = 'src/persistence/readiness.ts', GATE_TS = 'src/persistence/production-readiness.ts';
const originals = new Map([SQL, TS, RDY_TS, GATE_TS].map(f => [f, readFileSync(f)]));
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 12);
const M = [
  { id: 'RX1', file: SQL, why: 'validity check removed',
    anchor: "  UNION ALL SELECT 'INDEX_NOT_VALID', 'si.observations_by_ad_fk' FROM ix WHERE NOT ix.indisvalid\n", to: '', detector: /^not ok \d+ - RDY-2 /m },
  { id: 'RX2', file: SQL, why: 'readiness (indisready) check removed',
    anchor: "  UNION ALL SELECT 'INDEX_NOT_READY', 'si.observations_by_ad_fk' FROM ix WHERE NOT ix.indisready\n", to: '', detector: /^not ok \d+ - RDY-3 /m },
  { id: 'RX3', file: SQL, why: 'key-order check reduced to the column count',
    anchor: "   WHERE ix.indnkeyatts <> 4\n      OR EXISTS (SELECT 1 FROM expected e LEFT JOIN keycols k ON k.pos = e.pos WHERE k.attname IS DISTINCT FROM e.attname)\n",
    to: '   WHERE ix.indnkeyatts <> 4\n', detector: /^not ok \d+ - RDY-8 /m },
  { id: 'RX4', file: SQL, why: 'invalid artifacts elsewhere in schema si ignored',
    anchor: "     AND NOT (i.indisvalid AND i.indisready AND i.indislive))", to: '     AND false)', detector: /^not ok \d+ - RDY-18 /m },
  { id: 'RX5', file: SQL, why: 'catalog-definition catch-all removed',
    anchor: "   WHERE pg_catalog.pg_get_indexdef(ix.indexrelid)\n         IS DISTINCT FROM", to: '   WHERE false AND pg_catalog.pg_get_indexdef(ix.indexrelid)\n         IS DISTINCT FROM',
    detector: /^not ok \d+ - RDY-17 /m },
  { id: 'AX1', file: TS, why: 'adopt no longer requires catalog equivalence (readiness ignored)',
    anchor: "    if (failures.length) throw new MigrationError('INDEX_NOT_READY', `the prebuilt index is not ready: ${describe(failures)}`);\n",
    to: '', detector: /^not ok \d+ - MIG-4:/m },
  { id: 'AX2', file: TS, why: 'adopt no longer checks the migration version',
    anchor: "    if (applied.length !== opts.version - 1) throw new MigrationError('WRONG_VERSION', `database is at version ${applied.length}, adopting ${opts.version} requires ${opts.version - 1}`);\n",
    to: '', detector: /^not ok \d+ - MIG-2:/m },
  { id: 'AX3', file: TS, why: 'the pinned 0022 checksums are no longer verified',
    anchor: '  if (m.name !== pin.name || m.upSha256 !== pin.upSha256 || m.downSha256 !== pin.downSha256) {',
    to: '  if (!m || m.name !== pin.name) {', detector: /^not ok \d+ - MIG-9:/m },
  { id: 'AX4', file: TS, why: 'the build ignores foreign invalid artifacts',
    anchor: "    if (artifacts.length) throw new MigrationError('INVALID_ARTIFACTS_PRESENT',", to: "    if (artifacts.length < 0) throw new MigrationError('INVALID_ARTIFACTS_PRESENT',",
    detector: /^not ok \d+ - MIG-8:/m },
  // M4-P3.3-P1-CLOSE-01: the acceptance review's surviving gate mutants (NX1, NX2, NX4), now detected by tests/db/m4-gate.test.mjs.
  { id: 'NX1', file: GATE_TS, why: 'the production gate (every SI_PRODUCTION=1 command) no longer runs the readiness check',
    anchor: '  checks.push(...await checkIndexReadinessPrecondition(client));\n', to: '', detector: /^not ok \d+ - GATE-1:/m },
  { id: 'NX2', file: RDY_TS, why: 'exactly version 22 (adopted, before up) treated as NOT_APPLICABLE',
    anchor: '  if (version < INDEX_REQUIRED_FROM_VERSION) {', to: '  if (version <= INDEX_REQUIRED_FROM_VERSION) {', detector: /^not ok \d+ - GATE-3:/m },
  { id: 'NX4', file: TS, why: 'adopt reports ALREADY_APPLIED without checking readiness once 22 is recorded',
    anchor: "      if (failures.length) throw new MigrationError('INDEX_NOT_READY', `version ${opts.version} is recorded but the index is not ready: ${describe(failures)}`);\n",
    to: '', detector: /^not ok \d+ - GATE-5:/m },
];
// SI_MUT_ONLY=AX3,AX4 runs a subset (local diagnosis only; CI runs every mutant).
const ONLY = (process.env.SI_MUT_ONLY ?? '').split(',').filter(Boolean);
const build = () => { const r = spawnSync('npm', ['run', 'build'], { encoding: 'utf8', timeout: 180000 }); if (r.status !== 0) throw new Error('build failed: ' + r.stdout + r.stderr); };
const restoreAll = () => {
  for (const [f, b] of originals) { writeFileSync(f, b); if (!readFileSync(f).equals(b)) throw new Error(`FATAL: ${f} not restored`); }
  build();
  console.log('restored byte-for-byte and rebuilt:', [...originals].map(([f, b]) => `${f.split('/').pop()} ${sha(b)}`).join(', '));
};
const suite = () => {
  const r = spawnSync(process.execPath, ['tests/db/run.mjs', 'm4-readiness', 'm4-adopt', 'm4-gate'], { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024 });
  return { r, out: (r.stdout ?? '') + '\n' + (r.stderr ?? '') };
};
const outcomes = [];
try {
  for (const m of M.filter(z => !ONLY.length || ONLY.includes(z.id))) {
    const src = originals.get(m.file).toString('utf8');
    if (src.split(m.anchor).length !== 2) throw new Error(`${m.id}: expected exactly one anchor in ${m.file}`);
    try {
      writeFileSync(m.file, src.replace(m.anchor, () => m.to), 'utf8');
      if (m.file.endsWith('.ts')) build();
      const { r, out } = suite();
      const detected = m.detector.test(out), assertion = /AssertionError|ERR_ASSERTION/.test(out);
      const cls = r.error || r.signal || r.status === null ? 'INCONCLUSIVE' : r.status === 0 ? 'SURVIVED' : detected && assertion ? 'KILLED' : 'INCONCLUSIVE';
      console.log(`${m.id} ${m.why}: ${cls}; failing tests: ${JSON.stringify([...out.matchAll(/^not ok \d+ - (.{0,60})/gm)].map(z => z[1]))}`);
      outcomes.push({ id: m.id, cls });
    } finally { restoreAll(); }
  }
  const green = suite().r.status === 0;
  console.log('restored baseline green:', green);
  console.log('SUMMARY', JSON.stringify(outcomes));
  const bad = outcomes.filter(o => o.cls !== 'KILLED');
  if (!green || bad.length) { console.error('m4-p33-p1 FAILED:', JSON.stringify(bad)); process.exit(1); }
  console.log('m4-p33-p1 RESULT: every mutant KILLED by its detector');
} finally { restoreAll(); }
