/**
 * M4-P1 — synthetic advertiser intelligence (internal evaluation only; no display, export or mirroring).
 *
 * Everything here is computed deterministically from what the verified read boundary releases:
 *   - evidence pages from si_read_evidence (each page: its own committed, crash-durable request intent);
 *   - content-free source status from si_read_source_status (migration 0011; its own request intent, the
 *     period bound into the audited scope);
 *   - content-free source availability from si_read_source_availability (migration 0012; its own request intent).
 *     Every evidence scan checks availability before its first page and after its last: an unavailable source is
 *     a typed failure (SOURCE_UNAVAILABLE with fixed reason codes), never an empty result, and a change of
 *     availability during the scan fails the request (AVAILABILITY_CHANGED) instead of returning a truncated one.
 * There is no other database access: no table, no view, no unrestricted query. Every source is authorized
 * separately by the database; results are never merged across sources (an advertiser identity is the
 * normalized name WITHIN one source). Ages are measured against the database clock (status.as_of).
 *
 * What is NOT inferred: an advertisement having stopped (absence of observations proves nothing), ad
 * performance, spend, reach, impressions or conversions (no such data exists in the evidence).
 *
 * Call these on a client that is NOT inside a transaction: every request intent must commit on its own
 * (inside a caller transaction the read fails closed with INTENT_UNCOMMITTED).
 */
import { createHash } from 'node:crypto';
import type { ClientBase } from 'pg';
import { beginRead, classifyReadError, readEvidence, ReadFailed, NOT_DURABLE_ATTEMPTS, MAX_READ_RECORDS,
         type EvidenceRecord } from './reader.js';

/** Upper bound of records scanned per source and request; above it the request fails closed (SCAN_LIMIT). */
export const MAX_SCAN_RECORDS = 5000;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_SOURCES_PER_REQUEST = 10;

export type IntelligenceFailureCode = 'BAD_ARGUMENT' | 'BAD_CURSOR' | 'SCAN_LIMIT' | 'SOURCE_UNAVAILABLE' | 'AVAILABILITY_CHANGED';
/** Why a granted reader may not read a source now (migration 0012), in this fixed order. */
export const UNAVAILABILITY_REASONS = ['RETIRED', 'TERMINATED', 'SUSPENDED', 'RIGHTS_RESTRICTED', 'RETENTION_RESTRICTED',
                                       'NOT_SYNTHETIC', 'UNAVAILABLE'] as const;
export type UnavailabilityReason = typeof UNAVAILABILITY_REASONS[number];
/**
 * Fixed message only. Read refusals from the database surface as ReadFailed (reader.ts); in particular an unknown
 * or ungranted source is ReadFailed NOT_AUTHORIZED, never SOURCE_UNAVAILABLE and never an empty result.
 * SOURCE_UNAVAILABLE carries the source and its fixed reason codes; AVAILABILITY_CHANGED carries the source.
 */
