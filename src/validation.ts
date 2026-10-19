import type { AdEvidence, Network, RawFixture } from './types.js';
const NETWORKS = new Set(['META','TIKTOK','GOOGLE','PINTEREST','OTHER']);
function reqString(raw: RawFixture, key: string): string {
  const val = raw[key];
  if (typeof val !== 'string' || !val.trim()) throw new Error(`Invalid or missing ${key}`);
  return val.trim();
}
function optString(raw: RawFixture, key: string): string | undefined {
  const val = raw[key];
  if (val === undefined) return undefined;
  if (typeof val !== 'string' || !val.trim()) throw new Error(`Invalid ${key}`);
  return val.trim();
}
function iso(raw: RawFixture, key: string, required: boolean): string | undefined {
  const val = required ? reqString(raw,key) : optString(raw,key);
  if (val === undefined) return undefined;
  const d = new Date(val);
  if (!Number.isFinite(d.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(val)) throw new Error(`Invalid timestamp ${key}`);
  return d.toISOString();
}
function publicUrl(val: string, key: string): string {
  // These are evidence references only. The harness never fetches them.
  let u: URL;
  try { u = new URL(val); } catch { throw new Error(`Invalid URL ${key}`); }
  if (!['http:','https:'].includes(u.protocol) || !u.hostname || u.username || u.password) throw new Error(`Unsafe URL ${key}`);
  return u.toString();
}
function countryCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value);
}
export function parseAd(raw: RawFixture): AdEvidence {
  const network = reqString(raw,'network');
  if (!NETWORKS.has(network)) throw new Error('Invalid network');
  const countries = raw['countries'];
  if (!Array.isArray(countries) || countries.length === 0 || !countries.every(countryCode)) throw new Error('Invalid countries');
  const seenAt = iso(raw, 'seenAt', true)!;
  const sourceUrl = publicUrl(reqString(raw,'sourceUrl'),'sourceUrl');
  const result: AdEvidence = {
    network: network as Network,
    nativeAdId: reqString(raw,'nativeAdId'),
    advertiserName: reqString(raw,'advertiserName'),
    countries: [...new Set(countries)],
    seenAt,
    sourceUrl
  };
  for (const k of ['title','destinationUrl','creativeUrl','sourceReportedFirstSeen','sourceReportedLastSeen'] as const) {
    const value = k.includes('Seen') ? iso(raw,k,false) : optString(raw,k);
    if (value === undefined) continue;
    if (k === 'destinationUrl' || k === 'creativeUrl') result[k] = publicUrl(value,k);
    else if (k === 'title') result.title = value;
    else if (k === 'sourceReportedFirstSeen') result.sourceReportedFirstSeen = value;
    else result.sourceReportedLastSeen = value;
  }
  return result;
}
