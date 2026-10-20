/** Offline research data: no authority to store or display production ad content is implied. */
export type Network = 'META' | 'TIKTOK' | 'GOOGLE' | 'PINTEREST' | 'OTHER';
export type Permission = 'ALLOWED' | 'DENIED' | 'UNKNOWN';
export type UseAction = 'evaluation' | 'retain' | 'subscriber_display' | 'media_mirror' | 'export';
export type CollectionStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
/**
 * Kind of evidence an adapter produces. Only synthetic fixtures exist in B-001.
 * Widening this union is a deliberate act that must be backed by documented
 * source permissions; it is not a configuration switch.
 */
export type EvidenceKind = 'SYNTHETIC';
export type AdEvidence = {
  network: Network;
  nativeAdId: string;
  advertiserName: string;
  /** ISO 3166-1 alpha-2 shaped codes, de-duplicated and sorted. Format only, not checked against the official list. */
  countries: string[];
  seenAt: string;
  sourceUrl: string;
  title?: string;
  destinationUrl?: string;
  creativeUrl?: string;
  sourceReportedFirstSeen?: string;
  sourceReportedLastSeen?: string;
};
export type RawFixture = Record<string, unknown>;
export type Rights = {
  sourceId: string;
  evaluation: Permission;
  retain: Permission;
  subscriber_display: Permission;
  media_mirror: Permission;
  export: Permission;
  /** Free-text description of why these rights are believed to hold. Not verified by this code. */
  basis: string;
  /** Timestamp with explicit offset. An unparseable value is treated as expired. */
  expiresAt?: string;
};
export type NormalizedAd = AdEvidence & {
  /** `${network}:${nativeAdId}` — stable across runs for the same network-native ad. */
  identityKey: string;
  sourceId: string;
  /** Collection run that produced this record. */
  runId: string;
  evidenceKind: EvidenceKind;
};
export type Run = {
  runId: string;
  sourceId: string;
  status: CollectionStatus;
  startedAt: string;
  finishedAt?: string;
  received: number;
  unique: number;
  duplicate: number;
  /** Duplicates whose content (ignoring seenAt) differs from the first record kept. */
  conflicts: number;
  errors: string[];
};