export class IntelligenceFailed extends Error {
  readonly sourceId: string | null;
  readonly reasons: readonly UnavailabilityReason[];
  constructor(readonly code: IntelligenceFailureCode, detail: { sourceId?: string; reasons?: readonly UnavailabilityReason[] } = {}) {
    super(`INTELLIGENCE_FAILED: ${code}`);
    this.name = 'IntelligenceFailed';
    this.sourceId = detail.sourceId ?? null;
    this.reasons = Object.freeze([...(detail.reasons ?? [])]);
  }
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const NETWORK = /^[A-Z][A-Z0-9_]{1,31}$/;

/** Deterministic advertiser-name normalization (Unicode NFKC, trimmed, single spaces, lower case). */
export function normalizeAdvertiser(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export interface Period { from: Date; to: Date }
function checkPeriod(p: Period | undefined): Period | undefined {
  if (p === undefined) return undefined;
  const ok = p && p.from instanceof Date && p.to instanceof Date && Number.isFinite(p.from.getTime()) && Number.isFinite(p.to.getTime())
    && p.from.getTime() < p.to.getTime() && p.to.getTime() - p.from.getTime() <= 366 * 86400000;
  if (!ok) throw new IntelligenceFailed('BAD_ARGUMENT');
  return p;
}
const inPeriod = (r: EvidenceRecord, p?: Period): boolean => {
  if (!p) return true;
  const t = Date.parse(r.collectedAt);
  return t >= p.from.getTime() && t < p.to.getTime();                       // [from, to): from inclusive, to exclusive
};

// ------------------------------------------------------------------------------------------------
// Evidence scan through the verified read boundary.

/** The source was available, with no availability-relevant change, from `checkedFrom` to `asOf` (database clock). */
export interface AvailableSource { sourceId: string; state: 'AVAILABLE'; checkedFrom: string; asOf: string }
export interface EvidenceScan { sourceId: string; records: EvidenceRecord[]; pages: number; availability: AvailableSource }

/**
 * Every evidence record of one source that is readable NOW, in the read's deterministic order
 * (collectedAt, runId, ordinal). One request intent per page. Fails closed above MAX_SCAN_RECORDS.
 * Availability is checked before the first page and after the last (one request intent each): unavailable at
 * either end -> SOURCE_UNAVAILABLE with reasons; available at both ends but with a different state token ->
 * AVAILABILITY_CHANGED (pages read in between may have been empty because of the change).
 * `onPage` is called after each non-empty page (tests use it to interleave concurrent changes).
 */
export async function scanEvidence(client: ClientBase, sourceId: string,
  opts: { pageSize?: number | undefined; maxRecords?: number | undefined; onPage?: ((n: number) => Promise<void> | void) | undefined } = {}): Promise<EvidenceScan> {
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) throw new IntelligenceFailed('BAD_ARGUMENT');
  const limit = opts.pageSize ?? MAX_READ_RECORDS, max = opts.maxRecords ?? MAX_SCAN_RECORDS;
  if (!Number.isInteger(max) || max < 1 || max > MAX_SCAN_RECORDS) throw new IntelligenceFailed('BAD_ARGUMENT');
  const before = await sourceAvailability(client, sourceId);
  if (!before.available) throw new IntelligenceFailed('SOURCE_UNAVAILABLE', { sourceId, reasons: before.reasons });
  const records: EvidenceRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null, pages = 0;
  for (;;) {
    const page = await readEvidence(client, sourceId, { cursor, limit });
    pages++;
    if (page.records.length === 0) break;
    for (const r of page.records) {
      const k = `${r.runId}/${r.ordinal}`;
      if (seen.has(k)) continue;                                             // keyset pages never overlap; defensive
      seen.add(k);
      records.push(r);
      if (records.length > max) throw new IntelligenceFailed('SCAN_LIMIT');
    }
    cursor = page.nextCursor;
    if (opts.onPage) await opts.onPage(page.records.length);
  }
  const after = await sourceAvailability(client, sourceId);
  if (!after.available) throw new IntelligenceFailed('SOURCE_UNAVAILABLE', { sourceId, reasons: after.reasons });
  if (after.stateToken !== before.stateToken) throw new IntelligenceFailed('AVAILABILITY_CHANGED', { sourceId });
  return { sourceId, records, pages, availability: { sourceId, state: 'AVAILABLE', checkedFrom: before.asOf, asOf: after.asOf } };
}

// ------------------------------------------------------------------------------------------------
// Source availability (migration 0012).

export interface SourceAvailability {
  sourceId: string; asOf: string; available: boolean; reasons: UnavailabilityReason[];
  /** Opaque; equal tokens mean no availability-relevant change was committed in between. */
  stateToken: string;
}
export const availabilityCursor = (sourceId: string): string => `v1|${sourceId}|availability`;

/** One content-free, audited request (its own committed, crash-durable intent), with the library's bounded fresh-intent
 *  retry on INTENT_NOT_DURABLE only. `onError` may map a database error to a typed failure first. */
async function auditedCall(client: ClientBase, sourceId: string, cursor: string, sql: string, params: unknown[],
  onError: (message: string) => Error | null = () => null): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 1; ; attempt++) {
    const intentId = await beginRead(client, sourceId, { cursor, limit: 1 });
    try {
      return (await client.query(sql, [sourceId, intentId, ...params])).rows[0];
    } catch (err) {
      const m = (err as { message?: unknown })?.message;
      const mapped = typeof m === 'string' ? onError(m) : null;
      if (mapped) throw mapped;
      const code = (err as { code?: unknown })?.code;
      const failure = new ReadFailed(classifyReadError(err), typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null, intentId);
      if (failure.code === 'INTENT_NOT_DURABLE' && attempt < NOT_DURABLE_ATTEMPTS) continue;
      throw failure;
    }
  }
}

/**
 * Whether one source may be read now, and if not, why (fixed codes). Only a granted reader gets an answer: an unknown
 * or ungranted source is ReadFailed NOT_AUTHORIZED, exactly like an evidence page.
 */
