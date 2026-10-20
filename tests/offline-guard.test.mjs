// Runs the static offline guard (tests/offline-guard.mjs) over src/, and
// regression-tests the guard itself. The guard is a regression check for
// accidental network code, not a security sandbox; see offline-guard.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForNetworkCode } from './offline-guard.mjs';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Temporary tree whose root path deliberately contains spaces. */
function tempTree(t) {
  const root = mkdtempSync(join(tmpdir(), 'si offline guard '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.match(root, / /, 'temp root must contain a space');
  return root;
}
function put(root, rel, text) {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

test('src/ contains no network or process-spawning code (recursive)', () => {
  const { scanned, violations, unscanned } = scanForNetworkCode(SRC);
  assert.ok(scanned.includes('ingest.ts') && scanned.includes('validation.ts'), `unexpected scan set: ${scanned}`);
  assert.deepEqual(unscanned, []);
  assert.deepEqual(violations, []);
});

test('guard detects forbidden code in nested directories', t => {
  const root = tempTree(t);
  put(root, 'index.ts', "export const ok = 1;\n");
  put(root, 'live/net.ts', "import http from 'node:http';\nexport const h = http;\n");
  put(root, 'live/deep/er/call.mjs', "export const r = () => fetch ('https://example.org');\n");
  put(root, 'adapters/spawn.cts', "const cp = require('child_process');\n");
  const { scanned, violations } = scanForNetworkCode(root);
  assert.deepEqual(scanned, ['adapters/spawn.cts', 'index.ts', 'live/deep/er/call.mjs', 'live/net.ts']);
  assert.deepEqual([...new Set(violations.map(v => v.file))].sort(), ['adapters/spawn.cts', 'live/deep/er/call.mjs', 'live/net.ts']);
});

test('guard works when the repository path contains spaces', t => {
  const root = tempTree(t);
  const copy = join(root, 'repo with spaces', 'src');
  cpSync(SRC, copy, { recursive: true });
  const real = scanForNetworkCode(SRC);
  const spaced = scanForNetworkCode(copy);
  assert.deepEqual(spaced.scanned, real.scanned);
  assert.deepEqual(spaced.violations, []);
  put(copy, 'nested dir/with space.ts', "export const s = new WebSocket('wss://example.org');\n");
  assert.deepEqual(scanForNetworkCode(copy).violations.map(v => v.file), ['nested dir/with space.ts']);
});

test('allowed offline source files continue to pass', t => {
  const root = tempTree(t);
  put(root, 'a.ts', "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const f = readFileSync;\nexport const j = join;\n");
  put(root, 'nested/b.ts', "import { createHash } from 'node:crypto';\nexport const prefetchCount = (n: number) => n; // 'prefetch(' must not match\nexport const h = createHash;\n");
  put(root, 'nested/c.mjs', "export const httpStatus = 200; export const netTotal = 1;\n");
  put(root, 'nested/notes.md', "fetch('https://example.org') in prose is not source\n");
  const { scanned, violations, unscanned } = scanForNetworkCode(root);
  assert.deepEqual(scanned, ['a.ts', 'nested/b.ts', 'nested/c.mjs']);
  assert.deepEqual(violations, []);
  assert.deepEqual(unscanned, []);
});

test('symbolic links are reported, never silently skipped', t => {
  const root = tempTree(t);
  put(root, 'a.ts', "export const a = 1;\n");
  const outside = tempTree(t);
  put(outside, 'net.ts', "import net from 'node:net';\n");
  try {
    symlinkSync(outside, join(root, 'linked'), 'dir');
  } catch (err) {
    t.skip(`symlinks unavailable here: ${err.code}`);
    return;
  }
  assert.deepEqual(scanForNetworkCode(root).unscanned, ['linked']);
});
