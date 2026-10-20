import type { AdEvidence, Network, RawFixture } from './types.js';
import { toInstant } from './time.js';

const NETWORKS = new Set(['META', 'TIKTOK', 'GOOGLE', 'PINTEREST', 'OTHER']);
/** Upper bound for a network-native ad ID. Real platform IDs are far shorter. */
export const MAX_NATIVE_ID_LENGTH = 256;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

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
function optInstant(raw: RawFixture, key: string): string | undefined {
  const val = optString(raw, key);
  return val === undefined ? undefined : toInstant(val, key);
}
function publicUrl(val: string, key: string): string {
  // These are evidence references only. The harness never fetches them.
  let u: URL;
  try { u = new URL(val); } catch { throw new Error(`Invalid URL ${key}`); }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) throw new Error(`Unsafe URL ${key}`);
  return u.toString();
}
function optUrl(raw: RawFixture, key: string): string | undefined {
  const val = optString(raw, key);
  return val === undefined ? undefined : publicUrl(val, key);
}
/** Shape check only (two upper-case letters). Not validated against the ISO 3166-1 list. */
function countryCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value);
}
function nativeId(raw: RawFixture): string {
  const id = reqString(raw, 'nativeAdId');
  if (id.length > MAX_NATIVE_ID_LENGTH || CONTROL_CHARS.test(id)) throw new Error('Invalid nativeAdId');
  return id;
}

export function parseAd(raw: RawFixture): AdEvidence {
  const network = reqString(raw, 'network');
  if (!NETWORKS.has(network)) throw new Error('Invalid network');
  const countries = raw['countries'];
  if (!Array.isArray(countries) || countries.length === 0 || !countries.every(countryCode)) throw new Error('Invalid countries');
  const result: AdEvidence = {
    network: network as Network,
    nativeAdId: nativeId(raw),
    advertiserName: reqString(raw, 'advertiserName'),
    countries: [...new Set(countries)].sort(),
    seenAt: toInstant(reqString(raw, 'seenAt'), 'seenAt'),
    sourceUrl: publicUrl(reqString(raw, 'sourceUrl'), 'sourceUrl')
  };
  const title = optString(raw, 'title');
  const destinationUrl = optUrl(raw, 'destinationUrl');
  const creativeUrl = optUrl(raw, 'creativeUrl');
  const first = optInstant(raw, 'sourceReportedFirstSeen');
  const last = optInstant(raw, 'sourceReportedLastSeen');
  if (first !== undefined && last !== undefined && first > last) {
    // Both are canonical UTC ISO strings, so lexical order equals time order here.
    throw new Error('sourceReportedFirstSeen after sourceReportedLastSeen');
  }
  if (title !== undefined) result.title = title;
  if (destinationUrl !== undefined) result.destinationUrl = destinationUrl;
  if (creativeUrl !== undefined) result.creativeUrl = creativeUrl;
  if (first !== undefined) result.sourceReportedFirstSeen = first;
  if (last !== undefined) result.sourceReportedLastSeen = last;
  return result;
}
