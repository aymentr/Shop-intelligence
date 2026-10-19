// Static guard: B-001 source must stay offline. Fails if network-capable APIs
// or modules appear in src/. Adding a live adapter must be a deliberate change
// to this guard, reviewed alongside documented source permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url);
const FORBIDDEN = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /from\s+['"](node:)?(http|https|http2|net|tls|dgram|dns|child_process)['"]/,
  /import\s*\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns|child_process)['"]/,
  /require\s*\(\s*['"](node:)?(http|https|http2|net|tls|dgram|dns|child_process)['"]/,
  /from\s+['"](axios|got|undici|node-fetch|puppeteer|playwright|cheerio)['"]/
];

test('src/ contains no network or process-spawning code', () => {
  const files = readdirSync(SRC).filter(f => f.endsWith('.ts'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(join(SRC.pathname, f), 'utf8');
    for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${f} matches ${pattern}`);
  }
});