export async function sourceAvailability(client: ClientBase, sourceId: string): Promise<SourceAvailability> {
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) throw new IntelligenceFailed('BAD_ARGUMENT');
  const row = await auditedCall(client, sourceId, availabilityCursor(sourceId), 'SELECT * FROM si.si_read_source_availability($1, $2::uuid)', []);
  const reasons = row?.reasons, token = row?.state_token, asOf = iso(row?.as_of);
  if (!row || row.source_id !== sourceId || typeof row.available !== 'boolean' || !Array.isArray(reasons) || typeof token !== 'string' ||
      !/^[0-9a-f]{32}$/.test(token) || !asOf || !reasons.every(r => (UNAVAILABILITY_REASONS as readonly unknown[]).includes(r)) ||
      row.available !== (reasons.length === 0)) {
    throw new ReadFailed('INTERNAL', null);                                  // fail closed on anything unexpected
  }
  return { sourceId, asOf, available: row.available, reasons: reasons as UnavailabilityReason[], stateToken: token };
}

// ------------------------------------------------------------------------------------------------
// A. Advertiser history (one source).

export interface Observation {
  sourceId: string; runId: string; ordinal: number; collectedAt: string; seenAt: string; network: string;
  nativeAdId: string; title: string | null; sourceUrl: string; contentSha256: string;
  verification: 'VALID';                                                      // only VALID evidence is readable
}
export interface AdvertiserHistory {
  sourceId: string;
  advertiser: { normalizedName: string; names: string[] };
  observations: Observation[];
  firstObservedAt: string | null;                                             // earliest verified collection containing it
  lastObservedAt: string | null;                                              // latest verified collection containing it
  sourceReportedFirstSeen: string | null;                                     // as reported by the source, unverified
  sourceReportedLastSeen: string | null;
  distinctAds: number;                                                        // distinct (network, nativeAdId)
  runsWithEvidence: number;                                                   // distinct runs containing it
  networks: string[];
  endOfActivity: 'UNKNOWN';                                                   // absence of observations proves nothing
  availability: AvailableSource;                                              // explicit: zero observations from an AVAILABLE source
  sourceVerification: SourceStatus | null;                                    // run-level verdicts for the period (if requested)
  notes: string[];
}

const NOTE_ABSENCE = 'Absence of observations after lastObservedAt does not show that an advertisement stopped running.';
const NOTE_SCOPE = 'Synthetic evidence only. No performance, spend, reach, impressions or conversions are available or inferred.';

export async function advertiserHistory(client: ClientBase, sourceId: string, advertiserName: string,
  opts: { period?: Period; pageSize?: number; maxRecords?: number; withStatus?: boolean } = {}): Promise<AdvertiserHistory> {
  if (typeof advertiserName !== 'string' || normalizeAdvertiser(advertiserName).length === 0 || advertiserName.length > 300) {
    throw new IntelligenceFailed('BAD_ARGUMENT');
  }
  const period = checkPeriod(opts.period);
  const want = normalizeAdvertiser(advertiserName);
  const scan = await scanEvidence(client, sourceId, { pageSize: opts.pageSize, maxRecords: opts.maxRecords });
  const mine = scan.records.filter(r => normalizeAdvertiser(r.advertiserName) === want && inPeriod(r, period));
  const observations: Observation[] = mine.map(r => ({
    sourceId, runId: r.runId, ordinal: r.ordinal, collectedAt: r.collectedAt, seenAt: r.seenAt, network: r.network,
    nativeAdId: r.nativeAdId, title: r.title, sourceUrl: r.sourceUrl, contentSha256: r.contentSha256, verification: 'VALID' as const
  }));
  const minMax = (vals: (string | null)[]) => {
    const v = vals.filter((x): x is string => typeof x === 'string' && x.length > 0).sort();
    return { min: v[0] ?? null, max: v[v.length - 1] ?? null };
  };
  const collected = minMax(mine.map(r => r.collectedAt));
  const status = opts.withStatus && period ? await sourceStatus(client, sourceId, period) : null;
  return {
    sourceId,
    advertiser: { normalizedName: want, names: [...new Set(mine.map(r => r.advertiserName))].sort() },
    observations,
    firstObservedAt: collected.min, lastObservedAt: collected.max,
    sourceReportedFirstSeen: minMax(mine.map(r => r.sourceReportedFirstSeen ?? r.seenAt)).min,
    sourceReportedLastSeen: minMax(mine.map(r => r.sourceReportedLastSeen ?? r.seenAt)).max,
    distinctAds: new Set(mine.map(r => `${r.network}\u0000${r.nativeAdId}`)).size,
    runsWithEvidence: new Set(mine.map(r => r.runId)).size,
    networks: [...new Set(mine.map(r => r.network))].sort(),
    endOfActivity: 'UNKNOWN',
    availability: scan.availability,
    sourceVerification: status,
    notes: [NOTE_ABSENCE, NOTE_SCOPE]
  };
}

