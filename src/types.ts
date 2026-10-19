/** Offline research data: no authority to store or display production ad content is implied. */
export type Network = 'META' | 'TIKTOK' | 'GOOGLE' | 'PINTEREST' | 'OTHER';
export type Permission = 'ALLOWED' | 'DENIED' | 'UNKNOWN';
export type UseAction = 'evaluation' | 'retain' | 'subscriber_display' | 'media_mirror' | 'export';
export type CollectionStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type AdEvidence = {
  network: Network;
  nativeAdId: string;
  advertiserName: string;
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
  basis: string;
  expiresAt?: string;
};
export type NormalizedAd = AdEvidence & {
  identityKey: string;
  sourceId: string;
  evidenceKind: 'SYNTHETIC';
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
  errors: string[];
};
