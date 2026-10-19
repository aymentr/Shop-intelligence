import type { AdSourceAdapter } from './adapters.js';
import type { NormalizedAd, Rights, Run } from './types.js';
import { parseAd } from './validation.js';
import { assertPermitted, validateRights } from './rights.js';
export type IngestResult = {run: Run; ads: NormalizedAd[]};
export async function ingestOffline(adapter: AdSourceAdapter, rights: Rights, runId: string, startedAt: string): Promise<IngestResult> {
  validateRights(rights);
  if (rights.sourceId !== adapter.id) throw new Error('Source and rights mismatch');
  assertPermitted(rights,'evaluation');
  if (!runId.trim()) throw new Error('Missing run ID');
  const run: Run = {runId,sourceId:adapter.id,status:'RUNNING',startedAt,received:0,unique:0,duplicate:0,errors:[]};
  const keyed = new Map<string,NormalizedAd>();
  try {
    const rows = await adapter.readOffline();
    run.received = rows.length;
    for (let i=0;i<rows.length;i++) {
      try {
        const parsed = parseAd(rows[i]!);
        if (!adapter.supportedNetworks.includes(parsed.network)) throw new Error('Adapter network mismatch');
        const identityKey = `${parsed.network}:${parsed.nativeAdId}`;
        if (keyed.has(identityKey)) {run.duplicate++;continue;}
        keyed.set(identityKey,{...parsed,sourceId:adapter.id,identityKey,evidenceKind:'SYNTHETIC'});
      } catch (err) {run.errors.push(`row ${i}: ${err instanceof Error ? err.message : String(err)}`);}
    }
    if (run.errors.length) {run.status='FAILED';run.unique=0; return {run,ads:[]};}
    run.status='COMPLETED';run.unique=keyed.size;
    return {run,ads:[...keyed.values()]};
  } catch (err) {
    run.status='FAILED';run.errors.push(`source: ${err instanceof Error ? err.message : String(err)}`);
    return {run,ads:[]};
  }
}
/** Only counting diagnostics, not source quality, recall, or commercial usefulness. */
export function diagnostics(result: IngestResult) {
  const {run,ads}=result;
  return {status:run.status,recordsReceived:run.received,uniqueAds:run.unique,duplicates:run.duplicate,errors:run.errors.length,
    destinationCoverage:ads.length ? ads.filter(x=>x.destinationUrl).length/ads.length : null,
    creativeReferenceCoverage:ads.length ? ads.filter(x=>x.creativeUrl).length/ads.length : null};
}
