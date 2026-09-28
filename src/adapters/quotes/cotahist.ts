import type { BusinessDate } from '@/core/shared/clock';
import type { DomainError } from '@/core/shared/domain-error';
import type { Result } from '@/core/shared/result';
import type { OfficialCloseSource, OfficialClosesFile } from '@/core/quotes/ports';

export interface CotahistConfig {
  readonly source: string;
  /** The directory holding `COTAHIST_*.ZIP`; defaults to B3's public server. */
  readonly baseUrl?: string;
  readonly timeoutMs: number;
}

/** Skeleton — implemented in #171's adapter task. */
export class B3CotahistCloseSource implements OfficialCloseSource {
  readonly source: string;

  constructor(private readonly config: CotahistConfig) {
    this.source = config.source;
  }

  async fetchDay(
    _date: BusinessDate,
    _tickers: ReadonlySet<string>,
  ): Promise<Result<OfficialClosesFile, DomainError>> {
    throw new Error(`B3CotahistCloseSource.fetchDay: not implemented (${this.config.source})`);
  }

  async fetchYear(
    _year: number,
    _tickers: ReadonlySet<string>,
  ): Promise<Result<OfficialClosesFile, DomainError>> {
    throw new Error(`B3CotahistCloseSource.fetchYear: not implemented (${this.config.source})`);
  }
}