// ------------------------------------------------------------------------------------------------
// B. Deterministic advertiser search (each source authorized separately; never merged).

export interface SearchQuery { sources: string[]; query: string; period?: Period; networks?: string[]; limit?: number; cursor?: string | null }
export interface AdvertiserHit {
  sourceId: string; normalizedName: string; names: string[]; observations: number; distinctAds: number;
  runsWithEvidence: number; firstObservedAt: string; lastObservedAt: string; networks: string[];
}
/** `sources`: every requested source, each AVAILABLE throughout its scan (otherwise the whole search fails, typed). */
export interface SearchPage { hits: AdvertiserHit[]; nextCursor: string | null; scannedPages: number; sources: AvailableSource[] }

function searchKey(q: { sources: string[]; query: string; period: Period | undefined; networks: string[] }): string {
  const canon = JSON.stringify({ s: q.sources, q: q.query, f: q.period?.from.toISOString() ?? null, t: q.period?.to.toISOString() ?? null, n: q.networks });
  return createHash('sha256').update(canon).digest('hex').slice(0, 32);
}
function encodeCursor(key: string, last: [string, string]): string {
  return Buffer.from(JSON.stringify({ v: 1, k: key, a: last }), 'utf8').toString('base64url');
}
function decodeCursor(c: string, key: string): [string, string] {
  try {
    if (c.length > 2048) throw new Error('long');
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (o?.v === 1 && o.k === key && Array.isArray(o.a) && o.a.length === 2 && o.a.every((x: unknown) => typeof x === 'string')) return [o.a[0], o.a[1]];
  } catch { /* fall through */ }
  throw new IntelligenceFailed('BAD_CURSOR');
}
const cmp = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

/**
 * Advertisers whose normalized name contains the normalized query, per explicitly named source, ordered by
 * (normalizedName, sourceId). Filters: collection period [from, to), networks. Keyset pagination; a cursor
 * is bound to the exact query and is never an authorization (every call re-reads through the boundary).
 */
export async function searchAdvertisers(client: ClientBase, q: SearchQuery,
  opts: { pageSize?: number; maxRecords?: number } = {}): Promise<SearchPage> {
  if (!q || !Array.isArray(q.sources) || q.sources.length < 1 || q.sources.length > MAX_SOURCES_PER_REQUEST ||
      !q.sources.every(s => typeof s === 'string' && SOURCE_ID.test(s)) || typeof q.query !== 'string' || q.query.length > 300) {
    throw new IntelligenceFailed('BAD_ARGUMENT');
  }
  const query = normalizeAdvertiser(q.query);
  const limit = q.limit ?? 20;
  if (query.length < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) throw new IntelligenceFailed('BAD_ARGUMENT');
  const networks = q.networks === undefined ? [] : [...new Set(q.networks)].sort();
  if (!networks.every(n => typeof n === 'string' && NETWORK.test(n))) throw new IntelligenceFailed('BAD_ARGUMENT');
  const period = checkPeriod(q.period);
  const sources = [...new Set(q.sources)].sort();
  const key = searchKey({ sources, query, period, networks });
  const after = q.cursor ? decodeCursor(q.cursor, key) : null;
  const groups = new Map<string, { sourceId: string; normalizedName: string; recs: EvidenceRecord[] }>();
  let scannedPages = 0;
  const checked: AvailableSource[] = [];
  for (const sourceId of sources) {                                           // each source: its own authorization and availability
    const scan = await scanEvidence(client, sourceId, opts);
    scannedPages += scan.pages;
    checked.push(scan.availability);
    for (const r of scan.records) {
      const nn = normalizeAdvertiser(r.advertiserName);
      if (!nn.includes(query) || !inPeriod(r, period) || (networks.length > 0 && !networks.includes(r.network))) continue;
      const k = `${sourceId}\u0000${nn}`;
      const g = groups.get(k) ?? { sourceId, normalizedName: nn, recs: [] };
      g.recs.push(r); groups.set(k, g);
    }
  }
  const all: AdvertiserHit[] = [...groups.values()].map(g => {
    const times = g.recs.map(r => r.collectedAt).sort();
    return {
      sourceId: g.sourceId, normalizedName: g.normalizedName, names: [...new Set(g.recs.map(r => r.advertiserName))].sort(),
      observations: g.recs.length, distinctAds: new Set(g.recs.map(r => `${r.network}\u0000${r.nativeAdId}`)).size,
      runsWithEvidence: new Set(g.recs.map(r => r.runId)).size, firstObservedAt: times[0] as string, lastObservedAt: times[times.length - 1] as string,
      networks: [...new Set(g.recs.map(r => r.network))].sort()
    };
  }).sort((a, b) => cmp([a.normalizedName, a.sourceId], [b.normalizedName, b.sourceId]));
  const rest = after ? all.filter(h => cmp([h.normalizedName, h.sourceId], after) > 0) : all;
  const hits = rest.slice(0, limit);
  const last = hits[hits.length - 1];
  return { hits, nextCursor: rest.length > limit && last ? encodeCursor(key, [last.normalizedName, last.sourceId]) : null, scannedPages, sources: checked };
}

