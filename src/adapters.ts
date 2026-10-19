import type { Network, RawFixture } from './types.js';
/** All supplied adapters are offline fixtures. There are no API clients in B-001. */
export interface AdSourceAdapter {
  readonly id: string;
  readonly supportedNetworks: readonly Network[];
  readOffline(): Promise<readonly RawFixture[]>;
}
export class FixtureAdapter implements AdSourceAdapter {
  constructor(
    public readonly id: string,
    public readonly supportedNetworks: readonly Network[],
    private readonly rows: readonly RawFixture[]
  ) {}
  async readOffline(): Promise<readonly RawFixture[]> { return this.rows; }
}
