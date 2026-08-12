/**
 * AR-03/TS-20: `Clock` is a port because SPEC-008's entire behaviour is
 * time-dependent — "make no request outside the trading session" is untestable
 * without controlling what time it is. A fake is first-class here, not an
 * afterthought.
 */
export interface Clock {
  /** The current instant, in UTC. */
  now(): Date;
  /** Today in São Paulo, as a business date (AR-29). */
  today(): BusinessDate;
}

/**
 * AR-29: a trade on 2026-03-15 in São Paulo is that date regardless of the
 * reader's timezone. Storing it as a timestamp invites an off-by-one that
 * shifts transactions across period boundaries and quietly corrupts every
 * report — so business dates are a distinct type, `YYYY-MM-DD`, with no time
 * and no zone.
 */
export type BusinessDate = string & { readonly __businessDate: unique symbol };

const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const BusinessDate = {
  of(value: string): BusinessDate {
    if (!BUSINESS_DATE_PATTERN.test(value)) {
      throw new TypeError(`BusinessDate: "${value}" is not YYYY-MM-DD`);
    }
    const [y, m, d] = value.split('-').map((part) => Number(part));
    if (y === undefined || m === undefined || d === undefined) {
      throw new TypeError(`BusinessDate: "${value}" is not YYYY-MM-DD`);
    }
    // Reject 2026-02-31 and friends: Date normalises them silently, which would
    // let an impossible trade date through the parser.
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
      throw new TypeError(`BusinessDate: "${value}" is not a real date`);
    }
    return value as BusinessDate;
  },

  /** Comparison is lexicographic — the reason the format is fixed at ISO. */
  compare(a: BusinessDate, b: BusinessDate): number {
    return a < b ? -1 : a > b ? 1 : 0;
  },

  isBefore(a: BusinessDate, b: BusinessDate): boolean {
    return a < b;
  },

  isAfter(a: BusinessDate, b: BusinessDate): boolean {
    return a > b;
  },
};

export const SAO_PAULO_TIME_ZONE = 'America/Sao_Paulo';

/** Reads the wall-clock date in São Paulo from a UTC instant. */
export function businessDateInSaoPaulo(instant: Date): BusinessDate {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return BusinessDate.of(formatter.format(instant));
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  today(): BusinessDate {
    return businessDateInSaoPaulo(this.now());
  }
}

/**
 * TS-02: a hand-written fake, not a mocking library. When `Clock` changes this
 * stops compiling; a mock would carry on lying.
 */
export class FakeClock implements Clock {
  #instant: Date;

  constructor(instant: Date | string) {
    this.#instant = typeof instant === 'string' ? new Date(instant) : instant;
  }

  now(): Date {
    return new Date(this.#instant);
  }

  today(): BusinessDate {
    return businessDateInSaoPaulo(this.#instant);
  }

  set(instant: Date | string): void {
    this.#instant = typeof instant === 'string' ? new Date(instant) : instant;
  }

  advanceMinutes(minutes: number): void {
    this.#instant = new Date(this.#instant.getTime() + minutes * 60_000);
  }
}