// ------------------------------------------------------------------------------------------------
// C. Freshness and reliability (content-free source status, migration 0011).

export interface SourceStatus {
  sourceId: string; periodFrom: string; periodTo: string; asOf: string;
  latestSuccessfulCollectionAt: string | null; latestVerifiedEvidenceAt: string | null;
  runsCompleted: number; runsFailed: number; runsEmpty: number; runsWithEvidence: number;
  runsVerifiedValid: number; runsVerifiedInvalid: number; runsVerifiedUnverifiable: number; runsVerificationPending: number;
  runsReadable: number; runsPurged: number; daysInPeriod: number; daysWithCollection: number; daysWithVerifiedEvidence: number;
}
/** The audited scope of a status request: 'v1|<source>|status|<from>|<to>' (UTC, microseconds). */
export function statusCursor(sourceId: string, p: Period): string {
  const f = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  return `v1|${sourceId}|status|${f(p.from)}|${f(p.to)}`;
}
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : null);

export async function sourceStatus(client: ClientBase, sourceId: string, period: Period): Promise<SourceStatus> {
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) throw new IntelligenceFailed('BAD_ARGUMENT');
  const p = checkPeriod(period);
  if (!p) throw new IntelligenceFailed('BAD_ARGUMENT');
  const UNAVAILABLE = new Error('SOURCE_UNAVAILABLE');                          // marker: resolved to reasons below
  let row: Record<string, unknown> | undefined;
  try {
    row = await auditedCall(client, sourceId, statusCursor(sourceId, p),
      'SELECT * FROM si.si_read_source_status($1, $2::uuid, $3::timestamptz, $4::timestamptz)', [p.from.toISOString(), p.to.toISOString()],
      m => (m.startsWith('SI_READ_SOURCE_UNAVAILABLE:') ? UNAVAILABLE : null));
  } catch (err) {
    if (err !== UNAVAILABLE) throw err;
    const a = await sourceAvailability(client, sourceId);                     // why (a separate audited request)
    if (a.available) throw new IntelligenceFailed('AVAILABILITY_CHANGED', { sourceId });
    throw new IntelligenceFailed('SOURCE_UNAVAILABLE', { sourceId, reasons: a.reasons });
  }
  if (!row) throw new ReadFailed('INTERNAL', null);
  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    sourceId, periodFrom: iso(row.period_from) ?? '', periodTo: iso(row.period_to) ?? '', asOf: iso(row.as_of) ?? '',
    latestSuccessfulCollectionAt: iso(row.latest_successful_collection_at), latestVerifiedEvidenceAt: iso(row.latest_verified_evidence_at),
    runsCompleted: n('runs_completed'), runsFailed: n('runs_failed'), runsEmpty: n('runs_empty'), runsWithEvidence: n('runs_with_evidence'),
    runsVerifiedValid: n('runs_verified_valid'), runsVerifiedInvalid: n('runs_verified_invalid'),
    runsVerifiedUnverifiable: n('runs_verified_unverifiable'), runsVerificationPending: n('runs_verification_pending'),
    runsReadable: n('runs_readable'), runsPurged: n('runs_purged'), daysInPeriod: n('days_in_period'),
    daysWithCollection: n('days_with_collection'), daysWithVerifiedEvidence: n('days_with_verified_evidence')
  };
}

