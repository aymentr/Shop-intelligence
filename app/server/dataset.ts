/**
 * DEMO-V1 — the deterministic synthetic dataset and the catalog of synthetic collection scenarios.
 *
 * SYNTHETIC DATA ONLY. Every source, advertiser, advertisement, URL and timestamp here is invented. Names carry the
 * "(synthetic)" suffix (the repository's convention), URLs point at the reserved example.org domain and are never
 * fetched. Nothing here is collected from an advertising platform.
 *
 * The dataset is content-deterministic: the same sources, rows and run order on every seed. Database-generated values
 * (run ids, collection timestamps) differ between seeds; tests compare content and counts, never ids.
 */

export type Network = 'META' | 'TIKTOK' | 'GOOGLE' | 'PINTEREST' | 'OTHER';

/** One evidence row in the B-001 canonical form that si_complete_run validates (0005). */
export interface EvidenceRow {
  network: Network;
  nativeAdId: string;
  advertiserName: string;
  countries: string[];
  seenAt: string;
  sourceUrl: string;
  title?: string;
  sourceReportedFirstSeen?: string;
  sourceReportedLastSeen?: string;
}

export interface DemoSource {
  sourceId: string;
  displayName: string;
  networks: Network[];
  /** Whether the demo analyst principal is granted this source (si_grant_reader). Ungranted sources show isolation. */
  grantedToAnalyst: boolean;
  purpose: string;
}

/** A planned run: rows to publish, or `invalid` rows that the database must refuse (VALIDATION_FAILED). */
export interface PlannedRun { label: string; rows: EvidenceRow[]; expect: 'COMPLETED' | 'FAILED' }

export const ANALYST = 'si_reader_demo_ui_analyst';

export const SOURCES: readonly DemoSource[] = [
  { sourceId: 'demo-market-alpha', displayName: 'Synthetic Market Alpha', networks: ['GOOGLE', 'META', 'TIKTOK'], grantedToAnalyst: true,
    purpose: 'Main synthetic source: repeated ads, changing activity, an empty run and a refused publication.' },
  { sourceId: 'demo-market-beta', displayName: 'Synthetic Market Beta', networks: ['META', 'PINTEREST'], grantedToAnalyst: true,
    purpose: 'Second synthetic source: an advertiser name shared with Alpha stays a separate identity (no cross-source merge).' },
  { sourceId: 'demo-market-gamma', displayName: 'Synthetic Market Gamma', networks: ['GOOGLE'], grantedToAnalyst: true,
    purpose: 'Collector ran but found nothing: an available source with no evidence (empty states).' },
  { sourceId: 'demo-market-delta', displayName: 'Synthetic Market Delta', networks: ['META'], grantedToAnalyst: false,
    purpose: 'Has evidence but is NOT granted to the analyst principal: reads are refused NOT_AUTHORIZED (isolation).' }
];

export const ADVERTISERS = {
  NW: 'Northwind Outfitters (synthetic)',
  HG: 'Harbor Grove Foods (synthetic)',
  LH: 'Lumen Home Studio (synthetic)',
  CC: 'Cobalt Cycle Co. (synthetic)',
  JP: 'Juniper Pet Supply (synthetic)',
  QS: 'Quarry Stone Goods (synthetic)',
  AK: 'Aurora Kitchenworks (synthetic)'
} as const;

const TITLES: Record<string, string> = {
  'nw-1': 'Autumn trail jackets', 'nw-2': 'Weekend hiking checklist', 'nw-3': 'Waterproof boots guide', 'nw-4': 'Winter layering video',
  'nwb-1': 'Outdoor gear sale', 'hg-1': 'Farm-fresh boxes', 'hg-2': 'Seasonal soup recipes', 'lh-1': 'Linen bedding collection',
  'lh-2': 'Lighting for small rooms', 'lh-3': 'Ceramic tableware', 'cc-1': 'City bike tune-up', 'jp-1': 'Grain-free dog food',
  'jp-2': 'Cat enrichment toys', 'qs-1': 'Garden stone pavers', 'ak-1': 'Cast-iron starter set', 'ak-2': 'One-pan dinners'
};
const NETWORK_OF: Record<string, Network> = {
  'nw-1': 'META', 'nw-2': 'TIKTOK', 'nw-3': 'GOOGLE', 'nw-4': 'TIKTOK', 'nwb-1': 'META', 'hg-1': 'META', 'hg-2': 'META', 'lh-1': 'GOOGLE',
  'lh-2': 'GOOGLE', 'lh-3': 'META', 'cc-1': 'GOOGLE', 'jp-1': 'PINTEREST', 'jp-2': 'PINTEREST', 'qs-1': 'META', 'ak-1': 'META', 'ak-2': 'TIKTOK'
};

/**
 * One advertisement observation. A repeated ad keeps the same network and content; only `seenAt` (excluded from the
 * content fingerprint, 0005) changes between runs, so re-observations are duplicates, never conflicts.
 */
