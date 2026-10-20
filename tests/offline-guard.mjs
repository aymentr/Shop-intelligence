// Static offline guard: a REGRESSION CHECK, not a security sandbox.
//
// It scans source text for common network and process-spawning APIs so that a
// live integration cannot be added to src/ by accident. It cannot detect
// obfuscated or indirect access (for example a property built from strings,
// `eval`, or a dependency that opens sockets itself), and it does not stop code
// from running. Adding a live adapter must be a deliberate change to this
// guard, reviewed alongside documented source permissions.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

/** File types that can contain executable source. */
export const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);

const NET_MODULES = '(http|https|http2|net|tls|dgram|dns|child_process)';
export const FORBIDDEN = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  new RegExp(`from\\s+['"](node:)?${NET_MODULES}['"]`),
  new RegExp(`import\\s*\\(\\s*['"](node:)?${NET_MODULES}['"]`),
  new RegExp(`require\\s*\\(\\s*['"](node:)?${NET_MODULES}['"]`),
  /from\s+['"](axios|got|undici|node-fetch|puppeteer|playwright|cheerio)['"]/
];

/**
 * Patterns allowed only under one directory of the scanned root. The PostgreSQL
 * driver opens network connections (to the database only), so it is confined to
 * persistence/ — adapters and the ingest core must never import it.
 */
export const CONFINED = [
  { pattern: /(from\s+['"]pg['"]|import\s*\(\s*['"]pg['"]|require\s*\(\s*['"]pg['"])/, allowedUnder: 'persistence/' }
];

/**
 * Recursively scans `rootDir` (a filesystem path, not a URL).
 * Returns the source files scanned, the pattern matches found, and any entries
 * it refused to follow (symbolic links and other non-regular entries), so that
 * nothing under the root is skipped silently.
 */
export function scanForNetworkCode(rootDir) {
  const scanned = [];
  const violations = [];
  const unscanned = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(rootDir, full).split(sep).join('/');
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) { unscanned.push(rel); continue; }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
      scanned.push(rel);
      const text = readFileSync(full, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) violations.push({ file: rel, pattern: String(pattern) });
      }
      for (const { pattern, allowedUnder } of CONFINED) {
        if (!rel.startsWith(allowedUnder) && pattern.test(text)) violations.push({ file: rel, pattern: String(pattern) });
      }
    }
  };
  walk(rootDir);
  return { scanned: scanned.sort(), violations, unscanned };
}