export type Known<T> = { state: 'KNOWN'; value: T } | { state: 'UNKNOWN'; reason: string };
export interface FreshnessReport {
  sourceId: string; period: { from: string; to: string }; asOf: string;
  /** How recently the collector succeeded (any completed run, with or without evidence). */
  collectionFreshness: Known<{ latestSuccessfulCollectionAt: string; ageSeconds: number }>;
  /** How recent the newest evidence is that is verified and readable now. Not a statement about ads running. */
  evidenceFreshness: Known<{ latestVerifiedObservationAt: string; ageSeconds: number }>;
  collectionCoverage: Known<{ daysWithCollection: number; daysInPeriod: number; ratio: number }>;
  evidenceCoverage: Known<{ daysWithVerifiedEvidence: number; daysInPeriod: number; ratio: number }>;
  verificationCompleteness: Known<{ valid: number; invalid: number; unverifiable: number; pending: number; runsWithEvidence: number; ratio: number }>;
  collectionReliability: Known<{ completed: number; failed: number; successRatio: number }>;
  notes: string[];
}
const ratio = (a: number, b: number) => Math.round((a / b) * 10000) / 10000;    // deterministic 4-decimal rounding
const age = (asOf: string, t: string) => Math.floor((Date.parse(asOf) - Date.parse(t)) / 1000);

/** Deterministic freshness and reliability from the source status. UNKNOWN whenever the data cannot support a value. */
export function freshnessFromStatus(s: SourceStatus): FreshnessReport {
  const days = s.daysInPeriod;
  return {
    sourceId: s.sourceId, period: { from: s.periodFrom, to: s.periodTo }, asOf: s.asOf,
    collectionFreshness: s.latestSuccessfulCollectionAt
      ? { state: 'KNOWN', value: { latestSuccessfulCollectionAt: s.latestSuccessfulCollectionAt, ageSeconds: age(s.asOf, s.latestSuccessfulCollectionAt) } }
      : { state: 'UNKNOWN', reason: 'NO_SUCCESSFUL_COLLECTION' },
    evidenceFreshness: s.latestVerifiedEvidenceAt
      ? { state: 'KNOWN', value: { latestVerifiedObservationAt: s.latestVerifiedEvidenceAt, ageSeconds: age(s.asOf, s.latestVerifiedEvidenceAt) } }
      : { state: 'UNKNOWN', reason: 'NO_VERIFIED_READABLE_EVIDENCE' },
    collectionCoverage: days > 0
      ? { state: 'KNOWN', value: { daysWithCollection: s.daysWithCollection, daysInPeriod: days, ratio: ratio(s.daysWithCollection, days) } }
      : { state: 'UNKNOWN', reason: 'EMPTY_PERIOD' },
    evidenceCoverage: days > 0
      ? { state: 'KNOWN', value: { daysWithVerifiedEvidence: s.daysWithVerifiedEvidence, daysInPeriod: days, ratio: ratio(s.daysWithVerifiedEvidence, days) } }
      : { state: 'UNKNOWN', reason: 'EMPTY_PERIOD' },
    verificationCompleteness: s.runsWithEvidence > 0
      ? { state: 'KNOWN', value: { valid: s.runsVerifiedValid, invalid: s.runsVerifiedInvalid, unverifiable: s.runsVerifiedUnverifiable,
                                   pending: s.runsVerificationPending, runsWithEvidence: s.runsWithEvidence, ratio: ratio(s.runsVerifiedValid, s.runsWithEvidence) } }
      : { state: 'UNKNOWN', reason: 'NO_RUNS_WITH_EVIDENCE_IN_PERIOD' },
    collectionReliability: s.runsCompleted + s.runsFailed > 0
      ? { state: 'KNOWN', value: { completed: s.runsCompleted, failed: s.runsFailed, successRatio: ratio(s.runsCompleted, s.runsCompleted + s.runsFailed) } }
      : { state: 'UNKNOWN', reason: 'NO_COLLECTION_ATTEMPTS_IN_PERIOD' },
    notes: [
      'Collection freshness (the collector ran) and evidence freshness (verified evidence exists) are different facts.',
      NOTE_ABSENCE, NOTE_SCOPE
    ]
  };
}

export async function freshness(client: ClientBase, sourceId: string, period: Period): Promise<FreshnessReport> {
  return freshnessFromStatus(await sourceStatus(client, sourceId, period));
}