export function ad(advertiser: string, id: string, seenAt: string, extra: Partial<EvidenceRow> = {}): EvidenceRow {
  const network = NETWORK_OF[id];
  const title = TITLES[id];
  if (!network || !title) throw new Error(`unknown synthetic ad ${id}`);
  return { network, nativeAdId: `syn-${id}`, advertiserName: advertiser, countries: ['DE', 'FR'], seenAt,
           sourceUrl: `https://example.org/synthetic/ads/${id}`, title, ...extra };
}

const { NW, HG, LH, CC, JP, QS, AK } = ADVERTISERS;

/** The seeded history, in publication order per source. Source-reported dates (seenAt) are historical; collection
 *  timestamps are the database's own clock at seeding time (no time-shift fixture is used). */
export const PLAN: Readonly<Record<string, readonly PlannedRun[]>> = {
  'demo-market-alpha': [
    { label: 'alpha-1', expect: 'COMPLETED', rows: [
      ad(NW, 'nw-1', '2026-09-02T09:00:00.000Z', { sourceReportedFirstSeen: '2026-08-28T00:00:00.000Z' }),
      ad(NW, 'nw-2', '2026-09-03T10:30:00.000Z'),
      ad(HG, 'hg-1', '2026-09-05T08:15:00.000Z'),
      ad(CC, 'cc-1', '2026-09-06T17:45:00.000Z')] },
    { label: 'alpha-2', expect: 'COMPLETED', rows: [
      ad(NW, 'nw-1', '2026-09-20T09:00:00.000Z'),
      ad(HG, 'hg-1', '2026-09-21T08:15:00.000Z'),
      ad(HG, 'hg-2', '2026-09-22T12:00:00.000Z'),
      ad(NW, 'nw-3', '2026-09-23T14:20:00.000Z')] },
    { label: 'alpha-3', expect: 'COMPLETED', rows: [
      ad(NW, 'nw-1', '2026-10-08T09:00:00.000Z'),
      ad(LH, 'lh-1', '2026-10-09T11:00:00.000Z'),
      ad(LH, 'lh-2', '2026-10-10T16:40:00.000Z')] },
    { label: 'alpha-4 (empty)', expect: 'COMPLETED', rows: [] },
    { label: 'alpha-5', expect: 'COMPLETED', rows: [
      ad(NW, 'nw-1', '2026-11-01T09:00:00.000Z', { sourceReportedLastSeen: '2026-11-01T09:00:00.000Z' }),
      ad(NW, 'nw-4', '2026-11-02T19:10:00.000Z'),
      ad(LH, 'lh-1', '2026-11-03T11:00:00.000Z'),
      ad(LH, 'lh-3', '2026-11-04T13:25:00.000Z')] },
    { label: 'alpha-6 (refused: invalid country code)', expect: 'FAILED', rows: [
      ad(CC, 'cc-1', '2026-11-05T17:45:00.000Z', { countries: ['de'] })] }
  ],
  'demo-market-beta': [
    { label: 'beta-1', expect: 'COMPLETED', rows: [
      ad(NW, 'nwb-1', '2026-09-15T09:00:00.000Z'),
      ad(JP, 'jp-1', '2026-09-16T10:00:00.000Z')] },
    { label: 'beta-2', expect: 'COMPLETED', rows: [
      ad(JP, 'jp-1', '2026-10-15T10:00:00.000Z'),
      ad(JP, 'jp-2', '2026-10-17T15:30:00.000Z')] }
  ],
  'demo-market-gamma': [
    { label: 'gamma-1 (empty)', expect: 'COMPLETED', rows: [] }
  ],
  'demo-market-delta': [
    { label: 'delta-1', expect: 'COMPLETED', rows: [ad(QS, 'qs-1', '2026-10-01T09:00:00.000Z')] }
  ]
};

/** Operator scenarios the interface may execute (server-side catalog only: the browser never sends evidence rows). */
export interface Scenario { id: string; title: string; description: string; rows: (seenAt: string) => EvidenceRow[] }
export const SCENARIOS: readonly Scenario[] = [
  { id: 'new-advertiser', title: 'Collect: new advertiser appears',
    description: 'Two ads of Aurora Kitchenworks (synthetic) plus a re-observation of an existing Northwind ad.',
    rows: s => [ad(AK, 'ak-1', s), ad(AK, 'ak-2', s), ad(NW, 'nw-1', s)] },
  { id: 'repeat-activity', title: 'Collect: repeated activity only',
    description: 'Re-observes two ads already on file: duplicates across runs, no new advertisement.',
    rows: s => [ad(NW, 'nw-1', s), ad(LH, 'lh-1', s)] },
  { id: 'empty', title: 'Collect: nothing found',
    description: 'A successful collection that observed no advertisements (EMPTY run).',
    rows: () => [] },
  { id: 'invalid', title: 'Collect: invalid evidence (must be refused)',
    description: 'One row with a lower-case country code. The database must refuse the whole publication.',
    rows: s => [ad(AK, 'ak-1', s), ad(CC, 'cc-1', s, { countries: ['de'] })] }
];

/** Networks an operator scenario needs on the target source; a source without them refuses the run (scope). */
export function scenarioNetworks(rows: EvidenceRow[]): Network[] {
  return rows.length ? [...new Set(rows.map(r => r.network))].sort() as Network[] : [];
}
