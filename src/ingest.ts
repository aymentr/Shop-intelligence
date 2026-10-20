import type { AdSourceAdapter } from './adapters.js';
import type { AdEvidence, NormalizedAd, Rights, Run } from './types.js';
import { parseAd } from './validation.js';
import { assertPermitted, validateRights } from './rights.js';
import { toInstant } from './time.js';

export type IngestResult = { run: Run; ads: NormalizedAd[] };
export type IngestOptions = {
  /** Clock used for rights expiry and `finishedAt`. Injectable for deterministic tests. */
  now?: () => string;
};

/** Content fingerprint for conflict detection. Excludes `seenAt`: re-observing the same ad later is not a conflict. */
function fingerprint(ad: AdEvidence): string {
  const { seenAt: _seenAt, ...content } = ad;
  return JSON.stringify(content, Object.keys(content).sort());
}

/**
 * Pre-flight problems (invalid rights, source/rights mismatch, blocked
 * evaluation, bad run metadata, undeclared evidence kind) throw and no run is
 * started. Once started, every outcome is reported through `run.status`.
 */
export async function ingestOffline(
  adapter: AdSourceAdapter,
  rights: Rights,
  runId: string,
  startedAt: string,
  options: IngestOptions = {}
): Promise<IngestResult> {
  const now = options.now ?? (() => new Date().toISOString());
  validateRights(rights);
  if (rights.sourceId !== adapter.id) throw new Error('Source and rights mismatch');
  assertPermitted(rights, 'evaluation', now());
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('Missing run ID');
  const start = toInstant(startedAt, 'startedAt');
  if (adapter.evidenceKind !== 'SYNTHETIC') throw new Error('Unsupported adapter evidence kind');

  const run: Run = { runId, sourceId: adapter.id, status: 'RUNNING', startedAt: start, received: 0, unique: 0, duplicate: 0, conflicts: 0, errors: [] };
  const finish = (status: 'COMPLETED' | 'FAILED', ads: NormalizedAd[]): IngestResult => {
    run.status = status;
    run.finishedAt = now();
    return { run, ads };
  };
  const keyed = new Map<string, { ad: NormalizedAd; fp: string }>();
  try {
    const rows: unknown = await adapter.readOffline();
    if (!Array.isArray(rows)) throw new Error('Adapter did not return an array');
    run.received = rows.length;
    for (let i = 0; i < rows.length; i++) {
      try {
        const row: unknown = rows[i];
        if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('Row is not an object');
        const parsed = parseAd(row as Record<string, unknown>);
        if (!adapter.supportedNetworks.includes(parsed.network)) throw new Error('Adapter network mismatch');
        const identityKey = `${parsed.network}:${parsed.nativeAdId}`;
        const fp = fingerprint(parsed);
        const existing = keyed.get(identityKey);
        if (existing) {
          run.duplicate++;
          if (existing.fp !== fp) run.conflicts++;
          continue;
        }
        keyed.set(identityKey, { ad: { ...parsed, sourceId: adapter.id, runId, identityKey, evidenceKind: adapter.evidenceKind }, fp });
      } catch (err) {
        run.errors.push(`row ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (run.errors.length) { run.unique = 0; return finish('FAILED', []); }
    run.unique = keyed.size;
    return finish('COMPLETED', [...keyed.values()].map(v => v.ad));
  } catch (err) {
    run.errors.push(`source: ${err instanceof Error ? err.message : String(err)}`);
    return finish('FAILED', []);
  }
}

/** Only counting diagnostics, not source quality, recall, or commercial usefulness. */
export function diagnostics(result: IngestResult) {
  const { run, ads } = result;
  return {
    status: run.status,
    recordsReceived: run.received,
    uniqueAds: run.unique,
    duplicates: run.duplicate,
    conflictingDuplicates: run.conflicts,
    errors: run.errors.length,
    destinationCoverage: ads.length ? ads.filter(x => x.destinationUrl).length / ads.length : null,
    creativeReferenceCoverage: ads.length ? ads.filter(x => x.creativeUrl).length / ads.length : null
  };
}
